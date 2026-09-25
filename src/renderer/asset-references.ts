import {escapeHtml,inertDocument} from './codec';
export function assetNumber(value:string):number|null{
  const match=/^asset:(\d+)$/i.exec(value),id=match?Number(match[1]):0;return Number.isSafeInteger(id)&&id>0?id:null;
}
// Keep original HTML bytes outside actual image source values. Parsing and
// reserializing the complete document would normalize unknown Qt formatting.
export function imageAssetReferences(html:string){
  const refs:{id:number;from:number;to:number}[]=[],tokens:{value:string;offset:number}[]=[];
  const tags=/<!--[\s\S]*?(?:-->|$)|<![^>]*>|<(\/?)([a-zA-Z][\w:-]*)(?:[^>"']|"[^"]*"|'[^']*')*>/g;
  let marker:string;do{marker='data-tl-asset-ref-'+Math.random().toString(36).slice(2);}while(html.includes(marker));
  // Mark candidate tokens in a throwaway, inert parse. The browser decides
  // which are real images, excluding raw-text strings, comments and templates.
  const annotated=html.replace(tags,(value:string,closing:string|undefined,tag:string|undefined,offset:number)=>{
    if(closing||tag?.toLowerCase()!=='img')return value;const index=tokens.push({value,offset})-1;
    return value.replace(/^<img\b/i,prefix=>`${prefix} ${marker}="${index}"`);
  });
  const {root}=inertDocument(annotated);
  for(const element of root.querySelectorAll(`img[${marker}]`)){
    if(element.closest('qt-import-head,noscript'))continue;
    const id=assetNumber(element.getAttribute('src')??'');if(id===null)continue;
    const token=tokens[Number(element.getAttribute(marker))],prefix=/^<img\b/i.exec(token.value)![0].length,attributes=token.value.slice(prefix,-1);
    const pattern=/([^\s"'<>/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/dg;
    for(const attr of attributes.matchAll(pattern)){
      if(attr[1].toLowerCase()!=='src')continue;
      const group=attr[2]!==undefined?2:attr[3]!==undefined?3:attr[4]!==undefined?4:0;if(!group)break;
      const [from,to]=attr.indices![group];refs.push({id,from:token.offset+prefix+from,to:token.offset+prefix+to});
      break; // HTML uses the first src when duplicate attributes are present.
    }
  }
  return refs.sort((a,b)=>a.from-b.from);
}
export function remapImageAssets(html:string,replace:(id:number)=>string){
  const parts:string[]=[];let offset=0;
  for(const ref of imageAssetReferences(html)){const value=escapeHtml(replace(ref.id)).replace(/[\s`=]/g,c=>'&#'+c.charCodeAt(0)+';');parts.push(html.slice(offset,ref.from),value);offset=ref.to;}
  parts.push(html.slice(offset));return parts.join('');
}
