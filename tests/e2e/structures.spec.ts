import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,file:string;
const editor=()=>page.locator('.document-scroller:visible .todo-document');
function saved(){const db=new Database(file,{readonly:true});try{return db.prepare('select content_html,content_text from events order by pos').all() as {content_html:string;content_text:string}[];}finally{db.close();}}
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'引用与代码.tde');const store=new DocumentStore(),doc=store.open(file,true);
  await store.save({...doc,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_html:'<p>引用正文</p><p>代码正文</p><p>literal</p>',content_text:'引用正文\n代码正文\nliteral'}]});store.close(doc.handle);
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();BrowserWindow.getAllWindows()[0].focus();});await expect(editor()).toBeVisible();
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function format(label:string){await page.getByRole('button',{name:'段落与字符格式',exact:true}).click();await page.getByRole('button',{name:label,exact:true}).click();await page.keyboard.press('Escape');}
test('format controls create editable structures, undo once and preserve them after reopening',async({},info)=>{
  await editor().locator('p').first().click();await format('引用');await expect(editor().locator('blockquote')).toHaveText('引用正文');await page.keyboard.press('Control+z');await expect(editor().locator('blockquote')).toHaveCount(0);await page.keyboard.press('Control+y');await expect(editor().locator('blockquote')).toHaveCount(1);
  await editor().locator('p').filter({hasText:'代码正文'}).click();await format('代码块');await expect(editor().locator('pre')).toHaveText('代码正文');await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.type('  https://example.com');await page.keyboard.press('Space');await expect(editor().locator('pre a')).toHaveCount(0);
  await editor().locator('p').filter({hasText:'literal'}).click();await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await format('行内代码');await expect(editor().locator('p code')).toHaveText('literal');await expect.poll(()=>saved()[0].content_html).toContain('<code');await expect.poll(()=>saved()[0].content_html).toContain('<blockquote');await expect.poll(()=>saved()[0].content_html).toContain('<pre');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,680));await page.getByRole('button',{name:'段落与字符格式',exact:true}).click();const box=await page.locator('.format-menu').boundingBox();expect(box!.y+box!.height).toBeLessThanOrEqual(await page.evaluate(()=>innerHeight));await page.screenshot({path:info.outputPath('structures-menu.png')});await page.keyboard.press('Escape');
  await page.locator('.file-tab.active .tab-close').click();await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(editor().locator('blockquote')).toHaveText('引用正文');await expect(editor().locator('pre')).toContainText('  https://example.com');await expect(editor().locator('p code')).toHaveText('literal');await expect(editor().locator('.legacy-content')).toHaveCount(0);
});
test('Home and End follow code lines including a leading empty line; Enter exits at the end',async()=>{
  await editor().evaluate((el:any)=>{el.editor.commands.setContent({type:'doc',content:[{type:'codeBlock',content:[{type:'text',text:'\n  first\n  last'}]}]});el.editor.commands.focus();el.editor.commands.setTextSelection(1);});
  await expect(editor()).toBeFocused();
  const offset=()=>editor().evaluate((el:any)=>el.editor.state.selection.$from.parentOffset);
  await page.keyboard.press('Home');expect(await offset()).toBe(0);await page.keyboard.press('ArrowDown');await page.keyboard.press('End');expect(await offset()).toBe(8);await page.keyboard.press('Home');expect(await offset()).toBe(1);await page.keyboard.press('Shift+End');await page.keyboard.type('changed');await expect(editor().locator('pre')).toHaveText('\nchanged\n  last');
  await editor().evaluate((el:any)=>el.editor.commands.setTextSelection(el.editor.state.doc.firstChild.nodeSize-1));await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.press('Enter');await page.keyboard.type('outside');await expect(editor().locator('p').filter({hasText:'outside'})).toHaveText('outside');await expect(editor().locator('pre')).not.toContainText('outside');
});
test('three exports preserve literal code and PDF completes with Chinese, long lines and pagination',async()=>{
  const code='  const text = `中文 < &`;\n\n'+('long_identifier_'.repeat(35))+'\n'+Array.from({length:75},(_,i)=>`  第 ${i+1} 行`).join('\n');
  await editor().evaluate((el:any,code)=>el.editor.commands.setContent({type:'doc',content:[{type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'引用中文'}]}]},{type:'codeBlock',attrs:{language:'typescript'},content:[{type:'text',text:code}]},{type:'paragraph',content:[{type:'text',text:'a < b & `x`',marks:[{type:'code'}]}]}]}),code);
  await expect.poll(()=>saved()[0].content_html).toContain('<pre');
  for(const [ext,label] of [['md','Markdown .md'],['txt','纯文本 .txt'],['pdf','PDF 文档 .pdf']] as const){const out=path.join(root,'结构导出.'+ext);await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},out);await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:label,exact:true}).click();await expect.poll(async()=>fs.stat(out).then(s=>s.size,()=>0)).toBeGreaterThan(50);await expect(page.getByRole('dialog',{name:'导出完成'})).toContainText('结构导出.'+ext);await page.getByRole('button',{name:'知道了',exact:true}).click();if(ext==='md'){const text=await fs.readFile(out,'utf8');expect(text).toContain('> 引用中文');expect(text).toContain('```typescript\n'+code);expect(text).toContain('`` a < b & `x` ``');}if(ext==='txt')expect(await fs.readFile(out,'utf8')).toContain(code);}
});
test('native multiline paste stays inside code and undoes independently',async()=>{
  await editor().evaluate((el:any)=>{el.editor.commands.setContent({type:'doc',content:[{type:'codeBlock',content:[{type:'text',text:'beforeafter'}]}]});el.editor.commands.setTextSelection(7);el.editor.commands.focus();});await expect(editor()).toBeFocused();
  await app.evaluate(({clipboard})=>clipboard.writeText('  one\r\n\r\n  <two>'));await page.keyboard.press('Control+v');await expect(editor().locator('pre')).toHaveText('before  one\n\n  <two>after');await page.keyboard.press('Control+z');await expect(editor().locator('pre')).toHaveText('beforeafter');await page.keyboard.press('Control+y');await expect(editor().locator('pre')).toHaveText('before  one\n\n  <two>after');await expect.poll(()=>saved()[0].content_text).toContain('before  one\n\n  <two>after');
});
