import { useEffect, useState } from 'react';
import { Download, ImagePlus, LoaderCircle, X } from 'lucide-react';
import { isActiveImageTest, type ImageTestSettings } from '../shared/image-tests';
import { useApp } from './context';
import { useImageTest } from './useImageTest';

export function ImageModelTest({
  settings,
  apiKey,
  keyDirty,
  disabled = false,
}: {
  settings: ImageTestSettings;
  apiKey: string;
  keyDirty: boolean;
  disabled?: boolean;
}) {
  const { data, t } = useApp();
  const networkDenied = data.settings.permissions.network === 'deny';
  const test = useImageTest(settings, apiKey, keyDirty, networkDenied);
  const job = test.job;
  const [unavailablePreview, setUnavailablePreview] = useState('');
  const [expiredPreview, setExpiredPreview] = useState('');
  useEffect(() => {
    if (!job?.previewExpiresAt) return;
    const expiresIn = Date.parse(job.previewExpiresAt) - Date.now();
    const timer = setTimeout(() => setExpiredPreview(job.id), Math.max(0, expiresIn));
    return () => clearTimeout(timer);
  }, [job?.id, job?.previewExpiresAt]);
  const active = Boolean(job && isActiveImageTest(job));
  const busy = test.submitting || test.checking || test.cancelling || active;
  const canGenerate =
    Boolean(settings.baseUrl.trim() && settings.modelId.trim() && settings.size.trim()) &&
    settings.timeoutSeconds >= 10 &&
    settings.timeoutSeconds <= 1800;
  const preview =
    job?.previewAvailable &&
    job.image &&
    unavailablePreview !== job.id &&
    expiredPreview !== job.id;
  const status = test.cancelling
    ? t('キャンセルしています…', 'Cancelling…')
    : test.submitting
      ? t('テストを開始しています…', 'Starting the test…')
      : test.checking
        ? t('結果を確認しています…', 'Checking the result…')
        : test.uncertain
          ? t(
              '実行結果を確認できません。自動で再生成はしません。',
              'The result is unknown. This test will not be resent automatically.',
            )
          : job?.status === 'queued'
            ? t('生成枠が空くのを待っています…', 'Waiting for a generation slot…')
            : job?.status === 'generating'
              ? t('画像を1枚生成しています…', 'Generating one image…')
              : job?.status === 'completed'
                ? t('画像を1枚生成できました。', 'One image was generated successfully.')
                : job?.status === 'cancelled'
                  ? t('テストをキャンセルしました。', 'The test was cancelled.')
                  : job?.status === 'interrupted'
                    ? t(
                        'サーバーの再起動でテストが中断されました。',
                        'The test was interrupted by a server restart.',
                      )
                    : job?.errorCode === 'timeout'
                      ? t(
                          '待機時間を含む制限時間に達しました。自動で再生成はしません。',
                          'The test timed out, including time in the queue. It was not resent.',
                        )
                      : job?.status === 'failed'
                        ? t('画像を生成できませんでした。', 'The image could not be generated.')
                        : '';
  return (
    <div className="image-settings-test">
      <div className="image-test-heading">
        <h3>{t('画像生成をテスト', 'Test image generation')}</h3>
        <p>
          {t(
            '入力中の設定で、白い背景に青い丸の画像を1枚生成します。設定は保存しません。',
            'Generate one image of a blue circle on a white background using the current inputs. This does not save the settings.',
          )}
        </p>
        <p>
          {t(
            '実際に画像を1枚生成するため、有料サービスでは料金が発生する場合があります。',
            'This generates one real image, so a paid provider may charge for it.',
          )}
        </p>
      </div>
      <p className="image-test-model">
        <span>
          {t('使用モデル', 'Model')}: <strong>{settings.modelId.trim() || '—'}</strong>
        </span>
        <span>
          {t('サイズ', 'Size')}: {settings.size.trim() || '—'}
        </span>
      </p>
      <div className="image-test-actions">
        <button
          type="button"
          className="button button-secondary"
          disabled={disabled || networkDenied || !canGenerate || busy || test.uncertain}
          onClick={() => void test.generate()}
        >
          <ImagePlus size={16} />
          {t('1枚をテスト生成', 'Generate 1 test image')}
        </button>
        {test.uncertain && (
          <button
            type="button"
            className="button button-secondary"
            disabled={test.checking || test.cancelling}
            onClick={() => void test.check()}
          >
            {t('結果を確認', 'Check result')}
          </button>
        )}
        {(busy || test.uncertain) && (
          <button
            type="button"
            className="button button-secondary"
            disabled={test.cancelling}
            onClick={() => void test.cancel()}
          >
            <X size={15} />
            {t('テストをキャンセル', 'Cancel test')}
          </button>
        )}
      </div>
      {networkDenied && (
        <p className="field-hint">
          {t(
            'テストするには、通信の権限を許可してください。',
            'Allow network access to test image generation.',
          )}
        </p>
      )}
      {status && (
        <p className="image-test-status" role="status">
          {busy && !test.uncertain && <LoaderCircle size={16} className="spin" />}
          {status}
        </p>
      )}
      {(test.error || (job?.error && job.errorCode === 'generation_failed')) && (
        <p className="form-error" role="alert">
          {test.error || job?.error}
        </p>
      )}
      {preview && job && (
        <figure className="image-test-preview">
          <img
            src={`/api/image-tests/${job.id}/image`}
            alt={t('テストで生成した画像', 'Image generated by the test')}
            onError={() => setUnavailablePreview(job.id)}
          />
          <figcaption>
            <span>
              {t(
                'プレビューはこの画面で最大15分間利用できます。必要ならダウンロードしてください。',
                'The preview is available on this screen for up to 15 minutes. Download it if you want to keep it.',
              )}
            </span>
            <a
              className="button button-secondary"
              href={`/api/image-tests/${job.id}/image?download=1`}
              download={job.image!.filename}
            >
              <Download size={15} />
              {t('画像をダウンロード', 'Download image')}
            </a>
          </figcaption>
        </figure>
      )}
      {job?.status === 'completed' && !preview && (
        <p className="field-hint">
          {t(
            'この一時プレビューは利用できなくなりました。',
            'This temporary preview is no longer available.',
          )}
        </p>
      )}
    </div>
  );
}
