import { useEffect, useState } from 'react';
import { Check, ImagePlus, LoaderCircle, RefreshCw, Square } from 'lucide-react';
import { getAvatarImageSource } from '../shared/avatars';
import { Avatar, Button, Field } from './components';
import { useApp } from './context';
import { useAvatarGenerations } from './useAvatarGenerations';

export function AvatarGenerator({
  name,
  color,
  value,
  onChange,
  disabled,
}: {
  name: string;
  color: string;
  value: string;
  onChange: (value: string) => void;
  disabled: boolean;
}) {
  const { data, t } = useApp();
  const settings = data.settings.images;
  const available = Boolean(settings?.enabled && settings.baseUrl && settings.modelId);
  const denied = data.settings.permissions.network === 'deny';
  const [prompt, setPrompt] = useState(() =>
    t(
      '正方形のキャラクターアバター。親しみやすいオリジナルの小さなロボット。顔を大きく中央に、やわらかな色合い、シンプルな背景。文字やロゴは入れない。',
      'A square character avatar of a friendly original little robot. A large face centered in the frame, soft colors, a simple background, no text or logos.',
    ),
  );
  const [previewId, setPreviewId] = useState<string>();
  const [previewFailed, setPreviewFailed] = useState<string>();
  const {
    jobs,
    active,
    loading,
    submitting,
    cancelling,
    error,
    uncertain,
    reload,
    generate,
    cancel,
  } = useAvatarGenerations();
  const recent = jobs.filter((job) => job.status === 'completed' && job.image);
  const preview = jobs.find((job) => job.id === previewId) ?? active ?? jobs[0];
  const imageValue = preview?.image ? `image:${preview.image.id}` : '';
  const imageSource = getAvatarImageSource(imageValue);
  useEffect(() => setPreviewFailed(undefined), [imageSource]);

  return (
    <section
      className="avatar-generator"
      aria-label={t('アバター画像の生成', 'Avatar image generation')}
    >
      <header>
        <strong>{t('アバター画像', 'Avatar image')}</strong>
        <button
          type="button"
          className="text-button"
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw size={13} className={loading ? 'spin' : ''} />
          {t('更新', 'Refresh')}
        </button>
      </header>
      {available ? (
        <>
          <div className="avatar-model-summary">
            <strong>{settings!.modelId}</strong>
            <span>
              {settings!.size === 'auto' ? t('サイズ自動', 'Automatic size') : settings!.size}
            </span>
            <small>{settings!.baseUrl}</small>
          </div>
          <Field label={t('外見の説明', 'Appearance description')}>
            <textarea
              rows={3}
              maxLength={4000}
              aria-label={t('外見の説明', 'Appearance description')}
              value={prompt}
              disabled={Boolean(active) || submitting || uncertain || disabled}
              onChange={(event) => setPrompt(event.target.value)}
            />
          </Field>
          {denied && (
            <p className="field-hint">
              {t(
                '「設定」のネットワーク権限が拒否になっています。変更すると画像を生成できます。',
                'Network access is denied in Settings. Change that permission to generate an image.',
              )}
            </p>
          )}
          <div className="avatar-generation-actions">
            <Button
              type="button"
              icon={ImagePlus}
              busy={submitting}
              disabled={disabled || loading || Boolean(active) || denied || !prompt.trim()}
              onClick={async () => {
                const job = await generate(prompt);
                if (job) setPreviewId(job.id);
              }}
            >
              {uncertain
                ? t('同じリクエストを確認', 'Check the same request')
                : t('生成する', 'Generate')}
            </Button>
            {active && (
              <Button type="button" icon={Square} busy={cancelling} onClick={() => void cancel()}>
                {t('生成を停止', 'Stop generation')}
              </Button>
            )}
          </div>
          <p className="field-hint avatar-generation-hint">
            {t(
              '説明を上の画像モデルへ送信します。閉じても生成は続き、結果はここに保存されます。',
              'The description is sent to the image model above. Generation continues if you close this panel; the result stays here.',
            )}
          </p>
        </>
      ) : (
        <p className="avatar-setup-note">
          {t(
            '「設定」→「画像生成」で画像モデルを有効にしてください。キャラクターの選択と、保存済み画像の利用はそのままできます。',
            'Enable an image model in Settings → Image generation. You can still choose characters and use saved images.',
          )}
        </p>
      )}
      {error && (
        <div className="form-error" role="alert">
          {error}
        </div>
      )}
      {active && (
        <div className="avatar-generation-status" role="status">
          <LoaderCircle size={17} className="spin" />
          <div>
            <strong>
              {active.status === 'queued'
                ? t('順番待ち', 'Queued')
                : t('画像を生成中', 'Generating image')}
            </strong>
            <span>
              {active.status === 'queued'
                ? t('利用できる推論枠を待っています。', 'Waiting for an available generation slot.')
                : t(
                    '画像モデルからの結果を待っています。',
                    'Waiting for the image model to return the result.',
                  )}
            </span>
          </div>
        </div>
      )}
      {!active && preview && ['failed', 'cancelled', 'interrupted'].includes(preview.status) && (
        <p className="avatar-job-message" role="status">
          {preview.status === 'cancelled'
            ? t('生成を停止しました。', 'Generation stopped.')
            : preview.status === 'interrupted'
              ? t(
                  '再起動により生成が中断されました。必要なら再生成してください。',
                  'Generation was interrupted by a restart. Generate again when you are ready.',
                )
              : t('画像を生成できませんでした。', 'The image could not be generated.')}
          {preview.error && <span>{preview.error}</span>}
        </p>
      )}
      {preview?.status === 'completed' && imageSource && (
        <div className="avatar-generation-result">
          <div className="avatar-result-picture">
            {previewFailed === imageSource ? (
              <span>{t('画像を読み込めません', 'Image unavailable')}</span>
            ) : (
              <img
                src={imageSource}
                alt={t('生成したアバターのプレビュー', 'Generated avatar preview')}
                decoding="async"
                onError={() => setPreviewFailed(imageSource)}
              />
            )}
          </div>
          <div>
            <strong>{t('生成結果', 'Generated image')}</strong>
            <p>{preview.prompt}</p>
            <Button
              type="button"
              icon={value === imageValue ? Check : undefined}
              disabled={disabled || previewFailed === imageSource || value === imageValue}
              onClick={() => onChange(imageValue)}
            >
              {value === imageValue
                ? t('選択中', 'Selected')
                : t('この画像を使う', 'Use this image')}
            </Button>
            <small>
              {t(
                'プロフィールを保存すると反映されます。',
                'Save the profile to apply your selection.',
              )}
            </small>
          </div>
        </div>
      )}
      {recent.length > 0 && (
        <div className="avatar-generated-history">
          <span>{t('保存済みの画像', 'Saved images')}</span>
          <div>
            {recent.map((job, index) => (
              <button
                type="button"
                key={job.id}
                disabled={disabled}
                aria-pressed={preview?.id === job.id}
                aria-label={t(
                  `保存済みの画像 ${index + 1} をプレビュー`,
                  `Preview saved image ${index + 1}`,
                )}
                title={job.prompt}
                onClick={() => setPreviewId(job.id)}
              >
                <Avatar bot={{ name, color, avatar: `image:${job.image!.id}` }} />
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
