import {_electron} from '@playwright/test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';
const require=createRequire(import.meta.url),option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const label=process.argv[2]??'latest',runs=Number(option('runs')??3);if(!/^[\w-]+$/.test(label)||!Number.isInteger(runs)||runs<1||runs>15)throw Error('Invalid benchmark options');
const root=path.resolve('.cache/startup-visible');await fs.mkdir(root,{recursive:true});
await build({entryPoints:['src/main/storage.ts'],outfile:path.join(root,'storage.cjs'),bundle:true,platform:'node',format:'cjs',external:['better-sqlite3'],logLevel:'silent'});
const {DocumentStore}=require(path.join(root,'storage.cjs'));
const cases=[{name:'empty',tabs:0,events:0},{name:'single-small',tabs:1,events:30},{name:'single-5000',tabs:1,events:5000},{name:'restore-4x1500',tabs:4,events:1500},{name:'markdown',tabs:1,markdown:true}].filter(c=>!option('cases')||option('cases').split(',').includes(c.name));
const applications=[...(option('baseline-exe')?[{name:'baseline',exe:path.resolve(option('baseline-exe'))}]:[]),{name:'current',exe:option('exe')?path.resolve(option('exe')):undefined,app:path.resolve(option('app')??'.')}];
const samples=[];
for(const scenario of cases){
 const files=[];
 for(let i=0;i<scenario.tabs;i++){
  const file=path.join(root,`${scenario.name}-${i}.${scenario.markdown?'md':'tde'}`);files.push(file);
  if(await fs.stat(file).then(()=>true,()=>false))continue;
  if(scenario.markdown)await fs.writeFile(file,'# 启动测试\n\n'+Array.from({length:80},(_,j)=>`## 第 ${j+1} 节\n\n这是具有 **加粗** 和 [链接](https://example.com) 的正文。\n\n`).join(''));
  else {const store=new DocumentStore(),doc=store.open(file,true);await store.save({...doc,events:Array.from({length:scenario.events},(_,j)=>({id:-j-1,pos:j*1024,created_at:1700000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:j===0?1:0,content_html:`<p>文件 ${i}，事件 ${j}：启动速度样本。</p>`,content_text:`文件 ${i}，事件 ${j}：启动速度样本。`}))});store.close(doc.handle);}
 }
 for(let run=0;run<runs;run++)for(const application of run%2?[...applications].reverse():applications){
  const profile=await fs.mkdtemp(path.join(root,'profile-'));await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:files.map(path=>({path,cursor:2,scroll:0})),active:Math.max(0,files.length-1),recent:files,settings:{advanceMinutes:-1}}));
  const env={...process.env,TODOLINE_TEST:'0',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
  const start=performance.now();const app=await _electron.launch({...(application.exe?{executablePath:application.exe}:{}),args:application.exe?[]:[application.app],env,timeout:60000});
  try{
   const connectedMs=performance.now()-start,page=await app.firstWindow();
   await app.evaluate(({BrowserWindow})=>{const main=BrowserWindow.getAllWindows().find(w=>w.webContents.getURL().includes('index.html'))??BrowserWindow.getAllWindows()[0];main.show();main.focus();});
   let cdp;if(process.argv.includes('--profile')){cdp=await page.context().newCDPSession(page);await cdp.send('Profiler.enable');await cdp.send('Profiler.start');}
   await page.waitForFunction(file=>file?document.querySelector('.file-tab.active .tab-name')?.getAttribute('title')===file&&!!document.querySelector('.document-scroller[data-active] :is(.todo-document,.markdown-document)[contenteditable=true]'):!!document.querySelector('.welcome')&&!document.body.textContent.includes('正在恢复工作区'),files.at(-1),{timeout:60000,polling:20});
   const editableMs=performance.now()-start;await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));const paintedMs=performance.now()-start;
   if(cdp){const {profile:cpu}=await cdp.send('Profiler.stop');await fs.writeFile(path.join(root,`${label}-${application.name}-${scenario.name}-${run}.cpuprofile`),JSON.stringify(cpu));await cdp.detach();}
   const metrics=await page.evaluate(()=>({marks:performance.getEntriesByType('mark').map(e=>({name:e.name,start:e.startTime})),resources:performance.getEntriesByType('resource').map(e=>({name:e.name.split('/').at(-1),duration:e.duration,bytes:e.decodedBodySize})),editors:document.querySelectorAll('.todo-document,.markdown-document').length,domNodes:document.querySelectorAll('*').length}));
   const processes=await app.evaluate(({app})=>app.getAppMetrics().map(m=>({type:m.type,name:m.name,memoryMB:m.memory.workingSetSize/1024})));
   const sample={scenario:scenario.name,run,build:application.name,connectedMs:Math.round(connectedMs),editableMs:Math.round(editableMs),paintedMs:Math.round(paintedMs),...metrics,processes,memoryMB:Math.round(processes.reduce((n,p)=>n+p.memoryMB,0))};samples.push(sample);console.log(JSON.stringify({...sample,resources:undefined,processes:undefined}));
  }finally{await app.evaluate(({app})=>app.exit(0));}
 }
}
await fs.writeFile(path.join(root,label+'.json'),JSON.stringify({timestamp:new Date().toISOString(),runs,applications,samples,note:'Visible isolated windows; repeated launches with OS cache retained; includes Playwright connection overhead, not strict cold start.'},null,2));
