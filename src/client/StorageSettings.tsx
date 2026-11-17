import { useEffect, useRef, useState } from 'react';
import {
  Bookmark,
  BookmarkCheck,
  ChevronDown,
  ChevronUp,
  HardDrive,
  ImageOff,
  Layers,
  RefreshCw,
  Save,
  Trash2,
} from 'lucide-react';
import {
  DEFAULT_IMAGE_STORAGE_SETTINGS,
  IMAGE_STORAGE_UNUSED_DAYS,
  type ImageStorageBlockReason,
  type ImageStorageCleanupResult,
  type ImageStorageDeduplicateResult,
  type ImageStorageItem,
  type ImageStorageOverview,
  type ImageStorageQuery,
  type ImageStorageSettings as StoragePolicy,
} from '../shared/image-storage';
import { api } from './api';
import { Button, Field, Modal, Toggle } from './components';
import { dateLabel, useApp } from './context';

const PAGE_SIZE = 25;
const WARNING_TRANSLATIONS: Record<string, string> = {
  '一部の保存領域を安全に読み取れず、容量を集計できませんでした。':
    'Some storage locations could not be read safely and are excluded from the usage total.',
  '一部の画像の削減可能な容量を集計できませんでした。':
    'The amount of space recoverable from some images could not be calculated.',
  '読み取れない画像や整合性を確認できない画像は、整理対象から除外しています。':
    'Images that cannot be read or verified are excluded from cleanup.',
  '移行時のバックアップとブラウザー送信用の一時コピーは、画像原本の整理とは別に管理されます。':
    'Migration backups and temporary browser upload copies are managed separately from original image cleanup.',
};

function bytes(value: number) {
  if (value < 1024) return `${value.toLocaleString()} B`;
  const unit = Math.min(4, Math.floor(Math.log(value) / Math.log(1024)));
  return `${(value / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB', 'TB'][unit]}`;
}

function StorageThumbnail({ image }: { image: ImageStorageItem }) {
  const [failed, setFailed] = useState(false);
  return (
    <span className="storage-image-thumb" aria-hidden="true">
      {image.storage.deletedAt || failed ? (
        <ImageOff size={18} />
      ) : (
        <img
          src={`/api/images/${image.id}`}
          alt=""
          loading="lazy"
          decoding="async"
          referrerPolicy="no-referrer"
          onError={() => setFailed(true)}
        />
      )}
    </span>
  );
}

export function StorageSettings() {
  const { t, locale, connected, refresh, toast } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [overview, setOverview] = useState<ImageStorageOverview | null>(null);
  const [query, setQuery] = useState<Required<ImageStorageQuery>>({
    filter: 'candidates',
    sort: 'largest',
    offset: 0,
    limit: PAGE_SIZE,
  });
  const currentQuery = useRef(query);
  currentQuery.current = query;
  const [autoCleanup, setAutoCleanup] = useState(DEFAULT_IMAGE_STORAGE_SETTINGS.autoCleanup);
  const [unusedDays, setUnusedDays] = useState(String(DEFAULT_IMAGE_STORAGE_SETTINGS.unusedDays));
  const [policyDirty, setPolicyDirty] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [cleanupReview, setCleanupReview] = useState<ImageStorageItem[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [feedback, setFeedback] = useState('');
  const alive = useRef(true);
  const request = useRef<AbortController | null>(null);
  const mutationPending = useRef(false);
  const dirty = useRef(false);
  dirty.current = policyDirty;
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current?.abort();
    };
  }, []);

  const disabled = connected === false || !!action;
  const days = Number(unusedDays);
  const daysValid =
    /^\d+$/.test(unusedDays) &&
    Number.isInteger(days) &&
    days >= IMAGE_STORAGE_UNUSED_DAYS.min &&
    days <= IMAGE_STORAGE_UNUSED_DAYS.max;
  const selectedItems = (overview?.images ?? []).filter((image) => selected.includes(image.id));
  const selectable = (overview?.images ?? []).filter((image) => !image.storage.deletedAt);
  const allSelected =
    selectable.length > 0 && selectable.every((image) => selected.includes(image.id));
  const selectedCandidates = selectedItems.filter((image) => image.candidate);
  const categoryLabels = {
    originals: t('画像の原本', 'Original images'),
    history: t('会話履歴の画像', 'Conversation images'),
    backups: t('以前の移行バックアップ', 'Earlier migration backups'),
    uploads: t('アップロード用の一時ファイル', 'Temporary upload files'),
  };
  const reasonLabels: Record<ImageStorageBlockReason, string> = {
    protected: t('残す', 'Kept'),
    recent: t('最近使用', 'Recently used'),
    grace: t('保持期間内', 'Within retention period'),
    in_use: t('使用中', 'In use'),
    work: t('継続中の仕事で使用', 'Used by ongoing work'),
    shared: t('ほかの保存データで使用', 'Used by other saved data'),
    dependency: t('別の画像から参照', 'Referenced by another image'),
    missing: t('原本が見つかりません', 'Original unavailable'),
    deleted: t('整理済み', 'Cleaned up'),
    unverified: t('確認が必要', 'Needs inspection'),
  };

  async function load(nextQuery = currentQuery.current, resetPolicy = false) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setLoading(true);
    setError('');
    try {
      const params = new URLSearchParams({
        filter: nextQuery.filter,
        sort: nextQuery.sort,
        offset: String(nextQuery.offset),
        limit: String(nextQuery.limit),
      });
      const result = await api<ImageStorageOverview>(
        `/image-storage?${params}`,
        'GET',
        undefined,
        controller.signal,
      );
      if (!alive.current || controller.signal.aborted) return;
      setOverview(result);
      setSelected((current) =>
        current.filter((id) =>
          result.images.some((image) => image.id === id && !image.storage.deletedAt),
        ),
      );
      if (resetPolicy || !dirty.current) {
        setAutoCleanup(result.settings.autoCleanup);
        setUnusedDays(String(result.settings.unusedDays));
        setPolicyDirty(false);
      }
    } catch (caught) {
      if (alive.current && !controller.signal.aborted) setError((caught as Error).message);
    } finally {
      if (alive.current && !controller.signal.aborted) setLoading(false);
    }
  }

  function changeQuery(patch: Partial<ImageStorageQuery>) {
    const next = { ...currentQuery.current, offset: 0, ...patch };
    currentQuery.current = next;
    setQuery(next);
    setSelected([]);
    void load(next);
  }

  async function run(name: string, operation: () => Promise<void>) {
    if (mutationPending.current || connected === false) return;
    mutationPending.current = true;
    setAction(name);
    setError('');
    setFeedback('');
    try {
      await operation();
    } catch (caught) {
      if (alive.current) setError((caught as Error).message);
    } finally {
      mutationPending.current = false;
      if (alive.current) setAction(null);
    }
  }

  async function savePolicy() {
    if (!daysValid) return;
    const value: StoragePolicy = { autoCleanup, unusedDays: days };
    await run('save', async () => {
      await api<StoragePolicy>('/image-storage/settings', 'PATCH', value);
      if (!alive.current) return;
      dirty.current = false;
      setPolicyDirty(false);
      setFeedback(t('保存ルールを更新しました。', 'Storage rules saved.'));
      void refresh().catch(() => {});
      await load(query, true);
    });
  }

  async function protectSelection(protectedValue: boolean) {
    const targets = selectedItems.filter((image) => image.storage.protected !== protectedValue);
    if (!targets.length) return;
    await run('protection', async () => {
      const result = await api<{ updated: number }>('/image-storage/protection', 'POST', {
        imageIds: targets.map((image) => image.id),
        protected: protectedValue,
      });
      if (!alive.current) return;
      const count = result.updated;
      setFeedback(
        protectedValue
          ? t(`${count}枚を「残す」にしました。`, `${count} image(s) protected from cleanup.`)
          : t(`${count}枚の保護を解除しました。`, `Protection removed from ${count} image(s).`),
      );
      setSelected([]);
      void refresh().catch(() => {});
      await load();
    });
  }

  async function cleanup() {
    if (!cleanupReview?.length) return;
    const imageIds = cleanupReview.map((image) => image.id);
    await run('cleanup', async () => {
      const result = await api<ImageStorageCleanupResult>('/image-storage/cleanup', 'POST', {
        imageIds,
      });
      if (!alive.current) return;
      setCleanupReview(null);
      setSelected([]);
      setFeedback(
        t(
          `${result.deletedImages}枚を整理し、${bytes(result.freedBytes)}を解放しました。${result.skipped.length ? `使用・保護状況が変わった${result.skipped.length}枚は残しました。` : ''}`,
          `Cleaned up ${result.deletedImages} image(s), freeing ${bytes(result.freedBytes)}.${result.skipped.length ? ` Kept ${result.skipped.length} image(s) whose eligibility changed.` : ''}`,
        ),
      );
      void refresh().catch(() => {});
      const next = { ...query, offset: 0 };
      currentQuery.current = next;
      setQuery(next);
      await load(next);
    });
  }

  async function deduplicate() {
    await run('deduplicate', async () => {
      const result = await api<ImageStorageDeduplicateResult>(
        '/image-storage/deduplicate',
        'POST',
        {},
      );
      if (!alive.current) return;
      setFeedback(
        t(
          `${result.consolidatedImages}件の重複をまとめ、${bytes(result.freedBytes)}を解放しました。`,
          `Consolidated ${result.consolidatedImages} duplicate(s), freeing ${bytes(result.freedBytes)}.`,
        ),
      );
      await load();
    });
  }

  function markOpened(id: string) {
    void api(`/images/${id}/use`, 'POST', { reason: 'open' })
      .then(() => {
        if (alive.current) void load();
      })
      .catch((caught: Error) => toast(caught.message, 'error'));
  }

  return (
    <section className="settings-section storage-section">
      <div className="settings-section-heading">
        <span>
          <HardDrive size={20} />
        </span>
        <div>
          <h2>{t('ストレージ', 'Storage')}</h2>
          <p>
            {t(
              '残したい画像を保護し、使っていない画像を整理します。',
              'Keep important images and clean up images you no longer use.',
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          icon={expanded ? ChevronUp : ChevronDown}
          aria-expanded={expanded}
          aria-controls="image-storage-panel"
          disabled={!!action}
          onClick={() => {
            setExpanded(!expanded);
            if (!expanded) void load();
          }}
        >
          {expanded ? t('閉じる', 'Close') : t('管理を開く', 'Manage storage')}
        </Button>
      </div>
      {expanded && (
        <div
          className="settings-section-body storage-panel"
          id="image-storage-panel"
          aria-busy={loading}
        >
          {connected === false && (
            <p className="storage-notice" role="status">
              {t('接続が切れています。再接続すると変更できます。', 'Reconnect to make changes.')}
            </p>
          )}
          {error && (
            <p className="storage-error" role="alert">
              {error}
            </p>
          )}
          {feedback && (
            <p className="storage-feedback" role="status">
              {feedback}
            </p>
          )}
          {!overview ? (
            <div className="storage-toolbar">
              <p className="storage-notice">
                {loading
                  ? t('使用量を確認しています…', 'Checking storage…')
                  : t('使用量を取得できませんでした。', 'Storage information is unavailable.')}
              </p>
              {!loading && (
                <Button type="button" icon={RefreshCw} onClick={() => void load()}>
                  {t('再読み込み', 'Reload')}
                </Button>
              )}
            </div>
          ) : (
            <>
              <dl className="storage-summary">
                <div>
                  <dt>{t('使用量', 'Space used')}</dt>
                  <dd>
                    {bytes(overview.usage.totalBytes)}
                    <small>{t('管理対象の保存データ', 'Managed storage')}</small>
                  </dd>
                </div>
                <div>
                  <dt>{t('保存中の画像', 'Stored images')}</dt>
                  <dd>
                    {t(`${overview.usage.imageCount}枚`, `${overview.usage.imageCount}`)}
                    <small>
                      {t(
                        `「残す」${overview.usage.protectedCount}枚`,
                        `${overview.usage.protectedCount} kept`,
                      )}
                    </small>
                  </dd>
                </div>
                <div>
                  <dt>{t('整理候補', 'Cleanup candidates')}</dt>
                  <dd>
                    {t(`${overview.usage.candidateCount}枚`, `${overview.usage.candidateCount}`)}
                    <small>{bytes(overview.usage.candidateBytes)}</small>
                  </dd>
                </div>
              </dl>
              <dl className="storage-breakdown">
                {overview.usage.categories.map((category) => (
                  <div key={category.kind}>
                    <dt>{categoryLabels[category.kind]}</dt>
                    <dd>{bytes(category.bytes)}</dd>
                  </div>
                ))}
              </dl>
              <div className="storage-toolbar">
                <p className="storage-notice">
                  {t(
                    `同じ内容の重複：${bytes(overview.usage.duplicateBytes)}`,
                    `Duplicate content: ${bytes(overview.usage.duplicateBytes)}`,
                  )}
                </p>
                <Button
                  type="button"
                  icon={Layers}
                  busy={action === 'deduplicate'}
                  disabled={disabled || loading || overview.usage.duplicateBytes <= 0}
                  onClick={deduplicate}
                >
                  {t('重複をまとめる', 'Consolidate duplicates')}
                </Button>
              </div>
              {overview.warnings.length > 0 && (
                <div className="storage-notice" role="status">
                  {overview.warnings.map((warning) => (
                    <p key={warning}>{t(warning, WARNING_TRANSLATIONS[warning] ?? warning)}</p>
                  ))}
                </div>
              )}
              <div className="storage-policy">
                <Toggle
                  checked={autoCleanup}
                  onChange={(value) => {
                    setAutoCleanup(value);
                    setPolicyDirty(true);
                  }}
                  disabled={disabled}
                  label={t('未使用の画像を自動で整理', 'Automatically clean up unused images')}
                  description={t(
                    '「残す」指定のない画像が対象です。使用中の画像と、継続中の仕事に必要な画像は残します。',
                    'Only unprotected images are eligible. Images in use or needed by ongoing work are kept.',
                  )}
                />
                <div className="storage-policy-fields">
                  <Field
                    label={t('整理までの未使用日数', 'Days without use before cleanup')}
                    hint={t(
                      '拡大表示・ダウンロード・ボットによる再利用から数えます。',
                      'Counted from opening, downloading, or reuse by a bot.',
                    )}
                  >
                    <input
                      type="number"
                      min={IMAGE_STORAGE_UNUSED_DAYS.min}
                      max={IMAGE_STORAGE_UNUSED_DAYS.max}
                      step={1}
                      value={unusedDays}
                      disabled={disabled}
                      aria-label={t('整理までの未使用日数', 'Days without use before cleanup')}
                      aria-invalid={!daysValid}
                      onChange={(event) => {
                        setUnusedDays(event.target.value);
                        setPolicyDirty(true);
                      }}
                    />
                  </Field>
                  <Button
                    type="button"
                    icon={Save}
                    busy={action === 'save'}
                    disabled={disabled || !policyDirty || !daysValid}
                    onClick={savePolicy}
                  >
                    {t('保存ルールを保存', 'Save storage rules')}
                  </Button>
                </div>
                {!daysValid && (
                  <p className="storage-error" role="alert">
                    {t(
                      '日数は1〜3650の整数で指定してください。',
                      'Enter a whole number from 1 to 3650 days.',
                    )}
                  </p>
                )}
                <p className="storage-notice">
                  {t(
                    '添付した画像は初めから「残す」になっています。サムネイルの表示だけでは未使用日数はリセットしません。',
                    'Uploaded images are kept by default. Simply displaying a thumbnail does not reset the unused period.',
                  )}
                </p>
              </div>
              <div className="storage-gallery">
                <div className="storage-toolbar">
                  <h3>{t('画像の一覧', 'Images')}</h3>
                  <div className="storage-filters">
                    <select
                      aria-label={t('画像の絞り込み', 'Filter images')}
                      value={query.filter}
                      disabled={disabled}
                      onChange={(event) =>
                        changeQuery({
                          filter: event.target.value as Required<ImageStorageQuery>['filter'],
                        })
                      }
                    >
                      <option value="candidates">{t('整理候補', 'Cleanup candidates')}</option>
                      <option value="all">{t('すべて', 'All images')}</option>
                      <option value="protected">{t('残す', 'Kept images')}</option>
                      <option value="deleted">{t('整理済み', 'Cleaned up')}</option>
                    </select>
                    <select
                      aria-label={t('画像の並び順', 'Sort images')}
                      value={query.sort}
                      disabled={disabled}
                      onChange={(event) =>
                        changeQuery({
                          sort: event.target.value as Required<ImageStorageQuery>['sort'],
                        })
                      }
                    >
                      <option value="largest">{t('大きい順', 'Largest first')}</option>
                      <option value="oldest">{t('最終利用が古い順', 'Least recently used')}</option>
                    </select>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    icon={RefreshCw}
                    disabled={disabled}
                    busy={loading}
                    onClick={() => void load()}
                  >
                    {t('更新', 'Refresh')}
                  </Button>
                </div>
                {overview.images.length > 0 && (
                  <div className="storage-selection">
                    <label className="storage-select-all">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        disabled={disabled || loading || !selectable.length}
                        onChange={(event) =>
                          setSelected(
                            event.target.checked ? selectable.map((image) => image.id) : [],
                          )
                        }
                      />
                      {t('このページを選択', 'Select this page')}
                    </label>
                    <span>
                      {t(`${selectedItems.length}枚を選択`, `${selectedItems.length} selected`)}
                    </span>
                    <Button
                      type="button"
                      icon={Bookmark}
                      disabled={
                        disabled ||
                        loading ||
                        !selectedItems.some((image) => !image.storage.protected)
                      }
                      onClick={() => protectSelection(true)}
                    >
                      {t('残す', 'Keep')}
                    </Button>
                    <Button
                      type="button"
                      disabled={
                        disabled ||
                        loading ||
                        !selectedItems.some((image) => image.storage.protected)
                      }
                      onClick={() => protectSelection(false)}
                    >
                      {t('保護を解除', 'Unprotect')}
                    </Button>
                    <Button
                      type="button"
                      icon={Trash2}
                      disabled={
                        disabled ||
                        loading ||
                        !selectedCandidates.length ||
                        selectedCandidates.length !== selectedItems.length
                      }
                      onClick={() => setCleanupReview([...selectedCandidates])}
                    >
                      {t('整理する画像を確認', 'Review cleanup')}
                    </Button>
                  </div>
                )}
                {overview.images.length ? (
                  <ul className="storage-image-list">
                    {overview.images.map((image) => (
                      <li
                        className={`storage-image-row ${selected.includes(image.id) ? 'is-selected' : ''}`}
                        key={image.id}
                        data-image-id={image.id}
                      >
                        <label className="storage-row-select">
                          <input
                            type="checkbox"
                            aria-label={t(`${image.filename}を選択`, `Select ${image.filename}`)}
                            checked={selected.includes(image.id)}
                            disabled={disabled || loading || !!image.storage.deletedAt}
                            onChange={(event) =>
                              setSelected((current) =>
                                event.target.checked
                                  ? [...current, image.id]
                                  : current.filter((id) => id !== image.id),
                              )
                            }
                          />
                        </label>
                        <StorageThumbnail image={image} />
                        <div className="storage-image-details">
                          {image.storage.deletedAt ? (
                            <strong>{image.filename}</strong>
                          ) : (
                            <a
                              href={`/api/images/${image.id}`}
                              target="_blank"
                              rel="noreferrer"
                              onClick={() => markOpened(image.id)}
                              title={image.filename}
                            >
                              {image.filename}
                            </a>
                          )}
                          <small>
                            {image.storage.deletedAt
                              ? t(
                                  `整理：${dateLabel(image.storage.deletedAt, locale, true)}`,
                                  `Cleaned: ${dateLabel(image.storage.deletedAt, locale, true)}`,
                                )
                              : t(
                                  `最終利用：${dateLabel(image.storage.lastUsedAt, locale, true)}`,
                                  `Last used: ${dateLabel(image.storage.lastUsedAt, locale, true)}`,
                                )}
                            {image.roomNames.length ? ` · ${image.roomNames.join(', ')}` : ''}
                          </small>
                        </div>
                        <div className="storage-image-status">
                          <span>{bytes(image.byteLength)}</span>
                          {image.storage.deletedAt ? (
                            <span>{t('原本は整理済み', 'Original cleaned up')}</span>
                          ) : image.storage.protected ? (
                            <span className="storage-badge">
                              <BookmarkCheck size={12} />
                              {t('残す', 'Kept')}
                            </span>
                          ) : image.candidate ? (
                            <span className="storage-badge storage-badge-candidate">
                              {t('整理候補', 'Candidate')}
                            </span>
                          ) : (
                            <span
                              title={image.blockedReasons
                                .map((reason) => reasonLabels[reason])
                                .join(' · ')}
                            >
                              {reasonLabels[image.blockedReasons[0]] || t('保持中', 'Retained')}
                            </span>
                          )}
                        </div>
                      </li>
                    ))}
                  </ul>
                ) : (
                  <p className="storage-empty">
                    {query.filter === 'candidates'
                      ? t(
                          '現在、整理候補の画像はありません。',
                          'There are no cleanup candidates right now.',
                        )
                      : t('該当する画像はありません。', 'No images match this filter.')}
                  </p>
                )}
                <div className="storage-pagination">
                  <span>
                    {overview.total
                      ? t(
                          `${overview.offset + 1}〜${overview.offset + overview.images.length} / ${overview.total}件`,
                          `${overview.offset + 1}–${overview.offset + overview.images.length} of ${overview.total}`,
                        )
                      : t('0件', '0 images')}
                  </span>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={disabled || loading || query.offset === 0}
                    onClick={() => changeQuery({ offset: Math.max(0, query.offset - PAGE_SIZE) })}
                  >
                    {t('前へ', 'Previous')}
                  </Button>
                  <Button
                    type="button"
                    variant="ghost"
                    disabled={
                      disabled ||
                      loading ||
                      overview.offset + overview.images.length >= overview.total
                    }
                    onClick={() => changeQuery({ offset: query.offset + PAGE_SIZE })}
                  >
                    {t('次へ', 'Next')}
                  </Button>
                </div>
                {overview.lastCleanup && (
                  <p className="storage-notice">
                    {t(
                      `前回の整理：${dateLabel(overview.lastCleanup.at, locale, true)}・${overview.lastCleanup.deletedImages}枚・${bytes(overview.lastCleanup.freedBytes)}`,
                      `Last cleanup: ${dateLabel(overview.lastCleanup.at, locale, true)} · ${overview.lastCleanup.deletedImages} images · ${bytes(overview.lastCleanup.freedBytes)}`,
                    )}
                  </p>
                )}
              </div>
            </>
          )}
        </div>
      )}
      {cleanupReview && (
        <Modal
          title={t('整理する画像を確認', 'Review cleanup')}
          onClose={() => {
            if (!action) {
              setCleanupReview(null);
              setError('');
            }
          }}
        >
          <p className="storage-notice">
            {t(
              '選んだ画像の原本を整理します。会話の記録と生成時の情報は残ります。原本は元に戻せません。',
              'Remove the selected original images. Conversation records and image details remain. Removed originals cannot be restored.',
            )}
          </p>
          <ul className="storage-cleanup-list">
            {cleanupReview.map((image) => (
              <li key={image.id}>
                <span>{image.filename}</span>
                <span>{bytes(image.byteLength)}</span>
              </li>
            ))}
          </ul>
          <p className="storage-cleanup-total">
            {t(
              `${cleanupReview.length}枚・原本の合計 ${bytes(cleanupReview.reduce((total, image) => total + image.byteLength, 0))}`,
              `${cleanupReview.length} image(s) · ${bytes(cleanupReview.reduce((total, image) => total + image.byteLength, 0))} in originals`,
            )}
          </p>
          <p className="storage-notice">
            {t(
              '確認後に使用された画像や「残す」に変更された画像は整理しません。実際に空く容量は、共有されている保存データによって変わります。',
              'Images used or protected since this review will be kept. Actual space freed depends on shared stored data.',
            )}
          </p>
          {error && (
            <p className="storage-error" role="alert">
              {error}
            </p>
          )}
          <footer className="form-actions">
            <Button
              type="button"
              disabled={!!action}
              onClick={() => {
                setCleanupReview(null);
                setError('');
              }}
            >
              {t('キャンセル', 'Cancel')}
            </Button>
            <Button
              type="button"
              variant="danger"
              icon={Trash2}
              busy={action === 'cleanup'}
              disabled={disabled || !cleanupReview.length}
              onClick={cleanup}
            >
              {t(
                `${cleanupReview.length}枚の原本を整理`,
                `Clean up ${cleanupReview.length} original(s)`,
              )}
            </Button>
          </footer>
        </Modal>
      )}
    </section>
  );
}
