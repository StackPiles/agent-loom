import { setTimeout as delay } from 'node:timers/promises';

type FillOptions = { signal?: AbortSignal; typingThreshold?: number };
type InputKind = 'text' | 'editable' | 'other';
type InputState = {
  kind: InputKind;
  ready: boolean;
  reason?: 'detached' | 'disabled' | 'readonly' | 'hidden';
  bounds?: [number, number, number, number];
  inputType?: string;
};
export type BrowserInputHandle = {
  evaluate<T, A extends unknown[]>(
    action: (element: HTMLElement, ...args: A) => T,
    ...args: A
  ): Promise<Awaited<T>>;
  scrollIntoView(): Promise<void>;
  dispose(): Promise<void>;
};
export type BrowserInputLocator = {
  readonly timeout: number;
  waitHandle(options?: FillOptions): Promise<BrowserInputHandle>;
  fill(value: string | boolean, options?: FillOptions): Promise<void>;
};

const installed = new WeakSet<BrowserInputLocator>();
const errors = {
  detached: 'The input target is no longer attached. Take a new snapshot before trying again.',
  disabled: 'The input target is disabled.',
  readonly: 'The input target is read-only.',
  hidden: 'The input target is not visible or stable.',
  focus: 'The input target did not retain focus. Take a new snapshot before trying again.',
  rejected: 'The page did not accept the replacement text. Inspect the field before trying again.',
  changed: 'The field changed while replacing its text. Inspect the field before trying again.',
  cancelled: 'The page cancelled the text replacement.',
  maxlength: 'The replacement text exceeds the field length limit.',
  failed: 'Chrome could not verify the text replacement. Inspect the field before trying again.',
} as const;
type InputFailure = keyof typeof errors;

/** Fixed page code: no model-provided source or selectors are evaluated. */
function inputState(element: HTMLElement): InputState {
  let kind: InputKind = 'other';
  if (
    element instanceof HTMLTextAreaElement ||
    (element instanceof HTMLInputElement &&
      ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(element.type))
  )
    kind = 'text';
  else if (element.isContentEditable) kind = 'editable';
  if (kind === 'other') return { kind, ready: true };
  if (!element.isConnected) return { kind, ready: false, reason: 'detached' };
  if (
    element.matches(':disabled') ||
    element.closest('[inert]') ||
    element.getAttribute('aria-disabled') === 'true'
  )
    return { kind, ready: false, reason: 'disabled' };
  if (
    ((element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) &&
      element.readOnly) ||
    element.getAttribute('aria-readonly') === 'true'
  )
    return { kind, ready: false, reason: 'readonly' };
  const style = getComputedStyle(element);
  const bounds = element.getBoundingClientRect();
  if (
    !element.getClientRects().length ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    style.display === 'none'
  )
    return { kind, ready: false, reason: 'hidden' };
  return {
    kind,
    ready: true,
    bounds: [bounds.x, bounds.y, bounds.width, bounds.height],
    ...(element instanceof HTMLInputElement ? { inputType: element.type } : {}),
  };
}

/**
 * Focus before replacing, then use the native setter so controlled inputs see
 * the subsequent input event instead of silently restoring an unannounced clear.
 * Selection APIs do not work on input[type=email] or input[type=number].
 */
function replaceText(
  element: HTMLElement,
  value: string,
  inputType: string | undefined,
): InputFailure | undefined {
  const textControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  const root = element.getRootNode() as Document | ShadowRoot;
  const checks = {
    active() {
      return root.activeElement === element;
    },
    valid() {
      const bounds = element.getBoundingClientRect();
      const style = getComputedStyle(element);
      return (
        element.isConnected &&
        !element.matches(':disabled') &&
        !element.closest('[inert]') &&
        element.getAttribute('aria-disabled') !== 'true' &&
        element.getAttribute('aria-readonly') !== 'true' &&
        (!textControl || !element.readOnly) &&
        (!(element instanceof HTMLInputElement) ||
          (element.type === inputType &&
            ['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(
              element.type,
            ))) &&
        element.getClientRects().length > 0 &&
        bounds.width > 0 &&
        bounds.height > 0 &&
        style.display !== 'none' &&
        style.visibility !== 'hidden' &&
        style.visibility !== 'collapse'
      );
    },
    current() {
      return textControl ? element.value : element.innerText;
    },
  };
  if (!checks.valid()) return 'changed';
  if (!textControl && !element.isContentEditable) return 'changed';
  if (textControl && element.maxLength >= 0 && value.length > element.maxLength) return 'maxlength';
  if (element instanceof HTMLInputElement) {
    const probe = element.ownerDocument.createElement('input');
    probe.type = element.type;
    probe.value = value;
    if (probe.value !== value) return 'rejected';
  }
  element.focus({ preventScroll: true });
  if (!checks.valid()) return 'changed';
  if (!checks.active()) return 'focus';
  if (checks.current() === value) return;

  const beforeInput = new InputEvent('beforeinput', {
    bubbles: true,
    composed: true,
    cancelable: true,
    inputType: 'insertReplacementText',
    data: value,
  });
  if (!element.dispatchEvent(beforeInput)) return 'cancelled';
  if (!checks.valid()) return 'changed';
  if (!checks.active()) return 'focus';

  if (textControl) {
    const prototype =
      element instanceof HTMLTextAreaElement
        ? HTMLTextAreaElement.prototype
        : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    if (!setter) return 'failed';
    setter.call(element, value);
  } else element.innerText = value;
  // These events deliberately use the browser's DOM event API. They are not
  // presented as trusted keystrokes; a site can reject them, which is reported.
  element.dispatchEvent(
    new InputEvent('input', {
      bubbles: true,
      composed: true,
      inputType: 'insertReplacementText',
      data: value,
    }),
  );
  if (!checks.valid()) return 'changed';
  if (!checks.active()) return 'focus';
  if (checks.current() !== value) return 'rejected';
  element.dispatchEvent(new Event('change', { bubbles: true }));
  if (!checks.valid()) return 'changed';
  if (!checks.active()) return 'focus';
  if (checks.current() !== value) return 'rejected';
}

/** Observe the next rendering turns without doing any further writes or retries. */
async function verifyText(
  element: HTMLElement,
  value: string,
  inputType: string | undefined,
): Promise<InputFailure | undefined> {
  await new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, 100);
    requestAnimationFrame(() =>
      requestAnimationFrame(() => {
        clearTimeout(timer);
        resolve();
      }),
    );
  });
  const root = element.getRootNode() as Document | ShadowRoot;
  const bounds = element.getBoundingClientRect();
  const style = getComputedStyle(element);
  const textControl = element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement;
  if (
    !element.isConnected ||
    element.matches(':disabled') ||
    element.closest('[inert]') ||
    element.getAttribute('aria-disabled') === 'true' ||
    element.getAttribute('aria-readonly') === 'true' ||
    !element.getClientRects().length ||
    bounds.width <= 0 ||
    bounds.height <= 0 ||
    style.display === 'none' ||
    style.visibility === 'hidden' ||
    style.visibility === 'collapse' ||
    (element instanceof HTMLInputElement &&
      (element.type !== inputType ||
        !['text', 'search', 'url', 'tel', 'email', 'password', 'number'].includes(element.type))) ||
    (textControl ? element.readOnly : !element.isContentEditable)
  )
    return 'changed';
  if (root.activeElement !== element) return 'focus';
  if ((textControl ? element.value : element.innerText) !== value) return 'rejected';
}

async function abortable<T>(operation: () => Promise<T>, signal: AbortSignal): Promise<T> {
  signal.throwIfAborted();
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      new Promise<never>((_, reject) => {
        onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
      }),
      operation(),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener('abort', onAbort);
  }
}

/**
 * Install only in Loom's pinned MCP child. The existing tool handler still owns
 * page routing, UID resolution, the action queue and dialog/navigation tracking.
 * Non-text controls retain the upstream implementation, including option labels.
 */
export function installBrowserInputAdapter(prototype: BrowserInputLocator): void {
  if (installed.has(prototype)) return;
  if (typeof prototype.fill !== 'function' || typeof prototype.waitHandle !== 'function')
    throw new Error('The installed Chrome input adapter is incompatible. Reinstall dependencies.');
  installed.add(prototype);
  const originalFill = prototype.fill;
  prototype.fill = async function (value, options) {
    if (typeof value !== 'string') return originalFill.call(this, value, options);
    const timeout = AbortSignal.timeout(Math.max(1, this.timeout || 30_000));
    const signal = options?.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    let handle: BrowserInputHandle | undefined;
    let failure: InputFailure = 'failed';
    try {
      signal.throwIfAborted();
      handle = await this.waitHandle({ ...options, signal });
      let state = await abortable(() => handle!.evaluate(inputState), signal);
      if (state.kind === 'other') return await originalFill.call(this, value, options);
      if (state.reason && state.reason !== 'hidden') {
        failure = state.reason;
        throw new Error(errors[failure]);
      }
      await abortable(() => handle!.scrollIntoView(), signal);
      let previousBounds: string | undefined;
      while (true) {
        signal.throwIfAborted();
        state = await abortable(() => handle!.evaluate(inputState), signal);
        if (state.kind === 'other') {
          failure = 'changed';
          throw new Error(errors[failure]);
        }
        if (state.reason && state.reason !== 'hidden') {
          failure = state.reason;
          throw new Error(errors[failure]);
        }
        const bounds = state.ready ? JSON.stringify([state.bounds, state.inputType]) : undefined;
        if (bounds && bounds === previousBounds) break;
        previousBounds = bounds;
        failure = 'hidden';
        await delay(20, undefined, { signal });
      }
      signal.throwIfAborted();
      failure = 'failed';
      const rejected = await abortable(
        () => handle!.evaluate(replaceText, value, state.inputType),
        signal,
      );
      if (rejected) {
        failure = rejected;
        throw new Error(errors[failure]);
      }
      const verification = await abortable(
        () => handle!.evaluate(verifyText, value, state.inputType),
        signal,
      );
      if (verification) {
        failure = verification;
        throw new Error(errors[failure]);
      }
      signal.throwIfAborted();
    } catch {
      // Browser and page exceptions can quote password values. Keep only a fixed
      // diagnostic and never retry an action that may already have dispatched.
      if (options?.signal?.aborted)
        throw new Error('Text replacement was interrupted. Inspect the field before trying again.');
      throw new Error(errors[failure]);
    } finally {
      await handle?.dispose().catch(() => {});
    }
  };
}
