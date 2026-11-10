import { useEffect, useRef, useState } from 'react';
import {
  IMAGE_INPUT_LIMITS,
  IMAGE_INPUT_MIME_TYPES,
  type ChatImageUpload,
} from '../shared/image-inputs';

export interface DraftChatImage {
  id: string;
  filename: string;
  mimeType: ChatImageUpload['mimeType'];
  byteLength: number;
  status: 'reading' | 'ready' | 'error';
  data?: string;
}

function fileMimeType(file: File): ChatImageUpload['mimeType'] | undefined {
  if (IMAGE_INPUT_MIME_TYPES.includes(file.type as ChatImageUpload['mimeType']))
    return file.type as ChatImageUpload['mimeType'];
  // Some file pickers omit MIME metadata. The server still verifies the bytes.
  if (file.type) return undefined;
  const extension = file.name.split('.').at(-1)?.toLowerCase();
  return extension === 'png'
    ? 'image/png'
    : extension === 'jpg' || extension === 'jpeg'
      ? 'image/jpeg'
      : extension === 'webp'
        ? 'image/webp'
        : undefined;
}

/** Image drafts remain in memory, scoped to the room that received the files. */
export function useChatImages(t: (ja: string, en: string) => string) {
  const [drafts, setDrafts] = useState<Record<string, DraftChatImage[]>>({});
  const [errors, setErrors] = useState<Record<string, string | undefined>>({});
  const current = useRef(drafts);
  const readers = useRef(new Map<string, FileReader>());
  const sequence = useRef(0);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      for (const reader of readers.current.values()) reader.abort();
      readers.current.clear();
    };
  }, []);

  function update(roomId: string, change: (images: DraftChatImage[]) => DraftChatImage[]) {
    if (!mounted.current) return;
    current.current = { ...current.current, [roomId]: change(current.current[roomId] ?? []) };
    setDrafts(current.current);
  }

  function setError(roomId: string, error?: string) {
    setErrors((previous) => ({ ...previous, [roomId]: error }));
  }

  function add(roomId: string, files: File[]) {
    if (!files.length) return;
    const existing = current.current[roomId] ?? [];
    const types = files.map(fileMimeType);
    if (types.some((type) => !type)) {
      setError(
        roomId,
        t('PNG・JPEG・WebPの画像を選んでください。', 'Choose PNG, JPEG or WebP images.'),
      );
      return;
    }
    if (existing.length + files.length > IMAGE_INPUT_LIMITS.maxImages) {
      setError(
        roomId,
        t('画像は1回の送信につき10枚までです。', 'Attach up to 10 images per message.'),
      );
      return;
    }
    if (files.some((file) => file.size < 1 || file.size > IMAGE_INPUT_LIMITS.maxImageBytes)) {
      setError(
        roomId,
        t(
          '空でない20 MiB以下の画像を選んでください。',
          'Each image must be nonempty and at most 20 MiB.',
        ),
      );
      return;
    }
    const total = [...existing, ...files.map((file) => ({ byteLength: file.size }))].reduce(
      (sum, image) => sum + image.byteLength,
      0,
    );
    if (total > IMAGE_INPUT_LIMITS.maxTotalBytes) {
      setError(
        roomId,
        t(
          '画像の合計を80 MiB以下にしてください。',
          'Keep the total image size at or below 80 MiB.',
        ),
      );
      return;
    }
    const added = files.map((file, index): DraftChatImage => ({
      id: `draft_image_${++sequence.current}`,
      filename: file.name,
      mimeType: types[index]!,
      byteLength: file.size,
      status: 'reading',
    }));
    setError(roomId);
    update(roomId, (images) => [...images, ...added]);
    files.forEach((file, index) => {
      const image = added[index];
      const reader = new window.FileReader();
      readers.current.set(image.id, reader);
      const fail = () => {
        readers.current.delete(image.id);
        update(roomId, (images) =>
          images.map((item) => (item.id === image.id ? { ...item, status: 'error' } : item)),
        );
      };
      reader.onerror = fail;
      reader.onabort = fail;
      reader.onload = () => {
        readers.current.delete(image.id);
        const result = reader.result;
        const comma = typeof result === 'string' ? result.indexOf(',') : -1;
        if (typeof result !== 'string' || comma < 0 || !result.slice(comma + 1)) {
          fail();
          return;
        }
        update(roomId, (images) =>
          images.map((item) =>
            item.id === image.id
              ? { ...item, status: 'ready', data: result.slice(comma + 1) }
              : item,
          ),
        );
      };
      try {
        reader.readAsDataURL(file);
      } catch {
        fail();
      }
    });
  }

  function remove(roomId: string, ids: string[]) {
    const removed = new Set(ids);
    // Remove before abort: an abort callback cannot restore a deleted draft.
    update(roomId, (images) => images.filter((image) => !removed.has(image.id)));
    for (const id of ids) {
      readers.current.get(id)?.abort();
      readers.current.delete(id);
    }
    setError(roomId);
  }

  return { drafts, errors, add, remove };
}
