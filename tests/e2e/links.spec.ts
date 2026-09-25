import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,file:string;
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'链接.tde');const store=new DocumentStore(),doc=store.open(file,true);
  await store.save({...doc,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:0,content_html:'<p><a href="https://example.com"><span style="color:#2e86de;text-decoration:underline;font-size:18pt"><b>链接正文</b></span></a></p>',content_text:'链接正文'}]});store.close(doc.handle);
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();BrowserWindow.getAllWindows()[0].focus();});await expect(editor()).toBeVisible();
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
const editor=()=>page.locator('.document-scroller:visible .todo-document');
async function end(){await editor().locator('p').last().click();await page.keyboard.press('Control+End');}
function savedHtml(){const db=new Database(file,{readonly:true});try{return (db.prepare('select content_html from events order by pos').get() as {content_html:string}).content_html;}finally{db.close();}}
test('loaded link end Backspace unlinks before deleting text and both steps remain undoable after save',async()=>{
  await end();await page.keyboard.press('Backspace');await expect(editor().locator('a')).toHaveCount(0);await expect(editor()).toHaveText('链接正文');await expect.poll(savedHtml).not.toContain('href=');
  await page.keyboard.press('Backspace');await expect(editor()).toHaveText('链接正');await page.keyboard.press('Control+z');await expect(editor()).toHaveText('链接正文');await expect(editor().locator('a')).toHaveCount(0);await page.keyboard.press('Control+z');await expect(editor().locator('a')).toHaveCount(1);
  await page.keyboard.type(' 后续');await expect(editor().locator('a')).toHaveText('链接正文');await expect(editor()).toHaveText('链接正文 后续');
});
test('space and Enter link Qt tokens; explicit unlink is respected and IME Enter does not split',async()=>{
  await end();await page.keyboard.press('Control+a');await page.keyboard.type('https://example.com');await expect(editor().locator('a')).toHaveCount(0);await page.keyboard.press('Space');await expect(editor().locator('a')).toHaveText('https://example.com');await page.keyboard.press('Backspace');await page.keyboard.press('Backspace');await expect(editor().locator('a')).toHaveCount(0);await page.keyboard.press('Space');await expect(editor().locator('a')).toHaveCount(0);
  await page.keyboard.press('Control+a');await page.keyboard.type('中文www.example.com!');const dom=await editor().elementHandle();await editor().dispatchEvent('keydown',{key:'Enter',isComposing:true});await expect(editor().locator('p')).toHaveCount(1);await page.keyboard.press('Enter');await expect(editor().locator('p')).toHaveCount(2);await expect(editor().locator('a')).toHaveText('www.example.com');expect(await dom!.evaluate(el=>el.isConnected)).toBe(true);await page.keyboard.press('Control+z');await expect(editor().locator('p')).toHaveCount(1);await expect(editor().locator('a')).toHaveCount(0);
});
test('link menu validates, edits and removes a complete loaded link while preserving caret and focus',async({},info)=>{
  await end();const before=await editor().evaluate((el:any)=>el.editor.state.selection.from);await page.getByRole('button',{name:'插入链接',exact:true}).click();const input=page.getByRole('textbox',{name:'链接地址'});await expect(input).toHaveValue('https://example.com');await input.fill('https://');await input.press('Enter');await expect(input).toBeVisible();await expect(page.locator('.toast')).toContainText('有效');
  await input.fill('https://updated.example/test');await input.dispatchEvent('keydown',{key:'Enter',isComposing:true});await expect(input).toBeVisible();await page.screenshot({path:info.outputPath('link-menu.png')});await input.press('Enter');await expect(input).toHaveCount(0);await expect(editor()).toBeFocused();await expect(editor().locator('a')).toHaveAttribute('href','https://updated.example/test');expect(await editor().evaluate((el:any)=>el.editor.state.selection.from)).toBe(before);
  await page.getByRole('button',{name:'插入链接',exact:true}).click();await page.getByRole('button',{name:'移除链接',exact:true}).click();await expect(editor()).toBeFocused();await expect(editor().locator('a')).toHaveCount(0);expect(await editor().evaluate((el:any)=>el.editor.state.selection.from)).toBe(before);await page.keyboard.type('继续');await expect(editor()).toHaveText('链接正文继续');await expect.poll(savedHtml).not.toMatch(/href=|color:|<u>/);
});
test('inserting a link at an empty caret inserts its label and Escape returns to typing',async()=>{
  await end();await page.keyboard.press('Control+a');await page.keyboard.press('Delete');await page.getByRole('button',{name:'插入链接',exact:true}).click();await page.getByRole('textbox',{name:'链接地址'}).fill(' https://example.org/path ');await page.getByRole('textbox',{name:'链接地址'}).press('Enter');await expect(editor().locator('a')).toHaveText('https://example.org/path');await expect(editor()).toBeFocused();await page.getByRole('button',{name:'插入链接',exact:true}).click();await page.getByRole('textbox',{name:'链接地址'}).press('Escape');await expect(editor()).toBeFocused();await page.keyboard.type(' 正文');await expect(editor().locator('a')).toHaveText('https://example.org/path');
});
test('new links and removed Qt link styles survive an actual Qt save and Electron reopen',async()=>{
  await end();await page.keyboard.press('Backspace');await page.keyboard.press('Enter');await page.keyboard.type('https://example.org/path');await page.keyboard.press('Space');await expect.poll(savedHtml).toContain('href="https://example.org/path"');await page.locator('.file-tab.active .tab-close').click();
  execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['edit',file],{env:{...process.env,PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH,QT_QPA_PLATFORM:'offscreen'},windowsHide:true});
  await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(editor()).toContainText('旧版再次编辑');await expect(editor().locator('a')).toHaveCount(1);await expect(editor().locator('a')).toHaveAttribute('href','https://example.org/path');await expect(editor().locator('strong').first()).toHaveText('链接正文');
});
test('only Ctrl-click requests external opening and ordinary clicks keep links editable',async()=>{
  await app.evaluate(({shell})=>{(globalThis as any).openedLinks=[];shell.openExternal=async href=>{(globalThis as any).openedLinks.push(href);};});
  await editor().locator('a').click();expect(await app.evaluate(()=>(globalThis as any).openedLinks)).toEqual([]);
  await editor().locator('a').click({modifiers:['Control']});expect(await app.evaluate(()=>(globalThis as any).openedLinks)).toEqual(['https://example.com']);await expect(editor().locator('a')).toHaveCount(1);
});
