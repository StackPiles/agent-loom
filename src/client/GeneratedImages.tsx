import { useEffect, useRef, useState } from 'react';
import { Bookmark, BookmarkCheck, Download, Expand, ImageOff } from 'lucide-react';
import type { GeneratedImage } from '../shared/types';
import type { ImageUseReason } from '../shared/image-storage';
import { dateLabel, useApp } from './context';
import { Modal } from './components';
import { api } from './api';

function fileSize(bytes: number) {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

export function GeneratedImages({ images }: { images: GeneratedImage[] }) {
  const { t } = useApp();
  const valid = images.filter(
    (image) =>
      /^img_[a-f0-9]{64}$/.test(image.id) &&
      ['image/png', 'image/jpeg', 'image/webp'].includes(image.mimeType),
  );
  if (!valid.length) return null;
  return (
    <div className="generated-images" aria-label={t('画像', 'Images')}>
      {valid.map((image) => (
        <GeneratedImageCard key={image.id} image={image} />
      ))}
    </div>
  );
}

function GeneratedImageCard({ image }: { image: GeneratedImage }) {
  const { t, locale, connected, refresh, toast } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const [opening, setOpening] = useState(false);
  const [protecting, setProtecting] = useState(false);
  const [protectedImage, setProtectedImage] = useState(
    image.storage?.protected ?? image.source === 'uploaded',
  );
  const protectionPending = useRef(false);
  const openPending = useRef(false);
  const alive = useRef(true);
  const source = `/api/images/${image.id}`;
  const uploaded = image.source === 'uploaded';
  const deletedAt = image.storage?.deletedAt;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    setProtectedImage(image.storage?.protected ?? image.source === 'uploaded');
  }, [image.storage?.protected, image.source]);
  useEffect(() => {
    if (deletedAt) setExpanded(false);
  }, [deletedAt]);
  const recordUse = (id: string, reason: ImageUseReason) =>
    api(`/images/${id}/use`, 'POST', { reason });
  const recordLinkUse = (id: string, reason: ImageUseReason) => {
    void recordUse(id, reason).catch((error: Error) => {
      if (alive.current) toast(error.message, 'error');
    });
  };
  const open = async () => {
    if (openPending.current || deletedAt) return;
    openPending.current = true;
    setOpening(true);
    try {
      await recordUse(image.id, 'open');
      if (alive.current) setExpanded(true);
    } catch (error) {
      if (alive.current) toast((error as Error).message, 'error');
      void refresh().catch(() => {});
    } finally {
      openPending.current = false;
      if (alive.current) setOpening(false);
    }
  };
  const changeProtection = async () => {
    if (protectionPending.current || deletedAt) return;
    protectionPending.current = true;
    setProtecting(true);
    const next = !protectedImage;
    try {
      await api(`/images/${image.id}/protection`, 'PUT', { protected: next });
      if (alive.current) setProtectedImage(next);
      void refresh().catch(() => {});
    } catch (error) {
      if (alive.current) toast((error as Error).message, 'error');
    } finally {
      protectionPending.current = false;
      if (alive.current) setProtecting(false);
    }
  };
  const label = uploaded
    ? t('添付した画像', 'Uploaded image')
    : image.operation === 'edit'
      ? t('編集した画像', 'Edited image')
      : t('生成した画像', 'Generated image');
  const sourceImageId = image.inputImages?.find((input) => input.role === 'source')?.imageId;
  const alt = uploaded ? image.filename : image.prompt.slice(0, 300) || label;
  const download = (
    <a
      className="generated-image-download"
      href={`${source}?download=1`}
      download={image.filename}
      onClick={() => recordLinkUse(image.id, 'download')}
    >
      <Download size={14} aria-hidden="true" />
      {t('ダウンロード', 'Download')}
    </a>
  );
  return (
    <figure className="generated-image" data-image-id={image.id}>
      {deletedAt ? (
        <div className="generated-image-unavailable generated-image-cleaned" role="status">
          <ImageOff size={25} aria-hidden="true" />
          <strong>{t('原本は整理済み', 'Original cleaned up')}</strong>
          <span>{dateLabel(deletedAt, locale, true)}</span>
        </div>
      ) : failed ? (
        <div className="generated-image-unavailable" role="status">
          <ImageOff size={25} />
          <span>{t('画像を読み込めませんでした。', 'The image could not be loaded.')}</span>
        </div>
      ) : (
        <button
          type="button"
          className="generated-image-preview"
          onClick={open}
          disabled={opening || connected === false}
          aria-busy={opening}
          aria-label={t('画像を拡大', 'Enlarge image')}
        >
          <img
            src={source}
            alt={alt}
            loading="lazy"
            decoding="async"
            referrerPolicy="no-referrer"
            onError={() => setFailed(true)}
          />
          <span className="generated-image-expand">
            <Expand size={15} aria-hidden="true" />
          </span>
        </button>
      )}
      <figcaption>
        <div className="generated-image-meta">
          <strong title={uploaded ? image.filename : image.model}>
            {uploaded ? image.filename : image.model}
          </strong>
          <span>
            {deletedAt
              ? t(
                  `元のサイズ ${fileSize(image.byteLength)}`,
                  `Original size ${fileSize(image.byteLength)}`,
                )
              : fileSize(image.byteLength)}
          </span>
          {!deletedAt && download}
          {!deletedAt && (
            <button
              type="button"
              className={`generated-image-keep ${protectedImage ? 'is-kept' : ''}`}
              aria-label={
                protectedImage
                  ? t('画像の保護を解除', 'Unprotect image')
                  : t('この画像を残す', 'Keep this image')
              }
              aria-pressed={protectedImage}
              disabled={protecting || connected === false}
              onClick={changeProtection}
              title={
                protectedImage
                  ? t('整理の対象から外しています', 'Protected from cleanup')
                  : t('整理の対象から外す', 'Protect from cleanup')
              }
            >
              {protectedImage ? (
                <BookmarkCheck size={14} aria-hidden="true" />
              ) : (
                <Bookmark size={14} aria-hidden="true" />
              )}
              {t('残す', 'Keep')}
            </button>
          )}
        </div>
        {(uploaded || image.operation === 'edit') && (
          <div className="image-source-meta">
            <span>{label}</span>
            {sourceImageId && /^img_[a-f0-9]{64}$/.test(sourceImageId) && (
              <a
                href={`/api/images/${sourceImageId}`}
                target="_blank"
                rel="noreferrer"
                onClick={() => recordLinkUse(sourceImageId, 'open')}
              >
                {t('元画像を表示', 'View original')}
              </a>
            )}
          </div>
        )}
        {image.prompt && (
          <details className="generated-image-prompt">
            <summary>
              {image.operation === 'edit'
                ? t('編集の指示', 'Edit instruction')
                : t('生成の指示', 'Image prompt')}
            </summary>
            <p>{image.prompt}</p>
          </details>
        )}
      </figcaption>
      {expanded && !deletedAt && (
        <Modal
          title={label}
          description={uploaded ? image.filename : image.model}
          wide
          onClose={() => setExpanded(false)}
        >
          <div className="image-lightbox">
            <img src={source} alt={alt} referrerPolicy="no-referrer" />
            {download}
          </div>
        </Modal>
      )}
    </figure>
  );
}
