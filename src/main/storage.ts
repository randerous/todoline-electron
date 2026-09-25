import Database from 'better-sqlite3';
import {emptyDocumentEvents} from '../shared/new-document';
import {fileIdentity} from './file-identity';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync, existsSync, fsyncSync, linkSync, mkdirSync, openSync,
  realpathSync, renameSync, statSync, unlinkSync,
} from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import type {
  AssetRecord, AssetInput, DocumentSnapshot, EventRecord, SaveRequest, SaveResult, SearchHit,
} from '../shared/types';

// These definitions deliberately match the Qt application's version-1 format.
const META = 'CREATE TABLE meta(key TEXT PRIMARY KEY, value TEXT NOT NULL)';
const EVENTS = `CREATE TABLE events(
  id INTEGER PRIMARY KEY AUTOINCREMENT, pos REAL NOT NULL, created_at INTEGER NOT NULL,
  deadline_raw TEXT NOT NULL DEFAULT '', deadline_ts INTEGER,
  done INTEGER NOT NULL DEFAULT 0, content_html TEXT NOT NULL DEFAULT '',
  content_text TEXT NOT NULL DEFAULT '')`;
const ASSETS = `CREATE TABLE assets(id INTEGER PRIMARY KEY AUTOINCREMENT,
  w INTEGER NOT NULL DEFAULT 0, h INTEGER NOT NULL DEFAULT 0, data BLOB NOT NULL)`;
const DIVIDER = 'top_divider INTEGER NOT NULL DEFAULT 0';
const FTS = 'CREATE VIRTUAL TABLE events_fts USING fts5(content_text, deadline_raw';
const TRIGGERS = {
  events_ai: `CREATE TRIGGER events_ai AFTER INSERT ON events BEGIN
    INSERT INTO events_fts(rowid, content_text, deadline_raw)
    VALUES (new.id, lower(new.content_text), lower(new.deadline_raw)); END`,
  events_ad: `CREATE TRIGGER events_ad AFTER DELETE ON events BEGIN
    DELETE FROM events_fts WHERE rowid = old.id; END`,
  events_au: `CREATE TRIGGER events_au AFTER UPDATE ON events BEGIN
    DELETE FROM events_fts WHERE rowid = new.id;
    INSERT INTO events_fts(rowid, content_text, deadline_raw)
    VALUES (new.id, lower(new.content_text), lower(new.deadline_raw)); END`,
};
const FIELDS = [
  'pos', 'created_at', 'deadline_raw', 'deadline_ts', 'done',
  'top_divider', 'content_html', 'content_text',
] as const;
const BASE_FIELDS = ['id', ...FIELDS.filter(field => field !== 'top_divider')];

type Schema = { topDivider: boolean; trigram: boolean; warning?: string };
type SchemaRow = { type: string; name: string; sql: string | null };
type Document = {
  handle: string; path: string; db: Database.Database; identity: string;
  schema: Schema; events: EventRecord[]; revision: number; dataVersion: number; knownIds:Set<number>;
  readOnly: boolean; backup?: string; pending: number;
};

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function identity(path: string): string {
  const stat = statSync(path, { bigint: true });
  if (!stat.isFile()) throw new Error(`Not a regular document file: ${path}`);
  // birthtime also protects platforms/filesystems that recycle or omit inode numbers.
  return `${stat.dev}:${stat.ino}:${stat.birthtimeNs}`;
}

// Document paths must be canonical: open() stores realpathSync(path) while a
// brand-new Save As target does not exist yet, and macOS (/var -> /private/var),
// Windows short names or subst drives make the two forms compare unequal.
// Resolve the parent directory and keep the caller's basename.
function canonicalPath(path: string): string {
  const resolved = resolve(path);
  try { return join(realpathSync(dirname(resolved)), basename(resolved)); } catch { return resolved; }
}

function canonical(sql: string): string {
  return sql.replace(/\bIF\s+NOT\s+EXISTS\b/gi, '').replace(/[\s;"`\[\]]/g, '').toLowerCase();
}

function columns(db: Database.Database, table: string): string[] {
  // table is always an internal constant, never a caller-supplied identifier.
  return (db.pragma(`table_info(${table})`) as { name: string }[]).map(row => row.name);
}

function inspectSchema(db: Database.Database): Schema {
  const check = db.pragma('quick_check') as { quick_check: string }[];
  if (check.length !== 1 || check[0].quick_check !== 'ok') {
    throw new Error('SQLite integrity check failed; the document has not been modified.');
  }
  const rows = db.prepare('SELECT type, name, sql FROM sqlite_master').all() as SchemaRow[];
  const tables = new Map(rows.filter(row => row.type === 'table').map(row => [row.name, row.sql ?? '']));
  for (const [table, required] of [
    ['meta', ['key', 'value']], ['events', BASE_FIELDS], ['assets', ['id', 'w', 'h', 'data']],
  ] as const) {
    if (!tables.has(table) || !required.every(field => columns(db, table).includes(field))) {
      throw new Error(`Unsupported TodoLine schema: missing ${table} table or required columns.`);
    }
  }
  const version = db.prepare("SELECT value FROM meta WHERE key = 'format_version'").get() as
    { value: unknown } | undefined;
  const topDivider = columns(db, 'events').includes('top_divider');
  const trigram = canonical(tables.get('events_fts') ?? '') === canonical(`${FTS}, tokenize='trigram')`);
  const warnings: string[] = [];
  if (version?.value !== '1') warnings.push(`unsupported format_version ${String(version?.value ?? '(missing)')}`);
  const expected = { meta: META, events: topDivider ? EVENTS.slice(0, -1) + `, ${DIVIDER})` : EVENTS, assets: ASSETS };
  for (const [name, sql] of Object.entries(expected)) {
    if (canonical(tables.get(name) ?? '') !== canonical(sql)) warnings.push(`unrecognized ${name} schema`);
  }
  if (!trigram && canonical(tables.get('events_fts') ?? '') !== canonical(`${FTS})`)) {
    warnings.push('unrecognized or missing FTS5 index');
  }
  for (const [name, sql] of Object.entries(TRIGGERS)) {
    if (!rows.some(row => row.type === 'trigger' && row.name === name && canonical(row.sql ?? '') === canonical(sql))) {
      warnings.push(`unrecognized or missing ${name} trigger`);
    }
  }
  const allowed = new Set([
    'meta', 'events', 'assets', 'sqlite_sequence', 'sqlite_autoindex_meta_1',
    'events_fts', 'events_fts_data', 'events_fts_idx', 'events_fts_content',
    'events_fts_docsize', 'events_fts_config', ...Object.keys(TRIGGERS),
  ]);
  if (rows.some(row => !allowed.has(row.name) && !/^sqlite_stat[1-4]$/.test(row.name))) {
    warnings.push('unrecognized additional schema objects');
  }
  return {
    topDivider, trigram,
    warning: warnings.length ? `Read-only document: ${warnings.join('; ')}.` : undefined,
  };
}

function validateEvent(event: EventRecord, stored = false): void {
  if (!event || !Number.isSafeInteger(event.id) || event.id === 0 || (stored && event.id < 0)) {
    throw new Error('Invalid event ID: persisted IDs must be positive; new events need unique negative IDs.');
  }
  if (!Number.isFinite(event.pos) || !Number.isSafeInteger(event.created_at) ||
      (event.deadline_ts !== null && !Number.isSafeInteger(event.deadline_ts)) ||
      !Number.isSafeInteger(event.done) || !Number.isSafeInteger(event.top_divider) ||
      typeof event.deadline_raw !== 'string' || typeof event.content_html !== 'string' ||
      typeof event.content_text !== 'string') {
    throw new Error(`Invalid event fields for ID ${event.id}.`);
  }
}

function readEvents(db: Database.Database, schema: Schema): EventRecord[] {
  const rows = db.prepare(`SELECT id, pos, created_at, deadline_raw, deadline_ts, done,
    ${schema.topDivider ? 'top_divider' : '0 AS top_divider'}, content_html, content_text
    FROM events ORDER BY pos, id`).all() as EventRecord[];
  for (const event of rows) validateEvent(event, true);
  return rows;
}

function copyRequest(request: SaveRequest): SaveRequest {
  if (!request || typeof request.handle !== 'string' || !Number.isSafeInteger(request.revision) ||
      !Array.isArray(request.events)) throw new Error('Invalid save request.');
  const seen = new Set<number>();
  const events = request.events.map(event => {
    validateEvent(event);
    if (seen.has(event.id)) throw new Error(`Duplicate event ID ${event.id}.`);
    seen.add(event.id);
    return { ...event };
  });
  // The renderer array defines document order. Preserve good legacy positions;
  // re-space only when insertion/reordering supplied equal or decreasing values.
  if (events.some((event, index) => index > 0 && event.pos <= events[index - 1].pos)) {
    events.forEach((event, index) => { event.pos = (index + 1) * 1024; });
  }
  return { handle: request.handle, revision: request.revision, events };
}

function reserve(path: string): void {
  closeSync(openSync(path, 'wx', 0o600));
}

function syncFile(path: string): void {
  const fd = openSync(path, 'r+');
  try { fsyncSync(fd); } finally { closeSync(fd); }
}

function contentFingerprint(db: Database.Database): string {
  // Journal-mode transitions can reset SQLite's pager/data_version. Compare logical
  // content before accepting that one new baseline; stream blobs instead of keeping
  // another entire serialized database in memory. This is only needed on mode changes.
  const hash = createHash('sha256');
  for (const sql of [
    'SELECT type, name, tbl_name, sql FROM sqlite_master ORDER BY type, name',
    'SELECT * FROM meta ORDER BY key', 'SELECT * FROM events ORDER BY id',
    'SELECT * FROM assets ORDER BY id', 'SELECT * FROM sqlite_sequence ORDER BY name',
    'SELECT rowid, content_text, deadline_raw FROM events_fts ORDER BY rowid',
    'PRAGMA user_version', 'PRAGMA application_id',
  ]) {
    hash.update(sql);
    for (const row of db.prepare(sql).safeIntegers().raw().iterate() as Iterable<unknown[]>) {
      hash.update('row:');
      for (const value of row) {
        const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value));
        hash.update(`${value === null ? 'null' : typeof value}:${bytes.length}:`);
        hash.update(bytes);
      }
    }
  }
  return hash.digest('hex');
}

// Only used for uniquely reserved files owned by this operation, never an input document.
function removeOwnedFiles(path: string): void {
  for (const suffix of ['', '-wal', '-shm', '-journal']) {
    try { unlinkSync(path + suffix); } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

/** One handle per physical file. Async mutations are serialized across the store.
 * Synchronous reload/close reject while that handle has queued work; the worker
 * serializes every RPC, so ordinary IPC callers never encounter that condition.
 */
export class DocumentStore {
  private readonly documents = new Map<string, Document>();
  private tail: Promise<void> = Promise.resolve();
  private pending = 0;
  private readonly backupRoot?: string;

  constructor(backupRoot?: string) {
    this.backupRoot = backupRoot === undefined ? undefined : resolve(backupRoot);
  }

  open(path: string, create = false): DocumentSnapshot {
    if (this.pending) throw new Error('Storage is busy; await pending operations before opening another document.');
    if (typeof path !== 'string' || !path.trim() || path.includes('\0') || path === ':memory:') {
      throw new Error('A document filesystem path is required.');
    }
    if (typeof create !== 'boolean') throw new Error('The create option must be a boolean.');
    const fullPath = resolve(path);
    if (create) {
      // Exclusive reservation ensures create can never truncate an existing file.
      reserve(fullPath);
      let db: Database.Database | undefined;
      try {
        db = new Database(fullPath, { nativeBinding: process.env.TODOLINE_NATIVE_BINDING, fileMustExist: true });
        db.pragma('journal_mode = WAL');
        db.pragma('synchronous = FULL');
        db.transaction(() => {
          db!.exec(`${META}; ${EVENTS}; ${ASSETS};`);
          db!.prepare("INSERT INTO meta(key, value) VALUES ('format_version', '1')").run();
          db!.exec(`${FTS}, tokenize='trigram')`);
          for (const trigger of Object.values(TRIGGERS)) db!.exec(trigger);
          db!.exec(`ALTER TABLE events ADD COLUMN ${DIVIDER}`);
        }).immediate();
      } catch (error) {
        db?.close();
        removeOwnedFiles(fullPath);
        throw new Error(`Cannot create TodoLine document: ${message(error)}`, { cause: error });
      }
      db.close();
    }
    const physicalPath = realpathSync(fullPath);
    const fileIdentity = identity(physicalPath);
    for (const doc of this.documents.values()) {
      if (doc.identity === fileIdentity || doc.path === physicalPath) return this.snapshot(doc);
    }
    const doc = this.connect(physicalPath, randomUUID(), 1);
    this.documents.set(doc.handle, doc);
    return this.snapshot(doc);
  }

  reload(handle: string): DocumentSnapshot {
    const doc = this.get(handle);
    this.requireIdle(doc);
    // Keep the old handle and revision usable if validation of the new disk state fails.
    const replacement = this.connect(doc.path, handle, doc.revision + 1);
    doc.db.close();
    this.documents.set(handle, replacement);
    return this.snapshot(replacement);
  }

  async save(request: SaveRequest): Promise<SaveResult> {
    const input = copyRequest(request);
    const doc = this.get(input.handle);
    return this.enqueue(doc, async () => {
      this.checkRequest(doc, input);
      if (!this.changed(doc.events, input.events)) {
        return { revision: doc.revision, idMap: {}, backup: doc.backup };
      }
      await this.prepareWrite(doc);
      const result = doc.db.transaction(() => {
        // Check again AFTER BEGIN IMMEDIATE acquires the SQLite writer lock.
        this.checkRequest(doc, input);
        const idMap = this.applyEvents(doc, input.events);
        this.assertIdentity(doc);
        return { idMap, events: readEvents(doc.db, { ...doc.schema, topDivider: true }) };
      }).immediate();
      doc.schema.topDivider = true;
      doc.events = result.events;
      for(const e of result.events)doc.knownIds.add(e.id);
      doc.revision++;
      // data_version is connection-local and does not change for our own commits.
      // Never refresh it here: that could silently accept a concurrent external commit.
      return { revision: doc.revision, idMap: result.idMap, backup: doc.backup };
    });
  }

  renameCase(handle:string,path:string):DocumentSnapshot{
    const doc=this.get(handle),source=doc.path,destination=canonicalPath(path);
    this.requireIdle(doc);this.requireWritable(doc);this.assertCurrent(doc);
    if(destination===source)return this.snapshot(doc);
    // Compare basenames case-insensitively and directories canonicalized, so an
    // aliased source path (Save As target before this fix) still matches.
    if(basename(destination).toLowerCase()!==basename(source).toLowerCase()||dirname(destination)!==dirname(canonicalPath(source)))throw new Error('Only a filename case change is allowed.');
    const fingerprint=this.read(doc,()=>contentFingerprint(doc.db));
    let renamed=false,replacement:Document|undefined;
    doc.db.close();
    try{
      renameSync(source,destination);renamed=true;
      replacement=this.connect(destination,handle,doc.revision+1);
      if(replacement.identity!==doc.identity||contentFingerprint(replacement.db)!==fingerprint)throw new Error('Disk conflict during filename case change.');
      replacement.knownIds=doc.knownIds;replacement.backup=doc.backup;
      this.documents.set(handle,replacement);return this.snapshot(replacement);
    }catch(error){
      replacement?.db.close();let recoveryError='';
      if(renamed)try{renameSync(destination,source);}catch(rollback){recoveryError=` Filename restoration failed: ${message(rollback)}.`;}
      try{
        const restored=this.connect(source,handle,doc.revision);restored.knownIds=doc.knownIds;restored.backup=doc.backup;
        if(restored.identity!==doc.identity||contentFingerprint(restored.db)!==fingerprint)restored.dataVersion=-1;
        this.documents.set(handle,restored);
      }catch(reopen){recoveryError+=` Connection could not be restored; reopen ${source}: ${message(reopen)}.`;}
      throw new Error(`Filename case change failed: ${message(error)}.${recoveryError}`);
    }
  }

  async saveAs(request: SaveRequest, path: string, overwrite=true): Promise<DocumentSnapshot> {
    const input = copyRequest(request);
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Invalid Save As path.');
    const destination = existsSync(path) ? realpathSync(path) : canonicalPath(path);
    if(!overwrite&&existsSync(destination))throw new Error('Destination already exists; rename never replaces another file.');
    const doc = this.get(input.handle);
    return this.enqueue(doc, async () => {
      // Save As is also recovery from disk/revision conflicts: input.events is the
      // authoritative memory snapshot. Never save/reload/mutate the source here.
      for (const open of this.documents.values()) {
        if (open.path === destination || (existsSync(destination) && open.identity === identity(destination))) {
          throw new Error('Save As requires a different destination that is not already open.');
        }
      }
      if(!overwrite&&existsSync(destination))throw new Error('Destination already exists; rename never replaces another file.');
      const destinationIdentity = existsSync(destination) ? identity(destination) : undefined;
      const staging = join(dirname(destination), `.${basename(destination)}.${randomUUID()}.electron-saveas`);
      reserve(staging);
      let copy: Database.Database | undefined;
      let target: Document | undefined;
      try {
        // SQLite's online backup copies assets, IDs, sqlite_sequence and committed WAL pages.
        await doc.db.backup(staging);
        copy = new Database(staging, { nativeBinding: process.env.TODOLINE_NATIVE_BINDING, fileMustExist: true });
        const schema = inspectSchema(copy);
        if (schema.warning) throw new Error(`Cannot export this unsupported schema: ${schema.warning}`);
        copy.pragma('journal_mode = WAL');
        copy.pragma('synchronous = FULL');
        copy.transaction(() => {
          const exported = { ...doc, db: copy!, schema, events: readEvents(copy!, schema) };
          this.upgrade(exported);
          exported.schema = { ...schema, topDivider: true };
          const existing = new Set(exported.events.map(event => event.id));
          // Restore positive IDs deleted by an external writer before allocating
          // temporary negative IDs, so AUTOINCREMENT cannot take a restored ID.
          const insert = copy!.prepare(`INSERT INTO events (id, ${FIELDS.join(', ')})
            VALUES (?, ${FIELDS.map(() => '?').join(', ')})`);
          for (const event of input.events) {
            if (event.id > 0 && !existing.has(event.id)) insert.run(event.id, ...FIELDS.map(field => event[field]));
          }
          exported.events = readEvents(copy!, exported.schema);
          this.applyEvents(exported, input.events);
        }).immediate();
        copy.close();
        copy = undefined;
        syncFile(staging);
        if (destinationIdentity !== undefined) {
          // The main-process Save dialog owns overwrite confirmation. Validate and
          // back up the confirmed target, then leave no stale WAL beside the new DB.
          if (identity(destination) !== destinationIdentity) throw new Error('Disk conflict: Save As destination was replaced.');
          target = this.connect(destination, randomUUID(), 1);
          await this.prepareWrite(target);
          this.assertCurrent(target);
          this.setJournalMode(target, 'delete');
          this.assertCurrent(target);
          target.db.close();
          target = undefined;
          if (identity(destination) !== destinationIdentity) throw new Error('Disk conflict: Save As destination was replaced.');
          renameSync(staging, destination);
        } else {
          // Publish atomically without clobbering a destination created during export.
          linkSync(staging, destination);
        }
        const exported = this.connect(destination, randomUUID(), 1);
        this.documents.set(exported.handle, exported);
        return this.snapshot(exported);
      } finally {
        copy?.close();
        target?.db.close();
        removeOwnedFiles(staging);
      }
    });
  }

  discardEmpty(handle:string,identity:string):boolean{
    const doc=this.get(handle);this.requireIdle(doc);
    if(!emptyDocumentEvents(doc.events)||fileIdentity(statSync(doc.path))!==identity)return false;
    this.requireWritable(doc);this.assertCurrent(doc);
    this.close(handle);
    // The connection must be closed before unlinking on Windows.
    try{unlinkSync(doc.path);return true;}
    catch(error){const restored=this.connect(doc.path,handle,doc.revision);restored.knownIds=doc.knownIds;this.documents.set(handle,restored);throw error;}
  }

  close(handle: string): void {
    const doc = this.get(handle);
    this.requireIdle(doc);
    doc.db.close();
    this.documents.delete(handle);
  }

  search(handle: string, q: string): SearchHit[] {
    const doc = this.get(handle);
    if (typeof q !== 'string') throw new Error('Search query must be a string.');
    const query = q.trim();
    return this.read(doc, () => {
      if (!query) return [];
      if (doc.schema.trigram && !doc.readOnly && Array.from(query).length >= 3 && !query.includes('\0')) {
        const phrase = `"${query.toLowerCase().replace(/"/g, '""')}"`;
        return doc.db.prepare(`SELECT e.id, e.content_text AS text FROM events e
          JOIN events_fts f ON f.rowid = e.id WHERE events_fts MATCH ? ORDER BY e.pos, e.id`)
          .all(phrase) as SearchHit[];
      }
      // Literal substring fallback for short Unicode queries and the legacy plain
      // tokenizer; escape wildcards so searching for '%' cannot match every event.
      const like = `%${query.toLowerCase().replace(/[\\%_]/g, char => `\\${char}`)}%`;
      return doc.db.prepare(`SELECT id, content_text AS text FROM events
        WHERE lower(content_text) LIKE ? ESCAPE '\\' OR lower(deadline_raw) LIKE ? ESCAPE '\\'
        ORDER BY pos, id`).all(like, like) as SearchHit[];
    });
  }

  asset(handle: string, id: number): AssetRecord | null {
    const doc = this.get(handle);
    if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Invalid asset ID.');
    return this.read(doc, () => {
      const row = doc.db.prepare('SELECT id, w, h, data FROM assets WHERE id = ?').get(id) as AssetRecord | undefined;
      return row ? { ...row, data: new Uint8Array(row.data) } : null;
    });
  }

  async addAsset(handle: string, data: Uint8Array, w: number, h: number): Promise<number> {
    return (await this.addAssets(handle,[{data,w,h}]))[0];
  }
  async addAssets(handle:string,assets:AssetInput[]):Promise<number[]> {
    if(!Array.isArray(assets))throw new Error('Invalid asset batch.');
    const inputs=assets.map(asset=>{
      if(!asset||!(asset.data instanceof Uint8Array)||!Number.isSafeInteger(asset.w)||asset.w<0||!Number.isSafeInteger(asset.h)||asset.h<0)throw new Error('Invalid asset bytes or dimensions.');
      return {...asset,data:Buffer.from(asset.data)};
    });
    const doc = this.get(handle);
    return this.enqueue(doc, async () => {
      this.requireWritable(doc);
      this.assertCurrent(doc);
      if(!inputs.length)return [];
      await this.prepareWrite(doc);
      const ids = doc.db.transaction(() => {
        this.assertCurrent(doc);
        this.upgrade(doc);
        const insert=doc.db.prepare('INSERT INTO assets(w, h, data) VALUES (?, ?, ?)');
        const ids=inputs.map(({w,h,data})=>{
          const assetId=Number(insert.run(w,h,data).lastInsertRowid);
          if(!Number.isSafeInteger(assetId)||assetId<=0)throw new Error('Asset ID exceeds the supported integer range.');
          return assetId;
        });
        this.assertIdentity(doc);
        return ids;
      }).immediate();
      doc.schema.topDivider = true;
      // Asset insertion leaves the renderer's event revision valid (API returns only an ID).
      return ids;
    });
  }

  snapshots(): DocumentSnapshot[] {
    return [...this.documents.values()].map(doc => this.snapshot(doc));
  }

  readLegacySettings(path: string): Record<string, string> {
    // The Qt session DB is separate from document files; this never creates or migrates it.
    if (typeof path !== 'string' || !path.trim() || path.includes('\0')) throw new Error('Invalid legacy settings path.');
    identity(path);
    const db = new Database(path, { nativeBinding: process.env.TODOLINE_NATIVE_BINDING, readonly: true, fileMustExist: true });
    try {
      if (!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'settings'").get()) return {};
      if (!['key', 'value'].every(name => columns(db, 'settings').includes(name))) {
        throw new Error('Unsupported legacy settings schema.');
      }
      const rows = db.prepare('SELECT key, value FROM settings').all() as { key: unknown; value: unknown }[];
      return Object.fromEntries(rows.filter(row => typeof row.key === 'string' && typeof row.value === 'string')
        .map(row => [row.key as string, row.value as string]));
    } finally { db.close(); }
  }

  private connect(path: string, handle: string, revision: number): Document {
    const fileIdentity = identity(path);
    let db = new Database(path, { nativeBinding: process.env.TODOLINE_NATIVE_BINDING, readonly: true, fileMustExist: true, timeout: 3000 });
    try {
      let loaded = db.transaction(() => {
        const dataVersion = Number(db.pragma('data_version', { simple: true }));
        const schema = inspectSchema(db);
        return { schema, events: readEvents(db, schema), dataVersion };
      })();
      if (identity(path) !== fileIdentity) throw new Error('Disk conflict: document was replaced while opening.');
      if (!loaded.schema.warning) {
        let writable: Database.Database | undefined;
        try { writable = new Database(path, { nativeBinding: process.env.TODOLINE_NATIVE_BINDING, fileMustExist: true, timeout: 3000 }); } catch (error) {
          if (!/SQLITE_(CANTOPEN|READONLY)/.test(String((error as { code?: string }).code))) throw error;
          loaded.schema.warning = `Read-only document: write access unavailable (${message(error)}).`;
        }
        if (writable) {
          db.close();
          db = writable;
          // Validate again on this connection, before even changing journal mode.
          loaded = db.transaction(() => {
            const dataVersion = Number(db.pragma('data_version', { simple: true }));
            const schema = inspectSchema(db);
            return { schema, events: readEvents(db, schema), dataVersion };
          })();
          if (loaded.schema.warning) db.pragma('query_only = ON');
          db.pragma('synchronous = FULL');
        }
      }
      if (identity(path) !== fileIdentity) throw new Error('Disk conflict: document was replaced while opening.');
      return {
        handle, path, db, identity: fileIdentity, ...loaded, revision,
        readOnly: db.readonly || Boolean(loaded.schema.warning), pending: 0,knownIds:new Set(loaded.events.map(e=>e.id)),
      };
    } catch (error) {
      db.close();
      throw new Error(`Cannot open TodoLine document "${path}": ${message(error)}`, { cause: error });
    }
  }

  private get(handle: string): Document {
    const doc = this.documents.get(handle);
    if (!doc) throw new Error(`Unknown or closed document handle: ${handle}`);
    return doc;
  }

  private snapshot(doc: Document): DocumentSnapshot {
    return {
      handle: doc.handle, path: doc.path, name: basename(doc.path), revision: doc.revision,
      events: doc.events.map(event => ({ ...event })), readOnly: doc.readOnly, warning: doc.schema.warning,
    };
  }

  private requireIdle(doc: Document): void {
    if (doc.pending) throw new Error('Document is busy; await pending storage operations before reload or close.');
  }

  private requireWritable(doc: Document): void {
    if (doc.readOnly) throw new Error(doc.schema.warning ?? 'Document is read-only.');
  }

  private assertIdentity(doc: Document): void {
    try {
      if (identity(doc.path) === doc.identity) return;
    } catch { /* Deleted or inaccessible files are also conflicts, never new documents. */ }
    throw new Error('Disk conflict: document file was replaced, removed, or is inaccessible. Reload before saving.');
  }

  private assertCurrent(doc: Document): void {
    this.assertIdentity(doc);
    if (Number(doc.db.pragma('data_version', { simple: true })) !== doc.dataVersion) {
      throw new Error('Disk conflict: document was modified by another connection. Reload before saving.');
    }
  }

  private checkRequest(doc: Document, request: SaveRequest): void {
    this.requireWritable(doc);
    if (request.revision !== doc.revision) throw new Error('Revision conflict: stale renderer snapshot. Reload before saving.');
    this.assertCurrent(doc);
    const ids = doc.knownIds;
    for (const event of request.events) {
      if (event.id > 0 && !ids.has(event.id)) throw new Error(`Unknown persisted event ID ${event.id}; use a negative ID for new events.`);
    }
  }

  private enqueue<T>(doc: Document, operation: () => Promise<T>): Promise<T> {
    doc.pending++;
    this.pending++;
    const result = this.tail.then(async () => {
      if (this.documents.get(doc.handle) !== doc) throw new Error('Document changed while the operation was queued; reload it.');
      return operation();
    }).finally(() => { doc.pending--; this.pending--; });
    this.tail = result.then(() => undefined, () => undefined);
    return result;
  }

  private read<T>(doc: Document, operation: () => T): T {
    this.assertCurrent(doc);
    const result = doc.db.transaction(() => { this.assertCurrent(doc); return operation(); })();
    this.assertCurrent(doc);
    return result;
  }

  private async prepareWrite(doc: Document): Promise<void> {
    this.requireWritable(doc);
    this.assertCurrent(doc);
    if (!doc.backup) {
      const root = this.backupRoot ?? dirname(doc.path);
      if (this.backupRoot) mkdirSync(root, { recursive: true });
      const backup = join(root, `${basename(doc.path)}.${Date.now()}.${randomUUID()}.electron-backup`);
      reserve(backup);
      try {
        await doc.db.backup(backup, { progress: () => { this.assertCurrent(doc); return 100; } });
        this.assertCurrent(doc);
        syncFile(backup);
        doc.backup = backup;
      } catch (error) {
        removeOwnedFiles(backup);
        throw new Error(`Pre-write backup failed: ${message(error)}. No edits were written.`, { cause: error });
      }
    }
    this.assertCurrent(doc);
    // journal_mode itself persists a header change, so it must follow the backup.
    this.setJournalMode(doc, 'wal');
    doc.db.pragma('synchronous = FULL');
  }

  private setJournalMode(doc: Document, mode: 'wal' | 'delete'): void {
    this.assertCurrent(doc);
    if (String(doc.db.pragma('journal_mode', { simple: true })).toLowerCase() === mode) return;
    const before = doc.db.transaction(() => {
      this.assertCurrent(doc);
      return contentFingerprint(doc.db);
    })();
    if (String(doc.db.pragma(`journal_mode = ${mode}`, { simple: true })).toLowerCase() !== mode) {
      throw new Error(`Cannot enable ${mode.toUpperCase()} journaling; the document may be in use.`);
    }
    const dataVersion = doc.db.transaction(() => {
      this.assertIdentity(doc);
      if (contentFingerprint(doc.db) !== before) {
        throw new Error('Disk conflict: document changed during journal-mode transition. Reload before saving.');
      }
      return Number(doc.db.pragma('data_version', { simple: true }));
    }).immediate();
    // This baseline was verified while holding the writer lock. A later external
    // commit still changes data_version and is caught by the save's own transaction.
    doc.dataVersion = dataVersion;
  }

  private changed(before: EventRecord[], after: EventRecord[]): boolean {
    if (before.length !== after.length) return true;
    const byId = new Map(before.map(event => [event.id, event]));
    return after.some(event => {
      const original = byId.get(event.id);
      return !original || FIELDS.some(field => event[field] !== original[field]);
    });
  }

  private upgrade(doc: Document): void {
    if (!doc.schema.topDivider) doc.db.exec(`ALTER TABLE events ADD COLUMN ${DIVIDER}`);
  }

  private applyEvents(doc: Document, events: EventRecord[]): Record<string, number> {
    this.upgrade(doc); // Part of the same transaction as every insert/update/delete.
    const existing = new Map(doc.events.map(event => [event.id, event]));
    const retained = new Set(events.filter(event => event.id > 0).map(event => event.id));
    const del = doc.db.prepare('DELETE FROM events WHERE id = ?');
    for (const id of existing.keys()) if (!retained.has(id)) del.run(id);
    const insert = doc.db.prepare(`INSERT INTO events (${FIELDS.join(', ')}) VALUES (${FIELDS.map(() => '?').join(', ')})`);
    const idMap: Record<string, number> = {};
    for (const event of events) {
      if (event.id < 0) {
        const result = insert.run(...FIELDS.map(field => event[field]));
        const id = Number(result.lastInsertRowid);
        if (!Number.isSafeInteger(id) || id <= 0) throw new Error('Event ID exceeds the supported integer range.');
        idMap[String(event.id)] = id;
      } else if(!existing.has(event.id)) {
        doc.db.prepare(`INSERT INTO events (id, ${FIELDS.join(', ')}) VALUES (?, ${FIELDS.map(() => '?').join(', ')})`).run(event.id,...FIELDS.map(field=>event[field]));
      } else {
        const original = existing.get(event.id)!;
        const changed = FIELDS.filter(field => event[field] !== original[field]);
        if (changed.length) {
          // Do not even bind an unchanged HTML/text body on metadata-only updates.
          doc.db.prepare(`UPDATE events SET ${changed.map(field => `${field} = ?`).join(', ')} WHERE id = ?`)
            .run(...changed.map(field => event[field]), event.id);
        }
      }
    }
    return idMap;
  }
}
