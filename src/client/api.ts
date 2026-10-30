import type { ServerEvent, Snapshot } from '../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      payload?.error || `${response.status} ${response.statusText}`,
      response.status,
    );
  return payload as T;
}
export function subscribe(
  onEvent: (event: ServerEvent) => void,
  onConnected: (connected: boolean) => void,
) {
  const stream = new EventSource('/api/events', { withCredentials: true });
  stream.onopen = () => onConnected(true);
  stream.onerror = () => onConnected(false);
  stream.onmessage = (event) => {
    try {
      onEvent(JSON.parse(event.data) as ServerEvent);
    } catch {
      /* Ignore incomplete heartbeats, reconnect for the next snapshot. */
    }
  };
  return () => stream.close();
}
export function applyEvent(current: Snapshot | null, event: ServerEvent): Snapshot | null {
  if (event.type === 'snapshot') return event.data as Snapshot;
  if (event.type === 'message_delta' && current) {
    const { messageId, delta } = event.data as { messageId: string; delta: string };
    return {
      ...current,
      messages: current.messages.map((m) =>
        m.id === messageId ? { ...m, body: m.body + delta } : m,
      ),
    };
  }
  return current;
}
