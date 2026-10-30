import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, existsSync, readFileSync, writeFileSync, chmodSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import type { Settings, Bot, Room } from '../shared/types.js';
import { DEFAULT_IMAGE_SETTINGS, DEFAULT_INFERENCE_SETTINGS } from '../shared/model-settings.js';
export const now = () => new Date().toISOString();
export const id = (prefix: string) => `${prefix}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;
export class Store {
  readonly db: DatabaseSync;
  readonly dataDir: string;
  private key: Buffer;
  constructor(dataDir: string) {
    this.dataDir = resolve(dataDir);
    mkdirSync(this.dataDir, { recursive: true, mode: 0o700 });
    const keyPath = join(this.dataDir, 'secret.key');
    if (!existsSync(keyPath)) writeFileSync(keyPath, randomBytes(32), { mode: 0o600, flag: 'wx' });
    this.key = readFileSync(keyPath);
    if (this.key.length !== 32)
      throw new Error('Invalid encryption key. Restore secret.key from your backup.');
    this.db = new DatabaseSync(join(this.dataDir, 'loom.sqlite'));
    try {
      // Hold an OS-backed SQLite lock for this connection's lifetime. A second
      // process must fail before seed/recovery can change a live owner's tasks.
      this.db.exec(
        'PRAGMA busy_timeout=100; PRAGMA locking_mode=EXCLUSIVE; PRAGMA journal_mode=WAL; BEGIN EXCLUSIVE; COMMIT;',
      );
    } catch (error) {
      this.db.close();
      if (/locked|busy/i.test((error as Error).message))
        throw new Error(
          'This data directory is already in use. Stop the other Agent Loom instance before starting another.',
        );
      throw error;
    }
    this.db.exec(`PRAGMA foreign_keys=ON;
      CREATE TABLE IF NOT EXISTS objects(kind TEXT NOT NULL,id TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,PRIMARY KEY(kind,id));
      CREATE INDEX IF NOT EXISTS objects_kind_created ON objects(kind,created_at);
      CREATE TABLE IF NOT EXISTS secrets(key TEXT PRIMARY KEY,value TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(id INTEGER PRIMARY KEY AUTOINCREMENT,type TEXT NOT NULL,data TEXT NOT NULL,created_at TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS dedup(key TEXT PRIMARY KEY,created_at TEXT NOT NULL);
      PRAGMA user_version=1;`);
    try {
      chmodSync(join(this.dataDir, 'loom.sqlite'), 0o600);
    } catch {
      /* Windows file ACLs are inherited. */
    }
  }
  get<T>(kind: string, key: string): T | undefined {
    const row = this.db.prepare('SELECT data FROM objects WHERE kind=? AND id=?').get(kind, key) as
      { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }
  list<T>(kind: string): T[] {
    return (
      this.db
        .prepare('SELECT data FROM objects WHERE kind=? ORDER BY created_at ASC,id ASC')
        .all(kind) as { data: string }[]
    ).map((r) => JSON.parse(r.data) as T);
  }
  put<T extends { id: string }>(kind: string, value: T): T {
    const stamp = now();
    this.db
      .prepare(
        'INSERT INTO objects(kind,id,data,created_at,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(kind,id) DO UPDATE SET data=excluded.data,updated_at=excluded.updated_at',
      )
      .run(kind, value.id, JSON.stringify(value), stamp, stamp);
    return value;
  }
  patch<T extends { id: string }>(kind: string, key: string, patch: Partial<T>): T {
    const old = this.get<T>(kind, key);
    if (!old) throw Object.assign(new Error('Not found'), { statusCode: 404 });
    return this.put(kind, { ...old, ...patch, id: key });
  }
  remove(kind: string, key: string): boolean {
    return this.db.prepare('DELETE FROM objects WHERE kind=? AND id=?').run(kind, key).changes > 0;
  }
  remember(key: string): boolean {
    return (
      this.db.prepare('INSERT OR IGNORE INTO dedup(key,created_at) VALUES(?,?)').run(key, now())
        .changes > 0
    );
  }
  secret(name: string): string {
    const row = this.db.prepare('SELECT value FROM secrets WHERE key=?').get(name) as
      { value: string } | undefined;
    if (!row) return '';
    const [iv, tag, body] = row.value.split('.');
    const d = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64'));
    d.setAuthTag(Buffer.from(tag, 'base64'));
    return Buffer.concat([d.update(Buffer.from(body, 'base64')), d.final()]).toString('utf8');
  }
  setSecret(name: string, value: string) {
    if (!value) {
      this.db.prepare('DELETE FROM secrets WHERE key=?').run(name);
      return;
    }
    const iv = randomBytes(12);
    const c = createCipheriv('aes-256-gcm', this.key, iv);
    const body = Buffer.concat([c.update(value, 'utf8'), c.final()]);
    this.db
      .prepare(
        'INSERT INTO secrets(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
      )
      .run(name, [iv, c.getAuthTag(), body].map((b) => b.toString('base64')).join('.'));
  }
  event(type: string, data: unknown): number {
    return Number(
      this.db
        .prepare('INSERT INTO events(type,data,created_at) VALUES(?,?,?)')
        .run(type, JSON.stringify(data), now()).lastInsertRowid,
    );
  }
  close() {
    this.db.close();
  }
  settings(): Settings {
    const saved = this.get<Settings & { id: string }>('settings', 'main');
    if (!saved) throw new Error('Settings not initialized');
    const { id: _, ...settings } = saved;
    settings.inference = { ...DEFAULT_INFERENCE_SETTINGS, ...settings.inference };
    settings.images = { ...DEFAULT_IMAGE_SETTINGS, ...settings.images };
    settings.model.apiKeyConfigured = Boolean(this.secret('model.apiKey'));
    settings.search.apiKeyConfigured = Boolean(this.secret('search.apiKey'));
    settings.images.apiKeyConfigured = Boolean(this.secret('image.apiKey'));
    return settings;
  }
  seed() {
    if (!this.get('settings', 'main')) {
      const settings: Settings = {
        model: {
          baseUrl: process.env.LOOM_MODEL_BASE_URL || '',
          modelId: process.env.LOOM_MODEL_ID || '',
          apiKeyConfigured: false,
          contextWindow: 32768,
          maxOutputTokens: 4096,
          temperature: 0.5,
        },
        demoMode: false,
        inference: { ...DEFAULT_INFERENCE_SETTINGS },
        images: { ...DEFAULT_IMAGE_SETTINGS },
        autoLearn: true,
        maxHandoffs: 6,
        workspacePath: join(this.dataDir, 'workspace'),
        permissions: { shell: 'ask', fileWrite: 'ask', network: 'allow' },
        search: { provider: 'none', baseUrl: '', apiKeyConfigured: false },
      };
      this.put('settings', { ...settings, id: 'main' });
      if (process.env.LOOM_MODEL_API_KEY)
        this.setSecret('model.apiKey', process.env.LOOM_MODEL_API_KEY);
      mkdirSync(settings.workspacePath, { recursive: true, mode: 0o700 });
    }
    if (this.get('meta', 'initialBotsSeeded')) return;
    if (!this.list('bots').length) {
      const bots: Bot[] = [
        {
          id: 'bot_aster',
          name: 'Aster',
          handle: 'aster',
          role: '整理・計画',
          systemPrompt:
            'You are Aster, a thoughtful coordinator. Clarify goals, make concise plans, use tools when needed, and give actionable updates in the user’s language. Ask Nova for focused research when useful. Distinguish observations from assumptions. Never claim an action succeeded without tool evidence.',
          color: '#7c9885',
          avatar: 'sparkles',
          enabled: true,
          createdAt: now(),
        },
        {
          id: 'bot_nova',
          name: 'Nova',
          handle: 'nova',
          role: '調査・検証',
          systemPrompt:
            'You are Nova, a careful researcher and reviewer. Gather evidence, verify claims using available tools, report sources and uncertainty. Collaborate with Aster through directed messages when necessary. Be concise and use the user’s language. Do not invent tool results.',
          color: '#c29a6c',
          avatar: 'compass',
          enabled: true,
          createdAt: now(),
        },
      ];
      bots.forEach((bot) => this.put('bots', bot));
      const room: Room = {
        id: 'room_lounge',
        name: 'ラウンジ',
        description: '考えを持ち寄り、一緒に進める場所。',
        botIds: bots.map((b) => b.id),
        pinned: true,
        archived: false,
        createdAt: now(),
        updatedAt: now(),
      };
      this.put('rooms', room);
    }
    this.put('meta', { id: 'initialBotsSeeded', value: true });
  }
}
