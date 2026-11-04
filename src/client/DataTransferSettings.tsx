import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronUp,
  Database,
  RotateCcw,
} from 'lucide-react';
import type {
  DataTransferInfo,
  DataTransferJob,
  DataTransferSummary,
} from '../shared/data-transfer';
import { ApiError } from './api';
import { Button, Field, Toggle } from './components';
import { useApp } from './context';
import {
  captureTransferBrowserState,
  dataTransferApi,
  DataTransferPendingError,
  isTransferConnectionError,
  restoreTransferBrowserState,
  transferPasswordProblem,
  uploadTransferFile,
  waitForDataTransferJob,
} from './data-transfer';

const runningStatuses = new Set<DataTransferJob['status']>(['queued', 'working', 'applying']);

const transferWarningTranslations = new Map([
  [
    'The dedicated Chrome profile is included. Chrome logins may need to be renewed on another operating system or user account.',
    'Loom専用Chromeのプロファイルを含みます。別のOSやユーザーアカウントでは、Chromeで使うサービスへの再ログインが必要になる場合があります。',
  ],
  [
    'Host startup settings (.env), installed applications and models, existing-Chrome profiles, and external service data are not copied.',
    '起動設定（.env）、インストール済みのアプリやモデル、普段使っているChromeのプロファイル、外部サービスに保存されたデータはコピーされません。',
  ],
  [
    'Imported automations are disabled and active tasks require an explicit resume. Keep only one copy running the same automations.',
    '取り込んだ自動実行は停止状態になり、実行中だったタスクの再開には操作が必要です。同じ自動実行は、片方のLoomだけで動かしてください。',
  ],
  [
    'Source Loom login sessions are excluded. The destination keeps its own access settings.',
    'コピー元のLoomのログイン状態はコピーされません。コピー先のLoomのアクセス設定を維持します。',
  ],
  [
    'Loom browser login sessions were cleared. Use the destination computer’s existing access token to sign in.',
    'コピー元のLoomのログイン状態は引き継ぎません。ログインが必要な場合は、コピー先の既存アクセストークンを使ってください。',
  ],
]);
const transferWarningPrefixes = [
  ['Already included separately as Loom data: ', 'Loomのデータとして別にコピー済みです：'],
  [
    'Excluded a path that is not portable across operating systems: ',
    '別のOSで使えない名前のため、コピー対象から除外しました：',
  ],
  [
    'Excluded a symbolic link outside its storage root: ',
    '保存フォルダーの外を指すシンボリックリンクは除外しました：',
  ],
  [
    'Excluded a device, socket, or other non-file entry: ',
    'デバイスやソケットなど、通常のファイルではない項目を除外しました：',
  ],
  [
    'Workspace content was unavailable or was a symbolic link; an empty destination folder will be created: ',
    '作業フォルダーにアクセスできないか、シンボリックリンクのため、コピー先には空のフォルダーを作成します：',
  ],
  [
    'Excluded a dangling or chained symbolic link: ',
    '参照先がないか、別のリンクを経由するシンボリックリンクを除外しました：',
  ],
  [
    'A historical Pi parent session was outside the copied storage roots: ',
    '過去の会話の元セッションがコピー対象外の場所にあります：',
  ],
  [
    'A symbolic link could not be created on this computer and was excluded: ',
    'このPCでシンボリックリンクを作成できなかったため、除外しました：',
  ],
  [
    'An unavailable workspace was restored as an empty directory: ',
    '利用できなかった作業フォルダーを、空のフォルダーとして復元しました：',
  ],
] as const;

function localizeTransferWarning(warning: string, locale: 'ja' | 'en') {
  if (locale !== 'ja') return warning;
  const translated = transferWarningTranslations.get(warning);
  if (translated) return translated;
  for (const [prefix, label] of transferWarningPrefixes)
    if (warning.startsWith(prefix)) return label + warning.slice(prefix.length);
  const omitted =
    /^(\d+) additional excluded or unavailable paths were omitted from this warning list\.$/.exec(
      warning,
    );
  return omitted ? `このほか、除外または利用できなかったパスが${omitted[1]}件あります。` : warning;
}

function formatBytes(bytes: number) {
  if (bytes < 1024) return `${bytes.toLocaleString()} B`;
  const unit = Math.min(3, Math.floor(Math.log(bytes) / Math.log(1024)));
  return `${(bytes / 1024 ** unit).toLocaleString(undefined, { maximumFractionDigits: 1 })} ${['B', 'KB', 'MB', 'GB'][unit]}`;
}

function TransferSummary({
  summary,
  currentCounts,
}: {
  summary: DataTransferSummary;
  currentCounts?: Record<string, number>;
}) {
  const { t, locale } = useApp();
  const labels: Record<string, string> = {
    bots: t('ボット', 'Bots'),
    rooms: t('ルーム', 'Rooms'),
    messages: t('メッセージ', 'Messages'),
    tasks: t('タスク', 'Tasks'),
    activities: t('活動履歴', 'Activity'),
    approvals: t('承認', 'Approvals'),
    skills: t('スキル', 'Skills'),
    memories: t('メモリー', 'Memories'),
    automations: t('自動実行', 'Automations'),
    notifications: t('通知', 'Notifications'),
    mailAccounts: t('メールアカウント', 'Mail accounts'),
    mailDrafts: t('メールの下書き', 'Mail drafts'),
    generatedImages: t('生成画像', 'Generated images'),
    images: t('画像', 'Images'),
    accounts: t('アカウント', 'Accounts'),
    credentials: t('接続情報', 'Credentials'),
    settings: t('設定', 'Settings'),
    operations: t('操作履歴', 'Operation history'),
    automationState: t('自動実行の履歴', 'Automation history'),
    mailSends: t('メール送信履歴', 'Sent mail history'),
    serviceAccounts: t('サービスアカウント', 'Service accounts'),
    avatarGenerations: t('アバター作成履歴', 'Avatar generation history'),
    promptGenerations: t('プロンプト作成履歴', 'Prompt generation history'),
  };
  const created = new Date(summary.createdAt);
  const allCountKeys = [
    ...new Set([...Object.keys(summary.counts), ...Object.keys(currentCounts ?? {})]),
  ];
  const countRows = Object.keys(labels)
    .filter((key) => allCountKeys.includes(key))
    .map((key) => ({
      key,
      label: labels[key],
      incoming: summary.counts[key] ?? 0,
      current: currentCounts?.[key] ?? 0,
    }));
  const otherKeys = allCountKeys.filter((key) => !(key in labels));
  const otherIncoming = otherKeys.reduce((total, key) => total + (summary.counts[key] ?? 0), 0);
  const otherCurrent = otherKeys.reduce((total, key) => total + (currentCounts?.[key] ?? 0), 0);
  if (otherIncoming || otherCurrent)
    countRows.push({
      key: 'other',
      label: t('その他の保存データ', 'Other stored data'),
      incoming: otherIncoming,
      current: otherCurrent,
    });
  return (
    <div className="transfer-summary">
      <dl className="transfer-metadata">
        <div>
          <dt>{t('作成日時', 'Created')}</dt>
          <dd>
            {Number.isNaN(created.getTime())
              ? summary.createdAt
              : created.toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')}
          </dd>
        </div>
        <div>
          <dt>{t('コピー元', 'Source')}</dt>
          <dd>
            Agent Loom {summary.version} · {summary.platform}
          </dd>
        </div>
        <div>
          <dt>{t('保存ファイル', 'Stored files')}</dt>
          <dd>
            {summary.fileCount.toLocaleString()} · {formatBytes(summary.totalBytes)}
          </dd>
        </div>
      </dl>
      {countRows.length > 0 && (
        <div className="transfer-table-scroll">
          <table>
            <caption className="visually-hidden">
              {t('移行するデータの件数', 'Transfer data counts')}
            </caption>
            <thead>
              <tr>
                <th scope="col">{t('データ', 'Data')}</th>
                <th scope="col">{t('コピーする内容', 'Incoming data')}</th>
                {currentCounts && <th scope="col">{t('現在のLoom', 'Current Loom')}</th>}
              </tr>
            </thead>
            <tbody>
              {countRows.map((row) => (
                <tr key={row.key}>
                  <th scope="row">{row.label}</th>
                  <td>{row.incoming.toLocaleString()}</td>
                  {currentCounts && <td>{row.current.toLocaleString()}</td>}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {summary.workspaces.length > 0 && (
        <details className="transfer-workspaces">
          <summary>
            {t('作業フォルダー', 'Workspace folders')} ({summary.workspaces.length})
          </summary>
          <ul>
            {summary.workspaces.map((workspace, index) => (
              <li key={`${workspace.sourcePath}-${index}`}>
                <span>{workspace.sourcePath}</span>
                {workspace.destinationPath && (
                  <>
                    <span className="transfer-path-label">{t('移行先', 'Destination')}</span>
                    <span>{workspace.destinationPath}</span>
                  </>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {summary.warnings.length > 0 && (
        <div className="transfer-notice">
          <strong>{t('確認が必要な項目', 'Items to review')}</strong>
          <ul>
            {summary.warnings.map((warning, index) => (
              <li key={index}>{localizeTransferWarning(warning, locale)}</li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

export function DataTransferSettings({ hasChanges }: { hasChanges: boolean }) {
  const { t } = useApp();
  const [expanded, setExpanded] = useState(false);
  const [info, setInfo] = useState<DataTransferInfo | null>(null);
  const [mode, setMode] = useState<'export' | 'import'>('export');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [includeBrowser, setIncludeBrowser] = useState(true);
  const [restoreBrowser, setRestoreBrowser] = useState(true);
  const [file, setFile] = useState<File | null>(null);
  const [job, setJob] = useState<DataTransferJob | null>(null);
  const [action, setAction] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [waiting, setWaiting] = useState(false);
  const [needsStatus, setNeedsStatus] = useState(false);
  const [needsLogin, setNeedsLogin] = useState(false);
  const [recovered, setRecovered] = useState(false);
  const request = useRef<AbortController | null>(null);
  const mounted = useRef(true);
  const currentJob = useRef<DataTransferJob | null>(null);
  const pendingCleanup = useRef<string | null>(null);
  const uploadedFile = useRef<File | null>(null);
  const fileInput = useRef<HTMLInputElement | null>(null);
  const dirty = useRef(hasChanges);
  dirty.current = hasChanges;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      request.current?.abort();
    };
  }, []);

  function remember(next: DataTransferJob | null) {
    if (next && next.id === currentJob.current?.id && !next.preview && currentJob.current.preview)
      next = { ...next, preview: currentJob.current.preview };
    currentJob.current = next;
    if (mounted.current) setJob(next);
  }

  async function run(name: string, operation: (signal: AbortSignal) => Promise<void>) {
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    setAction(name);
    setError('');
    setWaiting(false);
    setNeedsStatus(false);
    setNeedsLogin(false);
    try {
      await operation(controller.signal);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted) return;
      if (failure instanceof DataTransferPendingError || isTransferConnectionError(failure)) {
        setNeedsStatus(true);
        setError(
          t(
            'Loomとの接続をまだ確認できません。処理結果は未確認です。接続が戻ったら、状況を再確認してください。',
            'Loom is not reachable yet. The result is not confirmed. Check the status when the connection returns.',
          ),
        );
      } else if (failure instanceof ApiError && failure.status === 401) {
        setNeedsLogin(true);
        setNeedsStatus(true);
        setError(
          t(
            '状況を確認するには、Loomへログインし直してください。',
            'Sign in to Loom again to check the transfer status.',
          ),
        );
      } else {
        setError(
          failure instanceof Error
            ? failure.message
            : t('処理を完了できませんでした。', 'The operation could not be completed.'),
        );
      }
    } finally {
      if (mounted.current && request.current === controller) {
        request.current = null;
        setAction(null);
      }
    }
  }

  async function watch(id: string, signal: AbortSignal) {
    const result = await waitForDataTransferJob(id, {
      signal,
      onUpdate: remember,
      onReconnect: (value) => {
        if (mounted.current) setWaiting(value);
      },
    });
    if (result.status === 'failed')
      setError(
        result.error || t('処理を完了できませんでした。', 'The operation could not be completed.'),
      );
    setInfo((current) => (current ? { ...current, busy: false } : current));
    if (result.status === 'completed' || (result.kind === 'export' && result.status === 'ready')) {
      setPassword('');
      setConfirmation('');
    }
  }

  async function loadStatus(signal: AbortSignal) {
    const next = await dataTransferApi.info(signal);
    setInfo(next);
    let existing = next.activeJob;
    if (currentJob.current) {
      const previousId = currentJob.current.id;
      try {
        existing = await dataTransferApi.job(previousId, signal);
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 404) throw failure;
        remember(null);
        if (existing?.id === previousId) existing = undefined;
      }
    }
    if (existing) {
      if (!currentJob.current) {
        setRecovered(true);
        if (existing.kind === 'import' && existing.status === 'completed') setRestoreBrowser(false);
      }
      setMode(existing.kind);
      remember(existing);
      if (existing.status === 'failed' && existing.error) setError(existing.error);
      if (runningStatuses.has(existing.status)) await watch(existing.id, signal);
    }
  }

  function refreshStatus() {
    void run('checking', loadStatus);
  }

  async function discard(signal: AbortSignal) {
    const previous = currentJob.current;
    if (previous) pendingCleanup.current = previous.id;
    remember(null);
    setRecovered(false);
    setRestoreBrowser(true);
    uploadedFile.current = null;
    if (pendingCleanup.current) {
      try {
        await dataTransferApi.discard(pendingCleanup.current, signal);
      } catch (failure) {
        if (!(failure instanceof ApiError) || failure.status !== 404) throw failure;
      }
      pendingCleanup.current = null;
      setInfo((current) => (current ? { ...current, busy: false, activeJob: undefined } : current));
    }
  }

  function switchMode(next: 'export' | 'import') {
    if (next === mode || action || (job && runningStatuses.has(job.status))) return;
    setMode(next);
    setPassword('');
    setConfirmation('');
    setFile(null);
    setError('');
    if (currentJob.current || pendingCleanup.current) void run('discarding', discard);
  }

  function changePassword(value: string) {
    setPassword(value);
    setError('');
    const previous = currentJob.current;
    if (previous?.kind === 'import' && previous.preview) {
      const invalidated = { ...previous, preview: undefined };
      currentJob.current = invalidated;
      setJob(invalidated);
    }
  }

  function chooseFile(next: File | null) {
    setFile(next);
    setError('');
    if (currentJob.current || pendingCleanup.current) void run('discarding', discard);
  }

  function validatePassword() {
    const problem = transferPasswordProblem(password);
    if (problem) {
      setError(
        problem === 'short'
          ? t(
              'パスワードは12文字以上で入力してください。',
              'Use a password with at least 12 characters.',
            )
          : t(
              'パスワードが長すぎます。短くしてください。',
              'This password is too long. Use a shorter one.',
            ),
      );
      return false;
    }
    return true;
  }

  function requireSavedSettings() {
    if (dirty.current)
      throw new Error(
        t(
          '未保存の設定があります。変更を保存してから操作してください。',
          'Save your settings changes before continuing.',
        ),
      );
  }

  function startExport() {
    if (hasChanges || action || !info?.available || !validatePassword()) return;
    if (password !== confirmation) {
      setError(t('確認用パスワードが一致しません。', 'The passwords do not match.'));
      return;
    }
    void run('exporting', async (signal) => {
      await discard(signal);
      requireSavedSettings();
      const next = await dataTransferApi.export(
        password,
        includeBrowser ? captureTransferBrowserState() : undefined,
        signal,
      );
      remember(next);
      await watch(next.id, signal);
    });
  }

  function inspectImport() {
    if (hasChanges || action || !info?.available || !validatePassword()) return;
    const stored = currentJob.current;
    const uploaded =
      stored?.kind === 'import' &&
      !stored.requiresNewUpload &&
      stored.totalBytes !== undefined &&
      stored.uploadedBytes === stored.totalBytes;
    if (!file && !uploaded) {
      setError(
        t(
          'Loomで作成した移行ファイルを選択してください。',
          'Choose a transfer file created by Loom.',
        ),
      );
      return;
    }
    if (file && (!file.size || file.size > info.maxArchiveBytes)) {
      setError(
        t(
          `空でない、${formatBytes(info.maxArchiveBytes)}以下の移行ファイルを選択してください。`,
          `Choose a nonempty transfer file no larger than ${formatBytes(info.maxArchiveBytes)}.`,
        ),
      );
      return;
    }
    void run('importing', async (signal) => {
      let next = currentJob.current;
      const canReuse =
        next?.kind === 'import' &&
        !next.requiresNewUpload &&
        (uploadedFile.current === file || (!file && uploaded));
      if (!canReuse) {
        await discard(signal);
        requireSavedSettings();
        next = await dataTransferApi.createImport(file!.size, signal);
        uploadedFile.current = file;
      } else {
        next = await dataTransferApi.job(next!.id, signal);
      }
      remember(next!);
      if (next!.uploadedBytes !== next!.totalBytes)
        next = await uploadTransferFile(next!, file!, info.chunkBytes, {
          signal,
          onUpdate: remember,
        });
      requireSavedSettings();
      setRecovered(false);
      next = await dataTransferApi.inspect(next!.id, password, signal);
      remember(next);
      await watch(next.id, signal);
    });
  }

  function applyImport() {
    const previous = currentJob.current;
    if (
      hasChanges ||
      action ||
      previous?.kind !== 'import' ||
      previous.status !== 'ready' ||
      !previous.preview
    )
      return;
    void run('applying', async (signal) => {
      requireSavedSettings();
      setRecovered(false);
      remember({ ...previous, status: 'applying' });
      try {
        remember(await dataTransferApi.apply(previous.id, previous.preview!.token, signal));
      } catch (failure) {
        if (!isTransferConnectionError(failure)) {
          remember(previous);
          throw failure;
        }
        setWaiting(true);
      }
      await watch(previous.id, signal);
    });
  }

  function reopenLoom() {
    try {
      if (
        job?.kind === 'import' &&
        job.status === 'completed' &&
        restoreBrowser &&
        job.preview?.browserState
      )
        restoreTransferBrowserState(job.preview.browserState);
      window.location.reload();
    } catch {
      setError(
        t(
          'このブラウザーに設定を保存できませんでした。ブラウザー設定の取り込みをオフにして開き直してください。',
          'Browser settings could not be saved. Turn off browser settings import and open Loom again.',
        ),
      );
    }
  }

  const processing = !!action || !!(job && runningStatuses.has(job.status));
  const blocked = processing || hasChanges || !info?.available || (!!info.busy && !job);
  const preview = job?.kind === 'import' && job.status === 'ready' ? job.preview : undefined;
  const completed = job?.kind === 'import' && job.status === 'completed';
  const exportReady = job?.kind === 'export' && job.status === 'ready';
  const statusText = waiting
    ? t(
        'Loomの再起動を待っています。処理結果を確認しています。',
        'Waiting for Loom to restart and confirm the result.',
      )
    : job?.status === 'uploading'
      ? action === 'importing'
        ? t('移行ファイルを送信しています。', 'Uploading the transfer file.')
        : job.uploadedBytes === job.totalBytes
          ? t(
              'ファイルは送信済みです。パスワードを入力して内容を確認してください。',
              'The file is uploaded. Enter its password to inspect it.',
            )
          : t(
              'ファイルの送信が途中です。「内容を確認」から再開できます。',
              'The upload is incomplete. Choose “Inspect file” to resume.',
            )
      : job?.status === 'applying'
        ? t(
            '現在のデータを退避して、取り込んでいます。Loomは自動で起動し直します。',
            'Backing up current data and importing. Loom will restart automatically.',
          )
        : job?.status === 'queued' || job?.status === 'working'
          ? mode === 'export'
            ? t(
                '暗号化ファイルを作成しています。Loomは自動で起動し直します。',
                'Creating the encrypted file. Loom will restart automatically.',
              )
            : t(
                'ファイルを検証しています。現在のデータはまだ置き換えません。',
                'Validating the file. Current data has not been replaced.',
              )
          : action === 'checking'
            ? t('Loomの状態を確認しています。', 'Checking Loom status.')
            : action === 'discarding'
              ? t('一時ファイルを片づけています。', 'Removing the temporary file.')
              : '';

  return (
    <section className="settings-section data-transfer-section">
      <div className="settings-section-heading">
        <span>
          <Database size={20} />
        </span>
        <div>
          <h2>{t('データの移行', 'Data transfer')}</h2>
          <p>
            {t(
              '設定・会話・保存ファイルを、別のPCで動くLoomへコピーします。',
              'Copy settings, conversations, and stored files to Loom on another computer.',
            )}
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          icon={expanded ? ChevronUp : ChevronDown}
          aria-expanded={expanded}
          aria-controls="data-transfer-panel"
          disabled={!!action}
          onClick={() => {
            if (!expanded) {
              setExpanded(true);
              refreshStatus();
            } else {
              setExpanded(false);
              setPassword('');
              setConfirmation('');
            }
          }}
        >
          {expanded ? t('閉じる', 'Close') : t('開く', 'Open')}
        </Button>
      </div>
      {expanded && (
        <div className="settings-section-body transfer-panel" id="data-transfer-panel">
          {hasChanges && (
            <p className="transfer-notice" role="status">
              {t(
                '未保存の設定があります。変更を保存してからコピーや取り込みを始めてください。',
                'Save your settings changes before starting a copy or import.',
              )}
            </p>
          )}
          {info && !info.available && (
            <p className="transfer-notice">
              {t(
                'この起動方法では移行機能を利用できません。Loomを通常の起動方法で起動し直してください。開発用サーバーなどでは使えません。',
                'Data transfer is unavailable with this launch method. Start Loom normally; development servers and other unmanaged instances cannot use this feature.',
              )}
            </p>
          )}
          {info?.busy && !job && (
            <p className="transfer-notice">
              {t(
                '別の移行処理が進行中です。しばらくして状況を更新してください。',
                'Another transfer is in progress. Check the status again shortly.',
              )}
            </p>
          )}
          {recovered && job && (
            <p className="transfer-description">
              {t(
                '保存されている移行の状況を表示しています。',
                'Showing the saved status of an earlier transfer.',
              )}
            </p>
          )}
          <div className="transfer-mode" aria-label={t('移行の操作', 'Transfer operation')}>
            <Button
              type="button"
              variant={mode === 'export' ? 'primary' : 'secondary'}
              icon={ArrowDownToLine}
              aria-pressed={mode === 'export'}
              disabled={processing}
              onClick={() => switchMode('export')}
            >
              {t('このLoomからコピー', 'Copy from this Loom')}
            </Button>
            <Button
              type="button"
              variant={mode === 'import' ? 'primary' : 'secondary'}
              icon={ArrowUpFromLine}
              aria-pressed={mode === 'import'}
              disabled={processing}
              onClick={() => switchMode('import')}
            >
              {t('別のLoomから取り込む', 'Import from another Loom')}
            </Button>
          </div>
          {!completed && (
            <p className="transfer-description">
              {mode === 'export'
                ? t(
                    'パスワードで保護した移行ファイルを作成します。このLoomを短時間停止するため、実行中の処理は中断されます。作成後は自動で起動し直し、元のデータは残ります。',
                    'Create a password-protected transfer file. Loom will stop briefly, interrupting running operations, then restart automatically. The original data stays here.',
                  )
                : t(
                    '最初にファイルの内容を確認します。取り込み時は現在のデータを自動で退避してから置き換えます。元のデータとの統合は行いません。Loomは短時間停止し、自動で起動し直します。',
                    'Review the file first. Import backs up the current data, then replaces it without merging. Loom will stop briefly and restart automatically.',
                  )}
            </p>
          )}
          {!completed && !exportReady && (
            <div className="transfer-inputs">
              {mode === 'import' && (
                <Field
                  label={t('移行ファイル', 'Transfer file')}
                  hint={
                    file
                      ? `${file.name} · ${formatBytes(file.size)}`
                      : job?.kind === 'import' && job.uploadedBytes === job.totalBytes
                        ? t(
                            '送信済みのファイルを確認します。別のファイルも選び直せます。',
                            'The uploaded file is ready to inspect. You can also choose a different file.',
                          )
                        : info
                          ? t(
                              `Loomで作成した暗号化ファイル（最大${formatBytes(info.maxArchiveBytes)}）`,
                              `An encrypted file created by Loom (up to ${formatBytes(info.maxArchiveBytes)})`,
                            )
                          : undefined
                  }
                >
                  <input
                    type="file"
                    ref={fileInput}
                    aria-label={t('移行ファイル', 'Transfer file')}
                    disabled={processing}
                    onChange={(event) => chooseFile(event.target.files?.[0] ?? null)}
                  />
                </Field>
              )}
              <Field
                label={t('移行ファイルのパスワード', 'Transfer file password')}
                hint={t(
                  '12文字以上。取り込み時にも使うため、忘れないように控えてください。',
                  'At least 12 characters. Keep it safe; it is required to import the file.',
                )}
              >
                <input
                  type="password"
                  autoComplete={mode === 'export' ? 'new-password' : 'current-password'}
                  maxLength={1024}
                  value={password}
                  aria-label={t('移行ファイルのパスワード', 'Transfer file password')}
                  disabled={processing}
                  onChange={(event) => changePassword(event.target.value)}
                />
              </Field>
              {mode === 'export' && (
                <>
                  <Field label={t('パスワードの確認', 'Confirm password')}>
                    <input
                      type="password"
                      autoComplete="new-password"
                      maxLength={1024}
                      value={confirmation}
                      aria-label={t('パスワードの確認', 'Confirm password')}
                      disabled={processing}
                      onChange={(event) => setConfirmation(event.target.value)}
                    />
                  </Field>
                  <Toggle
                    checked={includeBrowser}
                    onChange={setIncludeBrowser}
                    disabled={processing}
                    label={t(
                      'このブラウザーの下書き・表示設定も含める',
                      'Include drafts and display settings from this browser',
                    )}
                    description={t(
                      '言語、選択中のルーム、通知設定などをコピーします。',
                      'Copy the language, selected room, notification settings, and other Loom preferences.',
                    )}
                  />
                </>
              )}
            </div>
          )}
          {statusText && (
            <div className="transfer-status" role="status" aria-live="polite">
              <p>{statusText}</p>
              {job?.status === 'uploading' && job.totalBytes !== undefined && (
                <>
                  <progress
                    max={job.totalBytes || 1}
                    value={job.uploadedBytes ?? 0}
                    aria-label={t('ファイル送信の進捗', 'File upload progress')}
                  />
                  <span>
                    {formatBytes(job.uploadedBytes ?? 0)} / {formatBytes(job.totalBytes)}
                  </span>
                </>
              )}
            </div>
          )}
          {error && (
            <p className="transfer-error" role="alert">
              {error}
            </p>
          )}
          {exportReady && (
            <div className="transfer-result">
              <h3>{t('移行ファイルを作成しました', 'Your transfer file is ready')}</h3>
              {job.summary && <TransferSummary summary={job.summary} />}
              <a
                className="button button-primary"
                href={dataTransferApi.downloadUrl(job.id)}
                download
              >
                <ArrowDownToLine size={16} />
                {t('暗号化ファイルをダウンロード', 'Download encrypted file')}
              </a>
              <p>
                {t(
                  'コピー先のLoomで「別のLoomから取り込む」を開き、このファイルとパスワードを指定してください。',
                  'On the destination Loom, choose “Import from another Loom” and provide this file and its password.',
                )}
              </p>
            </div>
          )}
          {preview && (
            <div className="transfer-result">
              <h3>{t('取り込む内容を確認してください', 'Review the incoming data')}</h3>
              <TransferSummary summary={preview} currentCounts={preview.currentCounts} />
              <p className="transfer-notice">
                {t(
                  '現在のLoomのデータを退避してから、この内容に置き換えます。取り込んだ自動実行はすべて停止した状態になります。',
                  'Current Loom data will be backed up, then replaced with this content. All imported automations will be disabled.',
                )}
                {preview.disabledAutomations > 0 && (
                  <> ({preview.disabledAutomations.toLocaleString()})</>
                )}
              </p>
              {preview.browserState && (
                <Toggle
                  checked={restoreBrowser}
                  onChange={setRestoreBrowser}
                  disabled={processing}
                  label={t(
                    'このブラウザーの下書き・表示設定も取り込む',
                    'Import drafts and display settings into this browser',
                  )}
                />
              )}
              <Button
                type="button"
                variant="danger"
                icon={ArrowUpFromLine}
                disabled={blocked}
                busy={action === 'applying'}
                onClick={applyImport}
              >
                {t('退避して置き換える', 'Back up and replace')}
              </Button>
            </div>
          )}
          {completed && (
            <div className="transfer-result">
              <h3>{t('取り込みが完了しました', 'Import complete')}</h3>
              <p>
                {t(
                  '元のデータを退避して、コピーした内容に置き換えました。自動実行は停止しています。',
                  'The previous data was backed up and replaced with the copied content. Automations are disabled.',
                )}
              </p>
              {job.backupPath && (
                <div className="transfer-backup">
                  <strong>{t('元のデータの退避先', 'Previous data backup')}</strong>
                  <code>{job.backupPath}</code>
                </div>
              )}
              {job.preview?.browserState && (
                <Toggle
                  checked={restoreBrowser}
                  onChange={setRestoreBrowser}
                  label={t(
                    'このブラウザーの下書き・表示設定も取り込む',
                    'Import drafts and display settings into this browser',
                  )}
                />
              )}
              <Button type="button" variant="primary" icon={RotateCcw} onClick={reopenLoom}>
                {t('Loomを開き直す', 'Open Loom again')}
              </Button>
            </div>
          )}
          {(mode === 'import' || completed) && (
            <p className="transfer-description">
              {t(
                '移行先ではローカルモデルの接続先を見直してください。ブラウザーで使うサービスには再ログインが必要です。コピー元のLoomとそのデータは残ります。',
                'Review local model connections on the destination. Sign in again to services used through the browser. The source Loom and its data remain available.',
              )}
            </p>
          )}
          <div className="transfer-actions">
            {!completed && !exportReady && !preview && (
              <Button
                type="button"
                variant="primary"
                icon={mode === 'export' ? ArrowDownToLine : ArrowUpFromLine}
                disabled={blocked}
                busy={action === 'exporting' || action === 'importing'}
                onClick={mode === 'export' ? startExport : inspectImport}
              >
                {mode === 'export'
                  ? t('暗号化ファイルを作成', 'Create encrypted file')
                  : t('内容を確認', 'Inspect file')}
              </Button>
            )}
            {preview && (
              <Button type="button" variant="ghost" disabled={blocked} onClick={inspectImport}>
                {t('内容を再確認', 'Inspect again')}
              </Button>
            )}
            {(job || pendingCleanup.current) && !processing && (
              <Button
                type="button"
                variant="ghost"
                onClick={() => {
                  setPassword('');
                  setConfirmation('');
                  setFile(null);
                  if (fileInput.current) fileInput.current.value = '';
                  void run('discarding', async (signal) => {
                    await discard(signal);
                    await loadStatus(signal);
                  });
                }}
              >
                {completed
                  ? t('この結果を閉じる', 'Dismiss this result')
                  : t('一時ファイルを破棄', 'Discard temporary file')}
              </Button>
            )}
            {(needsStatus || !info || (info.busy && !job)) && (
              <Button
                type="button"
                icon={RotateCcw}
                variant="ghost"
                disabled={!!action}
                onClick={refreshStatus}
              >
                {t('状況を再確認', 'Check status again')}
              </Button>
            )}
            {needsLogin && (
              <Button type="button" variant="secondary" onClick={reopenLoom}>
                {t('ログインし直す', 'Sign in again')}
              </Button>
            )}
          </div>
        </div>
      )}
    </section>
  );
}
