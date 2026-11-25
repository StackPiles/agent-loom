/** A browser entry point and the exact origin allowed to receive its saved password. */
export interface ServiceLogin {
  loginUrl: string;
  credentialOrigin: string;
  provider: 'google' | 'amazon-jp' | 'custom';
}

/** Shared by server validation and the settings preview. Never echo a rejected URL. */
export function normalizeServiceLoginUrl(value: string): string {
  if (typeof value !== 'string') throw new Error('Use an HTTP(S) login URL without credentials.');
  const text = value.trim();
  try {
    if (!text || text.length > 2_000 || /[\u0000-\u001f\u007f]/.test(text))
      throw new Error('Invalid URL.');
    const url = new URL(text);
    const privateKey = /password|secret|token|api[_-]?key/i;
    if (
      !['https:', 'http:'].includes(url.protocol) ||
      url.username ||
      url.password ||
      [...url.searchParams.keys()].some((key) => privateKey.test(key)) ||
      [...new URLSearchParams(url.hash.slice(1))].some(
        ([key, value]) => value.length > 0 && privateKey.test(key),
      )
    )
      throw new Error('Invalid URL.');
    return url.toString();
  } catch {
    throw new Error('Use an HTTP(S) login URL without credentials.');
  }
}

/**
 * The catalog contains exact, verified HTTPS origins, never hostname suffixes or
 * destinations discovered in page text/redirects. An explicit login entry point
 * remains independent of the service's working URL after registration.
 */
export function resolveServiceLogin(url: string, loginUrl?: string): ServiceLogin {
  // Once present, the authentication entry has its own validation and identity.
  // An unrelated legacy working-page fragment must not invalidate that binding.
  let entry = normalizeServiceLoginUrl(loginUrl === undefined ? url : loginUrl);
  const origin = new URL(entry).origin;
  if (origin === 'https://mail.google.com') {
    // Gmail's application pages all start authentication with Google Accounts.
    if (loginUrl === undefined) entry = 'https://accounts.google.com/ServiceLogin?service=mail';
    return { loginUrl: entry, credentialOrigin: 'https://accounts.google.com', provider: 'google' };
  }
  if (origin === 'https://accounts.google.com')
    return { loginUrl: entry, credentialOrigin: origin, provider: 'google' };
  if (origin === 'https://affiliate.amazon.co.jp') {
    // Keep the official Associates entry point so Amazon retains the return URL.
    if (loginUrl === undefined) entry = 'https://affiliate.amazon.co.jp/login';
    return { loginUrl: entry, credentialOrigin: 'https://www.amazon.co.jp', provider: 'amazon-jp' };
  }
  if (origin === 'https://www.amazon.co.jp')
    return { loginUrl: entry, credentialOrigin: origin, provider: 'amazon-jp' };
  return { loginUrl: entry, credentialOrigin: origin, provider: 'custom' };
}
