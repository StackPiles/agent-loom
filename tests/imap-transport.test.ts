import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { Socket } from 'node:net';
import { createServer, type TLSSocket } from 'node:tls';
import { fileURLToPath } from 'node:url';

// Reuse the existing public test-only certificate; verification remains enabled.
const certificatePath = fileURLToPath(new URL('./fixtures/smtp/certificate.pem', import.meta.url));
const tlsOptions = {
  cert: readFileSync(certificatePath),
  key: readFileSync(new URL('./fixtures/smtp/test-only-key.pem', import.meta.url)),
  minVersion: 'TLSv1.2' as const,
};
type MetadataField = 'uidNext' | 'uidValidity' | 'exists';
interface FixtureOptions {
  omit?: MetadataField[];
  empty?: boolean;
  status?: 'ok' | 'reject' | 'incomplete' | 'changed';
  body?: 'flags-first' | 'unrelated-flags-first' | 'missing';
  metadata?: 'split' | 'absent' | 'oversized';
}
interface Row {
  uid: number;
  subject: string;
  date: string;
  text: string;
}
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const quoted = (value: string) => `"${value.replace(/["\\]/g, '\\$&')}"`;
const source = (row: Row) =>
  Buffer.from(
    `From: Sender <sender@example.test>\r\nTo: bot@example.test\r\nSubject: ${row.subject}\r\nMessage-ID: <fixture${row.uid}@example.test>\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${row.text}\r\n`,
  );

async function imapFixture(t: TestContext, options: FixtureOptions = {}) {
  const sockets = new Set<Socket>();
  const rows: Row[] = options.empty
    ? []
    : [
        {
          uid: 42,
          subject: 'Earlier message',
          date: '2026-10-28T11:00:00.000Z',
          text: 'Earlier fixture body.',
        },
        {
          uid: 43,
          subject: 'keep this message',
          date: '2026-10-28T12:00:01.000Z',
          text: 'Current fixture body.',
        },
      ];
  // An empty mailbox can retain an advanced UIDNEXT after messages were removed.
  let uidNext = options.empty ? 100 : 44;
  const received = {
    commands: [] as string[],
    invalidCommands: [] as string[],
    statusCalls: 0,
    advances: 0,
    beforeAdvance: [] as string[],
  };
  const selectedRows = (range: string, uid: boolean) =>
    rows.filter((row, index) =>
      range.split(',').some((part) => {
        const [first, last = first] = part.split(':').map(Number);
        const value = uid ? row.uid : index + 1;
        return value >= first && value <= last;
      }),
    );
  const serve = (socket: TLSSocket) => {
    let buffer = '';
    socket.on('error', () => {});
    socket.write('* OK [CAPABILITY IMAP4rev1 ESEARCH] IMAP loopback fixture\r\n');
    const bad = (tag: string, command: string) => {
      received.invalidCommands.push(command);
      socket.write(`${tag} BAD Unsupported or invalid fixture command\r\n`);
    };
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      let end: number;
      while ((end = buffer.indexOf('\r\n')) >= 0) {
        const line = buffer.slice(0, end);
        buffer = buffer.slice(end + 2);
        const match = /^(\S+) (.+)$/.exec(line);
        if (!match) {
          socket.destroy();
          return;
        }
        const [, tag, command] = match;
        received.commands.push(command.startsWith('LOGIN ') ? 'LOGIN [fixture]' : command);
        if (command === 'CAPABILITY') {
          socket.write(`* CAPABILITY IMAP4rev1 ESEARCH\r\n${tag} OK CAPABILITY completed\r\n`);
        } else if (command.startsWith('LOGIN ')) {
          socket.write(`${tag} OK [CAPABILITY IMAP4rev1 ESEARCH] Logged in\r\n`);
        } else if (command === 'LIST "" ""') {
          socket.write(`* LIST (\\Noselect) "/" ""\r\n${tag} OK LIST completed\r\n`);
        } else if (command.startsWith('LIST ') || command.startsWith('LSUB ')) {
          const verb = command.startsWith('LSUB ') ? 'LSUB' : 'LIST';
          socket.write(
            `* ${verb} (\\HasNoChildren) "/" "INBOX"\r\n${tag} OK ${verb} completed\r\n`,
          );
        } else if (command.startsWith('EXAMINE ')) {
          const metadata = ['* FLAGS (\\Seen)', '* 0 RECENT'];
          if (!options.omit?.includes('exists')) metadata.push(`* ${rows.length} EXISTS`);
          if (!options.omit?.includes('uidNext'))
            metadata.push(`* OK [UIDNEXT ${uidNext}] Next UID`);
          if (!options.omit?.includes('uidValidity'))
            metadata.push('* OK [UIDVALIDITY 3] UID validity');
          socket.write(`${metadata.join('\r\n')}\r\n${tag} OK [READ-ONLY] EXAMINE completed\r\n`);
        } else if (command.startsWith('STATUS ')) {
          received.statusCalls++;
          if (options.status === 'reject') {
            socket.write(`${tag} NO [UNAVAILABLE] STATUS unavailable in fixture\r\n`);
          } else {
            const next = options.status === 'incomplete' ? '' : ` UIDNEXT ${uidNext}`;
            const validity = options.status === 'changed' ? 4 : 3;
            socket.write(
              `* STATUS "INBOX" (MESSAGES ${rows.length}${next} UIDVALIDITY ${validity})\r\n${tag} OK STATUS completed\r\n`,
            );
          }
        } else if (command.startsWith('UID SEARCH ')) {
          const query = command.slice('UID SEARCH '.length);
          const range = /\bUID ([^ ]+)/.exec(query)?.[1];
          const bounds = range?.split(':').map(Number);
          if (
            range &&
            (!/^[1-9]\d*(?::[1-9]\d*)?$/.test(range) ||
              bounds!.some((value) => !Number.isSafeInteger(value) || value > 4_294_967_295) ||
              (bounds!.length > 1 && (bounds![0] > bounds![1] || bounds![1] - bounds![0] >= 2_000)))
          ) {
            bad(tag, command);
            continue;
          }
          let matches = range ? selectedRows(range, true) : [...rows];
          const text = /\bTEXT (?:"([^"]*)"|(\S+))/.exec(query);
          if (text) {
            const needle = (text[1] ?? text[2]).toLowerCase();
            matches = matches.filter((row) =>
              `${row.subject} ${row.text}`.toLowerCase().includes(needle),
            );
          }
          const since = /\bSINCE (\d{1,2})-([A-Za-z]{3})-(\d{4})/.exec(query);
          if (since) {
            const cutoff = Date.UTC(Number(since[3]), months.indexOf(since[2]), Number(since[1]));
            matches = matches.filter((row) => Date.parse(row.date) >= cutoff);
          }
          if (query.startsWith('RETURN (MIN) ')) {
            const minimum = matches.length ? ` MIN ${matches[0].uid}` : '';
            socket.write(
              `* ESEARCH (TAG "${tag}") UID${minimum}\r\n${tag} OK SEARCH completed\r\n`,
            );
          } else {
            const found = matches.length ? ` ${matches.map((row) => row.uid).join(' ')}` : '';
            socket.write(`* SEARCH${found}\r\n${tag} OK SEARCH completed\r\n`);
          }
        } else if (/^(UID )?FETCH /.test(command)) {
          const fetch = /^(UID )?FETCH ([^ ]+) (.+)$/.exec(command)!;
          if (!/^[1-9]\d*(?::[1-9]\d*)?(?:,[1-9]\d*(?::[1-9]\d*)?)*$/.test(fetch[2])) {
            bad(tag, command);
            continue;
          }
          for (const row of selectedRows(fetch[2], Boolean(fetch[1]))) {
            const seq = rows.indexOf(row) + 1;
            const body = source(row);
            if (fetch[3].includes('BODY.PEEK[]')) {
              if (options.body === 'flags-first' || options.body === 'missing') {
                socket.write(`* ${seq} FETCH (UID ${row.uid} FLAGS ())\r\n`);
              } else if (options.body === 'unrelated-flags-first') {
                // An unsolicited FLAGS response need not carry a UID. Neither
                // this row nor another message's flags are the requested body.
                socket.write('* 1 FETCH (FLAGS ())\r\n* 1 FETCH (UID 42 FLAGS ())\r\n');
              }
              if (options.body === 'missing') continue;
              socket.write(`* ${seq} FETCH (UID ${row.uid} BODY[]<0> {${body.length}}\r\n`);
              socket.write(body);
              socket.write(')\r\n');
            } else {
              const readingMetadata = fetch[3].includes('RFC822.SIZE');
              if (readingMetadata && options.metadata === 'absent') continue;
              const date = new Date(row.date);
              const internalDate = `${date.getUTCDate()}-${months[date.getUTCMonth()]}-${date.getUTCFullYear()} ${row.date.slice(11, 19)} +0000`;
              const sender = '(("Sender" NIL "sender" "example.test"))';
              const recipient = '((NIL NIL "bot" "example.test"))';
              const envelope = `(${quoted(date.toUTCString())} ${quoted(row.subject)} ${sender} ${sender} ${sender} ${recipient} NIL NIL NIL "<fixture${row.uid}@example.test>")`;
              const size =
                readingMetadata && options.metadata === 'oversized' ? 1_000_001 : body.length;
              if (readingMetadata && options.metadata === 'split') {
                socket.write(
                  `* ${seq} FETCH (UID ${row.uid} FLAGS ())\r\n` +
                    `* ${seq} FETCH (UID ${row.uid} RFC822.SIZE ${size})\r\n` +
                    `* ${seq} FETCH (UID ${row.uid} INTERNALDATE "${internalDate}" ENVELOPE ${envelope})\r\n`,
                );
              } else {
                socket.write(
                  `* ${seq} FETCH (UID ${row.uid} FLAGS () INTERNALDATE "${internalDate}" RFC822.SIZE ${size} ENVELOPE ${envelope})\r\n`,
                );
              }
            }
          }
          socket.write(`${tag} OK FETCH completed\r\n`);
        } else if (command === 'LOGOUT') {
          socket.end(`* BYE Bye\r\n${tag} OK LOGOUT completed\r\n`);
        } else {
          bad(tag, command);
        }
      }
    });
  };
  const server = createServer(tlsOptions, serve);
  server.on('tlsClientError', () => {});
  server.on('connection', (socket: Socket) => {
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
  return {
    port: address.port,
    received,
    advance() {
      received.beforeAdvance = [...received.commands];
      received.advances++;
      rows.push({
        uid: uidNext++,
        subject: 'First new arrival',
        date: '2026-10-28T12:00:03.000Z',
        text: 'Newly arrived fixture body.',
      });
    },
  };
}

interface ClientResult {
  ok: boolean;
  value?: unknown;
  code?: string;
  connectionStage?: string;
}

async function client(
  t: TestContext,
  fixture: Awaited<ReturnType<typeof imapFixture>>,
  action: 'full' | 'empty' | 'list' | 'read',
): Promise<ClientResult> {
  const env = { ...process.env, NODE_EXTRA_CA_CERTS: certificatePath };
  delete env.NODE_TLS_REJECT_UNAUTHORIZED;
  const child = spawn(
    process.execPath,
    [
      '--import',
      'tsx',
      fileURLToPath(new URL('./fixtures/imap/client.ts', import.meta.url)),
      JSON.stringify({ port: fixture.port, action }),
    ],
    { env, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] },
  );
  let result: ClientResult | undefined;
  let stderr = '';
  child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
  child.on('message', (message: { type: string; result?: ClientResult }) => {
    if (message.type === 'advance') {
      fixture.advance();
      child.send('advanced');
    } else if (message.type === 'result') {
      result = message.result;
    }
  });
  const timer = setTimeout(() => child.kill(), 15_000);
  t.after(() => {
    clearTimeout(timer);
    if (child.exitCode === null) child.kill();
  });
  return new Promise<ClientResult>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      clearTimeout(timer);
      if (code !== 0 || !result) {
        reject(new Error(`IMAP fixture client failed (${code ?? signal}): ${stderr}`));
      } else {
        resolve(result);
      }
    });
  });
}

test(
  'IMAP recovers omitted UIDNEXT for listing, searching, reading and consecutive polls',
  { timeout: 20_000 },
  async (t) => {
    const fixture = await imapFixture(t, { omit: ['uidNext'] });
    assert.deepEqual(await client(t, fixture, 'full'), {
      ok: true,
      value: {
        verified: { send: false },
        first: [43],
        firstValidity: ['3'],
        second: [42],
        searched: [43],
        read: { uid: 43, uidValidity: '3', text: 'Current fixture body.\n', unread: true },
        initial: { uids: [43], lastUid: 43, baseline: true, hasMore: false },
        later: { uids: [44], lastUid: 44, baseline: false, hasMore: false },
      },
    });
    assert.equal(fixture.received.statusCalls, 7);
    assert.equal(fixture.received.advances, 1);
    assert.deepEqual(fixture.received.invalidCommands, []);
    assert.ok(
      fixture.received.commands.every((command) => !/^(SELECT|STORE|APPEND)\b/.test(command)),
    );
  },
);

test('IMAP complete EXAMINE metadata needs no STATUS request', { timeout: 20_000 }, async (t) => {
  const fixture = await imapFixture(t);
  assert.deepEqual(await client(t, fixture, 'list'), {
    ok: true,
    value: { uids: [43, 42], validity: ['3', '3'] },
  });
  assert.equal(fixture.received.statusCalls, 0);
  assert.deepEqual(fixture.received.invalidCommands, []);
});

for (const field of ['uidValidity', 'exists'] as const) {
  test(`IMAP recovers omitted ${field} from STATUS`, { timeout: 20_000 }, async (t) => {
    const fixture = await imapFixture(t, { omit: [field] });
    assert.deepEqual(await client(t, fixture, 'list'), {
      ok: true,
      value: { uids: [43, 42], validity: ['3', '3'] },
    });
    assert.equal(fixture.received.statusCalls, 1);
    assert.deepEqual(fixture.received.invalidCommands, []);
  });
}

test(
  'IMAP empty mailbox skips SEARCH and preserves the checkpoint for the first arrival',
  { timeout: 20_000 },
  async (t) => {
    const fixture = await imapFixture(t, { omit: ['uidNext'], empty: true });
    assert.deepEqual(await client(t, fixture, 'empty'), {
      ok: true,
      value: {
        verified: { send: false },
        first: [],
        firstValidity: [],
        searched: [],
        initial: { uids: [], lastUid: 99, baseline: true, hasMore: false },
        later: { uids: [100], lastUid: 100, baseline: false, hasMore: false },
        repeated: { uids: [], lastUid: 100, baseline: false, hasMore: false },
      },
    });
    assert.ok(
      fixture.received.beforeAdvance.every((command) => !/\b(SEARCH|FETCH)\b/.test(command)),
    );
    assert.equal(fixture.received.advances, 1);
    assert.deepEqual(fixture.received.invalidCommands, []);
  },
);

for (const status of ['reject', 'incomplete', 'changed'] as const) {
  test(`IMAP ${status} STATUS metadata fails before searching`, { timeout: 20_000 }, async (t) => {
    const fixture = await imapFixture(t, { omit: ['uidNext'], status });
    assert.deepEqual(await client(t, fixture, 'list'), {
      ok: false,
      code: 'mailbox_metadata_unavailable',
      connectionStage: 'imap',
    });
    assert.equal(fixture.received.statusCalls, 1);
    assert.ok(fixture.received.commands.every((command) => !/\b(SEARCH|FETCH)\b/.test(command)));
    assert.deepEqual(fixture.received.invalidCommands, []);
  });
}

for (const body of ['flags-first', 'unrelated-flags-first'] as const) {
  test(
    `IMAP reading ignores ${body} responses before the requested body`,
    { timeout: 20_000 },
    async (t) => {
      const fixture = await imapFixture(t, { omit: ['uidNext'], body });
      assert.deepEqual(await client(t, fixture, 'read'), {
        ok: true,
        value: { uid: 43, uidValidity: '3', text: 'Current fixture body.\n', unread: true },
      });
      const sourceCommands = fixture.received.commands.filter((command) =>
        command.includes('BODY'),
      );
      assert.equal(sourceCommands.length, 1);
      assert.match(sourceCommands[0], /^UID FETCH 43 .*BODY\.PEEK\[\]<0\.1000001>/);
      assert.ok(
        fixture.received.commands.every((command) => !/^(SELECT|STORE|APPEND)\b/.test(command)),
      );
      assert.deepEqual(fixture.received.invalidCommands, []);
    },
  );
}

test(
  'IMAP reading merges metadata responses belonging to the requested UID',
  { timeout: 20_000 },
  async (t) => {
    const fixture = await imapFixture(t, { omit: ['uidNext'], metadata: 'split' });
    assert.deepEqual(await client(t, fixture, 'read'), {
      ok: true,
      value: { uid: 43, uidValidity: '3', text: 'Current fixture body.\n', unread: true },
    });
    assert.equal(
      fixture.received.commands.filter((command) => command.includes('BODY.PEEK[]')).length,
      1,
    );
    assert.deepEqual(fixture.received.invalidCommands, []);
  },
);

test(
  'IMAP reading a message removed after listing returns not-found without fetching a body',
  { timeout: 20_000 },
  async (t) => {
    const fixture = await imapFixture(t, { omit: ['uidNext'], metadata: 'absent' });
    assert.deepEqual(await client(t, fixture, 'read'), {
      ok: false,
      code: 'not_found',
      connectionStage: 'imap',
    });
    assert.ok(fixture.received.commands.every((command) => !command.includes('BODY')));
    assert.deepEqual(fixture.received.invalidCommands, []);
  },
);

test(
  'IMAP reading reports an unavailable body distinctly from an absent message',
  { timeout: 20_000 },
  async (t) => {
    const fixture = await imapFixture(t, { omit: ['uidNext'], body: 'missing' });
    assert.deepEqual(await client(t, fixture, 'read'), {
      ok: false,
      code: 'message_fetch_failed',
      connectionStage: 'imap',
    });
    assert.equal(
      fixture.received.commands.filter((command) => command.includes('BODY.PEEK[]')).length,
      1,
    );
    assert.deepEqual(fixture.received.invalidCommands, []);
  },
);

test(
  'IMAP reading rejects advertised oversized mail before fetching its body',
  { timeout: 20_000 },
  async (t) => {
    const fixture = await imapFixture(t, { omit: ['uidNext'], metadata: 'oversized' });
    assert.deepEqual(await client(t, fixture, 'read'), {
      ok: false,
      code: 'message_too_large',
      connectionStage: 'imap',
    });
    assert.ok(fixture.received.commands.every((command) => !command.includes('BODY')));
    assert.deepEqual(fixture.received.invalidCommands, []);
  },
);
