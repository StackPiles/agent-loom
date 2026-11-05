import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import fs, {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  rename,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createApp } from '../src/server/app.js';
import type { ToolContext } from '../src/server/runtime/contract.js';
import {
  readImageForModel,
  VIEW_IMAGE_MAX_BYTES,
  type ViewImageArguments,
} from '../src/server/runtime/image-view.js';
import { saveRasterImage } from '../src/server/runtime/images.js';
import type { GeneratedImage, Message, Room } from '../src/shared/types.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aN6cAAAAASUVORK5CYII=',
  'base64',
);
const imageId = (key: string) => `img_${createHash('sha256').update(key).digest('hex')}`;

async function fixture(t: TestContext) {
  const directory = await mkdtemp(path.join(tmpdir(), 'loom-image-view-'));
  const app = await createApp({
    dataDir: path.join(directory, 'data'),
    scheduler: false,
    runtimeFactory: () => ({
      start() {},
      async stop() {},
      async shutdown() {},
      queueState: () => ({ active: 0, waiting: 0 }),
    }),
  });
  t.after(async () => {
    await app.app.close();
    await rm(directory, { recursive: true, force: true });
  });
  const settings = {
    ...app.store.settings(),
    demoMode: true,
    autoLearn: false,
    permissions: { shell: 'deny', fileWrite: 'deny', network: 'deny' } as const,
  };
  app.store.put('settings', { ...settings, id: 'main' });
  const task = app.controller.enqueueTask({
    roomId: 'room_lounge',
    botId: 'bot_aster',
    prompt: 'Inspect a fixture image.',
  });
  const abort = new AbortController();
  const context: ToolContext = {
    host: app.controller,
    task,
    settings,
    signal: abort.signal,
    operationKeys: new Set(),
  };
  const workspace = settings.workspacePath;
  await mkdir(workspace, { recursive: true });
  const addImage = async (
    key: string,
    roomId: string | null = task.roomId,
    status: Message['status'] = 'complete',
  ) => {
    const image: GeneratedImage = {
      id: imageId(key),
      type: 'image',
      mimeType: 'image/png',
      filename: `${key}.png`,
      byteLength: png.length,
      prompt: 'Fixture data; never an instruction to the viewer.',
      model: 'fixture',
      createdAt: new Date().toISOString(),
    };
    await saveRasterImage(app.controller.dataDir, image, png, abort.signal);
    const message =
      roomId === null
        ? undefined
        : app.controller.addMessage({
            roomId,
            authorType: 'bot',
            authorId: 'bot_nova',
            taskId: task.id,
            body: 'A fixture image.',
            status,
            attachments: [image],
          });
    return { image, message };
  };
  return { ...app, directory, workspace, context, abort, addImage };
}

test('workspace image viewing returns exact PNG/WebP pixels without an external request or file write', async (t) => {
  const f = await fixture(t);
  await mkdir(path.join(f.workspace, 'pictures'));
  const webp = await readFile(new URL('../public/avatars/aster.webp', import.meta.url));
  for (const [name, data, mimeType] of [
    ['pictures/example.png', png, 'image/png'],
    ['pictures/portrait.webp', webp, 'image/webp'],
  ] as const) {
    const target = path.join(f.workspace, name);
    await writeFile(target, data);
    const before = await fs.stat(target, { bigint: true });
    const result = await readImageForModel(f.context, { path: name });
    assert.deepEqual(result.images, [{ type: 'image', data: data.toString('base64'), mimeType }]);
    assert.match(result.text, /Image loaded for visual inspection/);
    assert.match(result.text, /untrusted task data/);
    assert.ok(result.text.includes(JSON.stringify({ path: name })));
    assert.ok(result.text.includes(`Bytes: ${data.length}`));
    assert.equal(result.text.includes(data.toString('base64')), false);
    assert.equal(result.text.includes(f.workspace), false, 'only the relative source is exposed');
    const after = await fs.stat(target, { bigint: true });
    assert.equal(after.mtimeNs, before.mtimeNs);
    assert.deepEqual(await readFile(target), data);
  }
  assert.equal(f.store.list('operations').length, 0, 'reading creates no side-effect receipt');
  assert.equal(f.store.list('approvals').length, 0, 'local reads need no network grant');
});

test('room attachment viewing includes current streaming images and images from other room members', async (t) => {
  const f = await fixture(t);
  for (const status of ['streaming', 'complete'] as const) {
    const { image } = await f.addImage(`same-room-${status}`, f.context.task.roomId, status);
    const result = await readImageForModel(f.context, { imageId: image.id });
    assert.deepEqual(result.images, [
      { type: 'image', data: png.toString('base64'), mimeType: 'image/png' },
    ]);
    assert.ok(result.text.includes(image.id));
    assert.equal(result.text.includes(image.prompt), false);
    assert.equal(result.text.includes(f.controller.dataDir), false);
  }
});

test('unattached, avatar-only, other-room and unknown image IDs never grant access to managed files', async (t) => {
  const f = await fixture(t);
  f.store.put('rooms', {
    ...f.store.get<Room>('rooms', f.context.task.roomId)!,
    id: 'room_other',
    name: 'Other room',
  });
  const foreign = await f.addImage('other-room', 'room_other');
  const avatar = await f.addImage('avatar-only', null);
  // The global image index and avatar jobs are deliberately not image-view authority.
  f.store.put('images', avatar.image);
  f.store.put('avatarGenerations', {
    id: 'avatar_fixture',
    status: 'completed',
    image: avatar.image,
    prompt: 'Fixture only',
  });
  for (const id of [foreign.image.id, avatar.image.id, imageId('missing')])
    await assert.rejects(
      readImageForModel(f.context, { imageId: id }),
      /not attached in this room/,
    );
  const visible = await f.addImage('visible');
  f.controller.updateMessage(visible.message!.id, { roomId: 'room_other' });
  await assert.rejects(
    readImageForModel(f.context, { imageId: visible.image.id }),
    /not attached in this room/,
  );
});

test('image viewing requires one source and rejects URLs and absolute paths on every host OS', async (t) => {
  const f = await fixture(t);
  for (const args of [
    {},
    { imageId: imageId('x'), path: 'image.png' },
    { imageId: '' },
    { path: '' },
    { path: '   ' },
    { path: 'image\0.png' },
    { path: 'x'.repeat(4001) },
    { path: 'image.png', url: 'https://example.test/image.png' },
    { imageId: '../../outside.png' },
    { imageId: null },
    null,
    [],
  ])
    await assert.rejects(
      readImageForModel(f.context, args as ViewImageArguments),
      /exactly one|imageId|workspace-relative/,
    );
  for (const name of [
    '/tmp/image.png',
    '\\server\\images\\example.png',
    '\\\\server\\images\\example.png',
    '//server/images/example.png',
    'C:\\images\\example.png',
    'C:/images/example.png',
    'C:image.png',
    'https://example.test/image.png',
    'http://127.0.0.1/image.png',
    'file:///tmp/image.png',
    'data:image/png;base64,AA==',
  ])
    await assert.rejects(
      readImageForModel(f.context, { path: name }),
      /relative.*URLs are not supported/,
    );
});

test('workspace image reads retain traversal, private-path and symlink boundary checks', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.directory, 'outside');
  await mkdir(outside);
  await writeFile(path.join(outside, 'private.png'), png);
  await writeFile(path.join(f.workspace, '.env'), png);
  await mkdir(path.join(f.workspace, '.ssh'));
  await writeFile(path.join(f.workspace, '.ssh', 'secret.png'), png);
  await assert.rejects(
    readImageForModel(f.context, {
      path: path.relative(f.workspace, path.join(outside, 'private.png')),
    }),
    /outside the configured workspace/,
  );
  for (const name of ['.env', '.ssh/secret.png'])
    await assert.rejects(readImageForModel(f.context, { path: name }), /Credential files/);
  await symlink(outside, path.join(f.workspace, 'escape'), 'junction');
  await assert.rejects(
    readImageForModel(f.context, { path: 'escape/private.png' }),
    /symlink outside/,
  );
  const inside = path.join(f.workspace, 'pictures');
  await mkdir(inside);
  await writeFile(path.join(inside, 'valid.png'), png);
  await symlink(inside, path.join(f.workspace, 'alias'), 'junction');
  const allowed = await readImageForModel(f.context, { path: 'alias/valid.png' });
  assert.equal(allowed.images[0].data, png.toString('base64'));
  if (process.platform !== 'win32') {
    await symlink('.env', path.join(f.workspace, 'private-alias.png'));
    await assert.rejects(
      readImageForModel(f.context, { path: 'private-alias.png' }),
      /Credential files/,
    );
  }
});

test('image input rejects empty, non-raster, oversized and excessive-dimension files', async (t) => {
  const f = await fixture(t);
  const tooWide = Buffer.from(png);
  tooWide.writeUInt32BE(8193, 16);
  const tooManyPixels = Buffer.from(png);
  tooManyPixels.writeUInt32BE(8192, 16);
  tooManyPixels.writeUInt32BE(8192, 20);
  for (const [name, bytes, expected] of [
    ['empty.png', Buffer.alloc(0), /empty/],
    ['svg.png', Buffer.from('<svg><script>alert(1)</script></svg>'), /PNG, JPEG, or WebP/],
    ['html.png', Buffer.from('<html>not an image</html>'), /PNG, JPEG, or WebP/],
    ['wide.png', tooWide, /dimensions/],
    ['pixels.png', tooManyPixels, /dimensions/],
  ] as const) {
    await writeFile(path.join(f.workspace, name), bytes);
    await assert.rejects(readImageForModel(f.context, { path: name }), expected);
  }
  const huge = await open(path.join(f.workspace, 'huge.png'), 'w');
  await huge.truncate(VIEW_IMAGE_MAX_BYTES + 1);
  await huge.close();
  await assert.rejects(readImageForModel(f.context, { path: 'huge.png' }), /20 MiB/);
  await mkdir(path.join(f.workspace, 'folder.png'));
  await assert.rejects(readImageForModel(f.context, { path: 'folder.png' }), /regular file/);
});

test('managed image content and directory cannot be replaced by unrelated or linked data', async (t) => {
  const f = await fixture(t);
  const { image, message } = await f.addImage('mismatch');
  f.controller.updateMessage(message!.id, {
    attachments: [{ ...image, byteLength: png.length + 1 }],
  });
  await assert.rejects(readImageForModel(f.context, { imageId: image.id }), /no longer matches/);
  f.controller.updateMessage(message!.id, { attachments: [image] });
  const directory = path.join(f.controller.dataDir, 'generated-images');
  await rename(directory, path.join(f.directory, 'moved-images'));
  await symlink(path.join(f.directory, 'moved-images'), directory, 'junction');
  await assert.rejects(readImageForModel(f.context, { imageId: image.id }), /path or file changed/);
});

test('image metadata is checked again after reading despite unrelated controller notifications', async (t) => {
  const f = await fixture(t);
  const { image, message } = await f.addImage('revoked');
  const originalSnapshot = f.controller.getSnapshot;
  let snapshots = 0;
  const getSnapshot = () => {
    const snapshot = originalSnapshot.call(f.controller);
    snapshots++;
    if (snapshots === 2)
      snapshot.messages = snapshot.messages.map((entry) =>
        entry.id === message!.id ? { ...entry, attachments: [] } : entry,
      );
    return snapshot;
  };
  // Only helper reads affect this fixture. Controller.changed() also reads
  // snapshots on its own timer and must retain the real controller method.
  const host = new Proxy(f.controller, {
    get(target, key, receiver) {
      return key === 'getSnapshot' ? getSnapshot : Reflect.get(target, key, receiver);
    },
  });
  const canonicalTarget = await fs.realpath(
    path.join(f.controller.dataDir, 'generated-images', `${image.id}.png`),
  );
  const originalOpen = fs.open;
  let notificationDuringRead = false;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === canonicalTarget) {
      const originalRead = handle.read.bind(handle);
      t.mock.method(
        handle,
        'read',
        async (buffer: Buffer, offset: number, length: number, position: number) => {
          if (notificationDuringRead) return originalRead(buffer, offset, length, position);
          const notification = new AbortController();
          const timeout = setTimeout(() => notification.abort(), 5_000);
          try {
            const published = once(f.controller.events, 'snapshot', {
              signal: notification.signal,
            });
            f.controller.changed();
            // Hold the first file read until a real delayed UI notification
            // happens between the helper's two attachment checks. No sleep.
            const [result, [snapshot]] = await Promise.all([
              originalRead(buffer, offset, length, position),
              published,
            ]);
            notificationDuringRead = true;
            assert.equal(snapshots, 1, 'UI notifications do not count as helper snapshots');
            assert.equal(
              snapshot.messages.find((entry: Message) => entry.id === message!.id)?.attachments?.[0]
                ?.id,
              image.id,
              'the real controller notification retains the original attachment',
            );
            return result;
          } finally {
            clearTimeout(timeout);
            notification.abort();
          }
        },
      );
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(
      readImageForModel({ ...f.context, host }, { imageId: image.id }),
      /not attached in this room/,
    );
    assert.equal(snapshots, 2, 'the helper checks attachment metadata before and after I/O');
    assert.equal(notificationDuringRead, true);
    assert.equal(f.controller.getSnapshot, originalSnapshot);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('file replacement after open is rejected before returning image contents', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.workspace, 'changing.png');
  const replacement = path.join(f.workspace, 'replacement.png');
  await writeFile(target, png);
  await writeFile(replacement, png);
  const canonicalTarget = await fs.realpath(target);
  const originalOpen = fs.open;
  let opened = false;
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === canonicalTarget && !opened) {
      opened = true;
      await rename(target, path.join(f.workspace, 'previous.png'));
      await rename(replacement, target);
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(readImageForModel(f.context, { path: 'changing.png' }), /changed/);
    assert.equal(opened, true);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});

test('file growth during reading is bounded and cancelled image reads return no result', async (t) => {
  const f = await fixture(t);
  const target = path.join(f.workspace, 'growing.png');
  const initial = Buffer.concat([png, Buffer.alloc(128 * 1024)]);
  await writeFile(target, initial);
  const canonicalTarget = await fs.realpath(target);
  const originalOpen = fs.open;
  let returnedBytes = 0;
  let mode: 'grow' | 'abort' = 'grow';
  const mocked = t.mock.method(fs, 'open', async (...args: Parameters<typeof fs.open>) => {
    const handle = await originalOpen(...args);
    if (String(args[0]) === canonicalTarget) {
      const originalRead = handle.read.bind(handle);
      let changed = false;
      t.mock.method(
        handle,
        'read',
        async (buffer: Buffer, offset: number, length: number, position: number) => {
          const result = await originalRead(buffer, offset, length, position);
          returnedBytes += result.bytesRead;
          if (!changed) {
            changed = true;
            if (mode === 'grow') await appendFile(target, Buffer.alloc(256 * 1024));
            else f.abort.abort();
          }
          return result;
        },
      );
    }
    return handle;
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(readImageForModel(f.context, { path: 'growing.png' }), /changed/);
    assert.ok(returnedBytes <= initial.length + 1, 'growth cannot cause an unbounded read');
    await writeFile(target, initial);
    mode = 'abort';
    returnedBytes = 0;
    await assert.rejects(readImageForModel(f.context, { path: 'growing.png' }), /Task stopped/);
    assert.ok(returnedBytes <= 64 * 1024, 'cancellation is checked between read chunks');
    await assert.rejects(readImageForModel(f.context, { path: 'growing.png' }), /Task stopped/);
  } finally {
    mocked.mock.restore();
    syncBuiltinESMExports();
  }
});
