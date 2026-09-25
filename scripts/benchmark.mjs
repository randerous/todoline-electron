import { _electron } from '@playwright/test';
import { build } from 'esbuild';
import { createRequire } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url);
const root=path.resolve('.cache/benchmark');await fs.mkdir(root,{recursive:true});
const file=path.join(root,'fixed-5000.tde');
if(path.dirname(file)!==root)throw new Error('Invalid benchmark path');
for(const suffix of ['', '-wal', '-shm'])await fs.rm(file+suffix,{force:true});
await build({entryPoints:['src/main/storage.ts'],outfile:path.join(root,'storage.cjs'),bundle:true,platform:'node',format:'cjs',external:['better-sqlite3']});
const {DocumentStore}=require(path.join(root,'storage.cjs'));const store=new DocumentStore();const doc=store.open(file,true);
await store.save({handle:doc.handle,revision:doc.revision,events:Array.from({length:5000},(_,i)=>{const text=`固定样本事件 ${String(i).padStart(4,'0')}：检查文件、记录想法和下一步安排。`;return {id:-(i+1),pos:i*1024,created_at:1750000000+i*60,deadline_raw:'',deadline_ts:null,done:0,content_html:`<p>${text}</p>`,content_text:text,top_divider:i===0?1:0};})});store.close(doc.handle);
const env={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:path.join(root,'profile')};delete env.ELECTRON_RUN_AS_NODE;
const started=performance.now();const app=await _electron.launch({args:[path.resolve('.'),'--open',file],env,timeout:60000});
try{
  const page=await app.firstWindow();await app.evaluate(({BrowserWindow})=>{const win=BrowserWindow.getAllWindows()[0];win.show();win.focus();});await page.locator('.todo-document[contenteditable=true]').waitFor({timeout:60000});
  const firstEditableMs=performance.now()-started;
  await page.locator('.todo-document').evaluate(el=>{el.focus();const editor=el.editor;editor.commands.setTextSelection(2);window.__latencies=[];el.addEventListener('keydown',e=>{if(e.key.length===1){const start=performance.now();requestAnimationFrame(()=>window.__latencies.push(performance.now()-start));}});});
  await page.keyboard.type('abcdefghijklmnopqrstuvwxyz'.repeat(3),{delay:18});
  await page.evaluate(()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r))));
  const latency=await page.evaluate(()=>window.__latencies.sort((a,b)=>a-b));
  const search=await page.evaluate(async()=>{const session=await window.desktop.session();const doc=await window.desktop.openRecent(session.tabs[0].path);const start=performance.now();const hits=await window.desktop.search(doc.handle,'事件 4999');return {ms:performance.now()-start,hits:hits.length};});
  const memory=await app.evaluate(({app})=>app.getAppMetrics().map(m=>({type:m.type,workingSetKB:m.memory.workingSetSize,peakWorkingSetKB:m.memory.peakWorkingSetSize})));
  const scroll=await page.evaluate(async()=>{const el=document.querySelector('.document-scroller');const start=performance.now();let frames=0;for(let i=0;i<30;i++){el.scrollTop=i/29*(el.scrollHeight-el.clientHeight);await new Promise(r=>requestAnimationFrame(r));frames++;}return {frames,ms:performance.now()-start};});
  const results={sample:{events:5000,paragraphs:5000,images:0},firstEditableMs,keyP95Ms:latency[Math.floor(latency.length*.95)],keySamples:latency.length,search,memory,totalWorkingSetMB:memory.reduce((n,m)=>n+m.workingSetKB/1024,0),scroll,timestamp:new Date().toISOString()};
  await fs.writeFile(path.join(root,'electron-results.json'),JSON.stringify(results,null,2));console.log(JSON.stringify(results,null,2));
}finally{await app.evaluate(({app})=>app.exit(0));}
