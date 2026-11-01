import { request } from 'node:https';
import { MailAccountError, type MailProviderContext } from './types.js';

export type MailApiOrigin = 'https://api.agentmail.to' | 'https://api.resend.com';
export interface MailApiRequest {
  origin: MailApiOrigin;
  path: string;
  method?: 'GET' | 'POST';
  body?: Record<string, unknown>;
  idempotencyKey?: string;
}
export type MailApiTransport = (
  context: MailProviderContext,
  request: MailApiRequest,
) => Promise<Record<string, unknown>>;

/** Fixed TLS origins, no redirects or cookie jar, finite deadline and response size. */
export const mailApiRequest: MailApiTransport = async (context, input) => {
  context.check();
  if (!context.secrets.apiKey) throw new MailAccountError('credentials_required', true);
  if (
    !['https://api.agentmail.to', 'https://api.resend.com'].includes(input.origin) ||
    !input.path.startsWith('/') ||
    input.path.startsWith('//') ||
    /[\r\n]/.test(input.path)
  )
    throw new MailAccountError('invalid_request', true);
  const body = input.body ? JSON.stringify(input.body) : undefined;
  if (body && Buffer.byteLength(body) > 400_000)
    throw new MailAccountError('invalid_request', true);
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (error?: unknown, value?: Record<string, unknown>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      context.signal.removeEventListener('abort', cancel);
      if (error) reject(error);
      else resolve(value!);
    };
    const req = request(
      `${input.origin}${input.path}`,
      {
        method: input.method ?? 'GET',
        headers: {
          Authorization: `Bearer ${context.secrets.apiKey}`,
          Accept: 'application/json',
          'User-Agent': 'Agent-Loom/mail',
          ...(body
            ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) }
            : {}),
          ...(input.idempotencyKey ? { 'Idempotency-Key': input.idempotencyKey } : {}),
        },
        maxHeaderSize: 32_768,
        rejectUnauthorized: true,
        agent: false,
      },
      (response) => {
        const status = response.statusCode ?? 0;
        if (status < 200 || status >= 300) {
          response.destroy();
          const code = [401, 403].includes(status)
            ? 'authentication_failed'
            : status === 404
              ? 'not_found'
              : status === 429
                ? 'rate_limited'
                : status >= 400 && status < 500
                  ? 'invalid_request'
                  : 'connection_failed';
          finish(new MailAccountError(code, status >= 400 && status < 500));
          return;
        }
        const chunks: Buffer[] = [];
        let size = 0;
        response.on('data', (chunk: Buffer) => {
          size += chunk.length;
          if (size > 2_000_000) {
            response.destroy();
            req.destroy();
            finish(new MailAccountError('message_too_large'));
          } else chunks.push(chunk);
        });
        response.once('error', () => finish(new MailAccountError('connection_failed')));
        response.once('aborted', () => finish(new MailAccountError('connection_failed')));
        response.once('end', () => {
          try {
            const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
            if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
            finish(undefined, parsed);
          } catch {
            finish(new MailAccountError('connection_failed'));
          }
        });
      },
    );
    const cancel = () => {
      req.destroy();
      finish(new MailAccountError('cancelled'));
    };
    const timer = setTimeout(() => {
      req.destroy();
      finish(new MailAccountError('timeout'));
    }, 20_000);
    context.signal.addEventListener('abort', cancel, { once: true });
    req.once('error', () => finish(new MailAccountError('connection_failed')));
    if (context.signal.aborted) cancel();
    else req.end(body);
  });
};

export const apiPath = (inboxId: string, suffix = '') =>
  `/inboxes/${encodeURIComponent(inboxId)}${suffix}`;
export function queryPath(
  path: string,
  values: Record<string, string | number | undefined>,
): string {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values))
    if (value !== undefined) params.set(key, String(value));
  return `${path}?${params.toString()}`;
}

export function apiArray(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value) || value.length > 100) throw new MailAccountError('connection_failed');
  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry))
      throw new MailAccountError('connection_failed');
    return entry as Record<string, unknown>;
  });
}

export function apiId(value: unknown): string {
  if (
    typeof value !== 'string' ||
    !value ||
    value === '.' ||
    value === '..' ||
    value.length > 2_000 ||
    /[\r\n\0]/.test(value)
  )
    throw new MailAccountError('connection_failed');
  return value;
}

export function apiToken(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined;
  if (typeof value !== 'string' || value.length > 8_000)
    throw new MailAccountError('connection_failed');
  return value;
}
