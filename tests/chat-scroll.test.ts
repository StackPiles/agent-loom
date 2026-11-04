import assert from 'node:assert/strict';
import test, { type TestContext } from 'node:test';
import { JSDOM } from 'jsdom';
import { ChatScrollManager, type ChatScrollState } from '../src/client/chat-scroll.js';

function rectangle(top: number, height: number, width = 600, left = 0): DOMRect {
  return {
    top,
    bottom: top + height,
    left,
    right: left + width,
    width,
    height,
    x: left,
    y: top,
    toJSON() {},
  } as DOMRect;
}
interface Card {
  element: HTMLElement;
  top: number;
  height: number;
  blocks: Array<{ element: HTMLElement; top: number; height: number }>;
}

/** JSDOM has no layout. These mutable rectangles model actual content movement,
 * while native DOM events exercise the controller rather than its private fields. */
function fixture(t: TestContext) {
  const dom = new JSDOM('<!doctype html><div id="viewport"><div id="content"></div></div>', {
    pretendToBeVisual: true,
  });
  const viewport = dom.window.document.getElementById('viewport')!;
  const content = dom.window.document.getElementById('content')!;
  const layout = { height: 400, width: 600, total: 2400, top: 100, scroll: 0 };
  const writes: number[] = [];
  Object.defineProperties(viewport, {
    clientHeight: { configurable: true, get: () => layout.height },
    clientWidth: { configurable: true, get: () => layout.width },
    clientTop: { configurable: true, value: 0 },
    scrollHeight: { configurable: true, get: () => layout.total },
    scrollTop: {
      configurable: true,
      get: () => layout.scroll,
      set: (value: number) => {
        layout.scroll = Math.max(0, Math.min(layout.total - layout.height, value));
        writes.push(layout.scroll);
      },
    },
  });
  viewport.getBoundingClientRect = () => rectangle(layout.top, layout.height, layout.width);
  content.getBoundingClientRect = () =>
    rectangle(layout.top - layout.scroll, layout.total, layout.width);
  const resizeCallbacks = new Set<() => void>();
  class ResizeObserver {
    constructor(readonly callback: () => void) {
      resizeCallbacks.add(callback);
    }
    observe() {}
    unobserve() {}
    disconnect() {
      resizeCallbacks.delete(this.callback);
    }
  }
  Object.defineProperty(dom.window, 'ResizeObserver', {
    configurable: true,
    value: ResizeObserver,
  });
  const cards: Card[] = [];
  const addCard = (id: string, top: number, height: number, blockOffsets = [0]) => {
    const element = dom.window.document.createElement('article');
    element.dataset.scrollAnchor = `message:${id}`;
    element.dataset.messageId = id;
    const card: Card = { element, top, height, blocks: [] };
    element.getBoundingClientRect = () =>
      rectangle(layout.top + card.top - layout.scroll, card.height, layout.width);
    for (const [index, offset] of blockOffsets.entries()) {
      const paragraph = dom.window.document.createElement('p');
      paragraph.textContent = `${id} paragraph ${index}: readable content ` + 'word '.repeat(80);
      const block = {
        element: paragraph,
        top: offset,
        height: (blockOffsets[index + 1] ?? height) - offset,
      };
      paragraph.getBoundingClientRect = () =>
        rectangle(layout.top + card.top + block.top - layout.scroll, block.height, layout.width);
      card.blocks.push(block);
      element.append(paragraph);
    }
    cards.push(card);
    content.append(element);
    return card;
  };
  const a = addCard('aster', 0, 800, [0, 400]);
  const b = addCard('nova', 800, 1000, [0, 300, 650]);
  const c = addCard('moss', 1800, 600, [0, 300]);
  let state: ChatScrollState = { following: true, hasUpdates: false };
  let manager = new ChatScrollManager('room-a', viewport, content, (next) => {
    state = next;
  });
  const scrollEvent = () => viewport.dispatchEvent(new dom.window.Event('scroll'));
  scrollEvent();
  manager.reconcile(['initial']);
  const move = (top: number) => {
    viewport.scrollTop = top;
    scrollEvent();
  };
  const wheel = (deltaY: number, target: HTMLElement = viewport) =>
    target.dispatchEvent(new dom.window.WheelEvent('wheel', { deltaY, bubbles: true }));
  const key = (value: string, target: HTMLElement = viewport) =>
    target.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: value, bubbles: true }));
  const readAt = (top: number) => {
    wheel(-20);
    move(top);
  };
  const resize = () => {
    for (const callback of resizeCallbacks) callback();
  };
  const changeRoom = () => {
    manager.destroy();
    manager = new ChatScrollManager('room-b', viewport, content, (next) => {
      state = next;
    });
    manager.reconcile(['room-b-content']);
  };
  t.after(() => {
    manager.destroy();
    dom.window.close();
  });
  return {
    dom,
    viewport,
    content,
    layout,
    writes,
    cards,
    a,
    b,
    c,
    addCard,
    move,
    wheel,
    key,
    readAt,
    resize,
    scrollEvent,
    changeRoom,
    get manager() {
      return manager;
    },
    get state() {
      return state;
    },
  };
}

test('a small upward gesture detaches immediately, even inside the old 100px sticky zone', (t) => {
  const f = fixture(t);
  assert.equal(f.viewport.scrollTop, 2000);
  f.wheel(-20);
  assert.equal(
    f.state.following,
    false,
    'Do not wait for a subsequent scroll event before releasing the tail.',
  );
  f.move(1980);
  f.c.height += 300;
  f.c.blocks[1]!.height += 300;
  f.layout.total += 300;
  f.manager.reconcile(['a streamed response']);
  assert.equal(f.viewport.scrollTop, 1980);
  assert.deepEqual(f.state, { following: false, hasUpdates: true });
  f.manager.followLatest();
  assert.equal(f.viewport.scrollTop, 2300);
  assert.deepEqual(f.state, { following: true, hasUpdates: false });
  f.layout.total += 100;
  f.manager.reconcile(['another streamed response']);
  assert.equal(f.viewport.scrollTop, 2400);
});

test('another bot growing above the visible message preserves its screen position', (t) => {
  const f = fixture(t);
  f.readAt(920);
  const original = f.b.blocks[0]!.element.getBoundingClientRect().top;
  f.a.height += 360;
  f.b.top += 360;
  f.c.top += 360;
  f.layout.total += 360;
  f.manager.reconcile(['aster grew above nova']);
  assert.equal(f.viewport.scrollTop, 1280);
  assert.equal(f.b.blocks[0]!.element.getBoundingClientRect().top, original);
  f.scrollEvent();
  assert.equal(
    f.state.following,
    false,
    'Our anchor correction must never re-enable tail following.',
  );
});

test('a partially visible paragraph stays anchored when earlier blocks in the same message expand', (t) => {
  const f = fixture(t);
  f.readAt(1160);
  const paragraph = f.b.blocks[1]!;
  const original = paragraph.element.getBoundingClientRect().top;
  f.b.blocks[0]!.height += 240;
  paragraph.top += 240;
  f.b.blocks[2]!.top += 240;
  f.b.height += 240;
  f.c.top += 240;
  f.layout.total += 240;
  f.manager.reconcile(['expanded reasoning above the answer']);
  assert.equal(f.viewport.scrollTop, 1400);
  assert.equal(paragraph.element.getBoundingClientRect().top, original);
});

test('viewport reflow keeps a visible character at its reading line inside a long paragraph', (t) => {
  const f = fixture(t);
  const paragraph = f.b.blocks[1]!;
  const text = paragraph.element.firstChild!;
  const character = 160;
  const lineTop = () =>
    f.layout.top +
    f.b.top +
    paragraph.top +
    Math.floor(character / (f.layout.width / 10)) * 20 -
    f.layout.scroll;
  Object.defineProperty(f.dom.window.document, 'caretPositionFromPoint', {
    configurable: true,
    value: () => ({ offsetNode: text, offset: character }),
  });
  Object.defineProperty(f.dom.window.Range.prototype, 'getBoundingClientRect', {
    configurable: true,
    value() {
      return rectangle(lineTop(), 20, 8, 80);
    },
  });
  f.readAt(1140);
  const before = lineTop();
  f.layout.width = 300;
  f.layout.height = 320;
  f.layout.total += 500;
  f.resize();
  assert.equal(
    lineTop(),
    before,
    'Keep the same character visible after the sidebar/focus-mode width change.',
  );
  assert.equal(f.viewport.scrollTop, 1200);
  assert.equal(f.state.following, false);
});

test('loading older messages adjusts for the prefix only, not simultaneous growth below the reader', (t) => {
  const f = fixture(t);
  f.readAt(1000);
  f.manager.pause();
  const original = f.b.blocks[0]!.element.getBoundingClientRect().top;
  for (const card of f.cards) card.top += 700;
  f.addCard('earlier-history', 0, 700);
  f.content.prepend(f.cards.at(-1)!.element);
  f.layout.total += 700 + 250;
  f.c.height += 250;
  f.manager.reconcile(['new data below, plus older rendered history']);
  assert.equal(f.viewport.scrollTop, 1700);
  assert.equal(f.b.blocks[0]!.element.getBoundingClientRect().top, original);
});

test('a native user scroll before its scroll event is preserved alongside a layout correction', (t) => {
  const f = fixture(t);
  f.readAt(1000);
  f.wheel(-40);
  f.viewport.scrollTop = 960; // The browser has scrolled, but has not dispatched scroll yet.
  f.a.height += 200;
  f.b.top += 200;
  f.c.top += 200;
  f.layout.total += 200;
  f.manager.reconcile(['stream arrived between wheel and scroll']);
  assert.equal(
    f.viewport.scrollTop,
    1160,
    'Add only the upstream layout shift, preserving the user’s 40px move.',
  );
  f.scrollEvent();
  assert.equal(f.state.following, false);
});

test('only explicit downward intent at the actual end resumes following', (t) => {
  const f = fixture(t);
  f.readAt(1400);
  f.move(2000); // Layout/programmatic/accessibility position change, without down intent.
  assert.equal(f.state.following, false);
  f.layout.total += 100;
  f.manager.reconcile(['later content']);
  assert.equal(f.state.following, false);
  f.wheel(80);
  f.move(2100);
  assert.equal(f.state.following, true);
  f.readAt(1000);
  f.key('End');
  assert.equal(f.viewport.scrollTop, 2100);
  assert.equal(f.state.following, true);
});

test('a held scrollbar preserves later native drag moves before their scroll notifications', (t) => {
  const f = fixture(t);
  f.readAt(1000);
  f.viewport.dispatchEvent(
    new f.dom.window.MouseEvent('pointerdown', { button: 0, bubbles: true }),
  );
  f.move(960); // The first drag movement has already delivered its scroll event.
  f.viewport.scrollTop = 920; // A later drag movement has not delivered it yet.
  f.manager.reconcile(['stream commit between successive drag notifications']);
  assert.equal(
    f.viewport.scrollTop,
    920,
    'Do not undo continued scrollbar motion while the pointer is held.',
  );
  f.scrollEvent();
  assert.equal(f.state.following, false);
  f.dom.window.dispatchEvent(new f.dom.window.MouseEvent('pointerup'));
});

test('nested reasoning scrolls pause the conversation without treating their bottom as the chat bottom', (t) => {
  const f = fixture(t);
  const pre = f.dom.window.document.createElement('pre');
  pre.style.overflowY = 'auto';
  Object.defineProperties(pre, { clientHeight: { value: 100 }, scrollHeight: { value: 500 } });
  f.c.element.append(pre);
  f.wheel(-40, pre);
  assert.equal(f.state.following, false);
  f.wheel(40, pre);
  assert.equal(f.state.following, false);
  f.layout.total += 100;
  f.manager.reconcile(['another bot generated while reasoning is being read']);
  assert.equal(f.viewport.scrollTop, 2000);
});

test('image sizing and disclosure changes reconcile through observers, without a scroll animation loop', async (t) => {
  const f = fixture(t);
  f.readAt(900);
  const original = f.b.blocks[0]!.element.getBoundingClientRect().top;
  f.a.height += 180;
  f.b.top += 180;
  f.c.top += 180;
  f.layout.total += 180;
  f.resize();
  assert.equal(f.b.blocks[0]!.element.getBoundingClientRect().top, original);
  const image = f.dom.window.document.createElement('img');
  f.a.element.append(image);
  f.a.height += 90;
  f.b.top += 90;
  f.c.top += 90;
  f.layout.total += 90;
  image.dispatchEvent(new f.dom.window.Event('load'));
  await new Promise<void>((resolve) => f.dom.window.requestAnimationFrame(() => resolve()));
  assert.equal(f.viewport.scrollTop, 1170);
  assert.equal(f.b.blocks[0]!.element.getBoundingClientRect().top, original);
  const writes = f.writes.length;
  await new Promise<void>((resolve) => f.dom.window.requestAnimationFrame(() => resolve()));
  assert.equal(
    f.writes.length,
    writes,
    'No continuously scheduled smooth-follow work should remain.',
  );
});

test('an explicit task jump stays paused across subsequent streams, including jumps near the tail', (t) => {
  const f = fixture(t);
  f.manager.focusElement(f.b.element);
  assert.equal(f.dom.window.document.activeElement, f.b.element);
  assert.equal(f.state.following, false);
  const original = f.b.element.getBoundingClientRect().top;
  for (let index = 0; index < 2; index++) {
    f.a.blocks[1]!.height += 120;
    f.a.height += 120;
    f.b.top += 120;
    f.c.top += 120;
    f.layout.total += 120;
    f.manager.reconcile([`stream-${index}`]);
    f.scrollEvent();
    assert.equal(
      f.b.element.getBoundingClientRect().top,
      original,
      'Keep the chosen bot, even when a sliver of the previous bot remains visible.',
    );
    assert.equal(f.state.following, false);
  }
  f.manager.focusElement(f.c.blocks[1]!.element);
  f.scrollEvent();
  assert.equal(f.state.following, false);
});

test('switching rooms drops the old reading anchor and opens the new room at its latest content', (t) => {
  const f = fixture(t);
  f.readAt(850);
  f.manager.reconcile(['unread room-a changes']);
  f.layout.total = 3100;
  f.changeRoom();
  assert.equal(f.manager.roomId, 'room-b');
  assert.equal(f.viewport.scrollTop, 2700);
  assert.deepEqual(f.state, { following: true, hasUpdates: false });
  f.layout.total += 100;
  f.resize();
  assert.equal(f.viewport.scrollTop, 2800);
});
