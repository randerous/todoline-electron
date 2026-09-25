import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DocumentStore} from '../../src/main/storage';

let app:ElectronApplication,page:Page,root:string,files:string[];
const long='中文配置 data=1234 '.repeat(80);
const body=()=>page.locator('.document-scroller[data-active] .ProseMirror');
const toggle=()=>page.getByRole('button',{name:'自动换行',exact:true});
async function launch(){
 const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
 const executablePath=process.env.TODOLINE_TEST_EXE;
 app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),...files],env:env as Record<string,string>});page=await app.firstWindow();await expect(body()).toBeVisible();
}
test.beforeEach(async({},info)=>{
 root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});files=['事件.tde','文档.md','配置.cfg'].map(name=>path.join(root,name));
 const store=new DocumentStore(),doc=store.open(files[0],true);
 await store.save({...doc,events:[{id:-1,pos:0,created_at:1700000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_text:long,content_html:`<p>${long}</p>`}]});store.close(doc.handle);
 await fs.writeFile(files[1],long+'\n\n```text\n'+long+'\n```\n');await fs.writeFile(files[2],long+'\r\n');await launch();
});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('toolbar wraps all document modes without editing content or losing selection',async()=>{
 const originals=await Promise.all(files.map(file=>fs.readFile(file)));
 for(let i=0;i<files.length;i++){
  await page.locator('.file-tab').nth(i).locator('.tab-name').click();await expect(body()).toBeVisible();await expect(toggle()).toHaveAttribute('aria-pressed','true');
  const paragraph=body().locator('p').first(),wrapped=await paragraph.evaluate(el=>el.getBoundingClientRect().height);
  await body().evaluate((el:any)=>{el.editor.commands.setTextSelection({from:el.editor.state.doc.firstChild.type.name==='divider'?2:1,to:el.editor.state.doc.firstChild.type.name==='divider'?5:4});});
  const selection=await body().evaluate((el:any)=>el.editor.state.selection.toJSON());
  await toggle().click();await expect(toggle()).toHaveAttribute('aria-pressed','false');await expect(paragraph).toHaveCSS('white-space','pre');
  expect(await paragraph.evaluate(el=>el.getBoundingClientRect().height)).toBeLessThan(wrapped);
  expect(await body().evaluate((el:any)=>el.editor.state.selection.toJSON())).toEqual(selection);
  const scroller=page.locator('.document-scroller[data-active]');expect(await scroller.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeGreaterThan(100);
  await scroller.evaluate(el=>el.scrollLeft=200);expect(await scroller.evaluate(el=>el.scrollLeft)).toBe(200);
  await toggle().click();await expect(paragraph).toHaveCSS('white-space',/^(pre-wrap|break-spaces)$/);expect(await paragraph.evaluate(el=>el.getBoundingClientRect().height)).toBe(wrapped);
  if(i===1)await expect(body().locator('pre')).toHaveCSS('white-space','pre-wrap');
 }
 for(let i=0;i<files.length;i++)expect(await fs.readFile(files[i])).toEqual(originals[i]);
});

test('wrap preference is shared across tabs and restored after restarting',async()=>{
 await toggle().click();await page.locator('.file-tab').nth(1).locator('.tab-name').click();await expect(toggle()).toHaveAttribute('aria-pressed','false');await expect(body().locator('p').first()).toHaveCSS('white-space','pre');
 await expect.poll(async()=>JSON.parse(await fs.readFile(path.join(root,'profile','session.json'),'utf8')).settings.wordWrap).toBe(false);
 await app.evaluate(({app})=>app.exit(0));await launch();await expect(toggle()).toHaveAttribute('aria-pressed','false');await expect(body().locator('p').first()).toHaveCSS('white-space','pre');
 await toggle().click();await expect(body().locator('p').first()).toHaveCSS('white-space','pre-wrap');
});
