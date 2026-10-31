import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowRight,
  Bell,
  Check,
  ChevronDown,
  CircleHelp,
  Command,
  Cpu,
  Hash,
  LayoutGrid,
  LoaderCircle,
  LockKeyhole,
  Menu,
  MessageSquare,
  Plus,
  Search,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  WifiOff,
  Workflow,
  X,
} from 'lucide-react';
import { AnimatePresence, motion, MotionConfig } from 'motion/react';
import type { Snapshot } from '../shared/types';
import { api, applyEvent, ApiError, subscribe } from './api';
import { AppContext, activeStatuses, type Locale, type View } from './context';
import { Button, IconButton, Logo, Modal } from './components';
import { RoomDialog } from './RoomDialog';
import { Chat } from './Chat';
import { TeamPage, AutomationsPage, LearningPage, InboxPage, SettingsPage } from './pages';
import { getTaskStatus } from './task-status';

interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error';
}
const navItems: { view: View; icon: typeof Users; ja: string; en: string }[] = [
  { view: 'team', icon: Users, ja: 'ボット', en: 'Bots' },
  { view: 'automations', icon: Workflow, ja: '自動化', en: 'Automations' },
  { view: 'learning', icon: Sparkles, ja: '記憶とスキル', en: 'Memory & skills' },
  { view: 'inbox', icon: Bell, ja: 'お知らせ', en: 'Inbox' },
];

export default function App() {
  const [locale, setLocale] = useState<Locale>(() =>
    localStorage.getItem('loom.locale') === 'en' ? 'en' : 'ja',
  );
  const t = useCallback((ja: string, en: string) => (locale === 'ja' ? ja : en), [locale]);
  const [data, setData] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState('');
  const [auth, setAuth] = useState(false);
  const [token, setToken] = useState('');
  const [view, setView] = useState<View>('chat');
  const [roomId, setRoomId] = useState(() => localStorage.getItem('loom.room') || '');
  const [mobileNav, setMobileNav] = useState(false);
  const [newRoom, setNewRoom] = useState(false);
  const [palette, setPalette] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const originalTitle = useRef(document.title || 'Agent Loom');
  const streamRevision = useRef(0);
  const refreshRevision = useRef(0);
  const toast = useCallback((text: string, kind: 'success' | 'error' = 'success') => {
    const id = Date.now() + Math.random();
    setToasts((current) => [...current.slice(-3), { id, text, kind }]);
    setTimeout(
      () => setToasts((current) => current.filter((item) => item.id !== id)),
      kind === 'error' ? 7000 : 4000,
    );
  }, []);
  const refresh = useCallback(async () => {
    const streamAtStart = streamRevision.current;
    const request = ++refreshRevision.current;
    try {
      const next = await api<Snapshot>('/state');
      // A delayed snapshot must not rewind newer streamed text or task state.
      if (request === refreshRevision.current && streamAtStart === streamRevision.current)
        setData(next);
      if (request === refreshRevision.current) {
        setError('');
        setAuth(false);
      }
    } catch (e) {
      if (e instanceof ApiError && e.status === 401) setAuth(true);
      else setError((e as Error).message);
      throw e;
    }
  }, []);
  useEffect(() => {
    void refresh().catch(() => {});
  }, [refresh]);
  useEffect(() => {
    if (auth || !data) return;
    return subscribe((event) => {
      if (event.type !== 'heartbeat') streamRevision.current++;
      setData((current) => applyEvent(current, event));
    }, setConnected);
  }, [auth, !!data]);
  useEffect(() => {
    if (!data) return;
    if (!data.rooms.some((room) => room.id === roomId && !room.archived)) {
      const next = data.rooms.find((room) => !room.archived)?.id || '';
      setRoomId(next);
      if (next) localStorage.setItem('loom.room', next);
    }
  }, [data?.rooms, roomId]);
  useEffect(() => {
    document.documentElement.lang = locale;
    localStorage.setItem('loom.locale', locale);
  }, [locale]);
  useEffect(() => {
    const pending = data?.approvals.filter((approval) => approval.status === 'pending').length || 0;
    document.title = pending
      ? t(
          `${pending}件の承認待ち · Agent Loom`,
          `${pending} ${pending === 1 ? 'approval' : 'approvals'} pending · Agent Loom`,
        )
      : originalTitle.current;
  }, [data?.approvals, t]);
  useEffect(
    () => () => {
      document.title = originalTitle.current;
    },
    [],
  );
  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setPalette((open) => !open);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);
  const navigate = useCallback((next: View, nextRoom?: string) => {
    setView(next);
    setMobileNav(false);
    if (nextRoom) {
      setRoomId(nextRoom);
      localStorage.setItem('loom.room', nextRoom);
    }
  }, []);
  const seenNotifications = useRef<Set<string> | null>(null);
  useEffect(() => {
    if (!data) return;
    if (!seenNotifications.current) {
      seenNotifications.current = new Set(data.notifications.map((item) => item.id));
      return;
    }
    for (const item of data.notifications) {
      if (seenNotifications.current.has(item.id)) continue;
      seenNotifications.current.add(item.id);
      if (
        !item.read &&
        'Notification' in window &&
        Notification.permission === 'granted' &&
        localStorage.getItem('loom.notifications') === 'true' &&
        document.visibilityState === 'hidden'
      ) {
        try {
          const notification = new Notification(item.title, {
            body: item.body.slice(0, 240),
            icon: '/favicon.svg',
            tag: item.id,
          });
          notification.onclick = () => {
            window.focus();
            navigate(item.roomId ? 'chat' : 'inbox', item.roomId);
            notification.close();
          };
        } catch {
          /* Some mobile browsers require a service worker; the persistent inbox remains available. */
        }
      }
    }
  }, [data?.notifications, navigate]);
  const mutate = useCallback(
    async <T,>(path: string, method = 'POST', body?: unknown, success?: string) => {
      try {
        const result = await api<T>(path, method, body);
        await refresh();
        if (success) toast(success);
        return result;
      } catch (e) {
        toast((e as Error).message, 'error');
        throw e;
      }
    },
    [refresh, toast],
  );
  const signOut = useCallback(async () => {
    await api('/auth', 'DELETE');
    refreshRevision.current++;
    streamRevision.current++;
    setAuth(true);
    setData(null);
    setConnected(false);
    setToken('');
    setError('');
    seenNotifications.current = null;
  }, []);
  const context = useMemo(
    () =>
      data
        ? { data, locale, t, view, roomId, connected, navigate, refresh, toast, mutate, signOut }
        : null,
    [data, locale, t, view, roomId, connected, navigate, refresh, toast, mutate, signOut],
  );

  if (auth)
    return (
      <div className="boot-screen">
        <div className="auth-card">
          <Logo />
          <div className="empty-icon">
            <LockKeyhole size={26} />
          </div>
          <h1>{t('Agent Loomに接続', 'Connect to Agent Loom')}</h1>
          <p>
            {t(
              'このLoomサーバーにはアクセストークンが設定されています。',
              'An access token protects this Loom server.',
            )}
          </p>
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              try {
                await api('/auth', 'POST', { token });
                setToken('');
                await refresh();
              } catch (err) {
                setError((err as Error).message);
              }
            }}
          >
            <label className="field">
              <span className="field-label">{t('アクセストークン', 'Access token')}</span>
              <input
                type="password"
                value={token}
                onChange={(e) => setToken(e.target.value)}
                required
                autoFocus
                autoComplete="current-password"
              />
            </label>
            {error && (
              <p role="alert" className="form-error">
                {error}
              </p>
            )}
            <Button variant="primary" type="submit" icon={ArrowRight}>
              {t('接続する', 'Connect')}
            </Button>
          </form>
        </div>
      </div>
    );
  if (!data || !context)
    return (
      <div className="boot-screen">
        <Logo />
        <div className="boot-orbit">
          <LoaderCircle className="spin" size={32} />
        </div>
        <h2>
          {error
            ? t('接続を確認してください', 'Let’s reconnect')
            : t('Loomに接続しています', 'Connecting to Loom')}
        </h2>
        <p>{error || t('保存された状態を取得しています。', 'Loading saved application state.')}</p>
        {error && (
          <Button variant="primary" onClick={() => void refresh().catch(() => {})}>
            {t('もう一度接続', 'Try again')}
          </Button>
        )}
      </div>
    );

  const rooms = data.rooms
    .filter((room) => !room.archived)
    .sort((a, b) => Number(b.pinned) - Number(a.pinned));
  const archivedRooms = data.rooms.filter((room) => room.archived);
  const unread = data.notifications.filter((n) => !n.read).length;
  const pendingApprovals = data.approvals
    .filter((approval) => approval.status === 'pending')
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id));
  const outsideApprovals = pendingApprovals.filter(
    (approval) => view !== 'chat' || approval.roomId !== roomId,
  );
  const nextApproval = outsideApprovals[0];
  const nextApprovalRoom = data.rooms.find((item) => item.id === nextApproval?.roomId);
  const nextApprovalBot = data.bots.find((item) => item.id === nextApproval?.botId);
  const running = data.tasks.filter((task) => activeStatuses.includes(task.status));
  const room = data.rooms.find((item) => item.id === roomId);
  const currentLabel =
    view === 'chat'
      ? room?.name || t('ルーム', 'Rooms')
      : view === 'settings'
        ? t('設定', 'Settings')
        : navItems.find((item) => item.view === view)?.[locale] || '';
  return (
    <AppContext.Provider value={context}>
      <MotionConfig reducedMotion="user">
        <div className="app-shell">
          {mobileNav && (
            <button
              className="sidebar-scrim"
              aria-label={t('メニューを閉じる', 'Close menu')}
              onClick={() => setMobileNav(false)}
            />
          )}
          <aside className={`sidebar ${mobileNav ? 'sidebar-open' : ''}`}>
            <div className="sidebar-brand">
              <Logo />
              <IconButton
                icon={X}
                label={t('メニューを閉じる', 'Close menu')}
                className="mobile-only"
                onClick={() => setMobileNav(false)}
              />
            </div>
            <div
              className="instance-summary"
              aria-label={t('現在のモデル接続', 'Current model connection')}
            >
              <span className="instance-symbol">
                <Cpu size={17} aria-hidden="true" />
              </span>
              <span>
                <strong>{t('言語モデル', 'Language model')}</strong>
                <small title={data.settings.model.modelId}>
                  {data.settings.demoMode
                    ? t('デモモード', 'Demo mode')
                    : data.settings.model.modelId || t('モデル未設定', 'Model not configured')}
                </small>
              </span>
            </div>
            <div className="sidebar-scroll">
              <div className="sidebar-section-heading">
                <span>{t('メニュー', 'MENU')}</span>
              </div>
              <nav className="main-nav" aria-label={t('メインナビゲーション', 'Main navigation')}>
                {navItems.map((item) => (
                  <button
                    key={item.view}
                    onClick={() => navigate(item.view)}
                    className={`nav-item ${view === item.view ? 'active' : ''}`}
                  >
                    <item.icon size={18} />
                    <span>{item[locale]}</span>
                    {item.view === 'inbox' && unread > 0 && (
                      <span className="nav-count">{unread}</span>
                    )}
                    {item.view === 'learning' &&
                      data.skills.some((s) => s.status === 'candidate') && (
                        <span className="nav-dot" />
                      )}
                  </button>
                ))}
              </nav>
              <div className="sidebar-section-heading room-section-heading">
                <span>{t('ルーム', 'ROOMS')}</span>
                <IconButton
                  icon={Plus}
                  label={t('ルームを作成', 'Create room')}
                  onClick={() => setNewRoom(true)}
                />
              </div>
              <nav className="room-nav" aria-label={t('ルーム一覧', 'Rooms')}>
                {rooms.map((item) => {
                  const roomTasks = running.filter((task) => task.roomId === item.id);
                  const busy = roomTasks.length > 0;
                  const states = roomTasks.map((task) =>
                    getTaskStatus(task, data, locale, connected),
                  );
                  const working = states.some((state) => state.animated);
                  const roomPending = pendingApprovals.filter(
                    (approval) => approval.roomId === item.id,
                  ).length;
                  const roomState = roomPending
                    ? t(
                        `承認待ち ${roomPending}件`,
                        `${roomPending} ${roomPending === 1 ? 'approval' : 'approvals'} pending`,
                      )
                    : [...new Set(states.map((state) => state.label))].join(' · ');
                  return (
                    <button
                      key={item.id}
                      className={`room-nav-item ${view === 'chat' && roomId === item.id ? 'active' : ''} ${roomPending ? 'has-pending-approval' : ''}`}
                      onClick={() => navigate('chat', item.id)}
                      aria-label={roomState ? `${item.name} · ${roomState}` : item.name}
                      title={roomState ? `${item.name} · ${roomState}` : item.name}
                      data-pending-approvals={roomPending || undefined}
                    >
                      <Hash size={17} />
                      <span className="room-nav-name">{item.name}</span>
                      {roomPending > 0 ? (
                        <span className="room-approval-count" aria-hidden="true">
                          <ShieldCheck size={12} />
                          <span>{t('承認', 'Review')}</span>
                          <strong>{roomPending}</strong>
                        </span>
                      ) : busy ? (
                        <span
                          className={`nav-dot ${working ? 'pulse' : 'room-status-waiting'} ${!connected ? 'room-status-unconfirmed' : ''}`}
                          aria-hidden="true"
                        />
                      ) : null}
                      {item.pinned && !busy && !roomPending && <span className="pin-mark">↗</span>}
                    </button>
                  );
                })}
                {!rooms.length && (
                  <button className="room-nav-empty" onClick={() => setNewRoom(true)}>
                    <Plus size={16} />
                    {t('最初のルームをつくる', 'Create your first room')}
                  </button>
                )}
              </nav>
              {archivedRooms.length > 0 && (
                <div className="archived-rooms">
                  <button onClick={() => setShowArchived((value) => !value)}>
                    <ChevronDown size={12} className={showArchived ? '' : 'rotate-left'} />
                    {t('アーカイブ', 'Archived')} <span>{archivedRooms.length}</span>
                  </button>
                  {showArchived &&
                    archivedRooms.map((item) => (
                      <div key={item.id}>
                        <span>{item.name}</span>
                        <button
                          onClick={() =>
                            void mutate(`/rooms/${item.id}`, 'PATCH', { archived: false }).catch(
                              () => {},
                            )
                          }
                        >
                          {t('戻す', 'Restore')}
                        </button>
                      </div>
                    ))}
                </div>
              )}
            </div>
            <div className="sidebar-footer">
              <div className="runtime-mini">
                <span className={`connection-dot ${connected ? 'online' : ''}`} />
                <div>
                  <strong>
                    {connected
                      ? t('Loom接続中', 'Loom connected')
                      : t('再接続しています', 'Reconnecting')}{' '}
                  </strong>
                  <small>
                    {running.length
                      ? t(
                          `${running.length}件の作業 · 生成枠 ${data.queue.active}/${data.queue.capacity ?? data.settings.inference?.maxConcurrentRequests ?? 1}`,
                          `${running.length} tasks · slots ${data.queue.active}/${data.queue.capacity ?? data.settings.inference?.maxConcurrentRequests ?? 1}`,
                        )
                      : t('実行中のタスクはありません', 'No active tasks')}
                  </small>
                </div>
              </div>
              <button
                className={`nav-item ${view === 'settings' ? 'active' : ''}`}
                onClick={() => navigate('settings')}
              >
                <Settings2 size={18} />
                <span>{t('設定', 'Settings')}</span>
                <span className="version">v{data.version}</span>
              </button>
            </div>
          </aside>
          <div className="workspace-main">
            <header className="topbar">
              <div className="breadcrumb">
                <IconButton
                  icon={Menu}
                  label={t('メニューを開く', 'Open menu')}
                  className="mobile-only"
                  onClick={() => setMobileNav(true)}
                />
                <LayoutGrid size={15} />
                <span>Agent Loom</span>
                <span className="breadcrumb-slash">/</span>
                <strong>{currentLabel}</strong>
              </div>
              <div className="topbar-actions">
                <button className="search-trigger" onClick={() => setPalette(true)}>
                  <Search size={15} />
                  <span>{t('移動・検索', 'Jump to…')}</span>
                  <kbd>⌘ K</kbd>
                </button>
                <button
                  className="locale-button"
                  onClick={() => setLocale(locale === 'ja' ? 'en' : 'ja')}
                  aria-label={locale === 'ja' ? 'Switch to English' : '日本語に切り替え'}
                >
                  {locale === 'ja' ? 'EN' : '日本語'}
                </button>
                {data.settings.demoMode ? (
                  <span className="model-badge demo-badge">DEMO</span>
                ) : (
                  <button
                    className={`model-badge ${data.settings.model.modelId ? 'model-ready' : ''}`}
                    onClick={() => navigate('settings')}
                    title={data.settings.model.modelId || ''}
                  >
                    <span className="status-dot" />
                    <span className="model-name">
                      {data.settings.model.modelId
                        ? data.settings.model.modelId.split('/').pop()
                        : t('モデル未接続', 'Connect a model')}
                    </span>
                  </button>
                )}
              </div>
            </header>
            {!connected && (
              <div className="connection-banner" role="status">
                <WifiOff size={14} />
                <span>
                  {t(
                    '接続が途切れました。再接続すると最新の状態を表示します。',
                    'Connection interrupted. Loom will update when reconnected.',
                  )}
                </span>
                <button onClick={() => void refresh().catch(() => {})}>
                  {t('再試行', 'Retry')}
                </button>
              </div>
            )}
            {nextApproval && (
              <button
                className="approval-banner global-approval-banner"
                onClick={() => navigate('chat', nextApproval.roomId)}
                aria-label={t(
                  `${nextApprovalRoom?.name || 'ルーム'}の${nextApprovalBot?.name || 'ボット'}の承認を確認。${outsideApprovals.length}件が承認待ち`,
                  `Review approval from ${nextApprovalBot?.name || 'Bot'} in ${nextApprovalRoom?.name || 'room'}. ${outsideApprovals.length} pending`,
                )}
                data-approval-id={nextApproval.id}
              >
                <ShieldCheck size={19} aria-hidden="true" />
                <span className="global-approval-copy">
                  <strong>
                    {view === 'chat'
                      ? t(
                          `ほかのルームで承認待ち ${outsideApprovals.length}件`,
                          `${outsideApprovals.length} ${outsideApprovals.length === 1 ? 'approval in another room' : 'approvals in other rooms'}`,
                        )
                      : t(
                          `承認待ち ${outsideApprovals.length}件`,
                          `${outsideApprovals.length} ${outsideApprovals.length === 1 ? 'approval' : 'approvals'} pending`,
                        )}
                  </strong>
                  <span
                    className="global-approval-target"
                    title={`${nextApprovalRoom?.name || t('ルーム', 'Room')} · ${nextApprovalBot?.name || t('ボット', 'Bot')}`}
                  >
                    {nextApprovalRoom?.name || t('ルーム', 'Room')} ·{' '}
                    {nextApprovalBot?.name || t('ボット', 'Bot')}
                  </span>
                </span>
                <span className="global-approval-open">
                  {t('確認する', 'Review')}
                  <ArrowRight size={15} aria-hidden="true" />
                </span>
              </button>
            )}
            <main className={`main-content view-${view}`}>
              {view === 'chat' ? (
                <Chat room={room} />
              ) : view === 'team' ? (
                <TeamPage />
              ) : view === 'automations' ? (
                <AutomationsPage />
              ) : view === 'learning' ? (
                <LearningPage />
              ) : view === 'inbox' ? (
                <InboxPage />
              ) : (
                <SettingsPage />
              )}
            </main>
          </div>
          {newRoom && <RoomDialog onClose={() => setNewRoom(false)} />}
          {palette && (
            <CommandPalette
              onClose={() => setPalette(false)}
              onNewRoom={() => {
                setPalette(false);
                setNewRoom(true);
              }}
            />
          )}
          <div className="toast-stack" aria-live="polite">
            <AnimatePresence>
              {toasts.map((item) => (
                <motion.div
                  key={item.id}
                  initial={{ opacity: 0, y: 12, scale: 0.97 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  exit={{ opacity: 0, x: 20 }}
                  className={`toast toast-${item.kind}`}
                >
                  <span>
                    {item.kind === 'success' ? <Check size={16} /> : <CircleHelp size={16} />}
                  </span>
                  <p>{item.text}</p>
                  <button
                    onClick={() =>
                      setToasts((current) =>
                        current.filter((toastItem) => toastItem.id !== item.id),
                      )
                    }
                    aria-label={t('閉じる', 'Dismiss')}
                  >
                    <X size={14} />
                  </button>
                </motion.div>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </MotionConfig>
    </AppContext.Provider>
  );
}

function CommandPalette({ onClose, onNewRoom }: { onClose: () => void; onNewRoom: () => void }) {
  const { data, t, locale, navigate } = useApp();
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState(0);
  const items = [
    {
      title: t('新しいルーム', 'Create a room'),
      section: t('アクション', 'Actions'),
      icon: Plus,
      action: onNewRoom,
    },
    ...navItems.map((item) => ({
      title: item[locale],
      section: t('移動', 'Navigate'),
      icon: item.icon,
      action: () => {
        navigate(item.view);
        onClose();
      },
    })),
    {
      title: t('設定', 'Settings'),
      section: t('移動', 'Navigate'),
      icon: Settings2,
      action: () => {
        navigate('settings');
        onClose();
      },
    },
    ...data.rooms
      .filter((room) => !room.archived)
      .map((room) => ({
        title: room.name,
        section: t('ルーム', 'Rooms'),
        icon: MessageSquare,
        action: () => {
          navigate('chat', room.id);
          onClose();
        },
      })),
  ].filter((item) => item.title.toLowerCase().includes(query.toLowerCase()));
  return (
    <Modal title={t('どこへ移動しますか？', 'Where would you like to go?')} onClose={onClose}>
      <div className="command-search">
        <Search size={19} />
        <input
          autoFocus
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setSelected(0);
          }}
          placeholder={t('ルームや機能を検索…', 'Search rooms and actions…')}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setSelected((index) => (index + 1) % Math.max(items.length, 1));
            }
            if (e.key === 'ArrowUp') {
              e.preventDefault();
              setSelected((index) => (index - 1 + items.length) % Math.max(items.length, 1));
            }
            if (e.key === 'Enter') {
              e.preventDefault();
              items[selected]?.action();
            }
          }}
        />
      </div>
      <div className="command-results" role="listbox" aria-label={t('移動先', 'Destinations')}>
        {items.map((item, index) => (
          <button
            key={`${item.section}-${item.title}`}
            role="option"
            aria-selected={selected === index}
            className={selected === index ? 'selected' : ''}
            onMouseEnter={() => setSelected(index)}
            onClick={item.action}
          >
            <item.icon size={17} />
            <span>{item.title}</span>
            <small>{item.section}</small>
          </button>
        ))}
        {!items.length && (
          <p className="muted">{t('一致する項目がありません', 'No matching results')}</p>
        )}
      </div>
      <div className="command-footer">
        <span>↑ ↓ {t('選択', 'navigate')}</span>
        <span>↵ {t('開く', 'open')}</span>
        <span>esc {t('閉じる', 'close')}</span>
        <Command size={14} />
      </div>
    </Modal>
  );
}

import { useApp } from './context';
