import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,file:string;
const editor=()=>page.locator('.document-scroller:visible .todo-document');
function saved(){const db=new Database(file,{readonly:true});try{return db.prepare('select * from events order by pos').all() as any[];}finally{db.close();}}
async function open(html:string){
  file=path.join(root,'原始正文.tde');const store=new DocumentStore(),doc=store.open(file,true);
  await store.save({...doc,events:[{id:-1,pos:1024,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_html:html,content_text:'原始正文'}]});store.close(doc.handle);
  const before=await fs.readFile(file),mtime=(await fs.stat(file)).mtimeMs;
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();BrowserWindow.getAllWindows()[0].focus();});await expect(editor()).toBeVisible();return {before,mtime};
}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
for(const [tag,html] of [['ol','<ol start="3"><li>原始正文</li></ol>'],['blockquote','<blockquote><p>原始正文</p></blockquote>'],['pre','<pre>原始正文</pre>'],['h2','<h2 style="margin-top: 0px">原始正文</h2>']]){
  test(`browsing a document ending in ${tag} never changes its bytes; explicit Enter still works`,async()=>{
    const {before,mtime}=await open(html);await editor().locator(tag).click();
    await page.keyboard.press('Control+End');await page.keyboard.press('Control+a');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Control+End');
    await expect(editor().locator(':scope > p')).toHaveCount(0);
    // Observe beyond the autosave debounce to detect unintended writes.
    await page.waitForTimeout(900);expect(await fs.readFile(file)).toEqual(before);expect((await fs.stat(file)).mtimeMs).toBe(mtime);expect(saved()[0].content_html).toBe(html);
    await page.locator('.file-tab.active .tab-close').click();expect(await fs.readFile(file)).toEqual(before);
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(editor()).toBeVisible();await editor().locator(tag).click();await page.keyboard.press('Control+End');
    const count=tag==='pre'?3:tag==='h2'?1:2;for(let i=0;i<count;i++)await page.keyboard.press('Enter');await page.keyboard.type('outside');
    await expect(editor().locator(':scope > p')).toHaveText('outside');await expect(editor().locator(tag)).not.toContainText('outside');await expect.poll(()=>saved()[0].content_text).toContain('outside');
  });
}
test('metadata changes and saved body undo preserve the original HTML bytes',async()=>{
  const html='<p style="margin: 0px">原始正文 <b>bold</b></p>';await open(html);
  await editor().getByRole('button',{name:'标记完成',exact:true}).click();await expect.poll(()=>saved()[0].done).toBe(1);expect(saved()[0].content_html).toBe(html);
  await editor().locator('p').click();await page.keyboard.press('Control+End');await page.keyboard.type('edited');await expect.poll(()=>saved()[0].content_html).toContain('edited');await page.keyboard.press('Control+z');await expect.poll(()=>saved()[0].content_html).toBe(html);expect(saved()[0].done).toBe(1);
});
test('terminal divider supports end navigation, Enter, native text, undo and Backspace',async()=>{
  await open('<p>原始正文</p>');await editor().evaluate((el:any)=>{el.editor.commands.setContent({type:'doc',content:[{type:'divider',attrs:el.editor.state.doc.firstChild.attrs}]});el.editor.commands.focus();});
  await expect(editor()).toBeFocused();await page.keyboard.press('Control+a');expect(await editor().evaluate((el:any)=>el.editor.state.selection.toJSON().type)).toBe('all');await page.keyboard.press('ArrowRight');expect(await editor().evaluate((el:any)=>el.editor.state.selection.toJSON().type)).toBe('gapcursor');
  await page.keyboard.press('Enter');await page.keyboard.type('after');await expect(editor().locator('p')).toHaveText('after');await expect(editor().locator('.event-divider')).toHaveCount(1);
  await page.keyboard.press('Control+z');await expect(editor().locator('p')).toHaveText('');await page.keyboard.press('Control+z');await expect(editor().locator('p')).toHaveCount(0);
  await page.keyboard.press('Control+End');await page.keyboard.type('direct');await expect(editor().locator('p')).toHaveText('direct');await expect(editor().locator('.event-divider')).toHaveCount(1);await page.keyboard.press('Control+z');await expect(editor().locator('p')).toHaveCount(0);
  await page.keyboard.press('Control+End');await page.keyboard.press('Backspace');await expect(editor().locator('.event-divider')).toHaveCount(0);await page.keyboard.press('Control+z');await expect(editor().locator('.event-divider')).toHaveCount(1);
});
