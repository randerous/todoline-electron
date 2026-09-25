// @vitest-environment node
import {afterEach,beforeEach,expect,it} from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {MarkdownStore} from '../src/main/markdown-store';
let root:string,store:MarkdownStore;
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'todoline-text-'));store=new MarkdownStore(path.join(root,'recovery'));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
it.each(['notes.txt','app.log','a.cfg','a.conf','a.strange','README','.env'])('opens and saves %s without converting its content or suffix',async name=>{
 const file=path.join(root,name),original='\ufeff# header\r\n\t**literal**  \r\n\r\n';await fs.writeFile(file,original);const doc=await store.open(file);
 expect(doc.kind).toBe('text');expect(doc.source).toBe(original.slice(1));
 await store.save({handle:doc.handle,revision:0,source:doc.source});expect(await fs.readFile(file,'utf8')).toBe(original);
 await store.save({handle:doc.handle,revision:1,source:doc.source+'next\n'});expect(await fs.readFile(file,'utf8')).toBe(original+'next\r\n');
 await store.close(doc.handle);expect((await store.open(file)).kind).toBe('text');
});
it.each(['le','be'])('preserves UTF-16%s BOM and text when saving and reloading',async endian=>{
 const file=path.join(root,'unicode.cfg'),encode=(text:string)=>{const bytes=Buffer.from('\ufeff'+text,'utf16le');return endian==='be'?bytes.swap16():bytes;};await fs.writeFile(file,encode('中文\r\n'));
 const doc=await store.open(file);expect(doc.source).toBe('中文\r\n');await store.save({handle:doc.handle,revision:0,source:'新中文\n'});expect(await fs.readFile(file)).toEqual(encode('新中文\r\n'));
 await fs.writeFile(file,encode('外部\r\n'));expect((await store.reload({handle:doc.handle,revision:1,source:'本地'})).source).toBe('外部\r\n');
});
it('renames and saves copies without adding Markdown suffixes, and detects external edits',async()=>{
 const file=path.join(root,'a.conf');await fs.writeFile(file,'enabled=true');const doc=await store.open(file),renamed=await store.rename(doc.handle,path.join(root,'b.conf'));
 expect(renamed.name).toBe('b.conf');const copy=await store.saveAs({handle:doc.handle,revision:0,source:'copy'},path.join(root,'backup.cfg'));expect(copy.kind).toBe('text');expect(await fs.readFile(copy.path,'utf8')).toBe('copy');
 await fs.writeFile(renamed.path,'external');await expect(store.save({handle:doc.handle,revision:0,source:'local'})).rejects.toThrow('其他程序');expect(await fs.readFile(renamed.path,'utf8')).toBe('external');
 const recovered=await new MarkdownStore(path.join(root,'recovery')).open(renamed.path);expect(recovered).toMatchObject({kind:'text',source:'local',recovered:true});
});
it('rejects binary input and native-format save destinations without modifying files',async()=>{
 const file=path.join(root,'data.unknown'),bytes=Buffer.from([0x50,0x4b,0x03,0x04,0,1,2]);await fs.writeFile(file,bytes);await expect(store.open(file)).rejects.toThrow('二进制');expect(await fs.readFile(file)).toEqual(bytes);
 await fs.writeFile(file,'plain');const doc=await store.open(file);for(const ext of ['tde','md'])await expect(store.saveAs({handle:doc.handle,revision:0,source:'plain'},path.join(root,'copy.'+ext))).rejects.toThrow('文件类型');
});
it('preserves old-style CR line endings and permits ANSI escape sequences in logs',async()=>{
 const file=path.join(root,'terminal.log'),source='\x1b[31merror\x1b[0m\rnext\r';await fs.writeFile(file,source);const doc=await store.open(file);
 await store.save({handle:doc.handle,revision:0,source:doc.source+'last\n'});expect(await fs.readFile(file,'utf8')).toBe(source+'last\r');
});
it.each(['utf8','le','be'])('changes text and Markdown modes on rename, keeping %s text readable after reopen',async encoding=>{
 const file=path.join(root,'source.cfg'),text='# 标题\r\n\r\n**内容**\r\n';
 const bytes=encoding==='utf8'?Buffer.from('\ufeff'+text):Buffer.from('\ufeff'+text,'utf16le');if(encoding==='be')bytes.swap16();await fs.writeFile(file,bytes);
 const doc=await store.open(file),md=await store.rename(doc.handle,path.join(root,'renamed.md'));expect(md).toMatchObject({kind:'markdown',source:text,encoding:'utf8'});
 if(encoding==='utf8')expect(await fs.readFile(md.path)).toEqual(bytes);
 else expect(await fs.readFile(md.path,'utf8')).toBe(text);
 await store.close(doc.handle);const reopened=await store.open(md.path);expect(reopened.source).toBe(text);
 const plain=await store.rename(reopened.handle,path.join(root,'README'));expect(plain).toMatchObject({kind:'text',source:text});
});
