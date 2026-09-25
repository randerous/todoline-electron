import {_electron,expect,test,type ElectronApplication,type Page} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {DocumentStore} from '../../src/main/storage';
let app:ElectronApplication,page:Page,root:string,profile:string,env:NodeJS.ProcessEnv;
test.beforeEach(async({},info)=>{root=info.outputPath('workspace');profile=path.join(root,'profile');await fs.mkdir(profile,{recursive:true});const paths:string[]=[];
  for(const name of ['甲','乙','丙','丁']){const store=new DocumentStore(),file=path.join(root,name+'.tde'),doc=store.open(file,true);await store.save({...doc,events:[{id:-1,pos:0,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:1,content_html:`<p>${name}的正文</p>`,content_text:`${name}的正文`}]});store.close(doc.handle);paths.push(file);}
  await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:paths.map(path=>({path,cursor:2,scroll:0})),active:1,recent:paths}));env={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
});
test.afterEach(async({},info)=>{if(info.status!==info.expectedStatus)await page?.screenshot({path:info.outputPath('failure.png')}).catch(()=>{});await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
async function launch(){app=await _electron.launch({args:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.file-tab')).toHaveCount(4);await expect(page.locator('.document-scroller:visible .todo-document')).toBeVisible();}
const names=()=>page.locator('.tab-name').allTextContents();
const editor=()=>page.locator('.document-scroller:visible .todo-document');
async function drag(from:number,to:number,after=false,release=true){const a=(await page.locator('.tab-name').nth(from).boundingBox())!,b=(await page.locator('.file-tab').nth(to).boundingBox())!;await page.mouse.move(a.x+a.width/2,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+(after?b.width-3:3),b.y+b.height/2,{steps:12});if(release)await page.mouse.up();}
test('dragging an inactive tab preserves the active editor, selection, undo and restored session',async()=>{
  await launch();await editor().locator('p').click();await page.keyboard.press('End');await page.keyboard.type(' 编辑');
  const dom=await editor().elementHandle();const selection=await editor().evaluate((el:any)=>({from:el.editor.state.selection.from,to:el.editor.state.selection.to}));
  await drag(0,3,true);await expect.poll(names).toEqual(['乙','丙','丁','甲']);await expect(page.locator('.file-tab.active')).toContainText('乙');expect(await dom!.evaluate(el=>el.isConnected)).toBe(true);expect(await editor().evaluate((el:any)=>({from:el.editor.state.selection.from,to:el.editor.state.selection.to}))).toEqual(selection);
  await expect(editor()).toBeFocused();await page.keyboard.press('Control+z');await expect(editor()).not.toContainText('编辑');
  await expect.poll(async()=>JSON.parse(await fs.readFile(path.join(profile,'session.json'),'utf8')).tabs.map((t:any)=>path.basename(t.path))).toEqual(['乙.tde','丙.tde','丁.tde','甲.tde']);
  await app.evaluate(({app})=>app.exit(0));await launch();await expect.poll(names).toEqual(['乙','丙','丁','甲']);await expect(page.locator('.file-tab.active')).toContainText('乙');
});
test('Escape and a drop outside the strip cancel without selecting the dragged tab',async()=>{
  await launch();await drag(0,3,true,false);await page.keyboard.press('Escape');await page.mouse.up();await expect.poll(names).toEqual(['甲','乙','丙','丁']);await expect(page.locator('.file-tab.active')).toContainText('乙');
  await drag(0,3,true,false);await page.mouse.move(450,300);await page.mouse.up();await expect.poll(names).toEqual(['甲','乙','丙','丁']);await expect(page.locator('.file-tab.active')).toContainText('乙');
});
test('active tab can move left, then rename and close the intended file',async()=>{
  await launch();await drag(1,0);await expect.poll(names).toEqual(['乙','甲','丙','丁']);await expect(page.locator('.file-tab').first()).toHaveClass(/active/);
  await page.locator('.tab-name').first().dblclick();await page.getByRole('textbox',{name:'新文件名'}).fill('已排序');await page.getByRole('textbox',{name:'新文件名'}).press('Enter');await expect(page.locator('.tab-name').first()).toContainText('已排序');
  await page.getByRole('button',{name:'关闭 已排序.tde',exact:true}).click();await expect.poll(names).toEqual(['甲','丙','丁']);await expect(editor()).toContainText('甲的正文');
});
test('dragging near the edge scrolls overflowing tabs and exposes the insertion marker',async({},info)=>{
  await launch();await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.setSize(800,680);win.show();win.focus();});
  for(let i=0;i<6;i++)await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).click();
  const strip=page.locator('.tabs-scroll'),a=(await page.locator('.tab-name').first().boundingBox())!,b=(await strip.boundingBox())!;
  await page.mouse.move(a.x+20,a.y+a.height/2);await page.mouse.down();await page.mouse.move(b.x+b.width-3,b.y+b.height/2,{steps:10});
  await expect.poll(()=>strip.evaluate(el=>el.scrollLeft)).toBeGreaterThan(80);await expect(page.locator('[data-drop]')).toHaveCount(1);
  const marker=await strip.evaluate(el=>{const box=el.getBoundingClientRect(),style=getComputedStyle(el,'::after');return {left:parseFloat(style.left),height:parseFloat(style.height),min:box.left,max:box.right};});expect(marker.left).toBeGreaterThanOrEqual(marker.min);expect(marker.left+3).toBeLessThanOrEqual(marker.max);expect(marker.height).toBeGreaterThan(8);
  await page.screenshot({path:info.outputPath('tab-drag.png')});await page.mouse.up();
  await expect.poll(async()=>(await names()).indexOf('甲')).toBeGreaterThan(3);await expect(page.locator('[data-drop]')).toHaveCount(0);
});
