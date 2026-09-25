// @vitest-environment node
import {afterEach,beforeEach,expect,it} from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../src/main/storage';
import {MarkdownStore} from '../src/main/markdown-store';
import {fileIdentity} from '../src/main/file-identity';
import {documentDate,emptyDocumentEvents} from '../src/shared/new-document';
import {SessionStore} from '../src/main/session';
const blankEvent={id:-1,pos:0,created_at:1,deadline_raw:'',deadline_ts:null,done:0,top_divider:0,content_html:'',content_text:''};
let root:string,store:DocumentStore;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'todoline-new-'));store=new DocumentStore();});
afterEach(()=>{for(const doc of store.snapshots())store.close(doc.handle);fs.rmSync(root,{recursive:true,force:true});});
it('uses the local calendar date and persists daily sequence and ownership',()=>{
  expect(documentDate(new Date(2026,8,17,23,59))).toBe('20260917');
  const session=new SessionStore(root),file=path.join(root,'20260917_0.tde');
  session.update({newFileSequence:{date:'20260917',next:2},autoNamedDocuments:[{path:file,identity:'1:2:3.5'}]});
  expect(new SessionStore(root).data).toMatchObject({newFileSequence:{date:'20260917',next:2},autoNamedDocuments:[{path:file,identity:'1:2:3.5'}]});
});
it('removes an empty TDE including whitespace after edits, but only with matching identity',async()=>{
  const file=path.join(root,'empty.tde'),doc=store.open(file,true),identity=fileIdentity(fs.statSync(file));
  expect(store.discardEmpty(doc.handle,'1:2:0')).toBe(false);
  await store.save({handle:doc.handle,revision:doc.revision,events:[blankEvent].map(e=>({...e,content_html:'<!DOCTYPE HTML><html><head><style>p {margin:0}</style></head><body><p><span> &nbsp; </span><br></p></body></html>',content_text:'  '}))});
  expect(store.discardEmpty(doc.handle,identity)).toBe(true);expect(fs.existsSync(file)).toBe(false);
});
it.each(['<p>text</p>','<p><img src="asset:1"></p>','<table><tr><td></td></tr></table>','<hr>','<video></video>'])('preserves body content %s',html=>{
  const doc=store.open(path.join(root,'content.tde'),true);
  expect(emptyDocumentEvents([blankEvent].map(e=>({...e,content_html:html})))).toBe(false);
});
it('preserves deadlines without body text and rejects external changes',()=>{
  const file=path.join(root,'outside.tde'),doc=store.open(file,true),identity=fileIdentity(fs.statSync(file));
  expect(emptyDocumentEvents([blankEvent].map(e=>({...e,deadline_raw:'1天后'})))).toBe(false);
  const external=new Database(file);external.prepare('insert into events(pos,created_at,content_text,content_html) values(0,1,?,?)').run('outside','<p>outside</p>');external.close();
  expect(()=>store.discardEmpty(doc.handle,identity)).toThrow();expect(fs.existsSync(file)).toBe(true);
});
it('removes blank Markdown but preserves images, externally edited files and replacement identities',async()=>{
  const md=new MarkdownStore(path.join(root,'recovery')),file=path.join(root,'empty.md');
  const doc=await md.create(file);const identity=fileIdentity(fs.statSync(file));
  expect(await md.discardEmpty(doc.handle,'1:2:0')).toBe(false);
  fs.writeFileSync(file,'outside');await expect(md.discardEmpty(doc.handle,identity)).rejects.toThrow('其他程序');
  expect(fs.readFileSync(file,'utf8')).toBe('outside');await md.close(doc.handle);
  const image=await md.create(path.join(root,'image.md'),'![](image.png)');
  expect(await md.discardEmpty(image.handle,fileIdentity(fs.statSync(image.path)))).toBe(false);
  const blank=await md.create(path.join(root,'blank.md'),' \n');
  expect(await md.discardEmpty(blank.handle,fileIdentity(fs.statSync(blank.path)))).toBe(true);
  expect(fs.existsSync(blank.path)).toBe(false);
});
