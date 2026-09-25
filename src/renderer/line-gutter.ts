import {Plugin} from '@tiptap/pm/state';
import type {Node as PMNode} from '@tiptap/pm/model';
import type {EditorView} from '@tiptap/pm/view';

export interface GutterRow {pos:number;from:number;to:number;line:number;kind:'text'|'divider'|'legacy'|'table';id:number}
export type RowAction='replace'|'extend'|'toggle'|'add';
export function lineRows(doc:PMNode):GutterRow[]{
  const rows:GutterRow[]=[];
  doc.descendants((node,pos)=>{
    if(node.type.spec.tableRole==='row'){rows.push({pos,from:pos+1,to:pos+node.nodeSize-1,line:rows.length+1,kind:'table',id:0});return false;}
    if(node.isTextblock||node.type.name==='divider'||node.type.name==='legacy'){
      rows.push({pos,from:pos+1,to:pos+node.nodeSize-1,line:rows.length+1,kind:node.isTextblock?'text':node.type.name as 'divider'|'legacy',id:node.attrs.id});
      return false;
    }
  });return rows;
}
interface Actions {choose(row:GutterRow,mode:RowAction):void;selected(row:GutterRow):boolean}

/** Only gutter labels are culled. The editor and its selection DOM stay mounted. */
export function lineGutter(actions:Actions){return new Plugin({view:view=>new GutterView(view,actions)});}
class GutterView {
  private rows:GutterRow[]=[];
  private layer=document.createElement('div');
  private host:HTMLElement;
  private scroller:HTMLElement;
  private frame=0;
  private resize?:ResizeObserver;
  private attributes?:MutationObserver;
  private drag?:{last:number;ctrl:boolean;y:number};
  private autoFrame=0;
  private visible:{row:GutterRow;top:number;bottom:number}[]=[];
  private labels=new Map<number,HTMLButtonElement>();
  private nodes=new Map<number,Element|null>();
  private width=36;
  constructor(private view:EditorView,private actions:Actions){
    this.host=view.dom.parentElement!;this.scroller=this.host.closest<HTMLElement>('.document-scroller')??this.host;
    this.layer.className='line-gutter';this.layer.setAttribute('aria-label','行号');this.host.append(this.layer);
    this.layer.addEventListener('mousedown',this.down);
    this.scroller.addEventListener('scroll',this.schedule,{passive:true});
    window.addEventListener('resize',this.schedule);window.addEventListener('blur',this.up);
    view.dom.addEventListener('load',this.schedule,true);
    if(typeof ResizeObserver!=='undefined'){this.resize=new ResizeObserver(this.schedule);this.resize.observe(view.dom);this.resize.observe(this.scroller);}
    // Switching tabs / typography / line-number visibility may preserve the DOM.
    this.attributes=new MutationObserver(this.schedule);
    let parent:HTMLElement|null=this.host;
    while(parent){this.attributes.observe(parent,{attributes:true,attributeFilter:['class','style','hidden']});parent=parent.parentElement;}
    this.rebuild();this.schedule();
  }
  private rebuild(){
    this.rows=lineRows(this.view.state.doc);this.nodes.clear();
    this.width=Math.max(36,14+String(this.rows.length).length*7);
    // Establish the final text width before the first layout, not a frame later.
    const space=this.width+'px';if(this.host.style.getPropertyValue('--gutter-width')!==space)this.host.style.setProperty('--gutter-width',space);
  }
  update(view:EditorView,previous:{doc:PMNode}){this.view=view;if(previous.doc!==view.state.doc)this.rebuild();this.schedule();}
  private schedule=()=>{if(!this.frame)this.frame=requestAnimationFrame(()=>{this.frame=0;this.paint();});};
  private bounds=(row:GutterRow)=>{if(!this.nodes.has(row.pos)){const dom=this.view.nodeDOM(row.pos);this.nodes.set(row.pos,dom instanceof Element?dom:null);}return this.nodes.get(row.pos)?.getBoundingClientRect()??null;};
  private paint(){
    if(!this.host.isConnected||!this.host.getClientRects().length||this.host.closest('.hide-line-numbers')){this.layer.replaceChildren();this.labels.clear();this.visible=[];return;}
    const viewport=this.scroller.getBoundingClientRect(),base=this.host.getBoundingClientRect(),editor=this.view.dom.getBoundingClientRect();
    const width=this.width,space=width+'px';
    let low=0,high=this.rows.length;
    while(low<high){const mid=(low+high)>>>1,r=this.bounds(this.rows[mid]);if(r&&r.bottom<viewport.top-80)low=mid+1;else high=mid;}
    // Complete geometry reads before changing labels, avoiding read/write layout
    // thrashing on startup, scroll, and selection changes.
    const measured:{row:GutterRow;rect:DOMRect;index:number}[]=[];
    for(let i=Math.max(0,low-1);i<this.rows.length;i++){
      const row=this.rows[i],rect=this.bounds(row);if(!rect)continue;if(rect.top>viewport.bottom+80)break;if(rect.bottom<viewport.top-80)continue;
      measured.push({row,rect,index:i});
    }
    this.layer.style.left=(editor.left-base.left-width)+'px';this.layer.style.width=space;
    const retained=new Set<number>();let previous:ChildNode|null=null;this.visible=[];
    for(const {row,rect,index:i} of measured){
      let button=this.labels.get(row.line);
      if(!button){button=document.createElement('button');button.type='button';button.tabIndex=-1;const marker=document.createElement('span');marker.textContent=String(row.line);button.append(marker);this.labels.set(row.line,button);}
      retained.add(row.line);
      button.dataset.line=String(row.line);button.dataset.index=String(i);button.setAttribute('aria-label',`第 ${row.line} 行${row.kind==='divider'?' · 分隔线':row.kind==='legacy'?' · 只读内容':''}`);
      button.className='line-label'+(this.actions.selected(row)?' selected':'')+(row.kind==='divider'?' divider-line':'');button.disabled=row.kind==='legacy';
      button.style.top=(rect.top-base.top)+'px';button.style.height=Math.max(18,rect.height)+'px';
      const next:ChildNode|null=previous?previous.nextSibling:this.layer.firstChild;
      if(next!==button)this.layer.insertBefore(button,next);previous=button;
      this.visible.push({row,top:rect.top,bottom:rect.bottom});
    }
    for(const [line,button] of this.labels)if(!retained.has(line)){button.remove();this.labels.delete(line);}
  }
  private down=(event:MouseEvent)=>{
    if(event.button!==0)return;const target=(event.target as Element).closest<HTMLButtonElement>('button[data-index]');if(!target||target.disabled)return;
    event.preventDefault();const index=Number(target.dataset.index),row=this.rows[index];
    this.actions.choose(row,event.ctrlKey||event.metaKey?'toggle':event.shiftKey?'extend':'replace');
    if(row.kind!=='text'&&row.kind!=='table')return;
    this.drag={last:index,ctrl:event.ctrlKey||event.metaKey,y:event.clientY};document.addEventListener('mousemove',this.move);document.addEventListener('mouseup',this.up);
  };
  private selectAt(y:number){
    const hit=this.visible.find(r=>(r.row.kind==='text'||r.row.kind==='table')&&y>=r.top&&y<r.bottom);if(!hit||!this.drag)return;
    const index=hit.row.line-1;if(index===this.drag.last)return;
    if(this.drag.ctrl){for(let i=Math.min(index,this.drag.last);i<=Math.max(index,this.drag.last);i++)if(this.rows[i].kind==='text'||this.rows[i].kind==='table')this.actions.choose(this.rows[i],'add');}
    else this.actions.choose(hit.row,'extend');this.drag.last=index;
  }
  private move=(event:MouseEvent)=>{if(!this.drag)return;event.preventDefault();this.drag.y=event.clientY;this.selectAt(event.clientY);if(!this.autoFrame)this.autoFrame=requestAnimationFrame(this.autoScroll);};
  private autoScroll=()=>{
    this.autoFrame=0;if(!this.drag)return;const rect=this.scroller.getBoundingClientRect(),y=this.drag.y;
    const delta=y<rect.top+18?-Math.min(30,rect.top+18-y):y>rect.bottom-18?Math.min(30,y-rect.bottom+18):0;
    if(!delta)return;const old=this.scroller.scrollTop;this.scroller.scrollTop+=delta;
    this.paint();this.selectAt(Math.max(rect.top+2,Math.min(rect.bottom-2,y)));
    if(this.scroller.scrollTop!==old)this.autoFrame=requestAnimationFrame(this.autoScroll);
  };
  private up=()=>{this.drag=undefined;cancelAnimationFrame(this.autoFrame);this.autoFrame=0;document.removeEventListener('mousemove',this.move);document.removeEventListener('mouseup',this.up);};
  destroy(){this.up();cancelAnimationFrame(this.frame);this.resize?.disconnect();this.attributes?.disconnect();this.scroller.removeEventListener('scroll',this.schedule);window.removeEventListener('resize',this.schedule);window.removeEventListener('blur',this.up);this.view.dom.removeEventListener('load',this.schedule,true);this.layer.remove();}
}
