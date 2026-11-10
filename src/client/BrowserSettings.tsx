import { useEffect, useRef, useState } from 'react';
import { Chrome, Copy, Link2, RefreshCw, Unplug } from 'lucide-react';
import type {
  BrowserSettings as BrowserSettingsValue,
  BrowserStatus,
  Permission,
} from '../shared/types';
import {
  BROWSER_UPLOAD_SETTING_LIMITS,
  browserUploadSettings,
  browserUploadSettingsError,
  type BrowserUploadSettings,
} from '../shared/browser';
import { api } from './api';
import { useApp } from './context';
import { Button, Field, Toggle } from './components';

const debuggingUrl = 'chrome://inspect/#remote-debugging';
const uploadFields: Array<{
  key: keyof BrowserUploadSettings;
  label: [string, string];
}> = [
  { key: 'uploadMaxFiles', label: ['1回に送るファイル数の上限', 'Maximum files per upload'] },
  { key: 'uploadMaxFileMiB', label: ['1ファイルの上限（MiB）', 'Maximum file size (MiB)'] },
  {
    key: 'uploadMaxTotalMiB',
    label: ['1回に送る合計の上限（MiB）', 'Maximum total per upload (MiB)'],
  },
  {
    key: 'uploadStorageMiB',
    label: ['一時保存容量の上限（MiB）', 'Temporary upload storage (MiB)'],
  },
];

export function BrowserSettings({
  value,
  onChange,
  onSave,
  disabled = false,
  hasActiveTasks = false,
  imageInputEnabled = false,
}: {
  value: BrowserSettingsValue;
  onChange: (patch: Partial<BrowserSettingsValue>) => void;
  onSave: (value: BrowserSettingsValue) => Promise<void>;
  disabled?: boolean;
  hasActiveTasks?: boolean;
  imageInputEnabled?: boolean;
}) {
  const { t, toast } = useApp();
  const [status, setStatus] = useState<BrowserStatus>({
    state: 'disconnected',
    mode: value.mode,
    platform: '',
    busy: false,
    tabs: [],
  });
  const [connecting, setConnecting] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const errorSource = useRef<'status' | 'action' | null>(null);
  const mounted = useRef(false);
  const lifetime = useRef(0);
  const intent = useRef(0);
  const reading = useRef<AbortSignal | null>(null);
  const connectLock = useRef(false);
  const disconnectLock = useRef(false);
  const connectRequest = useRef<AbortController | null>(null);
  const requests = useRef(new Set<AbortController>());
  const live = status.state === 'connected' || status.state === 'connecting' || connecting;
  const modeLocked = disabled || hasActiveTasks || live || disconnecting;
  const uploadSettings = browserUploadSettings(value);
  const uploadError = browserUploadSettingsError(value);
  const uploadErrorMessage = uploadError
    ? t(
        '各上限を表示範囲内の整数で指定し、1ファイルの容量 ≤ 1回の合計容量 ≤ 一時保存容量にしてください。',
        'Use whole numbers within the displayed ranges, with file size ≤ total per upload ≤ temporary storage.',
      )
    : '';

  useEffect(() => {
    mounted.current = true;
    lifetime.current++;
    return () => {
      mounted.current = false;
      lifetime.current++;
      intent.current++;
      for (const request of requests.current) request.abort();
      requests.current.clear();
    };
  }, []);

  async function readStatus(signal?: AbortSignal): Promise<BrowserStatus | undefined> {
    if (reading.current && !reading.current.aborted) return;
    const owner = lifetime.current;
    const action = intent.current;
    const controller = new AbortController();
    requests.current.add(controller);
    const requestSignal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(30_000),
      ...(signal ? [signal] : []),
    ]);
    reading.current = requestSignal;
    if (mounted.current) setRefreshing(true);
    try {
      const next = await api<BrowserStatus>('/browser', 'GET', undefined, requestSignal);
      if (
        mounted.current &&
        owner === lifetime.current &&
        action === intent.current &&
        !signal?.aborted
      ) {
        setStatus(next);
        if (errorSource.current === 'status' || next.state === 'connected') {
          setError('');
          errorSource.current = null;
        }
        return next;
      }
    } catch (cause) {
      if (
        mounted.current &&
        owner === lifetime.current &&
        action === intent.current &&
        !signal?.aborted
      )
        if (errorSource.current !== 'action') {
          errorSource.current = 'status';
          setError((cause as Error).message);
        }
    } finally {
      requests.current.delete(controller);
      if (reading.current === requestSignal) {
        reading.current = null;
        if (mounted.current && owner === lifetime.current) setRefreshing(false);
      }
    }
  }

  useEffect(() => {
    if (!value.enabled && !live) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      const next = await readStatus(controller.signal);
      if (
        !controller.signal.aborted &&
        (value.enabled || live || next?.state === 'connected' || next?.state === 'connecting')
      )
        timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [value.enabled, live]);

  async function connect() {
    if (
      connectLock.current ||
      disconnectLock.current ||
      !value.enabled ||
      value.permission === 'deny' ||
      uploadError ||
      disabled
    )
      return;
    const owner = lifetime.current;
    const action = ++intent.current;
    const selected = structuredClone(value);
    const controller = new AbortController();
    requests.current.add(controller);
    connectRequest.current = controller;
    connectLock.current = true;
    setConnecting(true);
    setError('');
    errorSource.current = null;
    try {
      await onSave(selected);
      if (!mounted.current || owner !== lifetime.current || action !== intent.current) return;
      setStatus((previous) => ({
        ...previous,
        state: 'connecting',
        mode: selected.mode,
        error: undefined,
      }));
      const next = await api<BrowserStatus>(
        '/browser/connect',
        'POST',
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(130_000)]),
      );
      if (mounted.current && owner === lifetime.current && action === intent.current) {
        intent.current++;
        setStatus(next);
      }
    } catch (cause) {
      if (mounted.current && owner === lifetime.current && action === intent.current) {
        intent.current++;
        errorSource.current = 'action';
        setError((cause as Error).message);
        setStatus((previous) => ({ ...previous, state: 'error', busy: false }));
      }
    } finally {
      requests.current.delete(controller);
      if (connectRequest.current === controller) connectRequest.current = null;
      connectLock.current = false;
      if (mounted.current && owner === lifetime.current) setConnecting(false);
    }
  }

  async function disconnect() {
    if (disconnectLock.current || disabled) return;
    const owner = lifetime.current;
    const action = ++intent.current;
    connectRequest.current?.abort();
    disconnectLock.current = true;
    setDisconnecting(true);
    setError('');
    errorSource.current = null;
    const controller = new AbortController();
    requests.current.add(controller);
    try {
      const next = await api<BrowserStatus>(
        '/browser/connect',
        'DELETE',
        undefined,
        AbortSignal.any([controller.signal, AbortSignal.timeout(30_000)]),
      );
      if (mounted.current && owner === lifetime.current && action === intent.current) {
        intent.current++;
        setStatus(next);
        setConnecting(false);
      }
    } catch (cause) {
      if (mounted.current && owner === lifetime.current && action === intent.current) {
        errorSource.current = 'action';
        setError((cause as Error).message);
      }
    } finally {
      requests.current.delete(controller);
      disconnectLock.current = false;
      if (mounted.current && owner === lifetime.current) setDisconnecting(false);
    }
  }

  return (
    <section className="settings-section chrome-settings" id="browser-settings">
      <div className="settings-section-heading">
        <span>
          <Chrome size={20} />
        </span>
        <div>
          <h2>{t('Chrome操作', 'Chrome control')}</h2>
          <p>
            {t(
              'ボットがページを読み取り、クリックや入力を行います。',
              'Let bots read pages, click, and fill in fields.',
            )}
          </p>
        </div>
      </div>
      <div className="settings-section-body">
        <Toggle
          label={t('Chrome操作を有効にする', 'Enable Chrome control')}
          description={t(
            'Chrome DevTools MCPを内蔵しています。追加のモデル設定は不要です。',
            'Powered by bundled Chrome DevTools MCP. Uses your configured language model.',
          )}
          checked={value.enabled}
          onChange={(enabled) => onChange({ enabled })}
          disabled={disabled || disconnecting}
        />
        {value.enabled && (
          <div className="chrome-settings-fields">
            <p className="field-hint chrome-server-note">
              {t(
                '操作するのはLoomサーバーを動かしているマシンのChromeです。Dockerや別マシンでLoomを動かしている場合、閲覧中のPCのChromeには接続できません。',
                'Controls Chrome on the machine running the Loom server. A server in Docker or on another machine cannot access the Chrome on this viewing computer.',
              )}
            </p>
            <Field
              label={t('同時に開くChromeの上限', 'Maximum open browsers')}
              hint={t(
                'ボット専用と共通Chromeの合計です。上限時は未使用のChromeを閉じて切り替えます。ブラウザを使用するタスクと承認待ちが終わるまでは閉じず、空きが出るまで待機します。ログイン状態は保持されます。',
                'Includes bot browsers and the shared browser. At capacity, idle browsers close to make room. Tasks that use a browser keep it through completion, including pending approvals. Profiles retain sign-in state.',
              )}
            >
              <input
                aria-label={t('同時に開くChromeの上限', 'Maximum open browsers')}
                type="number"
                min={1}
                max={16}
                required
                value={value.maxConcurrentBrowsers ?? 3}
                disabled={disabled}
                onChange={(event) =>
                  onChange({ maxConcurrentBrowsers: Number(event.target.value) })
                }
              />
            </Field>
            <h3>{t('ファイルのアップロード', 'File uploads')}</h3>
            <div className="form-grid">
              {uploadFields.map(({ key, label }) => {
                const { min, max } = BROWSER_UPLOAD_SETTING_LIMITS[key];
                return (
                  <Field key={key} label={t(...label)} hint={`${min}–${max}`}>
                    <input
                      ref={(element) => {
                        element?.setCustomValidity(uploadErrorMessage);
                      }}
                      aria-label={t(...label)}
                      aria-invalid={!!uploadError || undefined}
                      aria-describedby={uploadError ? 'browser-upload-settings-error' : undefined}
                      type="number"
                      min={min}
                      max={max}
                      step={1}
                      required
                      value={uploadSettings[key]}
                      disabled={disabled}
                      onChange={(event) => onChange({ [key]: Number(event.target.value) })}
                    />
                  </Field>
                );
              })}
            </div>
            {uploadError && (
              <p className="form-error" role="alert" id="browser-upload-settings-error">
                {uploadErrorMessage}
              </p>
            )}
            <p className="field-hint">
              {t(
                'Loomは送信する各ファイルの一時コピーを1つ作成し、Chromeの終了を確認してから削除します。一時保存容量には、まだ保持中のコピーも含まれます。承認待ちのファイルはメモリにも保持するため、上限を高くするとRAM使用量も増えます。保存した上限は、承認待ちのものを含め、送信時に再確認します。1 MiB = 1,048,576バイト。',
                'Loom creates one temporary copy of each file and removes it once Chrome has exited. The storage budget includes copies still retained. Files awaiting approval also stay in memory, so higher limits increase RAM usage. Saved limits are checked again when files are sent, including uploads waiting for approval. 1 MiB = 1,048,576 bytes.',
              )}
            </p>
            <p className="field-hint chrome-server-note">
              {t(
                '各ボットの設定で専用Chrome・共通Chrome・使用しないを選べます。以下は「共通Chrome」の接続設定です。',
                'Choose a dedicated browser, the shared browser, or disabled in each bot’s settings. The connection below is the shared browser.',
              )}
            </p>
            <Field label={t('接続方法', 'Chrome connection mode')}>
              <select
                aria-label={t('接続方法', 'Chrome connection mode')}
                value={value.mode}
                disabled={modeLocked}
                onChange={(event) => {
                  setError('');
                  onChange({ mode: event.target.value as BrowserSettingsValue['mode'] });
                }}
              >
                <option value="existing">
                  {t('起動中のChromeに接続', 'Connect to existing Chrome')}
                </option>
                <option value="dedicated">
                  {t('Loom専用のChromeを開く', 'Open dedicated Chrome')}
                </option>
              </select>
            </Field>
            {value.mode === 'existing' ? (
              <div className="chrome-setup-note">
                <strong>{t('Chrome側で接続を許可', 'Allow the connection in Chrome')}</strong>
                <p>
                  {t(
                    'Chrome 144以降で次のページを開き、リモートデバッグを有効にします。「保存して接続」の後、Chromeの確認画面で許可してください。',
                    'In Chrome 144 or later, open the address below and enable remote debugging. After Save and connect, allow the connection in Chrome’s confirmation dialog.',
                  )}
                </p>
                <div className="chrome-debug-address">
                  <code>{debuggingUrl}</code>
                  <button
                    type="button"
                    className="text-button"
                    onClick={async () => {
                      try {
                        await navigator.clipboard.writeText(debuggingUrl);
                        toast(t('アドレスをコピーしました', 'Address copied'));
                      } catch {
                        toast(
                          t(
                            'コピーできませんでした。表示されているアドレスを選択してコピーしてください。',
                            'Copy failed. Select and copy the address shown here.',
                          ),
                          'error',
                        );
                      }
                    }}
                  >
                    <Copy size={13} />
                    {t('コピー', 'Copy address')}
                  </button>
                </div>
                <small>
                  {t(
                    'Chromeが選ぶ既定プロファイルの、開いているウィンドウとタブが対象です。',
                    'Connects to the open windows and tabs of the default profile selected by Chrome.',
                  )}
                </small>
              </div>
            ) : (
              <div className="chrome-setup-note">
                <strong>{t('専用プロファイルを使用', 'Uses a dedicated profile')}</strong>
                <p>
                  {t(
                    'インストール済みのChromeを、Loom専用のプロファイルで開きます。普段のChromeとはログイン状態が別になり、この専用ウィンドウでログインできます。',
                    'Opens installed Chrome with a persistent Loom profile. Sign-in is separate from your usual Chrome; log in within this dedicated window.',
                  )}
                </p>
              </div>
            )}
            <Field label={t('ブラウザー操作の権限', 'Browser permission')}>
              <select
                aria-label={t('ブラウザー操作の権限', 'Browser permission')}
                value={value.permission}
                disabled={disabled}
                onChange={(event) => onChange({ permission: event.target.value as Permission })}
              >
                <option value="auto">
                  {t(
                    '自動判定：読み取りは許可、操作は確認',
                    'Auto: allow reading, ask before actions',
                  )}
                </option>
                <option value="ask">{t('毎回確認', 'Ask every time')}</option>
                <option value="allow">{t('許可', 'Allow')}</option>
                <option value="deny">{t('拒否', 'Deny')}</option>
              </select>
            </Field>
            <p className="field-hint chrome-permission-note">
              {t(
                '自動判定ではタブ一覧・ページ内容・スクリーンショットを読み取れます。クリック、入力、ページ移動などは対象と引数を承認カードで確認します。',
                'Auto permits tab lists, page snapshots, and screenshots. Clicks, filling, navigation, and other actions show their target and arguments in an approval card.',
              )}
            </p>
            <Toggle
              label={t(
                '撮影時にスクリーンショットをLLMに渡す',
                'Send screenshots to the model when captured',
              )}
              description={t(
                '画像入力がオンの場合、撮影した画像をその場でLLMへ渡します。オフでも画像はチャットに表示されます。画像入力がオンなら、Botが必要に応じて後から画像を確認できます。',
                'With model image input on, include each screenshot when captured. When off, screenshots remain in chat; bots can still inspect saved images as needed if model image input is enabled.',
              )}
              checked={value.includeScreenshotsInModel}
              onChange={(includeScreenshotsInModel) => onChange({ includeScreenshotsInModel })}
              disabled={disabled || hasActiveTasks || connecting || status.state === 'connecting'}
            />
            {value.includeScreenshotsInModel && !imageInputEnabled && (
              <p className="field-hint" role="status">
                {t(
                  'スクリーンショットを渡すには、モデル接続の画像入力を有効にしてください。',
                  'Enable image input in Model connection to send screenshots to the model.',
                )}{' '}
                <a href="#model-image-input">{t('画像入力の設定へ', 'Image input settings')}</a>
              </p>
            )}
            {hasActiveTasks && (
              <p className="field-hint">
                {t(
                  '接続方法と画像入力を変更するには、実行中の作業を停止してください。',
                  'Stop active tasks before changing connection mode or model image input.',
                )}
              </p>
            )}
            {live && (
              <p className="field-hint">
                {t(
                  '接続方法を変更するには、先に切断してください。',
                  'Disconnect before changing the connection mode.',
                )}
              </p>
            )}
          </div>
        )}
        {(value.enabled || live || disconnecting) && (
          <div className="chrome-connection">
            <div className="chrome-connection-heading">
              <span
                className={'chrome-connection-state chrome-state-' + status.state}
                role="status"
              >
                <i aria-hidden="true" />
                {status.waiting
                  ? t('起動枠の空きを待機中', 'Waiting for browser capacity')
                  : connecting || status.state === 'connecting'
                    ? t('接続中…', 'Connecting…')
                    : status.state === 'connected'
                      ? t('接続済み', 'Connected')
                      : status.state === 'error'
                        ? t('接続エラー', 'Connection error')
                        : t('未接続', 'Disconnected')}
                {status.busy && status.state === 'connected' && (
                  <small>{t('使用中', 'In use')}</small>
                )}
              </span>
              <button
                type="button"
                className="text-button"
                disabled={refreshing || disabled}
                onClick={() => void readStatus()}
              >
                <RefreshCw size={13} className={refreshing ? 'spin' : ''} />
                {t('状態を更新', 'Refresh status')}
              </button>
            </div>
            {status.pool && (
              <p className="field-hint">
                {t(
                  `全Chrome：${status.pool.active} / ${status.pool.limit} 起動枠・${status.pool.waiting} 件待機`,
                  `All browsers: ${status.pool.active} / ${status.pool.limit} slots · ${status.pool.waiting} waiting`,
                )}
              </p>
            )}
            <div className="chrome-connection-actions">
              <Button
                type="button"
                icon={Link2}
                busy={connecting}
                disabled={
                  disabled ||
                  !value.enabled ||
                  value.permission === 'deny' ||
                  !!uploadError ||
                  status.state === 'connected' ||
                  disconnecting
                }
                onClick={() => void connect()}
              >
                {t('保存して接続', 'Save and connect')}
              </Button>
              {(live || status.state === 'error') && (
                <Button
                  type="button"
                  icon={Unplug}
                  busy={disconnecting}
                  disabled={disabled}
                  onClick={() => void disconnect()}
                >
                  {t('切断', 'Disconnect')}
                </Button>
              )}
            </div>
            {value.permission === 'deny' && (
              <p className="field-hint">
                {t(
                  '接続するにはブラウザー操作の権限を変更してください。',
                  'Change the browser permission to connect.',
                )}
              </p>
            )}
            {(error || status.error) && (
              <div className="form-error chrome-connection-error" role="alert">
                {error || status.error}
              </div>
            )}
            {status.tabs.length > 0 && status.state === 'connected' && (
              <div className="chrome-tab-summary">
                <strong>
                  {t(
                    `最後に確認したタブ · ${status.tabs.length}`,
                    `Last observed tabs · ${status.tabs.length}`,
                  )}
                </strong>
                <ul>
                  {status.tabs.slice(0, 3).map((tab) => (
                    <li key={tab.pageId}>
                      <span className="chrome-tab-id">#{tab.pageId}</span>
                      <div>
                        <span title={tab.title || tab.url}>{tab.title || tab.url}</span>
                        <small title={tab.url}>{tab.url}</small>
                      </div>
                      {tab.protected && (
                        <small className="chrome-protected-label">
                          {t('操作対象外', 'Protected')}
                        </small>
                      )}
                    </li>
                  ))}
                </ul>
                {status.tabs.length > 3 && (
                  <small>
                    {t(`ほか ${status.tabs.length - 3} 件`, `${status.tabs.length - 3} more`)}
                  </small>
                )}
              </div>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
