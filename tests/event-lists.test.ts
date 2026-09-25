import { describe, expect, it } from 'vitest';
import { eventLists, filterEventList } from '../src/shared/event-lists';
import type { EventRecord } from '../src/shared/types';

const time=(day:number,hour=0)=>new Date(2026,8,day,hour).getTime();
const event=(id:number,created:number,due:number|null,done=0):EventRecord=>({id,pos:id,created_at:created/1000,deadline_ts:due===null?null:due/1000,done,top_divider:0,deadline_raw:'',content_html:'',content_text:`事件 ${id}`});
const ids=(events:EventRecord[])=>events.map(e=>e.id);
describe('Qt event list semantics',()=>{
  it('includes open-ended earlier work, week overlaps, and exact Monday boundaries',()=>{
    const events=[event(1,time(1),null),event(2,time(1),null,1),event(3,time(6),time(7)),event(4,time(6),time(6,23)),event(5,time(13,23),null,1),event(6,time(14),time(15)),event(7,time(7),null,1)];
    expect(ids(eventLists(events,time(9)).week)).toEqual([3,1,7,5]);
  });
  it('pending includes future completed entries for unchecking and valid overdue snoozes',()=>{
    const events=[event(1,time(1),time(10)),event(2,time(1),time(10),1),event(3,time(1),time(8)),event(4,time(1),time(8),1),event(5,time(1),null)];
    expect(ids(eventLists(events,time(9),[3,4,5]).pending)).toEqual([3,1,2]);
    expect(ids(eventLists(events,time(9),[3]).overdue)).toEqual([3]);
  });
  it('exact deadline is neither future nor strictly overdue; null is not epoch zero',()=>{
    const events=[event(1,time(1),time(9)),event(2,time(1),null),event(3,time(1),0)];
    const lists=eventLists(events,time(9));expect(ids(lists.pending)).toEqual([]);expect(ids(lists.overdue)).toEqual([3]);expect(lists.all).toHaveLength(3);
  });
  it('filters the complete list, including rows beyond a UI page and deadline text',()=>{
    const events=Array.from({length:220},(_,i)=>event(i,time(1),null));events[200].deadline_raw='Friday';
    expect(ids(filterEventList(events,'FRIDAY'))).toEqual([200]);expect(ids(filterEventList(events,'事件 219'))).toEqual([219]);expect(filterEventList(events,'  ')).toHaveLength(220);
  });
  it('does not mutate source ordering and counts the leading body event',()=>{
    const events=[event(2,time(9),null),event(1,time(1),null)];expect(ids(eventLists(events,time(9)).all)).toEqual([1,2]);expect(ids(events)).toEqual([2,1]);
  });
  it('orders every list by the nearest date, keeping undated events last',()=>{
    const events=[event(1,time(1),null),event(2,time(2),time(20)),event(3,time(3),time(12)),event(4,time(4),null)];
    expect(ids(eventLists(events,time(9)).all)).toEqual([3,2,1,4]);
    expect(ids(eventLists(events,time(9)).pending)).toEqual([3,2]);
  });
});
