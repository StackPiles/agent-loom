import { classifyTaskInterruption, type TaskInterruptionReason } from '../shared/task-interruption';
import type { Activity, Task, WorkItem } from '../shared/types';
import type { Locale } from './context';

export interface TaskDiagnostic {
  source: 'task' | 'activity';
  version: string;
  taskId: string;
  roomId: string;
  botId: string;
  workId?: string;
  /** The linked work's current state, not its state when this task failed. */
  workStatus?: WorkItem['status'];
  messageId?: string;
  activityId?: string;
  status: Task['status'] | Activity['status'];
  recordedAt: string;
  error: string;
}

/** Include the task's stored error, identifiers, and its linked work's current status. */
export function taskDiagnostic(
  version: string,
  task: Pick<Task, 'id' | 'roomId' | 'botId' | 'workId' | 'status' | 'updatedAt' | 'error'>,
  messageId?: string,
  work?: Pick<WorkItem, 'id' | 'roomId' | 'status'>,
): TaskDiagnostic {
  return {
    source: 'task',
    version,
    taskId: task.id,
    roomId: task.roomId,
    botId: task.botId,
    workId: task.workId,
    workStatus:
      work && work.id === task.workId && work.roomId === task.roomId ? work.status : undefined,
    messageId,
    status: task.status,
    recordedAt: task.updatedAt,
    error: task.error || '',
  };
}

/** A historical record must not inherit a resumed task's status, time, or error. */
export function activityDiagnostic(
  version: string,
  activity: Pick<
    Activity,
    'id' | 'taskId' | 'roomId' | 'botId' | 'messageId' | 'status' | 'createdAt' | 'detail'
  >,
  owningMessageId?: string,
): TaskDiagnostic {
  return {
    source: 'activity',
    version,
    taskId: activity.taskId,
    roomId: activity.roomId,
    botId: activity.botId,
    messageId: activity.messageId || owningMessageId,
    activityId: activity.id,
    status: activity.status,
    recordedAt: activity.createdAt,
    error: activity.detail,
  };
}

export function formatTaskDiagnostic(record: TaskDiagnostic): string {
  return [
    `Agent Loom version (current): ${record.version}`,
    `Task ID: ${record.taskId}`,
    `Room ID: ${record.roomId}`,
    `Bot ID: ${record.botId}`,
    ...(record.source === 'task' && record.workId ? [`Work ID: ${record.workId}`] : []),
    ...(record.source === 'task' && record.workId && record.workStatus
      ? [`Work status (current): ${record.workStatus}`]
      : []),
    ...(record.messageId ? [`Message ID: ${record.messageId}`] : []),
    ...(record.activityId ? [`Activity ID: ${record.activityId}`] : []),
    `${record.source === 'task' ? 'Task' : 'Activity'} status: ${record.status}`,
    `${record.source === 'task' ? 'Task updated' : 'Activity created'} at: ${record.recordedAt}`,
    'Error:',
    record.error,
  ].join('\n');
}

type ErrorReason =
  | TaskInterruptionReason
  | 'response_timeout'
  | 'idle_timeout'
  | 'connect_timeout'
  | 'headers_timeout'
  | 'body_timeout'
  | 'transport_timeout'
  | 'http_408'
  | 'http_504'
  | 'unknown_timeout'
  | 'unknown';

export interface TaskErrorPresentation {
  reason: ErrorReason;
  title: string;
  detail?: string;
}

const interruptionTitles: Record<TaskInterruptionReason, [string, string]> = {
  owner_stop: ['停止操作により停止しました', 'Stopped by request'],
  server_shutdown: ['サーバーの終了により中断しました', 'Interrupted by server shutdown'],
  process_sigint: ['SIGINTによるサーバー終了で中断しました', 'Interrupted by SIGINT'],
  process_sigterm: ['SIGTERMによるサーバー終了で中断しました', 'Interrupted by SIGTERM'],
  supervisor_shutdown: [
    '起動管理プロセスの終了要求により中断しました',
    'Interrupted by an application shutdown request',
  ],
  supervisor_disconnect: [
    '起動管理プロセスとの接続が切れて中断しました',
    'Interrupted after losing the supervisor connection',
  ],
  application_update: [
    '更新のための再起動により中断しました',
    'Interrupted for an application update',
  ],
  data_export: ['データ書き出しに伴う再起動で中断しました', 'Interrupted for data export'],
  data_restore: ['データ復元に伴う再起動で中断しました', 'Interrupted for data restoration'],
  startup_failure: [
    'サーバー起動の失敗により中断しました',
    'Interrupted by a server startup failure',
  ],
  unexpected: ['予期しないキャンセルにより中断しました', 'Execution was cancelled unexpectedly'],
};

/** Summarize only messages emitted by known Loom paths. Always retain the raw error. */
export function taskErrorPresentation(error: string, locale: Locale): TaskErrorPresentation {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const reason = classifyTaskInterruption(error);
  if (reason !== 'unknown')
    return {
      reason,
      title: t(...interruptionTitles[reason]),
      detail: t(
        '作業ログを確認してから再開できます。完了済みの操作は自動で再実行しません。',
        'Review the activity before resuming. Completed actions are not replayed automatically.',
      ),
    };

  const response = error.match(
    /^The model did not begin responding within (\d+(?:\.\d+)?) seconds after starting the request\./,
  );
  if (response)
    return {
      reason: 'response_timeout',
      title: t('初回応答の待機上限に達しました', 'First response timeout'),
      detail: t(
        `モデルへの要求開始から${response[1]}秒以内に出力が始まりませんでした。`,
        `No output began within ${response[1]} seconds of starting the model request.`,
      ),
    };
  const idle = error.match(/^The model stopped producing output for (\d+(?:\.\d+)?) seconds\./);
  if (idle)
    return {
      reason: 'idle_timeout',
      title: t('出力中の無応答時間の上限に達しました', 'Output idle timeout'),
      detail: t(
        `${idle[1]}秒間、新しい出力を受信できませんでした。`,
        `No new output was received for ${idle[1]} seconds.`,
      ),
    };

  const transport = [
    {
      reason: 'connect_timeout' as const,
      pattern:
        /^The connection to the model server timed out after (\d+(?:\.\d+)?) seconds \(UND_ERR_CONNECT_TIMEOUT\)\./,
      title: [
        'モデルサーバーへの接続がタイムアウトしました',
        'Model server connection timeout',
      ] as const,
    },
    {
      reason: 'headers_timeout' as const,
      pattern:
        /^The model server response headers timed out after (\d+(?:\.\d+)?) seconds \(UND_ERR_HEADERS_TIMEOUT\)\./,
      title: [
        '応答ヘッダーの受信がタイムアウトしました',
        'Model response headers timeout',
      ] as const,
    },
    {
      reason: 'body_timeout' as const,
      pattern:
        /^The model response stream timed out after (\d+(?:\.\d+)?) seconds \(UND_ERR_BODY_TIMEOUT\)\./,
      title: [
        '応答ストリームの受信がタイムアウトしました',
        'Model response stream timeout',
      ] as const,
    },
    {
      reason: 'transport_timeout' as const,
      pattern:
        /^The model transport reported a timeout after (\d+(?:\.\d+)?) seconds \((?:ETIMEDOUT|ESOCKETTIMEDOUT)\)\. The failing connection stage was not reported\./,
      title: [
        '通信処理がタイムアウトしました（段階は未報告）',
        'Transport timeout; stage not reported',
      ] as const,
    },
    {
      reason: 'unknown_timeout' as const,
      pattern:
        /^The model request timed out after (\d+(?:\.\d+)?) seconds, but its timeout source was not reported\./,
      title: [
        'タイムアウトの発生元は報告されていません',
        'The timeout source was not reported',
      ] as const,
    },
  ];
  for (const item of transport) {
    const match = error.match(item.pattern);
    if (match)
      return {
        reason: item.reason,
        title: t(item.title[0], item.title[1]),
        detail: t(
          `モデル要求開始から${match[1]}秒後に検出しました。`,
          `Detected ${match[1]} seconds after the model request started.`,
        ),
      };
  }
  const http = error.match(
    /^The model server or its gateway returned HTTP (408|504) after (\d+(?:\.\d+)?) seconds\./,
  );
  if (http)
    return {
      reason: http[1] === '408' ? 'http_408' : 'http_504',
      title: t(
        `モデルサーバーまたは中継サーバーがHTTP ${http[1]}を返しました`,
        `The model server or gateway returned HTTP ${http[1]}`,
      ),
      detail: t(
        `モデル要求開始から${http[2]}秒後に受信しました。`,
        `Received ${http[2]} seconds after the model request started.`,
      ),
    };
  return { reason: 'unknown', title: t('記録されたエラー', 'Recorded error') };
}
