import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import {execFileSync} from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
let app:ElectronApplication,page:Page,file:string,root:string;
const qtEnv={...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH};
const qt=(mode:string)=>execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),[mode,file],{env:qtEnv,windowsHide:true,encoding:'utf8'});
const editor=()=>page.locator('.document-scroller:visible .todo-document');
const body=()=>editor().locator(':scope > p');
const inspect=()=>JSON.parse(qt('inspect-format'));
function saved(){const db=new Database(file,{readonly:true});try{return db.prepare('select * from events order by pos').get() as any;}finally{db.close();}}
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'格式样本.tde');qt('create-format');const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{BrowserWindow.getAllWindows()[0].show();BrowserWindow.getAllWindows()[0].focus();});await expect(editor()).toBeVisible();});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
test('Qt geometry and superscripts remain editable and survive text editing and a Qt save',async({},info)=>{
  const before=inspect(),record=saved();await expect(editor().locator('.legacy-content')).toHaveCount(0);await expect(body().first()).toHaveCSS('text-align','center');await expect(body().first()).toHaveCSS('margin-left','92px');await expect(body().last()).toHaveCSS('line-height','28px');await expect(editor().locator('sup')).toHaveText('2');await expect(editor().locator('sub')).toHaveText('2');
  await body().first().click();await page.keyboard.press('Home');await page.keyboard.type('已改 ');await expect.poll(()=>saved().content_text).toContain('已改');const after=inspect();for(let i=0;i<before.length;i++){const {text,runs,...format}=before[i];expect(after[i]).toMatchObject(format);}for(const key of ['id','pos','created_at','done','deadline_raw','deadline_ts','top_divider'])expect(saved()[key]).toEqual(record[key]);
  await page.screenshot({path:info.outputPath('formatted-editor.png')});await page.locator('.file-tab.active .tab-close').click();qt('edit');await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await page.getByRole('button',{name:'打开文档 · Ctrl+O',exact:true}).click();await expect(editor()).toContainText('旧版再次编辑');await expect(editor().locator('.legacy-content')).toHaveCount(0);await expect(editor().locator('sup')).toHaveText('2');await expect(editor().locator('sub')).toHaveText('2');await expect(body().first()).toHaveCSS('margin-left','92px');
});
test('text size applies to the selection in the unit Qt reads and can be handed back to the canvas size',async()=>{
  await body().first().click();await page.keyboard.press('Home');
  for(let i=0;i<3;i++)await page.keyboard.press('Shift+ArrowRight');
  await page.getByRole('button',{name:'段落与字符格式',exact:true}).click();
  await page.getByRole('button',{name:'增大选中文字字号',exact:true}).click();
  await page.getByRole('button',{name:'增大选中文字字号',exact:true}).click();
  await expect.poll(()=>saved().content_html).toContain('font-size:');
  // Qt only reports a point size for runs whose format it actually applied.
  const runs=inspect()[0].runs as {text:string;fontSize:number}[];
  expect(runs[0].fontSize).toBeGreaterThan(9);
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();
  await page.getByRole('button',{name:'应用到全部',exact:true}).click();
  await expect.poll(()=>saved().content_html).not.toContain('font-size:');
  await page.locator('.todo-document p').first().click();await page.keyboard.press('Control+z');
  await expect.poll(()=>saved().content_html).toContain('font-size:');
});

test('format controls update selected paragraphs in one undo and stay inside a narrow workbench',async({},info)=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,680));await editor().evaluate((el:any)=>{const ed=el.editor;const positions:number[]=[];ed.state.doc.forEach((n:any,p:number)=>{if(n.type.name==='paragraph')positions.push(p);});ed.commands.setTextSelection({from:positions[0]+1,to:positions[1]+ed.state.doc.nodeAt(positions[1]).nodeSize-1});});
  await page.getByRole('button',{name:'段落与字符格式',exact:true}).click();await expect(page.locator('.format-menu .format-row').first().locator('button.active')).toHaveCount(0);await page.getByRole('button',{name:'左对齐',exact:true}).click();await expect(body().nth(0)).toHaveCSS('text-align','left');await expect(body().nth(1)).toHaveCSS('text-align','left');await page.keyboard.press('Control+z');await expect(body().nth(0)).toHaveCSS('text-align','center');await expect(body().nth(1)).toHaveCSS('text-align','right');
  await page.getByRole('button',{name:'增加缩进',exact:true}).click();await expect(body().first()).toHaveCSS('margin-left','132px');await page.keyboard.press('Control+z');await expect(body().first()).toHaveCSS('margin-left','92px');
  const box=await page.locator('.format-menu').boundingBox(),width=await page.evaluate(()=>innerWidth);const header=await page.locator('.toolbar').evaluate(el=>el.getBoundingClientRect().bottom);expect(box!.x).toBeGreaterThanOrEqual(0);expect(box!.y).toBeGreaterThanOrEqual(header-1);expect(box!.x+box!.width).toBeLessThanOrEqual(width);await page.screenshot({path:info.outputPath('format-menu.png')});await page.keyboard.press('Escape');await expect(editor()).toBeFocused();
});
test('superscript and subscript are mutually exclusive and export preserves their placement',async({},info)=>{
  await editor().evaluate((el:any)=>{const ed=el.editor;ed.commands.setTextSelection({from:5,to:6});});await page.getByRole('button',{name:'段落与字符格式',exact:true}).click();await page.getByRole('button',{name:'上标',exact:true}).click();await expect(editor().locator('sup').first()).toContainText('x');await page.getByRole('button',{name:'下标',exact:true}).click();await expect(editor().locator('sub').first()).toContainText('x');await expect(editor().locator('sup sub,sub sup')).toHaveCount(0);await page.keyboard.press('Control+z');await page.keyboard.press('Control+z');await page.keyboard.press('Escape');
  for(const [extension,label] of [['md','Markdown .md'],['txt','纯文本 .txt'],['pdf','PDF 文档 .pdf']] as const){const out=path.join(root,'格式导出.'+extension);await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},out);await page.getByRole('button',{name:'导出',exact:true}).click();await page.getByRole('button',{name:label,exact:true}).click();await expect.poll(async()=>fs.stat(out).then(x=>x.size,()=>0)).toBeGreaterThan(50);await expect(page.getByRole('dialog',{name:'导出完成'})).toContainText('格式导出.'+extension);await page.getByRole('button',{name:'知道了',exact:true}).click();if(extension==='md')expect(await fs.readFile(out,'utf8')).toContain('x<sup>2</sup>');if(extension==='txt')expect(await fs.readFile(out,'utf8')).toContain('面积 x2 与 H2O');}
});
