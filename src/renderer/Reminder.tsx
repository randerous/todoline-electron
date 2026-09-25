import React,{useEffect,useState} from 'react';
import {createRoot} from 'react-dom/client';
import {Bell,Check,Clock,ArrowUpRight,X} from 'lucide-react';
import type {ReminderView,ReminderAction} from '../shared/types';
import './reminder.css';
import './scrollbars.css';
function Reminder(){
  const [state,setState]=useState<ReminderView>({count:0,theme:'dark',error:'',busy:false});
  const [error,setError]=useState('');
  const [snoozeText,setSnoozeText]=useState('10分钟后');
  useEffect(()=>{const off=window.reminder.onState(value=>{setState(value);setError('');document.documentElement.dataset.theme=value.theme;});void window.reminder.ready().catch(e=>setError(String(e)));return off;},[]);
  const n=state.notice;
  useEffect(()=>{setSnoozeText('10分钟后');},[n?.id]);
  const act=(action:ReminderAction)=>{if(n)void window.reminder.action(n.id,action,action==='snooze'?snoozeText:undefined).catch(e=>setError(String(e)));};
  const pause=(value:boolean)=>void window.reminder.pause(value).catch(e=>setError(String(e)));
  return <main className="reminder-card" onMouseEnter={()=>pause(true)} onMouseLeave={()=>pause(false)} onKeyDown={e=>{if(e.key==='Escape'){e.preventDefault();act('dismiss');}}}>
    <header><span className="bell"><Bell size={16}/></span><small>{state.count>1?`${state.count} 条提醒待处理`:'待办提醒'}</small><button aria-label="关闭提醒" disabled={state.busy} onClick={()=>act('dismiss')}><X size={16}/></button></header>
    {n&&<><button className="reminder-content" title={n.fileName} onClick={()=>act('open')} disabled={state.busy}><p>{n.text}</p></button><div className="reminder-due"><Clock size={13}/><span>截止 {new Date(n.due*1000).toLocaleString('zh-CN',{year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',hour12:false})}</span></div></>}
    {(state.error||error)&&<p className="reminder-error" role="alert">{state.error||error}</p>}
    <footer><div className="snooze-control"><input aria-label="稍后提醒时间" title="编辑完整时间，如 10分钟后、2小时后、1天后" value={snoozeText} maxLength={200} disabled={state.busy} style={{width:`${Math.max(4,Math.min(12,[...snoozeText].reduce((width,char)=>width+(/[^\x00-\xff]/.test(char)?2:1),0)))}ch`}} onChange={e=>setSnoozeText(e.target.value)} onKeyDown={e=>{if(e.key==='Enter'){e.preventDefault();act('snooze');}}}/><button aria-label={snoozeText+'提醒'} disabled={state.busy} onClick={()=>act('snooze')}>提醒</button></div><button disabled={state.busy} onClick={()=>act('dismiss')}>我知道了</button><button disabled={state.busy} onClick={()=>act('done')}><Check size={14}/>已完成</button><button className="open" disabled={state.busy} onClick={()=>act('open')}>打开事件<ArrowUpRight size={14}/></button></footer>
  </main>;
}
createRoot(document.getElementById('root')!).render(<Reminder/>);
