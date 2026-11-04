import assert from 'node:assert/strict';
import test from 'node:test';
import { ApiError, api } from '../src/client/api.js';
import { mailErrorText } from '../src/client/mail-ui.js';
import type { MailAccountErrorCode } from '../src/shared/mail-accounts.js';
import { MailAccountError, safeMailError } from '../src/server/mail-providers/types.js';

const privateDiagnostic = 'fixture-password-and-private-provider-response';
const ja = (value: string) => value;
const en = (_ja: string, value: string) => value;

test('structured mail transport failures distinguish DNS, refusal, TLS and timeout without diagnostic text', () => {
  const cases: [Record<string, unknown>, MailAccountErrorCode][] = [
    [{ code: 'ENOTFOUND' }, 'dns_failed'],
    [{ code: 'EDNS', originalCode: 'EAI_AGAIN' }, 'dns_failed'],
    [{ code: 'ECONNREFUSED' }, 'connection_refused'],
    [{ code: 'ESOCKET', originalCode: 'ECONNREFUSED' }, 'connection_refused'],
    [{ code: 'ERR_TLS_CERT_ALTNAME_INVALID' }, 'tls_failed'],
    [{ code: 'ESOCKET', originalCode: 'DEPTH_ZERO_SELF_SIGNED_CERT' }, 'tls_failed'],
    [{ code: 'ETLS' }, 'tls_failed'],
    [{ tlsFailed: true }, 'tls_failed'],
    [{ code: 'ERR_SSL_WRONG_VERSION_NUMBER' }, 'tls_failed'],
    [{ code: 'ESOCKET', originalCode: 'CERT_HAS_EXPIRED' }, 'tls_failed'],
    [{ code: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'EDNS', originalCode: 'ETIMEDOUT' }, 'timeout'],
    [{ code: 'GREETING_TIMEOUT' }, 'timeout'],
    [{ code: 'UPGRADE_TIMEOUT', tlsFailed: true }, 'timeout'],
    [{ code: 'ERR_TLS_HANDSHAKE_TIMEOUT' }, 'timeout'],
    [{ code: 'ECONNRESET' }, 'connection_failed'],
    [{ code: privateDiagnostic }, 'connection_failed'],
    [{}, 'connection_failed'],
  ];
  for (const [details, expected] of cases) {
    const raw = Object.assign(new Error(privateDiagnostic), details, {
      response: privateDiagnostic,
      cause: new Error(privateDiagnostic),
    });
    const result = safeMailError(raw, 'smtp');
    assert.equal(result.code, expected, JSON.stringify(details));
    assert.equal(result.connectionStage, 'smtp');
    assert.equal(result.definiteNoSend, false, 'transport failures must not enable send retries');
    assert.ok(!result.message.includes(privateDiagnostic));
    assert.ok(!JSON.stringify(result).includes(privateDiagnostic));
    assert.equal(result.cause, undefined);
    assert.equal(result.statusCode, expected === 'timeout' ? 504 : 400);
  }
  assert.equal(
    safeMailError(new Error('TLS certificate failed: ' + privateDiagnostic)).code,
    'connection_failed',
    'unstructured provider messages must not be interpreted or exposed',
  );
});

test('adding a mail connection stage preserves the originating error and send safety flags', () => {
  for (const code of ['network_denied', 'stale_revision', 'send_uncertain'] as const) {
    for (const definiteNoSend of [true, false]) {
      const original = new MailAccountError(code, definiteNoSend);
      assert.equal(safeMailError(original), original);
      const staged = safeMailError(original, 'imap');
      assert.equal(staged.code, code);
      assert.equal(staged.definiteNoSend, definiteNoSend);
      assert.equal(staged.statusCode, original.statusCode);
      assert.equal(staged.connectionStage, 'imap');
      assert.equal(safeMailError(staged, 'smtp'), staged, 'the first failing stage is retained');
    }
  }
  for (const details of [
    { code: 'EAUTH' },
    { authenticationFailed: true },
    { serverResponseCode: 'AUTHENTICATIONFAILED' },
  ]) {
    const error = safeMailError(details, 'imap');
    assert.equal(error.code, 'authentication_failed');
    assert.equal(error.definiteNoSend, true);
    assert.equal(error.connectionStage, 'imap');
  }
  const invalid = safeMailError({ code: 'EENVELOPE' }, 'smtp');
  assert.equal(invalid.code, 'invalid_request');
  assert.equal(invalid.definiteNoSend, true);
});

test('mail API errors display the receive/send stage in both languages without raw provider text', async (t) => {
  let payload: Record<string, unknown> = {};
  t.mock.method(globalThis, 'fetch', async () => Response.json(payload, { status: 400 }));
  for (const stage of ['imap', 'smtp'] as const) {
    payload = { error: privateDiagnostic, code: 'tls_failed', connectionStage: stage };
    await assert.rejects(api('/mail/accounts/test', 'POST', {}), (error: unknown) => {
      assert.ok(error instanceof ApiError);
      assert.equal(error.connectionStage, stage);
      const japanese = mailErrorText(error, ja);
      const english = mailErrorText(error, en);
      assert.ok(japanese.startsWith(stage === 'imap' ? '受信（IMAP）: ' : '送信（SMTP）: '));
      assert.ok(english.startsWith(stage === 'imap' ? 'Receiving (IMAP): ' : 'Sending (SMTP): '));
      assert.ok(japanese.includes('証明書'));
      assert.ok(english.includes('certificate'));
      assert.ok(!japanese.includes(privateDiagnostic));
      assert.ok(!english.includes(privateDiagnostic));
      return true;
    });
  }
  payload = {
    error: privateDiagnostic,
    code: 'connection_failed',
    connectionStage: privateDiagnostic,
  };
  await assert.rejects(api('/mail/accounts/test'), (error: unknown) => {
    assert.ok(error instanceof ApiError);
    assert.equal(error.connectionStage, undefined, 'API payload stage is allowlisted');
    assert.ok(!mailErrorText(error, ja).includes(privateDiagnostic));
    return true;
  });
  assert.ok(!mailErrorText(new Error(privateDiagnostic), ja).includes(privateDiagnostic));
  const search = mailErrorText(new ApiError(privateDiagnostic, 400, 'search_failed', 'imap'), ja);
  assert.ok(search.startsWith('受信（IMAP）: '));
  assert.ok(search.includes('受信箱には接続できました'));
  assert.ok(search.includes('検索・一覧取得に失敗'));
  assert.ok(!search.includes('TLS'));
  assert.ok(!search.includes(privateDiagnostic));
});
