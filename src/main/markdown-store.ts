import fs from 'node:fs/promises';
import path from 'node:path';
import {fileIdentity} from './file-identity';
import { createHash, randomUUID } from 'node:crypto';
import type { MarkdownSaveRequest, MarkdownSaveResult, TextFileSnapshot } from '../shared/native-document';
import { isMarkdownPath,isTdePath } from '../shared/native-document';

const hash = (data: string | Uint8Array) => createHash('sha256').update(data).digest('hex');
const key = (file: string) => path.resolve(file).toLocaleLowerCase();
interface OpenMarkdown {
  snapshot: TextFileSnapshot;
  diskHash: string;
  bom: boolean;
  encoding: 'utf8'|'utf16le'|'utf16be';
  newline: '\n' | '\r\n' | '\r';
  conflict: boolean;
}
interface Journal { path: string; base: string; source: string }

/** File-backed text storage, independent of the SQLite worker and event reminders. */
export class MarkdownStore {
  private documents = new Map<string, OpenMarkdown>();
  private queues = new Map<string, Promise<unknown>>();
  constructor(private recoveryRoot: string) {}

  private exclusive<T>(handle: string, action: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(handle) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(action);
    this.queues.set(handle, operation);
    void operation.finally(() => { if (this.queues.get(handle) === operation) this.queues.delete(handle); }).catch(() => {});
    return operation;
  }
  private get(handle: string): OpenMarkdown {
    const doc = this.documents.get(handle);
    if (!doc) throw new Error('文本文件已关闭，请重新打开。');
    return doc;
  }
  has(handle: string) { return this.documents.has(handle); }
  snapshot(handle: string): TextFileSnapshot { return { ...this.get(handle).snapshot }; }
  async discardEmpty(handle:string,identity:string){
    return this.exclusive(handle,async()=>{
      const doc=this.get(handle);
      if(doc.snapshot.source.trim()||doc.snapshot.readOnly||doc.conflict||fileIdentity(await fs.stat(doc.snapshot.path))!==identity)return false;
      await this.diskUnchanged(doc);await fs.unlink(doc.snapshot.path);
      this.documents.delete(handle);await this.retire(doc.snapshot.path).catch(()=>{});return true;
    });
  }
  annotate(handle:string,details:Pick<TextFileSnapshot,'warning'|'recoveryBackup'>){Object.assign(this.get(handle).snapshot,details);}
  snapshots(): TextFileSnapshot[] { return [...this.documents.values()].map(doc => ({ ...doc.snapshot })); }
  private journalPath(file: string) { return path.join(this.recoveryRoot, hash(key(file)) + '.json'); }
  private validate(request: MarkdownSaveRequest): OpenMarkdown {
    const doc = this.get(request.handle);
    if (!Number.isSafeInteger(request.revision) || typeof request.source !== 'string') throw new Error('无效文本保存请求。');
    if (request.revision !== doc.snapshot.revision) throw new Error('文本文件版本已变化，请重新加载或另存为。');
    return doc;
  }
  private encode(doc: OpenMarkdown, source: string) {
    const normalized = source.replace(/\r\n|\r/g, '\n').replace(/\n/g, doc.newline);
    const text=(doc.bom?'\ufeff':'')+normalized;
    return doc.encoding==='utf8'?Buffer.from(text,'utf8'):doc.encoding==='utf16le'?Buffer.from(text,'utf16le'):Buffer.from(text,'utf16le').swap16();
  }
  private async atomicWrite(file: string, data: string | Uint8Array) {
    const temp = file + '.' + randomUUID() + '.tmp';
    try {
      const stream = await fs.open(temp, 'wx');
      try { await stream.writeFile(data); await stream.sync(); } finally { await stream.close(); }
      await fs.rename(temp, file);
    } catch (error) { await fs.rm(temp, { force: true }).catch(() => {}); throw error; }
  }
  private async stage(doc: OpenMarkdown, source: string) {
    await fs.mkdir(this.recoveryRoot, { recursive: true });
    const record: Journal = { path: doc.snapshot.path, base: doc.diskHash, source };
    await this.atomicWrite(this.journalPath(doc.snapshot.path), JSON.stringify(record));
  }
  private async retire(file: string) { await fs.rm(this.journalPath(file), { force: true }); }
  private async diskUnchanged(doc: OpenMarkdown) {
    let current: Buffer;
    try { current = await fs.readFile(doc.snapshot.path); }
    catch { throw new Error('磁盘上的文本文件无法读取，当前编辑已保留，请另存为。'); }
    if (hash(current) !== doc.diskHash) throw new Error('文本文件已被其他程序修改，当前编辑已保留，请重新加载或另存为。');
  }

  /** Resolve only images belonging to this document tree; never arbitrary file: paths. */
  async assetPath(handle: string, reference: string): Promise<string> {
    const doc = this.get(handle), root = await fs.realpath(path.dirname(doc.snapshot.path));
    if (typeof reference !== 'string' || !reference || /^[a-z][a-z\d+.-]*:/i.test(reference) || /^[\\/]/.test(reference) || reference.includes('\0')) throw new Error('无效 Markdown 附件路径。');
    let relative: string; try { relative = decodeURIComponent(reference); } catch { throw new Error('无效 Markdown 附件路径。'); }
    const requested = path.resolve(root, relative), inside = (file: string) => { const rel = path.relative(root, file); return !!rel && rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel); };
    if (!inside(requested)) throw new Error('图片路径超出文档所在目录。');
    const real = await fs.realpath(requested); if (!inside(real)) throw new Error('图片路径超出文档所在目录。');
    return real;
  }

  async addAsset(handle: string, data: Uint8Array, extension: string): Promise<string> {
    return this.exclusive(handle, async () => {
      const doc = this.get(handle);
      if(doc.snapshot.kind==='text')throw new Error('纯文本文件不支持图片附件。');
      if (doc.snapshot.readOnly) throw new Error('文本文件为只读。');
      if (!(data instanceof Uint8Array) || !data.length || data.length > 100 * 1024 * 1024 || !/^(png|jpg|gif|webp|avif)$/.test(extension)) throw new Error('无效 Markdown 图片。');
      const directory = path.basename(doc.snapshot.path, path.extname(doc.snapshot.path)) + '.assets', root = path.dirname(doc.snapshot.path);
      await fs.mkdir(path.join(root, directory), { recursive: true });
      // Refuse an existing attachment directory that is a symlink outside the document tree.
      const actualRoot = await fs.realpath(root), actualDirectory = await fs.realpath(path.join(root, directory));
      if (path.dirname(actualDirectory).toLowerCase() !== actualRoot.toLowerCase()) throw new Error('附件目录超出文档所在目录。');
      const filename = hash(data) + '.' + extension, target = path.join(actualDirectory, filename);
      try { await fs.writeFile(target, data, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(await fs.readFile(target)) !== hash(data)) throw error; }
      return directory.split(path.sep).join('/') + '/' + filename;
    });
  }

  async open(file: string, draft = false): Promise<TextFileSnapshot> {
    file = path.resolve(file);
    if (isTdePath(file)) throw new Error('TDE 文档不能作为纯文本打开。');
    // Serialize opens of the same path as well as mutations of an existing handle.
    return this.exclusive('path:' + key(file), async () => {
      const existing = [...this.documents.values()].find(doc => key(doc.snapshot.path) === key(file));
      if (existing) return { ...existing.snapshot };
      const bytes = await fs.readFile(file);
      const decoded=decodeFile(bytes,!isMarkdownPath(file)),source=decoded.source;
      const snapshot: TextFileSnapshot = { kind: isMarkdownPath(file)?'markdown':'text', encoding:decoded.encoding, handle: randomUUID(), path: file, name: path.basename(file), source, revision: 0, draft };
      const doc: OpenMarkdown = { snapshot, diskHash: hash(bytes), bom: decoded.bom, encoding: decoded.encoding, newline: source.includes('\r\n') ? '\r\n' : source.includes('\r')?'\r':'\n', conflict: false };
      try { await fs.access(file, fs.constants.W_OK); } catch { snapshot.readOnly = true; }
      let record: Journal | undefined;
      try { record = JSON.parse(await fs.readFile(this.journalPath(file), 'utf8')); } catch { /* Absent or malformed recovery records are never substituted for a document. */ }
      if (record && record.path === file && typeof record.base === 'string' && typeof record.source === 'string') {
        if (hash(this.encode(doc, record.source)) === doc.diskHash) await this.retire(file).catch(() => {});
        else {
          snapshot.source = record.source; snapshot.recovered = true;
          doc.conflict = record.base !== doc.diskHash;
          snapshot.warning = doc.conflict ? '已恢复未保存的 文本内容；磁盘文件也有变化，请另存为或重新加载。' : '已恢复上次未保存的 文本内容。';
        }
      }
      this.documents.set(snapshot.handle, doc);
      return { ...snapshot };
    });
  }

  async create(file: string, source = '',draft=true): Promise<TextFileSnapshot> {
    if (isTdePath(file)) throw new Error('TDE 文件必须通过数据库创建。');
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, source, { encoding: 'utf8', flag: 'wx' });
    return this.open(file, draft);
  }

  async save(request: MarkdownSaveRequest): Promise<MarkdownSaveResult> {
    return this.exclusive(request.handle, async () => {
      const doc = this.validate(request);
      await this.stage(doc, request.source);
      if (doc.snapshot.readOnly) throw new Error('文本文件为只读，请另存为。');
      if (doc.conflict) throw new Error('恢复内容与磁盘版本冲突，请重新加载或另存为。');
      await this.diskUnchanged(doc);
      const bytes = this.encode(doc, request.source);
      // Avoid a rewrite (including BOM/newline changes) when no content changed.
      if (hash(bytes) !== doc.diskHash) await this.atomicWrite(doc.snapshot.path, bytes);
      doc.diskHash = hash(bytes);
      doc.snapshot.source = request.source; doc.snapshot.revision++; doc.snapshot.recovered = false; doc.snapshot.warning = undefined;
      let warning: string | undefined;
      try { await this.retire(doc.snapshot.path); } catch { warning = '正文已保存，恢复日志暂未清理。'; }
      return { revision: doc.snapshot.revision, warning };
    });
  }

  private async copyAssets(handle:string,target:string,references:string[]=[]){
    const doc=this.get(handle);
    // Preserve relative references when relocating. Conflicting destination
    // attachments abort before writing the Markdown file; nothing is overwritten.
    if (path.dirname(target) !== path.dirname(doc.snapshot.path)) for (const reference of new Set(references ?? [])) {
      if (/^(https?:|data:)/i.test(reference)) continue;
      const original = await this.assetPath(handle, reference), relative = decodeURIComponent(reference), destination = path.resolve(path.dirname(target), relative);
      const rel = path.relative(path.dirname(target), destination);
      if (!rel || rel.startsWith('..' + path.sep) || rel === '..' || path.isAbsolute(rel)) throw new Error('无法迁移文档目录外的图片。');
      await fs.mkdir(path.dirname(destination), { recursive: true });
      const actualTargetRoot = await fs.realpath(path.dirname(target)), actualParent = await fs.realpath(path.dirname(destination)), parentRelative = path.relative(actualTargetRoot, actualParent);
      if (parentRelative.startsWith('..' + path.sep) || parentRelative === '..' || path.isAbsolute(parentRelative)) throw new Error('目标附件目录超出保存目录。');
      const bytes = await fs.readFile(original);
      try { await fs.writeFile(destination, bytes, { flag: 'wx' }); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST' || hash(await fs.readFile(destination)) !== hash(bytes)) throw new Error('目标目录中存在不同的同名图片，未覆盖，请选择其他目录。'); }
    }
  }

  /** Call only after the native Save As dialog has authorized the destination. */
  async saveAs(request: MarkdownSaveRequest, target: string): Promise<TextFileSnapshot> {
    return this.exclusive(request.handle, async () => {
      const doc = this.validate(request); target = path.resolve(target);
      if (doc.snapshot.kind==='markdown'?!isMarkdownPath(target):isMarkdownPath(target)||isTdePath(target)) throw new Error('请保持当前文件类型，使用对应的文件扩展名。');
      if ([...this.documents.values()].some(d => key(d.snapshot.path) === key(target))) throw new Error('目标文件已在标签中打开，请选择其他文件名。');
      await this.copyAssets(request.handle,target,request.assets);
      await this.exclusive('path:'+key(target),async()=>{
        if([...this.documents.values()].some(d=>key(d.snapshot.path)===key(target)))throw new Error('目标文件已在标签中打开，请选择其他文件名。');
        await this.atomicWrite(target, this.encode(doc, request.source));
      });
      // Do not retire the source journal: a crash before the renderer adopts the
      // destination must still recover the original tab's unacknowledged edits.
      return this.open(target);
    });
  }

  async reload(request: MarkdownSaveRequest): Promise<TextFileSnapshot> {
    return this.exclusive(request.handle, async () => {
      const doc = this.validate(request);
      const directory=path.join(this.recoveryRoot,'documents',randomUUID());await fs.mkdir(directory,{recursive:true});
      const backup=path.join(directory,path.basename(doc.snapshot.path));
      await this.copyAssets(request.handle,backup,request.assets);
      await this.atomicWrite(backup, this.encode(doc, request.source));
      // Validate the on-disk text before retiring recovery or replacing state.
      const bytes = await fs.readFile(doc.snapshot.path);
      const decoded=decodeFile(bytes,doc.snapshot.kind==='text'),source=decoded.source;
      await this.retire(doc.snapshot.path);
      doc.diskHash = hash(bytes); doc.conflict = false;
      doc.bom = decoded.bom; doc.encoding=decoded.encoding; doc.newline = source.includes('\r\n') ? '\r\n' : source.includes('\r')?'\r':'\n';
      doc.snapshot = { ...doc.snapshot, source, encoding:decoded.encoding, revision: doc.snapshot.revision + 1, recovered: false, recoveryBackup: backup, warning: '已加载磁盘版本，之前的编辑已保留为恢复文档。' };
      return { ...doc.snapshot };
    });
  }

  async rename(handle: string, target: string): Promise<TextFileSnapshot> {
    return this.exclusive(handle, async () => {
      const doc = this.get(handle); target = path.resolve(target);
      if (isTdePath(target)) throw new Error('TDE 文件需要转换为数据库。');
      if(doc.snapshot.readOnly||doc.conflict)throw new Error('当前文件只读或存在外部修改冲突，无法重命名。');
      if (path.dirname(target) !== path.dirname(doc.snapshot.path)) throw new Error('重命名仅限当前目录，请使用另存为移动文件。');
      if (target === doc.snapshot.path) return { ...doc.snapshot };
      await this.diskUnchanged(doc);
      // link() cannot overwrite another file. Unlike rename(), it also refuses
      // an existing target on platforms where rename would silently replace it.
      if(key(doc.snapshot.path)===key(target))await fs.rename(doc.snapshot.path,target);
      else{
        if(isMarkdownPath(target)&&doc.encoding!=='utf8'){
          const bytes=Buffer.from(doc.snapshot.source.replace(/\r\n|\r/g,'\n').replace(/\n/g,doc.newline),'utf8');
          const stream=await fs.open(target,'wx');try{await stream.writeFile(bytes);await stream.sync();}catch(error){await stream.close();await fs.unlink(target).catch(()=>{});throw error;}await stream.close();
        }else await fs.link(doc.snapshot.path, target);
        try { await fs.unlink(doc.snapshot.path); } catch (error) { await fs.unlink(target).catch(() => {}); throw error; }
      }
      await this.retire(doc.snapshot.path).catch(() => {});
      if(isMarkdownPath(target)&&doc.encoding!=='utf8'){doc.encoding='utf8';doc.bom=false;doc.snapshot.encoding='utf8';doc.diskHash=hash(await fs.readFile(target));}
      doc.snapshot.kind=isMarkdownPath(target)?'markdown':'text';
      doc.snapshot.path = target; doc.snapshot.name = path.basename(target); doc.snapshot.draft = false;
      return { ...doc.snapshot };
    });
  }

  async verifyUnchanged(handle:string,revision:number){return this.exclusive(handle,async()=>{const doc=this.get(handle);if(doc.snapshot.readOnly||doc.conflict||doc.snapshot.revision!==revision)throw new Error('文件只读或版本已变化，无法转换。');await this.diskUnchanged(doc);});}

  async close(handle: string) { await this.exclusive(handle, async () => { this.get(handle); this.documents.delete(handle); }); }
}

function decodeFile(bytes:Buffer,plain:boolean):{source:string;bom:boolean;encoding:'utf8'|'utf16le'|'utf16be'} {
  const le=plain&&bytes[0]===0xff&&bytes[1]===0xfe,be=plain&&bytes[0]===0xfe&&bytes[1]===0xff;
  const encoding=le?'utf16le':be?'utf16be':'utf8',bom=le||be||bytes.subarray(0,3).equals(Buffer.from([0xef,0xbb,0xbf]));
  let source:string;
  try{source=new TextDecoder(le?'utf-16le':be?'utf-16be':'utf-8',{fatal:true}).decode(bytes);}
  catch{throw new Error('文件不是有效 UTF-8'+(plain?' 或带 BOM 的 UTF-16':'')+' 文本，请先转换编码；原文件未修改。');}
  if(/[\x00-\x08\x0e-\x1a\x1c-\x1f]/.test(source))throw new Error('该文件包含二进制内容，无法作为文本打开。');
  return {source,bom,encoding};
}
