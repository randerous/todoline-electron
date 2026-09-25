import type {EventRecord} from './types';

export function documentDate(now=new Date()){
  return `${now.getFullYear()}${String(now.getMonth()+1).padStart(2,'0')}${String(now.getDate()).padStart(2,'0')}`;
}
/** Preserve images, tables, unfamiliar markup and reminder metadata even without text. */
export function emptyDocumentEvents(events:EventRecord[]){
  return events.every(event=>{
    if(event.content_text.trim()||event.deadline_raw.trim()||event.deadline_ts||event.done)return false;
    const body=event.content_html.replace(/<head\b[^>]*>[\s\S]*?<\/head>/gi,'')
      .replace(/<!DOCTYPE[^>]*>/gi,'')
      .replace(/<\/?(?:html|body|p|div|span|br|b|i|u|strong|em|s|ul|ol|li|blockquote|h[1-6])\b[^>]*>/gi,'')
      .replace(/&(?:nbsp|#160|#xA0);/gi,'');
    return !body.trim();
  });
}
