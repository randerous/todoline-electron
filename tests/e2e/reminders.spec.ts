import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,popup:Page,root:string,profile:string,file:string,env:NodeJS.ProcessEnv;
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});file=path.join(root,'提醒与中文.tde');
  const store=new DocumentStore(),doc=store.open(file,true),now=Math.floor(Date.now()/1000);
  await store.save({handle:doc.handle,revision:doc.revision,events:Array.from({length:4},(_,i)=>({id:-(i+1),pos:i*1024,created_at:now-3600,deadline_raw:'',deadline_ts:now-60+i,done:0,top_divider:i===0?1:0,content_html:`<p>提醒事件 ${i+1}：核对资料与下一步安排。</p>`,content_text:`提醒事件 ${i+1}：核对资料与下一步安排。`}))});store.close(doc.handle);
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:[{path:file,cursor:2,scroll:0}],active:0,recent:[file]}));
  env={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus){await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await popup?.screenshot({path:info.outputPath('popup-failure.png')}).catch(()=>{});}await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function launch(){app=await _electron.launch(process.env.TODOLINE_TEST_EXE?{executablePath:process.env.TODOLINE_TEST_EXE,args:[],env:env as Record<string,string>}:{args:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.todo-document')).toBeVisible();}
async function getPopup(){await expect.poll(()=>app.windows().some(p=>p.url().includes('reminder.html'))).toBe(true);popup=app.windows().find(p=>p.url().includes('reminder.html'))!;await expect(popup.locator('.reminder-content')).toBeVisible();return popup;}
const state=async()=>JSON.parse(await fs.readFile(path.join(profile,'reminders.json'),'utf8'));
const visible=()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('reminder.html'))?.isVisible()??false);
const resume=()=>app.evaluate(({powerMonitor})=>{powerMonitor.emit('resume');});
function done(){const db=new Database(file,{readonly:true});try{return (db.prepare('select done from events order by pos').get() as {done:number}).done;}finally{db.close();}}

test('independent reminders queue every event without showing the hidden editor and open the selected event',async({},info)=>{
  await launch();await getPopup();await expect(popup.locator('small')).toContainText('4 条');await expect(popup.locator('.reminder-content')).toContainText('提醒事件 1');
  expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.isVisible())).toBe(false);
  expect(await visible()).toBe(true);expect((await state()).pending).toHaveLength(4);
  expect(await popup.evaluate(()=>typeof window.desktop)).toBe('undefined');
  const bounds=await app.evaluate(({BrowserWindow,screen})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('reminder.html'))!;return {bounds:win.getBounds(),area:screen.getPrimaryDisplay().workArea,top:win.isAlwaysOnTop()};});expect(bounds.top).toBe(true);expect(bounds.bounds.x+bounds.bounds.width).toBeLessThanOrEqual(bounds.area.x+bounds.area.width);
  await popup.screenshot({path:info.outputPath('reminder-dark.png')});
  await popup.getByRole('button',{name:'关闭提醒',exact:true}).click();await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');
  await popup.getByRole('button',{name:'打开事件',exact:true}).click();await expect.poll(()=>page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.$from.parent.textContent)).toContain('提醒事件 2');
  expect(await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.isVisible())).toBe(true);
  await expect(popup.locator('.reminder-content')).toContainText('提醒事件 3');expect((await state()).pending).toHaveLength(2);
  await popup.getByRole('button',{name:'我知道了',exact:true}).click();await expect(popup.locator('.reminder-content')).toContainText('提醒事件 4');expect((await state()).pending).toHaveLength(1);
});
test('pending deliveries replay after a process exit but a dismissed reminder does not',async()=>{
  await launch();await getPopup();const first=(await state()).pending[0].id;await app.evaluate(({app})=>app.exit(0));await launch();await getPopup();expect((await state()).pending[0].id).toBe(first);
  await popup.getByRole('button',{name:'关闭提醒',exact:true}).click();await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');await app.evaluate(({app})=>app.exit(0));await launch();await getPopup();await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');expect((await state()).pending).toHaveLength(3);
});
test('snooze persists for ten minutes and a failed write leaves the same actionable reminder',async()=>{
  await launch();await getPopup();const first=(await state()).pending[0];await fs.mkdir(path.join(profile,'reminders.json.tmp'));
  await popup.getByRole('button',{name:'10分钟后提醒',exact:true}).click();await expect(popup.getByRole('alert')).toBeVisible();expect((await state()).pending[0].id).toBe(first.id);
  await fs.rmdir(path.join(profile,'reminders.json.tmp'));const before=Date.now();await popup.getByRole('button',{name:'10分钟后提醒',exact:true}).click();await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');
  const saved=await state();expect(saved.snoozed[0][1]).toBeGreaterThanOrEqual(Math.floor(before/1000)*1000+600000);expect(saved.snoozed[0][1]).toBeLessThan(Date.now()+600001);
  await app.evaluate(({app})=>app.exit(0));await launch();await getPopup();await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');expect((await state()).snoozed).toHaveLength(1);
});
test('marking complete waits for a real save, retries a save failure and remains undoable',async()=>{
  await launch();await getPopup();await app.evaluate(()=>{const fs=process.getBuiltinModule('fs').promises,original=fs.open;(globalThis as any).__reminderFail=true;fs.open=async(file,...args)=>{if((globalThis as any).__reminderFail&&String(file).includes('recovery'))throw new Error('simulated disk full');return original(file,...args);};});
  await popup.getByRole('button',{name:'已完成',exact:true}).click();await expect(popup.getByRole('alert')).toContainText('simulated disk full');expect(done()).toBe(0);expect((await state()).pending).toHaveLength(4);
  await app.evaluate(()=>{(globalThis as any).__reminderFail=false;});await popup.getByRole('button',{name:'已完成',exact:true}).click();await expect.poll(done).toBe(1);await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');
  await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;win.show();win.focus();});await page.locator('.todo-document p').first().click();await page.keyboard.press('Control+z');await expect.poll(done).toBe(0);expect((await state()).pending).toHaveLength(3);
});
test('failed initial reminder persistence reports the failure and retries without losing due events',async()=>{
  await fs.mkdir(path.join(profile,'reminders.json.tmp'));await launch();await expect(page.locator('.toast')).toContainText('提醒暂未更新');expect(await visible()).toBe(false);
  await fs.rmdir(path.join(profile,'reminders.json.tmp'));await resume();await getPopup();await expect(popup.locator('small')).toContainText('4 条');expect((await state()).pending).toHaveLength(4);
});
test('lock and suspend hide reminders without consuming them; unlock follows the selected theme',async({},info)=>{
  await launch();await getPopup();const ids=(await state()).pending.map((p:any)=>p.id);
  await app.evaluate(({powerMonitor})=>{powerMonitor.emit('lock-screen');powerMonitor.emit('suspend');});await expect.poll(visible).toBe(false);
  await app.evaluate(({powerMonitor})=>{powerMonitor.emit('resume');});expect(await visible()).toBe(false);expect((await state()).pending.map((p:any)=>p.id)).toEqual(ids);
  await page.evaluate(async()=>{const s=await window.desktop.session();await window.desktop.updateSession({settings:{...s.settings,theme:'green'}});});
  await app.evaluate(({powerMonitor})=>{powerMonitor.emit('unlock-screen');});await expect.poll(visible).toBe(true);await expect(popup.locator('html')).toHaveAttribute('data-theme','green');await popup.screenshot({path:info.outputPath('reminder-green.png')});
});
test('closing a document removes its active popup and reopening restores its undismissed queue',async()=>{
  await launch();await getPopup();await page.evaluate(async()=>{const s=await window.desktop.session(),d=await window.desktop.openRecent(s.tabs[0].path);await window.desktop.close(d.handle);});await expect.poll(visible).toBe(false);
  await page.evaluate(async()=>{const s=await window.desktop.session();await window.desktop.openRecent(s.tabs[0].path);});await resume();await expect.poll(visible).toBe(true);await expect(popup.locator('small')).toContainText('4 条');
});
test('an unattended reminder expires after 45 real seconds even if the wall clock moves backwards',async()=>{
  test.setTimeout(70000);await launch();await getPopup();
  await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>!w.webContents.getURL().includes('reminder.html'))!;main.show();main.focus();const win=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('reminder.html'))!;win.blur();const original=Date.now;Date.now=()=>original()-3600000;});
  // CDP pointer positions are per renderer: leaving the main page does not
  // clear hover in the independent reminder renderer.
  await popup.mouse.move(20,50);await popup.mouse.move(-20,400);
  await expect(popup.locator('.reminder-card:hover')).toHaveCount(0);
  await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('reminder.html'))!.isFocused())).toBe(false);
  const started=performance.now();
  await expect.poll(async()=>(await state()).pending.length,{timeout:52000,intervals:[1000]}).toBe(3);
  expect(performance.now()-started).toBeGreaterThan(42000);await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');
});
test('saved deadline removal clears the displayed notice and normal quit destroys the independent window',async()=>{
  await launch();await getPopup();
  await fs.mkdir(path.join(profile,'reminders.json.tmp'));
  await page.evaluate(()=>{const editor=(document.querySelector('.todo-document') as any).editor;let pos=-1;editor.state.doc.descendants((node:any,p:number)=>{if(pos<0&&node.type.name==='divider')pos=p;});if(pos<0)throw new Error('Missing divider');editor.view.dispatch(editor.state.tr.setNodeMarkup(pos,undefined,{...editor.state.doc.nodeAt(pos).attrs,deadline_ts:null,deadline_raw:''}));});
  await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');expect((await state()).pending).toHaveLength(4);
  await fs.rmdir(path.join(profile,'reminders.json.tmp'));await resume();await expect.poll(async()=>(await state()).pending.length).toBe(3);
  const exited=app.waitForEvent('close');await page.evaluate(()=>window.desktop.requestClose());await exited;
});
test('advancing the queue retains the hover pause instead of expiring the next reminder under the pointer',async()=>{
  test.setTimeout(65000);await launch();await getPopup();await popup.getByRole('button',{name:'关闭提醒',exact:true}).click();
  await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');
  await popup.waitForTimeout(47000);
  expect((await state()).pending).toHaveLength(3);await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');
});

test('editable snooze accepts minutes, hours and days, rejects invalid input and resets for each notice',async({},info)=>{
 await launch();await getPopup();const field=popup.getByRole('textbox',{name:'稍后提醒时间'});await expect(field).toHaveValue('10分钟后');
 const first=(await state()).pending[0].id;await field.fill('错误时间');await field.press('Enter');await expect(popup.getByRole('alert')).toContainText('未来的提醒时间');expect((await state()).pending[0].id).toBe(first);expect((await state()).snoozed).toHaveLength(0);await expect(field).toHaveValue('错误时间');
 for(const [raw,delay] of [['5分钟',300000],['2小时',7200000],['3天后',259200000]] as const){
  const before=Date.now(),pending=(await state()).pending[0];await field.fill(raw);
  await popup.screenshot({path:info.outputPath(`snooze-${delay}.png`)});
  const layout=await popup.locator('footer').evaluate(el=>({width:el.clientWidth,scroll:el.scrollWidth}));expect(layout.scroll).toBeLessThanOrEqual(layout.width);
  await popup.getByRole('button',{name:raw+'提醒',exact:true}).click();await expect.poll(async()=>(await state()).pending[0].id).not.toBe(pending.id);
  const db=new Database(file,{readonly:true});const saved=db.prepare('select deadline_raw,deadline_ts from events where id=?').get(Number(pending.key.split(':').at(-2))) as any;db.close();expect(saved.deadline_raw).toBe(raw.endsWith('后')?raw:raw+'后');expect(saved.deadline_ts*1000).toBeGreaterThanOrEqual(Math.floor(before/1000)*1000+delay);expect(saved.deadline_ts*1000).toBeLessThanOrEqual(Date.now()+delay);const time=(await state()).snoozed.find((entry:any)=>entry[0]===pending.key.replace(/:\d+$/,':'+saved.deadline_ts))[1];expect(time).toBe(saved.deadline_ts*1000);await expect(field).toHaveValue('10分钟后');
 }
 await app.evaluate(({app})=>app.exit(0));await launch();await getPopup();expect((await state()).snoozed).toHaveLength(3);await expect(popup.getByRole('textbox',{name:'稍后提醒时间'})).toHaveValue('10分钟后');
});

test('postponing one day synchronizes the deadline and event lists, retaining body edits and surviving reopen',async()=>{
 await launch();await getPopup();
 await page.locator('.todo-document').evaluate((el:any)=>{const ed=el.editor;let at=0;ed.state.doc.descendants((n:any,p:number)=>{if(!at&&n.type.name==='paragraph')at=p+1;});ed.view.dispatch(ed.state.tr.insertText('未保存编辑 ',at));});
 const before=Date.now();const field=popup.getByRole('textbox',{name:'稍后提醒时间'});await field.fill('1天后');await field.press('Enter');await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');
 const saved=()=>{const db=new Database(file,{readonly:true});try{return db.prepare('select * from events order by pos').get() as any;}finally{db.close();}};
 await expect.poll(()=>saved().deadline_raw).toBe('1天后');expect(saved().deadline_ts).toBeGreaterThanOrEqual(Math.floor(before/1000)+86400);expect(saved().content_text).toContain('未保存编辑');
 await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;w.show();w.focus();});
 await expect(page.locator('.event-deadline').first()).toHaveValue('1天后');
 await page.getByRole('button',{name:/待提醒/}).click();await expect(page.locator('.event-panel-row').filter({hasText:'提醒事件 1'})).toHaveCount(1);await page.getByRole('button',{name:'关闭事件列表'}).click();
 await page.getByRole('button',{name:/到期未完成/}).click();await expect(page.locator('.event-panel-row').filter({hasText:'提醒事件 1'})).toHaveCount(0);
 const due=saved().deadline_ts;await app.evaluate(({app})=>app.exit(0));await launch();await getPopup();expect(saved().deadline_ts).toBe(due);await expect(page.locator('.event-deadline').first()).toHaveValue('1天后');
});
test('failed event save leaves postponed reminder retryable and restores its original deadline',async()=>{
 await launch();await getPopup();const first=(await state()).pending[0];
 await app.evaluate(()=>{const fs=process.getBuiltinModule('fs').promises,original=fs.open;(globalThis as any).__postponeFail=true;fs.open=async(file,...args)=>{if((globalThis as any).__postponeFail&&String(file).includes('recovery'))throw new Error('postpone disk full');return original(file,...args);};});
 const field=popup.getByRole('textbox',{name:'稍后提醒时间'});await field.fill('1天后');await field.press('Enter');await expect(popup.getByRole('alert')).toContainText('postpone disk full');expect((await state()).pending[0].id).toBe(first.id);await expect(page.locator('.event-deadline').first()).toHaveValue('');
 await app.evaluate(()=>{(globalThis as any).__postponeFail=false;});await field.press('Enter');await expect(popup.locator('.reminder-content')).toContainText('提醒事件 2');await expect(page.locator('.event-deadline').first()).toHaveValue('1天后');
});
