import { ChevronDown, ImagePlus, X } from 'lucide-react';
import {
  DEFAULT_IMAGE_SETTINGS,
  IMAGE_2K_PARALLEL_PRESET,
  IMAGE_STEP_LIMITS,
  IMAGE_STEP_PARAMETERS,
  IMAGE_TIMEOUT_LIMITS,
} from '../shared/model-settings';
import type { Settings } from '../shared/types';
import { useApp } from './context';
import { Field, Toggle } from './components';
import { ImageModelTest } from './ImageModelTest';

export type ImageSettingsValue = NonNullable<Settings['images']>;
export { DEFAULT_IMAGE_SETTINGS as defaultImageSettings } from '../shared/model-settings';

export function ImageSettings({
  value,
  onChange,
  apiKey,
  keyDirty,
  onKeyChange,
  disabled = false,
  disabledReason,
  permissionDisabled = disabled,
}: {
  value: ImageSettingsValue;
  onChange: (values: Partial<ImageSettingsValue>) => void;
  apiKey: string;
  keyDirty: boolean;
  onKeyChange: (value: string) => void;
  disabled?: boolean;
  disabledReason?: string;
  permissionDisabled?: boolean;
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
          <Field
            label={t('ボットの画像生成', 'Bot image generation')}
            hint={
              value.permission === 'inherit' || !value.permission
                ? t(
                    'ネットワークの「自動」「確認」は、画像生成では毎回確認します。「禁止」の場合は生成できません。',
                    'Network Auto and Ask require approval for each image. Network Deny always blocks generation.',
                  )
                : t(
                    'ボットの画像生成だけに適用します。ネットワークが「禁止」の場合は生成できません。',
                    'Applies only to bot image generation. Network Deny always blocks generation.',
                  )
            }
          >
            <select
              aria-label={t('ボットの画像生成', 'Bot image generation')}
              value={value.permission ?? 'inherit'}
              disabled={permissionDisabled}
              onChange={(event) =>
                onChange({ permission: event.target.value as ImageSettingsValue['permission'] })
              }
            >
              <option value="inherit">
                {t('ネットワーク設定に従う', 'Follow network permission')}
              </option>
              <option value="allow">{t('許可（確認なし）', 'Allow without approval')}</option>
              <option value="ask">{t('毎回確認', 'Ask every time')}</option>
              <option value="deny">{t('禁止', 'Deny')}</option>
            </select>
          </Field>
        )}
        {value.enabled && (
          <fieldset className="image-model-fields" disabled={disabled}>
            <p className="field-hint image-protocol-hint">
              {t(
                'OpenAI互換の画像生成API（/images/generations）に接続します。ローカルサーバーも指定できます。',
                'Connect to an OpenAI-compatible image generation API (/images/generations), including a local server.',
              )}
            </p>
            <p className="field-hint">
              {t(
                '接続先・モデル・サイズ・ステップ数・制限時間などの変更は、新しい画像生成依頼から反映します。すでに承認待ち・順番待ちの依頼は、作成時の接続先・認証情報と生成条件を使います。',
                'Changes to the connection, model, size, sampling steps or timeout apply to new image requests. Requests already waiting for approval or a slot keep their original connection, credentials and generation options.',
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
            <div>
              <button
                type="button"
                className="button button-secondary"
                disabled={disabled}
                onClick={() => onChange({ ...IMAGE_2K_PARALLEL_PRESET })}
              >
                {t('2K・60分・LLMと並列を適用', 'Apply 2K, 60 min and parallel LLM')}
              </button>
              <p className="field-hint">
                {t(
                  '画像サイズ・制限時間・LLMとの並列設定を変更します。反映するには設定を保存してください。',
                  'Changes the image size, timeout and LLM concurrency inputs. Save the settings to apply them.',
                )}
              </p>
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
                  placeholder="2048x2048"
                  spellCheck={false}
                />
                <datalist id="image-sizes">
                  {['auto', '512x512', '1024x1024', '1024x1536', '1536x1024', '2048x2048'].map(
                    (size) => (
                      <option key={size} value={size} />
                    ),
                  )}
                </datalist>
              </Field>
              <Field
                label={t('生成のタイムアウト（秒）', 'Generation timeout (seconds)')}
                hint={t(
                  '3,600秒で送信開始から画像取得まで最大60分待てます。Loom内の順番待ちは含めません。',
                  '3,600 seconds allows up to 60 minutes from sending the request until the image is received. Time waiting in Loom’s queues is excluded.',
                )}
              >
                <input
                  aria-label={t('生成のタイムアウト（秒）', 'Generation timeout (seconds)')}
                  type="number"
                  required
                  min={IMAGE_TIMEOUT_LIMITS.min}
                  max={IMAGE_TIMEOUT_LIMITS.max}
                  step={1}
                  value={value.timeoutSeconds}
                  onChange={(event) => onChange({ timeoutSeconds: Number(event.target.value) })}
                />
              </Field>
            </div>
            <div className="form-grid">
              <Field
                label={t('生成ステップ数', 'Sampling steps')}
                hint={t(
                  'ボットが省略した場合とアバター生成用の既定値です（1〜1,000の整数）。ボットは生成ごとに指定できます。空欄でボットも省略した場合は画像サーバーの既定値を使います。',
                  'Default for bot calls that omit steps and for avatars (a whole number from 1 to 1,000). Bots can specify a count per call. Leave blank to use the image server default when no per-call count is given.',
                )}
              >
                <input
                  aria-label={t('生成ステップ数', 'Sampling steps')}
                  type="number"
                  min={IMAGE_STEP_LIMITS.min}
                  max={IMAGE_STEP_LIMITS.max}
                  step={1}
                  value={value.steps ?? ''}
                  placeholder={t('サーバー既定', 'Server default')}
                  onChange={(event) =>
                    onChange({
                      steps: event.target.value === '' ? null : Number(event.target.value),
                    })
                  }
                />
              </Field>
              <Field
                label={t('ステップ数の送信形式', 'Sampling-step format')}
                hint={t(
                  'stable-diffusion.cpp、または接続先が対応するパラメーター名を選びます。既定のステップ数が空欄でも、ボットが指定した数にこの形式を使います。',
                  'Choose stable-diffusion.cpp or the parameter your image server accepts. This format also applies to bot-specified counts when the default sampling steps are blank.',
                )}
              >
                <select
                  aria-label={t('ステップ数の送信形式', 'Sampling-step format')}
                  value={value.stepsParameter ?? DEFAULT_IMAGE_SETTINGS.stepsParameter}
                  onChange={(event) =>
                    onChange({
                      stepsParameter: event.target.value as ImageSettingsValue['stepsParameter'],
                    })
                  }
                >
                  {IMAGE_STEP_PARAMETERS.map((parameter) => (
                    <option key={parameter} value={parameter}>
                      {parameter === 'sd_cpp_extra_args' ? 'stable-diffusion.cpp' : parameter}
                    </option>
                  ))}
                </select>
              </Field>
            </div>
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
        {value.enabled && (
          <div>
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
                      '画像生成も言語モデルの「同時生成の上限」に数えます。上限が1の場合は交互に実行します。',
                      'Image generation counts toward the language model’s maximum concurrent generations. With a limit of 1, they run one after another.',
                    )
                  : t(
                      '画像は独立した生成枠で1件ずつ実行します。同じマシンでも、両モデルを同時に推論できる構成で使えます。',
                      'Images use an independent slot and run one at a time. Use this when both models support concurrent inference, including on the same machine.',
                    )
              }
            />
          </div>
        )}
        {value.enabled && (
          <ImageModelTest
            settings={{
              baseUrl: value.baseUrl,
              modelId: value.modelId,
              size: value.size,
              steps: value.steps ?? null,
              stepsParameter: value.stepsParameter ?? DEFAULT_IMAGE_SETTINGS.stepsParameter,
              responseFormat: value.responseFormat,
              timeoutSeconds: value.timeoutSeconds,
              shareInferenceSlot: value.shareInferenceSlot,
            }}
            apiKey={apiKey}
            keyDirty={keyDirty}
            disabled={disabled}
          />
        )}
        {disabled && disabledReason && <p className="field-hint">{disabledReason}</p>}
      </div>
    </section>
  );
}
