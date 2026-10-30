import { useState } from 'react';
import { Download, Expand, ImageOff } from 'lucide-react';
import type { GeneratedImage } from '../shared/types';
import { useApp } from './context';
import { Modal } from './components';

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
    <div className="generated-images" aria-label={t('生成した画像', 'Generated images')}>
      {valid.map((image) => (
        <GeneratedImageCard key={image.id} image={image} />
      ))}
    </div>
  );
}

function GeneratedImageCard({ image }: { image: GeneratedImage }) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [failed, setFailed] = useState(false);
  const source = `/api/images/${image.id}`;
  const download = (
    <a className="generated-image-download" href={`${source}?download=1`} download={image.filename}>
      <Download size={14} aria-hidden="true" />
      {t('ダウンロード', 'Download')}
    </a>
  );
  return (
    <figure className="generated-image" data-image-id={image.id}>
      {failed ? (
        <div className="generated-image-unavailable" role="status">
          <ImageOff size={25} />
          <span>{t('画像を読み込めませんでした。', 'The image could not be loaded.')}</span>
        </div>
      ) : (
        <button
          type="button"
          className="generated-image-preview"
          onClick={() => setExpanded(true)}
          aria-label={t('画像を拡大', 'Enlarge image')}
        >
          <img
            src={source}
            alt={image.prompt.slice(0, 300) || t('生成した画像', 'Generated image')}
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
          <strong title={image.model}>{image.model}</strong>
          <span>{fileSize(image.byteLength)}</span>
          {download}
        </div>
        <details className="generated-image-prompt">
          <summary>{t('生成の指示', 'Image prompt')}</summary>
          <p>{image.prompt}</p>
        </details>
      </figcaption>
      {expanded && (
        <Modal
          title={t('生成した画像', 'Generated image')}
          description={image.model}
          wide
          onClose={() => setExpanded(false)}
        >
          <div className="image-lightbox">
            <img
              src={source}
              alt={image.prompt.slice(0, 300) || t('生成した画像', 'Generated image')}
              referrerPolicy="no-referrer"
            />
            {download}
          </div>
        </Modal>
      )}
    </figure>
  );
}
