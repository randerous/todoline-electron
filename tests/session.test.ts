// @vitest-environment node
import { afterEach,beforeEach,expect,it,vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SessionStore,normalizeSession } from '../src/main/session';
import { fitWindow } from '../src/main/window-state';
let root:string;
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'todoline-session-'));});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
it('validates each field while preserving valid tabs and the active file after invalid entries',()=>{
  const a=path.join(root,'甲.tde'),b=path.join(root,'乙.tde');
  const data=normalizeSession({settings:{theme:'system',fontSize:999,sidebarWidth:-100,sidebar:'false',lineNumbers:false,closeToTray:true,advanceMinutes:Infinity,autoHideToolbar:'yes'},tabs:[null,{path:a,cursor:4,scroll:NaN},{path:b,cursor:9,scroll:33},{path:a.toUpperCase()}],active:2,recent:[a,{},a.toUpperCase(),b,'relative.tde'],bounds:{x:0,y:NaN,width:NaN,height:20},maximized:'yes'});
  expect(data.tabs).toEqual([{path:a,cursor:4,scroll:0},{path:b,cursor:9,scroll:33}]);expect(data.active).toBe(1);expect(data.recent).toEqual([a,b]);expect(data.settings).toMatchObject({theme:'system',fontSize:30,sidebarWidth:180,sidebar:true,lineNumbers:false,closeToTray:true,advanceMinutes:5,autoHideToolbar:false});expect(data.bounds).toBeUndefined();expect(data.maximized).toBe(false);
  // A negative lead time is the "reminders off" choice and must survive validation.
  expect(normalizeSession({settings:{advanceMinutes:-1}}).settings.advanceMinutes).toBe(-1);
  expect(normalizeSession({settings:{advanceMinutes:-9}}).settings.advanceMinutes).toBe(-1);
});
it('backs up the previous valid session and recovers it when primary JSON is truncated',()=>{
  const store=new SessionStore(root);expect(store.firstRun).toBe(true);store.update({tabs:[{path:path.join(root,'甲.tde'),cursor:5,scroll:30}],settings:{...store.data.settings,theme:'green'}});store.update({settings:{...store.data.settings,theme:'light'}});
  fs.writeFileSync(path.join(root,'session.json'),'{broken');const recovered=new SessionStore(root);expect(recovered.firstRun).toBe(false);expect(recovered.data.settings.theme).toBe('green');expect(recovered.data.tabs[0].cursor).toBe(5);expect(recovered.warning).toContain('上一份有效会话');const preserved=fs.readdirSync(root).find(n=>n.startsWith('session.corrupt-'))!;expect(fs.readFileSync(path.join(root,preserved),'utf8')).toBe('{broken');
  recovered.update({});expect(new SessionStore(root).data.tabs).toEqual(recovered.data.tabs);expect(new SessionStore(root).warning).toBe('');
});
it('preserves an invalid root and starts with usable defaults when no backup exists',()=>{
  fs.writeFileSync(path.join(root,'session.json'),'null');const store=new SessionStore(root);expect(store.data.tabs).toEqual([]);expect(store.data.settings.theme).toBe('dark');expect(store.firstRun).toBe(false);expect(store.warning).toContain('损坏');store.update({});expect(JSON.parse(fs.readFileSync(path.join(root,'session.json'),'utf8')).tabs).toEqual([]);
});
it('does not overwrite corrupt configuration if its preservation fails',()=>{
  fs.writeFileSync(path.join(root,'session.json'),'{original');vi.spyOn(fs,'copyFileSync').mockImplementation(()=>{throw new Error('denied');});const store=new SessionStore(root);expect(()=>store.update({})).toThrow('暂不覆盖');expect(fs.readFileSync(path.join(root,'session.json'),'utf8')).toBe('{original');
});
it('a failed atomic replacement leaves the last committed session and backup usable',()=>{
  const store=new SessionStore(root);store.update({nextDraft:3});const rename=fs.renameSync;vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(to===path.join(root,'session.json'))throw new Error('disk denied');return rename(from,to);});
  expect(()=>store.update({nextDraft:4})).toThrow('disk denied');expect(store.data.nextDraft).toBe(3);expect(JSON.parse(fs.readFileSync(path.join(root,'session.json'),'utf8')).nextDraft).toBe(3);expect(JSON.parse(fs.readFileSync(path.join(root,'session.json.bak'),'utf8')).nextDraft).toBe(3);
});
it('unchanged session updates avoid redundant disk writes',()=>{const store=new SessionStore(root);store.update({});const write=vi.spyOn(fs,'writeFileSync');store.update({active:0});expect(write).not.toHaveBeenCalled();});
it('persists the new document directory and rejects invalid locations',()=>{
  const store=new SessionStore(root),directory=path.join(root,'文档');store.update({settings:{...store.data.settings,newFileDirectory:directory}});
  expect(new SessionStore(root).data.settings.newFileDirectory).toBe(directory);
  expect(normalizeSession({settings:{newFileDirectory:'../relative'}}).settings.newFileDirectory).toBe('');
});
it('defaults old sessions to wrapping and persists an explicitly disabled preference',()=>{
  expect(normalizeSession({}).settings.wordWrap).toBe(true);
  expect(normalizeSession({settings:{wordWrap:'false'}}).settings.wordWrap).toBe(true);
  const store=new SessionStore(root);store.update({settings:{...store.data.settings,wordWrap:false}});
  expect(new SessionStore(root).data.settings.wordWrap).toBe(false);
});
it('broadcasts one global recent list after successful persistence, deduplicating case variants',()=>{
  const changed=vi.fn(),store=new SessionStore(root,changed),file=path.join(root,'note.md');store.recent(file);store.recent(file.toUpperCase());
  expect(store.data.recent).toHaveLength(1);expect(changed).toHaveBeenLastCalledWith([file.toUpperCase()]);
  const previous=changed.mock.calls.length;store.update({active:0});expect(changed).toHaveBeenCalledTimes(previous);
  vi.spyOn(fs,'renameSync').mockImplementation(()=>{throw new Error('denied');});expect(()=>store.recent(path.join(root,'failed.md'))).toThrow();expect(changed).toHaveBeenCalledTimes(previous);
});
const primary={x:0,y:0,width:1920,height:1040},left={x:-1600,y:0,width:1600,height:860};
it('restores normal bounds on a negative-coordinate secondary monitor',()=>{expect(fitWindow({x:-1500,y:50,width:900,height:650},[primary,left])).toEqual({x:-1500,y:50,width:900,height:650});});
it('brings a disconnected monitor window back onto the primary work area',()=>{const b=fitWindow({x:8000,y:-4000,width:900,height:650},[primary]);expect(b).toEqual({x:510,y:195,width:900,height:650});});
it('fits oversized windows and keeps controls inside a small display work area',()=>{expect(fitWindow({x:0,y:0,width:4000,height:3000},[{x:20,y:30,width:640,height:480}])).toEqual({x:20,y:30,width:640,height:480});});
it('centers a first window and clamps partially offscreen edges',()=>{expect(fitWindow(undefined,[primary])).toEqual({x:340,y:100,width:1240,height:840});expect(fitWindow({x:1700,y:900,width:900,height:650},[primary])).toEqual({x:1020,y:390,width:900,height:650});});

it('normalizes fractional line spacing, clamps bounds and preserves it on disk',()=>{
 for(const [value,expected] of [[1.8,1.8],[0,1],[10,3],[NaN,1.5],['2',1.5]] as const)expect(normalizeSession({settings:{lineSpacing:value}}).settings.lineSpacing).toBe(expected);
 const store=new SessionStore(root);store.update({settings:{...store.data.settings,lineSpacing:1.8}});expect(new SessionStore(root).data.settings.lineSpacing).toBe(1.8);
});
