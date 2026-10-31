import type { BrowserSettings } from './types.js';

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: false,
  mode: 'existing',
  permission: 'auto',
  includeScreenshotsInModel: false,
};

export const BROWSER_OPERATIONS = [
  'tabs',
  'open',
  'navigate',
  'snapshot',
  'click',
  'fill',
  'press_key',
  'scroll',
  'hover',
  'screenshot',
  'close',
  'dialog',
] as const;
export type BrowserOperation = (typeof BROWSER_OPERATIONS)[number];
export const BROWSER_READ_OPERATIONS: ReadonlySet<BrowserOperation> = new Set([
  'tabs',
  'snapshot',
  'screenshot',
]);
