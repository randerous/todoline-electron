import fs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import type { DocumentSnapshot, EventRecord, SaveRequest } from '../shared/types';
const digest=(events:EventRecord[])=>createHash('sha256').update(JSON.stringify(events)).digest('hex');
export class RecoveryJournal{
  constructor(private root:string){}
  private file(docPath:string){return path.join(this.root,createHash('sha256').update(path.resolve(docPath).toLowerCase()).digest('hex')+'.json');}
  async stage(doc:DocumentSnapshot,request:SaveRequest){
    await fs.mkdir(this.root,{recursive:true});const file=this.file(doc.path),temp=file+'.tmp';
    const stream=await fs.open(temp,'w');try{await stream.writeFile(JSON.stringify({path:doc.path,base:digest(doc.events),events:request.events}),'utf8');await stream.sync();}finally{await stream.close();}
    await fs.rename(temp,file);
  }
  async clear(docPath:string){await fs.rm(this.file(docPath),{force:true});}
  async retire(docPath:string){
    const dir=path.join(this.root,'archived');await fs.mkdir(dir,{recursive:true});
    try{await fs.rename(this.file(docPath),path.join(dir,randomUUID()+'.json'));}
    catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')throw error;}
  }
  async recover(doc:DocumentSnapshot):Promise<{events:EventRecord[];conflict:boolean}|null>{
    let data:any;try{data=JSON.parse(await fs.readFile(this.file(doc.path),'utf8'));}catch{return null;}
    if(!Array.isArray(data.events)||!data.events.length||data.path!==doc.path)return null;
    // A crash after the COMMIT but before journal removal needs no replay.
    const clean=(events:EventRecord[])=>events.map(({id,...rest})=>rest);
    if(JSON.stringify(clean(doc.events))===JSON.stringify(clean(data.events))){await this.clear(doc.path);return null;}
    if(data.events.some((e:any)=>!Number.isSafeInteger(e.id)||typeof e.content_html!=='string'||typeof e.content_text!=='string'))return null;
    return {events:data.events,conflict:data.base!==digest(doc.events)};
  }
}
