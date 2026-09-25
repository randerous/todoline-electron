import {searchWindow} from './search-window';
import { _electron, expect, test, type ElectronApplication, type Page } from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import Database from 'better-sqlite3';
import { DocumentStore } from '../../src/main/storage';

let app:ElectronApplication,page:Page,root:string;
test.beforeEach(async({},info)=>{
  root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});
  const store=new DocumentStore(),file=path.join(root,'功能对照.tde'),doc=store.open(file,true),now=Math.floor(Date.now()/1000);
  await store.save({handle:doc.handle,revision:doc.revision,events:[
    {text:'目标一：完成界面设计',due:now+86400,done:0},
    {text:'目标二：验证文件兼容',due:now+172800,done:1},
    {text:'逾期事项：整理资料',due:now-172800,done:0},
    {text:'目标三：持续记录想法',due:null,done:0},
  ].map((e,i)=>({id:-i-1,pos:i*1024,created_at:now-7*86400,deadline_raw:e.due?'日期样本':'',deadline_ts:e.due,done:e.done,top_divider:i===0?1:0,content_html:`<p>${e.text}</p>`,content_text:e.text}))});store.close(doc.handle);
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
  app=await _electron.launch({args:[path.resolve('.'),'--open',file],env:env as Record<string,string>});page=await app.firstWindow();page.on('pageerror',e=>console.error('Renderer error:',e));await expect(page.locator('.todo-document')).toBeVisible();
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});

test('rename refuses to remove a source edited by another application',async()=>{
  const source=path.join(root,'功能对照.tde'),destination=path.join(root,'改名.tde');
  const db=new Database(source);db.prepare('update events set content_html=?,content_text=? where pos=0').run('<p>外部最新版本</p>','外部最新版本');db.close();
  await app.evaluate(({dialog},file)=>{dialog.showSaveDialog=async()=>({canceled:false,filePath:file});},destination);
  await page.locator('.file-tab').first().click({button:'right'});await page.getByRole('button',{name:'重命名…',exact:true}).click();await page.getByRole('textbox',{name:'新文件名'}).fill('改名');await page.getByRole('textbox',{name:'新文件名'}).press('Enter');
  await expect(page.locator('.tab-rename-error')).toContainText('修改');
  const check=new Database(source,{readonly:true});expect((check.prepare('select content_text from events where pos=0').get() as any).content_text).toBe('外部最新版本');check.close();expect(await fs.stat(destination).then(()=>true,()=>false)).toBe(false);
});

test('original Qt clipboard reader preserves full events and text fragments',async()=>{
  const qtRoundtrip=async(name:string)=>{
    const input=path.join(root,name+'-in.json'),output=path.join(root,name+'-out.json');
    const raw=await app.evaluate(({clipboard})=>clipboard.readBuffer('application/x-tde-events').toString());await fs.writeFile(input,raw);
    execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['clipboard',input,output],{windowsHide:true,env:{...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH}});
    return JSON.parse(await fs.readFile(output,'utf8'));
  };
  await page.locator('.todo-document p').first().click();await page.keyboard.press('Control+a');await page.keyboard.press('Control+c');
  await expect.poll(async()=>app.evaluate(({clipboard})=>{try{return JSON.parse(clipboard.readBuffer('application/x-tde-events').toString()).events?.map((e:any)=>e.text);}catch{return [];}})).toEqual(['目标一：完成界面设计','目标二：验证文件兼容','逾期事项：整理资料','目标三：持续记录想法']);
  const all=await qtRoundtrip('events');expect(all.events).toHaveLength(4);expect(all.events[0].top_divider).toBe(true);expect(all.events[1].done).toBe(true);
  await app.evaluate(({clipboard})=>clipboard.clear());await page.locator('.todo-document p').first().click();await page.keyboard.press('Home');await page.keyboard.press('Shift+End');await page.keyboard.press('Control+c');
  await expect.poll(async()=>app.evaluate(({clipboard})=>clipboard.readBuffer('application/x-tde-events').length)).toBeGreaterThan(20);
  const fragment=await qtRoundtrip('fragment');expect(fragment.events).toHaveLength(1);expect(fragment.events[0]).toMatchObject({text:'目标一：完成界面设计',done:false,top_divider:false});
});

test('status lists filter, preview, mark completion, undo and locate events',async()=>{
  await expect(page.getByRole('button',{name:'待提醒事件',exact:true})).toContainText('1');
  await expect(page.getByRole('button',{name:'到期未完成事件',exact:true})).toContainText('1');
  await page.getByRole('button',{name:'待提醒事件',exact:true}).hover();await expect(page.locator('.event-panel')).toContainText('待提醒');
  await page.mouse.move(20,300);await expect(page.locator('.event-panel')).toHaveCount(0);
  await page.getByRole('button',{name:'待提醒事件',exact:true}).click();
  await expect(page.locator('.event-panel-row')).toHaveCount(2);
  await page.getByRole('textbox',{name:'过滤事件列表'}).fill('目标一');
  await page.locator('.event-panel-row').hover();await expect(page.locator('.event-preview')).toContainText('完成界面设计');
  await page.getByRole('checkbox',{name:'完成事件 目标一：完成界面设计'}).check();
  await expect(page.locator('.event-check').first()).toHaveAttribute('aria-pressed','true');
  await expect(page.getByRole('button',{name:'待提醒事件',exact:true})).toContainText('0');
  await page.getByRole('button',{name:'关闭事件列表'}).click();await page.locator('.todo-document p').first().click();await page.keyboard.press('Control+z');
  await expect(page.locator('.event-check').first()).toHaveAttribute('aria-pressed','false');
  await page.getByRole('button',{name:'全部事件',exact:true}).click();await page.getByRole('textbox',{name:'过滤事件列表'}).fill('持续');
  await page.locator('.event-panel-row button').click();await expect(page.locator('.event-panel')).toHaveCount(0);
  const paragraph=await page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.$from.parent.textContent);expect(paragraph).toContain('持续记录想法');
});

test('the created time holds the centre of every divider and the deadline sits in the line',async()=>{
  const offsets=await page.locator('.event-divider').evaluateAll(rows=>rows.map(row=>{
    const line=row.getBoundingClientRect(),created=row.querySelector('.event-created')!.getBoundingClientRect();
    return Math.round(line.left+line.width/2-(created.left+created.width/2));
  }));
  expect(offsets.length).toBe(4);expect(offsets.every(offset=>Math.abs(offset)<=2)).toBe(true);
  const layout=await page.locator('.event-divider').first().evaluate(row=>Array.from(row.querySelectorAll('.divider-side')[1].children).map(el=>el.className.split(' ')[0]));
  expect(layout).toEqual(['divider-stroke','event-deadline','divider-stroke','countdown','divider-stroke']);
  const gaps=await page.locator('.event-divider').first().evaluate(row=>{
    const box=(el:Element)=>el.getBoundingClientRect();
    const strokes=Array.from(row.querySelectorAll('.divider-stroke')).map(box);
    const around=(el:Element)=>{const target=box(el);return strokes.filter(s=>s.right<=target.left+1||s.left>=target.right-1)
      .map(s=>s.right<=target.left?Math.round(target.left-s.right):Math.round(s.left-target.right)).filter(gap=>gap>=0&&gap<40).sort((a,b)=>a-b).slice(0,2);};
    return {created:around(row.querySelector('.event-created')!),deadline:around(row.querySelector('.event-deadline')!)};
  });
  expect(gaps.deadline).toEqual(gaps.created);
  // Without a countdown the deadline itself holds the right edge, one short stroke from it.
  const bare=await page.locator('.event-divider').last().evaluate(row=>{
    const side=row.querySelectorAll('.divider-side')[1] as HTMLElement;
    const strokes=Array.from(side.querySelectorAll('.divider-stroke')).filter(el=>getComputedStyle(el).display!=='none');
    const field=row.querySelector('.event-deadline')!.getBoundingClientRect();
    return {trailing:Math.round(strokes.at(-1)!.getBoundingClientRect().width),toEdge:Math.round(side.getBoundingClientRect().right-field.right)};
  });
  expect(bare.trailing).toBeLessThanOrEqual(30);
  expect(bare.toEdge).toBeLessThanOrEqual(40);
});

test('locating an event from either list parks it at the top of the canvas',async()=>{
  const offset=(index:number)=>page.evaluate(i=>{const scroller=document.querySelector('.document-scroller[data-active]')!.getBoundingClientRect();return Math.round(document.querySelectorAll('.event-divider')[i].getBoundingClientRect().top-scroller.top);},index);
  await page.locator('.todo-document p').last().click();
  await page.locator('.todo-document').evaluate((el:any)=>el.editor.commands.insertContentAt(el.editor.state.doc.content.size,Array.from({length:40},(_,i)=>({type:'paragraph',content:[{type:'text',text:`占位 ${i+1}`}]}))));
  await page.locator('.document-scroller[data-active]').evaluate(el=>el.scrollTo(0,el.scrollHeight));
  await expect.poll(()=>offset(0)).toBeLessThan(0);
  await page.locator('.outline-item').first().click();
  await expect.poll(()=>offset(0)).toBe(10);
  await page.getByRole('button',{name:'全部事件',exact:true}).click();
  await page.getByRole('textbox',{name:'过滤事件列表'}).fill('逾期事项');
  await page.locator('.event-panel-row button').click();
  await expect.poll(()=>offset(2)).toBe(10);
});

test('the search panel floats, jumps to the first match and dims when idle',async()=>{
  const editorTop=async()=>(await page.locator('.todo-document').boundingBox())!.y;
  const before=await editorTop();
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();
  expect(await editorTop()).toBe(before);
  await expect((await searchWindow(app)).getByRole('button',{name:'整个事件',exact:true})).toHaveAttribute('aria-pressed','true');
  await (await searchWindow(app)).getByRole('textbox',{name:'搜索内容'}).fill('逾期');
  await expect((await searchWindow(app)).locator('.search-bar')).toContainText('1 个事件');
  await expect.poll(()=>page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.$from.parent.textContent)).toContain('逾期事项');
  expect(await (await searchWindow(app)).evaluate(()=>document.activeElement?.getAttribute('aria-label'))).toBe('搜索内容');
  await expect(page.locator('.search-match').first()).toHaveCSS('background-color','rgb(240, 199, 90)');
  const search=await searchWindow(app);
  expect(await search.locator('.search-bar').evaluate(el=>getComputedStyle(el).getPropertyValue('-webkit-app-region'))).toBe('drag');
  const moved=await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!,child=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL()==='about:blank')!,b=main.getBounds();child.setPosition(b.x+b.width-30,b.y+100);return {main:b,child:child.getBounds()};});
  expect(moved.child.x+moved.child.width).toBeGreaterThan(moved.main.x+moved.main.width);
  await page.locator('.todo-document p').first().click();
  await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!;main.show();main.focus();});
  await expect(search.locator('.search-bar')).toHaveCSS('opacity','0.8');
});

test('the calendar places events by deadline and locates the one clicked',async()=>{
  await page.getByRole('button',{name:'事件日历',exact:true}).click();
  const panel=page.locator('.calendar-panel');
  await expect(panel).toBeVisible();
  await expect(panel.locator('.calendar-day')).toHaveCount(42);
  await expect(panel.locator('.calendar-note')).toContainText('1 个事件没有截止时间');
  const chip=panel.getByTitle('逾期事项：整理资料');
  if(!await chip.count())await page.getByRole('button',{name:'上个月',exact:true}).click();
  await expect(chip).toHaveCount(1);
  await expect(chip).toHaveClass(/overdue/);
  await expect(panel.locator('.calendar-chip.done')).toHaveCount(1);
  await chip.click();
  await expect(panel).toHaveCount(0);
  await expect.poll(()=>page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.$from.parent.textContent)).toContain('整理资料');
});

test('the toolbar size stepper follows the selection and otherwise the canvas',async()=>{
  const shown=()=>page.locator('.toolbar-size span').innerText();
  const canvas=()=>page.evaluate(()=>getComputedStyle(document.documentElement).getPropertyValue('--editor-size').trim());
  expect(await shown()).toBe('15 px');
  await page.getByRole('button',{name:'增大字号',exact:true}).click();
  expect(await canvas()).toBe('16px');
  await page.getByRole('button',{name:'减小字号',exact:true}).click();
  expect(await canvas()).toBe('15px');
  await page.locator('.todo-document p').first().click();await page.keyboard.press('Home');
  for(let i=0;i<3;i++)await page.keyboard.press('Shift+ArrowRight');
  await expect.poll(shown).toBe('15 px');
  await page.getByRole('button',{name:'增大字号',exact:true}).click();
  await expect.poll(shown).toBe('16 px');
  expect(await canvas()).toBe('15px');
  expect(await page.locator('.todo-document p span').first().evaluate(el=>Math.round(parseFloat(getComputedStyle(el).fontSize)))).toBe(16);
});

test('hover bubbles open where there is room instead of running off an edge',async()=>{
  const fits=()=>page.locator('.tooltip').evaluate(el=>{const r=el.getBoundingClientRect();return r.left>=0&&r.top>=0&&r.right<=innerWidth&&r.bottom<=innerHeight;});
  await page.locator('.outline-item').first().hover();
  await expect(page.locator('.tooltip')).toBeVisible();
  await expect(page.locator('.tooltip')).toContainText('目标一');
  expect(await fits()).toBe(true);
  await page.locator('.todo-document p').first().hover();
  await expect(page.locator('.tooltip')).toHaveCount(0);
  await page.locator('.reminder-status').hover();
  await expect(page.locator('.tooltip')).toBeVisible();
  expect(await fits()).toBe(true);
});

test('divider context menu inserts below and deletes selected events with one-step undo',async()=>{
  await page.locator('.divider-stroke').first().click({button:'right'});
  await expect(page.getByRole('menu',{name:'事件操作'})).toBeVisible();
  await page.getByRole('button',{name:'在此下方插入分隔线',exact:true}).click();
  await expect(page.locator('.event-divider')).toHaveCount(5);await page.keyboard.type('插入的新事件');
  await expect(page.locator('.todo-document')).toContainText('插入的新事件');
  await page.locator('.event-divider').nth(1).locator('.divider-stroke').first().click({button:'right'});
  await page.getByRole('button',{name:'删除选中事件',exact:true}).click();await expect(page.locator('.event-divider')).toHaveCount(4);
  await page.locator('.todo-document p').first().click();await page.keyboard.press('Control+z');await expect(page.locator('.event-divider')).toHaveCount(5);await expect(page.locator('.todo-document')).toContainText('插入的新事件');
});

test('search selects all matching events, exports Qt flags, remembers tabs and closes with Escape',async()=>{
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();await (await searchWindow(app)).getByRole('textbox',{name:'搜索内容'}).fill('目标');await expect((await searchWindow(app)).locator('.search-bar')).toContainText('3 个事件');
  await expect(page.locator('.search-match')).toHaveCount(3);await expect((await searchWindow(app)).getByRole('button',{name:'高亮',exact:true})).toHaveAttribute('aria-pressed','true');
  await expect(page.locator('.todo-document p.search-event')).toHaveCount(3);
  expect(await page.locator('.todo-document p.search-event').first().evaluate(el=>getComputedStyle(el).boxShadow)).toBe('none');
  await (await searchWindow(app)).getByRole('button',{name:'高亮',exact:true}).click();await expect(page.locator('.search-match')).toHaveCount(0);await expect(page.locator('.todo-document .search-event')).toHaveCount(0);
  await (await searchWindow(app)).getByRole('button',{name:'全选命中事件',exact:true}).click();await expect(page.locator('.selection-count')).toHaveText('已选 3 个事件');await page.keyboard.press('Control+Shift+c');
  await expect.poll(async()=>app.evaluate(({clipboard})=>{const raw=clipboard.readBuffer('application/x-tde-events').toString();return raw?JSON.parse(raw).events.map((e:any)=>e.done):[];})).toEqual([false,true,false]);
  await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await expect.poll(()=>app.windows().filter(p=>p.url()==='about:blank').length).toBe(0);await page.locator('.tab-name').first().click();await expect((await searchWindow(app)).getByRole('textbox',{name:'搜索内容'})).toHaveValue('目标');await expect((await searchWindow(app)).getByRole('button',{name:'高亮',exact:true})).toHaveAttribute('aria-pressed','false');
  await page.locator('.todo-document:visible p').first().click();await page.keyboard.press('Escape');await expect.poll(()=>app.windows().filter(p=>p.url()==='about:blank').length).toBe(0);
});

test('closing a tab to the left preserves the current document and editor',async()=>{
  await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();
  await expect(page.locator('.file-tab')).toHaveCount(3);
  await page.locator('.todo-document:visible p').click();await page.keyboard.type('当前文档保持');const title=await page.locator('.file-tab.active .tab-name').innerText();
  await page.locator('.file-tab').first().locator('.tab-close').click();await expect(page.locator('.file-tab')).toHaveCount(2);await expect(page.locator('.file-tab.active .tab-name')).toHaveText(title);await expect(page.locator('.document-scroller:visible')).toContainText('当前文档保持');
});

test('narrow workbench keeps search and event panels usable with wheel zoom and indentation',async()=>{
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(820,660));
  await page.locator('.todo-document p').first().click();await page.keyboard.press('Home');await page.keyboard.press('Tab');await page.keyboard.press('End');await page.keyboard.press('Enter');await page.keyboard.type('自动缩进');
  await expect(page.locator('.todo-document p').nth(1)).toHaveText('    自动缩进');
  const before=await page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--editor-size'));
  await page.mouse.move(600,340);await page.keyboard.down('Control');await page.mouse.wheel(0,-100);await page.keyboard.up('Control');await expect.poll(()=>page.locator('html').evaluate(el=>getComputedStyle(el).getPropertyValue('--editor-size'))).not.toBe(before);
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();await (await searchWindow(app)).getByRole('textbox',{name:'搜索内容'}).fill('目标');await page.getByRole('button',{name:'全部事件',exact:true}).click();
  await expect(page.locator('.event-panel')).toBeVisible();
  const overflow=await page.evaluate(()=>Array.from(document.querySelectorAll('.event-panel,.search-bar button,.statusbar button')).filter(el=>{const r=el.getBoundingClientRect();return r.width>0&&(r.left<0||r.right>innerWidth+1);} ).map(el=>el.textContent));expect(overflow).toEqual([]);
  await page.screenshot({path:path.join(root,'compact-workbench.png')}).catch(()=>{});
});

test('a crowded calendar day opens its bubble on hover, beside the cell',async()=>{
  const day=new Date(),pad=(v:number)=>String(v).padStart(2,'0');
  const stamp=(hour:number)=>`${day.getFullYear()}-${pad(day.getMonth()+1)}-${pad(day.getDate())} ${pad(hour)}:00`;
  const fields=page.locator('.event-deadline');
  for(let i=0;i<3;i++){await fields.nth(i).fill(stamp(9+i));await fields.nth(i).press('Enter');}
  await page.getByRole('button',{name:'事件日历',exact:true}).click();
  const cell=page.locator('.calendar-day.today'),bubble=page.locator('.calendar-bubble');
  const more=cell.getByRole('button',{name:'展开全部3个'});
  await expect(cell.locator('.calendar-chip')).toHaveCount(2);
  // The control names the whole day and stays readable inside the cell.
  expect(await more.evaluate(el=>el.scrollWidth-el.clientWidth)).toBeLessThanOrEqual(1);
  // Pointing at it opens the day after a deliberate dwell, without a click.
  await more.hover();
  await expect(bubble).toHaveCount(0,{timeout:200});
  await expect(bubble.locator('.calendar-chip')).toHaveCount(3);
  await expect(bubble).toContainText('3 个事件');
  const fits=async()=>{
    const box=(await bubble.boundingBox())!,cellBox=(await cell.boundingBox())!;
    const view=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));
    return {inside:box.x>=0&&box.y>=0&&box.x+box.width<=view.w+1&&box.y+box.height<=view.h+1,
      beside:box.x>=cellBox.x+cellBox.width-1||box.x+box.width<=cellBox.x+1};
  };
  expect(await fits()).toEqual({inside:true,beside:true});
  // The cell itself never grows or scrolls to make room.
  expect(await cell.evaluate(el=>el.scrollHeight-el.clientHeight)).toBeLessThanOrEqual(1);
  // Moving onto the bubble keeps it open; leaving both closes it.
  await bubble.hover();
  await expect(bubble).toBeVisible();
  await page.mouse.move(8,300);
  await expect(bubble).toHaveCount(0);
  // A click pins the day open, and clicking again closes it.
  await more.click();
  await expect(bubble.locator('.calendar-chip')).toHaveCount(3);
  await page.mouse.move(8,300);
  await expect(bubble).toBeVisible();
  await cell.getByRole('button',{name:'收起',exact:true}).click();
  await expect(bubble).toHaveCount(0);
  // A narrow window makes the bubble open to whichever side has room.
  await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows()[0].setSize(900,680));
  // The pointer is still resting on the button after the click: leave, then come back.
  await page.mouse.move(8,300);
  await more.hover();
  await expect(bubble.locator('.calendar-chip')).toHaveCount(3);
  expect(await fits()).toEqual({inside:true,beside:true});
  await bubble.locator('.calendar-chip').last().click();
  await expect(page.locator('.calendar-panel')).toHaveCount(0);
  await expect.poll(()=>page.locator('.todo-document').evaluate((el:any)=>el.editor.state.selection.$from.parent.textContent)).toContain('整理资料');
});

test('right-clicking the body offers undo, cut, copy, paste and select all',async()=>{
  const first=page.locator('.todo-document p').first();
  const menu=page.getByRole('menu',{name:'正文操作'}),item=(name:string)=>menu.getByRole('menuitem',{name:new RegExp('^'+name)});
  const clip=()=>app.evaluate(({clipboard})=>clipboard.readText());
  const at=async(dx:'start'|'end')=>{const box=(await first.boundingBox())!;return {x:dx==='start'?box.x+8:box.x+box.width-4,y:box.y+box.height/2};};
  // Select 目标一 through the editor: synthetic Shift+Arrow depends on window focus.
  await page.locator('.todo-document').evaluate((el:any)=>{const {doc}=el.editor.state;let start=-1;doc.forEach((node:any,pos:number)=>{if(start<0&&node.type.name==='paragraph')start=pos+1;});el.editor.commands.setTextSelection({from:start,to:start+3});el.editor.view.focus();});
  // Inside the selection the menu keeps it and copies exactly that text.
  let p=await at('start');await page.mouse.click(p.x,p.y,{button:'right'});
  await expect(menu).toBeVisible();
  await expect(item('复制')).toBeEnabled();await expect(item('剪切')).toBeEnabled();
  await item('复制').click();
  await expect(menu).toHaveCount(0);
  await expect.poll(clip).toBe('目标一');
  p=await at('start');await page.mouse.click(p.x,p.y,{button:'right'});
  await item('剪切').click();
  await expect(first).toHaveText('：完成界面设计');
  // Elsewhere it moves the caret first: nothing to copy, and paste lands there.
  p=await at('end');await page.mouse.click(p.x,p.y,{button:'right'});
  await expect(item('复制')).toBeDisabled();await expect(item('剪切')).toBeDisabled();
  await item('粘贴').click();
  await expect(first).toHaveText('：完成界面设计目标一');
  p=await at('end');await page.mouse.click(p.x,p.y,{button:'right'});
  await item('撤销').click();
  await expect(first).toHaveText('：完成界面设计');
  p=await at('end');await page.mouse.click(p.x,p.y,{button:'right'});
  await item('全选').click();
  expect(await page.locator('.todo-document').evaluate((el:any)=>{const {selection,doc}=el.editor.state;return selection.from===0&&selection.to===doc.content.size;})).toBe(true);
  // The menu stays on screen, Escape closes it, and dividers keep their own menu.
  p=await at('end');await page.mouse.click(p.x,p.y,{button:'right'});
  const box=(await menu.boundingBox())!,view=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));
  expect(box.x>=0&&box.y>=0&&box.x+box.width<=view.w&&box.y+box.height<=view.h).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await page.locator('.event-divider').first().click({button:'right',position:{x:40,y:8}});
  await expect(page.locator('.event-context-menu:not(.text-context-menu)')).toBeVisible();
  await expect(menu).toHaveCount(0);
});

test('Tab nests list items as 1. (1) ① ■ ● and both style menus switch markers',async()=>{
  const doc=page.locator('.todo-document');
  await doc.evaluate((el:any)=>{
    const e=el.editor;let from=-1,to=-1;
    e.state.doc.forEach((node:any,pos:number)=>{if(from<0&&node.type.name==='paragraph'){from=pos;to=pos+node.nodeSize;}});
    e.chain().insertContentAt({from,to},{type:'orderedList',content:['一','二','三','四','五','六'].map(text=>({type:'listItem',content:[{type:'paragraph',content:[{type:'text',text}]}]}))}).run();
  });
  const caret=(text:string)=>doc.evaluate((el:any,wanted:string)=>{const e=el.editor;let at=-1;e.state.doc.descendants((node:any,pos:number)=>{if(at<0&&node.type.name==='paragraph'&&node.textContent===wanted)at=pos+1;});e.commands.setTextSelection(at);e.view.focus();},text);
  const depth=()=>doc.evaluate((el:any)=>{const $from=el.editor.state.selection.$from;let n=0;for(let d=1;d<=$from.depth;d++)if(/List$/.test($from.node(d).type.name))n++;return n;});
  // Square lists hide the system marker and draw a larger square themselves (checked below).
  const markers=()=>doc.evaluate(el=>Array.from(el.querySelectorAll('ol,ul')).map(list=>(list as HTMLElement).dataset.listStyle==='square'?'square':getComputedStyle(list).listStyleType));
  for(const [text,times] of [['二',1],['三',2],['四',3],['五',4],['六',4]] as const){await caret(text);for(let i=0;i<times;i++)await page.keyboard.press('Tab');}
  await expect.poll(markers).toEqual(['decimal','tl-paren','tl-circled','square','disc']);
  await caret('六');expect(await depth()).toBe(5);
  // Five levels is the limit, and Shift+Tab steps back out.
  await page.keyboard.press('Tab');expect(await depth()).toBe(5);
  await expect(doc.locator('li > p').filter({hasText:/^六$/})).toHaveCount(1);
  await page.keyboard.press('Shift+Tab');expect(await depth()).toBe(4);
  await page.keyboard.press('Tab');expect(await depth()).toBe(5);
  // Qt reads (1), ■ and ● natively; ① rides on a property Qt ignores.
  const saved=()=>{const db=new Database(path.join(root,'功能对照.tde'),{readonly:true});try{return (db.prepare('select content_html from events order by pos limit 1').get() as any).content_html as string;}finally{db.close();}};
  await expect.poll(saved,{timeout:10000}).toContain(`-qt-list-number-prefix: '(';`);
  expect(saved()).toContain('<ul type="square"');
  expect(saved()).toContain('-todoline-list-style: circled;');
  // Toolbar: the menu marks the current marker and swaps it for another.
  await caret('六');
  await page.locator('.toolbar button[aria-label="列表样式"]').click();
  const toolbarMenu=page.getByRole('menu',{name:'列表样式菜单'});
  await expect(toolbarMenu.getByRole('menuitemradio',{name:'实心圆点'})).toHaveAttribute('aria-checked','true');
  const box=(await toolbarMenu.boundingBox())!,view=await page.evaluate(()=>({w:innerWidth,h:innerHeight}));
  expect(box.x>=0&&box.y>=0&&box.x+box.width<=view.w&&box.y+box.height<=view.h).toBe(true);
  const step=()=>doc.evaluate(el=>{const rows=Array.from(el.querySelectorAll('li > p')).filter(p=>p.textContent==='五'||p.textContent==='六');return rows[1].getBoundingClientRect().top-rows[0].getBoundingClientRect().top;});
  const joined=await step();
  await toolbarMenu.getByRole('menuitemradio',{name:'空心圆点'}).click();
  await expect(toolbarMenu).toHaveCount(0);
  // Only the line with the caret changes: 五 keeps its filled dot.
  await expect.poll(markers).toEqual(['decimal','tl-paren','tl-circled','square','disc','circle']);
  // Splitting 六 off into its own list must not open a gap between the two rows.
  expect(Math.abs(await step()-joined)).toBeLessThanOrEqual(0.5);
  // The filled square is drawn larger than Chromium's text-sized one without making its line taller.
  const square=await doc.evaluate(el=>{
    const item=el.querySelector('ul[data-list-style=square]>li')!,plain=el.querySelector('ol>li>p')!;
    return {size:parseFloat(getComputedStyle(item,'::before').width),line:item.querySelector('p')!.getBoundingClientRect().height,plain:plain.getBoundingClientRect().height};
  });
  expect(square.size).toBeGreaterThanOrEqual(7);
  expect(Math.abs(square.line-square.plain)).toBeLessThanOrEqual(0.5);
  // Right-click inside a list offers the same markers for that list.
  const second=(await doc.locator('li > p').filter({hasText:/^二$/}).boundingBox())!;
  await page.mouse.click(second.x+6,second.y+second.height/2,{button:'right'});
  const menu=page.getByRole('menu',{name:'正文操作'});
  await expect(menu.getByRole('menuitemradio',{name:'(1) (2) (3)'})).toHaveAttribute('aria-checked','true');
  await menu.getByRole('menuitemradio',{name:'a. b. c.'}).click();
  await expect(menu).toHaveCount(0);
  await expect.poll(async()=>(await markers())[1]).toBe('lower-alpha');
  // Outside a list the right-click menu has no marker section.
  const plain=(await doc.locator('p').filter({hasText:'目标二'}).boundingBox())!;
  await page.mouse.click(plain.x+6,plain.y+plain.height/2,{button:'right'});
  await expect(menu).toBeVisible();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('selected lines indent together with Tab and turn into a list nested by their indentation',async()=>{
  const doc=page.locator('.todo-document');
  await doc.evaluate((el:any)=>{
    const e=el.editor;let from=-1,to=-1;
    e.state.doc.forEach((node:any,pos:number)=>{if(from<0&&node.type.name==='paragraph'){from=pos;to=pos+node.nodeSize;}});
    e.chain().insertContentAt({from,to},['整理需求','拆分任务','确认接口','准备发布','甲','乙'].map(text=>({type:'paragraph',content:[{type:'text',text}]}))).run();
  });
  const select=(first:string,last:string)=>doc.evaluate((el:any,[a,b]:string[])=>{
    const e=el.editor;let from=-1,to=-1;
    e.state.doc.descendants((node:any,pos:number)=>{if(!node.isTextblock)return true;const text=node.textContent.trim();if(from<0&&text===a)from=pos+1;if(text===b)to=pos+1+node.content.size;return false;});
    e.commands.setTextSelection({from,to});e.view.focus();
  },[first,last]);
  const texts=()=>doc.evaluate((el:any)=>{const out:string[]=[];el.editor.state.doc.descendants((node:any)=>{if(node.type.name==='paragraph'){out.push(node.textContent);return false;}return true;});return out.slice(0,6);});
  const markers=()=>doc.evaluate(el=>Array.from(el.querySelectorAll('ol,ul')).map(list=>(list as HTMLElement).dataset.listStyle==='square'?'square':getComputedStyle(list).listStyleType));
  // Tab with two lines selected indents both instead of replacing them.
  await select('拆分任务','确认接口');await page.keyboard.press('Tab');
  await select('确认接口','确认接口');await doc.evaluate((el:any)=>{const e=el.editor;e.commands.setTextSelection(e.state.selection.from);});
  await page.keyboard.press('Home');await page.keyboard.press('Tab');
  await expect.poll(texts).toEqual(['整理需求','    拆分任务','        确认接口','准备发布','甲','乙']);
  // Right-click inside the selection: 有序列表 nests the lines by their indentation.
  await select('整理需求','准备发布');
  const row=(await doc.locator('p').filter({hasText:'整理需求'}).boundingBox())!;
  await page.mouse.click(row.x+8,row.y+row.height/2,{button:'right'});
  await page.getByRole('menu',{name:'正文操作'}).getByRole('menuitem',{name:/^有序列表/}).click();
  await expect.poll(markers).toEqual(['decimal','tl-paren','tl-circled']);
  await expect.poll(texts).toEqual(['整理需求','拆分任务','确认接口','准备发布','甲','乙']);
  // Toolbar: 无序列表 on two more lines, the second indented once, gives ● then ○.
  await select('乙','乙');await doc.evaluate((el:any)=>{const e=el.editor;e.commands.setTextSelection(e.state.selection.from);});
  await page.keyboard.press('Home');await page.keyboard.press('Tab');
  await select('甲','乙');
  await page.locator('.toolbar button[aria-label="无序列表"]').click();
  await expect.poll(markers).toEqual(['decimal','tl-paren','tl-circled','disc','circle']);
});

test('Tab on a first item indents it alone, and 继续编号 carries numbering on',async()=>{
  const doc=page.locator('.todo-document');
  await doc.evaluate((el:any)=>{
    const e=el.editor;let from=-1,to=-1;
    e.state.doc.forEach((node:any,pos:number)=>{if(from<0&&node.type.name==='paragraph'){from=pos;to=pos+node.nodeSize;}});
    const list=(items:string[])=>({type:'orderedList',content:items.map(text=>({type:'listItem',content:[{type:'paragraph',content:[{type:'text',text}]}]}))});
    e.chain().insertContentAt({from,to},[list(['一','二','三']),{type:'paragraph',content:[{type:'text',text:'说明'}]},list(['四','五'])]).run();
  });
  const caret=(text:string)=>doc.evaluate((el:any,wanted:string)=>{const e=el.editor;let at=-1;e.state.doc.descendants((node:any,pos:number)=>{if(at<0&&node.type.name==='paragraph'&&node.textContent===wanted)at=pos+1;});e.commands.setTextSelection(at);e.view.focus();},text);
  const lists=()=>doc.evaluate((el:any)=>{const out:string[]=[];el.editor.state.doc.descendants((node:any)=>{if(node.type.name==='orderedList')out.push(`${node.attrs.listStyle??'default'}:${node.attrs.listIndent??0}:${node.attrs.start}:${node.childCount}`);return true;});return out.slice(0,3);});
  await caret('一');await page.keyboard.press('Tab');
  await expect.poll(lists).toEqual(['paren:1:1:1','default:0:1:2','default:0:1:2']);
  const shape=await doc.evaluate(el=>{const [deeper,rest]=Array.from(el.querySelectorAll('ol')) as HTMLElement[];return {marker:getComputedStyle(deeper).listStyleType,indent:parseFloat(getComputedStyle(deeper).marginLeft)-parseFloat(getComputedStyle(rest).marginLeft)};});
  expect(shape).toEqual({marker:'tl-paren',indent:30});
  // Right-click inside the last list: 继续编号 continues after 二 and 三.
  const row=(await doc.locator('li > p').filter({hasText:/^四$/}).boundingBox())!;
  await page.mouse.click(row.x+6,row.y+row.height/2,{button:'right'});
  const menu=page.getByRole('menu',{name:'正文操作'}),next=menu.getByRole('menuitem',{name:'继续编号'});
  await expect(next).toBeEnabled();
  expect((await menu.getByRole('menuitem',{name:/^复制/}).boundingBox())!.height).toBeLessThanOrEqual(30);
  await next.click();
  await expect.poll(lists).toEqual(['paren:1:1:1','default:0:1:2','default:0:3:2']);
});

test('an input method attaching after Alt+drag keeps the column selection',async()=>{
  const doc=page.locator('.todo-document');
  await doc.evaluate((el:any)=>{const e=el.editor;let from=-1,to=-1;e.state.doc.forEach((node:any,pos:number)=>{if(from<0&&node.type.name==='paragraph'){from=pos;to=pos+node.nodeSize;}});e.chain().insertContentAt({from,to},['abcdef','ghijkl','mnopqr'].map(text=>({type:'paragraph',content:[{type:'text',text}]}))).run();});
  const a=(await doc.locator('p').nth(0).boundingBox())!,b=(await doc.locator('p').nth(2).boundingBox())!;
  const count=async()=>page.locator('.column-selection').count();
  await page.keyboard.down('Alt');await page.mouse.move(a.x+8,a.y+10);await page.mouse.down();await page.mouse.move(b.x+28,b.y+10,{steps:8});await page.mouse.up();await page.keyboard.up('Alt');
  await expect.poll(count).toBe(3);
  // What a Chinese input method sends when the editor gains focus or is clicked.
  await doc.evaluate(el=>{el.dispatchEvent(new CompositionEvent('compositionstart',{bubbles:true,data:''}));el.dispatchEvent(new CompositionEvent('compositionend',{bubbles:true,data:''}));});
  // What other input methods send instead: Alt reported as Process, then a composition that already carries text, with nothing typed.
  await doc.evaluate(el=>{el.dispatchEvent(new KeyboardEvent('keydown',{key:'Process',altKey:true,bubbles:true,cancelable:true}));for(const type of ['compositionstart','compositionupdate','compositionend'])el.dispatchEvent(new CompositionEvent(type,{bubbles:true,data:type==='compositionstart'?'':'中文'}));});
  await page.waitForTimeout(150);
  expect(await count()).toBe(3);
  await page.keyboard.type('Z');
  await expect.poll(()=>doc.evaluate((el:any)=>el.editor.state.doc.textContent)).toMatch(/Z.*Z.*Z/);
});

test('deleting a line inside a numbered list keeps one list and closes the numbering',async()=>{
  const doc=page.locator('.todo-document');
  await doc.evaluate((el:any)=>{const e=el.editor;let from=-1,to=-1;e.state.doc.forEach((node:any,pos:number)=>{if(from<0&&node.type.name==='paragraph'){from=pos;to=pos+node.nodeSize;}});e.chain().insertContentAt({from,to},{type:'orderedList',content:['一','二','三','四'].map(text=>({type:'listItem',content:[{type:'paragraph',content:[{type:'text',text}]}]}))}).run();});
  const lists=()=>doc.evaluate((el:any)=>{const out:string[]=[];el.editor.state.doc.descendants((node:any)=>{if(node.type.name==='orderedList')out.push(`${node.attrs.start}:${Array.from({length:node.childCount},(_,i)=>node.child(i).textContent).join('|')}`);return true;});return out;});
  const place=(text:string,whole:boolean)=>doc.evaluate((el:any,[wanted,all]:[string,boolean])=>{const e=el.editor;let at=-1,size=0;e.state.doc.descendants((node:any,pos:number)=>{if(at<0&&node.type.name==='paragraph'&&node.textContent===wanted){at=pos+1;size=node.content.size;}return true;});e.commands.setTextSelection(all?{from:at,to:at+size}:at);e.view.focus();},[text,whole] as [string,boolean]);
  // Clear the line, then Backspace it away: the rest stays one list numbered 1-3.
  await place('二',true);
  for(let i=0;i<3;i++)await page.keyboard.press('Backspace');
  await expect.poll(lists).toEqual(['1:一|三|四']);
  // Backspace at the start of a line folds it into the one above, then merges the text.
  await place('三',false);
  await page.keyboard.press('Backspace');
  await expect.poll(lists).toEqual(['1:一三|四']);
  await page.keyboard.press('Backspace');
  await expect.poll(lists).toEqual(['1:一三|四']);
  await expect.poll(()=>doc.evaluate((el:any)=>{let items=0;el.editor.state.doc.descendants((node:any)=>{if(node.type.name==='listItem')items++;return true;});return items;})).toBe(2);
});

test('an exported input trace shows what arrived around an Alt+drag column selection',async()=>{
  const doc=page.locator('.todo-document');
  await doc.evaluate((el:any)=>{const e=el.editor;let from=-1,to=-1;e.state.doc.forEach((node:any,pos:number)=>{if(from<0&&node.type.name==='paragraph'){from=pos;to=pos+node.nodeSize;}});e.chain().insertContentAt({from,to},['abcdef','ghijkl','mnopqr'].map(text=>({type:'paragraph',content:[{type:'text',text}]}))).run();});
  const a=(await doc.locator('p').nth(0).boundingBox())!,b=(await doc.locator('p').nth(2).boundingBox())!;
  await page.keyboard.down('Alt');await page.mouse.move(a.x+8,a.y+10);await page.mouse.down();await page.mouse.move(b.x+28,b.y+10,{steps:8});await page.mouse.up();await page.keyboard.up('Alt');
  await expect.poll(()=>page.locator('.column-selection').count()).toBe(3);
  await app.evaluate(({Menu})=>{const item=Menu.getApplicationMenu()!.items.flatMap(i=>i.submenu?.items??[]).find(i=>i.label==='导出输入诊断记录')!;(item.click as any)();});
  await expect(page.locator('.toast')).toContainText('已导出输入诊断记录');
  const dir=path.join(root,'profile','diagnostics'),files=await fs.readdir(dir);
  expect(files).toHaveLength(1);
  const text=await fs.readFile(path.join(dir,files[0]),'utf8');
  expect(text).toMatch(/^TodoLine \d+\.\d+\.\d+/);expect(text).toContain('Windows ');
  expect(text).toMatch(/keydown\s+key=Alt code=AltLeft/);
  expect(text).toMatch(/mousedown\s+button=0 detail=1 mods=alt/);
  expect(text).toMatch(/column-drag-end\s+3 ranges/);
  expect(text).not.toContain('abcdef');
  expect(await page.locator('.column-selection').count()).toBe(3);
});

test('the popup lists put the nearest date on top and stay tighter than the navigation',async()=>{
  await page.getByRole('button',{name:'全部事件',exact:true}).click();
  await expect(page.locator('.event-panel-row')).toHaveCount(4);
  const rows=await page.locator('.event-panel-row > button > span').allInnerTexts();
  expect(rows).toEqual(['逾期事项：整理资料','目标一：完成界面设计','目标二：验证文件兼容','目标三：持续记录想法']);
  const row=await page.locator('.event-panel-row').first().evaluate(el=>el.getBoundingClientRect().height);
  const nav=await page.locator('.outline-item').first().evaluate(el=>el.getBoundingClientRect().height);
  expect(row).toBeGreaterThan(20);
  expect(row).toBeLessThanOrEqual(nav);
});

test('search options narrow the match and can reach every open file',async()=>{
  const body=page.locator('.todo-document:visible p');
  const count=async()=>(await searchWindow(app)).locator('.search-count').innerText();
  for(const [index,word] of [[0,' Plan'],[1,' plan'],[2,' plans']] as const){
    await body.nth(index).click();await page.keyboard.press('End');await page.keyboard.type(word);
  }
  await page.getByRole('button',{name:'搜索 · Ctrl+F',exact:true}).click();
  await (await searchWindow(app)).getByRole('textbox',{name:'搜索内容'}).fill('plan');
  await expect.poll(count).toBe('3 个事件');
  await (await searchWindow(app)).getByRole('button',{name:'全词匹配',exact:true}).click();
  await expect.poll(count).toBe('2 个事件');
  await (await searchWindow(app)).getByRole('button',{name:'区分大小写',exact:true}).click();
  await expect.poll(count).toBe('1 个事件');
  await (await searchWindow(app)).getByRole('button',{name:'区分大小写',exact:true}).click();
  await (await searchWindow(app)).getByRole('button',{name:'全词匹配',exact:true}).click();
  await expect.poll(count).toBe('3 个事件');
  // A second document joins the results only when the scope covers open files.
  await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();
  await expect(page.locator('.file-tab')).toHaveCount(2);
  await expect(page.locator('.file-tab.active .tab-name')).toContainText(/\d{8}_\d+/);
  const fresh=page.locator('.document-scroller[data-active] .todo-document p').first();
  await expect(fresh).toBeVisible();await fresh.click();await page.keyboard.type('另一个文件里的 plan');
  await page.locator('.file-tab').first().click();
  await expect.poll(count).toBe('3 个事件');
  await (await searchWindow(app)).getByRole('button',{name:'所有打开文件',exact:true}).click();
  await expect.poll(count).toBe('4 个事件 · 2 个文件');
  for(let step=0;step<5&&(await page.locator('.file-tab.active .tab-name').innerText()).includes('功能对照');step++)
    await (await searchWindow(app)).getByRole('button',{name:'下一个搜索结果',exact:true}).click();
  await expect(page.locator('.file-tab.active .tab-name')).not.toContainText('功能对照');
  await expect((await searchWindow(app)).locator('.search-bar')).toBeVisible();
  await expect((await searchWindow(app)).getByRole('textbox',{name:'搜索内容'})).toHaveValue('plan');
  await expect(page.locator('.todo-document:visible .search-match')).toHaveCount(1);
});

test('cutting part of a line pastes back into the same line',async()=>{
  const first=page.locator('.todo-document p').first();
  const blocks=()=>page.locator('.todo-document').evaluate((el:any)=>el.editor.state.doc.content.content.length);
  const before=await blocks();
  await first.click();await page.keyboard.press('Home');
  for(let i=0;i<3;i++)await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Control+x');
  await expect(first).toHaveText('：完成界面设计');
  await page.keyboard.press('Control+v');
  await expect(first).toHaveText('目标一：完成界面设计');
  expect(await blocks()).toBe(before);
});

test('tabs follow their file name and the workbench keeps its lists compact',async()=>{
  const width=()=>page.locator('.file-tab.active').evaluate(el=>el.getBoundingClientRect().width);
  const clipped=()=>page.locator('.file-tab.active .tab-name span').first().evaluate((el:HTMLElement)=>el.scrollWidth-el.clientWidth);
  expect(await page.locator('.tabs').evaluate(el=>el.getBoundingClientRect().height)).toBeLessThanOrEqual(32);
  const short=await width();
  expect(short).toBeLessThan(150);
  expect(await clipped()).toBeLessThanOrEqual(0);
  await page.locator('.file-tab').first().click({button:'right'});
  await page.getByRole('button',{name:'重命名…',exact:true}).click();
  await page.getByRole('textbox',{name:'新文件名'}).fill('一个明显更长的文件名');
  await page.getByRole('textbox',{name:'新文件名'}).press('Enter');
  await expect(page.locator('.file-tab.active .tab-name')).toContainText('一个明显更长的文件名');
  expect(await width()).toBeGreaterThan(short+40);
  expect(await clipped()).toBeLessThanOrEqual(0);
  // The save-state dot keeps its slot, so a save does not resize the tab.
  const dot=page.locator('.file-tab.active .dirty-dot');
  const saved=await width();
  await page.locator('.todo-document p').first().click();await page.keyboard.type('改');
  await expect(dot).not.toHaveClass(/saved/);
  expect(await width()).toBe(saved);
  expect(await clipped()).toBeLessThanOrEqual(0);
  await expect(dot).toHaveClass(/saved/,{timeout:15000});
  expect(await width()).toBe(saved);
  const bold=await page.evaluate(()=>{
    const size=document.querySelector('.toolbar-size')!.getBoundingClientRect();
    const button=document.querySelector('button[title^="加粗"]')!.getBoundingClientRect();
    return {size:size.right,bold:button.left};
  });
  expect(bold.size).toBeLessThanOrEqual(bold.bold);
  await page.getByRole('button',{name:'全部事件',exact:true}).click();
  await expect(page.locator('.event-panel-row')).toHaveCount(4);
});

test('a divider takes over an empty line unless the next line starts an event',async()=>{
  const blocks=()=>page.locator('.todo-document').evaluate((el:any)=>el.editor.state.doc.content.content.map((node:any)=>node.type.name==='divider'?'—':node.textContent));
  await page.locator('.todo-document p').nth(1).click();await page.keyboard.press('End');
  await page.keyboard.press('Enter');await page.keyboard.press('Enter');
  const before=await blocks();
  // Put the caret on the first of the two blank lines, so the line below it is
  // another blank line rather than the next event.
  await page.locator('.todo-document').evaluate((el:any)=>{const {state}=el.editor;let at=-1;state.doc.forEach((node:any,pos:number,index:number)=>{if(at<0&&node.type.name==='paragraph'&&!node.content.size&&state.doc.maybeChild(index+1)?.type.name==='paragraph')at=pos+1;});el.editor.commands.focus(at);});
  await page.keyboard.press('Control+h');
  const inPlace=await blocks();
  expect(inPlace).toHaveLength(before.length);
  expect(inPlace.filter((b:string)=>b==='—')).toHaveLength(before.filter((b:string)=>b==='—').length+1);
  expect(inPlace.filter((b:string)=>b==='')).toHaveLength(before.filter((b:string)=>b==='').length-1);
  // The last empty line of an event keeps the old behaviour: the event that
  // follows must not lose its own body line.
  await page.keyboard.press('Control+h');
  const beside=await blocks();
  expect(beside).toHaveLength(inPlace.length+1);
});
