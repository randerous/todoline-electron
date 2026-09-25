import type {JSONContent} from '@tiptap/core';
import type {DocumentTab} from './runtime';
import type {AssetRecord} from '../shared/types';
import type {FormatRenameRequest} from '../shared/native-document';
import {isTdePath,isMarkdownPath} from '../shared/native-document';
import {parseQtHtml,serializeQtHtml} from './codec';
import {newEvent,exportContents} from './document';
import {serializeMarkdown} from './markdown-codec';
import {formatDate} from '../shared/deadline';
import {imageAssetReferences,remapImageAssets} from './asset-references';

/** Loaded only when a rename crosses the SQLite/text boundary. */
export async function conversionRequest(tab:DocumentTab,name:string):Promise<FormatRenameRequest>{
 const request:FormatRenameRequest={handle:tab.snapshot.handle,revision:tab.snapshot.revision,name};
 if(!isTdePath(name)){
  if(!isMarkdownPath(name)){request.source=exportContents(tab.records(),'txt',tab.snapshot.handle);return request;}
  const content:JSONContent[]=[],images=new Map<number,Promise<string>>();
  const image=(id:number)=>{let pending=images.get(id);if(!pending){pending=window.desktop.assetPreview(tab.snapshot.handle,id);images.set(id,pending);}return pending;};
  const convert=async(node:JSONContent):Promise<JSONContent>=>{
   if(node.type==='image'){
    const id=Number(node.attrs?.assetId);if(!Number.isSafeInteger(id)||id<=0)throw new Error('图片引用无效，原文件未修改。');
    const src=await image(id);
    return {...node,attrs:{src,alt:'图片'}};
   }
   return {...node,...(node.content?{content:await Promise.all(node.content.map(convert))}:{})};
  };
  for(const [i,event] of tab.records().entries()){
   if(i||event.top_divider||event.done||event.deadline_raw||event.deadline_ts)content.push({type:'heading',attrs:{level:2},content:[{type:'text',text:[formatDate(event.created_at),event.deadline_raw?'截止 '+event.deadline_raw:'',event.deadline_ts?formatDate(event.deadline_ts):'',event.done?'已完成':'未完成'].filter(Boolean).join(' · ')}]});
   const parsed=parseQtHtml(event.content_html);
   if(parsed.readOnly){
    const refs=new Map<number,string>();for(const {id} of imageAssetReferences(event.content_html))refs.set(id,await image(id));
    content.push({type:'rawMarkdown',attrs:{source:remapImageAssets(event.content_html,id=>refs.get(id)! )}});
   }
   else content.push(...await Promise.all(parsed.content.map(convert)));
  }
  request.source=serializeMarkdown({type:'doc',content});return request;
 }
 const assets:AssetRecord[]=[],references:string[]=[];
 let html:string,text:string;
 if(tab.markdown){
  const doc=new DOMParser().parseFromString(tab.markdown.html(),'text/html');text=tab.markdown.text();
  for(const image of Array.from(doc.images)){
   const src=image.getAttribute('src')??'';
   if(/^https?:/i.test(src)){image.replaceWith(doc.createTextNode(`[${image.alt||'图片'}](${src})`));continue;}
   const url=src.startsWith('data:')?src:await window.desktop.markdown.readAsset(tab.snapshot.handle,src);
   if(!src.startsWith('data:'))references.push(src);
   const match=/^data:image\/[\w+-]+;base64,([\s\S]+)$/i.exec(url);if(!match)throw new Error('图片数据无效，原文件未修改。');
   const bytes=Uint8Array.from(atob(match[1].replace(/\s/g,'')),c=>c.charCodeAt(0)),size=await window.desktop.imageInfo(bytes),id=assets.length+1;
   assets.push({id,data:bytes,w:size.width,h:size.height});image.setAttribute('src','asset:'+id);
  }
  for(const math of doc.querySelectorAll('[data-md-math-inline],[data-md-math-block]')){
   const block=math.hasAttribute('data-md-math-block'),delimiter=block?'$$':'$';math.textContent=delimiter+(math.getAttribute(block?'data-md-math-block':'data-md-math-inline')??'')+delimiter;
  }
  html=doc.body.innerHTML;
 }else{
  text=tab.source();html=serializeQtHtml(text.split(/\r\n|\r|\n/).map(line=>({type:'paragraph',content:line?[{type:'text',text:line}]:[]})));
 }
 const parsed=parseQtHtml(html);
 request.events=[{...newEvent(),content_html:parsed.readOnly?html:serializeQtHtml(parsed.content),content_text:text}];
 request.assets=assets;request.references=references;return request;
}
