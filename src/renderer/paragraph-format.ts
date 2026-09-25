export type ParagraphFormat=Record<string,string|number>;
const properties:Record<string,string>={textAlign:'text-align',textIndent:'text-indent',marginLeft:'margin-left',marginRight:'margin-right',marginTop:'margin-top',marginBottom:'margin-bottom',lineHeight:'line-height',direction:'direction'};
const inherited=new Set(['textAlign','textIndent','lineHeight','qtLineHeightType','direction']);
export function inheritedFormat(format:ParagraphFormat={}):ParagraphFormat{return Object.fromEntries(Object.entries(format).filter(([key])=>inherited.has(key)));}
function value(key:string,raw:unknown):string|number|null{
  if(key==='qtIndent')return Number.isSafeInteger(raw)&&Number(raw)>=0?Number(raw):null;
  if(key==='qtLineHeightType')return raw==='fixed'||raw==='proportional'?raw:null;
  if(typeof raw!=='string')return null;const text=raw.trim().toLowerCase();
  if(key==='textAlign')return /^(left|center|right|justify|start|end)$/.test(text)?text:null;
  if(key==='direction')return /^(ltr|rtl)$/.test(text)?text:null;
  if(key==='lineHeight')return text==='normal'||/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|%)?$/.test(text)?text:null;
  if(!Object.hasOwn(properties,key)||! /^-?(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt)?$/.test(text))return null;
  return /[a-z]$/.test(text)?text:text+'px';
}
export function normalizeFormat(raw:unknown):ParagraphFormat{
  const result:ParagraphFormat={};if(!raw||typeof raw!=='object'||Array.isArray(raw))return result;
  for(const [key,input] of Object.entries(raw)){const safe=value(key,input);if(safe!==null)result[key]=safe;}
  if(result.textAlign==='start')result.textAlign=result.direction==='rtl'?'right':'left';
  if(result.textAlign==='end')result.textAlign=result.direction==='rtl'?'left':'right';
  return result;
}
export function readParagraphFormat(element:Element,parent:ParagraphFormat={}):ParagraphFormat{
  const result:ParagraphFormat=inheritedFormat(parent);
  const style=(element as HTMLElement).style;
  for(const [key,property] of Object.entries(properties)){
    const raw=style?.getPropertyValue(property)||(key==='textAlign'?element.getAttribute('align'):key==='direction'?element.getAttribute('dir'):null);
    if(!raw||raw==='inherit')continue;
    if(key==='lineHeight')delete result.qtLineHeightType;
    if(/^(initial|unset)$/.test(raw)){delete result[key];continue;}
    const safe=value(key,raw);if(safe!==null)result[key]=safe;
  }
  const indent=/(?:^|;)\s*-qt-block-indent\s*:\s*(\d+)\s*(?:;|$)/i.exec(element.getAttribute('style')||'');
  if(indent)result.qtIndent=Number(indent[1]);
  const heightType=/(?:^|;)\s*-qt-line-height-type\s*:\s*(fixed|proportional)\s*(?:;|$)/i.exec(element.getAttribute('style')||'');
  if(heightType)result.qtLineHeightType=heightType[1].toLowerCase();
  for(const [key,input] of Object.entries(result))if(key!=='textIndent'&&/^0(?:px|pt)?$/.test(String(input))&&!(inherited.has(key)&&parent[key]&&!/^0(?:px|pt)?$/.test(String(parent[key]))))delete result[key];
  return normalizeFormat(result);
}
/** Qt stores block indent separately; Chromium needs its 40px indentation added. */
export function formatStyles(raw:unknown,display=false):string{
  const format=normalizeFormat(raw),parts:string[]=[];
  for(const [key,property] of Object.entries(properties)){
    if(!display&&(key==='textAlign'||key==='direction'))continue;
    if(display&&key==='marginLeft'&&format.qtIndent)continue;
    if(display&&key==='lineHeight'&&format.qtLineHeightType==='fixed'&&/^\d+(?:\.\d+)?$/.test(String(format.lineHeight))){parts.push(`line-height:${format.lineHeight}px;`);continue;}
    if(format[key]!==undefined)parts.push(`${property}:${format[key]};`);
  }
  if(format.qtIndent){
    if(display)parts.push(`margin-left:${format.marginLeft?`calc(${format.marginLeft} + ${Number(format.qtIndent)*40}px)`:Number(format.qtIndent)*40+'px'};`);
    else parts.push(`-qt-block-indent:${format.qtIndent};`);
  }
  if(!display&&format.qtLineHeightType)parts.push(`-qt-line-height-type:${format.qtLineHeightType};`);
  return parts.join('');
}
