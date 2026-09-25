import { _electron,expect,test,type ElectronApplication,type Page } from '@playwright/test';
import path from 'node:path';
import fs from 'node:fs/promises';
import { spawn,execFileSync } from 'node:child_process';
let app:ElectronApplication,page:Page;
test.beforeEach(async({},info)=>{const profile=info.outputPath('profile');await fs.mkdir(profile,{recursive:true});const env:NodeJS.ProcessEnv={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;app=await _electron.launch({args:[path.resolve('.')],env:env as Record<string,string>});page=await app.firstWindow();await expect(page.locator('.app')).toBeVisible();});
test.afterEach(async()=>{await app?.evaluate(({app})=>app.exit(0)).catch(()=>{});});
test('one copy retains native text, HTML, original image and custom events until the next copy',async()=>{
  const png=await app.evaluate(({nativeImage})=>Array.from(nativeImage.createFromBitmap(Buffer.alloc(12*7*4,255),{width:12,height:7}).toPNG()));
  await page.evaluate(async png=>window.desktop.copy({text:'中文\n内容',html:'<b>中文🙂</b>',externalHtml:'<b>中文🙂</b>',events:'{"events":[]}',image:new Uint8Array(png)}),png);
  const state=await app.evaluate(({clipboard})=>({text:clipboard.readText(),html:clipboard.readHTML(),image:clipboard.readImage().getSize(),custom:clipboard.readBuffer('application/x-tde-events').toString('utf8')}));expect(state.text).toBe('中文\n内容');expect(state.html).toContain('<b>中文🙂</b>');expect(state.image).toEqual({width:12,height:7});expect(state.custom).toBe('{"events":[]}');
  await page.evaluate(()=>window.desktop.copy({text:'下一次复制'}));expect(await app.evaluate(({clipboard})=>({text:clipboard.readText(),image:clipboard.readImage().isEmpty(),custom:clipboard.readBuffer('application/x-tde-events').length,html:clipboard.readHTML()}))).toEqual({text:'下一次复制',image:true,custom:0,html:''});
});
test('malformed native packets fail before clearing the previous clipboard',async()=>{
  await page.evaluate(()=>window.desktop.copy({text:'必须保留'}));const code=await new Promise<number|null>((resolve,reject)=>{const child=spawn(path.resolve('out/main/clipboard-win.exe'),[],{windowsHide:true,stdio:['pipe','ignore','ignore']});child.once('error',reject);child.once('exit',resolve);child.stdin.on('error',()=>{});child.stdin.end(Buffer.from('invalid packet'));});expect(code).toBe(2);expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe('必须保留');
});
test('an immediate IPC read waits for a native copy already requested',async()=>{
  await page.evaluate(()=>window.desktop.copy({text:'previous'}));
  const result=await page.evaluate(async()=>{const copying=window.desktop.copy({text:'fresh 中文',html:'<b>fresh 中文</b>',events:'{"events":[]}'}),reading=window.desktop.readClipboard();await copying;return reading;});
  expect(result.text).toBe('fresh 中文');expect(result.html).toContain('<b>fresh 中文</b>');expect(result.events).toBe('{"events":[]}');
});
test('copy waits for a brief lock held by another process before confirming success',async({},info)=>{
  const executable=info.outputPath('clipboard-lock.exe'),compiler=process.env.CC||'E:\\Qt\\Tools\\mingw1310_64\\bin\\gcc.exe';execFileSync(compiler,[path.resolve('tests/fixtures/clipboard-lock.c'),'-o',executable,'-luser32'],{windowsHide:true,env:{...process.env,PATH:path.dirname(compiler)+path.delimiter+process.env.PATH}});
  const holder=spawn(executable,[],{windowsHide:true,stdio:['ignore','pipe','ignore']});
  try{await new Promise<void>((resolve,reject)=>{holder.stdout.once('data',data=>String(data).includes('ready')?resolve():reject(new Error('Clipboard lock not acquired')));holder.once('error',reject);holder.once('exit',code=>{if(code!==0)reject(new Error('Clipboard holder failed: '+code));});});
    await page.evaluate(()=>window.desktop.copy({text:'等待占用释放后复制',html:'<b>已复制</b>'}));expect(await app.evaluate(({clipboard})=>clipboard.readText())).toBe('等待占用释放后复制');
  }finally{if(holder.exitCode===null)holder.kill();}
});
