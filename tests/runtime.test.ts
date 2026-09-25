import type { DocumentSnapshot } from '../src/shared/types';
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import { DocumentTab } from '../src/renderer/runtime';
import { newEvent } from '../src/renderer/document';
function tab(){return new DocumentTab({handle:'x',path:'x.tde',name:'x',events:[newEvent()],revision:1},vi.fn(),vi.fn());}
const mounted:DocumentTab[]=[];
beforeAll(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0} as DOMRect);Element.prototype.getClientRects=()=>[] as unknown as DOMRectList;});
afterEach(()=>{for(const t of mounted.splice(0))t.destroy();document.body.innerHTML='';});
function mountedTab(){const t=tab(),el=document.createElement('div');document.body.append(el);t.mount(el);mounted.push(t);return t;}
it('keeps unvisited snapshots intact and initializes an editor only once when requested',async()=>{
  const save=vi.fn();window.desktop={save} as any;
  const t=tab(),el=document.createElement('div');document.body.append(el);mounted.push(t);
  (t.snapshot as DocumentSnapshot).events[0].content_html='<p><b>原始内容</b></p>';(t.snapshot as DocumentSnapshot).events[0].content_text='原始内容';t.cursor=3;
  t.mount(el,false);expect(t.editor).toBeUndefined();expect(t.records()).toBe((t.snapshot as DocumentSnapshot).events);
  await t.flush();expect(save).not.toHaveBeenCalled();
  const editor=t.ensureEditor()!;expect(t.ensureEditor()).toBe(editor);expect(editor.editor.state.selection.from).toBe(3);
  expect(t.records()[0].content_html).toBe('<p><b>原始内容</b></p>');expect(t.dirty).toBe(false);
});
it('persists recovered background snapshots without constructing an editor',async()=>{
  const save=vi.fn().mockResolvedValue({revision:2,idMap:{}});window.desktop={save} as any;
  const t=tab();mounted.push(t);t.mount(document.createElement('div'),false);
  (t.snapshot as DocumentSnapshot).events[0].content_html='<p>恢复内容</p>';(t.snapshot as DocumentSnapshot).events[0].content_text='恢复内容';t.dirty=true;
  await t.flush();expect(save.mock.calls[0][0].events[0].content_html).toBe('<p>恢复内容</p>');expect(t.editor).toBeUndefined();expect(t.dirty).toBe(false);
});
it('serializes saves and sends edits made while a save acknowledgement is pending',async()=>{let finish:(x:any)=>void=()=>{};const save=vi.fn().mockImplementationOnce(()=>new Promise(r=>finish=r)).mockResolvedValue({revision:3,idMap:{}});window.desktop={save} as any;const t=tab();t.dirty=true;t.changes=1;const promise=t.flush();expect(save).toHaveBeenCalledTimes(1);t.changes++;(t.snapshot as DocumentSnapshot).events[0].content_text='later';finish({revision:2,idMap:{}});await promise;expect(save).toHaveBeenCalledTimes(2);expect(save.mock.calls[1][0].revision).toBe(2);expect(t.dirty).toBe(false);expect(t.snapshot.revision).toBe(3);});
it('keeps edits pending on failure and permits an explicit retry',async()=>{const save=vi.fn().mockRejectedValueOnce(new Error('disk full')).mockResolvedValueOnce({revision:2,idMap:{}});window.desktop={save} as any;const t=tab();t.dirty=true;await expect(t.flush()).rejects.toThrow('disk full');expect(t.dirty).toBe(true);expect(t.snapshot.revision).toBe(1);await t.flush();expect(t.dirty).toBe(false);expect(t.error).toBe('');});
it('Save As keeps the same editor and undo history while subsequent saves use the new handle',async()=>{
  const save=vi.fn().mockResolvedValue({revision:2,idMap:{}}),close=vi.fn().mockResolvedValue(undefined);
  window.desktop={save,close,saveAs:vi.fn(async r=>({handle:'new',path:'new.tde',name:'new',revision:1,events:r.events.map((e:any,i:number)=>({...e,id:i+20}))}))} as any;
  const t=mountedTab(),editor=t.editor!,dom=editor.editor.view.dom;
  editor.editor.commands.insertContent('另存前的编辑');
  expect(await t.relocate('saveAs')).toBe(true);expect(t.editor).toBe(editor);expect(editor.editor.view.dom).toBe(dom);expect(editor.handle).toBe('new');expect(t.records()[0].id).toBe(20);expect(t.dirty).toBe(false);expect(close).toHaveBeenCalledWith('x');
  editor.editor.commands.undo();expect(t.records()[0].content_text).toBe('');await t.flush();expect(save.mock.calls[0][0].handle).toBe('new');expect(save.mock.calls[0][0].events[0].id).toBe(20);
});
it('canceling Save As restores editing and retains unsaved text in the original file',async()=>{
  const close=vi.fn();window.desktop={saveAs:vi.fn(async()=>null),close} as any;
  const t=mountedTab();t.editor!.editor.commands.insertContent('不能丢');expect(await t.relocate('saveAs')).toBe(false);expect(t.snapshot.handle).toBe('x');expect(t.dirty).toBe(true);expect(t.editor!.editor.isEditable).toBe(true);expect(t.records()[0].content_text).toBe('不能丢');expect(close).not.toHaveBeenCalled();
});
it('flush waits for a file dialog and then saves a canceled move to the original handle',async()=>{
  let finish!:(value:any)=>void;const save=vi.fn().mockResolvedValue({revision:2,idMap:{}}),saveAs=vi.fn(()=>new Promise(resolve=>{finish=resolve;}));window.desktop={save,saveAs} as any;
  const t=mountedTab();t.editor!.editor.commands.insertContent('保留');const moving=t.relocate('saveAs');await vi.waitFor(()=>expect(saveAs).toHaveBeenCalledTimes(1));
  const flushing=t.flush();expect(save).not.toHaveBeenCalled();finish(null);await moving;await flushing;expect(save.mock.calls[0][0].handle).toBe('x');expect(t.dirty).toBe(false);
});
it('a failed source save does not prevent Save As recovery to a new file',async()=>{
  const save=vi.fn().mockRejectedValue(new Error('external conflict')),close=vi.fn().mockResolvedValue(undefined);window.desktop={save,close,saveAs:vi.fn(async r=>({handle:'recovery',path:'recovery.tde',name:'recovery',revision:1,events:r.events.map((e:any)=>({...e,id:50}))}))} as any;
  const t=mountedTab();t.editor!.editor.commands.insertContent('待恢复');await expect(t.flush()).rejects.toThrow('external conflict');expect(await t.relocate('saveAs')).toBe(true);expect(t.error).toBe('');expect(t.records()[0].content_text).toBe('待恢复');expect(t.snapshot.handle).toBe('recovery');
});
it('Save As waits for a clipboard read already in progress and includes its inserted text',async()=>{
  let finish!:(value:any)=>void;
  const saveAs=vi.fn(async r=>({handle:'copy',path:'copy.tde',name:'copy',revision:1,events:r.events}));
  window.desktop={readClipboard:vi.fn(()=>new Promise(resolve=>{finish=resolve;})),saveAs,close:vi.fn().mockResolvedValue(undefined)} as any;
  const t=mountedTab(),pasting=t.editor!.paste(),moving=t.relocate('saveAs');
  await Promise.resolve();expect(saveAs).not.toHaveBeenCalled();expect(t.fileBusy).toBe(true);
  finish({text:'迟到的粘贴',html:'',events:''});await pasting;await moving;
  expect(saveAs.mock.calls[0][0].events[0].content_text).toBe('迟到的粘贴');expect(t.records()[0].content_text).toBe('迟到的粘贴');expect(t.dirty).toBe(false);
});
it('flush waits for an in-flight image import and persists its original asset reference',async()=>{
  let finish!:(value:number[])=>void;
  const save=vi.fn().mockResolvedValue({revision:2,idMap:{}}),bitmap={width:120,height:80,close:vi.fn()};
  vi.stubGlobal('createImageBitmap',vi.fn().mockResolvedValue(bitmap));
  window.desktop={addAssets:vi.fn(()=>new Promise(resolve=>{finish=resolve;})),save} as any;
  try{
    const t=mountedTab(),importing=t.editor!.insertImage(new Uint8Array([1,2,3]));await vi.waitFor(()=>expect(window.desktop.addAssets).toHaveBeenCalled());
    const flushing=t.flush();expect(save).not.toHaveBeenCalled();finish([77]);await importing;await flushing;
    expect(save.mock.calls[0][0].events[0].content_html).toContain('asset:77');expect(bitmap.close).toHaveBeenCalled();expect(t.dirty).toBe(false);
  }finally{vi.unstubAllGlobals();}
});
it('a close hold remains active after a nested Save As is canceled',async()=>{
  window.desktop={saveAs:vi.fn(async()=>null)} as any;
  const t=mountedTab(),release=t.holdEditing();await t.relocate('saveAs');expect(t.fileBusy).toBe(true);expect(t.editor!.editor.isEditable).toBe(false);
  release();release();expect(t.fileBusy).toBe(false);expect(t.editor!.editor.isEditable).toBe(true);
});
it('reload replaces the document and its history without moving the tab or replaying old edits',async()=>{
  const reload=vi.fn(async request=>({handle:'x',path:'x.tde',name:'x',revision:2,recoveryBackup:'backup.tde',events:request.events.map((e:any)=>({...e,content_html:'<p>磁盘内容</p>',content_text:'磁盘内容'}))}));
  window.desktop={reload} as any;const t=mountedTab(),key=t.key,old=t.editor!;
  old.editor.commands.insertContent('待保留');t.error='external conflict';expect(await t.relocate('reload')).toBe(true);
  expect(reload.mock.calls[0][0].events[0].content_text).toBe('待保留');expect(old.editor.isDestroyed).toBe(true);expect(t.key).toBe(key);expect(t.records()[0].content_text).toBe('磁盘内容');expect(t.dirty).toBe(false);expect(t.error).toBe('');expect(t.editor!.editor.commands.undo()).toBe(false);expect(t.editor!.editor.isEditable).toBe(true);
});
it('failed reload keeps the current editor, history and pending text',async()=>{
  window.desktop={reload:vi.fn().mockRejectedValue(new Error('backup failed'))} as any;const t=mountedTab(),editor=t.editor!;editor.editor.commands.insertContent('保留编辑');t.error='external conflict';
  await expect(t.relocate('reload')).rejects.toThrow('backup failed');expect(t.editor).toBe(editor);expect(t.dirty).toBe(true);expect(editor.editor.isEditable).toBe(true);expect(t.records()[0].content_text).toBe('保留编辑');
});
