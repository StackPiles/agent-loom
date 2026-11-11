import { createHash } from 'node:crypto';
import {
  sessionEntryToContextMessages,
  type AgentSession,
  type CustomMessageEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { ImageContent, TextContent } from '@earendil-works/pi-ai';
import { TaskInputSupersededError, type TaskInput } from '../../shared/task-inputs.js';
import type { ToolContext } from './contract.js';
import { chatImageInput } from './chat-image-input.js';
import { throwIfAborted } from './gate.js';

export const TASK_INPUT_CUSTOM_TYPE = 'loom.task_input.v1';

const fingerprint = (input: TaskInput) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.id,
        input.requestId,
        input.taskId,
        input.roomId,
        input.botId,
        input.sequence,
        input.body,
        input.inputImageIds ?? [],
        input.mode,
      ]),
    )
    .digest('hex');

interface InputReceipt {
  version: 1;
  taskId: string;
  inputId: string;
  fingerprint: string;
  reason?: string;
}

export interface TaskInputModelRequest {
  signal: AbortSignal;
  started(): void;
  dispatched(imageInputEnabled?: boolean): void;
  retrying(): void;
  finish(): void;
}

type InputMessages = Parameters<NonNullable<AgentSession['agent']['transformContext']>>[0];

const imageInputDisabledReason =
  'Image pixels were not included because conversation image input is disabled.';

/**
 * An input first enters Pi's durable transcript, then becomes delivered when a
 * conversational request is accepted by the server. These are separate states:
 * a parked/queued request has not supplied the instruction to the model yet.
 */
export class TaskInputControl {
  private readonly inserted = new Map<string, InputReceipt>();
  private projected = new Map<string, { hasImages: boolean }>();
  private model:
    { controller: AbortController; conversation: boolean; dispatched: boolean } | undefined;
  private modelSuperseded = false;

  constructor(private readonly context: ToolContext) {}

  private inputs(): TaskInput[] {
    const { host, task } = this.context;
    return (host.getSnapshot().taskInputs ?? [])
      .filter(
        (input) =>
          input.taskId === task.id &&
          input.roomId === task.roomId &&
          input.botId === task.botId &&
          input.status !== 'cancelled',
      )
      .sort((a, b) => a.sequence - b.sequence);
  }

  private uninjected(): TaskInput[] {
    return this.inputs().filter((input) => !this.inserted.has(input.id));
  }

  hasUninjected(): boolean {
    return this.uninjected().length > 0;
  }

  /** Preview the pending instructions restored after compaction, without writing receipts. */
  previewProjection(branch: SessionEntry[], messages: InputMessages): InputMessages {
    const pending = this.inputs().filter(
      (input) => input.status === 'pending' && this.inserted.has(input.id),
    );
    const matches = (value: unknown): TaskInput | undefined => {
      const receipt = value as Partial<InputReceipt> | undefined;
      return pending.find(
        (input) =>
          receipt?.version === 1 &&
          receipt.taskId === input.taskId &&
          receipt.inputId === input.id &&
          receipt.fingerprint === fingerprint(input),
      );
    };
    const present = new Set(
      messages.flatMap((message) => {
        if (message.role !== 'custom' || message.customType !== TASK_INPUT_CUSTOM_TYPE) return [];
        const input = matches(message.details);
        return input ? [input.id] : [];
      }),
    );
    if (pending.every((input) => present.has(input.id))) return messages;
    // The real transform restores this whole group in sequence order when a
    // compaction hides any member. Include that same content in its budget.
    const result = messages.filter(
      (message) =>
        !(
          message.role === 'custom' &&
          message.customType === TASK_INPUT_CUSTOM_TYPE &&
          matches(message.details)
        ),
    );
    for (const input of pending) {
      const source = branch.findLast(
        (entry): entry is CustomMessageEntry<InputReceipt> =>
          entry.type === 'custom_message' &&
          entry.customType === TASK_INPUT_CUSTOM_TYPE &&
          matches(entry.details)?.id === input.id,
      );
      if (!source)
        throw new Error('A pending task instruction is missing from its durable session history.');
      result.push(...sessionEntryToContextMessages(source));
    }
    return result;
  }

  /** Read the active branch, including entries summarized by compaction. */
  restore(session: AgentSession): void {
    const inputs = new Map(this.inputs().map((input) => [input.id, input]));
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== 'custom_message' || entry.customType !== TASK_INPUT_CUSTOM_TYPE) continue;
      const receipt = entry.details as Partial<InputReceipt> | undefined;
      if (!receipt || receipt.version !== 1 || receipt.taskId !== this.context.task.id) continue;
      const input = inputs.get(receipt.inputId ?? '');
      if (!input || receipt.fingerprint !== fingerprint(input)) continue;
      this.inserted.set(input.id, {
        version: 1,
        taskId: input.taskId,
        inputId: input.id,
        fingerprint: receipt.fingerprint,
        ...(typeof receipt.reason === 'string' ? { reason: receipt.reason.slice(0, 1000) } : {}),
      });
    }
    // Pi may compact again while preparing the next request, after inject() has
    // already appended an input. Inspect the actual messages after that step,
    // retaining structured identity instead of treating a summary as delivery.
    const previous = session.agent.transformContext?.bind(session.agent);
    session.agent.transformContext = async (messages, signal) => {
      const transformed = previous ? await previous(messages, signal) : messages;
      if (signal) throwIfAborted(signal);
      throwIfAborted(this.context.signal);
      return this.restorePendingProjection(session, transformed);
    };
  }

  private restorePendingProjection(session: AgentSession, messages: InputMessages): InputMessages {
    const inputs = new Map(this.inputs().map((input) => [input.id, input]));
    const projected = new Map<string, { hasImages: boolean }>();
    for (const message of messages) {
      if (message.role !== 'custom' || message.customType !== TASK_INPUT_CUSTOM_TYPE) continue;
      const receipt = message.details as Partial<InputReceipt> | undefined;
      const input = inputs.get(receipt?.inputId ?? '');
      if (
        !input ||
        receipt?.version !== 1 ||
        receipt.taskId !== input.taskId ||
        receipt.fingerprint !== fingerprint(input)
      )
        continue;
      projected.set(input.id, {
        hasImages:
          Array.isArray(message.content) && message.content.some((part) => part.type === 'image'),
      });
    }
    let result = messages;
    const pending = [...inputs.values()].filter(
      (input) => input.status === 'pending' && this.inserted.has(input.id),
    );
    if (pending.some((input) => !projected.has(input.id))) {
      const branch = session.sessionManager.getBranch();
      const pendingIds = new Set(pending.map((input) => input.id));
      const isPendingReceipt = (value: unknown): boolean => {
        const receipt = value as Partial<InputReceipt> | undefined;
        const input = inputs.get(receipt?.inputId ?? '');
        return Boolean(
          input &&
          pendingIds.has(input.id) &&
          receipt?.version === 1 &&
          receipt.taskId === input.taskId &&
          receipt.fingerprint === fingerprint(input),
        );
      };
      // Restoring an older missing input after a retained newer input would
      // reverse the owner's corrections. Rebuild this pending group in sequence
      // order, using append-only context edits to omit its old active entries.
      // Already delivered inputs remain ordinary compactable history.
      for (const {
        sourceEntry,
        messages: active,
      } of session.sessionManager.buildSessionProjection().entries) {
        if (
          sourceEntry.type === 'custom_message' &&
          sourceEntry.customType === TASK_INPUT_CUSTOM_TYPE &&
          active.length &&
          isPendingReceipt(sourceEntry.details)
        )
          session.sessionManager.appendContextEdit(sourceEntry.id, null);
      }
      result = messages.filter(
        (message) =>
          !(
            message.role === 'custom' &&
            message.customType === TASK_INPUT_CUSTOM_TYPE &&
            isPendingReceipt(message.details)
          ),
      );
      for (const input of pending) {
        const source = branch.findLast((entry): entry is CustomMessageEntry<InputReceipt> => {
          if (entry.type !== 'custom_message' || entry.customType !== TASK_INPUT_CUSTOM_TYPE)
            return false;
          const receipt = entry.details as Partial<InputReceipt> | undefined;
          return (
            receipt?.version === 1 &&
            receipt.taskId === input.taskId &&
            receipt.inputId === input.id &&
            receipt.fingerprint === fingerprint(input)
          );
        });
        if (!source)
          throw new Error(
            'A pending task instruction could not be restored from its durable session entry.',
          );
        // Restore only an input which has never reached a conversation request.
        // Reuse its already-budgeted content, including pixels; do not read or
        // charge images again. The new entry keeps it available to tool turns
        // after this request as well, while the same inputId remains authoritative.
        const entryId = session.sessionManager.appendCustomMessageEntry(
          source.customType,
          source.content,
          source.display,
          source.details,
        );
        const entry = session.sessionManager.getEntry(entryId)!;
        result.push(...sessionEntryToContextMessages(entry));
        projected.set(input.id, {
          hasImages:
            Array.isArray(source.content) && source.content.some((part) => part.type === 'image'),
        });
      }
    }
    this.projected = projected;
    return result;
  }

  /** Only unissued calls are superseded. Do not use inside a claimed side effect. */
  assertCanStartOperation(): void {
    if (this.hasUninjected()) throw new TaskInputSupersededError();
  }

  notify(): void {
    const pending = this.uninjected();
    if (!pending.length || !this.model?.conversation) return;
    // A prepared transcript waiting for a slot is stale even in boundary mode.
    // Once issued, only the explicit immediate mode cancels conversation output.
    if (!this.model.dispatched || pending.some((input) => input.mode === 'immediate')) {
      this.modelSuperseded = true;
      this.model.controller.abort(new TaskInputSupersededError());
    }
  }

  beginModelRequest(conversation: boolean): TaskInputModelRequest {
    const model = { controller: new AbortController(), conversation, dispatched: false };
    const projected = this.projected;
    this.model = model;
    this.notify();
    return {
      signal: model.controller.signal,
      started: () => {
        model.dispatched = true;
      },
      dispatched: (imageInputEnabled = true) => {
        model.dispatched = true;
        if (!conversation) return;
        // Mark only the exact instructions already present in this request.
        // Inputs accepted by a later event remain pending for the next request.
        for (const input of this.inputs()) {
          if (input.status !== 'pending') continue;
          const receipt = this.inserted.get(input.id);
          if (receipt && projected.has(input.id))
            this.context.host.markTaskInputsDelivered?.(
              this.context.task.id,
              [input.id],
              receipt.reason ??
                (input.inputImageIds?.length && !imageInputEnabled
                  ? imageInputDisabledReason
                  : input.inputImageIds?.length && !projected.get(input.id)?.hasImages
                    ? 'The instruction text was delivered, but its image pixels were not available in the model request.'
                    : undefined),
            );
        }
      },
      retrying: () => {
        // A rejected request did not deliver its instructions. A new owner
        // correction must supersede this input before its replacement is sent.
        model.dispatched = false;
        this.notify();
      },
      finish: () => {
        if (this.model === model) this.model = undefined;
      },
    };
  }

  takeModelSuperseded(): boolean {
    const result = this.modelSuperseded;
    this.modelSuperseded = false;
    return result;
  }

  /** Called only while Pi is idle, so messages never split a tool call/result. */
  async inject(session: AgentSession): Promise<number> {
    let count = 0;
    for (;;) {
      throwIfAborted(this.context.signal);
      const input = this.uninjected()[0];
      if (!input) return count;
      await this.context.waitForRoom?.(this.context.signal);
      let attachments: Awaited<ReturnType<typeof chatImageInput>> = { text: '' };
      let reason: string | undefined;
      if (input.inputImageIds?.length) {
        try {
          attachments = await chatImageInput(
            {
              ...this.context,
              task: { ...this.context.task, inputImageIds: input.inputImageIds },
            },
            [],
          );
          if (!attachments.images?.length) reason = imageInputDisabledReason;
        } catch {
          throwIfAborted(this.context.signal);
          // A missing image or exhausted shared budget must not lose the owner's
          // text or masquerade as visual evidence. IDs still allow later review.
          reason =
            'The instruction text was delivered, but its image pixels could not be included within the current image policy and task budget.';
          attachments = {
            text: [
              ...input.inputImageIds.map((id, index) => `Image ${index + 1}: imageId=${id}`),
              reason,
              'Do not claim to have viewed these images. Explain the limitation if the instruction needs their pixels.',
            ].join('\n'),
          };
        }
      }
      await this.context.waitForRoom?.(this.context.signal);
      throwIfAborted(this.context.signal);
      const receipt: InputReceipt = {
        version: 1,
        taskId: input.taskId,
        inputId: input.id,
        fingerprint: fingerprint(input),
        ...(reason ? { reason } : {}),
      };
      const content: Array<TextContent | ImageContent> = [
        {
          type: 'text',
          text: [
            'Additional instruction from the human owner for this same task:',
            input.body || 'Please examine the attached images for the current task.',
            'Continue the existing task using this instruction. Preserve completed work and operation receipts; do not restart or repeat completed effects. Existing tool permissions still apply.',
            attachments.text,
          ]
            .filter(Boolean)
            .join('\n\n'),
        },
        ...(attachments.images ?? []),
      ];
      // Pi converts this public custom-message type to a real user-role model
      // message, while retaining details solely as durable session metadata.
      await session.sendCustomMessage(
        { customType: TASK_INPUT_CUSTOM_TYPE, content, display: false, details: receipt },
        { triggerTurn: false },
      );
      this.inserted.set(input.id, receipt);
      count++;
    }
  }
}
