// @vitest-environment node
import { afterEach, beforeEach, expect, it } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RecoveryJournal } from '../src/main/recovery';
import { ReminderSchedule } from '../src/main/reminders';
import type { DocumentSnapshot, EventRecord } from '../src/shared/types';
let root:string;
const event:EventRecord={id:1,pos:0,created_at:100,deadline_raw:'',deadline_ts:2000,done:0,top_divider:1,content_html:'<p>original</p>',content_text:'original'};
const doc:DocumentSnapshot={handle:'test',path:'E:\\test.tde',name:'test.tde',revision:1,events:[event]};
beforeEach(async()=>{root=await fs.mkdtemp(path.join(os.tmpdir(),'todoline-recovery-'));});
afterEach(async()=>{await fs.rm(root,{recursive:true,force:true});});
it('recovers a failed save and detects external content changes',async()=>{const journal=new RecoveryJournal(root);const changed={...event,content_html:'<p>pending</p>',content_text:'pending'};await journal.stage(doc,{handle:doc.handle,revision:1,events:[changed]});expect(await journal.recover(doc)).toEqual({events:[changed],conflict:false});expect((await journal.recover({...doc,events:[{...event,done:1}]}))?.conflict).toBe(true);});
it('does not replay a transaction already committed before a crash',async()=>{const journal=new RecoveryJournal(root);const changed={...event,id:-1,content_html:'<p>pending</p>',content_text:'pending'};await journal.stage(doc,{handle:doc.handle,revision:1,events:[changed]});expect(await journal.recover({...doc,events:[{...changed,id:2}]})).toBeNull();expect(await fs.readdir(root)).toHaveLength(0);});
it('ignores incomplete or corrupt recovery files',async()=>{const journal=new RecoveryJournal(root);await fs.writeFile(path.join(root,'broken.json'),'{');expect(await journal.recover(doc)).toBeNull();});
it('retires a replay record without deleting its contents and tolerates a missing record',async()=>{const journal=new RecoveryJournal(root),changed={...event,content_text:'pending'};await journal.stage(doc,{handle:doc.handle,revision:1,events:[changed]});await journal.retire(doc.path);expect(await journal.recover(doc)).toBeNull();const files=await fs.readdir(path.join(root,'archived'));expect(files).toHaveLength(1);expect(JSON.parse(await fs.readFile(path.join(root,'archived',files[0]),'utf8')).events).toEqual([changed]);await journal.retire(doc.path);});
it('deduplicates reminders across process restarts and supports snooze',()=>{const file=path.join(root,'reminders.json');const scheduler=new ReminderSchedule(file);expect(scheduler.collect([doc],5,1800000)).toHaveLength(1);expect(scheduler.collect([doc],5,1800001)).toHaveLength(0);const restored=new ReminderSchedule(file);expect(restored.collect([doc],5,1800002)).toHaveLength(0);const key=[...restored.seen][0];restored.snooze(key,1800002);expect(restored.collect([doc],5,1800003)).toHaveLength(0);expect(restored.collect([doc],5,2400003)).toHaveLength(1);});
it('catches up after sleep, skips done events and deadlines older than 24h',()=>{const scheduler=new ReminderSchedule();expect(scheduler.collect([doc],0,2100000)).toHaveLength(1);expect(new ReminderSchedule().collect([{...doc,events:[{...event,done:1}]}],0,2100000)).toHaveLength(0);expect(new ReminderSchedule().collect([doc],0,2000000+86400001)).toHaveLength(0);});
it('lists only current, unfinished snoozes and still reminds a leading body with a deadline',()=>{
  const scheduler=new ReminderSchedule();const body={...doc,events:[{...event,top_divider:0}]};const notice=scheduler.collect([body],5,1800000)[0];expect(notice).toBeDefined();scheduler.snooze(notice.key,1800000);expect(scheduler.pendingSnoozes(body,1800001)).toEqual([1]);expect(scheduler.pendingSnoozes({...body,events:[{...body.events[0],done:1}]},1800001)).toEqual([]);expect(scheduler.pendingSnoozes({...body,events:[{...body.events[0],deadline_ts:3000}]},1800001)).toEqual([]);expect(scheduler.pendingSnoozes(body,2400001)).toEqual([]);
});
it('honors an explicit snooze beyond the automatic 24-hour catch-up window only once',()=>{
  const scheduler=new ReminderSchedule(path.join(root,'reminders.json')),now=event.deadline_ts!*1000+3*86400000,key=`${doc.path}:${event.id}:${event.deadline_ts}`;
  scheduler.snooze(key,now);expect(scheduler.collect([doc],0,now+599999)).toEqual([]);expect(scheduler.collect([doc],0,now+600000)).toHaveLength(1);expect(scheduler.collect([doc],0,now+600001)).toEqual([]);expect(new ReminderSchedule(path.join(root,'reminders.json')).collect([doc],0,now+600002)).toEqual([]);
});
