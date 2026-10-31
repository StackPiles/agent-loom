import type { Message, QueueState, Snapshot, Task, TaskStatus } from '../shared/types';

export const activeTaskStatuses: TaskStatus[] = [
  'queued',
  'running',
  'waiting_model',
  'waiting_tool',
  'awaiting_approval',
];
export type TaskPhase =
  | 'queued'
  | 'waiting_model'
  | 'preparing'
  | 'thinking'
  | 'generating'
  | 'tool'
  | 'approval'
  | 'stopped'
  | 'interrupted'
  | 'failed'
  | 'completed'
  | 'unconfirmed';
export interface TaskPresentation {
  phase: TaskPhase;
  label: string;
  detail: string;
  animated: boolean;
  /** Last observed server state is nonterminal; not a connection heartbeat. */
  active: boolean;
  resumable: boolean;
}
type WaitingReason = NonNullable<QueueState['waitingTasks']>[number]['reason'];
export interface TaskPresentationOptions {
  message?: Pick<Message, 'status' | 'body' | 'reasoning' | 'reasoningStatus'>;
  waitingReason?: WaitingReason;
  hasPendingApproval?: boolean;
  connected?: boolean;
}

/** Task state wins over stale streaming flags. Only the latest run's message is relevant. */
export function getTaskPresentation(
  status: TaskStatus,
  locale: 'ja' | 'en',
  options: TaskPresentationOptions = {},
): TaskPresentation {
  const t = (ja: string, en: string) => (locale === 'ja' ? ja : en);
  const active = activeTaskStatuses.includes(status);
  const resumable = ['stopped', 'interrupted', 'failed'].includes(status);
  const presentation = (
    phase: TaskPhase,
    ja: string,
    en: string,
    detailJa: string,
    detailEn: string,
    animated = false,
  ): TaskPresentation => ({
    phase,
    label: t(ja, en),
    detail: t(detailJa, detailEn),
    animated,
    active,
    resumable,
  });
  if (status === 'stopped')
    return presentation(
      'stopped',
      '停止済み',
      'Stopped',
      '作業を停止しました。再開できます。',
      'Work has stopped. You can resume it.',
    );
  if (status === 'interrupted')
    return presentation(
      'interrupted',
      '中断・再開できます',
      'Interrupted · resumable',
      '作業が中断しました。内容を確認して再開できます。',
      'Work was interrupted. Review it before resuming.',
    );
  if (status === 'failed')
    return presentation(
      'failed',
      'エラーで終了',
      'Failed',
      'エラーで終了しました。詳細を確認して再開できます。',
      'Work ended with an error. Review the details before resuming.',
    );
  if (status === 'completed')
    return presentation(
      'completed',
      '完了',
      'Completed',
      'この作業は完了しました。',
      'This task is complete.',
    );
  if (options.connected === false)
    return presentation(
      'unconfirmed',
      '状態を確認できません',
      'Status unconfirmed',
      '接続が切れています。表示は最後に受信した状態です。',
      'Connection lost. This is the last received state.',
    );
  if (options.hasPendingApproval || status === 'awaiting_approval')
    return presentation(
      'approval',
      '承認待ち',
      'Needs approval',
      'この操作について、あなたの許可・拒否を待っています。',
      'Waiting for you to approve or deny this action.',
    );
  if (options.waitingReason || status === 'queued' || status === 'waiting_model') {
    const reason = options.waitingReason ?? (status === 'waiting_model' ? 'inference' : 'worker');
    const reasons: Record<WaitingReason, [string, string, string, string]> = {
      inference: [
        '生成枠待ち',
        'Waiting for generation slot',
        '生成枠が空くのを待っています。',
        'Waiting for an available generation slot.',
      ],
      room: [
        'ルーム内の順番待ち',
        'Waiting for this room',
        'このルームの別の生成が終わるのを待っています。',
        'Waiting for another response in this room to finish generating.',
      ],
      session: [
        '前の作業を待機中',
        'Waiting for previous task',
        'このボットの前の作業が終わるのを待っています。',
        'Waiting for this bot’s previous task in the room to finish.',
      ],
      worker: [
        '順番待ち',
        'Queued',
        '実行枠が空くのを待っています。',
        'Waiting for an available task worker.',
      ],
    };
    return presentation(reason === 'inference' ? 'waiting_model' : 'queued', ...reasons[reason]);
  }
  if (status === 'waiting_tool')
    return presentation(
      'tool',
      'ツール実行中',
      'Running a tool',
      'ツールの処理結果を待っています。',
      'Waiting for the tool to finish.',
      true,
    );
  const message = options.message;
  if (
    message?.status === 'streaming' &&
    message.reasoningStatus === 'streaming' &&
    message.reasoning
  )
    return presentation(
      'thinking',
      '思考を生成中',
      'Generating reasoning',
      'モデルから思考のテキストを受信しています。',
      'Receiving reasoning text from the model.',
      true,
    );
  if (message?.status === 'streaming' && message.body)
    return presentation(
      'generating',
      '回答を生成中',
      'Generating response',
      'モデルから回答のテキストを受信しています。',
      'Receiving response text from the model.',
      true,
    );
  if (message?.status === 'streaming')
    return presentation(
      'preparing',
      '生成準備中',
      'Preparing response',
      'モデルから次の出力を待っています。',
      'Waiting for the model’s next output.',
      true,
    );
  return presentation(
    'preparing',
    '実行中',
    'Running',
    '作業を実行しています。',
    'Work is in progress.',
    true,
  );
}

export function getTaskStatus(
  task: Task,
  data: Pick<Snapshot, 'messages' | 'approvals' | 'queue'>,
  locale: 'ja' | 'en',
  connected?: boolean,
): TaskPresentation {
  return getTaskPresentation(task.status, locale, {
    message: data.messages.findLast((item) => item.taskId === task.id && item.authorType === 'bot'),
    waitingReason: data.queue.waitingTasks?.find((item) => item.taskId === task.id)?.reason,
    hasPendingApproval: data.approvals.some(
      (item) => item.taskId === task.id && item.status === 'pending',
    ),
    connected,
  });
}
