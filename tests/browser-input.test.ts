import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { JSDOM } from 'jsdom';
import {
  installBrowserInputAdapter,
  type BrowserInputHandle,
  type BrowserInputLocator,
} from '../src/server/browser-input.js';

function fixture(markup = '<input type="email" value="old@example.invalid">') {
  const dom = new JSDOM(markup, { runScripts: 'outside-only', pretendToBeVisual: true });
  const element = dom.window.document.body.firstElementChild as HTMLElement;
  const bounds = { x: 10, y: 20, width: 200, height: 30 };
  Object.defineProperty(element, 'getBoundingClientRect', { value: () => bounds });
  Object.defineProperty(element, 'getClientRects', { value: () => [bounds] });
  if (element.hasAttribute('contenteditable')) {
    Object.defineProperty(element, 'isContentEditable', { value: true });
    Object.defineProperty(element, 'innerText', {
      get() {
        return element.textContent;
      },
      set(value: string) {
        element.textContent = value;
      },
    });
    element.tabIndex = 0;
  }
  let disposed = 0;
  let scrolled = 0;
  const delegated: Array<{ value: string | boolean; signal?: AbortSignal }> = [];
  const handle: BrowserInputHandle = {
    async evaluate(action, ...args) {
      return dom.window.eval('(' + action.toString() + ')')(element, ...args);
    },
    async scrollIntoView() {
      scrolled++;
    },
    async dispose() {
      disposed++;
    },
  };
  const prototype: BrowserInputLocator = {
    timeout: 1000,
    async waitHandle() {
      return handle;
    },
    async fill(value, options) {
      delegated.push({ value, signal: options?.signal });
    },
  };
  installBrowserInputAdapter(prototype);
  const locator = Object.create(prototype) as BrowserInputLocator;
  return {
    dom,
    element,
    locator,
    prototype,
    handle,
    delegated,
    disposed: () => disposed,
    scrolled: () => scrolled,
  };
}

test('a controlled email field replaces old text and updates validation without concatenation', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  const input = f.element as HTMLInputElement;
  const nativeValue = Object.getOwnPropertyDescriptor(
    f.dom.window.HTMLInputElement.prototype,
    'value',
  )!;
  let state = input.value;
  let tracked = state;
  let events = 0;
  let enabled = false;
  // Model the value tracker used by controlled inputs: a normal property write
  // updates its tracker, while an actual input edit must be discovered by input.
  Object.defineProperty(input, 'value', {
    get: () => nativeValue.get!.call(input),
    set(value: string) {
      tracked = value;
      nativeValue.set!.call(input, value);
    },
  });
  input.addEventListener('focus', () => {
    input.value = state;
  });
  input.addEventListener('input', () => {
    events++;
    if (input.value !== tracked) state = tracked = input.value;
    enabled = state === 'new@example.invalid' && input.checkValidity();
  });
  input.addEventListener('change', () => {
    input.value = state;
  });

  await f.locator.fill('new@example.invalid');
  assert.equal(input.value, 'new@example.invalid');
  assert.equal(state, 'new@example.invalid');
  assert.equal(enabled, true);
  assert.equal(events, 1);
  assert.equal(f.delegated.length, 0);
  assert.equal(f.disposed(), 1);
  assert.equal(f.scrolled(), 1);
});

test('repeated replacement, shared prefixes and empty clear use the complete requested value', async (t) => {
  const f = fixture('<input type="email" value="old@example.invalid">');
  t.after(() => f.dom.window.close());
  const input = f.element as HTMLInputElement;
  const edits: string[] = [];
  input.addEventListener('input', () => edits.push(input.value));
  for (const value of [
    'next@example.invalid',
    'next@example.invalid.long',
    '',
    'bad@@example.invalid',
  ]) {
    await f.locator.fill(value);
    assert.equal(input.value, value);
  }
  assert.deepEqual(edits, [
    'next@example.invalid',
    'next@example.invalid.long',
    '',
    'bad@@example.invalid',
  ]);
  assert.equal(input.validity.typeMismatch, true);
  await f.locator.fill('bad@@example.invalid');
  assert.equal(edits.length, 4, 'An unchanged value does not redispatch an input operation.');
});

test('an apparently matching value is checked again after focus restores controlled state', async (t) => {
  const f = fixture('<input value="requested value">');
  t.after(() => f.dom.window.close());
  const input = f.element as HTMLInputElement;
  let edits = 0;
  input.addEventListener('focus', () => {
    input.value = 'old controlled value';
  });
  input.addEventListener('input', () => edits++);
  await f.locator.fill('requested value');
  assert.equal(input.value, 'requested value');
  assert.equal(edits, 1);
  await f.locator.fill('requested value');
  assert.equal(edits, 1, 'A settled matching value causes no duplicate write.');
});

test('textareas and contenteditable fields replace multiline and Unicode text', async (t) => {
  for (const markup of [
    '<textarea>old value</textarea>',
    '<div contenteditable="true">old value</div>',
  ]) {
    const f = fixture(markup);
    t.after(() => f.dom.window.close());
    const value = '日本語の一行目\nSecond line 🎉';
    await f.locator.fill(value);
    assert.equal(
      f.element instanceof f.dom.window.HTMLTextAreaElement ? f.element.value : f.element.innerText,
      value,
    );
    await f.locator.fill('');
    assert.equal(
      f.element instanceof f.dom.window.HTMLTextAreaElement ? f.element.value : f.element.innerText,
      '',
    );
  }
});

test('disabled, readonly and nonvisible text controls are never written', async (t) => {
  for (const attribute of ['disabled', 'readonly', 'style="display:none"']) {
    const f = fixture(`<input value="untouched" ${attribute}>`);
    t.after(() => f.dom.window.close());
    if (attribute.startsWith('style')) Object.defineProperty(f.locator, 'timeout', { value: 50 });
    await assert.rejects(f.locator.fill('new private text'), /disabled|read-only|visible/);
    assert.equal((f.element as HTMLInputElement).value, 'untouched');
    assert.equal(f.disposed(), 1);
  }
});

test('focus redirection and a cancelled beforeinput cannot receive the replacement text', async (t) => {
  const stealing = fixture('<input value="untouched"><input id="other" value="also untouched">');
  t.after(() => stealing.dom.window.close());
  const other = stealing.dom.window.document.getElementById('other') as HTMLInputElement;
  stealing.element.addEventListener('focus', () => other.focus());
  await assert.rejects(stealing.locator.fill('PRIVATE_DO_NOT_ECHO'), /retain focus/);
  assert.equal((stealing.element as HTMLInputElement).value, 'untouched');
  assert.equal(other.value, 'also untouched');

  const cancelled = fixture('<input value="untouched">');
  t.after(() => cancelled.dom.window.close());
  cancelled.element.addEventListener('beforeinput', (event) => event.preventDefault());
  await assert.rejects(cancelled.locator.fill('PRIVATE_DO_NOT_ECHO'), /cancelled/);
  assert.equal((cancelled.element as HTMLInputElement).value, 'untouched');
});

test('a controlled rerender rejecting the value fails once without leaking the password', async (t) => {
  const f = fixture('<input type="password" value="old-password">');
  t.after(() => f.dom.window.close());
  const input = f.element as HTMLInputElement;
  let edits = 0;
  input.addEventListener('input', () => {
    edits++;
    queueMicrotask(() => {
      input.value = 'old-password';
    });
  });
  await assert.rejects(f.locator.fill('PRIVATE_PASSWORD_75397'), (error: Error) => {
    assert.match(error.message, /did not accept/);
    assert.ok(!JSON.stringify(error).includes('PRIVATE_PASSWORD_75397'));
    assert.ok(!error.stack?.includes('PRIVATE_PASSWORD_75397'));
    return true;
  });
  assert.equal(edits, 1);
  assert.equal(input.value, 'old-password');
  assert.equal(f.disposed(), 1);
});

test('on-focus field changes are rechecked before any text mutation', async (t) => {
  for (const change of ['readonly', 'detach', 'hidden', 'type']) {
    const f = fixture('<input value="untouched">');
    t.after(() => f.dom.window.close());
    const input = f.element as HTMLInputElement;
    let edits = 0;
    input.addEventListener('input', () => edits++);
    input.addEventListener('focus', () => {
      if (change === 'readonly') input.readOnly = true;
      if (change === 'detach') input.remove();
      if (change === 'hidden') input.style.display = 'none';
      if (change === 'type') input.type = 'checkbox';
    });
    await assert.rejects(f.locator.fill('new private value'), /field changed/);
    assert.equal(input.value, 'untouched');
    assert.equal(edits, 0);
  }
});

test('asynchronous input handlers changing type or actionability cannot report a verified fill', async (t) => {
  for (const change of ['type', 'visibility', 'readonly', 'inert']) {
    const f = fixture('<input type="email" value="old@example.invalid">');
    t.after(() => f.dom.window.close());
    const input = f.element as HTMLInputElement;
    let edits = 0;
    input.addEventListener('input', () => {
      edits++;
      queueMicrotask(() => {
        // The new value survives each change, so value-only verification would
        // incorrectly report success even though the target state has changed.
        if (change === 'type') input.type = 'text';
        if (change === 'visibility') input.style.visibility = 'hidden';
        if (change === 'readonly') input.readOnly = true;
        if (change === 'inert') input.setAttribute('inert', '');
      });
    });
    await assert.rejects(f.locator.fill('new@example.invalid'), /field changed/);
    assert.equal(input.value, 'new@example.invalid');
    assert.equal(edits, 1, 'A potentially applied edit must not be repeated.');
    assert.equal(f.disposed(), 1);
  }
});

test('field limits and native sanitization are rejected before modifying the control', async (t) => {
  for (const [markup, value, message] of [
    ['<input maxlength="3" value="old">', 'longer', /length limit/],
    ['<input type="number" value="42">', 'not a number', /did not accept/],
    ['<input type="email" value="old@example.invalid">', 'new\n@example.invalid', /did not accept/],
  ] as const) {
    const f = fixture(markup);
    t.after(() => f.dom.window.close());
    const before = (f.element as HTMLInputElement).value;
    let events = 0;
    f.element.addEventListener('input', () => events++);
    await assert.rejects(f.locator.fill(value), message);
    assert.equal((f.element as HTMLInputElement).value, before);
    assert.equal(events, 0);
  }
});

test(
  'cancellation before an edit or during preparation never dispatches replacement',
  { timeout: 3000 },
  async (t) => {
    for (const duringPreparation of [false, true]) {
      const f = fixture('<input value="untouched">');
      t.after(() => f.dom.window.close());
      const controller = new AbortController();
      if (duringPreparation)
        f.handle.scrollIntoView = () => {
          // Simulate a CDP operation whose cancellation fires synchronously but
          // whose original promise never settles after the connection is lost.
          controller.abort();
          return new Promise<void>(() => {});
        };
      else controller.abort();
      await assert.rejects(
        f.locator.fill('new private value', { signal: controller.signal }),
        /interrupted/,
      );
      assert.equal((f.element as HTMLInputElement).value, 'untouched');
    }
  },
);

test('page and protocol diagnostics cannot echo private replacement values', async (t) => {
  const f = fixture('<input type="password" value="untouched">');
  t.after(() => f.dom.window.close());
  f.handle.evaluate = async () => {
    throw new Error('Page rejected PRIVATE_PASSWORD_75397');
  };
  await assert.rejects(f.locator.fill('PRIVATE_PASSWORD_75397'), (error: Error) => {
    assert.match(error.message, /could not verify/);
    assert.ok(!error.stack?.includes('PRIVATE_PASSWORD_75397'));
    assert.equal(error.cause, undefined);
    return true;
  });
  assert.equal(f.disposed(), 1);
});

test('select options, date/range controls and toggles retain their original fill implementation', async (t) => {
  for (const markup of [
    '<select><option value="a">Label A</option></select>',
    '<input type="date">',
    '<input type="range">',
  ]) {
    const f = fixture(markup);
    t.after(() => f.dom.window.close());
    const signal = new AbortController().signal;
    await f.locator.fill('a', { signal });
    assert.deepEqual(f.delegated, [{ value: 'a', signal }]);
    assert.equal(f.scrolled(), 0);
  }
  const checkbox = fixture('<input type="checkbox">');
  t.after(() => checkbox.dom.window.close());
  await checkbox.locator.fill(true);
  assert.deepEqual(checkbox.delegated, [{ value: true, signal: undefined }]);
  assert.equal(checkbox.disposed(), 0);
  const fill = checkbox.prototype.fill;
  installBrowserInputAdapter(checkbox.prototype);
  assert.equal(
    checkbox.prototype.fill,
    fill,
    'Installing twice cannot stack replacement handlers.',
  );
});

test('the pinned ElementHandle locator inherits the adapter through timeout clones and disposes its handle', async (t) => {
  const f = fixture();
  t.after(() => f.dom.window.close());
  const require = createRequire(import.meta.url);
  const source = join(
    dirname(require.resolve('chrome-devtools-mcp/package.json')),
    'build',
    'src',
    'third_party',
    'index.js',
  );
  const { ElementHandle, Locator } = (await import(pathToFileURL(source).href)) as {
    ElementHandle: {
      prototype: {
        asLocator(): BrowserInputLocator & { setTimeout(timeout: number): BrowserInputLocator };
      };
    };
    Locator: { prototype: BrowserInputLocator };
  };
  installBrowserInputAdapter(Locator.prototype);
  const handle = Object.assign(f.handle, {
    frame: { getDefaultTimeout: () => 1000, logger() {} },
  });
  const locator = ElementHandle.prototype.asLocator.call(handle).setTimeout(2000);
  await locator.fill('new@example.invalid');
  assert.equal((f.element as HTMLInputElement).value, 'new@example.invalid');
  assert.equal(f.disposed(), 1);
});
