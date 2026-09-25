import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DocumentStore} from '../../src/main/storage';
import {searchWindow} from './search-window';

let app:ElectronApplication,page:Page,root:string,ids:number[];
const quick=()=>page.getByRole('textbox',{name:'快速搜索导航'});
const body=()=>page.locator('.document-scroller[data-active] .todo-document');
const next=()=>page.getByRole('button',{name:'下一个快速搜索结果',exact:true});
const previous=()=>page.getByRole('button',{name:'上一个快速搜索结果',exact:true});
async function atEvent(index:number){
 await expect.poll(()=>body().evaluate((el,id)=>{
  const scroller=el.closest('.document-scroller')!,divider=el.querySelector(`[data-id="${id}"]`)!;
  return Math.abs(divider.getBoundingClientRect().top-scroller.getBoundingClientRect().top);
 },ids[index])).toBeLessThan(60);
}
async function selectedAll(){await expect.poll(()=>quick().evaluate((el:HTMLInputElement)=>[el.selectionStart,el.selectionEnd])).toEqual([0,(await quick().inputValue()).length]);}
test.beforeEach(async({},info)=>{
 root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});const file=path.join(root,'快速搜索.tde'),store=new DocumentStore(),doc=store.open(file,true);
 await store.save({...doc,events:Array.from({length:90},(_,i)=>({id:-i-1,pos:i*1024,created_at:1700000000+i,deadline_raw:i===70?'下周二':'',deadline_ts:null,done:0,top_divider:1,content_text:`正文 ${i+1}`+([30,60].includes(i)?' 目标':''),content_html:`<p>正文 ${i+1}${[30,60].includes(i)?' 目标':''}</p>`}))});ids=store.snapshots()[0].events.map(e=>e.id);store.close(doc.handle);
 const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=process.env.TODOLINE_TEST_EXE;app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await expect(body()).toBeVisible();await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows()[0];main.show();main.focus();});
});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('quick search jumps, highlights without filtering, wraps results and searches deadlines',async({},info)=>{
 await quick().fill('目标');await expect(body().locator('.search-match')).toHaveCount(2);await atEvent(30);await expect(quick()).toBeFocused();
 await expect(page.locator('.event-navigation-rows')).toHaveCSS('height','2880px');await expect(page.locator(`.event-navigation [data-event-id="${ids[30]}"][data-match][data-visible]`)).toBeVisible();
 expect(app.windows().some(p=>p.url()==='about:blank')).toBe(false);await expect(page.getByRole('button',{name:'清除导航搜索'})).toHaveCount(0);
 await page.locator('.sidebar').screenshot({path:info.outputPath('quick-search.png')});
 await next().click();await atEvent(60);await expect(quick()).toBeFocused();await expect(body().locator('.search-match')).toHaveCount(2);
 await next().click();await atEvent(30);await previous().click();await atEvent(60);await quick().press('Shift+Enter');await atEvent(30);await quick().press('Enter');await atEvent(60);
 await quick().fill('下周二');await atEvent(70);await expect(page.locator('.event-navigation [data-match]')).toHaveCount(1);
 await quick().fill('没有任何匹配');await expect(next()).toBeDisabled();await expect(previous()).toBeDisabled();await expect(body().locator('.search-match')).toHaveCount(0);await expect(page.locator('.event-navigation-rows')).toHaveCSS('height','2880px');
});

test('blur clears search highlights, refocus selects all, and a new query replaces the old one',async()=>{
 await quick().fill('目标');await atEvent(30);await body().locator('p').filter({hasText:'正文 31'}).click();
 await expect(body().locator('.search-match,.search-event')).toHaveCount(0);await expect(page.locator('.event-navigation [data-match]')).toHaveCount(0);await expect(quick()).toHaveValue('目标');
 await quick().click();await selectedAll();await expect(body().locator('.search-match')).toHaveCount(2);await page.keyboard.insertText('下周二');await expect(quick()).toHaveValue('下周二');await atEvent(70);
 await quick().press('Tab');await expect(body().locator('.search-match,.search-event')).toHaveCount(0);await page.keyboard.press('Shift+Tab');await selectedAll();
 await quick().press('Escape');await expect(quick()).toHaveValue('');await expect(next()).toBeDisabled();
 // Clicking an arrow while the field is inactive should still honor that arrow.
 await quick().fill('目标');await atEvent(30);await body().locator('p').filter({hasText:'正文 31'}).click();await next().click();await atEvent(60);await expect(quick()).toBeFocused();
});

test('Ctrl+F shares the query and options; quick blur also clears highlights while its window is open',async()=>{
 await quick().fill('目标');await atEvent(30);await app.evaluate(({Menu})=>{const item=Menu.getApplicationMenu()!.items.flatMap(group=>group.submenu?.items??[]).find(item=>item.accelerator==='CmdOrCtrl+F')!;item.click();});const search=await searchWindow(app);await expect(search.getByRole('textbox',{name:'搜索内容'})).toHaveValue('目标');
 await search.getByRole('textbox',{name:'搜索内容'}).fill('正文 61');await expect(quick()).toHaveValue('正文 61');await atEvent(60);
 await quick().click();await selectedAll();await body().locator('p').filter({hasText:'正文 61'}).click();await expect(body().locator('.search-match,.search-event')).toHaveCount(0);await expect(page.locator('.event-navigation [data-match]')).toHaveCount(0);
 await search.getByRole('textbox',{name:'搜索内容'}).click();await expect(body().locator('.search-match')).toHaveCount(1);await search.getByRole('button',{name:'关闭搜索',exact:true}).click();await expect(quick()).toHaveValue('');
});

test('Markdown quick search covers body text, keeps the outline and clears highlights on blur',async()=>{
 const md=path.join(root,'正文搜索.md');await fs.writeFile(md,'# 目录标题\n\n'+Array.from({length:100},(_,i)=>`第 ${i} 段${[35,70].includes(i)?' 目标':''}`).join('\n\n'));
 await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},md);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();const editor=page.locator('.markdown-document');await expect(editor).toBeVisible();
 await quick().fill('目标');await expect(editor.locator('.md-search-match')).toHaveCount(2);await expect(page.locator('.markdown-outline-heading')).toHaveCount(1);await expect(quick()).toBeFocused();
 const position=()=>editor.evaluate((el:any)=>el.editor.state.selection.from);await expect.poll(()=>page.locator('.document-scroller[data-active]').evaluate(el=>el.scrollTop)).toBeGreaterThan(500);const first=await position();await next().click();await expect.poll(position).toBeGreaterThan(first);await previous().click();await expect.poll(position).toBe(first);
 await quick().press('Tab');await expect(editor.locator('.md-search-match')).toHaveCount(0);await page.keyboard.press('Shift+Tab');await selectedAll();await expect(editor.locator('.md-search-match')).toHaveCount(2);
});
