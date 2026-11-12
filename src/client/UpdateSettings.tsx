import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { ArrowDownToLine, Check, ExternalLink, LoaderCircle, RefreshCw } from 'lucide-react';
import {
  UPDATE_PROTOCOL,
  isActiveUpdate,
  type UpdateInfo,
  type UpdateJob,
} from '../shared/updates';
import { api, ApiError } from './api';
import { Button, Modal } from './components';
import { useApp } from './context';

const RECEIPT_KEY = 'loom.updateRequest';
const CHECK_INTERVAL = 6 * 60 * 60_000;
const RETRY_INTERVAL = 15 * 60_000;
const commitPattern = /^[a-f0-9]{40}$/i;
const requestPattern = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;

interface PendingUpdate {
  id: string;
  commit: string;
}
interface UpdateIssue {
  kind: 'status' | 'check' | 'install' | 'auth';
  code?: string;
  message?: string;
}
interface UpdateState {
  info: UpdateInfo | null;
  pending?: PendingUpdate;
  checking: boolean;
  submitting: boolean;
  waiting: boolean;
  issue?: UpdateIssue;
}
interface UpdateContextValue extends UpdateState {
  needsReload: boolean;
  hasUnsavedChanges: boolean;
  registerUnsavedChanges: (owner: string, dirty: boolean) => void;
  check: () => Promise<void>;
  refreshStatus: () => Promise<void>;
  install: () => Promise<void>;
}
const UpdateContext = createContext<UpdateContextValue | null>(null);

function newRequestId() {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // Authenticated HTTP LAN installations still expose getRandomValues.
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function rememberRequest(receipt?: PendingUpdate) {
  try {
    if (receipt) window.sessionStorage.setItem(RECEIPT_KEY, JSON.stringify(receipt));
    else window.sessionStorage.removeItem(RECEIPT_KEY);
  } catch {
    // The running page still retains the receipt when browser storage is unavailable.
  }
}
function recoverRequest(): PendingUpdate | undefined {
  try {
    const value = JSON.parse(window.sessionStorage.getItem(RECEIPT_KEY) || 'null');
    if (value && requestPattern.test(value.id) && commitPattern.test(value.commit))
      return { id: value.id, commit: value.commit };
  } catch {
    /* A missing or damaged browser receipt never starts an update. */
  }
  return undefined;
}
function isUpdateJob(value: unknown): value is UpdateJob {
  if (!value || typeof value !== 'object') return false;
  const job = value as UpdateJob;
  return (
    typeof job.id === 'string' &&
    requestPattern.test(job.id) &&
    commitPattern.test(job.targetSha) &&
    typeof job.targetVersion === 'string' &&
    typeof job.startedAt === 'string' &&
    typeof job.updatedAt === 'string' &&
    [
      'preparing',
      'stopping',
      'installing',
      'building',
      'verifying',
      'succeeded',
      'failed',
    ].includes(job.phase)
  );
}
function isUpdateInfo(value: unknown): value is UpdateInfo {
  if (!value || typeof value !== 'object') return false;
  const info = value as UpdateInfo;
  return (
    typeof info.current?.version === 'string' &&
    typeof info.available === 'boolean' &&
    typeof info.installation?.canUpdate === 'boolean' &&
    ['managed-git', 'git', 'docker', 'development', 'standalone'].includes(
      info.installation.kind,
    ) &&
    (!info.job || isUpdateJob(info.job)) &&
    (!info.latest ||
      (typeof info.latest.version === 'string' &&
        commitPattern.test(info.latest.commit) &&
        ['passed', 'pending', 'failed', 'unknown'].includes(info.latest.checks) &&
        typeof info.latest.protocol === 'number'))
  );
}

function hasRunningVersionMismatch(info: UpdateInfo | null): boolean {
  return Boolean(
    info?.latest &&
    info.current.commit === info.latest.commit &&
    info.current.version !== info.latest.version,
  );
}

/** Update requests are shared by navigation and settings, independently of chat streaming. */
export function AppUpdateProvider({ children }: { children: ReactNode }) {
  const { data, connected } = useApp();
  const pageVersion = useRef(data.version);
  const pageCommit = useRef<string | undefined>(undefined);
  const loadedAt = useRef(Date.now());
  const [state, setState] = useState<UpdateState>(() => ({
    info: null,
    pending: recoverRequest(),
    checking: false,
    submitting: false,
    waiting: false,
  }));
  const current = useRef(state);
  const mounted = useRef(false);
  const revision = useRef(0);
  const requests = useRef(new Set<AbortController>());
  const reading = useRef<Promise<UpdateInfo | undefined> | null>(null);
  const lastCheck = useRef<number | undefined>(undefined);
  const previousConnection = useRef(connected);
  const dirtyOwners = useRef(new Set<string>());
  const [hasUnsavedChanges, setHasUnsavedChanges] = useState(false);
  const registerUnsavedChanges = useCallback((owner: string, dirty: boolean) => {
    if (dirty) dirtyOwners.current.add(owner);
    else dirtyOwners.current.delete(owner);
    setHasUnsavedChanges(dirtyOwners.current.size > 0);
  }, []);

  const publish = useCallback((change: (previous: UpdateState) => UpdateState) => {
    if (!mounted.current) return;
    current.current = change(current.current);
    setState(current.current);
  }, []);

  const read = useCallback(
    (mode: 'status' | 'check', force = false): Promise<UpdateInfo | undefined> => {
      if (reading.current) return reading.current;
      if (
        mode === 'check' &&
        (current.current.pending ||
          current.current.submitting ||
          isActiveUpdate(current.current.info?.job))
      )
        return Promise.resolve(undefined);
      const generation = revision.current;
      const controller = new AbortController();
      requests.current.add(controller);
      const timeout = setTimeout(() => controller.abort(), 30_000);
      if (mode === 'check') lastCheck.current = Date.now();
      publish((value) => ({ ...value, checking: true }));
      const operation = (async () => {
        try {
          const next = await api<unknown>(
            mode === 'status' ? '/updates' : '/updates/check',
            mode === 'status' ? 'GET' : 'POST',
            mode === 'status' ? undefined : { force },
            controller.signal,
          );
          if (!isUpdateInfo(next)) throw new Error('The server did not return update information.');
          if (!mounted.current || generation !== revision.current || controller.signal.aborted)
            return undefined;
          pageCommit.current ??= next.current.commit;
          const accepted = Boolean(
            current.current.pending &&
            current.current.pending.id === next.job?.id &&
            current.current.pending.commit === next.job?.targetSha,
          );
          if (accepted) rememberRequest();
          publish((value) => ({
            ...value,
            info:
              !next.job && isActiveUpdate(value.info?.job)
                ? { ...next, job: value.info!.job }
                : next,
            pending: accepted ? undefined : value.pending,
            waiting: false,
            issue:
              accepted ||
              mode === 'check' ||
              (value.issue?.kind !== 'install' && value.issue?.kind !== 'check')
                ? undefined
                : value.issue,
          }));
          return next;
        } catch (failure) {
          if (!mounted.current || generation !== revision.current) return undefined;
          const reconnecting = Boolean(
            current.current.pending ||
            current.current.submitting ||
            isActiveUpdate(current.current.info?.job),
          );
          // An initial status failure also needs a bounded discovery retry.
          if (mode === 'status' && !current.current.info && !reconnecting)
            lastCheck.current = Date.now();
          publish((value) => ({
            ...value,
            waiting: reconnecting,
            issue:
              failure instanceof ApiError && failure.status === 401
                ? { kind: 'auth' }
                : reconnecting
                  ? value.issue
                  : {
                      kind: mode,
                      code: failure instanceof ApiError ? failure.code : undefined,
                      message: failure instanceof ApiError ? failure.message : undefined,
                    },
          }));
          return undefined;
        } finally {
          clearTimeout(timeout);
          requests.current.delete(controller);
          if (generation === revision.current) {
            reading.current = null;
            publish((value) => ({ ...value, checking: false }));
          }
        }
      })();
      reading.current = operation;
      return operation;
    },
    [publish],
  );

  const checkWhenDue = useCallback(() => {
    if (
      document.visibilityState === 'hidden' ||
      current.current.pending ||
      current.current.submitting ||
      isActiveUpdate(current.current.info?.job)
    )
      return;
    const latest = current.current.info?.latest;
    const waitingForChecks =
      current.current.info?.available &&
      (latest?.checks === 'pending' || latest?.checks === 'unknown');
    const retry =
      current.current.issue || current.current.info?.checkError || waitingForChecks
        ? RETRY_INTERVAL
        : CHECK_INTERVAL;
    if (lastCheck.current !== undefined && Date.now() - lastCheck.current < retry) return;
    if (current.current.info) void read('check');
    else
      void read('status').then((next) => {
        if (next && mounted.current && document.visibilityState !== 'hidden') void read('check');
      });
  }, [read]);

  useEffect(() => {
    mounted.current = true;
    void read('status').then((next) => {
      if (next && mounted.current) checkWhenDue();
    });
    const refresh = () => {
      if (document.visibilityState === 'hidden') return;
      if (
        current.current.pending ||
        current.current.submitting ||
        isActiveUpdate(current.current.info?.job)
      )
        void read('status');
      else checkWhenDue();
    };
    // The timer only checks a local deadline. Idle pages do not poll status.
    const timer = setInterval(checkWhenDue, RETRY_INTERVAL);
    window.addEventListener('focus', refresh);
    window.addEventListener('online', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      mounted.current = false;
      revision.current++;
      for (const request of requests.current) request.abort();
      requests.current.clear();
      reading.current = null;
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
      window.removeEventListener('online', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  }, [read, checkWhenDue]);

  useEffect(() => {
    const reconnected = connected === true && previousConnection.current === false;
    previousConnection.current = connected;
    if (reconnected) void read('status');
  }, [connected, read]);

  const watching = Boolean(state.pending || state.submitting || isActiveUpdate(state.info?.job));
  useEffect(() => {
    if (!watching) return;
    const timer = setInterval(() => void read('status'), 2_000);
    return () => clearInterval(timer);
  }, [watching, read]);

  const install = useCallback(async () => {
    const value = current.current;
    const latest = value.info?.latest;
    if (
      dirtyOwners.current.size > 0 ||
      !value.info?.installation.canUpdate ||
      value.submitting ||
      isActiveUpdate(value.info.job) ||
      (!value.pending &&
        (hasRunningVersionMismatch(value.info) ||
          !value.info.available ||
          latest?.checks !== 'passed' ||
          latest.protocol !== UPDATE_PROTOCOL))
    )
      return;
    const pending = value.pending ?? { id: newRequestId(), commit: latest!.commit };
    revision.current++;
    for (const request of requests.current) request.abort();
    reading.current = null;
    rememberRequest(pending);
    publish((previous) => ({
      ...previous,
      pending,
      submitting: true,
      checking: false,
      waiting: false,
      issue: undefined,
    }));
    const controller = new AbortController();
    requests.current.add(controller);
    const timeout = setTimeout(() => controller.abort(), 45_000);
    try {
      const job = await api<unknown>(
        '/updates/install',
        'POST',
        { commit: pending.commit, requestId: pending.id },
        controller.signal,
      );
      if (!isUpdateJob(job) || job.id !== pending.id || job.targetSha !== pending.commit)
        throw new Error('The update receipt could not be verified.');
      if (!mounted.current || controller.signal.aborted) return;
      // A GET started while the POST was in flight may still contain no job.
      // Once acceptance is known, that older response cannot clear the receipt.
      revision.current++;
      for (const request of requests.current) if (request !== controller) request.abort();
      reading.current = null;
      rememberRequest();
      publish((previous) => ({
        ...previous,
        info: previous.info
          ? {
              ...previous.info,
              job: previous.info.job?.id === job.id ? previous.info.job : job,
            }
          : previous.info,
        pending: undefined,
        checking: false,
        waiting: false,
        issue: undefined,
      }));
    } catch (failure) {
      if (!mounted.current) return;
      const rejected = failure instanceof ApiError && failure.status >= 400 && failure.status < 500;
      if (rejected) rememberRequest();
      publish((previous) => ({
        ...previous,
        pending: rejected ? undefined : previous.pending,
        waiting: !rejected,
        issue:
          failure instanceof ApiError && failure.status === 401
            ? { kind: 'auth' }
            : rejected
              ? { kind: 'install', code: failure.code, message: failure.message }
              : undefined,
      }));
    } finally {
      clearTimeout(timeout);
      requests.current.delete(controller);
      publish((previous) => ({ ...previous, submitting: false }));
      if (mounted.current && current.current.pending) void read('status');
    }
  }, [publish, read]);

  const check = useCallback(async () => {
    await read('check', true);
  }, [read]);
  const refreshStatus = useCallback(async () => {
    await read('status');
  }, [read]);
  const job = state.info?.job;
  const needsReload = Boolean(
    job?.phase === 'succeeded' &&
    job.targetSha === state.info?.current.commit &&
    (pageCommit.current !== job.targetSha ||
      pageVersion.current !== state.info?.current.version ||
      Date.parse(job.startedAt) >= loadedAt.current),
  );
  const context = useMemo(
    () => ({
      ...state,
      needsReload,
      hasUnsavedChanges,
      registerUnsavedChanges,
      check,
      refreshStatus,
      install,
    }),
    [state, needsReload, hasUnsavedChanges, registerUnsavedChanges, check, refreshStatus, install],
  );
  return <UpdateContext.Provider value={context}>{children}</UpdateContext.Provider>;
}

/** A small action in the existing top bar; it never adds a row above the chat. */
export function UpdateNotice() {
  const updates = useContext(UpdateContext);
  const { t } = useApp();
  const [open, setOpen] = useState(false);
  if (!updates) return null;
  const { info, pending, needsReload } = updates;
  const working = Boolean(pending || updates.submitting || isActiveUpdate(info?.job));
  const available = Boolean(info?.available && !hasRunningVersionMismatch(info));
  const showNotice = working || needsReload || available;
  const label = working
    ? t('更新中', 'Updating')
    : needsReload
      ? t('更新完了', 'Update complete')
      : t('更新あり', 'Update available');
  const title = t('アプリの更新', 'App updates');
  const stateLabel = working ? 'updating' : needsReload ? 'complete' : 'available';
  return (
    <>
      {showNotice && (
        <button
          type="button"
          className="app-update-notice"
          data-update-state={stateLabel}
          aria-label={label ? `${title}: ${label}` : title}
          aria-haspopup="dialog"
          aria-expanded={open}
          title={label ? `${title}: ${label}` : title}
          onClick={() => {
            setOpen(true);
            void updates.refreshStatus();
          }}
        >
          {working ? (
            <LoaderCircle size={14} className="spin" aria-hidden="true" />
          ) : (
            <ArrowDownToLine size={14} aria-hidden="true" />
          )}
          <span>{title}</span>
          {label && <small>{label}</small>}
        </button>
      )}
      {/* A refresh may find no update. Keep an already-open dialog until the owner closes it. */}
      {open && (
        <Modal title={title} onClose={() => setOpen(false)} wide>
          <div className="app-update-dialog" data-app-update-dialog="">
            <UpdateSettings />
          </div>
        </Modal>
      )}
    </>
  );
}

export function UpdateSettings({ hasChanges = false }: { hasChanges?: boolean }) {
  const updates = useContext(UpdateContext);
  const { data, t, locale } = useApp();
  const instanceId = useId();
  const registerUnsavedChanges = updates?.registerUnsavedChanges;
  useLayoutEffect(() => {
    registerUnsavedChanges?.(instanceId, hasChanges);
    return () => registerUnsavedChanges?.(instanceId, false);
  }, [instanceId, hasChanges, registerUnsavedChanges]);
  if (!updates) return null;
  const unsavedChanges = hasChanges || updates.hasUnsavedChanges;
  const { info, pending, checking, submitting, waiting, issue, needsReload } = updates;
  const job = info?.job;
  const active = isActiveUpdate(job);
  const latest = info?.latest;
  const versionMismatch = hasRunningVersionMismatch(info);
  const ready = Boolean(
    info?.available &&
    !versionMismatch &&
    !info.checkError &&
    issue?.kind !== 'check' &&
    issue?.kind !== 'status' &&
    issue?.kind !== 'auth' &&
    latest?.checks === 'passed' &&
    latest.protocol === UPDATE_PROTOCOL,
  );
  const canInstall = Boolean(info?.installation.canUpdate && (ready || pending));
  const busyInstall = issue?.kind === 'install' && issue.code === 'update_busy';
  const errorDetail = busyInstall ? info?.checkError : issue?.message || info?.checkError;
  const phases: Record<UpdateJob['phase'], string> = {
    preparing: t('更新の準備をしています', 'Preparing the update'),
    stopping: t('Loomを停止しています', 'Stopping Loom'),
    installing: t('必要なファイルを取得しています', 'Getting the required files'),
    building: t('アプリを更新しています', 'Building the updated app'),
    verifying: t('起動を確認しています', 'Checking the updated app'),
    succeeded: t('更新が完了しました', 'Update complete'),
    failed: t('更新を完了できませんでした', 'The update did not complete'),
  };
  const kind = info?.installation.kind;
  const manualProtocol = Boolean(info?.available && latest?.protocol !== UPDATE_PROTOCOL);
  const manual = info && (!info.installation.canUpdate || manualProtocol);
  const checkedAt = info?.checkedAt ? new Date(info.checkedAt) : undefined;
  return (
    <section
      className="settings-section app-update-settings"
      id={`app-updates-${instanceId}`}
      aria-labelledby={`app-update-heading-${instanceId}`}
      tabIndex={-1}
    >
      <div className="settings-section-heading">
        <span>
          <RefreshCw size={20} aria-hidden="true" />
        </span>
        <div>
          <h2 id={`app-update-heading-${instanceId}`}>
            {t('Agent Loomの更新', 'Agent Loom updates')}
          </h2>
          <p>
            {t(
              '通常は6時間ごとに確認します。更新があるときは、どの画面でも上部に「アプリの更新」を表示します。',
              'Updates are normally checked every 6 hours. When an update is available, App updates appears in the top bar on every screen.',
            )}
          </p>
        </div>
      </div>
      <div className="settings-section-body">
        <dl className="app-update-versions">
          <div>
            <dt>{t('現在のバージョン', 'Current version')}</dt>
            <dd>
              v{info?.current.version || data.version}
              {info?.current.commit && (
                <code title={info.current.commit}>{info.current.commit.slice(0, 7)}</code>
              )}
            </dd>
          </div>
          {latest && (
            <div>
              <dt>{t('配布元のバージョン', 'Upstream version')}</dt>
              <dd>
                <a
                  href={`https://github.com/StackPiles/agent-loom/commit/${latest.commit}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  v{latest.version}
                  <code title={latest.commit}>{latest.commit.slice(0, 7)}</code>
                  <ExternalLink size={12} aria-hidden="true" />
                  <span className="visually-hidden">
                    {t('（GitHubで開く）', ' (open on GitHub)')}
                  </span>
                </a>
              </dd>
            </div>
          )}
        </dl>

        {!active && !pending && !submitting && (
          <p className="app-update-summary" role="status">
            {info?.checkError || issue?.kind === 'check' || issue?.kind === 'status'
              ? t('更新の確認ができませんでした。', 'Updates could not be checked.')
              : !latest
                ? checking
                  ? t('更新を確認しています…', 'Checking for updates…')
                  : t('更新はまだ確認されていません。', 'Updates have not been checked yet.')
                : versionMismatch
                  ? t(
                      'ソースのリビジョンは配布元と同じですが、実行中のバージョンが一致していません。',
                      'The source revision matches upstream, but the running version does not.',
                    )
                  : info?.available
                    ? latest.version === info.current.version
                      ? t(
                          '同じバージョンの新しい修正があります。',
                          'A new revision of this version is available.',
                        )
                      : t(
                          `v${latest.version}への更新があります。`,
                          `An update to v${latest.version} is available.`,
                        )
                    : latest.commit === info?.current.commit
                      ? t(
                          '配布元と同じバージョンです。',
                          'You are on the current upstream version.',
                        )
                      : !info?.current.commit && latest.version === info?.current.version
                        ? t(
                            '配布元と同じ版数です。この環境では、同じ版数の追加修正までは確認できません。',
                            'The version number matches upstream. This installation cannot identify additional revisions of the same version.',
                          )
                        : t(
                            '現在のバージョンに適用する更新はありません。',
                            'There is no applicable update for the current version.',
                          )}
          </p>
        )}
        {versionMismatch && !active && !pending && !submitting && (
          <p className="app-update-hint">
            {t(
              '修正版が公開されていないか更新を確認してください。修正済みのソースを取得した場合は、再ビルド・再起動してから画面を再読み込みしてください。',
              'Check for a corrective update. After obtaining corrected source, rebuild and restart Loom, then reload this page.',
            )}
          </p>
        )}
        {info?.available && latest?.checks !== 'passed' && (
          <p className="app-update-hint">
            {latest?.checks === 'failed'
              ? t(
                  'この更新の動作確認は成功していません。更新できる版の公開をお待ちください。',
                  'This update has not passed its checks. Wait for a verified update.',
                )
              : t(
                  '配布元での動作確認を待っています。確認が完了すると更新できます。',
                  'Waiting for the upstream checks. You can update once they pass.',
                )}
          </p>
        )}
        {info?.available && latest?.protocol !== UPDATE_PROTOCOL && (
          <p className="app-update-hint">
            {t(
              'この版はWeb画面からの更新に対応していません。手動で更新してください。',
              'This version does not support updating from the web app. Update manually.',
            )}
          </p>
        )}

        {(active ||
          pending ||
          submitting ||
          job?.phase === 'succeeded' ||
          job?.phase === 'failed') && (
          <div
            className={`app-update-result${job?.phase === 'failed' && !pending ? ' is-error' : ''}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <strong>
              {active || pending || submitting ? (
                <LoaderCircle size={16} className="spin" aria-hidden="true" />
              ) : job?.phase === 'succeeded' ? (
                <Check size={16} aria-hidden="true" />
              ) : null}
              {pending
                ? submitting
                  ? t('更新を開始しています', 'Requesting the update')
                  : t('更新要求の結果を確認しています', 'Confirming the update request')
                : job
                  ? phases[job.phase]
                  : t('更新を開始しています', 'Requesting the update')}
            </strong>
            {waiting && (
              <p>
                {t(
                  'Loomとの再接続を待っています。接続が戻ると結果を表示します。',
                  'Waiting to reconnect to Loom. The result will appear when the connection returns.',
                )}
              </p>
            )}
            {active && !waiting && (
              <p>
                {t(
                  '更新中はLoomに接続できない時間があります。この画面で結果を確認できます。',
                  'Loom will be briefly unavailable during the update. You can check the result here.',
                )}
              </p>
            )}
            {pending && !submitting && !waiting && (
              <p>
                {t(
                  'この更新要求の記録をまだ確認できません。「状況を再確認」から確認できます。再試行しても同じ更新を重複して開始しません。',
                  'The request receipt is not available yet. Check its status, or retry the same request without starting a duplicate update.',
                )}
              </p>
            )}
            {job?.phase === 'failed' && !pending && (
              <>
                {job.rolledBack && (
                  <p>
                    {t(
                      '更新前のバージョンで起動し直しました。',
                      'Loom restarted on the previous version.',
                    )}
                  </p>
                )}
                {job.error && <p className="app-update-error-detail">{job.error}</p>}
              </>
            )}
            {job?.phase === 'succeeded' && !pending && (
              <p>
                {needsReload
                  ? t(
                      'サーバーの更新は完了しました。画面を再読み込みすると新しい表示を使えます。',
                      'The server is updated. Reload this page to use the updated interface.',
                    )
                  : t(
                      'この画面も更新後のバージョンです。',
                      'This page is also using the updated version.',
                    )}
              </p>
            )}
          </div>
        )}

        {(info?.checkError || issue) && (
          <div className="app-update-error" role="alert">
            <p>
              {issue?.kind === 'auth'
                ? t(
                    '更新の状況を確認するには、Loomへログインし直してください。',
                    'Sign in to Loom again to check the update status.',
                  )
                : busyInstall
                  ? t(
                      '生成・ツール実行やメール送信、データ転送などの処理が続いています。処理が完了し、作業中のボットが完了または完全に休止してから、もう一度更新してください。',
                      'Generation, tools, mail sending, data transfers or other work are still in progress. Wait for these operations to finish and for bots to finish or fully pause, then try updating again.',
                    )
                  : issue?.kind === 'install'
                    ? t(
                        '更新を開始できませんでした。実行中の作業や起動状態を確認してください。',
                        'The update could not start. Check active work and how Loom was started.',
                      )
                    : t(
                        '接続を確認してから、もう一度確認してください。',
                        'Check your connection, then try checking again.',
                      )}
            </p>
            {errorDetail && <p className="app-update-error-detail">{errorDetail}</p>}
          </div>
        )}
        {manual && (
          <div className="app-update-manual">
            <p>
              {kind === 'docker'
                ? t(
                    'Dockerで起動しています。ホスト側で更新し、コンテナーを作り直してください。',
                    'Loom is running in Docker. Update it on the host and recreate the container.',
                  )
                : kind === 'development'
                  ? t(
                      '開発モードではWeb更新を使えません。本番用にビルドして npm start で起動してください。',
                      'Web updates are unavailable in development mode. Build the app and run npm start.',
                    )
                  : kind === 'git'
                    ? t(
                        '最初の1回は手動で更新し、npm start で起動してください。以後、対応する更新はこの画面から行えます。',
                        'Update manually once and launch with npm start. Supported future updates can then run from this screen.',
                      )
                    : manualProtocol && info.installation.canUpdate
                      ? t(
                          'この版は手動更新が必要です。プロジェクトのフォルダーで更新してください。',
                          'This version requires a manual update from the project folder.',
                        )
                      : kind === 'managed-git'
                        ? t(
                            'この作業コピーは、現在Web更新の条件を満たしていません。下の理由を確認してください。',
                            'This checkout is not currently eligible for a web update. Check the reason below.',
                          )
                        : t(
                            'この起動方法はWeb更新に対応していません。導入元の手順で更新してください。',
                            'This installation does not support web updates. Follow its installation instructions to update.',
                          )}
            </p>
            {info.installation.reason && (
              <p className="app-update-error-detail">{info.installation.reason}</p>
            )}
            {(kind !== 'managed-git' || (manualProtocol && info.installation.canUpdate)) &&
              kind !== 'standalone' && (
                <details>
                  <summary>{t('手動更新のコマンド', 'Manual update commands')}</summary>
                  <p>
                    {t(
                      '起動中のLoomを止め、プロジェクトのフォルダーで実行します。',
                      'Stop Loom, then run these commands in the project folder.',
                    )}
                  </p>
                  <pre>
                    <code>
                      {kind === 'docker'
                        ? 'git pull --ff-only\ndocker compose up --build -d'
                        : 'git pull --ff-only\nnpm ci\nnpm run build\nnpm start'}
                    </code>
                  </pre>
                </details>
              )}
          </div>
        )}
        {unsavedChanges && (info?.available || pending || needsReload) && (
          <p className="app-update-hint">
            {t(
              '未保存の設定があります。変更を保存してから更新・再読み込みしてください。',
              'Save your settings changes before updating or reloading.',
            )}
          </p>
        )}
        <div className="app-update-actions">
          {active || pending || submitting ? (
            <Button
              type="button"
              icon={RefreshCw}
              busy={checking}
              onClick={() => void updates.refreshStatus()}
            >
              {t('状況を再確認', 'Check status')}
            </Button>
          ) : (
            <Button
              type="button"
              icon={RefreshCw}
              busy={checking}
              onClick={() => void updates.check()}
            >
              {t('更新を確認', 'Check for updates')}
            </Button>
          )}
          {(info?.available || pending) && !active && !needsReload && (
            <Button
              type="button"
              variant="primary"
              icon={ArrowDownToLine}
              busy={submitting}
              disabled={unsavedChanges || !canInstall || checking || (Boolean(pending) && waiting)}
              onClick={() => {
                if (!unsavedChanges) void updates.install();
              }}
            >
              {pending
                ? t('同じ要求で再試行', 'Retry the same request')
                : t('更新して再起動', 'Update and restart')}
            </Button>
          )}
          {needsReload && (
            <Button
              type="button"
              variant="primary"
              icon={RefreshCw}
              disabled={unsavedChanges}
              onClick={() => {
                if (!unsavedChanges) window.location.reload();
              }}
            >
              {t('画面を再読み込み', 'Reload page')}
            </Button>
          )}
        </div>
        {info?.installation.canUpdate && !active && !pending && (
          <p className="app-update-hint">
            {t(
              '更新はボタンを押したときだけ行います。実行中の生成・ツール・メール送信・データ転送は完了を待ちます。完全に休止したタスクは更新後も休止を保ち、ルームの再開後に保存済みの履歴から続きを進めます。承認待ちの操作は再確認が必要です。',
              'Updates run only when you choose to install them. Active generation, tools, mail sending and data transfers must finish first. Fully paused tasks remain paused after updating and recover from saved history when you resume the room. Pending approvals must be reviewed again.',
            )}
          </p>
        )}
        {checkedAt && !Number.isNaN(checkedAt.getTime()) && (
          <p className="app-update-checked">
            {t('最終確認', 'Last checked')}:{' '}
            {checkedAt.toLocaleString(locale === 'ja' ? 'ja-JP' : 'en-US')}
          </p>
        )}
      </div>
    </section>
  );
}
