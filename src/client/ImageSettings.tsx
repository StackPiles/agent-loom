import { ChevronDown, ImagePlus, X } from 'lucide-react';
import type { Settings } from '../shared/types';
import { useApp } from './context';
import { Field, Toggle } from './components';

export type ImageSettingsValue = NonNullable<Settings['images']>;
export { DEFAULT_IMAGE_SETTINGS as defaultImageSettings } from '../shared/model-settings';

export function ImageSettings({
  value,
  onChange,
  apiKey,
  keyDirty,
  onKeyChange,
  disabled = false,
}: {
  value: ImageSettingsValue;
  onChange: (values: Partial<ImageSettingsValue>) => void;
  apiKey: string;
  keyDirty: boolean;
  onKeyChange: (value: string) => void;
  disabled?: boolean;
}) {
  const { t } = useApp();
  return (
    <section className="settings-section" id="image-settings">
      <div className="settings-section-heading">
        <span>
          <ImagePlus size={20} />
        </span>
        <div>
          <h2>{t('画像生成モデル', 'Image generation model')}</h2>
          <p>
            {t(
              'ボットが必要に応じて画像生成モデルを呼び出します。',
              'Let bots call a separate model to generate images.',
            )}
          </p>
        </div>
      </div>
      <div className="settings-section-body">
        <Toggle
          checked={value.enabled}
          onChange={(enabled) => onChange({ enabled })}
          label={t('画像生成を有効にする', 'Enable image generation')}
          description={t(
            '生成した画像はチャットで確認・ダウンロードできます。',
            'View and download generated images in the chat.',
          )}
          disabled={disabled}
        />
        {value.enabled && (
          <fieldset className="image-model-fields" disabled={disabled}>
            <p className="field-hint image-protocol-hint">
              {t(
                'OpenAI互換の画像生成API（/images/generations）に接続します。ローカルサーバーも指定できます。',
                'Connect to an OpenAI-compatible image generation API (/images/generations), including a local server.',
              )}
            </p>
            <Field
              label={t('画像APIのベースURL', 'Image API base URL')}
              hint={t(
                'Loomサーバーから接続できるURLを指定します。言語モデルの接続先とは別に保存します。',
                'Use a URL reachable from the Loom server. This is saved separately from the language model endpoint.',
              )}
            >
              <input
                type="url"
                aria-label={t('画像APIのベースURL', 'Image API base URL')}
                required
                value={value.baseUrl}
                onChange={(event) => onChange({ baseUrl: event.target.value })}
                placeholder="http://localhost:8000/v1"
                spellCheck={false}
              />
            </Field>
            <div className="form-grid">
              <Field label={t('画像モデルID', 'Image model ID')}>
                <input
                  aria-label={t('画像モデルID', 'Image model ID')}
                  required
                  value={value.modelId}
                  onChange={(event) => onChange({ modelId: event.target.value })}
                  placeholder={t('サーバー上のモデルID', 'Model ID on your server')}
                  spellCheck={false}
                />
              </Field>
              <Field
                label={t('画像APIキー（必要な場合）', 'Image API key (if required)')}
                hint={
                  value.apiKeyConfigured
                    ? t(
                        '保存済みのキーは同じオリジンでのみ使用します。接続先を変える場合は入力し直してください。',
                        'The saved key is used only for the same origin. Enter a new key when changing the endpoint origin.',
                      )
                    : t(
                        '認証が不要なら空欄のままで構いません。言語モデル用のキーは使いません。',
                        'Leave blank when authentication is not required. The language model key is never used.',
                      )
                }
              >
                <div className="secret-field">
                  <input
                    aria-label={t('画像APIキー', 'Image API key')}
                    type="password"
                    autoComplete="new-password"
                    value={apiKey}
                    onChange={(event) => onKeyChange(event.target.value)}
                    placeholder={value.apiKeyConfigured && !keyDirty ? '••••••••••••' : ''}
                  />
                  {value.apiKeyConfigured && (
                    <button
                      type="button"
                      onClick={() => onKeyChange('')}
                      aria-label={t('画像APIキーを削除', 'Clear image API key')}
                      title={t('保存時にキーを削除', 'Clear key when saved')}
                    >
                      <X size={15} />
                    </button>
                  )}
                </div>
                {keyDirty && !apiKey && value.apiKeyConfigured && (
                  <small className="form-error">
                    {t('保存するとキーを削除します。', 'The saved key will be cleared on save.')}
                  </small>
                )}
              </Field>
            </div>
            <div className="form-grid">
              <Field
                label={t('既定の画像サイズ', 'Default image size')}
                hint={t(
                  '生成サーバーが対応するサイズを指定します。',
                  'Choose a size supported by your generation server.',
                )}
              >
                <input
                  aria-label={t('既定の画像サイズ', 'Default image size')}
                  required
                  value={value.size}
                  onChange={(event) => onChange({ size: event.target.value })}
                  list="image-sizes"
                  placeholder="1024x1024"
                  spellCheck={false}
                />
                <datalist id="image-sizes">
                  {['auto', '512x512', '1024x1024', '1024x1536', '1536x1024'].map((size) => (
                    <option key={size} value={size} />
                  ))}
                </datalist>
              </Field>
              <Field label={t('生成のタイムアウト（秒）', 'Generation timeout (seconds)')}>
                <input
                  aria-label={t('生成のタイムアウト（秒）', 'Generation timeout (seconds)')}
                  type="number"
                  required
                  min={10}
                  max={1800}
                  step={1}
                  value={value.timeoutSeconds}
                  onChange={(event) => onChange({ timeoutSeconds: Number(event.target.value) })}
                />
              </Field>
            </div>
            <Toggle
              checked={value.shareInferenceSlot}
              onChange={(shareInferenceSlot) => onChange({ shareInferenceSlot })}
              disabled={disabled}
              label={t(
                '言語モデルと生成枠を共有',
                'Share generation slots with the language model',
              )}
              description={
                value.shareInferenceSlot
                  ? t(
                      '同じGPUを使う場合に適しています。画像生成も「同時生成の上限」に数えます。',
                      'Suitable for a shared GPU. Image generation counts toward the maximum concurrent generations.',
                    )
                  : t(
                      '別のGPU・サーバーで画像を生成する場合に使います。画像生成は独立して1件ずつ実行します。',
                      'Use for an image model on a separate GPU or server. Images run independently, one at a time.',
                    )
              }
            />
            <details className="advanced-settings image-advanced-settings">
              <summary>
                <span>{t('画像APIの詳細設定', 'Image API options')}</span>
                <ChevronDown size={14} />
              </summary>
              <Field
                label={t('画像の応答形式', 'Image response format')}
                hint={t(
                  '通常はサーバー既定を使用します。Base64指定を必要とする互換サーバーでは切り替えてください。',
                  'Use the server default unless your compatible server requires an explicit Base64 response request.',
                )}
              >
                <select
                  aria-label={t('画像の応答形式', 'Image response format')}
                  value={value.responseFormat}
                  onChange={(event) =>
                    onChange({ responseFormat: event.target.value as 'auto' | 'b64_json' })
                  }
                >
                  <option value="auto">{t('サーバー既定', 'Server default')}</option>
                  <option value="b64_json">Base64 (b64_json)</option>
                </select>
              </Field>
            </details>
          </fieldset>
        )}
        {disabled && (
          <p className="field-hint">
            {t(
              '画像モデルの設定を変更するには、実行中の作業を停止してください。',
              'Stop active tasks before changing the image model configuration.',
            )}
          </p>
        )}
      </div>
    </section>
  );
}
