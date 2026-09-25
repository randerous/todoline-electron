import type {JSONContent} from '@tiptap/core';
import type {DesktopAPI,EventRecord} from '../shared/types';
import {formatDate,countdown} from '../shared/deadline';
import {imageMime} from '../shared/image-mime';
import {inertDocument,plainText} from './codec';
import {remapImageAssets} from './asset-references';

/** Plain text uses the displayed body, not Markdown markup. Keep math source. */
export function clipboardPlainText(content:JSONContent[]):string {
  const normalize=(node:JSONContent):JSONContent=>{
    if(['inlineMath','blockMath','rawMarkdown','rawMarkdownInline'].includes(node.type??''))return {type:'text',text:String(node.attrs?.latex??node.attrs?.source??'')};
    if(node.type==='horizontalRule')return {type:'text',text:'===='};
    return {...node,content:node.content?.map(normalize)};
  };
  return plainText(content.map(normalize));
}
export function eventsClipboardText(events:EventRecord[]):string {
  return events.map((event,index)=>{
    const header=index>0||event.top_divider?`==== ${[formatDate(event.created_at),event.deadline_raw?`截止 ${event.deadline_raw}${event.deadline_ts&&formatDate(event.deadline_ts)!==event.deadline_raw?'（'+formatDate(event.deadline_ts)+'）':''}`:'',event.deadline_ts?`剩余 ${countdown(event.deadline_ts)}`:'',event.done?'已完成':''].filter(Boolean).join(' ==== ')} ====\n`:'';
    return header+event.content_text;
  }).join('\n\n');
}
type Payload=Parameters<DesktopAPI['copy']>[0];
/** Native HTML is offered only for image content. Private HTML / TDE formats
 * retain in-app fidelity without tempting Office to paste text as an object. */
export function clipboardOutput(data:Payload):Payload {
  if(!data.html||data.image)return data;
  const {root}=inertDocument(data.html);
  if(!Array.from(root.querySelectorAll('img')).some(img=>!img.closest('qt-import-head,noscript')))return data;
  const assets:{name:string;data:string}[]=data.events?JSON.parse(data.events).assets??[]:[];
  const externalHtml=remapImageAssets(data.html,id=>{
    const asset=assets.find(a=>a.name===`asset:${id}`);if(!asset)throw new Error('复制图片资源缺失');
    const bytes=Uint8Array.from(atob(asset.data),c=>c.charCodeAt(0));
    return `data:${imageMime(bytes)};base64,${asset.data}`;
  });
  return {...data,externalHtml};
}
export function copyToClipboard(data:Payload){return window.desktop.copy(clipboardOutput(data));}
