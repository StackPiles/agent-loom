import { useEffect, useRef, useState } from 'react';
import { Chrome, RefreshCw, Unplug } from 'lucide-react';
import type { Bot, BotBrowserSettings as Value, BrowserStatus } from '../shared/types';
import { botBrowserMode, DEFAULT_BROWSER_SETTINGS } from '../shared/browser';
import { api } from './api';
import { activeStatuses, useApp } from './context';
import { Button, Field } from './components';

export function BotBrowserSettings({
  bot,
  mode,
  onChange,
  disabled = false,
}: {
  bot?: Bot;
  mode: Value['mode'];
  onChange: (mode: Value['mode']) => void;
  disabled?: boolean;
}) {
  const { data, t, mutate, roomId: currentRoomId } = useApp();
  const settings = { ...DEFAULT_BROWSER_SETTINGS, ...data.settings.browser };
  const saved = data.bots.find((item) => item.id === bot?.id) ?? bot;
  const rooms = data.rooms.filter((room) => !room.deletion && room.botIds.includes(bot?.id ?? ''));
  const defaultRoomId = rooms.find((room) => room.id === currentRoomId)?.id ?? rooms[0]?.id;
  const [selectedRoomId, setSelectedRoomId] = useState(defaultRoomId);
  const roomId = rooms.some((room) => room.id === selectedRoomId) ? selectedRoomId : defaultRoomId;
  const active = data.tasks.some(
    (task) => task.botId === bot?.id && activeStatuses.includes(task.status),
  );
  const [observation, setObservation] = useState<{ path: string; status: BrowserStatus }>();
  const [busy, setBusy] = useState<'connect' | 'disconnect' | undefined>();
  const [error, setError] = useState('');
  const life = useRef<AbortController | undefined>(undefined);
  const action = useRef(0);
  const actionLock = useRef<'connect' | 'disconnect' | undefined>(undefined);
  const connectRequest = useRef<AbortController | undefined>(undefined);
  const path =
    bot && roomId
      ? `/rooms/${encodeURIComponent(roomId)}/bots/${encodeURIComponent(bot.id)}/browser`
      : undefined;
  // Never display one room's tabs while a different room is being selected or refreshed.
  const status = observation?.path === path ? observation?.status : undefined;
  const canObserve =
    !!path && settings.enabled && !!saved?.enabled && botBrowserMode(saved) !== 'disabled';
  const changedMode = !!saved && botBrowserMode(saved) !== mode;
  const live = status?.state === 'connected' || status?.state === 'connecting' || status?.waiting;

  async function refresh(signal?: AbortSignal) {
    if (!path || !canObserve) return;
    const current = action.current;
    try {
      const next = await api<BrowserStatus>(path, 'GET', undefined, signal);
      if (!signal?.aborted && current === action.current) setObservation({ path, status: next });
    } catch (cause) {
      if (!signal?.aborted && current === action.current) setError((cause as Error).message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    actionLock.current = undefined;
    setObservation(undefined);
    setError('');
    setBusy(undefined);
    return () => {
      controller.abort();
      action.current++;
      connectRequest.current?.abort();
    };
  }, [path]);

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    if (!canObserve) {
      action.current++;
      connectRequest.current?.abort();
      setObservation(undefined);
      setError('');
      setBusy(undefined);
      actionLock.current = undefined;
    }
    async function poll() {
      await refresh(controller.signal);
      if (!controller.signal.aborted && canObserve) timer = setTimeout(poll, 2500);
    }
    void poll();
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [path, canObserve]);

  async function connect() {
    if (!path || actionLock.current || disabled || mode === 'disabled') return;
    const intent = ++action.current;
    const request = new AbortController();
    connectRequest.current = request;
    actionLock.current = 'connect';
    setBusy('connect');
    setError('');
    try {
      // Persist the selected binding before any connection request is sent.
      if (changedMode)
        await mutate(`/bots/${encodeURIComponent(bot!.id)}`, 'PATCH', { browser: { mode } });
      if (life.current?.signal.aborted || intent !== action.current) return;
      const next = await api<BrowserStatus>(
        path + '/connect',
        'POST',
        undefined,
        AbortSignal.any([request.signal, life.current!.signal, AbortSignal.timeout(130_000)]),
      );
      if (!life.current?.signal.aborted && intent === action.current)
        setObservation({ path, status: next });
    } catch (cause) {
      if (!life.current?.signal.aborted && intent === action.current)
        setError((cause as Error).message);
    } finally {
      if (connectRequest.current === request) connectRequest.current = undefined;
      if (intent === action.current) {
        // A GET begun during this action must not replace its final result.
        action.current++;
        actionLock.current = undefined;
        if (!life.current?.signal.aborted) setBusy(undefined);
      }
    }
  }

  async function disconnect() {
    if (!path || actionLock.current === 'disconnect' || disabled) return;
    const intent = ++action.current;
    connectRequest.current?.abort();
    actionLock.current = 'disconnect';
    setBusy('disconnect');
    setError('');
    try {
      const next = await api<BrowserStatus>(
        path + '/connect',
        'DELETE',
        undefined,
        AbortSignal.any([life.current!.signal, AbortSignal.timeout(30_000)]),
      );
      if (!life.current?.signal.aborted && intent === action.current)
        setObservation({ path, status: next });
    } catch (cause) {
      if (!life.current?.signal.aborted && intent === action.current)
        setError((cause as Error).message);
    } finally {
      if (intent === action.current) {
        action.current++;
        actionLock.current = undefined;
        if (!life.current?.signal.aborted) setBusy(undefined);
      }
    }
  }

  return (
    <section className="bot-browser-settings" aria-label={t('ボットのChrome', 'Bot browser')}>
      <Field label={t('このボットのブラウザ', 'Browser for this bot')}>
        <select
          aria-label={t('このボットのブラウザ', 'Browser for this bot')}
          value={mode}
          disabled={disabled || active || !!busy}
          onChange={(event) => onChange(event.target.value as Value['mode'])}
        >
          <option value="dedicated">
            {t('Loomごとにこのボット専用のChrome', 'Dedicated Chrome for this bot in each Loom')}
          </option>
          <option value="shared">
            {t('全Loomの共通Chromeを使う', 'Use shared Chrome across all Looms')}
          </option>
          <option value="disabled">{t('ブラウザを使わない', 'Disable browser use')}</option>
        </select>
      </Field>
      <p className="field-hint">
        {mode === 'dedicated'
          ? t(
              'Loomとボットの組み合わせごとに、ログインとタブを分離します。必要なときだけ起動し、閉じてもログイン状態を保持します。同じボットでも別のLoomのChromeには接続しません。',
              'Each Loom and bot has separate sign-in and tabs. Chrome starts only when needed and retains sign-in after closing. This bot uses a different Chrome in each Loom.',
            )
          : mode === 'shared'
            ? t(
                '設定画面の共通Chromeを使います。Loomが違っても、共通Chromeを選んだ全ボットが同じログインとタブを操作できます。切断も全利用ボットに影響します。',
                'Uses the shared browser configured in Settings. Every bot choosing shared Chrome can operate the same sign-in and tabs across all Looms; disconnect affects all of them.',
              )
            : t(
                'このボットにはChrome操作ツールを提供しません。',
                'Chrome tools are unavailable to this bot.',
              )}
      </p>
      {active && (
        <p className="field-hint">
          {t(
            'ブラウザの種類を変更するには、このボットの作業を停止してください。',
            'Stop this bot’s tasks before changing its browser.',
          )}
        </p>
      )}
      {!bot ? (
        <p className="field-hint">
          {t(
            'ボットを保存してLoomに追加すると、そのLoomのChromeを開いてログインできます。',
            'Save the bot and add it to a Loom, then open that Loom’s Chrome to sign in.',
          )}
        </p>
      ) : (
        <div className="chrome-connection">
          <Field label={t('Chromeを開くLoom', 'Loom for this Chrome')}>
            <select
              aria-label={t('Chromeを開くLoom', 'Loom for this Chrome')}
              value={roomId ?? ''}
              disabled={disabled || !rooms.length}
              onChange={(event) => {
                action.current++;
                connectRequest.current?.abort();
                setSelectedRoomId(event.target.value);
              }}
            >
              {!rooms.length && (
                <option value="">{t('参加しているLoomがありません', 'No Loom membership')}</option>
              )}
              {rooms.map((room) => (
                <option key={room.id} value={room.id}>
                  {room.name}
                </option>
              ))}
            </select>
          </Field>
          {!rooms.length && (
            <p className="field-hint">
              {t(
                'このボットをLoomに追加するとChromeを開けます。',
                'Add this bot to a Loom before opening Chrome.',
              )}
            </p>
          )}
          <div className="chrome-connection-heading">
            <span
              role="status"
              className={
                'chrome-connection-state chrome-state-' + (status?.state ?? 'disconnected')
              }
            >
              <i aria-hidden="true" />
              {status?.waiting
                ? t('起動枠の空きを待機中', 'Waiting for browser capacity')
                : busy === 'connect' || status?.state === 'connecting'
                  ? t('接続中…', 'Connecting…')
                  : status?.state === 'connected'
                    ? t('接続済み', 'Connected')
                    : status?.state === 'error'
                      ? t('接続エラー', 'Connection error')
                      : t('未接続', 'Disconnected')}
              {status?.busy && <small>{t('使用中', 'In use')}</small>}
            </span>
            <button
              type="button"
              className="text-button"
              disabled={disabled || !canObserve}
              onClick={() => void refresh(life.current?.signal)}
            >
              <RefreshCw size={13} /> {t('状態を更新', 'Refresh status')}
            </button>
          </div>
          <div className="chrome-connection-actions">
            <Button
              type="button"
              icon={Chrome}
              busy={busy === 'connect'}
              disabled={
                disabled ||
                !path ||
                !!busy ||
                !settings.enabled ||
                settings.permission === 'deny' ||
                mode === 'disabled' ||
                !saved?.enabled ||
                (active && changedMode) ||
                (status?.state === 'connected' && !changedMode)
              }
              onClick={() => void connect()}
            >
              {changedMode
                ? t('ブラウザ設定を保存して開く', 'Save browser setting and open')
                : t('Chromeを開く・接続', 'Open / connect Chrome')}
            </Button>
            {(live || busy === 'connect' || status?.state === 'error') && (
              <Button
                type="button"
                icon={Unplug}
                busy={busy === 'disconnect'}
                disabled={disabled}
                onClick={() => void disconnect()}
              >
                {t('切断', 'Disconnect')}
              </Button>
            )}
          </div>
          {!settings.enabled || settings.permission === 'deny' ? (
            <p className="field-hint">
              {t(
                '設定画面でChrome操作を有効にして、操作権限を許可してください。',
                'Enable Chrome control and allow browser operations in Settings.',
              )}
            </p>
          ) : (
            <p className="field-hint">
              {t(
                'ChromeはLoomサーバーのマシンで、必要になった分だけ開きます。同時起動の上限時は未使用のChromeを閉じ、全て使用中なら空きを待ちます。ログイン状態は保持します。',
                'Chrome opens on the Loom server machine only when needed. At the limit, idle browsers close; if all are in use, the next browser waits. Sign-in is retained.',
              )}
            </p>
          )}
          {status?.pool && (
            <p className="field-hint">
              {t(
                `全Chrome：${status.pool.active} / ${status.pool.limit} 起動枠・${status.pool.waiting} 件待機`,
                `All browsers: ${status.pool.active} / ${status.pool.limit} slots · ${status.pool.waiting} waiting`,
              )}
            </p>
          )}
          {(error || status?.error) && (
            <div className="form-error chrome-connection-error" role="alert">
              {error || status?.error}
            </div>
          )}
          {!!status?.tabs.length && (
            <div className="chrome-tab-summary">
              <strong>{t('最後に確認したタブ', 'Last observed tabs')}</strong>
              <ul>
                {status.tabs.slice(0, 3).map((tab) => (
                  <li key={tab.pageId}>
                    <div>
                      <span title={tab.title || tab.url}>{tab.title || tab.url}</span>
                      <small title={tab.url}>{tab.url}</small>
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
