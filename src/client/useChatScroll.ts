import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { ChatScrollManager, type ChatScrollState } from './chat-scroll';

export function useChatScroll(roomId: string | undefined, content: readonly unknown[]) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const manager = useRef<ChatScrollManager | undefined>(undefined);
  const [state, setState] = useState<ChatScrollState>({ following: true, hasUpdates: false });
  useLayoutEffect(() => {
    if (!scrollRef.current || !contentRef.current) return;
    const current = new ChatScrollManager(roomId, scrollRef.current, contentRef.current, (next) => {
      setState((previous) =>
        previous.following === next.following && previous.hasUpdates === next.hasUpdates
          ? previous
          : next,
      );
    });
    manager.current = current;
    return () => {
      current.destroy();
      if (manager.current === current) manager.current = undefined;
    };
  }, [roomId]);
  useLayoutEffect(() => {
    manager.current?.reconcile(content);
  });
  const pause = useCallback(() => manager.current?.pause(), []);
  const followLatest = useCallback((expectedRoomId?: string) => {
    if (expectedRoomId === undefined || manager.current?.roomId === expectedRoomId)
      manager.current?.followLatest();
  }, []);
  const focusElement = useCallback(
    (element: HTMLElement) => manager.current?.focusElement(element),
    [],
  );
  return { scrollRef, contentRef, ...state, pause, followLatest, focusElement };
}
