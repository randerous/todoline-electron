import type {DocumentTab} from './runtime';
import {formatDate} from '../shared/deadline';

/** Compare visible event text plus stable metadata, not DB IDs or ticking countdowns. */
export function diffDocument(tab:DocumentTab):string{
 if(tab.isText)return tab.source();
 return tab.records().map((event,index)=>{
  const header=index||event.top_divider||event.done||event.deadline_raw||event.deadline_ts?`==== ${formatDate(event.created_at)}${event.deadline_raw?' · 截止 '+event.deadline_raw:''}${event.deadline_ts?' · '+formatDate(event.deadline_ts):''} · ${event.done?'已完成':'未完成'} ====\n`:'';
  return header+event.content_text;
 }).join('\n');
}
