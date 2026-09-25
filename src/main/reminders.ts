import type { DocumentSnapshot, EventRecord, Notice } from '../shared/types';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import {parseDeadline} from '../shared/deadline';

const DAY=86400000;
export const SNOOZE_MS=10*60000;
export function reminderTime(raw:unknown='10分钟后',now=Date.now()){
  let text=typeof raw==='string'?raw.trim():'';
  if(/(?:秒钟|秒|分钟|分|小时|钟头|时|天|日|星期|周|礼拜|个月|月|年)$/.test(text))text+='后';
  const ts=text.length<=200?parseDeadline(text,new Date(now)):null;
  if(ts===null||ts<=Math.floor(now/1000))throw new Error('请输入未来的提醒时间，例如 10分钟后、2小时后、1天后。');
  return {raw:text,ts};
}
type Pending={key:string;id:string;createdAt:number};
type State={seen:Set<string>;snoozed:Map<string,number>;pending:Map<string,Pending>};
const fileKey=(file:string)=>path.win32.normalize(file).toLowerCase();
export const reminderKey=(doc:DocumentSnapshot,event:EventRecord)=>`${fileKey(doc.path)}:${event.id}:${event.deadline_ts}`;
function parsedKey(value:unknown){
  if(typeof value!=='string'||value.length>33000)return;
  const match=/^(.+):(-?\d+):(\d+)$/.exec(value);
  if(!match||!Number.isSafeInteger(Number(match[2]))||!Number.isSafeInteger(Number(match[3])))return;
  return {key:`${fileKey(match[1])}:${Number(match[2])}:${Number(match[3])}`,file:fileKey(match[1]),due:Number(match[3])};
}
const blank=():State=>({seen:new Set(),snoozed:new Map(),pending:new Map()});
const serialize=(s:State)=>JSON.stringify({version:2,seen:[...s.seen],snoozed:[...s.snoozed],pending:[...s.pending.values()]});
export class ReminderSchedule {
  private state=blank();
  private committed?:string;
  private preserveFailed=false;
  warning='';
  get seen(){return this.state.seen;}
  get snoozed(){return this.state.snoozed;}
  constructor(private file?:string){
    if(!file)return;
    for(const source of [file,file+'.bak']){
      let raw:string;
      try{raw=fs.readFileSync(source,'utf8');}catch(error){if((error as NodeJS.ErrnoException).code!=='ENOENT')this.warning='提醒记录无法读取，将尝试备用记录。';continue;}
      try{
        const data=JSON.parse(raw);if(!data||typeof data!=='object'||Array.isArray(data)||!Array.isArray(data.seen)||!Array.isArray(data.snoozed))throw new Error('Invalid reminder state');
        if(data.version!==undefined&&data.version!==2)throw new Error('Unknown reminder version');
        const next=blank();let invalid=false;
        for(const item of data.seen){const key=parsedKey(item);if(key)next.seen.add(key.key);else invalid=true;}
        for(const item of data.snoozed){const key=Array.isArray(item)&&parsedKey(item[0]),time=item?.[1];if(key&&typeof time==='number'&&Number.isSafeInteger(time)&&time>=0)next.snoozed.set(key.key,time);else invalid=true;}
        if(data.pending!==undefined&&!Array.isArray(data.pending))throw new Error('Invalid pending reminders');
        for(const item of data.pending??[]){const key=parsedKey(item?.key);if(key&&typeof item.id==='string'&&/^[\w-]{1,80}$/.test(item.id)&&Number.isSafeInteger(item.createdAt)&&item.createdAt>=0){next.pending.set(key.key,{key:key.key,id:item.id,createdAt:item.createdAt});next.seen.add(key.key);next.snoozed.delete(key.key);}else invalid=true;}
        if(invalid)this.preserve(source);
        this.state=next;this.committed=serialize(next);
        if(source.endsWith('.bak'))this.warning='提醒记录已恢复到上一份有效备份。';
        return;
      }catch{this.preserve(source);}
    }
  }
  private preserve(source:string){
    try{fs.copyFileSync(source,`${this.file}.corrupt-${randomUUID()}.json`,fs.constants.COPYFILE_EXCL);this.warning='损坏的提醒记录已保留，已恢复其中可用的数据。';}
    catch{this.preserveFailed=true;this.warning='提醒记录损坏且无法备份，请检查配置目录权限。';}
  }
  private clone():State{return {seen:new Set(this.state.seen),snoozed:new Map(this.state.snoozed),pending:new Map(this.state.pending)};}
  private commit(next:State){
    const content=serialize(next);if(content===serialize(this.state)&&!this.warning)return;
    if(this.file){
      if(this.preserveFailed)throw new Error('损坏的提醒记录尚未备份，暂不覆盖原文件。');
      fs.mkdirSync(path.dirname(this.file),{recursive:true});
      const write=(file:string,value:string)=>{const temp=file+'.tmp',fd=fs.openSync(temp,'w');try{fs.writeFileSync(fd,value);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}fs.renameSync(temp,file);};
      if(this.committed)write(this.file+'.bak',this.committed);
      write(this.file,content);
    }
    // A failed write must leave the previous live state retryable.
    this.state=next;this.committed=content;this.warning='';
  }
  collect(docs:DocumentSnapshot[],advance:number,now=Date.now()):Notice[]{
    if(!Number.isFinite(now))return [];
    const next=this.clone(),opened=new Set(docs.map(d=>fileKey(d.path))),valid=new Set<string>(),added=new Set<string>();
    for(const d of docs)for(const e of d.events)if(!e.done&&e.deadline_ts!==null&&Number.isSafeInteger(e.deadline_ts))valid.add(reminderKey(d,e));
    for(const map of [next.pending,next.snoozed])for(const key of map.keys())if(opened.has(parsedKey(key)!.file)&&!valid.has(key))map.delete(key);
    for(const key of next.seen)if(!opened.has(parsedKey(key)!.file)&&parsedKey(key)!.due*1000<now-2*DAY&&!next.pending.has(key)&&!next.snoozed.has(key))next.seen.delete(key);
    const lead=Number.isFinite(advance)?Math.max(0,Math.min(1440,advance))*60000:0;
    for(const d of docs)for(const e of d.events){
      const key=reminderKey(d,e);if(!valid.has(key)||next.pending.has(key))continue;
      const postponed=next.snoozed.get(key);
      if(postponed!==undefined){if(now<postponed)continue;}
      else if(next.seen.has(key)||now>e.deadline_ts!*1000+DAY||now<e.deadline_ts!*1000-lead)continue;
      next.snoozed.delete(key);next.seen.add(key);next.pending.set(key,{key,id:randomUUID(),createdAt:now});added.add(key);
    }
    this.commit(next);
    return this.active(docs).filter(n=>added.has(n.key));
  }
  active(docs:DocumentSnapshot[]):Notice[]{
    const result:Notice[]=[];
    for(const d of docs)for(const e of d.events){const key=reminderKey(d,e),p=this.state.pending.get(key);if(p&&!e.done&&e.deadline_ts!==null)result.push({id:p.id,key,handle:d.handle,eventId:e.id,text:e.content_text.trim().slice(0,180)||'（无正文内容）',due:e.deadline_ts,fileName:d.name,createdAt:p.createdAt});}
    return result.sort((a,b)=>a.createdAt-b.createdAt||a.due-b.due||a.key.localeCompare(b.key));
  }
  dismiss(id:string){const next=this.clone();for(const [key,p]of next.pending)if(p.id===id)next.pending.delete(key);this.commit(next);}
  copyDocument(source:DocumentSnapshot,target:DocumentSnapshot){
    if(fileKey(source.path)===fileKey(target.path))return;
    if(source.events.length!==target.events.length)throw new Error('提醒迁移失败：副本事件数量不一致。');
    const next=this.clone(),prefix=fileKey(target.path)+':';
    // The target may replace a previous file. Its former identities must not
    // suppress reminders belonging to the new document.
    for(const key of next.seen)if(key.startsWith(prefix))next.seen.delete(key);
    for(const map of [next.snoozed,next.pending])for(const key of map.keys())if(key.startsWith(prefix))map.delete(key);
    source.events.forEach((event,i)=>{
      const copy=target.events[i];if(event.deadline_ts===null||event.deadline_ts!==copy.deadline_ts)return;
      const old=reminderKey(source,event),key=reminderKey(target,copy);
      if(this.state.seen.has(old))next.seen.add(key);
      const time=this.state.snoozed.get(old);if(time!==undefined)next.snoozed.set(key,time);
      const p=this.state.pending.get(old);if(p)next.pending.set(key,{key,id:randomUUID(),createdAt:p.createdAt});
    });
    this.commit(next);
  }
  forgetDocument(file:string){
    const next=this.clone(),prefix=fileKey(file)+':';
    for(const key of next.seen)if(key.startsWith(prefix))next.seen.delete(key);
    for(const map of [next.snoozed,next.pending])for(const key of map.keys())if(key.startsWith(prefix))map.delete(key);
    this.commit(next);
  }
  snooze(key:string,now=Date.now(),id?:string,raw='10分钟'){
    const parsed=parsedKey(key);if(!parsed||!Number.isFinite(now))throw new Error('无效提醒');
    if(id&&this.state.pending.get(parsed.key)?.id!==id)throw new Error('这条提醒已处理或已更新。');
    const {ts:due}=reminderTime(raw,now);
    const next=this.clone();next.pending.delete(parsed.key);next.seen.add(parsed.key);next.snoozed.set(parsed.key,now+(due-Math.floor(now/1000))*1000);this.commit(next);
  }
  pendingSnoozes(doc:DocumentSnapshot,now=Date.now()){
    return doc.events.filter(e=>!e.done&&e.deadline_ts!==null&&(this.state.snoozed.get(reminderKey(doc,e))??0)>now).map(e=>e.id);
  }
  /** Reserve the new deadline before saving the event. Keep the original notice
   *  actionable until the editor acknowledges the save. */
  preparePostpone(notice:Notice,due:number){
    const parsed=parsedKey(notice.key);
    if(!parsed||this.state.pending.get(parsed.key)?.id!==notice.id)throw new Error('这条提醒已处理或已更新。');
    if(!Number.isSafeInteger(due)||due<=Date.now()/1000)throw new Error('提醒时间必须在未来。');
    const next=this.clone(),key=parsed.key.replace(/:\d+$/,':'+due);
    next.snoozed.set(key,due*1000);this.commit(next);
  }
}
