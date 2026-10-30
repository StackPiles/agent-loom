import { lookup } from 'node:dns/promises';
import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { isIP } from 'node:net';
import { throwIfAborted } from './gate.js';

/** Public-address-only by default. Pinned DNS also closes the lookup/request gap. */
export function isPublicAddress(address: string): boolean {
  const ip = address
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .split('%')[0];
  if (isIP(ip) === 4) {
    const [a, b, c] = ip.split('.').map(Number);
    return !(
      a === 0 ||
      a === 10 ||
      a === 127 ||
      a >= 224 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) ||
      (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) ||
      (a === 203 && b === 0 && c === 113)
    );
  }
  if (isIP(ip) !== 6) return false;
  // Accept global unicast only. This excludes loopback, local, multicast,
  // IPv4-mapped and NAT64 addresses (including private IPv4 translations).
  const first = parseInt(ip.split(':')[0] || '0', 16);
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !/^2001:0?db8:/i.test(ip) &&
    !/^2001:0{0,4}:/i.test(ip) &&
    !/^2002:/i.test(ip)
  ); // 6to4 can embed a private IPv4 destination.
}

export interface TextResponse {
  url: string;
  status: number;
  contentType: string;
  text: string;
}

interface RequestOptions {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  maxBytes?: number;
  timeoutMs?: number;
  /** Only for an explicitly configured integration such as local SearXNG. */
  allowPrivate?: boolean;
  /** Credential-bearing integrations must not redirect to a different origin. */
  sameOriginRedirects?: boolean;
  /** Runs before contacting a redirect target; throwing stops the redirect. */
  validateRedirect?: (target: URL) => void;
}

export async function requestText(
  input: string,
  options: RequestOptions = {},
): Promise<TextResponse> {
  const deadline = AbortSignal.timeout(options.timeoutMs ?? 20_000);
  const signal = options.signal ? AbortSignal.any([options.signal, deadline]) : deadline;
  const initial = new URL(input);
  let url = initial;
  for (let redirects = 0; redirects <= 4; redirects++) {
    throwIfAborted(signal);
    if (!['http:', 'https:'].includes(url.protocol))
      throw new Error('Only HTTP and HTTPS URLs are supported.');
    if (url.username || url.password) throw new Error('Credentials in URLs are not allowed.');
    const hostname = url.hostname.replace(/^\[|\]$/g, '');
    const addresses = isIP(hostname)
      ? [{ address: hostname, family: isIP(hostname) }]
      : await abortable(lookup(hostname, { all: true, verbatim: true }), signal);
    if (!addresses.length) throw new Error('The URL hostname did not resolve.');
    if (!options.allowPrivate && addresses.some(({ address }) => !isPublicAddress(address))) {
      throw new Error(
        'This URL resolves to a local, private, reserved, or metadata address. Web fetch permits public addresses only.',
      );
    }
    const pinned = addresses[0];
    const response = await new Promise<{
      status: number;
      location?: string;
      contentType: string;
      body: string;
    }>((resolve, reject) => {
      const request = (url.protocol === 'https:' ? httpsRequest : httpRequest)(
        url,
        {
          agent: false,
          signal,
          headers: {
            'user-agent': 'AgentLoom/0.1 (+https://github.com/StackPiles/agent-loom)',
            accept: 'text/html, application/json, text/plain, application/xml;q=0.8',
            'accept-encoding': 'identity',
            ...options.headers,
          },
          lookup: (_hostname, _options, callback) => {
            // Node can request all records when its family auto-selection is enabled.
            if (typeof _options === 'object' && _options.all) {
              (
                callback as unknown as (
                  error: null,
                  records: Array<{ address: string; family: number }>,
                ) => void
              )(null, [pinned]);
            } else callback(null, pinned.address, pinned.family);
          },
        },
        (response) => {
          const status = response.statusCode ?? 0;
          const contentType = response.headers['content-type'] ?? '';
          const maxBytes = options.maxBytes ?? 2_000_000;
          if (Number(response.headers['content-length'] ?? 0) > maxBytes) {
            response.destroy();
            request.destroy();
            reject(new Error(`Response exceeds ${maxBytes} bytes.`));
            return;
          }
          const chunks: Buffer[] = [];
          let bytes = 0;
          response.on('data', (chunk: Buffer) => {
            bytes += chunk.length;
            if (bytes > maxBytes) {
              response.destroy();
              request.destroy();
              reject(new Error(`Response exceeds ${maxBytes} bytes.`));
            } else chunks.push(chunk);
          });
          response.on('error', reject);
          response.on('end', () =>
            resolve({
              status,
              location: response.headers.location,
              contentType,
              body: Buffer.concat(chunks).toString('utf8'),
            }),
          );
        },
      );
      request.on('error', reject);
      request.end();
    });
    if ([301, 302, 303, 307, 308].includes(response.status) && response.location) {
      url = new URL(response.location, url);
      if (options.sameOriginRedirects && url.origin !== initial.origin) {
        throw new Error(
          'The configured integration redirected to another origin; credentials were not forwarded.',
        );
      }
      options.validateRedirect?.(url);
      continue;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`The remote server returned HTTP ${response.status}.`);
    }
    return {
      url: url.href,
      status: response.status,
      contentType: response.contentType,
      text: response.body,
    };
  }
  throw new Error('The URL redirected more than four times.');
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(new Error('Network request cancelled or timed out.'));
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    if (signal.aborted) abort();
  });
}

export function readablePage(text: string, contentType: string): string {
  if (contentType && !/(?:text\/|json|xml|html)/i.test(contentType)) {
    throw new Error(
      `Unsupported page type: ${contentType.split(';')[0]}. Only text pages are supported.`,
    );
  }
  if (/html/i.test(contentType) || /<!doctype html|<html[\s>]/i.test(text.slice(0, 300))) {
    text = text
      .replace(/<(script|style|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, '')
      .replace(/<(?:br|\/p|\/div|\/h[1-6]|\/li|\/section)\s*[^>]*>/gi, '\n')
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[\t ]+/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }
  return text.length > 24_000 ? `${text.slice(0, 24_000)}\n[Truncated at 24,000 characters]` : text;
}
