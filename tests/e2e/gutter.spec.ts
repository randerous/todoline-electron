import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,file:string;
const editor=()=>page.locator('.document-scroller:visible .todo-document');
const labels=()=>page.locator('.document-scroller:visible .line-label');
const line=(n:number)=>labels().filter({has:page.locator('span',{hasText:new RegExp(`^${n}$`)})});
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});file=path.join(root,'行号与缩进.tde');
  const store=new DocumentStore(),doc=store.open(file,true);
  const contents=['<p style="margin-left:80px" align="center">缩进居中段落</p><p>'+('自动换行正文，'.repeat(30))+'</p><ol><li>列表一<ul><li>嵌套列表</li></ul></li><li>列表二</li></ol><p></p>','<h2>第二个事件标题</h2><p>最后一段</p>'];
  await store.save({...doc,events:contents.map((html,i)=>({id:-(i+1),pos:i*1024,created_at:1750000000+i*60,deadline_raw:'',deadline_ts:null,done:0,top_divider:i===0?1:0,content_html:html,content_text:'行号样本'}))});store.close(doc.handle);
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  const executablePath=process.env.TODOLINE_TEST_EXE;
  app=await _electron.launch({...(executablePath?{executablePath}:{}),args:[...(executablePath?[]:[path.resolve('.')]),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{const w=BrowserWindow.getAllWindows()[0];w.show();w.focus();});await expect(editor()).toBeVisible();
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('global gutter includes dividers, nested lists and empty paragraphs without following indentation',async({},info)=>{
  await expect(labels()).toHaveCount(10);expect(await labels().locator('span').allTextContents()).toEqual(Array.from({length:10},(_,i)=>String(i+1)));
  const boxes=await labels().evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().x));expect(Math.max(...boxes)-Math.min(...boxes)).toBeLessThan(.5);
  const expected=await editor().evaluate((el:any)=>{const ed=el.editor,rows:number[]=[];ed.state.doc.descendants((n:any,p:number)=>{if(n.isTextblock||n.type.name==='divider'){rows.push((ed.view.nodeDOM(p) as Element).getBoundingClientRect().top);return false;}});return rows;});
  const tops=await labels().evaluateAll(nodes=>nodes.map(n=>n.getBoundingClientRect().top));for(let i=0;i<tops.length;i++)expect(Math.abs(tops[i]-expected[i])).toBeLessThan(.6);
  await expect(editor().locator('.legacy-content')).toHaveCount(0);await page.screenshot({path:info.outputPath('gutter-dark.png')});
  await page.getByRole('button',{name:'外观与设置',exact:true}).click();await page.getByText('显示行号',{exact:true}).locator('input').uncheck();await expect(labels()).toHaveCount(0);await page.getByText('显示行号',{exact:true}).locator('input').check();await expect(labels()).toHaveCount(10);await page.keyboard.press('Escape');
});

test('gutter range and additive drag include nested and empty rows, delete and undo as one change',async()=>{
  await line(4).click();await line(6).click({modifiers:['Shift']});await expect(labels()).toHaveCount(10);
  await expect(page.locator('.line-label.selected')).toHaveCount(3);await page.keyboard.press('Delete');await expect(editor()).not.toContainText('列表一');await expect(editor()).not.toContainText('列表二');await page.keyboard.press('Control+z');await expect(editor()).toContainText('嵌套列表');
  await line(2).click();await line(7).click({modifiers:['Control']});await expect(page.locator('.line-label.selected')).toHaveCount(2);await page.keyboard.press('Delete');await expect(editor()).not.toContainText('缩进居中段落');await page.keyboard.press('Control+z');await expect(editor()).toContainText('缩进居中段落');
  await expect(line(4)).toBeVisible();await expect(line(6)).toBeVisible();const a=await line(4).boundingBox(),b=await line(6).boundingBox();await page.mouse.move(a!.x+8,a!.y+8);await page.mouse.down();await page.mouse.move(b!.x+8,b!.y+8,{steps:10});await page.mouse.up();await expect(page.locator('.line-label.selected')).toHaveCount(3);
  await line(1).click();await expect(editor().locator('.selected-event')).toHaveCount(1);await expect(editor().locator('.row-selection')).toHaveCount(0);await page.keyboard.press('ArrowLeft');await page.keyboard.press('Delete');await expect(editor().locator('.event-divider')).toHaveCount(1);await page.keyboard.press('Control+z');await expect(editor().locator('.event-divider')).toHaveCount(2);
});

test('clicking paragraph trailing blank space places the cursor in that paragraph',async()=>{
  const p=editor().locator('p').first();await editor().click();await page.keyboard.press('Control+End');await p.scrollIntoViewIfNeeded();const box=await p.boundingBox();await p.click({position:{x:box!.width-6,y:8}});
  await expect.poll(()=>editor().evaluate((el:any)=>el.editor.state.selection.$from.parent.textContent)).toBe('缩进居中段落');await page.keyboard.press('Home');await page.keyboard.type('定位正确');await expect(p).toContainText('定位正确缩进居中段落');
});

test('gutter culls labels only and restores them when changing tabs and scrolling',async()=>{
  await editor().evaluate((el:any)=>{const ed=el.editor;ed.commands.setContent({type:'doc',content:Array.from({length:5000},(_,i)=>({type:'paragraph',content:[{type:'text',text:'固定行 '+i}]}))});ed.commands.setTextSelection({from:1,to:4});});
  await expect(editor().locator('p')).toHaveCount(5000);await expect.poll(()=>labels().count()).toBeLessThan(80);await expect(line(1)).toBeVisible();const rootHandle=await editor().elementHandle();
  await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect(page.locator('.file-tab')).toHaveCount(2);await page.locator('.tab-name').first().click();await expect(page.locator('.file-tab').first()).toHaveClass(/active/);expect(await rootHandle!.evaluate(el=>el.isConnected)).toBe(true);await expect(line(1)).toBeVisible();
  await page.locator('.document-scroller:visible').evaluate(el=>{el.scrollTop=el.scrollHeight;});await expect(line(5000)).toBeVisible();await expect.poll(()=>labels().count()).toBeLessThan(80);await expect(editor().locator('p')).toHaveCount(5000);
});

test('Ctrl dragging adds traversed rows and dragging beyond the viewport scrolls the gutter',async()=>{
  await editor().evaluate((el:any)=>el.editor.commands.setContent({type:'doc',content:Array.from({length:200},(_,i)=>({type:'paragraph',content:[{type:'text',text:'拖动行 '+i}]}))}));
  await line(1).click();await expect(line(3)).toBeVisible();const a=await line(3).boundingBox(),b=await line(6).boundingBox();
  await page.keyboard.down('Control');await page.mouse.move(a!.x+10,a!.y+8);await page.mouse.down();await page.mouse.move(b!.x+10,b!.y+8,{steps:12});await page.mouse.up();await page.keyboard.up('Control');await expect(page.locator('.line-label.selected')).toHaveCount(5);
  const viewport=await page.locator('.document-scroller:visible').boundingBox(),start=await line(3).boundingBox();await page.mouse.move(start!.x+10,start!.y+8);await page.mouse.down();await page.mouse.move(start!.x+10,viewport!.y+viewport!.height+16,{steps:12});
  await expect.poll(()=>page.locator('.document-scroller:visible').evaluate(el=>el.scrollTop)).toBeGreaterThan(100);await page.mouse.up();const scroll=await page.locator('.document-scroller:visible').evaluate(el=>el.scrollTop);await page.waitForTimeout(80);expect(await page.locator('.document-scroller:visible').evaluate(el=>el.scrollTop)).toBe(scroll);
  await page.keyboard.press('Delete');await expect.poll(()=>editor().locator('p').count()).toBeLessThan(190);await page.keyboard.press('Control+z');await expect(editor().locator('p')).toHaveCount(200);
});

test('visible line buttons retain their DOM identity during selection, editing and undo',async()=>{
  await expect(line(2)).toBeVisible();const button=await line(2).elementHandle();await line(2).click();await line(4).click({modifiers:['Control']});
  expect(await button!.evaluate(el=>el.isConnected)).toBe(true);await page.keyboard.press('Escape');await editor().locator('p').first().click();await page.keyboard.press('End');await page.keyboard.type(' continued');
  await expect(editor().locator('p').first()).toContainText('continued');expect(await button!.evaluate(el=>el.isConnected)).toBe(true);await page.keyboard.press('Control+z');await expect(editor().locator('p').first()).not.toContainText('continued');expect(await button!.evaluate(el=>el.isConnected)).toBe(true);
});

test('ordinary click synchronization preserves native double-click and Shift selection',async()=>{
  await editor().evaluate((el:any)=>el.editor.commands.setContent({type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'alpha beta gamma'}]}]}));
  const point=async(from:number,to:number)=>editor().locator('p').evaluate((el,args)=>{const range=document.createRange();range.setStart(el.firstChild!,args[0]);range.setEnd(el.firstChild!,args[1]);const r=range.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};},[from,to]);
  const beta=await point(6,10);await page.mouse.dblclick(beta.x,beta.y);await expect.poll(()=>editor().evaluate((el:any)=>el.editor.state.doc.textBetween(el.editor.state.selection.from,el.editor.state.selection.to).trim())).toBe('beta');
  await page.keyboard.press('Control+b');await expect(editor().locator('strong')).toHaveText('beta');await page.keyboard.press('ArrowLeft');await page.keyboard.press('Home');
  const box=await editor().locator('p').boundingBox();await editor().locator('p').click({position:{x:box!.width-6,y:8},modifiers:['Shift']});
  await expect.poll(()=>editor().evaluate((el:any)=>el.editor.state.doc.textBetween(el.editor.state.selection.from,el.editor.state.selection.to))).toBe('alpha beta gamma');
});
