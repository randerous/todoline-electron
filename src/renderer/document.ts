import type { JSONContent } from '@tiptap/core';
import type { Node as PMNode } from '@tiptap/pm/model';
import type { EventRecord } from '../shared/types';
import { parseQtHtml, serializeQtHtml, plainText, markdown, escapeHtml } from './codec';
import { formatDate } from '../shared/deadline';
import {remapImageAssets} from './asset-references';

let nextId=-1;
export const newEvent = ():EventRecord => ({id:nextId--,pos:0,created_at:Math.floor(Date.now()/1000),deadline_raw:'',deadline_ts:null,done:0,top_divider:0,content_html:'',content_text:''});
export const eventMeta=(e:EventRecord)=>({id:e.id,created_at:e.created_at,deadline_raw:e.deadline_raw,deadline_ts:e.deadline_ts,done:e.done});
export function recordsToJSON(events:EventRecord[]):JSONContent {
  const content:JSONContent[]=[];
  // Each event still gets an isolated inert template; the blank HTML document
  // and its parser setup can be shared for this one import instead of N times.
  const parsingDocument=new DOMParser().parseFromString('', 'text/html');
  events.forEach((e,i)=>{
    if(i>0||e.top_divider)content.push({type:'divider',attrs:eventMeta(e)});
    const parsed=parseQtHtml(e.content_html,parsingDocument);
    if(parsed.readOnly)content.push({type:'legacy',attrs:{html:e.content_html,text:e.content_text,reason:parsed.reason??'包含暂不支持的格式',id:e.id}});
    else content.push(...(parsed.content.length?parsed.content:[{type:'paragraph'}]));
  });
  return {type:'doc',attrs:{head:eventMeta(events[0]??newEvent())},content:content.length?content:[{type:'paragraph'}]};
}
interface Group { meta:EventRecord; blocks:PMNode[]; dividerPos:number; start:number; end:number }
export function groups(doc:PMNode,head:EventRecord):Group[] {
  const result:Group[]=[];
  let current:Group={meta:{...head,...doc.attrs.head,top_divider:0},blocks:[],dividerPos:-1,start:0,end:0};
  doc.forEach((node,pos)=>{
    if(node.type.name==='divider'){
      if(current.blocks.length||current.dividerPos>=0) {current.end=pos;result.push(current);}
      current={meta:{...head,...node.attrs,top_divider:pos===0?1:0},blocks:[],dividerPos:pos,start:pos,end:pos+node.nodeSize};
    } else {current.blocks.push(node);current.end=pos+node.nodeSize;}
  });
  if(current.blocks.length||current.dividerPos>=0)result.push(current);
  return result;
}
function validOpaqueGroup(blocks:PMNode[]){
  if(blocks.length===1&&blocks[0].type.name==='legacy')return true;
  return !blocks.some(n=>{let found=n.type.name==='legacy';n.descendants(child=>{if(child.type.name==='legacy')found=true;});return found;});
}
export function preservesOpaqueBodies(before:PMNode,after:PMNode,head:EventRecord,history=false){
  const previous:PMNode[]=[],remaining:PMNode[]=[];
  before.descendants(n=>{if(n.type.name==='legacy')previous.push(n);});
  after.descendants(n=>{if(n.type.name==='legacy')remaining.push(n);});
  if(!previous.length&&!remaining.length)return true;
  if(groups(after,head).some(g=>!validOpaqueGroup(g.blocks)))return false;
  if(history)return true;
  return previous.every(n=>{const index=remaining.findIndex(a=>a.eq(n));if(index<0)return false;remaining.splice(index,1);return true;});
}
export class DocumentCodec {
  head:EventRecord;
  private original=new Map<number,EventRecord>();
  private initialBlocks=new Map<number,PMNode[]>();
  private cached=new Map<number,{blocks:PMNode[];html:string;text:string}>();
  private aliases=new Map<number,number>();
  resolveId(id:number){return this.aliases.get(id)??id;}
  constructor(events:EventRecord[]) {this.head=events[0]??newEvent();this.original=new Map(events.map(e=>[e.id,e]));}
  prime(doc:PMNode) {
    for(const g of groups(doc,this.head)) { const old=this.original.get(g.meta.id); if(old){this.initialBlocks.set(g.meta.id,g.blocks);this.cached.set(g.meta.id,{blocks:g.blocks,html:old.content_html,text:old.content_text});} }
  }
  records(doc:PMNode):EventRecord[] {
    const records=groups(doc,this.head).map((g,i)=>{
      if(!validOpaqueGroup(g.blocks))throw new Error('只读事件与正文边界无效，未保存不完整内容。');
      let cached=this.cached.get(g.meta.id);
      if(!cached||cached.blocks.length!==g.blocks.length||!cached.blocks.every((n,j)=>n===g.blocks[j])) {
        const initial=this.initialBlocks.get(g.meta.id),original=this.original.get(g.meta.id);
        if(original&&initial?.length===g.blocks.length&&g.blocks.every((n,i)=>n.eq(initial[i]))){
          // Undo can reconstruct equal nodes with new identities. Preserve the
          // original bytes when the body returns to its opened state as well.
          cached={blocks:g.blocks,html:original.content_html,text:original.content_text};
        }else{
          const legacy=g.blocks.find(n=>n.type.name==='legacy');
          const json=g.blocks.map(n=>n.toJSON());
          cached={blocks:g.blocks,html:legacy?legacy.attrs.html:serializeQtHtml(json),text:legacy?legacy.attrs.text:plainText(json)};
        }
        this.cached.set(g.meta.id,cached);
      }
      // Preserve order values for untouched documents; normalize only if structure changes ordering.
      const old=this.original.get(g.meta.id);
      return {...g.meta,id:this.resolveId(g.meta.id),pos:old?.pos??i*1024,top_divider:i===0?g.meta.top_divider:0,content_html:cached.html,content_text:cached.text};
    });
    const reorder=records.some((r,j)=>j>0&&r.pos<=records[j-1].pos);
    return reorder?records.map((e,i)=>({...e,pos:i*1024})):records;
  }
  remap(ids:Record<string,number>) {
    for(const [raw,current]of this.aliases)if(ids[current]!==undefined)this.aliases.set(raw,ids[current]);
    for(const [k,v]of Object.entries(ids))if(Number(k)!==v)this.aliases.set(Number(k),v);
  }
}
export function exportContents(events:EventRecord[],format:'md'|'txt'|'pdf',handle:string) {
  const chunks:string[]=[];
  events.forEach((e,i)=>{
    const hasDivider=i>0||e.top_divider;
    const deadline=e.deadline_raw?(e.deadline_ts&&formatDate(e.deadline_ts)!==e.deadline_raw?`${e.deadline_raw}（${formatDate(e.deadline_ts)}）`:e.deadline_raw):'';
    const title=`${formatDate(e.created_at)}${deadline?' · 截止 '+deadline:''}${e.done?' · ✅ 已完成':''}`;
    const parsed=parseQtHtml(e.content_html);
    if(format==='pdf') {
      if(hasDivider)chunks.push(`<h2>${escapeHtml(title)}</h2>`);
      const body=parsed.readOnly?`<p>${escapeHtml(e.content_text).replace(/\n/g,'<br>')}</p>`:serializeQtHtml(parsed.content,true);
      chunks.push(remapImageAssets(body.replace(/^[\s\S]*<body[^>]*>/i,'').replace(/<\/body>[\s\S]*$/i,''),id=>`tde-asset://document/${handle}/${id}`));
    } else {
      if(hasDivider)chunks.push(format==='md'?`## ${title}`:`${'─'.repeat(46)}\n${[formatDate(e.created_at),deadline?'截止 '+deadline:'',e.done?'[已完成]':'[未完成]'].filter(Boolean).join('   ')}`);
      const body=(parsed.readOnly?e.content_text:format==='md'?markdown(parsed.content):plainText(parsed.content));if(body)chunks.push(body);
    }
  });
  return chunks.join(format==='md'?'\n\n':'\n')+'\n';
}
