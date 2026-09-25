import {Plugin,type Transaction} from '@tiptap/pm/state';
import type {Node as PMNode} from '@tiptap/pm/model';
import type {EditorView} from '@tiptap/pm/view';
import {TableMap} from '@tiptap/pm/tables';
import {closeHistory} from '@tiptap/pm/history';
import type {TableLayout} from './table-format';

const sizedLayout=(raw:TableLayout|null,width:number):TableLayout=>({attributes:{...raw?.attributes,width:String(width)},style:{...raw?.style,width:width+'px'}});
/** Write every cell constraint together, including cells spanning the resized column. */
export function resizeTable(tr:Transaction,pos:number,widths:readonly number[]){
  const table=tr.doc.nodeAt(pos);if(table?.type.spec.tableRole!=='table')throw new Error('表格已不存在。');
  const map=TableMap.get(table);
  if(widths.length!==map.width||widths.some(n=>!Number.isFinite(n)||n<1||n>32768))throw new Error('列宽无效。');
  const values=widths.map(Math.round),total=values.reduce((a,b)=>a+b,0);if(total>32768)throw new Error('表格过宽。');
  for(const offset of new Set(map.map)){
    const cell=table.nodeAt(offset)!,rect=map.findCell(offset),colwidth=values.slice(rect.left,rect.right),width=colwidth.reduce((a,b)=>a+b,0);
    tr.setNodeMarkup(pos+1+offset,undefined,{...cell.attrs,colwidth,layout:sizedLayout(cell.attrs.layout,width)});
  }
  return tr.setNodeMarkup(pos,undefined,{...table.attrs,layout:sizedLayout(table.attrs.layout,total)});
}

interface Target {pos:number;node:PMNode;element:HTMLTableElement;column:number;rtl:boolean}
interface Drag extends Target {start:number;widths:number[];width:number;max:number}
function targetAt(view:EditorView,event:MouseEvent):Target|null{
  if(!view.editable||event.buttons)return null;
  const cell=(event.target as Element)?.closest?.('td,th'),element=cell?.closest('table');if(!cell||!element||!view.dom.contains(element))return null;
  const rtl=getComputedStyle(element).direction==='rtl',rect=cell.getBoundingClientRect(),edge=rtl?rect.left:rect.right;
  if(Math.abs(event.clientX-edge)>5)return null;
  const at=view.state.doc.resolve(view.posAtDOM(cell,0));let depth=at.depth;
  while(depth>0&&at.node(depth).type.spec.tableRole!=='table')depth--;
  if(!depth)return null;const pos=at.before(depth),node=at.node(depth),map=TableMap.get(node),offset=at.before(depth+2)-at.start(depth),column=map.findCell(offset).right-1;
  return {pos,node,element,column,rtl};
}
function measuredWidths(view:EditorView,target:Target){
  const map=TableMap.get(target.node),style=getComputedStyle(target.element),spacing=style.borderCollapse==='collapse'?0:parseFloat(style.borderSpacing)||0,widths:number[]=[],constraints:{left:number;right:number;width:number}[]=[];
  for(const offset of new Set(map.map)){
    const cell=view.nodeDOM(target.pos+1+offset);if(!(cell instanceof Element))continue;
    const box=cell.getBoundingClientRect(),rect=map.findCell(offset),width=box.width-spacing*(rect.right-rect.left-1);constraints.push({...rect,width});if(rect.right-rect.left===1)widths[rect.left]=width;
  }
  for(const rect of constraints.sort((a,b)=>(a.right-a.left)-(b.right-b.left))){let known=0;const missing:number[]=[];for(let i=rect.left;i<rect.right;i++)if(widths[i])known+=widths[i];else missing.push(i);for(const i of missing)widths[i]=Math.max(1,(rect.width-known)/missing.length);}
  let sum=0,previous=0;return Array.from({length:map.width},(_,i)=>{sum+=widths[i]??1;const next=Math.round(sum),value=Math.max(1,next-previous);previous=next;return value;});
}
export function tableColumnResize(){
  let controller:ColumnResize;
  return new Plugin({view:view=>(controller=new ColumnResize(view)),props:{handleDOMEvents:{mousemove:(_view,event)=>{controller.hover(event);return false;},mouseleave:()=>{controller.leave();return false;},mousedown:(_view,event)=>controller.down(event)}}});
}
class ColumnResize {
  private target:Target|null=null;
  private drag?:Drag;
  private unsubscribe?:()=>void;
  private guide=document.createElement('div');
  private label=document.createElement('span');
  private host:HTMLElement;
  constructor(private view:EditorView){this.host=view.dom.parentElement!;this.guide.className='table-resize-guide';this.guide.hidden=true;this.guide.append(this.label);this.host.append(this.guide);}
  hover(event:MouseEvent){if(this.drag)return;this.target=targetAt(this.view,event);this.host.classList.toggle('table-resize-hover',!!this.target);}
  leave(){if(!this.drag){this.target=null;this.host.classList.remove('table-resize-hover');}}
  down(event:MouseEvent){
    if(event.button!==0||event.altKey||event.ctrlKey||event.metaKey||event.shiftKey||!this.view.editable||this.view.composing||!this.target||this.drag)return false;
    const target=this.target;if(!target.element.isConnected||this.view.state.doc.nodeAt(target.pos)!==target.node)return false;
    const widths=measuredWidths(this.view,target),width=widths[target.column],total=widths.reduce((a,b)=>a+b,0),available=this.view.dom.clientWidth-(target.element.getBoundingClientRect().width-total),others=total-width;
    const next=widths[target.column+1],max=next===undefined?Math.min(32768-others,Math.max(width,available-others)):width+Math.max(0,next-40);
    this.drag={...target,start:event.clientX,widths,width,max};
    this.guide.hidden=false;this.paint();this.unsubscribe=window.desktop?.onWindowInactive?.(this.cancel);window.addEventListener('mousemove',this.move);window.addEventListener('mouseup',this.up);window.addEventListener('blur',this.cancel);window.addEventListener('resize',this.cancel);window.addEventListener('keydown',this.key,true);event.preventDefault();return true;
  }
  private paint(){const d=this.drag;if(!d)return;const table=d.element.getBoundingClientRect(),base=this.host.getBoundingClientRect(),style=getComputedStyle(d.element),spacing=style.borderCollapse==='collapse'?0:parseFloat(style.borderSpacing)||0,border=parseFloat(d.rtl?style.borderRightWidth:style.borderLeftWidth)||0,distance=d.widths.slice(0,d.column).reduce((a,b)=>a+b,0)+d.width+border+spacing*(d.column+1);this.guide.style.left=((d.rtl?table.right-distance:table.left+distance)-base.left)+'px';this.guide.style.top=(table.top-base.top)+'px';this.guide.style.height=table.height+'px';this.label.textContent=Math.round(d.width)+' px';}
  private move=(event:MouseEvent)=>{if(!this.drag)return;if(!event.buttons){this.cancel();return;}const delta=(event.clientX-this.drag.start)*(this.drag.rtl?-1:1),initial=this.drag.widths[this.drag.column];this.drag.width=delta===0?initial:Math.max(Math.min(40,this.drag.max),Math.min(this.drag.max,initial+delta));this.paint();event.preventDefault();};
  private up=(event:MouseEvent)=>{if(event.button!==0)return;const d=this.drag;this.cancel();if(!d||!this.view.editable||!this.host.getClientRects().length||this.view.state.doc.nodeAt(d.pos)!==d.node||Math.round(d.width)===d.widths[d.column])return;const widths=[...d.widths],delta=Math.round(d.width)-widths[d.column];widths[d.column]+=delta;if(d.column+1<widths.length)widths[d.column+1]-=delta;const tr=resizeTable(closeHistory(this.view.state.tr),d.pos,widths);this.view.dispatch(tr);this.view.dispatch(closeHistory(this.view.state.tr));};
  private key=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();this.cancel();}else if(!['Shift','Control','Alt','Meta'].includes(event.key))this.cancel();};
  private cancel=()=>{this.unsubscribe?.();this.unsubscribe=undefined;this.drag=undefined;this.target=null;this.guide.hidden=true;this.host.classList.remove('table-resize-hover');window.removeEventListener('mousemove',this.move);window.removeEventListener('mouseup',this.up);window.removeEventListener('blur',this.cancel);window.removeEventListener('resize',this.cancel);window.removeEventListener('keydown',this.key,true);};
  update(view:EditorView,previous:{doc:PMNode}){this.view=view;if(this.drag&&(!view.editable||previous.doc!==view.state.doc))this.cancel();}
  destroy(){this.cancel();this.guide.remove();}
}
