import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  Activity,
  Archive,
  ArrowDown,
  ArrowUp,
  Check,
  Compass,
  FolderOpen,
  Hash,
  ImageOff,
  ImagePlus,
  Info,
  Lightbulb,
  LoaderCircle,
  MoreHorizontal,
  PanelRightClose,
  PanelRightOpen,
  Pause,
  Pin,
  Play,
  Plus,
  Settings2,
  ShieldCheck,
  Sparkles,
  Users,
  X,
} from 'lucide-react';
import { motion } from 'motion/react';
import type { Bot, Message, Room } from '../shared/types';
import { canAcceptTaskInput } from '../shared/task-inputs';
import { modelImageInputEnabled } from '../shared/model-settings';
import {
  getMessageContext,
  isTaskOutputMessage,
  type MessageContext,
} from '../shared/message-context.js';
import { activeStatuses, dateLabel, useApp, type Locale } from './context';
import {
  Avatar,
  Button,
  Confirm,
  CopyButton,
  EmptyState,
  IconButton,
  Markdown,
  Modal,
  Status,
} from './components';
import { RoomDialog } from './RoomDialog';
import { ApprovalCard } from './ApprovalCard';
import { RunProgress, activityTitle } from './RunProgress';
import { isArchivedTask } from './TaskArchive';
import { TaskHistoryControls } from './TaskHistory';
import { GeneratedImages } from './GeneratedImages';
import { RoomActivity } from './RoomActivity';
import { RoomWorkSummary } from './AutonomousWork';
import { useChatScroll } from './useChatScroll';
import { NotificationReplyQuote } from './NotificationReplyQuote';
import { useChatImages } from './useChatImages';
import { ApiError } from './api';
import {
  loadTaskInputAttempts,
  loadTaskInputTargets,
  newTaskInputRequestId,
  saveTaskInputDrafts,
  TaskInputNotice,
  TaskInputTargetCard,
  type TaskInputTarget,
} from './TaskSteering';

type MentionCandidate = { kind: 'bot'; handle: string; bot: Bot } | { kind: 'all'; handle: 'all' };

export function Chat({
  room,
  focusMode = false,
  onOpenActivity,
}: {
  room?: Room;
  focusMode?: boolean;
  onOpenActivity?: () => void;
}) {
  const { data, t, locale, mutate, navigate, connected, toast } = useApp();
  const [edit, setEdit] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [archive, setArchive] = useState(false);
  const editRoom = () => {
    setDetailsOpen(false);
    setEdit(true);
  };
  const [activityOpen, setActivityOpen] = useState(
    () =>
      window.innerWidth > 1100 &&
      (localStorage.getItem('loom.activity')
        ? localStorage.getItem('loom.activity') === 'true'
        : true),
  );
  const activityVisible = activityOpen && !focusMode;
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
  const [taskInputTargets, setTaskInputTargets] = useState(loadTaskInputTargets);
  const taskInputTarget = room ? taskInputTargets[room.id] : undefined;
  const [initialTaskInputAttempts] = useState(loadTaskInputAttempts);
  const taskInputAttempts = useRef(initialTaskInputAttempts);
  const [taskInputErrors, setTaskInputErrors] = useState<Record<string, string | undefined>>({});
  const taskInputError = room ? taskInputErrors[room.id] : undefined;
  const [sendingRooms, setSendingRooms] = useState(new Set<string>());
  const sendLocks = useRef(new Set<string>());
  const sending = !!room && sendingRooms.has(room.id);
  const activeRoom = useRef(room?.id);
  activeRoom.current = room?.id;
  const chatImages = useChatImages(t);
  const draftImages = room ? (chatImages.drafts[room.id] ?? []) : [];
  const imageError = room ? chatImages.errors[room.id] : undefined;
  const imagesLoading = draftImages.some((image) => image.status === 'reading');
  const imagesInvalid = draftImages.some((image) => image.status !== 'ready');
  const imageInputEnabled = modelImageInputEnabled(data.settings);
  const [showImageHint, setShowImageHint] = useState(false);
  const [imageDragActive, setImageDragActive] = useState(false);
  const dragDepth = useRef(0);
  const imagePicker = useRef<HTMLInputElement>(null);
  const [changingRoom, setChangingRoom] = useState<string>();
  const roomChangeLocks = useRef(new Set<string>());
  const [mention, setMention] = useState<{ start: number; end: number; query: string } | null>(
    null,
  );
  const [mentionIndex, setMentionIndex] = useState(0);
  const [count, setCount] = useState(100);
  const [focusTaskId, setFocusTaskId] = useState<string>();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const composerInputRef = useRef<HTMLDivElement>(null);
  const roomMenuRef = useRef<HTMLDetailsElement>(null);
  const botsById = new Map(data.bots.map((bot) => [bot.id, bot]));
  const tasksById = new Map(data.tasks.map((task) => [task.id, task]));
  const inputTask = taskInputTarget ? tasksById.get(taskInputTarget.taskId) : undefined;
  const inputBot = inputTask ? botsById.get(inputTask.botId) : undefined;
  const inputTaskEligible =
    !data.settings.demoMode &&
    !!inputTask &&
    canAcceptTaskInput(inputTask) &&
    inputTask.roomId === room?.id &&
    !room?.archived &&
    !!inputBot?.enabled &&
    !!room?.botIds.includes(inputTask.botId);
  const members = data.bots.filter((bot) => room?.botIds.includes(bot.id));
  const enabled = members.filter((bot) => bot.enabled);
  const messages = data.messages.filter((message) => message.roomId === room?.id);
  const tasks = data.tasks.filter((task) => task.roomId === room?.id);
  const active = tasks.filter((task) => activeStatuses.includes(task.status));
  const pausedTasks = new Set(
    data.queue.waitingTasks?.filter((item) => item.reason === 'paused').map((item) => item.taskId),
  );
  const pausing =
    room?.paused && active.some((task) => task.status !== 'queued' && !pausedTasks.has(task.id));
  const pending = data.approvals.filter(
    (approval) => approval.roomId === room?.id && approval.status === 'pending',
  );
  const liveMessageIds = new Set(
    active
      .filter((task) => task.status === 'running' && !pausedTasks.has(task.id))
      .map(
        (task) =>
          messages.findLast((message) => message.taskId === task.id && isTaskOutputMessage(message))
            ?.id,
      ),
  );
  const visibleMessages = messages.slice(-count);
  const representedTasks = new Set(
    visibleMessages.filter(isTaskOutputMessage).map((message) => message.taskId),
  );
  // Settled runs stay at their original message, even outside the loaded window.
  const tasksWithOutput = new Set(
    messages.filter(isTaskOutputMessage).map((message) => message.taskId),
  );
  const standaloneTasks = tasks.filter(
    (task) =>
      !representedTasks.has(task.id) &&
      (activeStatuses.includes(task.status) ||
        (['interrupted', 'stopped', 'failed'].includes(task.status) &&
          !isArchivedTask(task) &&
          !tasksWithOutput.has(task.id))),
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
  const mentionQuery = mention?.query.toLowerCase() || '';
  const candidates: MentionCandidate[] = enabled
    .filter(
      (bot) =>
        bot.handle.toLowerCase() !== 'all' &&
        `${bot.handle} ${bot.name}`.toLowerCase().includes(mentionQuery),
    )
    .map((bot) => ({ kind: 'bot', handle: bot.handle, bot }));
  if (enabled.length && 'all 全員 all teammates'.includes(mentionQuery))
    candidates.push({ kind: 'all', handle: 'all' });
  const scroll = useChatScroll(room?.id, [
    ...messages.flatMap((message) => [
      message.id,
      message.body,
      message.reasoning,
      message.status,
      message.reasoningStatus,
      message.reasoningTruncated,
      message.attachments?.map((image) => image.id).join(','),
    ]),
    ...tasks.flatMap((task) => [task.id, task.status, task.error]),
    ...activities.flatMap((activity) => [
      activity.id,
      activity.title,
      activity.detail,
      activity.status,
    ]),
    ...pending.flatMap((approval) => [approval.id, approval.summary, approval.target]),
    ...(data.taskInputs ?? [])
      .filter((input) => input.roomId === room?.id)
      .flatMap((input) => [input.id, input.status, input.deliveredAt]),
  ]);
  const { scrollRef, contentRef } = scroll;
  useLayoutEffect(() => {
    setCount(100);
    setMention(null);
    setDetailsOpen(false);
    if (roomMenuRef.current) roomMenuRef.current.open = false;
    setFocusTaskId(undefined);
    setShowImageHint(false);
    setImageDragActive(false);
    dragDepth.current = 0;
  }, [room?.id]);
  useEffect(() => {
    localStorage.setItem('loom.drafts', JSON.stringify(drafts));
  }, [drafts]);
  useEffect(() => {
    saveTaskInputDrafts('targets', taskInputTargets);
  }, [taskInputTargets]);
  useEffect(() => {
    localStorage.setItem('loom.activity', String(activityOpen));
  }, [activityOpen]);
  useEffect(() => {
    const dismissRoomMenu = (event: Event) => {
      const menu = roomMenuRef.current;
      if (menu?.open && !event.composedPath().includes(menu)) menu.open = false;
    };
    document.addEventListener('pointerdown', dismissRoomMenu);
    document.addEventListener('click', dismissRoomMenu);
    document.addEventListener('focusin', dismissRoomMenu);
    return () => {
      document.removeEventListener('pointerdown', dismissRoomMenu);
      document.removeEventListener('click', dismissRoomMenu);
      document.removeEventListener('focusin', dismissRoomMenu);
    };
  }, []);
  useEffect(() => {
    if (!mention) return;
    const dismissMention = (event: Event) => {
      const path = event.composedPath();
      if (!path.includes(composerInputRef.current!)) setMention(null);
    };
    document.addEventListener('pointerdown', dismissMention);
    document.addEventListener('click', dismissMention);
    document.addEventListener('focusin', dismissMention);
    return () => {
      document.removeEventListener('pointerdown', dismissMention);
      document.removeEventListener('click', dismissMention);
      document.removeEventListener('focusin', dismissMention);
    };
  }, [!!mention]);
  useEffect(() => {
    const resize = () => {
      if (window.innerWidth <= 1100) setActivityOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (
        event.key !== 'Escape' ||
        event.defaultPrevented ||
        document.querySelector('dialog[open]')
      )
        return;
      if (roomMenuRef.current?.open) {
        event.preventDefault();
        roomMenuRef.current.open = false;
        roomMenuRef.current.querySelector('summary')?.focus();
        return;
      }
      setActivityOpen(false);
    };
    window.addEventListener('resize', resize);
    window.addEventListener('keydown', escape);
    return () => {
      window.removeEventListener('resize', resize);
      window.removeEventListener('keydown', escape);
    };
  }, []);
  useLayoutEffect(() => {
    if (!focusTaskId || !scrollRef.current) return;
    const target = [...scrollRef.current.querySelectorAll<HTMLElement>('[data-task-id]')]
      .filter((item) => item.dataset.taskId === focusTaskId)
      .at(-1);
    if (target) scroll.focusElement(target);
    setFocusTaskId(undefined);
  }, [focusTaskId, count, room?.id, scroll.focusElement]);
  useLayoutEffect(() => {
    const textarea = textRef.current;
    const input = composerInputRef.current;
    if (!textarea || !input) return;
    const resize = () => {
      textarea.style.height = '0px';
      const maxHeight = window.innerHeight <= 650 ? 96 : 160;
      textarea.style.height = `${textarea.value ? Math.max(42, Math.min(maxHeight, textarea.scrollHeight)) : 42}px`;
      textarea.style.overflowY =
        textarea.value && textarea.scrollHeight > maxHeight ? 'auto' : 'hidden';
    };
    resize();
    let width = input.getBoundingClientRect().width;
    const observer =
      typeof ResizeObserver === 'undefined'
        ? undefined
        : new ResizeObserver(() => {
            const nextWidth = input.getBoundingClientRect().width;
            if (nextWidth !== width) {
              width = nextWidth;
              resize();
            }
          });
    observer?.observe(input);
    window.addEventListener('resize', resize);
    return () => {
      observer?.disconnect();
      window.removeEventListener('resize', resize);
    };
  }, [draft, room?.id, activityVisible]);
  async function changeRoomPause() {
    if (!room || connected === false || roomChangeLocks.current.has(room.id)) return;
    const roomId = room.id;
    roomChangeLocks.current.add(roomId);
    setChangingRoom(roomId);
    try {
      await mutate(`/rooms/${roomId}/${room.paused ? 'resume' : 'pause'}`, 'POST');
    } catch {
      // The application mutation handler reports errors without changing the room state.
    } finally {
      roomChangeLocks.current.delete(roomId);
      setChangingRoom((current) => (current === roomId ? undefined : current));
    }
  }
  function focusTask(taskId: string) {
    const index = messages.findLastIndex(
      (message) => message.taskId === taskId && isTaskOutputMessage(message),
    );
    scroll.pause();
    if (index >= 0) setCount((current) => Math.max(current, messages.length - index));
    setFocusTaskId(taskId);
    if (window.innerWidth <= 1100) setActivityOpen(false);
  }
  const inputSelection = useRef({ room, data, connected });
  inputSelection.current = { room, data, connected };
  const selectTaskInput = useCallback((taskId: string) => {
    const current = inputSelection.current;
    const targetRoom = current.room;
    const task = current.data.tasks.find((item) => item.id === taskId);
    const bot = current.data.bots.find((item) => item.id === task?.botId);
    if (
      !targetRoom ||
      targetRoom.archived ||
      current.connected === false ||
      current.data.settings.demoMode ||
      sendLocks.current.has(targetRoom.id) ||
      !task ||
      task.roomId !== targetRoom.id ||
      !canAcceptTaskInput(task) ||
      !bot?.enabled ||
      !targetRoom.botIds.includes(bot.id)
    )
      return;
    setTaskInputTargets((previous) => ({
      ...previous,
      [targetRoom.id]:
        previous[targetRoom.id]?.taskId === taskId
          ? previous[targetRoom.id]
          : { taskId, mode: 'boundary' },
    }));
    setTaskInputErrors((previous) => ({ ...previous, [targetRoom.id]: undefined }));
    setMention(null);
    requestAnimationFrame(() => textRef.current?.focus());
  }, []);
  function clearTaskInputTarget() {
    if (!room || sendLocks.current.has(room.id)) return;
    const roomId = room.id;
    setTaskInputTargets((previous) => {
      const next = { ...previous };
      delete next[roomId];
      return next;
    });
    setTaskInputErrors((previous) => ({ ...previous, [roomId]: undefined }));
    delete taskInputAttempts.current[roomId];
    saveTaskInputDrafts('attempts', taskInputAttempts.current);
    requestAnimationFrame(() => textRef.current?.focus());
  }
  function changeTaskInputMode(mode: TaskInputTarget['mode']) {
    if (!room || !taskInputTarget || sendLocks.current.has(room.id)) return;
    setTaskInputTargets((previous) => ({ ...previous, [room.id]: { ...taskInputTarget, mode } }));
    setTaskInputErrors((previous) => ({ ...previous, [room.id]: undefined }));
  }
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
  function insertBotMention(botId: string) {
    const bot = enabled.find((candidate) => candidate.id === botId);
    if (!bot) return;
    if (bot.handle.toLowerCase() === 'all') {
      toast(
        t(
          'このボットの識別名「all」は全員宛てと重なります。ボット設定で識別名を変更してください。',
          'This bot uses the reserved identifier “all”. Rename its identifier in bot settings before mentioning it.',
        ),
        'error',
      );
      return;
    }
    const alreadyMentioned = [...draft.matchAll(/(?:^|\s)@([a-z][a-z0-9_-]*)/gi)].some(
      (match) => match[1].toLowerCase() === bot.handle.toLowerCase(),
    );
    const prefix = alreadyMentioned ? '' : `@${bot.handle} `;
    const start = (textRef.current?.selectionStart ?? draft.length) + prefix.length;
    const end = (textRef.current?.selectionEnd ?? draft.length) + prefix.length;
    if (prefix) setDraft(prefix + draft);
    setMention(null);
    requestAnimationFrame(() => {
      textRef.current?.focus();
      textRef.current?.setSelectionRange(start, end);
    });
  }
  function attachImages(files: File[]) {
    if (!room || sendLocks.current.has(room.id) || !files.length) return;
    if (!imageInputEnabled) {
      setShowImageHint(true);
      return;
    }
    setShowImageHint(false);
    chatImages.add(room.id, files);
  }
  async function send() {
    if (
      !room ||
      (!draft.trim() && !draftImages.length) ||
      sendLocks.current.has(room.id) ||
      !ready ||
      !enabled.length ||
      connected === false ||
      imagesInvalid ||
      (draftImages.length > 0 && !imageInputEnabled)
    )
      return;
    const roomId = room.id;
    const sentDraft = draft;
    const sentImages = [...draftImages];
    const target = taskInputTarget;
    // Image drafts have immutable IDs once read. Keep pixels in memory only;
    // the retry signature records their IDs and metadata, never their base64.
    const signature = target
      ? JSON.stringify([
          target.taskId,
          sentDraft.trim(),
          target.mode,
          sentImages.map((image) => [image.id, image.filename, image.mimeType, image.byteLength]),
        ])
      : undefined;
    const previousAttempt = taskInputAttempts.current[roomId];
    const isRetry = !!signature && previousAttempt?.signature === signature;
    if (target && !inputTaskEligible && !isRetry) {
      setTaskInputErrors((previous) => ({
        ...previous,
        [roomId]: t(
          'この作業には追加できません。内容は保持しています。対象を解除すると、新しい依頼として送れます。',
          'This task cannot accept more instructions. Your draft is kept. Clear the target to send a new request.',
        ),
      }));
      return;
    }
    const attempt =
      target && signature
        ? isRetry
          ? previousAttempt
          : {
              requestId: newTaskInputRequestId(),
              signature,
            }
        : undefined;
    if (attempt) {
      taskInputAttempts.current[roomId] = attempt;
      saveTaskInputDrafts('attempts', taskInputAttempts.current);
      setTaskInputErrors((previous) => ({ ...previous, [roomId]: undefined }));
    }
    sendLocks.current.add(roomId);
    // Follow on the explicit send gesture, not its eventual network completion:
    // a reader can still scroll away while the request is in flight.
    scroll.followLatest(roomId);
    setSendingRooms(new Set(sendLocks.current));
    try {
      await mutate(
        target ? `/tasks/${encodeURIComponent(target.taskId)}/inputs` : `/rooms/${roomId}/messages`,
        'POST',
        {
          body: sentDraft.trim(),
          ...(target && attempt ? { requestId: attempt.requestId, mode: target.mode } : {}),
          ...(sentImages.length
            ? {
                images: sentImages.map((image) => ({
                  filename: image.filename,
                  mimeType: image.mimeType,
                  data: image.data!,
                })),
              }
            : {}),
        },
      );
      // A later draft or another room must survive this request completing.
      setDrafts((current) =>
        (current[roomId] ?? '') === sentDraft ? { ...current, [roomId]: '' } : current,
      );
      chatImages.remove(
        roomId,
        sentImages.map((image) => image.id),
      );
      if (attempt && taskInputAttempts.current[roomId]?.requestId === attempt.requestId) {
        delete taskInputAttempts.current[roomId];
        saveTaskInputDrafts('attempts', taskInputAttempts.current);
      }
      if (activeRoom.current === roomId) setMention(null);
    } catch (error) {
      // The mutation handler reports the error. Retain all inputs for retry.
      if (target)
        setTaskInputErrors((previous) => ({
          ...previous,
          [roomId]:
            error instanceof ApiError && error.status === 409
              ? t(
                  '作業の状態が変わり、追加できませんでした。内容と対象は保持しています。対象を解除すると、新しい依頼として送れます。',
                  'The task changed and could not accept this instruction. Your draft and target are kept. Clear the target to send a new request.',
                )
              : t(
                  '受付を確認できませんでした。同じ内容で再送すると、同じ受付番号で確認します。',
                  'Receipt could not be confirmed. Resending unchanged content checks the same request.',
                ),
        }));
    } finally {
      sendLocks.current.delete(roomId);
      setSendingRooms(new Set(sendLocks.current));
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
    <div className={`chat-workspace ${activityVisible ? 'with-activity' : ''}`}>
      <section className="conversation conversation-compact" aria-label={room.name}>
        <header className="room-header">
          <div className="room-heading">
            <span className="room-symbol" aria-hidden="true">
              <Hash size={18} />
            </span>
            <h1 title={room.name}>{room.name}</h1>
            <button
              type="button"
              className="room-details-trigger"
              aria-label={t('ルームの詳細を表示', 'Show room details')}
              aria-haspopup="dialog"
              aria-expanded={detailsOpen}
              onClick={() => setDetailsOpen(true)}
            >
              <Info size={15} aria-hidden="true" />
              <span>{t('詳細', 'Details')}</span>
            </button>
          </div>
          <div className="room-header-actions">
            {members.length > 0 && (
              <button
                type="button"
                className="room-members-trigger"
                aria-label={t(
                  `${members.length}件の参加ボットを表示`,
                  `Show ${members.length} room members`,
                )}
                aria-haspopup="dialog"
                aria-expanded={detailsOpen}
                onClick={() => setDetailsOpen(true)}
              >
                <span className="avatar-stack" aria-hidden="true">
                  {members.slice(0, 4).map((bot) => (
                    <span key={bot.id} title={bot.name}>
                      <Avatar bot={bot} size="small" />
                    </span>
                  ))}
                </span>
                {members.length > 4 && <span>+{members.length - 4}</span>}
              </button>
            )}
            {room.paused && (
              <span
                className="room-pause-state"
                role="status"
                title={
                  connected === false
                    ? t(
                        '再接続後に最新の休止状態を確認します。',
                        'The room state will be checked after reconnecting.',
                      )
                    : pausing
                      ? t(
                          '実行中の生成・ツールが終わったら休止します。次の処理は開始しません。',
                          'The current generation or tool will finish. The next action waits until you resume the room.',
                        )
                      : t(
                          'ルームを休止しています。再開すると、途中の作業を続け、待機中の作業も順番に実行します。',
                          'The room is paused. Resume it to continue unfinished tasks and start queued work.',
                        )
                }
              >
                {connected === false
                  ? t('状態未確認', 'Unconfirmed')
                  : pausing
                    ? t('休止予約', 'Pausing')
                    : t('休止中', 'Paused')}
              </span>
            )}
            <IconButton
              icon={room.paused ? Play : Pause}
              label={
                room.paused
                  ? t('このルームを再開', 'Resume this room')
                  : t(
                      '現在の生成・ツール実行が終わったらルームを休止',
                      'Pause this room after the current generation or tool finishes',
                    )
              }
              disabled={changingRoom === room.id || connected === false || room.archived}
              aria-busy={changingRoom === room.id}
              className={room.paused ? 'is-active' : ''}
              onClick={() => void changeRoomPause()}
            />
            <details ref={roomMenuRef} className="room-menu">
              <summary aria-label={t('ルームの操作', 'Room actions')}>
                <MoreHorizontal size={20} />
              </summary>
              <div
                className="dropdown-menu"
                onClick={(event) => {
                  if (!(event.target instanceof Element) || !event.target.closest('button')) return;
                  if (roomMenuRef.current) {
                    roomMenuRef.current.open = false;
                    roomMenuRef.current.querySelector('summary')?.focus();
                  }
                }}
              >
                <button onClick={editRoom}>
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
            <button
              type="button"
              aria-label={t('アクティビティを表示・非表示', 'Toggle activity')}
              title={
                pending.length
                  ? t(
                      `アクティビティ · 承認待ち ${pending.length}件`,
                      `Activity · ${pending.length} pending approvals`,
                    )
                  : t('アクティビティを表示・非表示', 'Toggle activity')
              }
              onClick={() => {
                if (activityVisible) setActivityOpen(false);
                else {
                  setActivityOpen(true);
                  onOpenActivity?.();
                }
              }}
              aria-expanded={activityVisible}
              aria-controls="activity-panel"
              aria-describedby={pending.length ? 'room-activity-attention' : undefined}
              className={`icon-button room-activity-toggle${activityVisible ? ' is-active' : ''}${pending.length ? ' has-pending-approval' : ''}`}
            >
              {activityVisible ? <PanelRightClose size={18} /> : <PanelRightOpen size={18} />}
              {pending.length > 0 && (
                <>
                  <span className="room-attention-count" aria-hidden="true">
                    {pending.length}
                  </span>
                  <span className="visually-hidden" id="room-activity-attention" role="status">
                    {t(`承認待ち ${pending.length}件`, `${pending.length} pending approvals`)}
                  </span>
                </>
              )}
            </button>
          </div>
        </header>
        <RoomWorkSummary key={room.id} roomId={room.id} />
        <div
          className="message-scroll"
          ref={scrollRef}
          tabIndex={0}
          role="region"
          aria-label={t('会話のメッセージ', 'Conversation messages')}
        >
          <div className="message-content" ref={contentRef}>
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
                      onClick={() => insertBotMention(bot.id)}
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
                      scroll.pause();
                      setCount((value) => value + 100);
                    }}
                  >
                    {t('前のメッセージを表示', 'Load earlier messages')}
                  </button>
                )}
                {visibleMessages.map((message) => (
                  <MessageItem
                    key={message.id}
                    message={message}
                    bot={botsById.get(message.authorId)}
                    completed={
                      !!message.taskId && tasksById.get(message.taskId)?.status === 'completed'
                    }
                    contextLabel={describeMessageContext(
                      getMessageContext(message, tasksById),
                      botsById,
                      locale,
                    )}
                    locale={locale}
                    onTaskInput={selectTaskInput}
                    streaming={
                      connected !== false &&
                      message.status === 'streaming' &&
                      (!message.taskId || liveMessageIds.has(message.id))
                    }
                  />
                ))}
              </div>
            )}
            <TaskHistoryControls
              roomId={room.id}
              pendingTaskIds={standaloneTasks
                .filter((task) => !activeStatuses.includes(task.status))
                .map((task) => task.id)}
            />
            {standaloneTasks.length > 0 && (
              <div className="standalone-runs">
                {standaloneTasks.map((task) => (
                  <article
                    className="message message-bot message-standalone"
                    key={task.id}
                    data-scroll-anchor={`task:${task.id}`}
                  >
                    <div className="message-avatar">
                      <Avatar bot={data.bots.find((bot) => bot.id === task.botId)} />
                    </div>
                    <div className="message-main">
                      <header>
                        <strong>
                          {data.bots.find((bot) => bot.id === task.botId)?.name ||
                            t('ボット', 'Bot')}
                        </strong>
                        <time>{dateLabel(task.createdAt, locale)}</time>
                      </header>
                      <RunProgress
                        taskId={task.id}
                        onTaskInput={selectTaskInput}
                        message={data.messages.findLast(
                          (message) => message.taskId === task.id && isTaskOutputMessage(message),
                        )}
                      />
                    </div>
                  </article>
                ))}
              </div>
            )}
            {floatingApprovals.length > 0 && (
              <div className="inline-approvals" data-scroll-anchor="floating-approvals">
                {floatingApprovals.map((approval) => (
                  <ApprovalCard key={approval.id} approval={approval} />
                ))}
              </div>
            )}
            <div className="scroll-bottom-space" />
          </div>
        </div>
        <div className="composer-area">
          {!scroll.following && (messages.length > 0 || standaloneTasks.length > 0) && (
            <button
              type="button"
              className="jump-latest"
              title={t(
                '最新の内容へ移動して自動スクロールを再開',
                'Go to the latest content and resume following',
              )}
              onClick={() => scroll.followLatest()}
            >
              <ArrowDown size={14} />
              {scroll.hasUpdates && <span className="new-content-dot" aria-hidden="true" />}
              {scroll.hasUpdates
                ? t('更新あり · 最新へ', 'New activity · Jump to latest')
                : t('最新へ', 'Jump to latest')}
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
          {taskInputTarget && (
            <TaskInputTargetCard
              roomId={room.id}
              target={taskInputTarget}
              eligible={inputTaskEligible}
              busy={sending}
              onClear={clearTaskInputTarget}
              onMode={changeTaskInputMode}
            />
          )}
          <form
            className={`composer${imageDragActive ? ' composer-image-drag' : ''}`}
            onSubmit={(e) => {
              e.preventDefault();
              void send();
            }}
            onDragEnter={(event) => {
              if (!Array.from(event.dataTransfer.types).includes('Files')) return;
              event.preventDefault();
              dragDepth.current++;
              setImageDragActive(true);
            }}
            onDragOver={(event) => {
              if (!Array.from(event.dataTransfer.types).includes('Files')) return;
              event.preventDefault();
              event.dataTransfer.dropEffect = sending ? 'none' : 'copy';
            }}
            onDragLeave={(event) => {
              if (!Array.from(event.dataTransfer.types).includes('Files')) return;
              dragDepth.current = Math.max(0, dragDepth.current - 1);
              if (!dragDepth.current) setImageDragActive(false);
            }}
            onDrop={(event) => {
              if (!event.dataTransfer.files.length) return;
              event.preventDefault();
              dragDepth.current = 0;
              setImageDragActive(false);
              attachImages(Array.from(event.dataTransfer.files));
            }}
          >
            <input
              ref={imagePicker}
              className="composer-image-picker"
              type="file"
              accept="image/png,image/jpeg,image/webp"
              multiple
              hidden
              onChange={(event) => {
                const files = Array.from(event.currentTarget.files ?? []);
                event.currentTarget.value = '';
                attachImages(files);
              }}
            />
            <button
              type="button"
              className="composer-attach-button"
              aria-label={t('画像を添付', 'Attach images')}
              title={t(
                '画像を添付・貼り付け（PNG・JPEG・WebP）',
                'Attach or paste images (PNG, JPEG, WebP)',
              )}
              disabled={sending}
              onClick={() => {
                if (!imageInputEnabled) setShowImageHint(true);
                else imagePicker.current?.click();
              }}
            >
              <ImagePlus size={19} aria-hidden="true" />
            </button>
            <div ref={composerInputRef} className="composer-input-wrap">
              {draftImages.length > 0 && (
                <div className="composer-image-attachments">
                  <ul
                    className="composer-image-list"
                    aria-label={t('送信する画像', 'Images to send')}
                  >
                    {draftImages.map((image) => (
                      <li
                        key={image.id}
                        className="composer-image-item"
                        data-draft-image={image.id}
                      >
                        <div className="composer-image-thumb">
                          {image.status === 'reading' ? (
                            <LoaderCircle
                              size={22}
                              className="composer-image-loading"
                              aria-hidden="true"
                            />
                          ) : image.status === 'error' ? (
                            <ImageOff size={22} aria-hidden="true" />
                          ) : (
                            <img
                              src={`data:${image.mimeType};base64,${image.data}`}
                              alt={image.filename}
                            />
                          )}
                          <button
                            type="button"
                            className="composer-image-remove"
                            aria-label={t(`${image.filename}を削除`, `Remove ${image.filename}`)}
                            disabled={sending}
                            onClick={() => chatImages.remove(room.id, [image.id])}
                          >
                            <X size={12} aria-hidden="true" />
                          </button>
                        </div>
                        <span title={image.filename}>{image.filename}</span>
                        {image.status === 'error' && (
                          <small role="alert">
                            {t('読み込めませんでした', 'Could not read image')}
                          </small>
                        )}
                      </li>
                    ))}
                  </ul>
                  <span className="composer-image-count" role="status">
                    {imagesLoading
                      ? t('画像を読み込み中…', 'Reading images…')
                      : t(
                          `${draftImages.length}枚の画像`,
                          `${draftImages.length} image${draftImages.length === 1 ? '' : 's'}`,
                        )}
                  </span>
                </div>
              )}
              <textarea
                ref={textRef}
                value={draft}
                rows={1}
                onChange={(e) => {
                  setDraft(e.target.value);
                  updateMention(e.target.value, e.target.selectionStart);
                }}
                onClick={(e) =>
                  updateMention(e.currentTarget.value, e.currentTarget.selectionStart)
                }
                onPaste={(event) => {
                  const files = Array.from(event.clipboardData.files);
                  if (!files.length) return;
                  // Mixed clipboard content may include ordinary text; let the
                  // browser insert it while attaching the image separately.
                  if (!event.clipboardData.getData('text/plain')) event.preventDefault();
                  attachImages(files);
                }}
                placeholder={
                  taskInputTarget
                    ? t('この作業への追加指示を入力…', 'Add an instruction for this task…')
                    : room.paused
                      ? t(
                          'メッセージを入力。ルームの再開後に実行します…',
                          'Write a message. It will run when this room resumes…',
                        )
                      : t(
                          'メッセージを入力。@で仲間に話しかける…',
                          'Share a thought. Use @ to bring in a teammate…',
                        )
                }
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
                    if ((e.key === 'Enter' || e.key === 'Tab') && !e.shiftKey) {
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
                  {candidates.map((candidate, index) => (
                    <button
                      key={candidate.kind === 'bot' ? `bot:${candidate.bot.id}` : 'all'}
                      type="button"
                      role="option"
                      data-mention-handle={candidate.handle}
                      aria-label={
                        candidate.kind === 'bot'
                          ? `${candidate.bot.name} @${candidate.handle}`
                          : t('全員 @all', 'All teammates @all')
                      }
                      aria-selected={mentionIndex === index}
                      className={mentionIndex === index ? 'selected' : ''}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => chooseMention(candidate.handle)}
                    >
                      {candidate.kind === 'bot' ? (
                        <Avatar bot={candidate.bot} size="small" />
                      ) : (
                        <span className="avatar avatar-small mention-all-avatar" aria-hidden="true">
                          <Users size={18} />
                        </span>
                      )}
                      <strong>
                        {candidate.kind === 'bot' ? candidate.bot.name : t('全員', 'All teammates')}
                      </strong>
                      <span>@{candidate.handle}</span>
                      <small>
                        {candidate.kind === 'bot'
                          ? candidate.bot.role
                          : t('このルームの有効なボット全員', 'All enabled bots in this room')}
                      </small>
                    </button>
                  ))}
                </div>
              )}
            </div>
            <button
              className="send-button"
              type="submit"
              aria-label={
                taskInputTarget
                  ? t('追加指示を送信', 'Send task instruction')
                  : t('送信', 'Send message')
              }
              title={
                taskInputTarget
                  ? t('追加指示を送信', 'Send task instruction')
                  : room.paused
                    ? t(
                        '送信して待機。ルームの再開後に実行します。',
                        'Send to the queue. This runs after the room resumes.',
                      )
                    : t('送信', 'Send message')
              }
              aria-busy={sending}
              disabled={
                (!draft.trim() && !draftImages.length) ||
                sending ||
                !ready ||
                !enabled.length ||
                connected === false ||
                imagesInvalid ||
                (draftImages.length > 0 && !imageInputEnabled)
              }
            >
              <ArrowUp size={20} />
            </button>
          </form>
          {taskInputTarget && taskInputError && (
            <p className="task-input-error" role="alert">
              {taskInputError}
            </p>
          )}
          {imageError && (
            <p className="composer-image-error" role="alert">
              {imageError}
            </p>
          )}
          {!imageInputEnabled && (showImageHint || draftImages.length > 0) && (
            <div className="composer-image-hint" role="status">
              <span>
                {t(
                  '画像を送るには、画像対応の会話モデルを接続し、設定の「画像入力を有効にする」をオンにしてください。',
                  'To send images, connect an image-capable conversation model and turn on “Enable image input” in Settings.',
                )}
              </span>
              <button type="button" onClick={() => navigate('settings')}>
                {t('設定を開く', 'Open settings')}
              </button>
            </div>
          )}
          {data.settings.demoMode && (
            <div className="composer-hint">
              {t('デモの応答はシミュレーションです', 'Demo responses are simulated')}
            </div>
          )}
        </div>
      </section>
      {activityVisible && (
        <button
          className="activity-scrim"
          aria-label={t('アクティビティを閉じる', 'Close activity')}
          onClick={() => setActivityOpen(false)}
        />
      )}
      {activityVisible && (
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
            <RoomActivity
              key={room.id}
              roomId={room.id}
              onFocusTask={focusTask}
              onTaskInput={selectTaskInput}
              onSelectBot={(botId) => {
                insertBotMention(botId);
                if (window.innerWidth <= 1100) setActivityOpen(false);
              }}
            />
            <div className="queue-card">
              <span className="eyebrow">{t('全体の生成枠', 'GENERATION SLOTS')}</span>
              <div>
                <strong>
                  {data.queue.active}
                  <small>
                    / {data.queue.capacity ?? data.settings.inference?.maxConcurrentRequests ?? 1}
                  </small>
                </strong>
                <span>{t('使用中', 'in use')}</span>
                <span className="queue-divider" />
                <strong>{data.queue.waiting}</strong>
                <span>{t('待機中', 'waiting')}</span>
              </div>
              <p>
                {room.parallelResponses
                  ? t(
                      'このルームは複数の応答を同時に生成できます。',
                      'This room allows simultaneous responses.',
                    )
                  : t(
                      'このルームの生成は1件ずつ進みます。',
                      'This room generates one response at a time.',
                    )}
              </p>
              {data.queue.active >
                (data.queue.capacity ?? data.settings.inference?.maxConcurrentRequests ?? 1) && (
                <p role="status" className="queue-draining">
                  {t(
                    '上限の変更を反映中です。生成中の応答はそのまま継続します。',
                    'Applying a lower limit. Responses already generating will finish normally.',
                  )}
                </p>
              )}
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
                        {item.kind === 'progress' ? (
                          <Markdown>{item.detail}</Markdown>
                        ) : (
                          <pre>{item.detail}</pre>
                        )}
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
      {detailsOpen && (
        <Modal
          title={t('ルームの詳細', 'Room details')}
          description={room.name}
          onClose={() => setDetailsOpen(false)}
        >
          <div className="room-details">
            <section className="room-details-section">
              <h3>{t('このルームの目的', 'Room purpose')}</h3>
              <p className="room-details-description">
                {room.description || t('目的はまだ設定されていません。', 'No room purpose set.')}
              </p>
            </section>
            <section className="room-details-section">
              <h3>
                {t('参加するボット', 'Bots')}
                <span>{members.length}</span>
              </h3>
              {members.length > 0 ? (
                <ul className="room-details-members">
                  {members.map((bot) => (
                    <li key={bot.id}>
                      <Avatar bot={bot} size="small" />
                      <div>
                        <strong>{bot.name}</strong>
                        <small>@{bot.handle}</small>
                      </div>
                      {!bot.enabled && (
                        <span className="room-member-disabled">{t('無効', 'Disabled')}</span>
                      )}
                    </li>
                  ))}
                </ul>
              ) : (
                <p>{t('参加するボットはまだありません。', 'No bots have joined this room yet.')}</p>
              )}
            </section>
            <dl className="room-details-settings">
              <div>
                <dt>
                  <FolderOpen size={15} aria-hidden="true" />
                  {t('作業場所', 'Workspace folder')}
                </dt>
                <dd>
                  <button
                    type="button"
                    className="room-workspace-link"
                    title={room.workspacePath || data.settings.workspacePath}
                    aria-label={t('このルームの作業場所を変更', 'Change this room’s workspace')}
                    onClick={editRoom}
                  >
                    <span>{room.workspacePath || data.settings.workspacePath}</span>
                  </button>
                  <small>
                    {room.workspacePath
                      ? t('このルーム専用の作業場所', 'Workspace set for this room')
                      : t('全体設定の作業場所を使用', 'Using the default workspace')}
                  </small>
                </dd>
              </div>
              <div>
                <dt>{t('同時生成', 'Simultaneous responses')}</dt>
                <dd>
                  <button
                    type="button"
                    className="room-generation-link"
                    aria-label={t(
                      'このルームの同時生成を設定',
                      'Configure simultaneous responses in this room',
                    )}
                    onClick={editRoom}
                  >
                    {room.parallelResponses
                      ? t('同時生成を許可', 'Parallel responses allowed')
                      : t('ルーム内は順番に生成', 'One response at a time')}
                  </button>
                </dd>
              </div>
            </dl>
            {data.settings.demoMode && (
              <p className="room-details-demo">
                {t('デモの応答はシミュレーションです', 'Demo responses are simulated')}
              </p>
            )}
            <footer className="room-details-actions">
              <Button icon={Settings2} onClick={editRoom}>
                {t('ルームを編集', 'Edit room')}
              </Button>
            </footer>
          </div>
        </Modal>
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

interface MessageContextLabel {
  kind:
    'user-directed' | 'directed' | 'user-reply' | 'bot-reply' | 'automation' | 'learning' | 'room';
  label: string;
  title: string;
}

function describeMessageContext(
  context: MessageContext,
  bots: ReadonlyMap<string, Bot>,
  locale: Locale,
): MessageContextLabel {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const shared = t('ルーム内で共有される投稿です。', 'This post is shared with the room.');
  const botName = (id: string) => bots.get(id)?.name || t('不明なボット', 'Unknown bot');
  if (context.audience === 'user')
    return {
      kind: 'user-directed',
      label: t('→ あなた', '→ You'),
      title: t(
        'あなた宛てに送られたメッセージです。ルーム内で共有されます。',
        'This message was addressed to you. It is shared with the room.',
      ),
    };
  if (context.audience === 'bots') {
    const recipients = context.targetBotIds.map((id) => {
      const bot = bots.get(id);
      return bot ? `${bot.name} (@${bot.handle})` : botName(id);
    });
    return {
      kind: 'directed',
      label:
        context.targetBotIds.length === 1
          ? `→ ${botName(context.targetBotIds[0])}`
          : t(`→ ${context.targetBotIds.length}人`, `→ ${context.targetBotIds.length} bots`),
      title: t(
        `宛先: ${recipients.join('、')}。${shared}`,
        `To: ${recipients.join(', ')}. ${shared}`,
      ),
    };
  }
  switch (context.source.kind) {
    case 'user':
      return {
        kind: 'user-reply',
        label: t('あなたの依頼への回答', 'Reply to your request'),
        title: t(`あなたの依頼に対する回答です。${shared}`, `Reply to your request. ${shared}`),
      };
    case 'bot': {
      const requester = botName(context.source.botId);
      return {
        kind: 'bot-reply',
        label: t(`ボット依頼への回答 · ${requester}`, `Bot request reply · ${requester}`),
        title: t(
          `${requester}からの依頼に対する回答です。${shared}依頼元への自動返信ではありません。`,
          `Reply to a request from ${requester}. ${shared}This is not an automatic message back to the requester.`,
        ),
      };
    }
    case 'automation':
      return {
        kind: 'automation',
        label: t('自動実行の報告', 'Automation report'),
        title: t(`自動実行による報告です。${shared}`, `Report from an automation. ${shared}`),
      };
    case 'learning':
      return {
        kind: 'learning',
        label: t('学習の記録', 'Learning record'),
        title: t(`学習タスクの記録です。${shared}`, `Record from a learning task. ${shared}`),
      };
    default:
      return {
        kind: 'room',
        label: t('ルーム共有', 'Shared with room'),
        title: t(
          `${shared}宛先や依頼元を確定できる記録がありません。`,
          `${shared}No recorded recipient or verified request source is available.`,
        ),
      };
  }
}

const MessageItem = memo(
  function MessageItem({
    message,
    bot,
    completed,
    contextLabel,
    locale,
    streaming,
    onTaskInput,
  }: {
    message: Message;
    bot?: Bot;
    completed: boolean;
    contextLabel: MessageContextLabel;
    locale: Locale;
    streaming: boolean;
    onTaskInput: (taskId: string) => void;
  }) {
    const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
    const sender =
      message.authorType === 'user' ? t('あなた', 'You') : bot?.name || t('仲間', 'Teammate');
    if (message.authorType === 'system')
      return (
        <div
          className="system-message"
          data-message-id={message.id}
          data-scroll-anchor={`message:${message.id}`}
        >
          <Sparkles size={13} />
          <span>{message.body}</span>
        </div>
      );
    return (
      <motion.article
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ duration: 0.18 }}
        className={`message message-${message.authorType}`}
        data-message-id={message.id}
        data-scroll-anchor={`message:${message.id}`}
      >
        <div className="message-avatar">
          {message.authorType === 'user' ? (
            <span className="user-avatar">{t('私', 'Y')}</span>
          ) : (
            <Avatar bot={bot} />
          )}
        </div>
        <div className="message-main">
          <header className="message-header">
            <strong title={bot ? `${sender} (@${bot.handle}) · ${bot.role}` : sender}>
              {sender}
            </strong>
            <span
              className="message-context-badge"
              data-message-context={contextLabel.kind}
              title={contextLabel.title}
            >
              <span className="message-context-label" aria-hidden="true">
                {contextLabel.label}
              </span>
              <span className="visually-hidden">{contextLabel.title}</span>
            </span>
            <time>{dateLabel(message.createdAt, locale)}</time>
            <div className="message-copy">
              <CopyButton text={message.body} />
            </div>
          </header>
          {isTaskOutputMessage(message) && message.taskId && (
            <RunProgress taskId={message.taskId} message={message} onTaskInput={onTaskInput} />
          )}
          {message.authorType === 'user' && message.taskInputId && (
            <TaskInputNotice inputId={message.taskInputId} />
          )}
          {message.authorType === 'user' && message.notificationReply && (
            <NotificationReplyQuote reply={message.notificationReply} locale={locale} />
          )}
          {message.body ? (
            <div className="message-answer">
              <Markdown>{message.body}</Markdown>
            </div>
          ) : streaming && !message.taskId ? (
            <span className="typing-dots" aria-label={t('応答を生成中', 'Generating a response')}>
              <i />
              <i />
              <i />
            </span>
          ) : null}
          {!!message.attachments?.length && <GeneratedImages images={message.attachments} />}
          {streaming && message.body && <span className="stream-cursor" />}
          {message.status === 'error' && (
            <small className="form-error">
              {t(
                'この応答は完了しませんでした。実行状況で詳細を確認できます。',
                'This response did not finish. Check the run progress for details.',
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
    previous.contextLabel.kind === next.contextLabel.kind &&
    previous.contextLabel.label === next.contextLabel.label &&
    previous.contextLabel.title === next.contextLabel.title &&
    previous.streaming === next.streaming &&
    previous.onTaskInput === next.onTaskInput &&
    isTaskOutputMessage(previous.message) === isTaskOutputMessage(next.message) &&
    previous.message.id === next.message.id &&
    previous.message.body === next.message.body &&
    previous.message.status === next.message.status &&
    previous.message.taskId === next.message.taskId &&
    previous.message.taskInputId === next.message.taskInputId &&
    previous.message.reasoning === next.message.reasoning &&
    previous.message.reasoningStatus === next.message.reasoningStatus &&
    previous.message.reasoningTruncated === next.message.reasoningTruncated &&
    previous.message.attachments === next.message.attachments &&
    previous.message.notificationReply === next.message.notificationReply &&
    previous.message.authorType === next.message.authorType &&
    previous.message.authorId === next.message.authorId &&
    previous.message.createdAt === next.message.createdAt &&
    previous.bot?.name === next.bot?.name &&
    previous.bot?.handle === next.bot?.handle &&
    previous.bot?.role === next.bot?.role &&
    previous.bot?.color === next.bot?.color &&
    previous.bot?.avatar === next.bot?.avatar,
);
