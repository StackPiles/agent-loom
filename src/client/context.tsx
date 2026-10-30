import { createContext, useContext } from 'react';
import type { Snapshot, TaskStatus } from '../shared/types';

export type Locale = 'ja' | 'en';
export type View = 'chat' | 'team' | 'automations' | 'learning' | 'inbox' | 'settings';
export interface AppContextValue {
  data: Snapshot;
  locale: Locale;
  t: (ja: string, en: string) => string;
  view: View;
  roomId: string;
  navigate: (view: View, roomId?: string) => void;
  refresh: () => Promise<void>;
  toast: (message: string, kind?: 'success' | 'error') => void;
  signOut: () => Promise<void>;
  mutate: <T = unknown>(
    path: string,
    method?: string,
    body?: unknown,
    success?: string,
  ) => Promise<T>;
}
export const AppContext = createContext<AppContextValue | null>(null);
export function useApp() {
  const context = useContext(AppContext);
  if (!context) throw new Error('App context unavailable');
  return context;
}
export const activeStatuses: TaskStatus[] = [
  'queued',
  'running',
  'waiting_model',
  'waiting_tool',
  'awaiting_approval',
];
export function statusLabel(status: TaskStatus, locale: Locale) {
  const labels: Record<TaskStatus, [string, string]> = {
    queued: ['順番待ち', 'Queued'],
    running: ['考えています', 'Thinking'],
    waiting_model: ['モデル待ち', 'Waiting for model'],
    waiting_tool: ['ツール実行中', 'Running a tool'],
    awaiting_approval: ['承認待ち', 'Needs approval'],
    stopped: ['停止済み', 'Stopped'],
    interrupted: ['中断・再開できます', 'Interrupted · resumable'],
    failed: ['エラー', 'Failed'],
    completed: ['完了', 'Completed'],
  };
  return labels[status][locale === 'ja' ? 0 : 1];
}
export function dateLabel(value: string, locale: Locale, full = false) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '—';
  return new Intl.DateTimeFormat(
    locale === 'ja' ? 'ja-JP' : 'en-US',
    full
      ? { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }
      : { hour: '2-digit', minute: '2-digit' },
  ).format(date);
}
