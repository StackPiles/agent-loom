/** Private, per-process transport between Loom and its pinned Chrome input adapter. */
export function encodeBrowserCredential(channel: string, origin: string, value: string): string {
  return `\u001eAgentLoom:${channel}:` + JSON.stringify({ origin, value });
}

export function decodeBrowserCredential(
  channel: string | undefined,
  input: string,
): { origin: string; value: string } | undefined {
  if (!channel) return;
  const prefix = `\u001eAgentLoom:${channel}:`;
  if (!input.startsWith(prefix)) return;
  try {
    const data: unknown = JSON.parse(input.slice(prefix.length));
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    const { origin, value } = data as Record<string, unknown>;
    if (
      typeof origin !== 'string' ||
      !['http:', 'https:'].includes(new URL(origin).protocol) ||
      new URL(origin).origin !== origin ||
      typeof value !== 'string' ||
      !value ||
      value.length > 16_384
    )
      throw new Error();
    return { origin, value };
  } catch {
    throw new Error('The private browser credential input is invalid.');
  }
}
