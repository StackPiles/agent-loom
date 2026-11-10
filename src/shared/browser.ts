import type { Bot, BotBrowserSettings, BrowserSettings } from './types.js';

export const DEFAULT_BROWSER_UPLOAD_SETTINGS = {
  uploadMaxFiles: 10,
  uploadMaxFileMiB: 256,
  uploadMaxTotalMiB: 512,
  uploadStorageMiB: 2048,
} as const;

export const BROWSER_UPLOAD_SETTING_LIMITS = {
  uploadMaxFiles: { min: 1, max: 100 },
  uploadMaxFileMiB: { min: 1, max: 1024 },
  uploadMaxTotalMiB: { min: 1, max: 2048 },
  uploadStorageMiB: { min: 1, max: 32768 },
} as const;

export type BrowserUploadSettings = {
  -readonly [Key in keyof typeof DEFAULT_BROWSER_UPLOAD_SETTINGS]: number;
};
const uploadSettingKeys = Object.keys(DEFAULT_BROWSER_UPLOAD_SETTINGS) as Array<
  keyof BrowserUploadSettings
>;

/** Only omitted values inherit defaults; explicit invalid values are not coerced. */
export function browserUploadSettings(
  settings: Partial<BrowserSettings> | undefined,
): BrowserUploadSettings {
  const result = {} as BrowserUploadSettings;
  for (const key of uploadSettingKeys) {
    const value = settings?.[key];
    result[key] = value === undefined ? DEFAULT_BROWSER_UPLOAD_SETTINGS[key] : value;
  }
  return result;
}

/** Validate upload fields in a Chrome settings object, including legacy omissions. */
export function browserUploadSettingsError(settings: unknown): string | undefined {
  if (
    settings !== undefined &&
    (!settings || typeof settings !== 'object' || Array.isArray(settings))
  )
    return 'Chrome upload settings must be an object.';
  const values = browserUploadSettings(settings as Partial<BrowserSettings> | undefined);
  for (const key of uploadSettingKeys) {
    const { min, max } = BROWSER_UPLOAD_SETTING_LIMITS[key];
    if (!Number.isInteger(values[key]) || values[key] < min || values[key] > max)
      return `Chrome ${key} must be a whole number from ${min} to ${max}.`;
  }
  if (values.uploadMaxFileMiB > values.uploadMaxTotalMiB)
    return 'Maximum upload file size must not exceed the total size per upload.';
  if (values.uploadMaxTotalMiB > values.uploadStorageMiB)
    return 'Total size per upload must not exceed the temporary upload storage budget.';
}

export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  enabled: false,
  mode: 'existing',
  permission: 'auto',
  includeScreenshotsInModel: false,
  maxConcurrentBrowsers: 3,
  ...DEFAULT_BROWSER_UPLOAD_SETTINGS,
};

export const BOT_BROWSER_MODES = ['dedicated', 'shared', 'disabled'] as const;
export const botBrowserMode = (bot: Pick<Bot, 'browser'>): BotBrowserSettings['mode'] =>
  bot.browser?.mode ?? 'shared';

export const BROWSER_OPERATIONS = [
  'tabs',
  'open',
  'navigate',
  'snapshot',
  'click',
  'fill',
  'upload_file',
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
