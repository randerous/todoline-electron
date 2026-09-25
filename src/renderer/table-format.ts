import type {JSONContent} from '@tiptap/core';
export type TableLayout={attributes?:Record<string,string>;style?:Record<string,string>};
const cssProperties=new Set(['border','border-width','border-style','border-color','border-collapse','border-spacing','background-color','width','height','vertical-align','text-align','direction','padding','padding-top','padding-right','padding-bottom','padding-left','margin','margin-top','margin-bottom','margin-left','margin-right',...['top','right','bottom','left'].flatMap(side=>['width','style','color'].map(p=>`border-${side}-${p}`))]);
const dimension=(s:string)=>/^(?:\d+(?:\.\d+)?|\.\d+)(?:px|pt|%)?$/.test(s);
export function tableDomAttrs(raw:unknown,document:Document=window.document):Record<string,string>{
  const layout=raw as TableLayout|undefined,result:Record<string,string>={};
  for(const [key,value] of Object.entries(layout?.attributes??{})){
    if(typeof value!=='string')continue;
    if(['width','height'].includes(key)&&dimension(value))result[key]=value;
    if(['border','cellpadding','cellspacing'].includes(key)&&/^\d+(?:\.\d+)?$/.test(value))result[key]=value;
    if(key==='align'&&/^(left|right|center|justify)$/.test(value)||key==='valign'&&/^(top|middle|bottom|baseline)$/.test(value))result[key]=value;
    if(key==='bgcolor'&&!/[<>\\]|url\s*\(/i.test(value)){
      const style=document.createElement('div').style;style.color=value;
      // The legacy HTML attribute (and Qt) requires a color name or hex, not CSS rgb().
      const rgb=style.color.match(/^rgb\(\s*(\d+),\s*(\d+),\s*(\d+)\s*\)$/);
      if(rgb)result[key]='#'+rgb.slice(1).map(n=>Number(n).toString(16).padStart(2,'0')).join('');
      else if(/^#[\da-f]{3,8}$|^[a-z]+$/i.test(style.color)&&style.color!=='transparent')result[key]=style.color;
    }
  }
  const css=document.createElement('div').style;
  for(const [property,value] of Object.entries(layout?.style??{}))if(cssProperties.has(property)&&typeof value==='string'&&!/[<>\\\u0000-\u001f]|url\s*\(|expression\s*\(|@import/i.test(value))css.setProperty(property,value);
  if(css.cssText)result.style=css.cssText;return result;
}
export function readTableLayout(element:Element,unsupported?:Set<string>):TableLayout{
  const style=(element as HTMLElement).style,layout:TableLayout={attributes:{},style:{}};
  for(const key of ['border','cellpadding','cellspacing','width','height','align','valign','bgcolor'])if(element.hasAttribute(key))layout.attributes![key]=element.getAttribute(key)!;
  for(let i=0;i<style.length;i++){const p=style.item(i);if(cssProperties.has(p))layout.style![p]=style.getPropertyValue(p);else if(!/^(font|color|text-indent|line-height|white-space|text-decoration)/.test(p))unsupported?.add(`表格 ${p}`);}
  const normalized=tableDomAttrs(layout,element.ownerDocument);
  for(const [key,value] of Object.entries(layout.attributes!))if(!normalized[key])unsupported?.add(`表格属性 ${key}=${value}`);
  if(/-qt-table-type\s*:/i.test(element.getAttribute('style')||''))unsupported?.add('Qt 文档框架');
  return layout;
}
export function span(value:unknown){const n=Number(value??1);return Number.isSafeInteger(n)&&n>=1&&n<=10000?n:1;}
export function cellDomAttrs(attrs:Record<string,any>,document:Document=window.document){
  const result=tableDomAttrs(attrs.layout,document);if(span(attrs.colspan)>1)result.colspan=String(span(attrs.colspan));if(span(attrs.rowspan)>1)result.rowspan=String(span(attrs.rowspan));
  if(Array.isArray(attrs.colwidth)&&attrs.colwidth.length===span(attrs.colspan)&&attrs.colwidth.every((n:unknown)=>typeof n==='number'&&Number.isFinite(n)&&n>0)){
    if(span(attrs.colspan)===1)result.width=String(attrs.colwidth[0]);
    else{
      // Qt treats a width on a spanning cell as equal constraints on all of
      // its columns, overriding the individual widths in subsequent rows.
      delete result.width;const css=document.createElement('div').style;css.cssText=result.style??'';css.removeProperty('width');if(css.cssText)result.style=css.cssText;else delete result.style;
    }
  }
  return result;
}
/** Browser fixed-layout tables need a column definition when the first row spans cells. */
export function tableColumnWidths(rows:JSONContent[]):number[]{
  const occupied:boolean[][]=rows.map(()=>[]),widths:number[]=[],constraints:{from:number;span:number;width:number}[]=[];
  for(let r=0;r<rows.length;r++){let col=0;for(const cell of rows[r].content??[]){
    while(occupied[r][col])col++;const count=span(cell.attrs?.colspan),height=span(cell.attrs?.rowspan);
    for(let y=r;y<Math.min(rows.length,r+height);y++)for(let x=col;x<col+count;x++)occupied[y][x]=true;
    const values=cell.attrs?.colwidth;if(Array.isArray(values)&&values.length===count)values.forEach((n,i)=>{if(Number.isFinite(n)&&n>0)widths[col+i]=n;});
    const layout=cell.attrs?.layout as TableLayout|undefined,raw=layout?.style?.width??layout?.attributes?.width??'',match=/^(\d+(?:\.\d+)?)(px|pt)?$/.exec(raw);
    if(match){const width=Number(match[1])*(match[2]==='pt'?4/3:1);if(width>0){constraints.push({from:col,span:count,width});if(count===1&&!widths[col])widths[col]=width;}}
    col+=count;
  }}
  const count=Math.max(0,...occupied.map(row=>row.length));
  for(const c of constraints.sort((a,b)=>a.span-b.span)){
    let known=0;const missing:number[]=[];for(let i=c.from;i<c.from+c.span;i++)if(widths[i])known+=widths[i];else missing.push(i);
    if(missing.length&&c.width>known)for(const i of missing)widths[i]=(c.width-known)/missing.length;
  }
  return Array.from({length:count},(_,i)=>widths[i]??0);
}
/** Reject ragged/overlapping imported tables before an editor plugin can repair them. */
export function validTable(rows:JSONContent[]):boolean{
  const grid:boolean[][]=rows.map(()=>[]);let width=0;
  for(let r=0;r<rows.length;r++){let c=0;for(const cell of rows[r].content??[]){while(grid[r][c])c++;const h=span(cell.attrs?.rowspan),w=span(cell.attrs?.colspan);if(r+h>rows.length||c+w>1000)return false;for(let y=r;y<r+h;y++)for(let x=c;x<c+w;x++){if(grid[y][x])return false;grid[y][x]=true;}c+=w;}width=Math.max(width,grid[r].length);}
  return width>0&&grid.every(row=>row.length===width&&Array.from({length:width},(_,i)=>row[i]).every(Boolean));
}
