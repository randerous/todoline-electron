import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CalendarDays, ChevronLeft, ChevronRight, X } from 'lucide-react';
import type { EventRecord } from '../shared/types';

const dayKey=(value:Date)=>`${value.getFullYear()}-${value.getMonth()}-${value.getDate()}`;
const startOfMonth=(value:Date)=>{const first=new Date(value);first.setDate(1);first.setHours(0,0,0,0);return first;};
const clock=(event:EventRecord)=>new Date(event.deadline_ts!*1000).toLocaleTimeString('zh-CN',{hour:'2-digit',minute:'2-digit',hour12:false});
const chipClass=(event:EventRecord,now:number)=>'calendar-chip'+(event.done?' done':event.deadline_ts!*1000<now?' overdue':'');
const firstLine=(event:EventRecord)=>event.content_text.split('\n')[0]||'空白事件';

/** Events sit on the calendar by deadline; undated ones stay out of the grid. */
export function CalendarPanel({events,now,onReveal,onClose}:{
  events:EventRecord[];now:number;onReveal:(id:number)=>void;onClose:()=>void;
}){
  const [month,setMonth]=useState(()=>startOfMonth(new Date(now)));
  // A crowded day opens its own bubble beside the cell, never inside it.
  const [opened,setOpened]=useState<{key:string;anchor:DOMRect}|null>(null);
  const hoverTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  const pinned=useRef(false);
  useEffect(()=>()=>clearTimeout(hoverTimer.current),[]);
  // Pointing at the control opens the day after a deliberate dwell; clicking
  // pins it so the bubble survives the pointer leaving.
  const hoverDay=(key:string,anchor:DOMRect)=>{clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>{pinned.current=false;setOpened({key,anchor});},300);};
  const pinDay=(key:string,anchor:DOMRect,open:boolean)=>{clearTimeout(hoverTimer.current);if(open&&pinned.current){pinned.current=false;setOpened(null);return;}pinned.current=true;setOpened({key,anchor});};
  const keepDay=()=>clearTimeout(hoverTimer.current);
  const leaveDay=()=>{clearTimeout(hoverTimer.current);hoverTimer.current=setTimeout(()=>{if(!pinned.current)setOpened(null);},300);};
  const closeDay=()=>{clearTimeout(hoverTimer.current);pinned.current=false;setOpened(null);};
  const dated=useMemo(()=>events.filter(e=>e.deadline_ts!==null),[events]);
  const byDay=useMemo(()=>{
    const map=new Map<string,EventRecord[]>();
    for(const event of [...dated].sort((a,b)=>a.deadline_ts!-b.deadline_ts!)){
      const key=dayKey(new Date(event.deadline_ts!*1000));
      map.set(key,[...(map.get(key)??[]),event]);
    }
    return map;
  },[dated]);
  const cells=useMemo(()=>{
    const first=new Date(month),lead=(first.getDay()+6)%7,start=new Date(first);
    start.setDate(first.getDate()-lead);
    return Array.from({length:42},(_,i)=>{const day=new Date(start);day.setDate(start.getDate()+i);return day;});
  },[month]);
  const today=dayKey(new Date(now));
  const inMonth=cells.filter(day=>day.getMonth()===month.getMonth()).reduce((n,day)=>n+(byDay.get(dayKey(day))?.length??0),0);
  const goto=(next:Date)=>{closeDay();setMonth(next);};
  const shift=(delta:number)=>{closeDay();setMonth(current=>{const next=new Date(current);next.setMonth(current.getMonth()+delta);return next;});};
  const openedDay=opened?cells.find(day=>dayKey(day)===opened.key):undefined;
  return <section className="menu calendar-panel" role="dialog" aria-label="事件日历">
    <header>
      <div><CalendarDays size={16}/><h3>{month.getFullYear()} 年 {month.getMonth()+1} 月</h3><span>{inMonth} 个事件</span></div>
      <div>
        <button aria-label="上个月" onClick={()=>shift(-1)}><ChevronLeft size={16}/></button>
        <button className="calendar-today" onClick={()=>goto(startOfMonth(new Date(now)))}>今天</button>
        <button aria-label="下个月" onClick={()=>shift(1)}><ChevronRight size={16}/></button>
        <button aria-label="关闭日历" onClick={onClose}><X size={16}/></button>
      </div>
    </header>
    <div className="calendar-weekdays">{['一','二','三','四','五','六','日'].map(day=><span key={day}>{day}</span>)}</div>
    <div className="calendar-grid" onScroll={closeDay}>{cells.map(day=>{
      const key=dayKey(day),items=byDay.get(key)??[],expanded=opened?.key===key;
      return <div key={key} className={'calendar-day'+(day.getMonth()===month.getMonth()?'':' outside')+(key===today?' today':'')+(expanded?' expanded':'')}>
        <span className="calendar-date">{day.getDate()}</span>
        {items.slice(0,2).map(event=><button key={event.id} className={chipClass(event,now)} title={event.content_text||'空白事件'} onClick={()=>onReveal(event.id)}>
          <b>{clock(event)}</b><span>{firstLine(event)}</span>
        </button>)}
        {items.length>2&&<button className="calendar-more" aria-expanded={expanded}
          onMouseEnter={e=>hoverDay(key,e.currentTarget.closest('.calendar-day')!.getBoundingClientRect())}
          onMouseLeave={leaveDay}
          onFocus={e=>hoverDay(key,e.currentTarget.closest('.calendar-day')!.getBoundingClientRect())}
          onClick={e=>pinDay(key,e.currentTarget.closest('.calendar-day')!.getBoundingClientRect(),expanded)}>
          {expanded?'收起':`展开全部${items.length}个`}
        </button>}
      </div>;
    })}</div>
    {dated.length<events.length&&<p className="calendar-note">{events.length-dated.length} 个事件没有截止时间，不在日历中显示。</p>}
    {opened&&openedDay&&<DayBubble anchor={opened.anchor} day={openedDay} items={byDay.get(opened.key)??[]} now={now}
      onReveal={onReveal} onClose={closeDay} onHover={keepDay} onLeave={leaveDay}/>}
  </section>;
}

/** The bubble opens toward whichever side of the cell has room for it. */
function DayBubble({anchor,day,items,now,onReveal,onClose,onHover,onLeave}:{
  anchor:DOMRect;day:Date;items:EventRecord[];now:number;onReveal:(id:number)=>void;onClose:()=>void;onHover:()=>void;onLeave:()=>void;
}){
  const box=useRef<HTMLDivElement>(null);
  const [at,setAt]=useState<{left:number;top:number}|null>(null);
  useLayoutEffect(()=>{
    const el=box.current;if(!el)return;
    const {offsetWidth:width,offsetHeight:height}=el,gap=6;
    let left=anchor.right+gap;
    if(left+width>innerWidth-8)left=anchor.left-gap-width;
    if(left<8)left=Math.max(8,Math.min(anchor.left,innerWidth-width-8));
    const top=Math.max(8,Math.min(anchor.top,innerHeight-height-8));
    setAt({left:Math.round(left),top:Math.round(top)});
  },[anchor,items.length]);
  useEffect(()=>{
    const away=(e:PointerEvent)=>{
      const target=e.target as HTMLElement;
      if(!box.current?.contains(target)&&!target.closest('.calendar-more'))onClose();
    };
    document.addEventListener('pointerdown',away,true);
    return()=>document.removeEventListener('pointerdown',away,true);
  },[onClose]);
  return <div ref={box} className="calendar-bubble" role="dialog" aria-label={`${day.getMonth()+1} 月 ${day.getDate()} 日的事件`}
    onMouseEnter={onHover} onMouseLeave={onLeave}
    style={{left:at?.left??0,top:at?.top??0,visibility:at?'visible':'hidden'}}>
    <header><b>{day.getMonth()+1} 月 {day.getDate()} 日</b><span>{items.length} 个事件</span><button aria-label="关闭这一天" onClick={onClose}><X size={14}/></button></header>
    <div className="calendar-bubble-list">{items.map(event=><button key={event.id} className={chipClass(event,now)} title={event.content_text||'空白事件'} onClick={()=>onReveal(event.id)}>
      <b>{clock(event)}</b><span>{firstLine(event)}</span>
    </button>)}</div>
  </div>;
}
