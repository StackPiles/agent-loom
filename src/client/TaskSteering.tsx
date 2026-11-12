import { Check, Clock3, MessageSquarePlus, X } from 'lucide-react';
import type { Message, TaskInput } from '../shared/types';
import { IMAGE_INPUT_LIMITS, IMAGE_INPUT_MIME_TYPES } from '../shared/image-inputs';
import type { DraftChatImage } from './useChatImages';
import { useApp } from './context';

export interface TaskInputTarget {
  taskId: string;
  mode: 'boundary' | 'immediate';
  selectionId?: string;
}

export interface TaskInputSubmission {
  roomId: string;
  botId: string;
  target: TaskInputTarget;
  draft: string;
  images: Pick<DraftChatImage, 'id' | 'filename' | 'mimeType' | 'byteLength'>[];
  imageSessionId: string;
}

export interface TaskInputAttempt {
  requestId: string;
  signature: string;
  /** Older saved attempts retain their retry ID, but have no receipt evidence. */
  submission?: TaskInputSubmission;
}

const requestIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export function sameTaskInputSelection(left: TaskInputTarget | undefined, right: TaskInputTarget) {
  return (
    left?.taskId === right.taskId &&
    left.mode === right.mode &&
    left.selectionId === right.selectionId
  );
}

export function taskInputSignature(submission: TaskInputSubmission): string {
  return JSON.stringify([
    submission.target.taskId,
    submission.draft.trim(),
    submission.target.mode,
    submission.images.map((image) => [
      `${submission.imageSessionId}:${image.id}`,
      image.filename,
      image.mimeType,
      image.byteLength,
    ]),
  ]);
}

function isTaskInputSubmission(value: unknown): value is TaskInputSubmission {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const submission = value as TaskInputSubmission;
  const reference = (item: unknown) =>
    typeof item === 'string' && item.length > 0 && item.length <= 1024;
  return (
    reference(submission.roomId) &&
    reference(submission.botId) &&
    !!submission.target &&
    reference(submission.target.taskId) &&
    ['boundary', 'immediate'].includes(submission.target.mode) &&
    (submission.target.selectionId === undefined ||
      requestIdPattern.test(submission.target.selectionId)) &&
    typeof submission.draft === 'string' &&
    submission.draft.length <= 64_000 &&
    typeof submission.imageSessionId === 'string' &&
    requestIdPattern.test(submission.imageSessionId) &&
    Array.isArray(submission.images) &&
    submission.images.length <= IMAGE_INPUT_LIMITS.maxImages &&
    submission.images.every(
      (image) =>
        !!image &&
        reference(image.id) &&
        reference(image.filename) &&
        IMAGE_INPUT_MIME_TYPES.includes(image.mimeType) &&
        Number.isSafeInteger(image.byteLength) &&
        image.byteLength > 0 &&
        image.byteLength <= IMAGE_INPUT_LIMITS.maxImageBytes,
    )
  );
}

/** A receipt confirms acceptance only; pending/delivered never promises obedience. */
export function matchesTaskInputReceipt(
  attempt: TaskInputAttempt,
  input: TaskInput,
  messages: Message[],
): boolean {
  const submission = attempt.submission;
  if (
    !submission ||
    input.requestId !== attempt.requestId ||
    input.taskId !== submission.target.taskId ||
    input.roomId !== submission.roomId ||
    input.botId !== submission.botId ||
    input.mode !== submission.target.mode ||
    input.body !== submission.draft.trim() ||
    !['pending', 'delivered'].includes(input.status) ||
    (input.inputImageIds?.length ?? 0) !== submission.images.length
  )
    return false;
  if (!submission.images.length) return true;
  // Uploaded image IDs are assigned by the server. Bind their metadata to the
  // exact receipt's owner message, never to another image with a similar name.
  const message = messages.find((item) => item.id === input.messageId);
  return (
    !!message &&
    message.taskInputId === input.id &&
    message.taskId === input.taskId &&
    message.roomId === input.roomId &&
    message.authorType === 'user' &&
    message.authorId === 'user' &&
    message.body === input.body &&
    message.targetBotIds?.length === 1 &&
    message.targetBotIds[0] === input.botId &&
    message.attachments?.length === submission.images.length &&
    submission.images.every((image, index) => {
      const attachment = message.attachments![index];
      const filename = image.filename
        .split(/[\\/]/)
        .at(-1)!
        .replace(/[\x00-\x1f\x7f]/g, '')
        .trim();
      return (
        attachment.id === input.inputImageIds![index] &&
        attachment.filename === filename &&
        attachment.mimeType === image.mimeType &&
        attachment.byteLength === image.byteLength
      );
    })
  );
}

export function loadTaskInputTargets(): Record<string, TaskInputTarget> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('loom.task-input-targets') || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([, value]) =>
          value &&
          typeof value === 'object' &&
          typeof value.taskId === 'string' &&
          value.taskId.length > 0 &&
          value.taskId.length <= 1024 &&
          (value.mode === 'boundary' || value.mode === 'immediate') &&
          (value.selectionId === undefined ||
            (typeof value.selectionId === 'string' && requestIdPattern.test(value.selectionId))),
      ),
    );
  } catch {
    return {};
  }
}

export function loadTaskInputAttempts(): Record<string, TaskInputAttempt> {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem('loom.task-input-attempts') || '{}');
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return {};
    return Object.fromEntries(
      Object.entries(saved).filter(
        ([roomId, value]) =>
          value &&
          typeof value === 'object' &&
          typeof value.requestId === 'string' &&
          requestIdPattern.test(value.requestId) &&
          typeof value.signature === 'string' &&
          value.signature.length <= 64_000 &&
          (value.submission === undefined ||
            (isTaskInputSubmission(value.submission) &&
              value.submission.roomId === roomId &&
              taskInputSignature(value.submission) === value.signature)),
      ),
    );
  } catch {
    return {};
  }
}

export function saveTaskInputDrafts(key: 'targets' | 'attempts', value: object) {
  try {
    localStorage.setItem(`loom.task-input-${key}`, JSON.stringify(value));
  } catch {
    // Private browsing or full browser storage must not prevent an in-memory draft.
  }
}

export function newTaskInputRequestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function TaskInputTargetCard({
  roomId,
  target,
  eligible,
  busy,
  onClear,
  onMode,
}: {
  roomId: string;
  target: TaskInputTarget;
  eligible: boolean;
  busy: boolean;
  onClear: () => void;
  onMode: (mode: TaskInputTarget['mode']) => void;
}) {
  const { data, t } = useApp();
  const task = data.tasks.find((item) => item.id === target.taskId && item.roomId === roomId);
  const bot = data.bots.find((item) => item.id === task?.botId);
  const room = data.rooms.find((item) => item.id === roomId);
  const compacting =
    data.queue.scheduling?.find((item) => item.taskId === target.taskId)?.purpose === 'compaction';
  const immediateAvailable =
    eligible &&
    !room?.paused &&
    !compacting &&
    task?.status === 'running' &&
    !data.queue.waitingTasks?.some((item) => item.taskId === target.taskId);
  return (
    <section
      className="task-input-target"
      data-task-input-target={target.taskId}
      aria-label={t('追加指示の対象', 'Instruction target')}
    >
      <div className="task-input-target-heading">
        <MessageSquarePlus size={16} aria-hidden="true" />
        <div>
          <strong>
            {t(
              `${bot?.name || 'ボット'}の作業に追加指示`,
              `Add an instruction to ${bot?.name || 'the bot'}'s task`,
            )}
          </strong>
          <span className="task-input-target-prompt" title={task?.prompt}>
            {task?.prompt || t('元の作業を確認できません', 'Original task unavailable')}
          </span>
        </div>
        <button
          type="button"
          className="task-input-clear"
          disabled={busy}
          aria-label={t(
            '追加指示の対象を解除して新しい依頼にする',
            'Clear instruction target and start a new request',
          )}
          onClick={onClear}
        >
          <X size={14} aria-hidden="true" />
          {t('対象を解除', 'Clear target')}
        </button>
      </div>
      <p className="task-input-target-detail">
        {data.settings.demoMode
          ? t(
              '追加指示は接続したモデルで利用できます。デモでは新しい依頼を送ってください。',
              'Task instructions require a connected model. In demo mode, send a new request.',
            )
          : !eligible
            ? t(
                'この作業には追加できません。内容は保持しています。新しい依頼にする場合は対象を解除してください。',
                'This task cannot accept new instructions. Your draft is kept. Clear the target to start a new request.',
              )
            : room?.paused
              ? t(
                  '追加指示は保存し、ルームの再開後に渡します。',
                  'The instruction is saved and delivered after the room resumes.',
                )
              : compacting
                ? t(
                    '会話履歴を要約しています。要約の終了後に追加指示を渡します。',
                    'The conversation is being summarized. The instruction is delivered after summarization finishes.',
                  )
                : task?.status === 'awaiting_approval'
                  ? t(
                      '未実行の承認待ち操作を取り下げ、追加指示を含めて検討し直します。',
                      'The unissued action awaiting approval is withdrawn so the bot can reconsider with your instruction.',
                    )
                  : task?.status === 'waiting_tool'
                    ? t(
                        '実行中の処理が終わってから渡します。すでに実行した操作の結果は保持します。',
                        'Delivered after the current action finishes. Actions already taken remain recorded.',
                      )
                    : t(
                        'この作業の続きを変更します。本文の@メンションは宛先を増やしません。',
                        'Updates this task. Mentions in the message do not add recipients.',
                      )}
      </p>
      <label className="task-input-immediate">
        <input
          type="checkbox"
          checked={target.mode === 'immediate'}
          disabled={busy || !immediateAvailable}
          onChange={(event) => onMode(event.target.checked ? 'immediate' : 'boundary')}
        />
        <span>{t('すぐ反映', 'Apply now')}</span>
        <small>
          {t(
            '生成中の応答を止めて続行します。実行中のツールは完了を待ちます。',
            'Stops the current model response and continues. Running tools finish first.',
          )}
        </small>
      </label>
    </section>
  );
}

/** Delivery records a model input, not a guarantee that the model obeyed it. */
export function TaskInputNotice({ inputId }: { inputId: string }) {
  const { data, t, connected } = useApp();
  const input: TaskInput | undefined = data.taskInputs?.find((item) => item.id === inputId);
  if (!input)
    return (
      <p className="task-input-notice" data-task-input-id={inputId}>
        <MessageSquarePlus size={14} aria-hidden="true" />
        {t('この作業への追加指示', 'Additional instruction for this task')}
      </p>
    );
  const task = data.tasks.find((item) => item.id === input.taskId);
  const room = data.rooms.find((item) => item.id === input.roomId);
  const bot = data.bots.find((item) => item.id === input.botId);
  const held = room?.paused || ['stopped', 'interrupted', 'failed'].includes(task?.status || '');
  const detail =
    input.status === 'delivered'
      ? t('ボットに渡しました', 'Delivered to the bot')
      : input.status === 'cancelled'
        ? t('取り下げ済み・未反映', 'Cancelled · not delivered')
        : connected === false
          ? t(
              '受付済み・接続後に状況を確認します',
              'Received · delivery status unconfirmed while disconnected',
            )
          : held
            ? t('受付済み・再開後に渡します', 'Received · will deliver after resume')
            : task?.status === 'waiting_tool'
              ? t(
                  '受付済み・実行中の処理が終わるのを待っています',
                  'Received · waiting for the current action to finish',
                )
              : t('受付済み・ボットに渡すのを待っています', 'Received · waiting for delivery');
  const deliveryNote =
    input.reason === 'Image pixels were not included because conversation image input is disabled.'
      ? t('会話モデルの画像入力が無効なため、画像そのものは渡していません。', input.reason)
      : input.reason ===
          'The instruction text was delivered, but its image pixels could not be included within the current image policy and task budget.'
        ? t(
            '文章は渡しましたが、画像入力の設定・画像の取得状態・この作業の画像処理上限により、画像そのものは渡せませんでした。',
            input.reason,
          )
        : input.reason;
  const Icon = input.status === 'delivered' ? Check : input.status === 'cancelled' ? X : Clock3;
  return (
    <div
      className={`task-input-notice task-input-${input.status}`}
      data-task-input-id={input.id}
      data-task-input-status={input.status}
      data-task-input-task-id={input.taskId}
      role="status"
    >
      <Icon size={14} aria-hidden="true" />
      <span>
        <strong>
          {t('作業への追加指示', 'Task instruction')}
          {bot ? ` · ${bot.name}` : ''}
        </strong>
        <span>{detail}</span>
        {deliveryNote && <small className="task-input-delivery-note">{deliveryNote}</small>}
      </span>
    </div>
  );
}
