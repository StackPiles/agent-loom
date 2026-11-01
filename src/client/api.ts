import type { Message, ServerEvent, Snapshot } from '../shared/types';

export class ApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: string,
  ) {
    super(message);
  }
}
export async function api<T = unknown>(
  path: string,
  method = 'GET',
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(`/api${path}`, {
    method,
    credentials: 'same-origin',
    ...(signal ? { signal } : {}),
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok)
    throw new ApiError(
      payload?.error || `${response.status} ${response.statusText}`,
      response.status,
      typeof payload?.code === 'string' ? payload.code : undefined,
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
  if (event.type === 'message_reasoning_delta' && current) {
    const { messageId, delta, truncated } = event.data as {
      messageId: string;
      delta: string;
      truncated?: boolean;
    };
    return {
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId
          ? {
              ...message,
              reasoning: (message.reasoning || '') + delta,
              reasoningStatus: 'streaming',
              reasoningTruncated: message.reasoningTruncated || truncated,
            }
          : message,
      ),
    };
  }
  if (event.type === 'message_updated' && current) {
    const { messageId, patch } = event.data as { messageId: string; patch: Partial<Message> };
    return {
      ...current,
      messages: current.messages.map((message) =>
        message.id === messageId ? { ...message, ...patch, id: message.id } : message,
      ),
    };
  }
  return current;
}
