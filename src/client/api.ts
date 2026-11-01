import type { Message, ServerEvent, Snapshot } from '../shared/types';
import type {
  MailAccount,
  MailAccountInput,
  MailAccountTestResult,
  MailDraft,
  MailDraftInput,
  MailListOptions,
  MailListResult,
  MailMessage,
  MailSendOptions,
} from '../shared/mail-accounts';

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

export const mailApi = {
  saveAccount: (input: MailAccountInput, id?: string) =>
    api<MailAccount>(
      id ? `/mail/accounts/${encodeURIComponent(id)}` : '/mail/accounts',
      id ? 'PUT' : 'POST',
      input,
    ),
  test: (input: MailAccountInput, existingId?: string, signal?: AbortSignal) =>
    api<MailAccountTestResult>(
      '/mail/accounts/test',
      'POST',
      { input, ...(existingId ? { existingId } : {}) },
      signal,
    ),
  messages: (accountId: string, options: MailListOptions = {}, signal?: AbortSignal) => {
    const query = new URLSearchParams();
    if (options.query) query.set('query', options.query);
    if (options.cursor) query.set('cursor', options.cursor);
    if (options.limit) query.set('limit', String(options.limit));
    return api<MailListResult>(
      `/mail/accounts/${encodeURIComponent(accountId)}/messages?${query}`,
      'GET',
      undefined,
      signal,
    );
  },
  message: (accountId: string, messageId: string, signal?: AbortSignal) =>
    api<MailMessage>(
      `/mail/accounts/${encodeURIComponent(accountId)}/messages/${encodeURIComponent(messageId)}`,
      'GET',
      undefined,
      signal,
    ),
  drafts: (accountId: string, signal?: AbortSignal) =>
    api<MailDraft[]>(
      `/mail/drafts?accountId=${encodeURIComponent(accountId)}`,
      'GET',
      undefined,
      signal,
    ),
  saveDraft: (input: MailDraftInput, id?: string) =>
    api<MailDraft>(
      id ? `/mail/drafts/${encodeURIComponent(id)}` : '/mail/drafts',
      id ? 'PUT' : 'POST',
      input,
    ),
  sendDraft: (id: string, options: MailSendOptions) =>
    api<MailDraft>(`/mail/drafts/${encodeURIComponent(id)}/send`, 'POST', options),
};
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
