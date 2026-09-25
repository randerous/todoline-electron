// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { MarkdownStore } from '../src/main/markdown-store';

let root: string, store: MarkdownStore, file: string;
beforeEach(async () => { root = await fs.mkdtemp(path.join(os.tmpdir(), 'todoline-md-')); file = path.join(root, '中文 文档.md'); store = new MarkdownStore(path.join(root, 'recovery')); });
afterEach(async () => { await fs.rm(root, { recursive: true, force: true }); });
const write = (source: string | Uint8Array) => fs.writeFile(file, source);

it('opens a native text file and deduplicates simultaneous opens without inventing events', async () => {
  await write('# 标题\n\n正文');
  const [a, b] = await Promise.all([store.open(file), store.open(file)]);
  expect(a).toEqual(b); expect(a).toMatchObject({ kind: 'markdown', source: '# 标题\n\n正文', draft: false });
  expect('events' in a).toBe(false); expect(store.snapshots()).toHaveLength(1);
  expect(await fs.readFile(file, 'utf8')).toBe('# 标题\n\n正文');
});
it('keeps UTF-8 BOM and CRLF while saving edits, then reopens as Markdown', async () => {
  await write('\ufeff# 标题\r\n\r\n内容\r\n');
  const doc = await store.open(file);
  expect(doc.source.startsWith('\ufeff')).toBe(false);
  const result = await store.save({ handle: doc.handle, revision: 0, source: '# 标题\n\n新内容\n' });
  expect(result.revision).toBe(1); expect(await fs.readFile(file, 'utf8')).toBe('\ufeff# 标题\r\n\r\n新内容\r\n');
  await store.close(doc.handle);
  expect((await store.open(file)).source).toBe('# 标题\r\n\r\n新内容\r\n');
});
it('rejects stale concurrent saves instead of overwriting an acknowledged edit', async () => {
  await write('before'); const doc = await store.open(file);
  const saved = await Promise.allSettled(['one', 'two'].map(source => store.save({ handle: doc.handle, revision: 0, source })));
  expect(saved[0].status).toBe('fulfilled'); expect(saved[1].status).toBe('rejected');
  expect(await fs.readFile(file, 'utf8')).toBe('one');
});
it('detects external modifications, preserves both versions and recovers the pending edit after restart', async () => {
  await write('before'); const doc = await store.open(file); await write('outside');
  await expect(store.save({ handle: doc.handle, revision: 0, source: 'local' })).rejects.toThrow('其他程序');
  expect(await fs.readFile(file, 'utf8')).toBe('outside');
  const restart = new MarkdownStore(path.join(root, 'recovery')), recovered = await restart.open(file);
  expect(recovered).toMatchObject({ source: 'local', recovered: true });
  await expect(restart.save({ handle: recovered.handle, revision: 0, source: recovered.source })).rejects.toThrow('冲突');
  const copy = await restart.saveAs({ handle: recovered.handle, revision: 0, source: recovered.source }, path.join(root, '副本.md'));
  expect(copy.source).toBe('local'); expect(await fs.readFile(file, 'utf8')).toBe('outside');
});
it('reload archives the editor contents before adopting externally modified text', async () => {
  await write('initial'); const doc = await store.open(file); await write('external');
  const reloaded = await store.reload({ handle: doc.handle, revision: 0, source: 'local unsaved' });
  expect(reloaded.source).toBe('external'); expect(reloaded.revision).toBe(1);
  expect(await fs.readFile(reloaded.recoveryBackup!, 'utf8')).toBe('local unsaved');
});
it('invalid reload does not replace the current snapshot or delete its recovery', async () => {
  await write('initial'); const doc = await store.open(file); await write(Buffer.from([0xff, 0xfe]));
  await expect(store.reload({ handle: doc.handle, revision: 0, source: 'local' })).rejects.toThrow('UTF-8');
  expect(store.snapshot(doc.handle).source).toBe('initial');
  const backup = (await fs.readdir(path.join(root, 'recovery'),{recursive:true})).find(name => name.endsWith('.md'))!;
  expect(await fs.readFile(path.join(root, 'recovery', backup), 'utf8')).toBe('local');
});
it('refuses invalid UTF-8 and binary files without altering their bytes', async () => {
  for (const bytes of [Buffer.from([0xff, 0xfe, 0x61]), Buffer.from('a\0b')]) {
    await write(bytes); await expect(store.open(file)).rejects.toThrow(); expect(await fs.readFile(file)).toEqual(bytes);
  }
});
it('does not rewrite an unchanged Markdown document', async () => {
  await write('unchanged'); const old = new Date('2020-01-01T00:00:00Z'); await fs.utimes(file, old, old);
  const doc = await store.open(file); await store.save({ handle: doc.handle, revision: 0, source: doc.source });
  expect((await fs.stat(file)).mtimeMs).toBe(old.getTime());
});
it('creates recoverable drafts without overwriting an existing file', async () => {
  expect(await store.create(file)).toMatchObject({ draft: true, source: '' });
  await expect(store.create(file, 'replacement')).rejects.toThrow(); expect(await fs.readFile(file, 'utf8')).toBe('');
});
it('renames a Markdown document and refuses to overwrite another file', async () => {
  await write('body'); const doc = await store.open(file), target = path.join(root, 'new.markdown');
  await fs.writeFile(target, 'other'); await expect(store.rename(doc.handle, target)).rejects.toThrow();
  expect(await fs.readFile(target, 'utf8')).toBe('other'); await fs.unlink(target);
  expect(await store.rename(doc.handle, target)).toMatchObject({ path: target, name: 'new.markdown' });
  expect(await fs.readFile(target, 'utf8')).toBe('body'); await expect(fs.stat(file)).rejects.toThrow();
});
it('Save As refuses to overwrite another open tab', async () => {
  await write('a'); const doc = await store.open(file), other = path.join(root, 'other.md'); await fs.writeFile(other, 'b'); await store.open(other);
  await expect(store.saveAs({ handle: doc.handle, revision: 0, source: 'c' }, other)).rejects.toThrow('标签');
  expect(await fs.readFile(other, 'utf8')).toBe('b');
});
it('stores pasted image bytes in a portable attachment folder and copies referenced assets on Save As', async () => {
  await write('');const doc=await store.open(file),bytes=Buffer.from([137,80,78,71,1,2,3]);
  const reference=await store.addAsset(doc.handle,bytes,'png');expect(reference).toMatch(/^中文 文档\.assets\/.+\.png$/);
  expect(await fs.readFile(await store.assetPath(doc.handle,reference))).toEqual(bytes);
  expect(await store.addAsset(doc.handle,bytes,'png')).toBe(reference);
  const directory=path.join(root,'copy');await fs.mkdir(directory);
  const target=path.join(directory,'new.md'),source=`![图](<${reference}>)`;
  const copy=await store.saveAs({handle:doc.handle,revision:0,source,assets:[reference]},target);
  expect(copy.source).toBe(source);expect(await fs.readFile(await store.assetPath(copy.handle,reference))).toEqual(bytes);
});
it('never serves an image outside the document directory through a relative traversal',async()=>{
  const directory=path.join(root,'inner');await fs.mkdir(directory);const doc=await store.create(path.join(directory,'test.md'));
  await fs.writeFile(path.join(root,'private.png'),'private');
  await expect(store.assetPath(doc.handle,'../private.png')).rejects.toThrow('超出');
  await expect(store.assetPath(doc.handle,'%2e%2e/private.png')).rejects.toThrow('超出');
  await expect(store.assetPath(doc.handle,'file:///private.png')).rejects.toThrow('无效');
});
it('does not overwrite different destination image bytes during Save As',async()=>{
  await write('');const doc=await store.open(file),reference=await store.addAsset(doc.handle,Buffer.from([1,2,3]),'png');
  const directory=path.join(root,'copy'),image=path.join(directory,reference);await fs.mkdir(path.dirname(image),{recursive:true});await fs.writeFile(image,'different');
  const target=path.join(directory,'new.md');await expect(store.saveAs({handle:doc.handle,revision:0,source:'image',assets:[reference]},target)).rejects.toThrow('同名图片');
  expect(await fs.readFile(image,'utf8')).toBe('different');await expect(fs.stat(target)).rejects.toThrow();
});
it('reload creates an independently usable recovery copy including local images',async()=>{
  await write('initial');const doc=await store.open(file),bytes=Buffer.from([1,2,3]),reference=await store.addAsset(doc.handle,bytes,'png');await write('external');
  const restored=await store.reload({handle:doc.handle,revision:0,source:`![图片](<${reference}>)`,assets:[reference]});
  const backup=await store.open(restored.recoveryBackup!);expect(await fs.readFile(await store.assetPath(backup.handle,reference))).toEqual(bytes);
});
