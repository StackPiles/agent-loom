export interface ChatScrollState {
  following: boolean;
  hasUpdates: boolean;
}

const END_TOLERANCE = 2;
const POSITION_TOLERANCE = 0.5;
const BLOCKS =
  'header, p, pre, li, h1, h2, h3, h4, h5, h6, summary, figure, table, [data-approval-id]';
const INTERACTIVE =
  'button, a, input, textarea, select, summary, [contenteditable="true"], [role="button"]';

interface ReadingAnchor {
  ownerId: string;
  ownerOffset: number;
  element: HTMLElement;
  elementPath: number[];
  elementOffset: number;
  signature: string;
  textOffset?: number;
  textY?: number;
}
interface Intent {
  direction: -1 | 0 | 1;
  until: number;
  pending: boolean;
}
interface CaretDocument {
  caretPositionFromPoint?: (x: number, y: number) => { offsetNode: Node; offset: number } | null;
  caretRangeFromPoint?: (x: number, y: number) => Range | null;
}

function elementPath(owner: Element, element: Element): number[] {
  const result: number[] = [];
  let current: Element | null = element;
  while (current && current !== owner) {
    const parent: Element | null = current.parentElement;
    if (!parent) return [];
    result.unshift([...parent.children].indexOf(current));
    current = parent;
  }
  return result;
}
function atElementPath(owner: HTMLElement, indices: number[]): HTMLElement | undefined {
  let element: Element | undefined = owner;
  for (const index of indices) element = element?.children[index];
  return element instanceof owner.ownerDocument.defaultView!.HTMLElement ? element : undefined;
}
function signature(element: HTMLElement): string {
  return `${element.tagName}:${element.textContent?.trim().slice(0, 80) ?? ''}`;
}
function textPosition(element: HTMLElement, node: Node, offset: number): number | undefined {
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
  let current: Node | null,
    length = 0;
  while ((current = walker.nextNode())) {
    if (current === node) return length + Math.min(offset, current.textContent?.length ?? 0);
    length += current.textContent?.length ?? 0;
  }
}
function textRectangle(element: HTMLElement, offset: number): DOMRect | undefined {
  const walker = element.ownerDocument.createTreeWalker(element, 4 /* SHOW_TEXT */);
  let node: Node | null;
  while ((node = walker.nextNode())) {
    const length = node.textContent?.length ?? 0;
    if (offset < length) {
      const range = element.ownerDocument.createRange();
      range.setStart(node, offset);
      range.setEnd(node, Math.min(length, offset + 1));
      const rectangle = range.getBoundingClientRect?.();
      return rectangle?.height ? rectangle : undefined;
    }
    offset -= length;
  }
}

/** Owns one chat viewport. Layout changes never imply permission to resume following. */
export class ChatScrollManager {
  private state: ChatScrollState = { following: true, hasUpdates: false };
  private anchors: ReadingAnchor[] = [];
  private preferredAnchor?: HTMLElement;
  private previousContent?: readonly unknown[];
  private lastTop = 0;
  private programmedTop?: number;
  private intent?: Intent;
  private dragging = false;
  private touchY?: number;
  private focusing = false;
  private frame?: number;
  private disposed = false;
  private cleanups: Array<() => void> = [];
  private readonly view: Window & typeof globalThis;

  constructor(
    readonly roomId: string | undefined,
    private readonly viewport: HTMLElement,
    private readonly content: HTMLElement,
    private readonly changed: (state: ChatScrollState) => void,
  ) {
    this.view = viewport.ownerDocument.defaultView!;
    const previousAnchor = viewport.style.overflowAnchor;
    viewport.style.overflowAnchor = 'none';
    this.cleanups.push(() => {
      viewport.style.overflowAnchor = previousAnchor;
    });
    const listen = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement,
      type: K,
      listener: (event: HTMLElementEventMap[K]) => void,
      options: AddEventListenerOptions = { passive: true },
    ) => {
      target.addEventListener(type, listener as EventListener, options);
      this.cleanups.push(() =>
        target.removeEventListener(type, listener as EventListener, options),
      );
    };
    listen(viewport, 'scroll', (event) => {
      if (event.target === viewport) this.onScroll();
    });
    listen(viewport, 'wheel', (event) => {
      if (event.ctrlKey || event.shiftKey || Math.abs(event.deltaY) < 0.1) return;
      this.userIntent(event.deltaY < 0 ? -1 : 1, event.target);
    });
    listen(viewport, 'touchstart', (event) => {
      this.touchY = event.touches[0]?.clientY;
    });
    listen(viewport, 'touchmove', (event) => {
      const next = event.touches[0]?.clientY;
      if (next !== undefined && this.touchY !== undefined && Math.abs(next - this.touchY) > 1)
        this.userIntent(next > this.touchY ? -1 : 1, event.target);
      this.touchY = next;
    });
    listen(viewport, 'touchend', () => {
      this.touchY = undefined;
    });
    listen(viewport, 'keydown', (event) => {
      if (event.defaultPrevented || event.altKey || event.metaKey) return;
      const target = event.target instanceof this.view.Element ? event.target : undefined;
      if (target?.closest('input, textarea, select, [contenteditable="true"]')) return;
      if (event.key === ' ' && target?.closest(INTERACTIVE)) return;
      const up =
        ['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey);
      const down =
        ['ArrowDown', 'PageDown', 'End'].includes(event.key) ||
        (event.key === ' ' && !event.shiftKey);
      if (!up && !down) return;
      if (event.key === 'End' && !this.nestedScroller(event.target)) this.followLatest();
      else this.userIntent(up ? -1 : 1, event.target);
    });
    listen(
      viewport,
      'pointerdown',
      (event) => {
        if (event.button !== 0 || event.pointerType === 'touch') return;
        const target = event.target instanceof this.view.Element ? event.target : undefined;
        if (target?.closest(INTERACTIVE)) return;
        // Selecting text and dragging the scrollbar are reading gestures too.
        this.pause();
        this.dragging = event.target === viewport;
        this.intent = { direction: 0, until: Date.now() + 250, pending: true };
      },
      { passive: true, capture: true },
    );
    const releasePointer = () => {
      this.dragging = false;
      if (this.intent) this.intent.until = Date.now() + 250;
    };
    this.view.addEventListener('pointerup', releasePointer, { passive: true });
    this.view.addEventListener('pointercancel', releasePointer, { passive: true });
    this.cleanups.push(() => {
      this.view.removeEventListener('pointerup', releasePointer);
      this.view.removeEventListener('pointercancel', releasePointer);
    });
    listen(
      viewport,
      'click',
      (event) => {
        const target =
          event.target instanceof this.view.Element ? event.target.closest('summary') : null;
        if (target instanceof this.view.HTMLElement && viewport.contains(target))
          this.pause(target);
      },
      { capture: true },
    );
    listen(viewport, 'focusin', (event) => {
      if (
        !this.focusing &&
        event.target instanceof this.view.HTMLElement &&
        event.target !== viewport
      )
        this.pause(event.target);
    });
    listen(viewport, 'load', () => this.scheduleLayout(), { capture: true, passive: true });
    const resized = () => this.reconcile();
    if (typeof this.view.ResizeObserver === 'function') {
      const observer = new this.view.ResizeObserver(resized);
      observer.observe(viewport);
      observer.observe(content);
      this.cleanups.push(() => observer.disconnect());
    }
    const mutations = new this.view.MutationObserver(() => this.scheduleLayout());
    mutations.observe(content, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
      attributeFilter: ['open', 'hidden'],
    });
    this.cleanups.push(() => mutations.disconnect());
    this.view.addEventListener('resize', resized, { passive: true });
    this.cleanups.push(() => this.view.removeEventListener('resize', resized));
    this.changed(this.state);
    this.followLatest();
  }

  private emit(patch: Partial<ChatScrollState>) {
    const next = { ...this.state, ...patch };
    if (next.following === this.state.following && next.hasUpdates === this.state.hasUpdates)
      return;
    this.state = next;
    this.changed(next);
  }
  private bottom() {
    return Math.max(0, this.viewport.scrollHeight - this.viewport.clientHeight);
  }
  private nearEnd() {
    return this.bottom() - this.viewport.scrollTop <= END_TOLERANCE;
  }
  private activeIntent() {
    return this.intent && (this.dragging || this.intent.until >= Date.now())
      ? this.intent
      : undefined;
  }
  private writeTop(value: number) {
    const top = Math.max(0, Math.min(this.bottom(), value));
    if (Math.abs(this.viewport.scrollTop - top) > POSITION_TOLERANCE) {
      this.viewport.scrollTop = top;
      this.programmedTop = this.viewport.scrollTop;
    }
    this.lastTop = this.viewport.scrollTop;
  }
  private nestedScroller(target: EventTarget | null): boolean {
    let element = target instanceof this.view.Element ? target : null;
    while (element && element !== this.viewport) {
      if (
        element instanceof this.view.HTMLElement &&
        element.clientHeight > 0 &&
        element.scrollHeight > element.clientHeight + 1
      ) {
        const style = this.view.getComputedStyle(element);
        if (/(?:auto|scroll|overlay)/.test(style.overflowY)) return true;
      }
      element = element.parentElement;
    }
    return false;
  }
  private userIntent(direction: -1 | 1, target: EventTarget | null) {
    if (this.nestedScroller(target)) {
      this.pause();
      this.intent = undefined;
      return;
    }
    if (direction < 0) this.pause();
    this.intent = { direction, until: Date.now() + 250, pending: true };
    if (direction > 0 && this.nearEnd()) this.followLatest();
  }
  private onScroll() {
    if (this.disposed) return;
    const top = this.viewport.scrollTop;
    if (
      this.programmedTop !== undefined &&
      Math.abs(top - this.programmedTop) <= POSITION_TOLERANCE
    ) {
      this.programmedTop = undefined;
      this.lastTop = top;
      return;
    }
    this.programmedTop = undefined;
    const intent = this.activeIntent(),
      delta = top - this.lastTop;
    if (this.state.following && !this.nearEnd()) this.emit({ following: false });
    else if (
      !this.state.following &&
      this.nearEnd() &&
      intent &&
      (intent.direction > 0 || (intent.direction === 0 && delta > 0))
    ) {
      this.followLatest();
      return;
    }
    this.preferredAnchor = undefined;
    this.capture();
    this.lastTop = top;
    if (this.intent) this.intent.pending = false;
  }
  private scheduleLayout() {
    if (this.disposed || this.frame !== undefined) return;
    this.frame = this.view.requestAnimationFrame(() => {
      this.frame = undefined;
      this.reconcile();
    });
  }
  private viewportTop() {
    return this.viewport.getBoundingClientRect().top + this.viewport.clientTop;
  }
  private capture(preferred?: HTMLElement) {
    const top = this.viewportTop(),
      bottom = top + this.viewport.clientHeight;
    const owners = [...this.content.querySelectorAll<HTMLElement>('[data-scroll-anchor]')];
    const preferredOwner = preferred?.closest<HTMLElement>('[data-scroll-anchor]');
    const first = preferredOwner
      ? owners.indexOf(preferredOwner)
      : owners.findIndex((element) => {
          const rectangle = element.getBoundingClientRect();
          return rectangle.height > 0 && rectangle.bottom > top + 1 && rectangle.top < bottom;
        });
    if (first < 0) {
      this.anchors = [];
      return;
    }
    this.anchors = owners.slice(first, first + 3).map((owner, index) => {
      const ownerRect = owner.getBoundingClientRect();
      let element = index === 0 && preferred && owner.contains(preferred) ? preferred : owner;
      if (element === owner) {
        const candidates = [...owner.querySelectorAll<HTMLElement>(BLOCKS)]
          .map((item) => ({ item, rectangle: item.getBoundingClientRect() }))
          .filter(
            ({ rectangle }) =>
              rectangle.height > 0 && rectangle.bottom > top + 2 && rectangle.top < bottom,
          );
        // Prefer the smallest block crossing the upper reading line, so a long
        // message does not reduce to an off-screen article header as its anchor.
        const crossing = candidates
          .filter(({ rectangle }) => rectangle.top <= top + 8 && rectangle.bottom > top + 8)
          .sort((a, b) => a.rectangle.height - b.rectangle.height);
        element = crossing[0]?.item ?? candidates[0]?.item ?? owner;
      }
      const rectangle = element.getBoundingClientRect();
      const anchor: ReadingAnchor = {
        ownerId: owner.dataset.scrollAnchor!,
        ownerOffset: ownerRect.top - top,
        element,
        elementPath: elementPath(owner, element),
        elementOffset: rectangle.top - top,
        signature: signature(element),
      };
      // A visible character also survives width changes (focus mode, sidebars,
      // viewport rotation) that reflow a paragraph across different line breaks.
      if (index === 0 && rectangle.top < top && !this.nestedScroller(element)) {
        const document = element.ownerDocument as CaretDocument;
        const viewportRect = this.viewport.getBoundingClientRect();
        const x = Math.max(
          viewportRect.left + 8,
          Math.min(viewportRect.right - 8, rectangle.left + Math.min(80, rectangle.width / 2)),
        );
        const y = Math.min(bottom - 2, rectangle.bottom - 2, top + 8);
        const position = document.caretPositionFromPoint?.(x, y);
        const range = position ? undefined : document.caretRangeFromPoint?.(x, y);
        const node = position?.offsetNode ?? range?.startContainer;
        const offset = position?.offset ?? range?.startOffset;
        if (node && offset !== undefined && element.contains(node)) {
          const textOffset = textPosition(element, node, offset);
          const textRect =
            textOffset === undefined ? undefined : textRectangle(element, textOffset);
          if (textRect) {
            anchor.textOffset = textOffset;
            anchor.textY = textRect.top - top;
          }
        }
      }
      return anchor;
    });
  }
  private locate(anchor: ReadingAnchor): { current: number; previous: number } | undefined {
    const owner = [...this.content.querySelectorAll<HTMLElement>('[data-scroll-anchor]')].find(
      (element) => element.dataset.scrollAnchor === anchor.ownerId,
    );
    if (!owner || !owner.getBoundingClientRect().height) return;
    const top = this.viewportTop();
    let element =
      anchor.element.isConnected && owner.contains(anchor.element) ? anchor.element : undefined;
    if (!element) {
      const candidate = atElementPath(owner, anchor.elementPath);
      element =
        candidate && signature(candidate) === anchor.signature
          ? candidate
          : [...owner.querySelectorAll<HTMLElement>(BLOCKS)].find(
              (item) => signature(item) === anchor.signature,
            );
    }
    if (element?.getBoundingClientRect().height) {
      if (anchor.textOffset !== undefined && anchor.textY !== undefined) {
        const rectangle = textRectangle(element, anchor.textOffset);
        if (rectangle) return { current: rectangle.top - top, previous: anchor.textY };
      }
      return { current: element.getBoundingClientRect().top - top, previous: anchor.elementOffset };
    }
    return { current: owner.getBoundingClientRect().top - top, previous: anchor.ownerOffset };
  }

  /** Call after a React commit; observers cover images and local disclosure state. */
  reconcile(values?: readonly unknown[]) {
    if (this.disposed) return;
    if (values) {
      const changed =
        this.previousContent &&
        (values.length !== this.previousContent.length ||
          values.some((value, index) => value !== this.previousContent![index]));
      this.previousContent = values;
      if (changed && !this.state.following) this.emit({ hasUpdates: true });
    }
    if (this.state.following) {
      this.writeTop(this.bottom());
      return;
    }
    const top = this.viewport.scrollTop;
    const userDelta = this.dragging || this.activeIntent()?.pending ? top - this.lastTop : 0;
    for (const anchor of this.anchors) {
      const located = this.locate(anchor);
      if (!located) continue;
      const delta = located.current - located.previous + userDelta;
      if (Math.abs(delta) > POSITION_TOLERANCE) this.writeTop(top + delta);
      break;
    }
    if (this.preferredAnchor && !this.content.contains(this.preferredAnchor))
      this.preferredAnchor = undefined;
    this.capture(this.preferredAnchor);
    this.lastTop = this.viewport.scrollTop;
  }
  pause(preferred?: HTMLElement) {
    if (this.disposed) return;
    this.emit({ following: false });
    this.preferredAnchor = preferred;
    this.capture(preferred);
    this.lastTop = this.viewport.scrollTop;
  }
  followLatest() {
    if (this.disposed) return;
    this.intent = undefined;
    this.anchors = [];
    this.preferredAnchor = undefined;
    this.emit({ following: true, hasUpdates: false });
    this.writeTop(this.bottom());
  }
  focusElement(target: HTMLElement) {
    if (this.disposed || !this.content.contains(target)) return;
    this.pause();
    this.intent = undefined;
    const rectangle = target.getBoundingClientRect();
    const inset = Math.max(12, (this.viewport.clientHeight - rectangle.height) / 2);
    this.writeTop(this.viewport.scrollTop + rectangle.top - this.viewportTop() - inset);
    this.focusing = true;
    try {
      target.tabIndex = -1;
      target.focus({ preventScroll: true });
    } finally {
      this.focusing = false;
    }
    // Keep the explicitly chosen bot/approval as the reading owner until the
    // next user scroll, even if a few pixels of the preceding card are visible.
    this.preferredAnchor = target;
    this.capture(target);
  }
  destroy() {
    this.disposed = true;
    if (this.frame !== undefined) this.view.cancelAnimationFrame(this.frame);
    for (const cleanup of this.cleanups) cleanup();
    this.cleanups = [];
    this.anchors = [];
    this.preferredAnchor = undefined;
  }
}
