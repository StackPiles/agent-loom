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
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Square,
  X,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { Approval, Bot, Message, Room } from '../shared/types';
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

export function Chat({ room }: { room?: Room }) {
  const { data, t, locale, mutate, navigate } = useApp();
  const [edit, setEdit] = useState(false);
  const [archive, setArchive] = useState(false);
  const [activityOpen, setActivityOpen] = useState(() =>
    localStorage.getItem('loom.activity')
      ? localStorage.getItem('loom.activity') === 'true'
      : window.innerWidth >= 1180,
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
  const recoverable = tasks
    .filter((task) => ['interrupted', 'stopped', 'failed'].includes(task.status))
    .slice(-3);
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
  useLayoutEffect(() => {
    if (sticky.current && scrollRef.current)
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
  }, [messages.length, messages.at(-1)?.body, pending.length, active.length, room?.id]);
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
          title={t('新しいことを、ここから。', 'Make room for something good.')}
          action={
            <Button variant="primary" icon={Plus} onClick={() => setEdit(true)}>
              {t('ルームをつくる', 'Create a room')}
            </Button>
          }
        >
          {t(
            '目的ごとにルームをつくり、AIの仲間たちと一緒に進めましょう。',
            'Create a room for your ideas, projects, and AI teammates.',
          )}
        </EmptyState>
        {edit && <RoomDialog onClose={() => setEdit(false)} />}
      </div>
    );
  const prompts = [
    {
      icon: Compass,
      label: t('一緒に調べる', 'Explore an idea'),
      detail: t('気になることを、深く。', 'Follow your curiosity.'),
      prompt: t(
        'あなたができることを教えて。調べものを一緒に進めたい。',
        'Tell me what you can do. I’d like to explore an idea together.',
      ),
    },
    {
      icon: Lightbulb,
      label: t('アイデアを育てる', 'Think it through'),
      detail: t('まだ曖昧でも、大丈夫。', 'Start with a rough thought.'),
      prompt: t(
        '新しいプロジェクトのアイデアを整理したい。まず、必要なことを質問して。',
        'Help me shape a new project idea. Ask me a few useful questions to start.',
      ),
    },
    {
      icon: ShieldCheck,
      label: t('動きを見てみる', 'See work in motion'),
      detail: t('作業と承認を、見える形に。', 'Every action, in the open.'),
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
                  t('ひとつの会話から、次の一歩へ。', 'From a conversation to your next step.')}
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
              className={activityOpen ? 'is-active' : ''}
            />
          </div>
        </header>
        <div className="room-context">
          <span className={`connection-dot ${active.length ? 'working' : 'online'}`} />
          <span>
            {active.length
              ? t(`${active.length}件の作業が進行中`, `${active.length} tasks in progress`)
              : t('いつでも、ここから。', 'Ready when you are.')}
          </span>
          <span className="context-separator">·</span>
          <span>{t('推論はひとつずつ', 'One model, one turn at a time')}</span>
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
          {!messages.length ? (
            <div className="chat-welcome">
              <div className="welcome-orbit">
                <span className="orbit-ring ring-one" />
                <span className="orbit-ring ring-two" />
                <span className="orbit-spark">✦</span>
                {members.slice(0, 3).map((bot, index) => (
                  <span key={bot.id} className={`orbit-avatar orbit-avatar-${index}`}>
                    <Avatar bot={bot} />
                  </span>
                ))}
              </div>
              <span className="eyebrow">
                {t('ここから、はじめよう', 'A SPACE TO THINK TOGETHER')}
              </span>
              <h2>{t('考える仲間を、\nひとつの場所に。', 'Good ideas\nkeep good company.')}</h2>
              <p>
                {t(
                  'ひらめきを話したり、仕事を任せたり。\nあなたのペースで、仲間と一歩ずつ。',
                  'A place to share a thought, hand off a task,\nand make a little progress together.',
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
              <div className="date-divider">
                <span>{dateLabel(messages[0].createdAt, locale, true)}</span>
              </div>
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
              {messages.slice(-count).map((message) => (
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
          {pending.length > 0 && (
            <div className="inline-approvals">
              {pending.map((approval) => (
                <ApprovalCard key={approval.id} approval={approval} />
              ))}
            </div>
          )}
          {recoverable.length > 0 && (
            <div className="recovery-list">
              {recoverable.map((task) => (
                <div className="recovery-card" key={task.id}>
                  <div>
                    <Status status={task.status} />
                    <p>
                      {data.bots.find((bot) => bot.id === task.botId)?.name} ·{' '}
                      {task.error || task.prompt.slice(0, 110)}
                    </p>
                  </div>
                  <Button
                    icon={Play}
                    onClick={() =>
                      void mutate(
                        `/tasks/${task.id}/resume`,
                        'POST',
                        undefined,
                        t('作業を再開しました', 'Task resumed'),
                      ).catch(() => {})
                    }
                  >
                    {t('再開', 'Resume')}
                  </Button>
                </div>
              ))}
            </div>
          )}
          {active.length > 0 && (
            <div className="active-work">
              <div className="working-glyph">
                <Sparkles size={17} />
              </div>
              <div>
                {active.slice(0, 3).map((task) => (
                  <div key={task.id}>
                    <strong>{data.bots.find((bot) => bot.id === task.botId)?.name}</strong>
                    <Status status={task.status} />
                  </div>
                ))}
              </div>
              <IconButton
                icon={Square}
                label={t('このルームの作業を停止', 'Stop work in this room')}
                onClick={() =>
                  void Promise.all(active.map((task) => mutate(`/tasks/${task.id}/stop`))).catch(
                    () => {},
                  )
                }
              />
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
                : t('あなたのモデル。あなたのワークスペース。', 'Your model. Your workspace.')}
            </span>
          </div>
        </div>
      </section>
      {activityOpen && (
        <aside className="activity-panel" aria-label={t('作業のアクティビティ', 'Work activity')}>
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
              <p>{t('ローカルモデルに、ひとつずつ。', 'One thoughtful turn at a time.')}</p>
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
                <p>{t('動きが、ここに見えてきます。', 'A clear view of what’s happening.')}</p>
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
                    <strong>{item.title}</strong>
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
            {t('何をするか、いつでも見える。', 'Every action has a trace.')}
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
          {message.body ? (
            <Markdown>{message.body}</Markdown>
          ) : message.status === 'streaming' ? (
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
          {completed && (
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
    previous.message.authorType === next.message.authorType &&
    previous.message.authorId === next.message.authorId &&
    previous.message.createdAt === next.message.createdAt &&
    previous.bot?.name === next.bot?.name &&
    previous.bot?.role === next.bot?.role &&
    previous.bot?.color === next.bot?.color &&
    previous.bot?.avatar === next.bot?.avatar,
);

export function ApprovalCard({ approval }: { approval: Approval }) {
  const { data, t, mutate } = useApp();
  const [busy, setBusy] = useState<'approve' | 'deny' | null>(null);
  const bot = data.bots.find((item) => item.id === approval.botId);
  async function decide(decision: 'approve' | 'deny') {
    setBusy(decision);
    try {
      await mutate(
        `/approvals/${approval.id}`,
        'POST',
        { decision },
        decision === 'approve'
          ? t('この操作を許可しました', 'This action was approved')
          : t('この操作を拒否しました', 'This action was denied'),
      );
    } catch {
    } finally {
      setBusy(null);
    }
  }
  return (
    <article className="approval-card">
      <div className="approval-card-header">
        <span className="approval-icon">
          <ShieldCheck size={19} />
        </span>
        <div>
          <span className="eyebrow">{t('あなたの確認が必要です', 'YOUR APPROVAL IS NEEDED')}</span>
          <h3>{approval.summary}</h3>
        </div>
      </div>
      <div className="approval-meta">
        <Avatar bot={bot} size="small" />
        <span>{bot?.name}</span>
        <code>{approval.toolName}</code>
      </div>
      <dl>
        <dt>{t('対象', 'Target')}</dt>
        <dd>{approval.target || t('下記の引数を参照', 'See arguments below')}</dd>
      </dl>
      <details className="approval-arguments" open>
        <summary>
          {t('実行する操作の詳細', 'Exact action details')}
          <ChevronDown size={14} />
        </summary>
        <pre>{JSON.stringify(approval.args, null, 2)}</pre>
      </details>
      <footer>
        <span>
          {t('許可はこの操作にのみ適用されます。', 'Approval applies to this action only.')}
        </span>
        <div>
          <Button
            icon={X}
            disabled={!!busy}
            busy={busy === 'deny'}
            onClick={() => void decide('deny')}
          >
            {t('拒否する', 'Deny')}
          </Button>
          <Button
            icon={Check}
            variant="primary"
            disabled={!!busy}
            busy={busy === 'approve'}
            onClick={() => void decide('approve')}
          >
            {t('許可する', 'Approve')}
          </Button>
        </div>
      </footer>
    </article>
  );
}
