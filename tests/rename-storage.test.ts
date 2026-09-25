// @vitest-environment node
import {beforeEach,afterEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import {DocumentStore} from '../src/main/storage';
import type {DocumentSnapshot,EventRecord} from '../src/shared/types';
let root:string,store:DocumentStore,doc:DocumentSnapshot;
const event:EventRecord={id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_html:'<p>大小写与历史</p>',content_text:'大小写与历史'};
beforeEach(async()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'todoline-rename-'));store=new DocumentStore();doc=store.open(path.join(root,'Case.tde'),true);await store.save({...doc,events:[event,{...event,id:-2,pos:1024,content_text:'恢复这条'}]});doc=store.snapshots()[0];});
afterEach(()=>{vi.restoreAllMocks();for(const d of store.snapshots())try{store.close(d.handle);}catch{}fs.rmSync(root,{recursive:true,force:true});});
it('changes only filename case while keeping the handle, events and deleted IDs available for undo',async()=>{
  const original=doc.events;await store.save({...doc,events:[original[0]]});const renamed=store.renameCase(doc.handle,path.join(root,'case.TDE'));
  expect(renamed.handle).toBe(doc.handle);expect(renamed.name).toBe('case.TDE');expect(fs.readdirSync(root)).toContain('case.TDE');expect(fs.readdirSync(root)).not.toContain('Case.tde');
  await store.save({...renamed,events:original});expect(store.snapshots()[0].events).toEqual(original);
});
it.skipIf(process.platform !== 'win32')('an external reader that prevents rename leaves the old connection usable',async()=>{
  const reader=new Database(doc.path);reader.prepare('select * from events').all();
  try{expect(()=>store.renameCase(doc.handle,path.join(root,'case.tde'))).toThrow('case change failed');}finally{reader.close();}
  await store.save({...doc,events:doc.events.map(e=>({...e,done:1}))});expect(store.snapshots()[0].events[0].done).toBe(1);expect(fs.existsSync(doc.path)).toBe(true);
});
it('a failed reopen restores the original name and allows retrying saves',async()=>{
  vi.spyOn(store as any,'connect').mockImplementationOnce(()=>{throw new Error('reopen denied');});
  expect(()=>store.renameCase(doc.handle,path.join(root,'CASE.tde'))).toThrow('reopen denied');expect(fs.readdirSync(root)).toContain('Case.tde');
  await store.save({...doc,events:doc.events.map(e=>({...e,done:1}))});expect(store.snapshots()[0].events[0].done).toBe(1);
});
it('external writes while the connection is closed force a reload rather than adopting a new save baseline',async()=>{
  const connect=(store as any).connect.bind(store);let once=true;
  vi.spyOn(store as any,'connect').mockImplementation((...args:any[])=>{if(once){once=false;const db=new Database(args[0]);db.prepare('update events set content_text=? where id=?').run('外部修改',doc.events[0].id);db.close();}return connect(...args);});
  expect(()=>store.renameCase(doc.handle,path.join(root,'CASE.tde'))).toThrow('Disk conflict');
  await expect(store.save({...doc,events:doc.events})).rejects.toThrow('Disk conflict');expect(store.reload(doc.handle).events[0].content_text).toBe('外部修改');
});
it('case rename rejects arbitrary relocation and a rename copy cannot overwrite an existing file',async()=>{
  expect(()=>store.renameCase(doc.handle,path.join(root,'elsewhere.tde'))).toThrow('Only a filename');
  const target=path.join(root,'existing.tde');fs.writeFileSync(target,'keep these bytes');
  await expect(store.saveAs({...doc},target,false)).rejects.toThrow('already exists');expect(fs.readFileSync(target,'utf8')).toBe('keep these bytes');
  const raced=path.join(root,'raced.tde'),saving=store.saveAs({...doc},raced,false);fs.writeFileSync(raced,'created while queued');
  await expect(saving).rejects.toThrow('already exists');expect(fs.readFileSync(raced,'utf8')).toBe('created while queued');
});
