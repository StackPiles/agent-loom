import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createServer as createTcpServer, type Socket } from 'node:net';
import { createServer as createTlsServer, createSecureContext, TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';

const fixtureDirectory = new URL('./fixtures/smtp/', import.meta.url);
const certificatePath = fileURLToPath(new URL('certificate.pem', fixtureDirectory));
const tlsOptions = {
  cert: readFileSync(certificatePath),
  key: readFileSync(new URL('test-only-key.pem', fixtureDirectory)),
  minVersion: 'TLSv1.2' as const,
};

async function smtpFixture(
  t: TestContext,
  mode: 'tls' | 'starttls',
  onAuthentication?: () => void,
) {
  const sockets = new Set<Socket>();
  const received = { connections: 0, auth: 0, encryptedAuth: 0, messages: 0, upgrades: 0 };
  const secureContext = createSecureContext(tlsOptions);
  const serve = (socket: Socket, encrypted: boolean, greeting = true) => {
    let buffer = '';
    let data = false;
    socket.on('error', () => {});
    const receive = (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        if (data) {
          if (line === '.') {
            received.messages++;
            data = false;
            socket.write('250 Message accepted by loopback fixture\r\n');
          }
        } else if (line.startsWith('EHLO ')) {
          socket.write(
            encrypted
              ? '250-localhost\r\n250 AUTH PLAIN\r\n'
              : '250-localhost\r\n250-AUTH PLAIN\r\n250 STARTTLS\r\n',
          );
        } else if (line === 'STARTTLS' && !encrypted) {
          received.upgrades++;
          socket.removeListener('data', receive);
          socket.write('220 Ready to start TLS\r\n', () => {
            const secured = new TLSSocket(socket, { isServer: true, secureContext });
            serve(secured, true, false);
          });
          return;
        } else if (line.startsWith('AUTH PLAIN ')) {
          received.auth++;
          if (encrypted) received.encryptedAuth++;
          const credentials = Buffer.from(line.slice('AUTH PLAIN '.length), 'base64').toString();
          if (!encrypted || credentials !== '\0bot@example.test\0fixture-smtp') {
            socket.end('535 Authentication rejected by fixture\r\n');
          } else if (onAuthentication) {
            onAuthentication(); // Deliberately hold the reply for the cancellation test.
          } else {
            socket.write('235 Authentication successful\r\n');
          }
        } else if (line.startsWith('MAIL FROM:') || line.startsWith('RCPT TO:')) {
          socket.write('250 Accepted\r\n');
        } else if (line === 'DATA') {
          data = true;
          socket.write('354 End data with a dot\r\n');
        } else if (line === 'QUIT') {
          socket.end('221 Bye\r\n');
        } else {
          socket.write('500 Unexpected fixture command\r\n');
        }
      }
    };
    socket.on('data', receive);
    if (greeting) socket.write('220 localhost SMTP loopback fixture\r\n');
  };
  const server =
    mode === 'tls'
      ? createTlsServer(tlsOptions, (socket) => serve(socket, true))
      : createTcpServer((socket) => serve(socket, false));
  server.on('tlsClientError', () => {});
  server.on('connection', (socket: Socket) => {
    received.connections++;
    sockets.add(socket);
    socket.on('error', () => {});
    socket.once('close', () => sockets.delete(socket));
  });
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return { port: address.port, received, sockets };
}

interface ClientResult {
  ok: boolean;
  value?: { send?: boolean; messageId?: string };
  code?: string;
  connectionStage?: string;
}

function client(
  t: TestContext,
  port: number,
  secure: boolean,
  action: 'verify' | 'send',
  trustCertificate = true,
) {
  const env = { ...process.env };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  delete env.NODE_EXTRA_CA_CERTS;
  if (trustCertificate) env.NODE_EXTRA_CA_CERTS = certificatePath;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('client.ts', fixtureDirectory)),
      JSON.stringify({ port, secure, action }),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let result: ClientResult | undefined;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.on('message', (message) => (result = message as ClientResult));
  const timer = setTimeout(() => child.kill(), 15_000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  });
  const done = new Promise<ClientResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || !result) {
        reject(new Error(`SMTP fixture client failed (${code ?? signal}): ${stderr}`));
        return;
      }
      resolve(result);
    });
  });
  return { done, abort: () => child.send('abort') };
}

for (const mode of ['tls', 'starttls'] as const) {
  test(`SMTP ${mode} verifies and sends over authenticated, certificate-verified TLS`, async (t) => {
    const fixture = await smtpFixture(t, mode);
    const verified = await client(t, fixture.port, mode === 'tls', 'verify').done;
    assert.deepEqual(verified, { ok: true, value: { send: true } });
    assert.equal(fixture.received.messages, 0);
    const sent = await client(t, fixture.port, mode === 'tls', 'send').done;
    assert.deepEqual(sent, { ok: true, value: { messageId: '<loom.loopback@example.test>' } });
    assert.deepEqual(fixture.received, {
      connections: 2,
      auth: 2,
      encryptedAuth: 2,
      messages: 1,
      upgrades: mode === 'starttls' ? 2 : 0,
    });
  });

  test(`SMTP ${mode} rejects an untrusted certificate before authentication`, async (t) => {
    const fixture = await smtpFixture(t, mode);
    const result = await client(t, fixture.port, mode === 'tls', 'verify', false).done;
    assert.equal(result.ok, false);
    assert.equal(result.code, 'tls_failed');
    assert.equal(result.connectionStage, 'smtp');
    assert.equal(fixture.received.connections, 1);
    assert.equal(fixture.received.auth, 0);
    assert.equal(fixture.received.messages, 0);
  });

  test(
    `SMTP ${mode} abort closes an active connection without sending`,
    { timeout: 20_000 },
    async (t) => {
      let running: ReturnType<typeof client>;
      const fixture = await smtpFixture(t, mode, () => running.abort());
      running = client(t, fixture.port, mode === 'tls', 'send');
      const result = await running.done;
      assert.equal(result.ok, false);
      assert.equal(result.code, 'cancelled');
      assert.equal(result.connectionStage, 'smtp');
      assert.equal(fixture.received.auth, 1);
      assert.equal(fixture.received.messages, 0);
      // The server's close event may arrive after the client process exits.
      await Promise.all(
        [...fixture.sockets].map(
          (socket) => new Promise<void>((resolve) => socket.once('close', () => resolve())),
        ),
      );
      assert.equal(fixture.sockets.size, 0);
    },
  );
}
