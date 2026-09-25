import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import Database from 'better-sqlite3';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,file:string,profile:string,env:Record<string,string>;
test.beforeEach(async({},info)=>{
  const root=info.outputPath('workspace');profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});file=path.join(root,'右键验证.tde');
  const store=new DocumentStore(),doc=store.open(file,true),html=['<p>首个事件 Alpha</p>','<ol start="7"><li>有序一</li><li>有序二</li><li>有序三</li></ol>','<p><a href="https://example.com/path">已识别的链接</a> 后文 Alpha</p>'];
  await store.save({...doc,events:html.map((content_html,i)=>({id:-i-1,pos:i*1024,created_at:1750000000+i,deadline_raw:i===2?'明天':'',deadline_ts:null,done:i===2?1:0,top_divider:0,content_html,content_text:content_html.replace(/<[^>]*>/g,'')}))});store.close(doc.handle);
  const values:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete values.ELECTRON_RUN_AS_NODE;env=values as Record<string,string>;await launch();
});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function launch(){const exe=process.env.TODOLINE_TEST_EXE;app=await _electron.launch(exe?{executablePath:exe,args:['--open',file],env}:{args:[path.resolve('.'),'--open',file],env});page=await app.firstWindow();await expect(page.locator('.todo-document')).toBeVisible();}
test('recognized links expose open action and Control changes the pointer',async()=>{
  await app.evaluate(({shell})=>{shell.openExternal=async url=>{(globalThis as any).lastOpenedLink=url;};});
  const link=page.locator('.todo-document a');await link.hover();await page.keyboard.down('Control');await expect(link).toHaveCSS('cursor','pointer');await page.keyboard.up('Control');await expect(link).not.toHaveCSS('cursor','pointer');
  await link.click({button:'right'});await page.getByRole('menuitem',{name:'打开链接',exact:true}).click();await expect.poll(()=>app.evaluate(()=>(globalThis as any).lastOpenedLink)).toBe('https://example.com/path');
});
test('restart and continue numbering share a row and can be undone',async()=>{
  await page.locator('.todo-document li p').nth(1).click({button:'right'});const restart=page.getByRole('menuitem',{name:'重新编号',exact:true});await expect(restart).toBeVisible();
  expect((await restart.boundingBox())!.y).toBe((await page.getByRole('menuitem',{name:'继续编号',exact:true}).boundingBox())!.y);
  await restart.click();await expect(page.locator('.todo-document ol')).toHaveCount(2);expect(await page.locator('.todo-document ol').last().evaluate((el:HTMLOListElement)=>el.start)).toBe(1);
  await page.keyboard.press('Control+z');await expect(page.locator('.todo-document ol')).toHaveCount(1);await expect(page.locator('.todo-document ol')).toHaveAttribute('start','7');
});
test('move event to top persists metadata and undo restores its place',async()=>{
  const before=new Database(file,{readonly:true});const original=before.prepare('select * from events order by pos').all() as any[];before.close();
  await page.locator('.todo-document a').click({button:'right'});await page.getByRole('menuitem',{name:/^置顶事件/}).click();await expect(page.locator('.todo-document p').first()).toContainText('已识别的链接');
  const saved=()=>{const db=new Database(file,{readonly:true});try{return db.prepare('select * from events order by pos').all() as any[];}finally{db.close();}};
  await expect.poll(()=>saved()[0].id).toBe(original[2].id);expect(saved()[0]).toMatchObject({done:1,deadline_raw:'明天',content_html:original[2].content_html});
  await page.keyboard.press('Control+z');await expect.poll(()=>saved().map(e=>e.id)).toEqual(original.map(e=>e.id));
});
test('search stays usable outside the main window and closes independently',async({},info)=>{
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();
  await expect.poll(()=>app.windows().length).toBe(2);const search=app.windows().find(p=>p!==page)!;
  await expect(search.getByRole('textbox',{name:'搜索内容'})).toBeVisible();await search.getByRole('textbox',{name:'搜索内容'}).fill('Alpha');await expect(search.locator('.search-count')).toHaveText('2 个事件');await expect(page.locator('.search-match')).toHaveCount(2);
  const geometry=await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!,popup=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='about:blank')!;const b=main.getBounds();popup.setPosition(b.x+b.width-20,b.y+80);return {main:b,popup:popup.getBounds()};});expect(geometry.popup.x+geometry.popup.width).toBeGreaterThan(geometry.main.x+geometry.main.width);
  await app.evaluate(({BrowserWindow})=>{for(const w of BrowserWindow.getAllWindows())w.show();});await search.screenshot({path:info.outputPath('search-outside.png')});await expect(search.getByRole('button',{name:'关闭搜索',exact:true})).toBeVisible();await search.getByRole('button',{name:'下一个搜索结果'}).click();await expect(search.locator('.search-count')).toHaveText('2 个事件');
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.hide());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='about:blank')!.isVisible())).toBe(false);await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.show());await expect.poll(()=>app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='about:blank')!.isVisible())).toBe(true);
  await search.getByRole('button',{name:'关闭搜索',exact:true}).click();await expect.poll(()=>app.windows().length).toBe(1);await expect(page.locator('.search-match')).toHaveCount(0);
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();await expect.poll(()=>app.windows().length).toBe(2);
});

test('Ctrl+T moves the caret event to the top through the native shortcut and undo restores it',async()=>{
 await page.locator('.todo-document a').click();await page.keyboard.press('Control+t');await expect(page.locator('.todo-document p').first()).toContainText('已识别的链接');
 await page.keyboard.press('Control+z');await expect(page.locator('.todo-document p').first()).toContainText('首个事件');
 await page.locator('.todo-document a').click({button:'right'});await expect(page.getByRole('menuitem',{name:/^置顶事件/}).locator('small')).toHaveText('Ctrl T');
});
test('Backspace removes an empty marker then each Tab indentation and persists a flush-left line',async()=>{
 const line=page.locator('.todo-document li p').first();await line.click();await page.keyboard.press('Home');await page.keyboard.press('Tab');await page.keyboard.press('Tab');await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await page.keyboard.press('Backspace');
 const caret=()=>page.locator('.todo-document').evaluate((el:any)=>{const p=el.editor.state.selection.$from;return {depth:p.depth,text:p.parent.textContent,format:p.parent.attrs.format};});
 await page.keyboard.press('Backspace');expect(await caret()).toMatchObject({depth:1,text:'',format:{marginLeft:'87px'}});
 await page.keyboard.press('Backspace');expect((await caret()).format.marginLeft).toBe('57px');await page.keyboard.press('Backspace');expect((await caret()).format.marginLeft).toBe('27px');await page.keyboard.press('Backspace');expect((await caret()).format).toBeNull();
 await page.keyboard.type('回到行首');await page.keyboard.press('Control+s');await expect.poll(()=>{const db=new Database(file,{readonly:true});try{return (db.prepare('select content_html from events order by pos').all() as any[]).map(e=>e.content_html).join('');}finally{db.close();}}).toContain('回到行首</p>');
 await app.evaluate(({app})=>app.exit(0));await launch();await expect(page.locator('.todo-document > p').filter({hasText:'回到行首'})).toBeVisible();await expect(page.locator('.todo-document > p').filter({hasText:'回到行首'})).toHaveCSS('margin-left','0px');
});

for(const list of ['<ol><li>列表甲</li><li><p></p></li><li>列表乙</li></ol>','<ul><li>列表甲<ul><li><p></p></li><li>列表乙</li></ul></li></ul>'])test('list and plain paragraphs keep identical vertical spacing when removing an empty marker '+list.slice(1,3),async()=>{
 await page.locator('.todo-document').evaluate((el:any,html)=>{const ed=el.editor;ed.commands.setContent('<p>上文</p>'+html+'<p>下文</p>');let at=-1;ed.state.doc.descendants((n:any,p:number)=>{if(at<0&&n.type.name==='paragraph'&&!n.content.size)at=p+1;});ed.commands.setTextSelection(at);ed.view.focus();},list);
 const geometry=()=>page.locator('.todo-document p').evaluateAll(els=>els.map(el=>{const r=el.getBoundingClientRect();return {y:r.y,height:r.height,line:getComputedStyle(el).lineHeight};}));
 const before=await geometry();for(const row of before)expect(row.height).toBeCloseTo(before[0].height,1);
 await page.keyboard.press('Backspace');const after=await geometry();expect(after).toHaveLength(before.length);after.forEach((row,i)=>{expect(row.y).toBeCloseTo(before[i].y,1);expect(row.height).toBeCloseTo(before[i].height,1);expect(row.line).toBe(before[i].line);});
});

for(const first of [false,true])test(`dragging text upward onto ${first?'first':'interior'} divider selects it, deletes only the selected range and undoes`,async({},info)=>{
 if(first)await page.locator('.todo-document').evaluate((el:any)=>{const ed=el.editor;ed.commands.insertContentAt(0,{type:'divider',attrs:ed.state.doc.attrs.head});});
 const before=await page.locator('.todo-document').evaluate((el:any)=>el.editor.state.doc.toJSON());
 const drag=await page.locator('.todo-document').evaluate((el:any,first)=>{const ed=el.editor;let anchor=-1,divider=-1;ed.state.doc.descendants((n:any,p:number)=>{if(n.type.name==='divider'&&(first?divider<0:true))divider=p;if(n.isText&&(first?n.text.includes('首个事件'):n.text==='已识别的链接'))anchor=p+3;});return {start:ed.view.coordsAtPos(anchor),divider};},first);
 const line=first?page.locator('.event-divider').first():page.locator('.event-divider').last(),box=(await line.boundingBox())!;
 await page.mouse.move(drag.start.left, (drag.start.top+drag.start.bottom)/2);await page.mouse.down();await page.mouse.move(box.x+box.width*.3,box.y+box.height/2,{steps:12});await page.mouse.up();
 await expect(line).toHaveClass(/text-selected-divider/);const selected=await page.locator('.todo-document').evaluate((el:any)=>({from:el.editor.state.selection.from,to:el.editor.state.selection.to,text:el.editor.state.doc.textBetween(el.editor.state.selection.from,el.editor.state.selection.to)}));expect(selected.from).toBe(drag.divider);expect(selected.text.length).toBeGreaterThan(0);
 const count=await page.locator('.event-divider').count();await page.screenshot({path:info.outputPath('divider-selected.png')});await page.keyboard.press('Delete');await expect(page.locator('.event-divider')).toHaveCount(count-1);
 await page.keyboard.press('Control+z');expect(await page.locator('.todo-document').evaluate((el:any)=>el.editor.state.doc.toJSON())).toEqual(before);
});
