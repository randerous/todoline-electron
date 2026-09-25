import type {JSONContent} from '@tiptap/core';
import type {EventRecord} from '../shared/types';
import {parseQtHtml,serializeQtHtml} from './codec';
import {newEvent} from './document';
import {assetNumber,imageAssetReferences} from './asset-references';
interface PreparedClipboard {kind:'image'|'fragment'|'events';htmls:string[];events:EventRecord[];fragment?:JSONContent[];display?:{width:number;height:number};assets:{id:number;data:Uint8Array}[]}
const object=(value:unknown):value is Record<string,any>=>!!value&&typeof value==='object'&&!Array.isArray(value);
const timestamp=(value:unknown)=>typeof value==='number'&&Number.isSafeInteger(value)&&Math.abs(value)<=8640000000000;
function validateFragment(nodes:JSONContent[],depth=0){
  if(depth>100)throw new Error('剪贴板内容嵌套过深。');
  for(const node of nodes){
    if(!object(node)||typeof node.type!=='string')throw new Error('剪贴板片段结构无效。');
    if(node.type==='image'){
      const id=node.attrs?.assetId??assetNumber(node.attrs?.src??'');if(!Number.isSafeInteger(id)||id<=0)throw new Error('剪贴板图片引用无效。');
      for(const key of ['width','height']){const value=node.attrs?.[key];if(value!==undefined&&value!==null&&(!Number.isFinite(Number(value))||Number(value)<=0))throw new Error('剪贴板图片显示尺寸无效。');}
    }
    if(node.content!==undefined){if(!Array.isArray(node.content))throw new Error('剪贴板片段结构无效。');validateFragment(node.content,depth+1);}
  }
}
export function prepareEventClipboard(encoded:string,eventRange:boolean):PreparedClipboard|null{
  if(encoded.length>512*1024*1024)throw new Error('剪贴板内容过大，请分批复制。');
  const data:unknown=JSON.parse(encoded);if(!object(data))throw new Error('剪贴板事件格式无效。');
  if(data.events!==undefined&&!Array.isArray(data.events)||data.fragment!==undefined&&!Array.isArray(data.fragment)||data.image===undefined&&data.events===undefined&&data.fragment===undefined)throw new Error('剪贴板事件或片段结构无效。');
  let kind:PreparedClipboard['kind'],display:PreparedClipboard['display'],events:EventRecord[]=[],htmls:string[]=[];
  if(data.image&&!eventRange){
    if(!object(data.image)||!['width','height'].every(k=>typeof data.image[k]==='number'&&Number.isFinite(data.image[k])&&data.image[k]>0))throw new Error('剪贴板图片显示尺寸无效。');
    kind='image';display={width:data.image.width,height:data.image.height};
  }else if(Array.isArray(data.fragment)&&(!eventRange||!data.events?.length)){
    if(!data.fragment.length)return null;kind='fragment';validateFragment(data.fragment);const html=serializeQtHtml(data.fragment),parsed=parseQtHtml(html);if(parsed.readOnly)throw new Error('剪贴板内容无法安全转换。');htmls=[html];
  }else if(Array.isArray(data.events)&&data.events.length){
    kind='events';events=data.events.map((e:unknown)=>{
      if(!object(e)||!timestamp(e.created_at)||typeof e.html!=='string'||typeof e.text!=='string'||e.deadline_raw!==undefined&&typeof e.deadline_raw!=='string'||e.deadline_ts!=null&&!timestamp(e.deadline_ts)||['done','top_divider'].some(k=>e[k]!==undefined&&![true,false,0,1].includes(e[k])))throw new Error('剪贴板事件内容或时间信息无效。');
      return {...newEvent(),created_at:e.created_at,deadline_raw:e.deadline_raw??'',deadline_ts:e.deadline_ts??null,done:e.done?1:0,top_divider:e.top_divider?1:0,content_html:e.html,content_text:e.text};
    });htmls=events.map(e=>e.content_html);
  }else return null;
  if(data.assets!==undefined&&!Array.isArray(data.assets))throw new Error('剪贴板图片列表无效。');
  const available=new Map<number,string>();
  for(const value of data.assets??[]){
    if(!object(value)||typeof value.name!=='string'||assetNumber(value.name)===null||typeof value.data!=='string')throw new Error('剪贴板图片数据无效。');
    const id=assetNumber(value.name)!;if(available.has(id)&&available.get(id)!==value.data)throw new Error('剪贴板包含冲突的图片引用。');available.set(id,value.data);
  }
  const refs=kind==='image'?[assetNumber(data.assets?.[0]?.name??'')]:htmls.flatMap(html=>imageAssetReferences(html).map(ref=>ref.id));
  const ids=[...new Set(refs)];if(ids.some(id=>id===null||!available.has(id)))throw new Error('剪贴板缺少原图，未插入不完整内容。');
  const assets:PreparedClipboard['assets']=[];let total=0;
  for(const id of ids){
    const encoded=available.get(id!)!.replace(/\s/g,'');if(encoded.length>Math.ceil(100*1024*1024/3)*4)throw new Error('剪贴板图片过大，请分批复制。');
    let raw:string;try{raw=atob(encoded);}catch{throw new Error(`asset:${id} 图片编码无效。`);}if(!raw.length)throw new Error(`asset:${id} 图片为空。`);
    if((total+=raw.length)>512*1024*1024)throw new Error('图片批次过大，请分批复制。');assets.push({id:id!,data:Uint8Array.from(raw,c=>c.charCodeAt(0))});
  }
  return {kind,htmls,events,fragment:kind==='fragment'?data.fragment:undefined,display,assets};
}
