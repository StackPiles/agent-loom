import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  AtSign,
  Check,
  ChevronDown,
  Compass,
  Hash,
  Lightbulb,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pin,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { Bot, Message, Room } from '../shared/types';
import { activeStatuses, dateLabel, statusLabel, useApp, type Locale } from './context';
import {
  Avatar,
  Button,
  Confirm,
  CopyButton,
  EmptyState,
  IconButton,
  Markdown,
  Status,
} from './components';
import { RoomDialog } from './RoomDialog';
import { ApprovalCard } from './ApprovalCard';
import { RunProgress, activityTitle } from './RunProgress';

export function Chat({ room }: { room?: Room }) {
  const { data, t, locale, mutate, navigate } = useApp();
  const [edit, setEdit] = useState(false);
  const [archive, setArchive] = useState(false);
  const [activityOpen, setActivityOpen] = useState(
    () =>
      window.innerWidth > 1100 &&
      (localStorage.getItem('loom.activity')
        ? localStorage.getItem('loom.activity') === 'true'
        : true),
  );
  const [drafts, setDrafts] = useState<Record<string, string>>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('loom.drafts') || '{}');
      return Object.fromEntries(
        Object.entries(saved).filter(([, value]) => typeof value === 'string'),
      ) as Record<string, string>;
    } catch {
      return {};
    }
  });
  const draft = room ? drafts[room.id] || '' : '';
  const setDraft = (value: string) => {
    if (room) setDrafts((current) => ({ ...current, [room.id]: value }));
  };
  const [recipient, setRecipient] = useState('');
  const [sending, setSending] = useState(false);
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [count, setCount] = useState(100);
  const [atBottom, setAtBottom] = useState(true);
  const textRef = useRef<HTMLTextAreaElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const sticky = useRef(true);
  const members = data.bots.filter((bot) => room?.botIds.includes(bot.id));
  const enabled = members.filter((bot) => bot.enabled);
  const messages = data.messages.filter((message) => message.roomId === room?.id);
  const tasks = data.tasks.filter((task) => task.roomId === room?.id);
  const active = tasks.filter((task) => activeStatuses.includes(task.status));
  const pending = data.approvals.filter(
    (approval) => approval.roomId === room?.id && approval.status === 'pending',
  );
  const visibleMessages = messages.slice(-count);
  const representedTasks = new Set(
    visibleMessages
      .filter((message) => message.authorType === 'bot')
      .map((message) => message.taskId),
  );
  const standaloneTasks = tasks.filter(
    (task) =>
      !representedTasks.has(task.id) &&
      (activeStatuses.includes(task.status) ||
        ['interrupted', 'stopped', 'failed'].includes(task.status)),
  );
  const floatingApprovals = pending.filter(
    (approval) =>
      !representedTasks.has(approval.taskId) &&
      !standaloneTasks.some((task) => task.id === approval.taskId),
  );
  const activities = data.activities
    .filter((activity) => activity.roomId === room?.id)
    .slice(-60)
    .reverse();
  const ready =
    data.settings.demoMode || !!(data.settings.model.baseUrl && data.settings.model.modelId);
  const candidates = enabled.filter((bot) =>
    `${bot.handle} ${bot.name}`.toLowerCase().includes(mention?.query.toLowerCase() || ''),
  );
  useEffect(() => {
    setRecipient('');
    setCount(100);
    setMention(null);
    sticky.current = true;
    setAtBottom(true);
  }, [room?.id]);
  useEffect(() => {
    localStorage.setItem('loom.drafts', JSON.stringify(drafts));
  }, [drafts]);
  useEffect(() => {
    localStorage.setItem('loom.activity', String(activityOpen));
  }, [activityOpen]);
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth <= 1100) setActivityOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !document.querySelector('dialog[open]')) setActivityOpen(false);
    };
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  useLayoutEffect(() => {
    if (sticky.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [data.messages, data.activities, data.approvals, active.length, room?.id]);
  useLayoutEffect(() => {
    if (textRef.current) {
      textRef.current.style.height = 'auto';
      textRef.current.style.height = `${Math.min(160, textRef.current.scrollHeight)}px`;
    }
  }, [draft]);
  function updateMention(value: string, cursor: number) {
    const match = value.slice(0, cursor).match(/(?:^|\s)@([^\s@]*)$/);
    setMention(
      match ? { start: cursor - match[1].length - 1, end: cursor, query: match[1] } : null,
    );
    setMentionIndex(0);
  }
  function chooseMention(handle: string) {
    if (!mention) return;
    const value = `${draft.slice(0, mention.start)}@${handle} ${draft.slice(mention.end)}`;
    const cursor = mention.start + handle.length + 2;
    setDraft(value);
    setMention(null);
    requestAnimationFrame(() => {
      textRef.current?.focus();
      textRef.current?.setSelectionRange(cursor, cursor);
    });
  }
  async function send() {
    if (!room || !draft.trim() || sending || !ready || !enabled.length) return;
    setSending(true);
    try {
      await mutate(`/rooms/${room.id}/messages`, 'POST', {
        body: draft.trim(),
        ...(recipient
          ? { botIds: recipient === 'all' ? enabled.map((bot) => bot.id) : [recipient] }
          : {}),
      });
      setDraft('');
      setMention(null);
      sticky.current = true;
      setAtBottom(true);
    } catch {
    } finally {
      setSending(false);
    }
  }
  if (!room)
    return (
      <div className="page-scroll">
        <EmptyState
          icon={Hash}
          title={t('ルームがありません', 'No rooms yet')}
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEdit(true)}>
              {t('ルームをつくる', 'Create a room')}
            </Button>
          }
        >
          {t(
            'ルームを作成し、使用するボットを追加してください。',
            'Create a room and add the bots you want to use.',
          )}
        </EmptyState>
        {edit && <RoomDialog onClose={() => setEdit(false)} />}
      </div>
    );
  const prompts = [
    {
      icon: Compass,
      label: t('機能を確認', 'Check capabilities'),
      detail: t('利用できるツールを確認', 'List available tools'),
      prompt: t(
        'あなたができることを教えて。調べものを一緒に進めたい。',
        'Tell me what you can do. I’d like to explore an idea together.',
      ),
    },
    {
      icon: Lightbulb,
      label: t('作業を計画', 'Plan a task'),
      detail: t('目的や条件を整理', 'Clarify requirements'),
      prompt: t(
        '新しいプロジェクトのアイデアを整理したい。まず、必要なことを質問して。',
        'Help me shape a new project idea. Ask me a few useful questions to start.',
      ),
    },
    {
      icon: ShieldCheck,
      label: t('フォルダを確認', 'Inspect workspace'),
      detail: t('ファイルを変更せず確認', 'Read without changing files'),
      prompt: t(
        '作業フォルダの内容を確認して、何があるか簡潔に教えて。変更はまだ行わないで。',
        'Inspect the workspace folder and briefly explain what is there. Do not make changes yet.',
      ),
    },
  ];
  return (
    <div className={`chat-workspace ${activityOpen ? 'with-activity' : ''}`}>
      <section className="conversation" aria-label={room.name}>
        <header className="room-header">
          <div className="room-heading">
            <span className="room-symbol">
              <Hash size={23} />
            </span>
            <div>
              <h1>{room.name}</h1>
              <p>
                {room.description ||
                  t(`${members.length}件のボットが参加`, `${members.length} bots in this room`)}
              </p>
            </div>
          </div>
          <div className="room-header-actions">
            <div className="avatar-stack">
              {members.slice(0, 4).map((bot) => (
                <span key={bot.id} title={bot.name}>
                  <Avatar bot={bot} size="small" />
                </span>
              ))}
            </div>
            <details className="room-menu">
              <summary aria-label={t('ルームの操作', 'Room actions')}>
                <MoreHorizontal size={20} />
              </summary>
              <div className="dropdown-menu">
                <button onClick={() => setEdit(true)}>
                  <Settings2 size={15} />
                  {t('ルームを編集', 'Edit room')}
                </button>
                <button
                  onClick={() =>
                    void mutate(`/rooms/${room.id}`, 'PATCH', { pinned: !room.pinned }).catch(
                      () => {},
                    )
                  }
                >
                  <Pin size={15} />
                  {room.pinned ? t('ピンを外す', 'Unpin room') : t('ピン留め', 'Pin room')}
                </button>
                <button onClick={() => setArchive(true)}>
                  <Archive size={15} />
                  {t('アーカイブ', 'Archive')}
                </button>
              </div>
            </details>
            <span className="action-divider" />
            <IconButton
              icon={activityOpen ? PanelRightClose : PanelRightOpen}
              label={t('アクティビティを表示・非表示', 'Toggle activity')}
              onClick={() => setActivityOpen((value) => !value)}
              aria-expanded={activityOpen}
              aria-controls="activity-panel"
              className={activityOpen ? 'is-active' : ''}
            />
          </div>
        </header>
        <div className="room-context">
          <span className={`connection-dot ${active.length ? 'working' : 'online'}`} />
          <span>
            {active.length
              ? t(`${active.length}件の作業が進行中`, `${active.length} tasks in progress`)
              : t('実行中のタスクはありません', 'No active tasks')}
          </span>
          <span className="context-separator">·</span>
          <span>{t('同時実行: 1', 'Concurrency: 1')}</span>
          {active.length > 0 && (
            <IconButton
              icon={Square}
              label={t('このルームの作業を停止', 'Stop work in this room')}
              onClick={() =>
                void Promise.all(active.map((task) => mutate(`/tasks/${task.id}/stop`))).catch(
                  () => {},
                )
              }
            />
          )}
          {data.settings.demoMode && (
            <span className="tiny-demo">{t('シミュレーション', 'SIMULATION')}</span>
          )}
        </div>
        <div
          className="message-scroll"
          ref={scrollRef}
          onScroll={(event) => {
            const el = event.currentTarget;
            const bottom = el.scrollHeight - el.scrollTop - el.clientHeight < 100;
            sticky.current = bottom;
            setAtBottom(bottom);
          }}
        >
          {!messages.length && !standaloneTasks.length ? (
            <div className="chat-welcome">
              <div className="chat-empty-icon">
                <Hash size={25} />
              </div>
              <h2>{t('メッセージはありません', 'No messages yet')}</h2>
              <p>
                {t(
                  'メッセージを入力して開始します。@で応答するボットを選べます。',
                  'Send a message to start. Use @ to select a responding bot.',
                )}
              </p>
              <div className="welcome-members">
                {members.map((bot) => (
                  <button
                    key={bot.id}
                    disabled={!bot.enabled}
                    onClick={() => {
                      setRecipient(bot.id);
                      textRef.current?.focus();
                    }}
                  >
                    <Avatar bot={bot} size="small" />
                    <span>{bot.name}</span>
                    <small>@{bot.handle}</small>
                  </button>
                ))}
                {!members.length && (
                  <Button icon={Plus} onClick={() => setEdit(true)}>
                    {t('仲間を追加', 'Add teammates')}
                  </Button>
                )}
              </div>
              <div className="prompt-grid">
                {prompts.map((prompt) => (
                  <button
                    key={prompt.label}
                    onClick={() => {
                      setDraft(prompt.prompt);
                      textRef.current?.focus();
                    }}
                  >
                    <prompt.icon size={20} strokeWidth={1.6} />
                    <strong>{prompt.label}</strong>
                    <span>{prompt.detail}</span>
                    <ArrowUp size={14} className="prompt-arrow" />
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="message-list">
              {messages[0] && (
                <div className="date-divider">
                  <span>{dateLabel(messages[0].createdAt, locale, true)}</span>
                </div>
              )}
              {messages.length > count && (
                <button
                  className="load-earlier"
                  onClick={() => {
                    const height = scrollRef.current?.scrollHeight || 0;
                    setCount((value) => value + 100);
                    requestAnimationFrame(() => {
                      if (scrollRef.current)
                        scrollRef.current.scrollTop += scrollRef.current.scrollHeight - height;
                    });
                  }}
                >
                  {t('前のメッセージを表示', 'Load earlier messages')}
                </button>
              )}
              {visibleMessages.map((message) => (
                <MessageItem
                  key={message.id}
                  message={message}
                  bot={data.bots.find((bot) => bot.id === message.authorId)}
                  completed={
                    data.tasks.find((task) => task.id === message.taskId)?.status === 'completed'
                  }
                  locale={locale}
                />
              ))}
            </div>
          )}
          {standaloneTasks.length > 0 && (
            <div className="standalone-runs">
              {standaloneTasks.map((task) => (
                <article className="message message-bot message-standalone" key={task.id}>
                  <div className="message-avatar">
                    <Avatar bot={data.bots.find((bot) => bot.id === task.botId)} />
                  </div>
                  <div className="message-main">
                    <header>
                      <strong>
                        {data.bots.find((bot) => bot.id === task.botId)?.name || t('ボット', 'Bot')}
                      </strong>
                      <time>{dateLabel(task.createdAt, locale)}</time>
                    </header>
                    <RunProgress
                      taskId={task.id}
                      message={data.messages
                        .filter(
                          (message) => message.taskId === task.id && message.authorType === 'bot',
                        )
                        .at(-1)}
                    />
                  </div>
                </article>
              ))}
            </div>
          )}
          {floatingApprovals.length > 0 && (
            <div className="inline-approvals">
              {floatingApprovals.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} />
              ))}
            </div>
          )}
          <div className="scroll-bottom-space" />
        </div>
        <div className="composer-area">
          {!atBottom && messages.length > 0 && (
            <button
              className="jump-latest"
              onClick={() => {
                sticky.current = true;
                scrollRef.current?.scrollTo({
                  top: scrollRef.current.scrollHeight,
                  behavior: 'smooth',
                });
              }}
            >
              <ArrowDown size={14} />
              {t('最新のメッセージ', 'Jump to latest')}
            </button>
          )}
          {!ready && (
            <div className="connect-strip">
              <span>
                <span className="status-dot" />
                {t(
                  'モデルを接続して、会話をはじめましょう。',
                  'Connect a model to start your conversation.',
                )}
              </span>
              <button onClick={() => navigate('settings')}>
                {t('接続設定', 'Connect')}
                <ArrowUp size={13} />
              </button>
              <button
                onClick={() =>
                  void mutate(
                    '/demo',
                    'POST',
                    { enabled: true },
                    t('デモを有効にしました', 'Demo enabled'),
                  ).catch(() => {})
                }
              >
                {t('デモで試す', 'Try demo')}
              </button>
            </div>
          )}
          <form
            className="composer"
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
          >
            <div className="composer-recipient">
              <span>{t('話しかける相手', 'Speaking to')}</span>
              <select
                value={recipient}
                onChange={(e) => setRecipient(e.target.value)}
                aria-label={t('応答するボット', 'Responding teammate')}
              >
                <option value="">
                  {t('@メンション、または最初の仲間', '@mention or first teammate')}
                </option>
                {enabled.length > 1 && (
                  <option value="all">{t('全員に、順番に', 'Everyone, in turn')}</option>
                )}
                {enabled.map((bot) => (
                  <option key={bot.id} value={bot.id}>
                    {bot.name} · @{bot.handle}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} />
            </div>
            <div className="composer-input-wrap">
              <textarea
                ref={textRef}
                value={draft}
                rows={2}
                onChange={(e) => {
                  setDraft(e.target.value);
                  updateMention(e.target.value, e.target.selectionStart);
                }}
                onClick={(e) =>
                  updateMention(e.currentTarget.value, e.currentTarget.selectionStart)
                }
                placeholder={t(
                  'メッセージを入力。@で仲間に話しかける…',
                  'Share a thought. Use @ to bring in a teammate…',
                )}
                aria-label={t('メッセージ', 'Message')}
                aria-controls={mention && candidates.length ? 'mention-menu' : undefined}
                aria-expanded={!!mention && candidates.length > 0}
                onKeyDown={(e) => {
                  if (e.nativeEvent.isComposing) return;
                  if (mention && candidates.length) {
                    if (e.key === 'ArrowDown') {
                      e.preventDefault();
                      setMentionIndex((index) => (index + 1) % candidates.length);
                      return;
                    }
                    if (e.key === 'ArrowUp') {
                      e.preventDefault();
                      setMentionIndex(
                        (index) => (index - 1 + candidates.length) % candidates.length,
                      );
                      return;
                    }
                    if (e.key === 'Enter' || e.key === 'Tab') {
                      e.preventDefault();
                      chooseMention(candidates[mentionIndex]?.handle || candidates[0].handle);
                      return;
                    }
                    if (e.key === 'Escape') {
                      e.preventDefault();
                      setMention(null);
                      return;
                    }
                  }
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault();
                    void send();
                  }
                }}
              />
              {mention && candidates.length > 0 && (
                <div
                  className="mention-menu"
                  id="mention-menu"
                  role="listbox"
                  aria-label={t('仲間を選択', 'Mention a teammate')}
                >
                  <small>{t('会話に招く', 'BRING INTO THE CONVERSATION')}</small>
                  {candidates.map((bot, index) => (
                    <button
                      key={bot.id}
                      type="button"
                      role="option"
                      aria-selected={mentionIndex === index}
                      className={mentionIndex === index ? 'selected' : ''}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => chooseMention(bot.handle)}
                    >
                      <Avatar bot={bot} size="small" />
                      <strong>{bot.name}</strong>
                      <span>@{bot.handle}</span>
                      <small>{bot.role}</small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <div className="composer-toolbar">
              <IconButton
                type="button"
                icon={AtSign}
                label={t('仲間をメンション', 'Mention a teammate')}
                onClick={() => {
                  const cursor = textRef.current?.selectionStart || draft.length;
                  const prefix = draft.slice(0, cursor);
                  const insertion = `${prefix && !/\s$/.test(prefix) ? ' ' : ''}@`;
                  const next = `${prefix}${insertion}${draft.slice(cursor)}`;
                  setDraft(next);
                  updateMention(next, cursor + insertion.length);
                  requestAnimationFrame(() => {
                    textRef.current?.focus();
                    textRef.current?.setSelectionRange(
                      cursor + insertion.length,
                      cursor + insertion.length,
                    );
                  });
                }}
              />
              <span className="composer-member-count">
                {t(`${enabled.length}人の仲間`, `${enabled.length} teammates`)}
              </span>
              <button
                className="send-button"
                type="submit"
                aria-label={t('送信', 'Send message')}
                disabled={!draft.trim() || sending || !ready || !enabled.length}
              >
                <ArrowUp size={20} />
              </button>
            </div>
          </form>
          <div className="composer-hint">
            <span>
              <kbd>↵</kbd> {t('送信', 'send')} <span>·</span> <kbd>shift ↵</kbd>{' '}
              {t('改行', 'new line')}
            </span>
            <span>
              {data.settings.demoMode
                ? t('デモの応答はシミュレーションです', 'Demo responses are simulated')
                : null}
            </span>
          </div>
        </div>
      </section>
      {activityOpen && (
        <button
          className="activity-scrim"
          aria-label={t('アクティビティを閉じる', 'Close activity')}
          onClick={() => setActivityOpen(false)}
        />
      )}
      {activityOpen && (
        <aside
          id="activity-panel"
          className="activity-panel"
          aria-label={t('作業のアクティビティ', 'Work activity')}
        >
          <header className="activity-header">
            <div>
              <Activity size={16} />
              <h2>{t('アクティビティ', 'Activity')}</h2>
            </div>
            <IconButton
              icon={X}
              label={t('アクティビティを閉じる', 'Close activity')}
              onClick={() => setActivityOpen(false)}
            />
          </header>
          <div className="activity-scroll">
            <div className="queue-card">
              <span className="eyebrow">{t('ワークスペースの推論', 'MODEL QUEUE')}</span>
              <div>
                <strong>
                  {data.queue.active}
                  <small>/ 1</small>
                </strong>
                <span>{t('実行中', 'active')}</span>
                <span className="queue-divider" />
                <strong>{data.queue.waiting}</strong>
                <span>{t('順番待ち', 'queued')}</span>
              </div>
              <p>{t('タスクは順番に実行します。', 'Tasks run sequentially.')}</p>
            </div>
            <div className="panel-section-title">
              {t('このルームの仲間', 'IN THIS ROOM')}
              <span>{members.length}</span>
            </div>
            <div className="panel-members">
              {members.map((bot) => {
                const task = active.find((item) => item.botId === bot.id);
                return (
                  <button
                    key={bot.id}
                    onClick={() => {
                      setRecipient(bot.id);
                      textRef.current?.focus();
                    }}
                    disabled={!bot.enabled}
                  >
                    <Avatar bot={bot} size="small" />
                    <span>
                      <strong>{bot.name}</strong>
                      <small>
                        {task
                          ? statusLabel(task.status, locale)
                          : bot.enabled
                            ? bot.role
                            : t('無効', 'Disabled')}
                      </small>
                    </span>
                    <span
                      className={`connection-dot ${task ? 'working' : bot.enabled ? 'online' : ''}`}
                    />
                  </button>
                );
              })}
            </div>
            <div className="panel-section-title">
              {t('作業の記録', 'LIVE ACTIVITY')}
              <span className="live-indicator" />
            </div>
            {!activities.length ? (
              <div className="activity-empty">
                <Activity size={24} strokeWidth={1.2} />
                <p>{t('作業ログはありません', 'No activity yet')}</p>
                <span>
                  {t(
                    'ツールの実行、承認、引き継ぎを時系列で確認できます。',
                    'Tools, approvals, and handoffs will appear here as they happen.',
                  )}
                </span>
              </div>
            ) : (
              <div className="activity-timeline">
                {activities.map((item) => (
                  <div className={`timeline-item timeline-${item.status}`} key={item.id}>
                    <span className="timeline-marker">
                      {item.status === 'success' ? (
                        <Check size={10} />
                      ) : item.status === 'error' ? (
                        <X size={10} />
                      ) : (
                        <span />
                      )}
                    </span>
                    <div className="timeline-time">
                      {data.bots.find((bot) => bot.id === item.botId)?.name}
                      <time>{dateLabel(item.createdAt, locale)}</time>
                    </div>
                    <strong>{activityTitle(item, locale)}</strong>
                    {item.detail && (
                      <details>
                        <summary>{t('内容を確認', 'View details')}</summary>
                        <pre>{item.detail}</pre>
                      </details>
                    )}
                  </div>
                ))}
              </div>
            )}
            {tasks.length > 0 && (
              <>
                <div className="panel-section-title">{t('最近のタスク', 'RECENT TASKS')}</div>
                <div className="panel-tasks">
                  {tasks
                    .slice(-8)
                    .reverse()
                    .map((task) => (
                      <div key={task.id}>
                        <Status status={task.status} />
                        <p>{task.prompt}</p>
                        <small>
                          {task.inputTokens + task.outputTokens > 0
                            ? `${(task.inputTokens + task.outputTokens).toLocaleString()} tokens · `
                            : ''}
                          {dateLabel(task.createdAt, locale)}
                        </small>
                      </div>
                    ))}
                </div>
              </>
            )}
          </div>
          <footer className="activity-footer">
            <ShieldCheck size={14} />
            {t('最近の60件まで表示', 'Up to 60 recent events')}
          </footer>
        </aside>
      )}
      {edit && <RoomDialog room={room} onClose={() => setEdit(false)} />}
      {archive && (
        <Confirm
          title={t('ルームをアーカイブしますか？', 'Archive this room?')}
          onClose={() => setArchive(false)}
          onConfirm={async () => {
            await mutate(`/rooms/${room.id}`, 'PATCH', { archived: true });
          }}
        >
          {t(
            '会話は保存されます。サイドバーの「アーカイブ」から、いつでも戻せます。',
            'Your conversation stays saved. You can restore it from Archived in the sidebar.',
          )}
        </Confirm>
      )}
    </div>
  );
}

const MessageItem = memo(
  function MessageItem({
    message,
    bot,
    completed,
    locale,
  }: {
    message: Message;
    bot?: Bot;
    completed: boolean;
    locale: Locale;
  }) {
    const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
    if (message.authorType === 'system')
      return (
        <div className="system-message">
          <Sparkles size={13} />
          <span>{message.body}</span>
        </div>
      );
    return (
      <motion.article
        initial={{ opacity: 0, y: 5 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ duration: 0.18 }}
        className={`message message-${message.authorType}`}
      >
        <div className="message-avatar">
          {message.authorType === 'user' ? (
            <span className="user-avatar">{t('私', 'Y')}</span>
          ) : (
            <Avatar bot={bot} />
          )}
        </div>
        <div className="message-main">
          <header>
            <strong>
              {message.authorType === 'user'
                ? t('あなた', 'You')
                : bot?.name || t('仲間', 'Teammate')}
            </strong>
            {message.authorType === 'bot' && <span className="message-role">{bot?.role}</span>}
            <time>{dateLabel(message.createdAt, locale)}</time>
            <div className="message-copy">
              <CopyButton text={message.body} />
            </div>
          </header>
          {message.authorType === 'bot' && message.taskId && (
            <RunProgress taskId={message.taskId} message={message} />
          )}
          {message.body ? (
            <div className="message-answer">
              <Markdown>{message.body}</Markdown>
            </div>
          ) : message.status === 'streaming' && !message.taskId ? (
            <span className="typing-dots" aria-label={t('応答を生成中', 'Generating a response')}>
              <i />
              <i />
              <i />
            </span>
          ) : null}
          {message.status === 'streaming' && message.body && <span className="stream-cursor" />}
          {message.status === 'error' && (
            <small className="form-error">
              {t(
                '応答が中断されました。タスクから再開できます。',
                'The response was interrupted. Resume from the task card.',
              )}
            </small>
          )}
          {completed && !message.taskId && (
            <div className="message-complete">
              <Check size={12} />
              {t('完了', 'Done')}
            </div>
          )}
        </div>
      </motion.article>
    );
  },
  (previous, next) =>
    previous.locale === next.locale &&
    previous.completed === next.completed &&
    previous.message.id === next.message.id &&
    previous.message.body === next.message.body &&
    previous.message.status === next.message.status &&
    previous.message.taskId === next.message.taskId &&
    previous.message.reasoning === next.message.reasoning &&
    previous.message.reasoningStatus === next.message.reasoningStatus &&
    previous.message.reasoningTruncated === next.message.reasoningTruncated &&
    previous.message.authorType === next.message.authorType &&
    previous.message.authorId === next.message.authorId &&
    previous.message.createdAt === next.message.createdAt &&
    previous.bot?.name === next.bot?.name &&
    previous.bot?.role === next.bot?.role &&
    previous.bot?.color === next.bot?.color &&
    previous.bot?.avatar === next.bot?.avatar,
);
