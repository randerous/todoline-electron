import {_electron} from '@playwright/test';
import {build} from 'esbuild';
import {createRequire} from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

// Separate profiles keep user documents and the running user's session untouched.
const require=createRequire(import.meta.url);
const option=name=>process.argv.find(arg=>arg.startsWith(`--${name}=`))?.slice(name.length+3);
const application=path.resolve(option('app')??'.'),runs=Number(option('runs')??3),includeMarkdown=process.argv.includes('--markdown');
const baseline=option('baseline')?path.resolve(option('baseline')):undefined;
if(!Number.isInteger(runs)||runs<1||runs>20)throw new Error('Invalid run count');
const root=path.resolve('.cache/startup-benchmark');
await fs.mkdir(root,{recursive:true});
await build({entryPoints:['src/main/storage.ts'],outfile:path.join(root,'storage.cjs'),bundle:true,platform:'node',format:'cjs',external:['better-sqlite3'],logLevel:'silent'});
const {DocumentStore}=require(path.join(root,'storage.cjs'));
const samples=[];
const scenarios=[{name:'single-5000',tabs:1,events:5000},{name:'restore-4x1500',tabs:4,events:1500},...(includeMarkdown?[{name:'markdown-active',tabs:1,events:0,markdown:true},{name:'markdown-complex',tabs:1,events:0,markdown:true,complex:true},{name:'mixed-background-markdown',tabs:2,events:1500,backgroundMarkdown:true}]:[])];
for(const scenario of scenarios){
  const paths=[];
  for(let i=0;i<scenario.tabs;i++){
    const markdown=scenario.markdown||scenario.backgroundMarkdown&&i===0;
    const file=path.join(root,`${scenario.name}-${i}.${markdown?'md':'tde'}`);
    try{await fs.access(file);}catch{
      if(markdown){
        const sections=Array.from({length:scenario.complex?100:50},(_,j)=>`## 第 ${j} 节\n\nMarkdown 启动样本 ${j}。\n\n${scenario.complex?'$$\nx^2 + y^2 = z^2\n$$\n\n| 项 | 值 |\n| --- | --- |\n| a | b |\n\n':''}`);
        await fs.writeFile(file,'# Markdown 样本\n\n'+sections.join('\n'));
      }else{
      const store=new DocumentStore(),doc=store.open(file,true);
      await store.save({...doc,events:Array.from({length:scenario.events},(_,j)=>({id:-j-1,pos:j*1024,created_at:1750000000,deadline_raw:'',deadline_ts:null,done:0,top_divider:j===0?1:0,content_html:`<p>文件 ${i} 事件 ${j}：启动速度固定样本</p>`,content_text:`文件 ${i} 事件 ${j}：启动速度固定样本`}))});
      store.close(doc.handle);
      }
    }
    paths.push(file);
  }
  for(let run=0;run<runs;run++){
    const applications=baseline?(run%2?[application,baseline]:[baseline,application]):[application];
    for(const measuredApplication of applications){
    const profile=await fs.mkdtemp(path.join(root,'profile-'));
    await fs.writeFile(path.join(profile,'session.json'),JSON.stringify({tabs:paths.map(path=>({path,cursor:2,scroll:0})),active:paths.length-1,recent:paths,settings:{advanceMinutes:-1}}));
    const env={...process.env,TODOLINE_TEST:'1',TODOLINE_DATA_DIR:profile};delete env.ELECTRON_RUN_AS_NODE;
    const start=performance.now();
    const app=await _electron.launch({args:[measuredApplication],env,timeout:60000});
    try{
      const page=await app.firstWindow();
      await page.waitForFunction(name=>document.querySelector('.file-tab.active .tab-name')?.getAttribute('title')===name&&!!document.querySelector('.document-scroller[data-active] :is(.todo-document,.markdown-document)[contenteditable=true]'),paths.at(-1),{timeout:60000});
      const activeEditableMs=Math.round(performance.now()-start);
      await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve))));
      const paintedMs=Math.round(performance.now()-start);
      const editors=await page.locator('.todo-document,.markdown-document').count();
      const markdownResources=await page.evaluate(()=>[...new Set([...performance.getEntriesByType('resource').map(entry=>entry.name),...Array.from(document.querySelectorAll('link[href],script[src]'),node=>node.getAttribute('href')??node.getAttribute('src')??'')].filter(name=>/markdown-(editor|search)|katex-|markdown-highlight/.test(name)).map(name=>name.split('/').at(-1)))]);
      const memoryMB=await app.evaluate(({app})=>Math.round(app.getAppMetrics().reduce((sum,m)=>sum+m.memory.workingSetSize/1024,0)));
      const sample={scenario:scenario.name,run,...(baseline?{build:measuredApplication===baseline?'baseline':'current'}:{}),activeEditableMs,paintedMs,editors,memoryMB,markdownResources};samples.push(sample);console.log(JSON.stringify(sample));
    }finally{await app.evaluate(({app})=>app.exit(0));}
    }
  }
}
const output={timestamp:new Date().toISOString(),application,baseline,runs,samples};
const label=process.argv[2]??'latest';if(!/^[\w-]+$/.test(label))throw new Error('Invalid result label');
await fs.writeFile(path.join(root,`${label}.json`),JSON.stringify(output,null,2)+'\n');
