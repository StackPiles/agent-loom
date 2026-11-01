import { createContext, useContext } from 'react';
import type { Snapshot, TaskStatus } from '../shared/types';
import { activeTaskStatuses, getTaskPresentation } from './task-status';

export type Locale = 'ja' | 'en';
export type View = 'chat' | 'team' | 'accounts' | 'automations' | 'learning' | 'inbox' | 'settings';
export interface AppContextValue {
  data: Snapshot;
  connected?: boolean;
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
export const activeStatuses = activeTaskStatuses;
export function statusLabel(status: TaskStatus, locale: Locale) {
  return getTaskPresentation(status, locale).label;
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
