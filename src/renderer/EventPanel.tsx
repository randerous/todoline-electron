import { useEffect, useMemo, useRef, useState } from 'react';
import { CheckCheck, Search, X } from 'lucide-react';
import type { EventRecord } from '../shared/types';
import { eventListLabels, eventLists, filterEventList, type EventListKind } from '../shared/event-lists';
import { countdown, formatDate } from '../shared/deadline';

export function EventPanel({events,kind,now,snoozed,readOnly,onDone,onReveal,onClose,onHover,onLeave}:{
  events:EventRecord[];kind:EventListKind;now:number;snoozed:number[];
  readOnly:boolean;onDone:(id:number,done:boolean)=>void;onReveal:(id:number)=>void;onClose:()=>void;
  onHover?:()=>void;onLeave?:()=>void;
}){
  const [query,setQuery]=useState(''),[limit,setLimit]=useState(100),[preview,setPreview]=useState<{id:number;top:number}|null>(null);
  const panel=useRef<HTMLElement>(null);
  const lists=useMemo(()=>eventLists(events,now,snoozed),[events,now,snoozed]);
  const rows=useMemo(()=>filterEventList(lists[kind],query),[lists,kind,query]);
  useEffect(()=>{setLimit(100);setPreview(null);},[kind,query]);
  const detail=events.find(e=>e.id===preview?.id);
  // The preview opens beside the hovered row instead of reserving panel height.
  const show=(id:number,row:HTMLElement)=>{
    const base=panel.current?.getBoundingClientRect();if(!base)return;
    const rect=row.getBoundingClientRect();
    setPreview({id,top:Math.max(0,Math.min(rect.top-base.top,base.height-150))});
  };
  return <section className="menu event-panel" role="dialog" aria-label="事件列表" ref={panel} onMouseEnter={onHover} onMouseLeave={()=>{setPreview(null);onLeave?.();}}>
    <header><div><CheckCheck size={16}/><h3>{eventListLabels[kind]}</h3><span>{rows.length}</span></div><button aria-label="关闭事件列表" onClick={onClose}><X size={16}/></button></header>
    <div className="event-panel-rows">{rows.slice(0,limit).map(e=><div className={'event-panel-row '+(e.done?'completed':'')} key={e.id} onMouseEnter={ev=>show(e.id,ev.currentTarget)} onFocus={ev=>show(e.id,ev.currentTarget)}>
      <input type="checkbox" aria-label={`完成事件 ${e.content_text.slice(0,40)||'空白事件'}`} checked={!!e.done} disabled={readOnly} onChange={ev=>onDone(e.id,ev.target.checked)}/>
      <button onClick={()=>onReveal(e.id)} title="定位到正文"><span>{e.content_text.split('\n')[0]||'空白事件'}</span><small>{e.deadline_ts!==null?countdown(e.deadline_ts):e.deadline_raw||formatDate(e.created_at).slice(5,16)}</small></button>
    </div>)}{rows.length>limit&&<button className="load-more" onClick={()=>setLimit(n=>n+100)}>继续显示 · 还有 {rows.length-limit} 项</button>}{!rows.length&&<p className="event-panel-empty">{query?'没有匹配的事件':'此分类暂无事件'}</p>}</div>
    <label className="event-filter"><Search size={14}/><input aria-label="过滤事件列表" placeholder="过滤正文或截止时间…" value={query} onChange={e=>setQuery(e.target.value)}/>{query&&<button aria-label="清除事件过滤" onClick={()=>setQuery('')}><X size={13}/></button>}</label>
    {detail&&preview&&<aside className="event-preview" style={{top:preview.top}}><p>{detail.content_text||'空白事件'}</p>{detail.deadline_raw&&<small>截止：{detail.deadline_raw}</small>}</aside>}
  </section>;
}
