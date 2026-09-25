// @vitest-environment node
import {afterEach,beforeEach,expect,it,vi} from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {ReminderSchedule,reminderKey,SNOOZE_MS,reminderTime} from '../src/main/reminders';
import type {DocumentSnapshot,EventRecord} from '../src/shared/types';
let root:string,file:string;
const due=1800000000,now=due*1000;
const event:EventRecord={id:1,pos:0,created_at:due-3600,deadline_raw:'',deadline_ts:due,done:0,top_divider:0,content_html:'<p>提醒</p>',content_text:'提醒'};
const doc:DocumentSnapshot={handle:'one',path:'E:\\Notes\\计划.tde',name:'计划.tde',revision:1,events:[event]};
beforeEach(()=>{root=fs.mkdtempSync(path.join(os.tmpdir(),'todoline-reminders-'));file=path.join(root,'reminders.json');});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
it('recovers an unconsumed delivery with a new document handle and consumes it durably',()=>{
  const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],5,now);
  expect(schedule.collect([doc],5,now+1)).toEqual([]);
  const reopened={...doc,handle:'reopened',path:'e:/notes/计划.tde'},restored=new ReminderSchedule(file);
  expect(restored.collect([reopened],5,now+2)).toEqual([]);expect(restored.active([reopened])[0]).toMatchObject({id:notice.id,handle:'reopened'});
  restored.dismiss(notice.id);const again=new ReminderSchedule(file);expect(again.active([doc])).toEqual([]);expect(again.collect([doc],5,now+3)).toEqual([]);
});
it('does not mark a reminder seen when its atomic file replacement fails',()=>{
  const schedule=new ReminderSchedule(file),rename=vi.spyOn(fs,'renameSync').mockImplementation(()=>{throw new Error('disk full');});
  expect(()=>schedule.collect([doc],5,now)).toThrow('disk full');expect(schedule.seen.size).toBe(0);expect(schedule.active([doc])).toEqual([]);
  rename.mockRestore();expect(schedule.collect([doc],5,now)).toHaveLength(1);
});
it('failed snooze and dismiss retain the current delivery and survive restart',()=>{
  const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],5,now);
  const original=fs.renameSync,rename=vi.spyOn(fs,'renameSync').mockImplementation((from,to)=>{if(to===file)throw new Error('locked');return original(from,to);});
  expect(()=>schedule.snooze(notice.key,now,notice.id)).toThrow('locked');expect(()=>schedule.dismiss(notice.id)).toThrow('locked');
  expect(schedule.active([doc])[0].id).toBe(notice.id);expect(new ReminderSchedule(file).active([doc])[0].id).toBe(notice.id);
  rename.mockRestore();schedule.snooze(notice.key,now,notice.id);expect(schedule.active([doc])).toEqual([]);
});
it('preserves an overdue snooze through long sleep and unrelated reminder writes',()=>{
  const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],5,now);schedule.snooze(notice.key,now,notice.id);
  const later=now+4*86400000,other={...doc,path:'E:\\other.tde',events:[{...event,deadline_ts:later/1000}]};
  schedule.collect([other],0,later);const restored=new ReminderSchedule(file);
  expect(restored.collect([doc],0,later)).toHaveLength(1);expect(restored.collect([doc],0,later+1)).toEqual([]);
});
it('snoozes ten minutes, does not refire after a clock rollback and rejects stale actions',()=>{
  const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],5,now);schedule.snooze(notice.key,now,notice.id);
  expect(schedule.collect([doc],5,now-3600000)).toEqual([]);expect(schedule.collect([doc],5,now+SNOOZE_MS-1)).toEqual([]);
  const [next]=schedule.collect([doc],5,now+SNOOZE_MS);expect(next.id).not.toBe(notice.id);
  expect(()=>schedule.snooze(notice.key,now+SNOOZE_MS,notice.id)).toThrow('已处理');expect(schedule.active([doc])[0].id).toBe(next.id);
});
it('cancels obsolete deliveries and snoozes when completion, deletion or deadline changes are saved',()=>{
  for(const events of [[],[{...event,done:1}],[{...event,deadline_ts:due+10000}]]){
    const schedule=new ReminderSchedule(),[notice]=schedule.collect([doc],0,now);schedule.snooze(notice.key,now,notice.id);
    const edited={...doc,events};schedule.collect([edited],0,now);expect(schedule.snoozed.size).toBe(0);expect(schedule.active([edited])).toEqual([]);
  }
  const schedule=new ReminderSchedule();schedule.collect([doc],0,now);schedule.collect([{...doc,events:[]}],0,now);expect(schedule.active([doc])).toEqual([]);
});
it('keeps unopened documents pending and presents all due events in stable order',()=>{
  const schedule=new ReminderSchedule(file),many={...doc,events:Array.from({length:50},(_,i)=>({...event,id:i+1,deadline_ts:due-i}))};
  expect(schedule.collect([many],0,now)).toHaveLength(50);expect(schedule.active([many])[0].eventId).toBe(50);
  schedule.collect([],0,now);expect(schedule.active([])).toEqual([]);expect(new ReminderSchedule(file).active([many])).toHaveLength(50);
});
it('validates damaged fields independently and preserves the original bytes',()=>{
  const key=reminderKey(doc,event),raw=JSON.stringify({seen:[key,42,null],snoozed:[[key,now+SNOOZE_MS],null,['bad','oops']],pending:[]});fs.writeFileSync(file,raw);
  const schedule=new ReminderSchedule(file);expect(schedule.seen.has(key)).toBe(true);expect(schedule.snoozed.get(key)).toBe(now+SNOOZE_MS);expect(schedule.warning).toContain('损坏');
  const preserved=fs.readdirSync(root).find(n=>n.includes('.corrupt-'))!;expect(fs.readFileSync(path.join(root,preserved),'utf8')).toBe(raw);
});
it('uses the valid backup after a truncated primary and refuses to overwrite if preservation fails',()=>{
  const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],0,now);schedule.dismiss(notice.id);fs.writeFileSync(file,'{truncated');
  const restored=new ReminderSchedule(file);expect(restored.active([doc])[0].id).toBe(notice.id);expect(restored.warning).toContain('备份');
  vi.spyOn(fs,'copyFileSync').mockImplementation(()=>{throw new Error('denied');});const blocked=new ReminderSchedule(file);
  expect(()=>blocked.dismiss(notice.id)).toThrow('尚未备份');expect(fs.readFileSync(file,'utf8')).toBe('{truncated');
});
it('migrates legacy mixed-case keys and tolerates malformed collection shapes',()=>{
  fs.writeFileSync(file,JSON.stringify({seen:[`${doc.path}:1:${due}`],snoozed:[]}));expect(new ReminderSchedule(file).collect([{...doc,path:'e:/notes/计划.tde'}],0,now)).toEqual([]);
  fs.writeFileSync(file,JSON.stringify({seen:[],snoozed:{bad:true}}));const schedule=new ReminderSchedule(file);expect(schedule.collect([doc],0,now)).toHaveLength(1);
});
it('adjusting advance triggers a future event only once and catch-up stops at 24 hours',()=>{
  const future={...doc,events:[{...event,deadline_ts:due+600}]},schedule=new ReminderSchedule();
  expect(schedule.collect([future],5,now)).toEqual([]);expect(schedule.collect([future],10,now)).toHaveLength(1);expect(schedule.collect([future],20,now)).toEqual([]);
  expect(new ReminderSchedule().collect([doc],0,now+86400000)).toHaveLength(1);expect(new ReminderSchedule().collect([doc],0,now+86400001)).toEqual([]);
});
it('a clock jump forward and back cannot erase deduplication for an open document',()=>{
  const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],0,now);schedule.dismiss(notice.id);
  schedule.collect([doc],0,now+5*86400000);expect(schedule.collect([doc],0,now)).toEqual([]);
});
it('copies seen, snoozed and pending reminders to remapped event IDs without linking dismissal',()=>{
  const schedule=new ReminderSchedule(file),source={...doc,events:[event,{...event,id:2},{...event,id:3}]};const notices=schedule.collect([source],0,now);
  schedule.dismiss(notices[0].id);schedule.snooze(notices[1].key,now,notices[1].id);
  const target={...source,path:'E:\\copy.tde',handle:'copy',events:source.events.map(e=>({...e,id:e.id+100}))};schedule.copyDocument(source,target);
  const restored=new ReminderSchedule(file);expect(restored.collect([target],0,now)).toEqual([]);expect(restored.pendingSnoozes(target,now)).toEqual([102]);
  const pending=restored.active([target]);expect(pending).toHaveLength(1);expect(pending[0].eventId).toBe(103);expect(pending[0].id).not.toBe(notices[2].id);
  restored.dismiss(pending[0].id);expect(restored.active([source])[0].id).toBe(notices[2].id);
});
it('migration failure preserves source records and can retry without duplicate target reminders',()=>{
  const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],0,now),target={...doc,path:'E:\\new.tde'};
  const rename=vi.spyOn(fs,'renameSync').mockImplementation(()=>{throw new Error('denied');});expect(()=>schedule.copyDocument(doc,target)).toThrow('denied');
  expect(schedule.active([doc])[0].id).toBe(notice.id);expect(schedule.active([target])).toEqual([]);rename.mockRestore();schedule.copyDocument(doc,target);schedule.forgetDocument(doc.path);
  expect(schedule.active([doc])).toEqual([]);expect(new ReminderSchedule(file).active([target])).toHaveLength(1);
});
it('replacing a file clears stale target identities but copying to the same case-insensitive path is a no-op',()=>{
  const schedule=new ReminderSchedule(file),target={...doc,path:'E:\\other.tde'},[notice]=schedule.collect([target],0,now);schedule.dismiss(notice.id);
  schedule.copyDocument(doc,target);expect(schedule.collect([target],0,now)).toHaveLength(1);
  const id=schedule.active([target])[0].id;schedule.copyDocument(target,{...target,path:'e:/OTHER.tde'});expect(schedule.active([target])[0].id).toBe(id);
});

it.each([['5分钟',300000],['2小时',7200000],['3天后',259200000],['半小时',1800000]])('snoozes a custom duration %s durably and delivers exactly when due',(raw,delay)=>{
 const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],0,now);schedule.snooze(notice.key,now,notice.id,String(raw));
 expect(schedule.snoozed.get(notice.key)).toBe(now+Number(delay));const restored=new ReminderSchedule(file);expect(restored.collect([doc],0,now+Number(delay)-1)).toEqual([]);expect(restored.collect([doc],0,now+Number(delay))).toHaveLength(1);
});
it.each(['','随便','0分钟','-1小时','昨天',null,123])('rejects invalid snooze %s without consuming the notice',raw=>{
 const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],0,now);expect(()=>schedule.snooze(notice.key,now,notice.id,raw as string)).toThrow('未来的提醒时间');expect(schedule.active([doc])[0].id).toBe(notice.id);expect(schedule.snoozed.size).toBe(0);
});

it('reserves the new event deadline without early delivery, including after restart',()=>{
 vi.spyOn(Date,'now').mockReturnValue(now);const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],5,now),due=now/1000+60;
 schedule.preparePostpone(notice,due);expect(schedule.active([doc])[0].id).toBe(notice.id);
 const changed={...doc,events:[{...event,deadline_raw:'1分钟后',deadline_ts:due}]};schedule.dismiss(notice.id);
 const restored=new ReminderSchedule(file);expect(restored.collect([changed],5,now+1)).toEqual([]);expect(restored.collect([changed],5,now+59999)).toEqual([]);expect(restored.collect([changed],5,now+60000)).toHaveLength(1);
});
it('abandons an unused reservation after a failed event save while retaining the original reminder',()=>{
 vi.spyOn(Date,'now').mockReturnValue(now);const schedule=new ReminderSchedule(file),[notice]=schedule.collect([doc],5,now);schedule.preparePostpone(notice,now/1000+86400);schedule.collect([doc],5,now);expect(schedule.snoozed.size).toBe(0);expect(schedule.active([doc])[0].id).toBe(notice.id);
});
it('uses complete editable deadline text, adding 后 only when omitted from a duration',()=>{expect(reminderTime('1天后',now)).toEqual({raw:'1天后',ts:now/1000+86400});expect(reminderTime('10分钟',now)).toEqual({raw:'10分钟后',ts:now/1000+600});expect(reminderTime(undefined,now).raw).toBe('10分钟后');});
