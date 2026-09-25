import React,{useEffect,useLayoutEffect,useMemo,useRef,useState} from 'react';
import {Check,Circle} from 'lucide-react';
import type {EventRecord} from '../shared/types';
import type {DocumentTab} from './runtime';
import {countdown,formatDate} from '../shared/deadline';
import {observeVisibleEvents} from './visible-events';
import './event-navigation.css';

const rowHeight=32,overscan=5;
export function EventNavigation({tab,events,matches,onlyPending,onNavigate}:{tab:DocumentTab;events:EventRecord[];matches:ReadonlySet<number>;onlyPending:boolean;onNavigate:(id:number,toggle:boolean)=>void}){
  const list=useRef<HTMLDivElement>(null),observer=useRef<ReturnType<typeof observeVisibleEvents>|null>(null);
  const [visible,setVisible]=useState<number[]>([]),[viewport,setViewport]=useState({top:0,height:600});
  const rows=useMemo(()=>events.map((event,index)=>({event,index})).filter(({event})=>!onlyPending||!event.done),[events,onlyPending]);
  const indices=useMemo(()=>new Map(rows.map(({event},index)=>[event.id,index])),[rows]);
  const visibleIds=useMemo(()=>new Set(visible),[visible]);
  useEffect(()=>{
    if(!tab.editor)return;
    const tracking=observeVisibleEvents(tab.editor,setVisible);observer.current=tracking;
    return()=>{tracking.destroy();observer.current=null;};
  },[tab,tab.editor]);
  // A save can remap temporary IDs without changing the ProseMirror document.
  useEffect(()=>observer.current?.refresh(),[events]);
  useLayoutEffect(()=>{
    const el=list.current;if(!el)return;let frame=0;
    const measure=()=>{frame=0;const top=el.scrollTop,height=el.clientHeight;setViewport(old=>old.top===top&&old.height===height?old:{top,height});};
    const schedule=()=>{if(!frame)frame=requestAnimationFrame(measure);};
    const resize=new ResizeObserver(schedule);resize.observe(el);el.addEventListener('scroll',schedule,{passive:true});measure();
    return()=>{cancelAnimationFrame(frame);resize.disconnect();el.removeEventListener('scroll',schedule);};
  },[]);
  useLayoutEffect(()=>{
    const el=list.current,index=visible.map(id=>indices.get(id)).find(index=>index!==undefined);if(!el||index===undefined)return;
    const top=index*rowHeight,bottom=top+rowHeight;
    if(top<el.scrollTop||bottom>el.scrollTop+el.clientHeight){
      el.scrollTop=Math.max(0,top-(el.clientHeight-rowHeight)/2);
      setViewport({top:el.scrollTop,height:el.clientHeight});
    }
  },[visible,indices]);
  const start=Math.max(0,Math.min(Math.max(0,rows.length-1),Math.floor(viewport.top/rowHeight)-overscan));
  const end=Math.min(rows.length,Math.ceil((viewport.top+viewport.height)/rowHeight)+overscan);
  return <div className="event-outline event-navigation" ref={list} aria-label="事件导航列表">
    <div className="event-navigation-rows" style={{height:rows.length*rowHeight}}>
      {rows.slice(start,end).map(({event:e,index},offset)=>{
        const inView=visibleIds.has(e.id),match=matches.has(e.id);
        return <button key={e.id} data-event-id={e.id} data-visible={inView?'':undefined} data-match={match?'':undefined} aria-current={inView?'location':undefined}
          className={'outline-item'+(e.done?' completed':'')+(inView?' in-view':'')+(match?' search-hit':'')}
          style={{top:(start+offset)*rowHeight,height:rowHeight}}
          title={(e.content_text.trim()||'空白事件')+(e.deadline_raw?'\n截止：'+e.deadline_raw:'')}
          onClick={ev=>onNavigate(e.id,ev.ctrlKey)}>
          <span className="outline-symbol">{e.done?<Check size={12}/>:<Circle size={8}/>}</span>
          <span className="outline-text">{e.content_text.trim().split('\n')[0]||'空白事件'}</span>
          <span className="outline-time">{e.deadline_ts?countdown(e.deadline_ts):e.top_divider||index>0?formatDate(e.created_at).slice(5,16):'正文'}</span>
        </button>;
      })}
    </div>
    {!rows.length&&<p className="nav-empty">没有可显示的事件</p>}
  </div>;
}
