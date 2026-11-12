import { memo, useEffect, useLayoutEffect, useRef, useState } from 'react';
import {
  BrainCircuit,
  Check,
  ChevronDown,
  Clock3,
  Copy,
  FolderOpen,
  LoaderCircle,
  MessageSquareText,
  MessageSquarePlus,
  ShieldCheck,
  Square,
  Wrench,
  X,
} from 'lucide-react';
import type { Activity, Message } from '../shared/types';
import { canAcceptTaskInput } from '../shared/task-inputs';
import { isTaskOutputMessage } from '../shared/message-context.js';
import { activeStatuses, dateLabel, useApp, type Locale } from './context';
import { Button, Markdown, Status } from './components';
import { ApprovalCard } from './ApprovalCard';
import { getTaskStatus } from './task-status';
import { TaskScheduling, taskQueueDetail } from './TaskScheduling';
import { TaskRecoveryActions } from './TaskRecovery';
import { getTaskWork } from './task-work';
import { isArchivedTask } from './TaskArchive';
import {
  activityDiagnostic,
  formatTaskDiagnostic,
  taskDiagnostic,
  taskErrorPresentation,
  type TaskDiagnostic,
} from './task-diagnostics';

function runOwnsEvent(message: Message | undefined, eventTime: string, siblings: Message[]) {
  if (!message) return siblings.length === 0;
  if (siblings.length <= 1) return true;
  // Legacy events have no messageId. Attribute them to one run, never every resume.
  const owner = siblings.filter((item) => item.createdAt <= eventTime).at(-1) || siblings[0];
  return owner.id === message.id;
}

export function RunProgress({
  taskId,
  message,
  onTaskInput,
}: {
  taskId: string;
  message?: Message;
  onTaskInput?: (taskId: string) => void;
}) {
  const { data, t, locale, mutate, connected } = useApp();
  const task = data.tasks.find((item) => item.id === taskId);
  const inputRoom = task && data.rooms.find((item) => item.id === task.roomId);
  const inputBot = task && data.bots.find((item) => item.id === task.botId);
  const siblings = data.messages.filter(
    (item) => item.taskId === taskId && isTaskOutputMessage(item),
  );
  const currentRun = !message || siblings.at(-1)?.id === message.id;
  const currentMessage = message
    ? data.messages.find((item) => item.id === message.id) || message
    : undefined;
  const activities = data.activities.filter(
    (item) =>
      item.taskId === taskId &&
      (item.messageId
        ? item.messageId === message?.id
        : runOwnsEvent(message, item.createdAt, siblings)),
  );
  const approvals = data.approvals.filter(
    (item) => item.taskId === taskId && runOwnsEvent(message, item.createdAt, siblings),
  );
  const pending = approvals.filter((item) => item.status === 'pending');
  const decided = approvals.filter((item) => item.status !== 'pending');
  const running = !!task && currentRun && activeStatuses.includes(task.status);
  const resumable =
    !!task && currentRun && ['stopped', 'interrupted', 'failed'].includes(task.status);
  const [expanded, setExpanded] = useState(running || pending.length > 0);
  const [busy, setBusy] = useState(false);
  if (!task && !activities.length && !approvals.length && !currentMessage?.reasoning) return null;
  const latest = activities.at(-1);
  const waiting = running
    ? data.queue.waitingTasks?.find((item) => item.taskId === taskId)
    : undefined;
  const presentation = task ? getTaskStatus(task, data, locale, connected) : undefined;
  const liveReasoning = currentRun && presentation?.phase === 'thinking';
  const reasoningPhase = liveReasoning
    ? 'streaming'
    : currentMessage?.reasoningStatus === 'interrupted' ||
        (currentMessage?.reasoningStatus === 'streaming' &&
          (currentMessage.status === 'error' ||
            (currentRun && !!task && ['stopped', 'interrupted', 'failed'].includes(task.status))))
      ? 'interrupted'
      : running && connected === false
        ? 'unconfirmed'
        : 'complete';
  const waitingLabels = {
    paused: presentation?.detail,
    inference: t('生成枠が空くのを待っています。', 'Waiting for an available generation slot.'),
    room: t(
      'このルームの別の生成が終わるのを待っています。',
      'Waiting for another response in this room to finish generating.',
    ),
    session: t(
      'このボットの前の作業が終わるのを待っています。',
      'Waiting for this bot’s previous task in the room to finish.',
    ),
    worker:
      presentation?.detail ||
      t('実行中の作業が進むのを待っています。', 'Waiting for an available task worker.'),
  };
  return (
    <section
      className="run-progress"
      data-task-id={taskId}
      data-run-message-id={message?.id}
      data-current-run={currentRun}
      aria-label={t('この実行の進捗', 'Run progress')}
    >
      <div className="run-status-line">
        <span className="run-status-label">{t('実行状況', 'Task')}</span>
        {task && currentRun ? (
          <Status status={task.status} presentation={presentation} />
        ) : (
          <span className="run-history-status">
            {currentMessage?.status === 'error'
              ? t('この実行は中断済み', 'Previous run interrupted')
              : t('この実行は終了済み', 'Previous run finished')}
          </span>
        )}
        {task && currentRun && isArchivedTask(task) && (
          <span className="task-archived-label">{t('履歴へ移動済み', 'Archived')}</span>
        )}
        {currentRun &&
          task &&
          !data.settings.demoMode &&
          canAcceptTaskInput(task) &&
          onTaskInput && (
            <Button
              variant="ghost"
              icon={MessageSquarePlus}
              className="task-input-action"
              disabled={
                connected === false ||
                !inputBot?.enabled ||
                !inputRoom?.botIds.includes(inputBot.id) ||
                !!inputRoom.archived
              }
              aria-label={t('この作業に追加指示', 'Add an instruction to this task')}
              data-task-input-action={taskId}
              onClick={() => onTaskInput(taskId)}
            >
              {t('追加指示', 'Add instruction')}
            </Button>
          )}
        {task && resumable && <TaskRecoveryActions task={task} />}
        {running && (
          <Button
            variant="ghost"
            icon={Square}
            busy={busy}
            disabled={connected === false}
            title={t('この作業だけを今すぐ中断', 'Stop only this task immediately')}
            aria-label={t('この作業を今すぐ中断', 'Stop this task now')}
            onClick={async () => {
              setBusy(true);
              try {
                await mutate(`/tasks/${taskId}/stop`, 'POST');
              } catch {
              } finally {
                setBusy(false);
              }
            }}
          >
            {t('停止', 'Stop')}
          </Button>
        )}
      </div>
      {waiting && connected !== false && presentation?.phase !== 'approval' && (
        <p className="run-queue-reason" data-queue-reason={waiting.reason}>
          <Clock3 size={13} aria-hidden="true" />
          {task
            ? taskQueueDetail(task, data, locale) || waitingLabels[waiting.reason]
            : waitingLabels[waiting.reason]}
        </p>
      )}
      {task &&
        currentRun &&
        (!waiting || connected === false || presentation?.phase === 'approval') && (
          <p className={`run-state-detail run-state-${presentation?.phase}`}>
            {(connected !== false && taskQueueDetail(task, data, locale)) || presentation?.detail}
          </p>
        )}
      {task && running && <TaskScheduling task={task} />}
      {task?.error && currentRun && (
        <TaskDiagnosticPanel
          record={taskDiagnostic(
            data.version,
            task,
            currentMessage?.id || siblings.at(-1)?.id,
            getTaskWork(task, data),
          )}
        />
      )}
      {task?.workspacePath && (
        <div className="run-workspace" title={task.workspacePath}>
          <FolderOpen size={12} aria-hidden="true" />
          <span>{t('作業場所', 'Workspace')}</span>
          <code>{task.workspacePath}</code>
        </div>
      )}
      {currentMessage?.reasoning && (
        <Reasoning message={currentMessage} locale={locale} phase={reasoningPhase} />
      )}
      {activities.length > 0 && (
        <details
          className="run-steps"
          open={expanded}
          onToggle={(event) => setExpanded(event.currentTarget.open)}
        >
          <summary>
            <ChevronDown size={14} />
            <strong>{t(`作業ログ ${activities.length}件`, `${activities.length} steps`)}</strong>
            {!expanded && latest && (
              <span className="run-latest-step">{activityTitle(latest, locale)}</span>
            )}
          </summary>
          <ol>
            {activities.map((item) => (
              <li key={item.id}>
                <ActivityStep
                  activity={item}
                  locale={locale}
                  diagnosticVersion={data.version}
                  owningMessageId={message?.id}
                  runState={
                    running
                      ? connected === false
                        ? 'unconfirmed'
                        : waiting?.reason === 'paused'
                          ? 'paused'
                          : 'live'
                      : resumable || currentMessage?.status === 'error'
                        ? 'interrupted'
                        : 'finished'
                  }
                />
              </li>
            ))}
          </ol>
        </details>
      )}
      {pending.map((approval) => (
        <ApprovalCard key={approval.id} approval={approval} />
      ))}
      {decided.length > 0 && (
        <div className="approval-results">
          {decided.map((approval) => (
            <details
              className={`approval-result approval-result-${approval.status}`}
              key={approval.id}
            >
              <summary>
                {approval.status === 'approved' ? <Check size={13} /> : <X size={13} />}
                <span>
                  {approval.status === 'approved'
                    ? t('許可済み', 'Approved')
                    : approval.status === 'denied'
                      ? t('拒否済み', 'Denied')
                      : approval.cancellationReason === 'superseded'
                        ? t('追加指示により取り下げ', 'Withdrawn for the new instruction')
                        : t('取消済み', 'Cancelled')}
                </span>
                <code>{approval.toolName}</code>
                <span className="approval-result-target">{approval.target}</span>
                <ChevronDown size={13} />
              </summary>
              <pre>{JSON.stringify(approval.args, null, 2)}</pre>
            </details>
          ))}
        </div>
      )}
    </section>
  );
}

function TaskDiagnosticPanel({ record }: { record: TaskDiagnostic }) {
  const { locale, t } = useApp();
  const [copied, setCopied] = useState(false);
  const [copying, setCopying] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const text = formatTaskDiagnostic(record);
  const latestText = useRef(text);
  latestText.current = text;
  const presentation = taskErrorPresentation(record.error, locale);
  useEffect(() => {
    setCopied(false);
    setCopyFailed(false);
  }, [text]);

  async function copy() {
    setCopying(true);
    setCopied(false);
    setCopyFailed(false);
    try {
      if (typeof navigator.clipboard?.writeText !== 'function')
        throw new Error('Clipboard unavailable');
      await navigator.clipboard.writeText(text);
      if (latestText.current === text) setCopied(true);
    } catch {
      if (latestText.current === text) {
        setCopyFailed(true);
        setExpanded(true);
      }
    } finally {
      setCopying(false);
    }
  }

  return (
    <section
      className="run-diagnostic"
      data-task-diagnostics={record.source === 'task' ? 'current' : 'activity'}
      data-task-error-reason={presentation.reason}
      aria-label={t('この実行の診断', 'Diagnostics for this run')}
    >
      <div className="run-diagnostic-heading">
        <strong role="status">{presentation.title}</strong>
        <Button
          type="button"
          variant="ghost"
          icon={copied ? Check : Copy}
          busy={copying}
          data-copy-task-diagnostics=""
          aria-label={t('診断情報をコピー', 'Copy diagnostics')}
          onClick={() => void copy()}
        >
          {copied ? t('コピーしました', 'Copied') : t('診断情報をコピー', 'Copy diagnostics')}
        </Button>
      </div>
      {presentation.detail && <p className="run-diagnostic-summary">{presentation.detail}</p>}
      <p className="run-error" data-task-error="">
        {record.error}
      </p>
      {copyFailed && (
        <p className="run-diagnostic-copy-status" role="status">
          {t(
            'コピーできませんでした。下の診断情報を選択してコピーしてください。',
            'Could not copy. Select and copy the diagnostic text below.',
          )}
        </p>
      )}
      <details
        className="run-diagnostic-details"
        data-task-diagnostic-details=""
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>{t('診断情報を表示', 'Show diagnostics')}</summary>
        <pre
          data-task-diagnostic-text=""
          tabIndex={0}
          aria-label={t('診断情報', 'Diagnostic text')}
        >
          {text}
        </pre>
      </details>
    </section>
  );
}
const Reasoning = memo(
  function Reasoning({
    message,
    locale,
    phase,
  }: {
    message: Message;
    locale: Locale;
    phase: 'streaming' | 'complete' | 'interrupted' | 'unconfirmed';
  }) {
    const [expanded, setExpanded] = useState(phase === 'streaming');
    const scroll = useRef<HTMLDivElement>(null);
    const follow = useRef(true);
    const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
    useLayoutEffect(() => {
      if (follow.current && scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight;
    }, [message.reasoning, expanded]);
    return (
      <details
        className="reasoning-panel"
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <BrainCircuit size={15} />
          <strong>{t('モデルの推論', 'Model reasoning')}</strong>
          {phase === 'streaming' ? (
            <span className="reasoning-phase">
              <LoaderCircle className="spin" size={12} />
              {t('受信中', 'Streaming')}
            </span>
          ) : phase === 'interrupted' ? (
            <span className="reasoning-phase">{t('中断', 'Interrupted')}</span>
          ) : phase === 'unconfirmed' ? (
            <span className="reasoning-phase">{t('接続待ち', 'Connection lost')}</span>
          ) : null}
          <ChevronDown size={14} />
        </summary>
        <div
          className="reasoning-text"
          ref={scroll}
          onScroll={(event) => {
            const element = event.currentTarget;
            follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 35;
          }}
        >
          <Markdown>{message.reasoning || ''}</Markdown>
        </div>
        {message.reasoningTruncated && (
          <p className="reasoning-limit">
            {t('推論の表示上限に達しました。', 'The reasoning display limit was reached.')}
          </p>
        )}
      </details>
    );
  },
  (previous, next) =>
    previous.locale === next.locale &&
    previous.phase === next.phase &&
    previous.message.reasoning === next.message.reasoning &&
    previous.message.reasoningStatus === next.message.reasoningStatus &&
    previous.message.reasoningTruncated === next.message.reasoningTruncated,
);

export function activityTitle(activity: Activity, locale: Locale) {
  const imageActions: Record<string, [string, string]> = {
    'Generate an image': ['画像を生成', 'Generate an image'],
    'Edit an image': ['画像を編集', 'Edit an image'],
    'View an image': ['画像を確認', 'View an image'],
  };
  if (imageActions[activity.title]) return imageActions[activity.title][locale === 'ja' ? 0 : 1];
  if (activity.kind === 'approval' && activity.approvalRule) {
    const rules: Record<string, [string, string]> = {
      new_workspace_document: ['新規ドキュメントの作成', 'Create a new document'],
      public_web_read: ['公開ページの取得', 'Read a public page'],
      configured_web_search: ['設定済みのWeb検索', 'Use configured web search'],
      workspace_inspection: ['作業フォルダの確認', 'Inspect the workspace'],
    };
    const reason = rules[activity.approvalRule]?.[locale === 'ja' ? 0 : 1] || activity.approvalRule;
    return locale === 'ja' ? `自動承認: ${reason}` : `Automatically approved: ${reason}`;
  }
  if (activity.title === 'Starting Pi agent session') {
    return activity.status === 'success'
      ? locale === 'ja'
        ? '実行完了'
        : 'Run completed'
      : locale === 'ja'
        ? '実行開始'
        : 'Run started';
  }
  if (activity.title === 'Running the labelled demo')
    return locale === 'ja' ? 'デモ実行' : 'Demo run';
  if (activity.title === 'Reviewing a completed workflow')
    return locale === 'ja' ? '完了したタスクを確認' : 'Review completed task';
  return activity.title;
}

const ActivityStep = memo(
  function ActivityStep({
    activity,
    locale,
    diagnosticVersion,
    owningMessageId,
    runState,
  }: {
    activity: Activity;
    locale: Locale;
    diagnosticVersion: string;
    owningMessageId?: string;
    runState: 'live' | 'paused' | 'unconfirmed' | 'interrupted' | 'finished';
  }) {
    const [expanded, setExpanded] = useState(
      activity.status === 'running' || activity.status === 'pending',
    );
    const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
    const Icon =
      activity.kind === 'approval'
        ? ShieldCheck
        : activity.kind === 'progress'
          ? MessageSquareText
          : activity.kind === 'tool'
            ? Wrench
            : activity.status === 'error'
              ? X
              : Clock3;
    const labels = {
      running:
        runState === 'live'
          ? t('実行中', 'Running')
          : runState === 'paused'
            ? t('休止中', 'Paused')
            : runState === 'unconfirmed'
              ? t('状態未確認', 'Unconfirmed')
              : runState === 'interrupted'
                ? t('中断', 'Interrupted')
                : t('終了', 'Finished'),
      success: t('完了', 'Done'),
      error: t('エラー', 'Error'),
      pending: t('確認待ち', 'Pending'),
    };
    if (activity.kind === 'progress')
      return (
        <div className="run-note">
          <div className="run-note-heading">
            <Icon size={14} />
            <span>{t('途中経過', 'Progress update')}</span>
            <time>{dateLabel(activity.createdAt, locale)}</time>
          </div>
          <Markdown>{activity.detail}</Markdown>
        </div>
      );
    return (
      <details
        className={`run-step run-step-${activity.status}`}
        data-activity-id={activity.id}
        open={expanded}
        onToggle={(event) => setExpanded(event.currentTarget.open)}
      >
        <summary>
          <Icon size={14} />
          <span className="run-step-title">{activityTitle(activity, locale)}</span>
          <span className="run-step-status">{labels[activity.status]}</span>
          {activity.detail && <ChevronDown size={12} />}
        </summary>
        {activity.detail &&
          (activity.kind === 'status' && activity.status === 'error' ? (
            <TaskDiagnosticPanel
              record={activityDiagnostic(diagnosticVersion, activity, owningMessageId)}
            />
          ) : (
            <pre className="run-step-detail">{activity.detail}</pre>
          ))}
      </details>
    );
  },
  (previous, next) =>
    previous.locale === next.locale &&
    previous.diagnosticVersion === next.diagnosticVersion &&
    previous.owningMessageId === next.owningMessageId &&
    previous.runState === next.runState &&
    previous.activity.title === next.activity.title &&
    previous.activity.detail === next.activity.detail &&
    previous.activity.kind === next.activity.kind &&
    previous.activity.status === next.activity.status &&
    previous.activity.approvalRule === next.activity.approvalRule &&
    previous.activity.createdAt === next.activity.createdAt,
);
