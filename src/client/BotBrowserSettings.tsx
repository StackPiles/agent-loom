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
  const { data, t, mutate } = useApp();
  const settings = { ...DEFAULT_BROWSER_SETTINGS, ...data.settings.browser };
  const saved = data.bots.find((item) => item.id === bot?.id) ?? bot;
  const active = data.tasks.some(
    (task) => task.botId === bot?.id && activeStatuses.includes(task.status),
  );
  const [status, setStatus] = useState<BrowserStatus>();
  const [busy, setBusy] = useState<'connect' | 'disconnect' | undefined>();
  const [error, setError] = useState('');
  const life = useRef<AbortController | undefined>(undefined);
  const action = useRef(0);
  const actionLock = useRef<'connect' | 'disconnect' | undefined>(undefined);
  const connectRequest = useRef<AbortController | undefined>(undefined);
  const path = bot ? `/bots/${encodeURIComponent(bot.id)}/browser` : undefined;
  const canObserve =
    !!path && settings.enabled && !!saved?.enabled && botBrowserMode(saved) !== 'disabled';
  const changedMode = !!saved && botBrowserMode(saved) !== mode;
  const live = status?.state === 'connected' || status?.state === 'connecting' || status?.waiting;

  async function refresh(signal?: AbortSignal) {
    if (!path || !canObserve) return;
    const current = action.current;
    try {
      const next = await api<BrowserStatus>(path, 'GET', undefined, signal);
      if (!signal?.aborted && current === action.current) setStatus(next);
    } catch (cause) {
      if (!signal?.aborted && current === action.current) setError((cause as Error).message);
    }
  }

  useEffect(() => {
    const controller = new AbortController();
    life.current = controller;
    actionLock.current = undefined;
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
      setStatus(undefined);
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
      if (!life.current?.signal.aborted && intent === action.current) setStatus(next);
    } catch (cause) {
      if (!life.current?.signal.aborted && intent === action.current)
        setError((cause as Error).message);
    } finally {
      if (connectRequest.current === request) connectRequest.current = undefined;
      if (intent === action.current) {
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
      if (!life.current?.signal.aborted && intent === action.current) setStatus(next);
    } catch (cause) {
      if (!life.current?.signal.aborted && intent === action.current)
        setError((cause as Error).message);
    } finally {
      if (intent === action.current) {
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
            {t('このボット専用のChrome', 'Dedicated Chrome for this bot')}
          </option>
          <option value="shared">{t('共通Chromeを使う', 'Use shared Chrome')}</option>
          <option value="disabled">{t('ブラウザを使わない', 'Disable browser use')}</option>
        </select>
      </Field>
      <p className="field-hint">
        {mode === 'dedicated'
          ? t(
              '必要なときだけ起動します。ログインとタブを他のボットから分離し、ログイン状態は再起動後も保持します。同じボットは複数ルームで共用します。',
              'Starts when needed. Sign-in and tabs are separate from other bots, and the profile persists across restarts. This bot shares its browser across rooms.',
            )
          : mode === 'shared'
            ? t(
                '設定画面の共通Chromeを使います。ログインとタブは他の共通Chrome利用ボットと共有され、切断は全利用ボットに影響します。',
                'Uses the shared browser configured in Settings. Sign-in and tabs are shared with its other bots; disconnect affects all of them.',
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
            'ボットを保存するとChromeを開いてログインできます。',
            'Save the bot, then open its Chrome to sign in.',
          )}
        </p>
      ) : (
        <div className="chrome-connection">
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
                'ChromeはLoomサーバーのマシンで開きます。上限に達すると未使用のChromeが閉じることがあります。',
                'Chrome opens on the Loom server machine. Idle browsers may close when another browser needs capacity.',
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
