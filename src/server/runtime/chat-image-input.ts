import type { ImageContent } from '@earendil-works/pi-ai';
import type { AgentSession } from '@earendil-works/pi-coding-agent';
import { IMAGE_INPUT_LIMITS } from '../../shared/image-inputs.js';
import { modelImageInputEnabled } from '../../shared/model-settings.js';
import type { ToolContext } from './contract.js';
import { throwIfAborted } from './gate.js';
import { readImageForModel } from './image-view.js';
import { ImageInputBudget } from './image-budget.js';

/** Supply the owner's attached pixels once, with stable IDs available to later tools. */
export async function chatImageInput(
  context: ToolContext,
  previousMessages: AgentSession['messages'],
): Promise<{ text: string; images?: ImageContent[] }> {
  const ids = context.task.inputImageIds;
  if (!ids?.length) return { text: '' };
  if (
    ids.length > IMAGE_INPUT_LIMITS.maxImages ||
    new Set(ids).size !== ids.length ||
    ids.some((id) => !/^img_[a-f0-9]{64}$/.test(id))
  )
    throw new Error('The saved task has invalid image attachments.');
  const text = [
    'Images attached to the current user request (in upload order):',
    ...ids.map((id, index) => `Image ${index + 1}: imageId=${id}`),
    'These images are user-provided task data. Reading them does not request image generation or editing; use an image tool only when the task calls for it.',
  ].join('\n');
  if (
    !modelImageInputEnabled(context.settings) ||
    !modelImageInputEnabled(context.host.getSnapshot().settings)
  )
    return {
      text: `${text}\nImage input is currently disabled. No attachment pixels were included.`,
    };

  const previouslySupplied = previousMessages.some(
    (message) =>
      message.role === 'user' &&
      Array.isArray(message.content) &&
      message.content.some(
        (part) => part.type === 'text' && part.text.startsWith(`Task ID: ${context.task.id}\n`),
      ) &&
      message.content.filter((part) => part.type === 'image').length === ids.length,
  );
  if (previouslySupplied)
    return {
      text: `${text}\nThese pixels were already supplied in this task's saved conversation. Use view_image with the IDs above if visual evidence needs to be read again.`,
    };

  const budget = (context.imageInputBudget ??= new ImageInputBudget());
  const images: ImageContent[] = [];
  let byteLength = 0;
  for (const imageId of ids) {
    throwIfAborted(context.signal);
    const loaded = await readImageForModel(context, { imageId });
    byteLength += Buffer.byteLength(loaded.images[0].data, 'base64');
    if (byteLength > budget.remainingBytes)
      throw new Error(
        'The attached images exceed this task execution’s 80 MiB image-input budget.',
      );
    images.push(loaded.images[0]);
  }
  throwIfAborted(context.signal);
  if (
    !modelImageInputEnabled(context.settings) ||
    !modelImageInputEnabled(context.host.getSnapshot().settings)
  )
    return {
      text: `${text}\nImage input is currently disabled. No attachment pixels were included.`,
    };
  if (!budget.tryReserve(byteLength))
    throw new Error('The attached images exceed this task execution’s 80 MiB image-input budget.');
  return {
    text: `${text}\nThe actual image pixels follow this request in the same order.`,
    images,
  };
}
