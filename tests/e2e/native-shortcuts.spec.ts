import {searchWindow} from './search-window';
import {_electron,expect,test} from '@playwright/test';
import fs from 'node:fs/promises';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DocumentStore} from '../../src/main/storage';
test('Windows native menu accelerators create, save, search, close and open documents',async({},info)=>{
  const root=info.outputPath('workspace');await fs.mkdir(root,{recursive:true});const file=path.join(root,'原生快捷键.tde'),store=new DocumentStore(),doc=store.open(file,true);store.close(doc.handle);
  const helper=path.join(root,'native-keys.exe'),compiler='E:/Qt/Tools/mingw1310_64/bin/gcc.exe';execFileSync(compiler,['-std=c11','-O2','-s','-static','tests/fixtures/native-keys.c','-luser32','-o',helper],{windowsHide:true,env:{...process.env,PATH:path.dirname(compiler)+';'+process.env.PATH}});
  const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;const app=await _electron.launch({args:[path.resolve('.')],env:env as Record<string,string>});
  try{const page=await app.firstWindow();await page.getByRole('button',{name:'新建文档 · Ctrl+N',exact:true}).waitFor();await page.evaluate(()=>{(window as any).nativeCommands=[];window.desktop.onCommand(command=>(window as any).nativeCommands.push(command));});
    const ownerId=await app.evaluate(({BrowserWindow})=>BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().endsWith('index.html'))!.id);
    const key=async(value:string)=>{const target=await app.evaluate(({BrowserWindow},id)=>{const win=BrowserWindow.fromId(id)!;win.show();win.focus();const handle=win.getNativeWindowHandle();return {handle:handle.length===8?handle.readBigUInt64LE().toString():String(handle.readUInt32LE()),pid:process.pid};},ownerId);execFileSync(helper,[target.handle,String(target.pid),value],{windowsHide:true});};
    await key('N');await expect(page.locator('.file-tab')).toHaveCount(1);await page.locator('.todo-document').focus();await page.keyboard.type('native shortcut');await key('S');await expect.poll(()=>page.evaluate(()=>(window as any).nativeCommands.includes('save'))).toBe(true);
    await key('F');await expect((await searchWindow(app)).getByRole('textbox',{name:'搜索内容'})).toBeVisible();const floating=await searchWindow(app);await floating.keyboard.press('Escape').catch(error=>{if(!floating.isClosed())throw error;});await expect.poll(()=>app.windows().some(p=>p.url()==='about:blank')).toBe(false);await key('W');await expect(page.locator('.file-tab')).toHaveCount(0);
    await app.evaluate(({dialog},file)=>{dialog.showOpenDialog=async()=>({canceled:false,filePaths:[file]});},file);await key('O');await expect(page.locator('.file-tab.active')).toContainText('原生快捷键');expect(await page.evaluate(()=>(window as any).nativeCommands)).toEqual(['new','save','search','closeTab','open']);
    await page.screenshot({path:info.outputPath('native-shortcuts.png')});
  }finally{await app.evaluate(({app})=>app.exit(0));}
});
