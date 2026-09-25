import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DocumentStore} from '../../src/main/storage';
import {searchWindow} from './search-window';
let app:ElectronApplication,page:Page,root:string,ids:number[];
const rows=()=>page.locator('.event-navigation .outline-item');
const current=()=>page.locator('.event-navigation .outline-item[data-visible]');
const scroller=()=>page.locator('.document-scroller[data-active]');
async function scrollToEvent(index:number,offset=0){await page.locator('.todo-document').evaluate((el:any,{id,offset})=>{const scroller=el.closest('.document-scroller'),node=el.querySelector(`[data-id="${id}"]`)??el;scroller.scrollTop+=node.getBoundingClientRect().top-scroller.getBoundingClientRect().top+offset;},{id:ids[index],offset});}
async function expectedVisible(){return page.locator('.todo-document').evaluate((el:HTMLElement,ids:number[])=>{const root=el.closest('.document-scroller')!,viewport=root.getBoundingClientRect(),dividers=Array.from(el.querySelectorAll<HTMLElement>(':scope > .event-divider')),starts=[el.firstElementChild!.getBoundingClientRect().top,...dividers.map(d=>d.getBoundingClientRect().top)],end=el.lastElementChild!.getBoundingClientRect().bottom;return ids.filter((_,i)=>starts[i]<viewport.bottom&&(starts[i+1]??end)>viewport.top);},ids);}
test.beforeEach(async({},info)=>{
 root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});const file=path.join(root,'导航测试.tde'),store=new DocumentStore(),doc=store.open(file,true);
 const events=Array.from({length:180},(_,i)=>{const text=`事件 ${i+1}`+(i%3===0?' 金色匹配':'');return {id:-i-1,pos:i*1024,created_at:1700000000+i,deadline_raw:'',deadline_ts:null,done:i%4===0?1:0,top_divider:0,content_text:text+(i===0?' 长事件':'') ,content_html:i===0?`<p>${text}</p>`+Array.from({length:45},(_,j)=>`<p>长事件正文 ${j+1}</p>`).join(''):`<p>${text}</p>`};});
 await store.save({handle:doc.handle,revision:doc.revision,events});ids=store.snapshots()[0].events.map(e=>e.id);store.close(doc.handle);
 const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=process.env.TODOLINE_TEST_EXE;app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.todo-document')).toBeVisible();await expect(rows().first()).toBeVisible();
});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
test('all viewport events are highlighted including long bodies with their divider above view',async()=>{
 await expect(current()).toHaveCount(1);await expect(current()).toHaveAttribute('data-event-id',String(ids[0]));
 await scroller().evaluate(el=>el.scrollTop=400);const middle=await expectedVisible();expect(middle).toContain(ids[0]);await expect.poll(()=>current().evaluateAll(rows=>rows.map(el=>Number((el as HTMLElement).dataset.eventId)))).toEqual(middle);
 await scrollToEvent(1,-80);const expected=await expectedVisible();expect(expected.length).toBeGreaterThan(2);
 await expect.poll(()=>current().evaluateAll(rows=>rows.map(el=>Number((el as HTMLElement).dataset.eventId)))).toEqual(expected);
 await expect(current().first()).toHaveAttribute('aria-current','location');
});
test('navigation follows distant body events while rendering only a small window of the full list',async({},info)=>{
 await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;main.show();main.focus();});
 await expect(current().first()).toBeVisible();
 const samples:number[]=[];
 for(const index of [150,20,130,40,150]){
  await page.evaluate(()=>new Promise<void>(resolve=>requestAnimationFrame(()=>requestAnimationFrame(()=>resolve()))));
  samples.push(await page.evaluate(id=>new Promise<number>((resolve,reject)=>{
   const nav=document.querySelector('.event-navigation')!,scroller=document.querySelector('.document-scroller[data-active]')!,target=scroller.querySelector(`[data-id="${id}"]`)!;
   const start=performance.now(),watch=new MutationObserver(()=>{if(nav.querySelector(`[data-event-id="${id}"][data-visible]`)){clearTimeout(timer);watch.disconnect();resolve(performance.now()-start);}});
   const timer=setTimeout(()=>{watch.disconnect();reject(new Error('Navigation did not follow scroll'));},5000);
   watch.observe(nav,{subtree:true,childList:true,attributes:true,attributeFilter:['data-visible']});scroller.scrollTop+=target.getBoundingClientRect().top-scroller.getBoundingClientRect().top;
  }),ids[index]));
 }
 await fs.writeFile(info.outputPath('navigation-performance.json'),JSON.stringify({events:180,scrollToHighlightMs:samples,renderedRows:await rows().count()}));

await expect(page.locator(`.event-navigation [data-event-id="${ids[150]}"][data-visible]`)).toBeVisible();
 expect(await rows().count()).toBeLessThan(45);await expect(page.locator('.sidebar-section b')).toHaveText('180');
 const before=await page.locator('.event-navigation').evaluate(el=>el.scrollTop);expect(before).toBeGreaterThan(3000);
 await page.locator('.event-navigation').evaluate(el=>el.scrollTop=0);await expect(rows().first()).toHaveAttribute('data-event-id',String(ids[0]));
 // Manual browsing of the navigation must not continuously snap back to the body.
 await page.waitForTimeout(250);expect(await page.locator('.event-navigation').evaluate(el=>el.scrollTop)).toBe(0);
 await scrollToEvent(2);await expect(page.locator(`.event-navigation [data-event-id="${ids[2]}"][data-visible]`)).toBeVisible();
});
test('search keeps the complete navigation and uses stronger gold for visible matches',async()=>{
 await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();const search=await searchWindow(app);await search.getByRole('textbox',{name:'搜索内容'}).fill('金色匹配');await expect(search.locator('.search-count')).toHaveText('60 个事件');
 await expect(page.locator('.event-navigation-rows')).toHaveCSS('height','5760px');
 const visibleMatch=page.locator(`.event-navigation [data-event-id="${ids[0]}"]`),offscreenMatch=page.locator(`.event-navigation [data-event-id="${ids[3]}"]`),ordinary=page.locator(`.event-navigation [data-event-id="${ids[1]}"]`);
 await expect(visibleMatch).toHaveAttribute('data-match','');await expect(visibleMatch).toHaveAttribute('data-visible','');await expect(offscreenMatch).toHaveAttribute('data-match','');await expect(offscreenMatch).not.toHaveAttribute('data-visible','');await expect(ordinary).not.toHaveAttribute('data-match','');
 const colors=await page.locator('.event-navigation').evaluate(el=>({current:getComputedStyle(el.querySelector('.search-hit.in-view')!).backgroundColor,match:getComputedStyle(el.querySelector('.search-hit:not(.in-view)')!).backgroundColor,normal:getComputedStyle(el.querySelector('.outline-item:not(.search-hit):not(.in-view)')!).backgroundColor}));expect(new Set(Object.values(colors)).size).toBe(3);
 await ordinary.click();await expect(ordinary).toHaveAttribute('data-visible','');await expect(page.locator('.event-navigation-rows')).toHaveCSS('height','5760px');
 await search.getByRole('textbox',{name:'搜索内容'}).fill('不存在的内容');await expect(search.locator('.search-count')).toHaveText('0 个事件');await expect(page.locator('.event-navigation [data-match]')).toHaveCount(0);await expect(rows().first()).toBeVisible();await expect(page.locator('.event-navigation-rows')).toHaveCSS('height','5760px');
 await search.getByRole('button',{name:'关闭搜索',exact:true}).click();await expect(current().first()).toBeVisible();
});
test('visible IDs stay synchronized through a new divider, autosave, undo and switching tabs',async()=>{
 await scrollToEvent(2);await page.locator('.todo-document p').filter({hasText:/^事件 3$/}).click();await page.keyboard.press('End');await page.locator('.divider-tool').click();await page.keyboard.type('新增事件');
 const added=page.locator('.event-navigation .outline-item').filter({hasText:'新增事件'});await expect(added).toHaveAttribute('data-visible','');await expect.poll(async()=>Number(await added.getAttribute('data-event-id'))).toBeGreaterThan(0);
 await page.keyboard.press('Control+z');await expect(page.locator('.sidebar-section b')).toHaveText('181');
 await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(2);await expect(current()).toHaveCount(1);await expect(current()).toContainText('空白事件');
 await page.locator('.file-tab').first().click();await expect(page.locator('.sidebar-section b')).toHaveText('181');await expect(current().first()).toBeVisible();
 await page.getByRole('button',{name:'切换导航',exact:true}).click();await expect(page.locator('.event-navigation')).toHaveCount(0);await page.getByRole('button',{name:'切换导航',exact:true}).click();await expect(current().first()).toBeVisible();
});

test('gold and viewport highlights remain distinct across dark, light and green themes',async({},info)=>{
 await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;main.show();main.focus();});
 await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();const search=await searchWindow(app);await search.getByRole('textbox',{name:'搜索内容'}).fill('金色匹配');await expect(search.locator('.search-count')).toHaveText('60 个事件');
 for(const [name,theme] of [['深色','dark'],['浅色','light'],['绿色','green']]){
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByRole('button',{name,exact:true}).click();await page.keyboard.press('Escape');await expect(page.locator('html')).toHaveAttribute('data-theme',theme);
  await expect(page.locator('.event-navigation .search-hit.in-view')).toHaveCount(1);
  await page.locator('.sidebar').screenshot({path:info.outputPath(`navigation-${theme}.png`),timeout:5000});
 }
});
