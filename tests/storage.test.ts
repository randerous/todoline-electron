// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { DocumentStore } from '../src/main/storage';
import { attachDatabaseWorker } from '../src/main/db-worker';
import type { DocumentSnapshot, EventRecord, SaveRequest } from '../src/shared/types';

// Windows can deny replacement of a live SQLite file. Model a changed stat identity
// at the filesystem boundary without modifying the native ESM module namespace.
vi.mock('node:fs', async importOriginal => {
  const actual = await importOriginal<typeof fs>();
  return { ...actual, statSync: vi.fn(actual.statSync) };
});

// Independent synthetic fixtures mirror database.cpp; no real user databases are opened.
const LEGACY_SCHEMA = `
  CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
  INSERT INTO meta VALUES('format_version', '1');
  CREATE TABLE events(id INTEGER PRIMARY KEY AUTOINCREMENT, pos REAL NOT NULL,
    created_at INTEGER NOT NULL, deadline_raw TEXT NOT NULL DEFAULT '', deadline_ts INTEGER,
    done INTEGER NOT NULL DEFAULT 0, content_html TEXT NOT NULL DEFAULT '', content_text TEXT NOT NULL DEFAULT '');
  CREATE TABLE assets(id INTEGER PRIMARY KEY AUTOINCREMENT,
    w INTEGER NOT NULL DEFAULT 0, h INTEGER NOT NULL DEFAULT 0, data BLOB NOT NULL);
`;
const LEGACY_TRIGGERS = `
  CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, content_text, deadline_raw)
    VALUES (new.id, lower(new.content_text), lower(new.deadline_raw)); END;
  CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
    DELETE FROM events_fts WHERE rowid = old.id; END;
  CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
    DELETE FROM events_fts WHERE rowid = new.id;
    INSERT INTO events_fts(rowid, content_text, deadline_raw)
    VALUES (new.id, lower(new.content_text), lower(new.deadline_raw)); END;
`;
const bytes = Buffer.from(Array.from({ length: 16384 }, (_, index) => (index * 37) % 256));
const hash = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const event = (id: number, text = '计划明天开会', pos = 100): EventRecord => ({
  id, pos, created_at: 1700000000, deadline_raw: '周三 09:30', deadline_ts: null,
  done: 0, top_divider: 0, content_html: `<p>${text}</p>`, content_text: text,
});
const request = (snapshot: DocumentSnapshot, events = snapshot.events): SaveRequest => ({
  handle: snapshot.handle, revision: snapshot.revision, events,
});

let root: string;
let store: DocumentStore;
let connections: Database.Database[];
function connect(path: string, readonly = false): Database.Database {
  const db = new Database(path, { readonly });
  connections.push(db);
  return db;
}
function fixture(name = 'legacy.tde', options: { divider?: boolean; plain?: boolean; version?: string } = {}) {
  const path = join(root, name);
  const db = connect(path);
  db.pragma('journal_mode = WAL');
  db.pragma('wal_autocheckpoint = 0');
  db.exec(LEGACY_SCHEMA);
  db.exec(`CREATE VIRTUAL TABLE events_fts USING fts5(content_text, deadline_raw${options.plain ? '' : ", tokenize='trigram'"})`);
  db.exec(LEGACY_TRIGGERS);
  if (options.divider !== false) db.exec('ALTER TABLE events ADD COLUMN top_divider INTEGER NOT NULL DEFAULT 0');
  const insert = db.prepare(`INSERT INTO events(id, pos, created_at, deadline_raw, deadline_ts, done, content_html, content_text)
    VALUES (@id, @pos, @created_at, @deadline_raw, @deadline_ts, @done, @content_html, @content_text)`);
  insert.run(event(7));
  insert.run(event(42, 'English ALPHA 100% a_b C:\\notes "quoted"', 200));
  db.prepare('INSERT INTO assets(id, w, h, data) VALUES (?, ?, ?, ?)').run(9, 64, 64, bytes);
  db.prepare('INSERT INTO assets(id, w, h, data) VALUES (?, ?, ?, ?)').run(87, 2, 1, Buffer.from([0, 255, 1, 128]));
  if (options.version) db.prepare("UPDATE meta SET value = ? WHERE key = 'format_version'").run(options.version);
  db.pragma('wal_checkpoint(TRUNCATE)');
  return { path, db };
}
function backups(): string[] {
  return fs.readdirSync(root, { recursive: true }).map(String).filter(name => name.endsWith('.electron-backup'))
    .map(name => join(root, name));
}
function assets(db: Database.Database) {
  return (db.prepare('SELECT id, w, h, data FROM assets ORDER BY id').all() as
    { id: number; w: number; h: number; data: Buffer }[]).map(row => ({ ...row, data: hash(row.data) }));
}

beforeEach(() => {
  root = fs.mkdtempSync(join(tmpdir(), 'todoline-storage-'));
  connections = [];
  store = new DocumentStore();
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const snapshot of store.snapshots()) store.close(snapshot.handle);
  for (const db of connections) if (db.open) db.close();
  // Verify the exact, generated temp directory before recursively removing fixtures.
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.includes('todoline-storage-')) {
    throw new Error('Refusing to clean an unexpected fixture path.');
  }
  fs.rmSync(target, { recursive: true, force: true });
});

describe('legacy compatibility and validation', () => {
  it('opens missing top_divider as zero without mutating or migrating the file', () => {
    const { path, db } = fixture('old.tde', { divider: false });
    const before = hash(fs.readFileSync(path));
    const snapshot = store.open(path);
    expect(snapshot.readOnly).toBe(false);
    expect(snapshot.handle).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(snapshot.events.map(row => [row.id, row.top_divider])).toEqual([[7, 0], [42, 0]]);
    expect(db.pragma('table_info(events)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'top_divider' })]));
    expect(hash(fs.readFileSync(path))).toBe(before);
    expect(backups()).toEqual([]);
    const duplicate = store.open(join(root, '.', 'old.tde'));
    expect(duplicate.handle).toBe(snapshot.handle);
    snapshot.events[0].content_html = 'mutated outside store';
    expect(store.snapshots()[0].events[0].content_html).toBe('<p>计划明天开会</p>');
  });

  it('creates version 1 with WAL and closes/removes its handle', async () => {
    const path = join(root, 'new.tde');
    const snapshot = store.open(path, true);
    const db = connect(path);
    expect(db.pragma('journal_mode', { simple: true })).toBe('wal');
    expect(db.prepare('SELECT value FROM meta').pluck().get()).toBe('1');
    expect(snapshot.events).toEqual([]);
    expect(() => store.open(path, true)).toThrow(/exist/i);
    const result = await store.save(request(snapshot, [event(-1)]));
    expect(result.idMap['-1']).toBeGreaterThan(0);
    store.close(snapshot.handle);
    expect(store.snapshots()).toEqual([]);
    expect(() => store.asset(snapshot.handle, 9)).toThrow(/closed/);
  });

  it.each(['2', '999'])('makes future format %s read-only and refuses every mutation', async version => {
    const { path, db } = fixture('future.tde', { version });
    const before = hash(fs.readFileSync(path));
    const snapshot = store.open(path);
    expect(snapshot.readOnly).toBe(true);
    expect(snapshot.warning).toContain('format_version');
    await expect(store.save(request(snapshot, [event(-1)]))).rejects.toThrow(/read-only/i);
    await expect(store.addAsset(snapshot.handle, bytes, 1, 1)).rejects.toThrow(/read-only/i);
    await expect(store.saveAs(request(snapshot), join(root, 'future-copy.tde'))).rejects.toThrow(/unsupported schema/i);
    expect(store.search(snapshot.handle, '明天')).toHaveLength(1);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
    expect(hash(fs.readFileSync(path))).toBe(before);
    expect(backups()).toEqual([]);
  });

  it('refuses to write unknown triggers and missing FTS synchronization', async () => {
    const { path, db } = fixture();
    db.exec('DROP TRIGGER events_au; CREATE TRIGGER destructive AFTER UPDATE ON events BEGIN DELETE FROM assets; END;');
    const snapshot = store.open(path);
    expect(snapshot.readOnly).toBe(true);
    const originals = assets(db);
    await expect(store.save(request(snapshot, [event(-1)]))).rejects.toThrow(/read-only/i);
    expect(assets(db)).toEqual(originals);
  });

  it('rejects unrelated, empty and non-SQLite files without changing bytes or creating missing files', () => {
    const unrelated = join(root, 'other.db');
    connect(unrelated).exec('CREATE TABLE other(secret BLOB)');
    const invalid = join(root, 'not-sqlite.tde');
    fs.writeFileSync(invalid, 'This is not SQLite');
    const empty = join(root, 'empty.tde');
    fs.writeFileSync(empty, '');
    for (const path of [unrelated, invalid, empty]) {
      const before = hash(fs.readFileSync(path));
      expect(() => store.open(path)).toThrow(/schema|database|SQLite/i);
      expect(hash(fs.readFileSync(path))).toBe(before);
    }
    const missing = join(root, 'missing.tde');
    expect(() => store.open(missing)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
    expect(store.snapshots()).toEqual([]);
  });
});

describe('backups and atomic saving', () => {
  it('backs up committed WAL pages and all assets before migration or the first edit', async () => {
    const { path, db } = fixture('wal.tde', { divider: false });
    db.prepare("INSERT INTO events(pos, created_at, content_text) VALUES (300, 1700000000, 'WAL-only event')").run();
    expect(fs.statSync(path + '-wal').size).toBeGreaterThan(0);
    const mainOnly = join(root, 'main-only.sqlite');
    fs.copyFileSync(path, mainOnly);
    expect(connect(mainOnly, true).prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
    const originals = assets(db);
    const snapshot = store.open(path);
    const events = snapshot.events.map((row, index) => index === 0 ? { ...row, content_text: 'updated', top_divider: 1 } : row);
    const result = await store.save(request(snapshot, events));
    expect(result.backup).toMatch(/\.electron-backup$/);
    const backup = connect(result.backup!, true);
    expect(backup.prepare('SELECT content_text FROM events ORDER BY id').pluck().all())
      .toEqual(['计划明天开会', 'English ALPHA 100% a_b C:\\notes "quoted"', 'WAL-only event']);
    expect(backup.pragma('table_info(events)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'top_divider' })]));
    expect(assets(backup)).toEqual(originals);
    expect(db.prepare('SELECT top_divider FROM events WHERE id = 7').pluck().get()).toBe(1);
    expect(db.prepare('SELECT value FROM meta').pluck().get()).toBe('1');
    const latest = store.snapshots()[0];
    await store.save(request(latest, latest.events.map(row => ({ ...row, done: 1 }))));
    expect(backups()).toHaveLength(1);
  });

  it('does not write unchanged rows or bind unchanged bodies on metadata updates', async () => {
    const { path, db } = fixture();
    const snapshot = store.open(path);
    const originalBackup = Database.prototype.backup;
    vi.spyOn(Database.prototype, 'backup').mockImplementation(function (this: Database.Database, ...args) {
      this.exec(`CREATE TEMP TRIGGER forbid_body BEFORE UPDATE OF content_html, content_text ON events
        BEGIN SELECT RAISE(ABORT, 'body was rewritten'); END;`);
      return originalBackup.apply(this, args);
    });
    const noop = await store.save(request(snapshot));
    expect(noop.revision).toBe(snapshot.revision);
    expect(backups()).toHaveLength(0);
    const result = await store.save(request(snapshot, snapshot.events.map(row => ({ ...row, done: 1 }))));
    expect(result.revision).toBe(snapshot.revision + 1);
    expect(db.prepare('SELECT content_html FROM events WHERE id = 7').pluck().get()).toBe(snapshot.events[0].content_html);
    expect(store.search(snapshot.handle, 'ALPHA')).toHaveLength(1);
  });

  it('rolls back deletion, updates, FTS, sequence and top_divider on a late SQLite failure', async () => {
    const { path, db } = fixture('rollback.tde', { divider: false });
    const snapshot = store.open(path);
    const originalAssets = assets(db);
    const originalBackup = Database.prototype.backup;
    vi.spyOn(Database.prototype, 'backup').mockImplementation(function (this: Database.Database, ...args) {
      this.exec(`CREATE TEMP TRIGGER fail_insert BEFORE INSERT ON events
        WHEN new.content_text = 'fail' BEGIN SELECT RAISE(ABORT, 'injected disk write failure'); END;`);
      return originalBackup.apply(this, args);
    });
    const edits = [{ ...snapshot.events[0], content_text: 'changed' }, event(-1, 'first insert', 300), event(-2, 'fail', 400)];
    await expect(store.save(request(snapshot, edits))).rejects.toThrow(/injected disk write failure/);
    expect(store.snapshots()[0]).toEqual(snapshot);
    expect(db.prepare('SELECT id, content_text FROM events ORDER BY id').all())
      .toEqual(snapshot.events.map(row => ({ id: row.id, content_text: row.content_text })));
    expect(db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").pluck().get()).toBe(42);
    expect(db.pragma('table_info(events)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'top_divider' })]));
    expect(store.search(snapshot.handle, 'ALPHA')).toHaveLength(1);
    expect(assets(db)).toEqual(originalAssets);
    expect(edits.map(row => row.id)).toEqual([7, -1, -2]);
    const retry = await store.save(request(snapshot, [...snapshot.events, event(-1, 'retry', 300)]));
    expect(retry.idMap['-1']).toBe(43);
  });

  it('stops before mutation if the backup cannot be created', async () => {
    const { path, db } = fixture('backup-failure.tde', { divider: false });
    const blockedRoot = join(root, 'not-a-directory');
    fs.writeFileSync(blockedRoot, 'keep');
    store = new DocumentStore(blockedRoot);
    const snapshot = store.open(path);
    await expect(store.save(request(snapshot, [event(-1)]))).rejects.toThrow();
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
    expect(store.snapshots()[0].revision).toBe(snapshot.revision);
    expect(db.pragma('table_info(events)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'top_divider' })]));
  });

  it('backs up DELETE-mode legacy files before enabling WAL and configures FULL durability', async () => {
    const { path, db } = fixture('delete-mode.tde', { divider: false });
    db.pragma('journal_mode = DELETE');
    const before = hash(fs.readFileSync(path));
    const snapshot = store.open(path);
    expect(db.pragma('journal_mode', { simple: true })).toBe('delete');
    expect(hash(fs.readFileSync(path))).toBe(before);
    const originalTransaction = Database.prototype.transaction;
    const synchronous: unknown[] = [];
    vi.spyOn(Database.prototype, 'transaction').mockImplementation(function (this: Database.Database, fn: (...args: any[]) => any) {
      synchronous.push(this.pragma('synchronous', { simple: true }));
      return originalTransaction.call(this, fn);
    });
    const result = await store.save(request(snapshot, snapshot.events.map(row => ({ ...row, done: 1 }))));
    expect(synchronous).toContain(2); // FULL is 2, not NORMAL's 1.
    expect(connect(result.backup!, true).prepare('SELECT done FROM events WHERE id = 7').pluck().get()).toBe(0);
    expect(db.prepare('SELECT done FROM events WHERE id = 7').pluck().get()).toBe(1);
    expect(connect(path).pragma('journal_mode', { simple: true })).toBe('wal');
  });

  it('allocates positive IDs, retains existing IDs, removes omitted rows and preserves monotonic order', async () => {
    const { path, db } = fixture();
    const originalAssets = assets(db);
    const snapshot = store.open(path);
    const result = await store.save(request(snapshot, [event(-5, 'new first', 100), { ...snapshot.events[0], pos: 100 }, event(-9, 'new last', 50)]));
    expect(result.idMap).toEqual({ '-5': 43, '-9': 44 });
    const rows = store.snapshots()[0].events;
    expect(rows.map(row => row.id)).toEqual([43, 7, 44]);
    expect(rows.every((row, index) => !index || row.pos > rows[index - 1].pos)).toBe(true);
    expect(db.prepare('SELECT id FROM events WHERE id = 42').get()).toBeUndefined();
    expect(store.search(snapshot.handle, 'ALPHA')).toEqual([]);
    expect(store.search(snapshot.handle, 'new first')).toEqual([{ id: 43, text: 'new first' }]);
    expect(assets(db)).toEqual(originalAssets);
    const empty = store.snapshots()[0];
    await store.save(request(empty, []));
    const next = await store.save(request(store.snapshots()[0], [event(-1)]));
    expect(next.idMap['-1']).toBe(45);
  });

  it.each([
    [event(999)], [event(0)], [event(-1), event(-1)], [{ ...event(-1), pos: Number.NaN }],
  ])('rejects invalid event IDs/fields before backing up or mutating (%#)', async (...events) => {
    const { path, db } = fixture();
    const snapshot = store.open(path);
    await expect(store.save(request(snapshot, events))).rejects.toThrow(/ID|fields/);
    expect(backups()).toEqual([]);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
  });
});

describe('concurrency and conflicts', () => {
  it('rejects external SQLite commits, then permits saving after explicit reload', async () => {
    const { path, db } = fixture();
    const snapshot = store.open(path);
    db.prepare("UPDATE events SET content_text = 'external' WHERE id = 7").run();
    await expect(store.save(request(snapshot, [event(-1)]))).rejects.toThrow(/Disk conflict/);
    await expect(store.addAsset(snapshot.handle, bytes, 1, 1)).rejects.toThrow(/Disk conflict/);
    expect(() => store.search(snapshot.handle, 'external')).toThrow(/Disk conflict/);
    expect(backups()).toEqual([]);
    expect(store.snapshots()[0].events).toEqual(snapshot.events);
    const fresh = store.reload(snapshot.handle);
    expect(fresh.events[0].content_text).toBe('external');
    expect(fresh.revision).toBeGreaterThan(snapshot.revision);
    await expect(store.save(request(snapshot))).rejects.toThrow(/Revision conflict/);
    await expect(store.save(request(fresh, fresh.events.map(row => ({ ...row, done: 1 }))))).resolves.toHaveProperty('backup');
  });

  it('detects an external write during asynchronous backup and leaves edits uncommitted', async () => {
    const { path, db } = fixture('racing.tde', { divider: false });
    const snapshot = store.open(path);
    const originalBackup = Database.prototype.backup;
    vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (this: Database.Database, ...args) {
      const result = await originalBackup.apply(this, args);
      db.prepare("UPDATE events SET content_text = 'racing external write' WHERE id = 7").run();
      return result;
    });
    await expect(store.save(request(snapshot, [event(-1)]))).rejects.toThrow(/conflict/);
    expect(db.prepare('SELECT id FROM events ORDER BY id').pluck().all()).toEqual([7, 42]);
    expect(db.pragma('table_info(events)')).not.toEqual(expect.arrayContaining([expect.objectContaining({ name: 'top_divider' })]));
    expect(backups()).toEqual([]);
  });

  it('does not accept an external asset edit hidden by a journal-mode data_version reset', async () => {
    const { path, db } = fixture('mode-race.tde');
    db.pragma('journal_mode = DELETE');
    const snapshot = store.open(path);
    const originalPragma = Database.prototype.pragma;
    let injected = false;
    vi.spyOn(Database.prototype, 'pragma').mockImplementation(function (this: Database.Database, ...args) {
      const result = originalPragma.apply(this, args);
      if (!injected && this.name === fs.realpathSync(path) && /^journal_mode = wal$/i.test(args[0])) {
        injected = true;
        db.prepare('UPDATE assets SET data = ? WHERE id = 9').run(Buffer.from('external asset edit'));
      }
      return result;
    });
    await expect(store.save(request(snapshot, []))).rejects.toThrow(/Disk conflict.*journal-mode/);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
    expect(db.prepare('SELECT data FROM assets WHERE id = 9').pluck().get()).toEqual(Buffer.from('external asset edit'));
    expect(store.snapshots()[0].revision).toBe(snapshot.revision);
  });

  it('detects changed file identity even when SQLite data_version is unchanged', async () => {
    const { path, db } = fixture();
    const snapshot = store.open(path);
    const originalStat = fs.statSync;
    vi.spyOn(fs, 'statSync').mockImplementation(((file: fs.PathLike, options: { bigint?: boolean }) => {
      const stat = originalStat(file, options as { bigint: true });
      // open() canonicalizes with realpath (macOS /var -> /private/var).
      if (String(file) === fs.realpathSync(path) && options?.bigint) {
        return Object.assign(Object.create(Object.getPrototypeOf(stat)), stat, { ino: stat.ino + 1n });
      }
      return stat;
    }) as typeof fs.statSync);
    await expect(store.save(request(snapshot, [event(-1)]))).rejects.toThrow(/replaced/);
    await expect(store.addAsset(snapshot.handle, bytes, 1, 1)).rejects.toThrow(/replaced/);
    expect(db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
    expect(backups()).toEqual([]);
  });

  it('serializes simultaneous saves, captures queued inputs, and recovers after rejection', async () => {
    const { path } = fixture();
    const snapshot = store.open(path);
    const input = request(snapshot, [event(-1, 'captured')]);
    const first = store.save(input);
    input.events[0].content_text = 'mutated by caller';
    const second = store.save(request(snapshot, [event(-2, 'stale')]));
    expect(() => store.close(snapshot.handle)).toThrow(/busy/);
    expect(() => store.reload(snapshot.handle)).toThrow(/busy/);
    expect(() => store.open(join(root, 'cannot-interleave.tde'), true)).toThrow(/busy/);
    expect(fs.existsSync(join(root, 'cannot-interleave.tde'))).toBe(false);
    const results = await Promise.allSettled([first, second]);
    expect(results[0].status).toBe('fulfilled');
    expect(results[1]).toMatchObject({ status: 'rejected', reason: expect.objectContaining({ message: expect.stringMatching(/Revision conflict/) }) });
    expect(store.snapshots()[0].events[0].content_text).toBe('captured');
    const latest = store.snapshots()[0];
    await expect(store.save(request(latest, latest.events.map(row => ({ ...row, done: 1 }))))).resolves.toBeDefined();
  });
});

describe('assets and substring search', () => {
  it('inserts a whole asset batch in order, snapshots input bytes, and backs up once',async()=>{
    const {path,db}=fixture(),original=assets(db),snapshot=store.open(path),input=[{data:new Uint8Array([1]),w:10,h:20},{data:new Uint8Array([2]),w:30,h:40}];const pending=store.addAssets(snapshot.handle,input);input[0].data[0]=9;input[1].w=999;const ids=await pending;expect(ids).toEqual([88,89]);expect(store.asset(snapshot.handle,88)).toMatchObject({data:new Uint8Array([1]),w:10,h:20});expect(store.asset(snapshot.handle,89)?.w).toBe(30);expect(assets(connect(backups()[0],true))).toEqual(original);expect(backups()).toHaveLength(1);expect(store.snapshots()[0].revision).toBe(snapshot.revision);
  });
  it('rolls back the first asset and schema upgrade when the second asset fails',async()=>{
    const {path,db}=fixture('batch-failure.tde',{divider:false});db.prepare("UPDATE sqlite_sequence SET seq=? WHERE name='assets'").run(Number.MAX_SAFE_INTEGER-1);const original=assets(db),snapshot=store.open(path);await expect(store.addAssets(snapshot.handle,[{data:new Uint8Array([1]),w:12,h:2},{data:new Uint8Array([2]),w:123,h:2}])).rejects.toThrow('Asset ID exceeds');expect(assets(db)).toEqual(original);expect((db.pragma('table_info(events)') as any[]).some(row=>row.name==='top_divider')).toBe(false);await expect(store.addAssets(snapshot.handle,[{data:new Uint8Array([3]),w:12,h:2}])).resolves.toEqual([Number.MAX_SAFE_INTEGER]);
  });
  it('rejects any invalid batch member before making changes',async()=>{
    const {path,db}=fixture(),original=assets(db),snapshot=store.open(path);await expect(store.addAssets(snapshot.handle,[{data:new Uint8Array([1]),w:1,h:1},{data:new Uint8Array([2]),w:-1,h:1}])).rejects.toThrow(/Invalid/);expect(assets(db)).toEqual(original);expect(backups()).toHaveLength(0);await expect(store.addAssets(snapshot.handle,[])).resolves.toEqual([]);expect(backups()).toHaveLength(0);
  });
  it('preserves asset hashes and uses backup/conflict checks without advancing event revision', async () => {
    const { path, db } = fixture('assets.tde', { divider: false });
    const originalAssets = assets(db);
    const snapshot = store.open(path);
    const input = Uint8Array.from([5, 0, 250, 99]);
    const pending = store.addAsset(snapshot.handle, input, 2, 2);
    input[0] = 100;
    const id = await pending;
    expect(id).toBe(88);
    expect(store.snapshots()[0].revision).toBe(snapshot.revision);
    expect(store.asset(snapshot.handle, id)).toEqual({ id, w: 2, h: 2, data: Uint8Array.from([5, 0, 250, 99]) });
    expect(hash(store.asset(snapshot.handle, 9)!.data)).toBe(hash(bytes));
    expect(store.asset(snapshot.handle, 999)).toBeNull();
    const backup = connect(backups()[0], true);
    expect(assets(backup)).toEqual(originalAssets);
    expect(assets(db).slice(0, 2)).toEqual(originalAssets);
    await store.save(request(snapshot, snapshot.events.map(row => ({ ...row, done: 1 }))));
    db.prepare('INSERT INTO assets(w,h,data) VALUES (0,0,?)').run(Buffer.from([1]));
    await expect(store.addAsset(snapshot.handle, bytes, 0, 0)).rejects.toThrow(/Disk conflict/);
    expect(backups()).toHaveLength(1);
  });

  it.each([false, true])('finds short Chinese, deadlines and literal wildcard text (plain=%s)', plain => {
    const { path } = fixture('search.tde', { plain });
    const snapshot = store.open(path);
    for (const query of ['明', '明天', '明天开会']) expect(store.search(snapshot.handle, query).map(hit => hit.id)).toEqual([7]);
    for (const query of ['ALPHA', '%', '_', '\\', '"quoted"']) expect(store.search(snapshot.handle, query).map(hit => hit.id)).toEqual([42]);
    expect(store.search(snapshot.handle, '周三').map(hit => hit.id)).toEqual([7, 42]);
    expect(store.search(snapshot.handle, '   ')).toEqual([]);
    expect(store.search(snapshot.handle, '" OR *')).toEqual([]);
  });
});

describe('Save As and legacy settings', () => {
  it('exports memory despite disk conflict, restores IDs, keeps source intact and copies every asset', async () => {
    const { path, db } = fixture();
    const snapshot = store.open(path);
    const originalAssets = assets(db);
    db.prepare("UPDATE events SET content_text = 'external' WHERE id = 7").run();
    db.prepare('DELETE FROM events WHERE id = 42').run();
    db.prepare("INSERT INTO events(pos,created_at,content_text) VALUES (300,1,'external new')").run();
    const sourceBefore = db.prepare('SELECT * FROM events ORDER BY id').all();
    const destination = join(root, 'recovered.tde');
    const exported = await store.saveAs(request(snapshot, [{ ...snapshot.events[0], content_text: 'unsaved memory' }, snapshot.events[1], event(-1, 'new memory', 300)]), destination);
    expect(exported.handle).not.toBe(snapshot.handle);
    expect(exported.events.map(row => row.id)).toEqual([7, 42, 44]);
    expect(exported.events[0].content_text).toBe('unsaved memory');
    expect(db.prepare('SELECT * FROM events ORDER BY id').all()).toEqual(sourceBefore);
    expect(assets(connect(destination, true))).toEqual(originalAssets);
    expect(store.search(exported.handle, 'ALPHA')).toHaveLength(1);
    expect(store.snapshots()).toHaveLength(2);
    store.close(snapshot.handle);
    expect(store.snapshots()[0].handle).toBe(exported.handle);
    expect(fs.readdirSync(root).some(name => name.includes('electron-saveas'))).toBe(false);
  });

  it('backs up a confirmed existing destination including WAL before atomic replacement', async () => {
    const source = fixture('source.tde');
    const target = fixture('target.tde', { divider: false });
    target.db.prepare("UPDATE events SET content_text = 'destination WAL contents' WHERE id = 7").run();
    // Close external connections so replacing a live WAL database is never attempted.
    target.db.close();
    const snapshot = store.open(source.path);
    const exported = await store.saveAs(request(snapshot, [snapshot.events[0]]), target.path);
    expect(exported.events.map(row => row.id)).toEqual([7]);
    const savedBackup = backups().find(path => path.includes('target.tde'))!;
    expect(connect(savedBackup, true).prepare('SELECT content_text FROM events WHERE id = 7').pluck().get()).toBe('destination WAL contents');
    expect(source.db.prepare('SELECT COUNT(*) FROM events').pluck().get()).toBe(2);
  });

  it('refuses unsupported or already-open destinations without overwriting them', async () => {
    const source = fixture('source.tde');
    const target = fixture('unknown.tde', { version: '99' });
    const snapshot = store.open(source.path);
    const before = hash(fs.readFileSync(target.path));
    await expect(store.saveAs(request(snapshot), target.path)).rejects.toThrow(/read-only/i);
    expect(hash(fs.readFileSync(target.path))).toBe(before);
    await expect(store.saveAs(request(snapshot), source.path)).rejects.toThrow(/different destination/);
  });

  it('refuses overwriting an in-use WAL target, with its committed contents safely backed up', async () => {
    const source = fixture('source.tde');
    const target = fixture('in-use.tde');
    target.db.prepare("UPDATE events SET content_text = 'live WAL contents' WHERE id = 7").run();
    const snapshot = store.open(source.path);
    await expect(store.saveAs(request(snapshot, []), target.path)).rejects.toThrow(/locked|in use|busy/i);
    expect(target.db.prepare('SELECT content_text FROM events WHERE id = 7').pluck().get()).toBe('live WAL contents');
    const backup = backups().find(path => path.includes('in-use.tde'))!;
    expect(connect(backup, true).prepare('SELECT content_text FROM events WHERE id = 7').pluck().get()).toBe('live WAL contents');
    expect(store.snapshots()).toHaveLength(1);
  });

  it('can recover a stale renderer snapshot to a separate file after another renderer save', async () => {
    const { path, db } = fixture();
    const snapshot = store.open(path);
    await store.save(request(snapshot, [snapshot.events[0]]));
    const exported = await store.saveAs(request(snapshot), join(root, 'stale-memory.tde'));
    expect(exported.events).toEqual(snapshot.events);
    expect(db.prepare('SELECT id FROM events').pluck().all()).toEqual([7]);
  });

  it('does not clobber a new destination created during the export', async () => {
    const { path } = fixture();
    const snapshot = store.open(path);
    const destination = join(root, 'raced.tde');
    const originalBackup = Database.prototype.backup;
    vi.spyOn(Database.prototype, 'backup').mockImplementation(async function (this: Database.Database, ...args) {
      const result = await originalBackup.apply(this, args);
      fs.writeFileSync(destination, 'created by another process', { flag: 'wx' });
      return result;
    });
    await expect(store.saveAs(request(snapshot), destination)).rejects.toThrow();
    expect(fs.readFileSync(destination, 'utf8')).toBe('created by another process');
    expect(store.snapshots()).toHaveLength(1);
  });

  it('reads legacy settings through a read-only connection, without creating or migrating anything', () => {
    const path = join(root, 'session.db');
    const db = connect(path);
    db.exec("CREATE TABLE settings(key TEXT PRIMARY KEY, value TEXT NOT NULL); INSERT INTO settings VALUES('theme','green'),('__proto__','literal');");
    const before = hash(fs.readFileSync(path));
    const settings = store.readLegacySettings(path);
    expect(settings.theme).toBe('green');
    expect(Object.hasOwn(settings, '__proto__')).toBe(true);
    expect(settings.__proto__).toBe('literal');
    expect(hash(fs.readFileSync(path))).toBe(before);
    const missing = join(root, 'missing-settings.db');
    expect(() => store.readLegacySettings(missing)).toThrow();
    expect(fs.existsSync(missing)).toBe(false);
  });
});

describe('utility-process protocol', () => {
  function port() {
    let listener: (event: { data: unknown }) => void;
    const replies = new Map<unknown, (value: any) => void>();
    const transport = {
      on: (_event: 'message', callback: typeof listener) => { listener = callback; },
      postMessage: (reply: any) => { replies.get(reply.id)?.(reply); },
    };
    attachDatabaseWorker(transport, store);
    return (data: { id: number; method?: unknown; args?: unknown }) => new Promise<any>(resolve => {
      replies.set(data.id, resolve);
      listener({ data });
    });
  }

  it('allowlists methods, returns error strings and keeps serving after malformed calls', async () => {
    const send = port();
    for (const [index, method] of ['constructor', '__proto__', 'toString', 'prepareWrite', 'documents'].entries()) {
      expect(await send({ id: index, method, args: [] })).toMatchObject({ id: index, error: expect.stringMatching(/not allowed/) });
    }
    expect(await send({ id: 10, method: 'open', args: 'bad' })).toHaveProperty('error');
    expect(await send({ id: 11, method: 'open', args: [] })).toHaveProperty('error');
    expect(await send({ id: 12, method: 'snapshots', args: [] })).toEqual({ id: 12, result: [] });
  });

  it('queues reads and close after an asynchronous save and exposes settings migration', async () => {
    const { path } = fixture();
    const send = port();
    const opened = await send({ id: 1, method: 'open', args: [path] });
    const snapshot = opened.result as DocumentSnapshot;
    const saving = send({ id: 2, method: 'save', args: [request(snapshot, [event(-1, 'worker written')])] });
    const searching = send({ id: 3, method: 'search', args: [snapshot.handle, 'worker'] });
    const closing = send({ id: 4, method: 'close', args: [snapshot.handle] });
    expect(await saving).toHaveProperty('result.idMap.-1', 43);
    expect(await searching).toMatchObject({ result: [{ id: 43, text: 'worker written' }] });
    expect(await closing).toEqual({ id: 4, result: undefined });
    expect(await send({ id: 5, method: 'snapshots', args: [] })).toEqual({ id: 5, result: [] });
    expect(await send({ id: 6, method: 'readLegacySettings', args: [path] })).toEqual({ id: 6, result: {} });
  });
});
