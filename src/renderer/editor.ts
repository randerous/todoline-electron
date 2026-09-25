import {multiTextSelection} from './multi-selection';
import {copyToClipboard,eventsClipboardText} from './clipboard-output';
import { Editor, Node, Mark, Extension, CommandManager, type JSONContent } from '@tiptap/core';
import StarterKit from '@tiptap/starter-kit';
import CodeBlock from '@tiptap/extension-code-block';
import { Plugin, PluginKey, TextSelection, NodeSelection, AllSelection, Selection, EditorState, type Transaction } from '@tiptap/pm/state';
import { Decoration, DecorationSet, type EditorView } from '@tiptap/pm/view';
import {dividerDragSelection} from './divider-selection';
import { GapCursor } from '@tiptap/pm/gapcursor';
import { Fragment, Slice, type Node as PMNode, type ResolvedPos } from '@tiptap/pm/model';
import { sinkListItem, liftListItem } from '@tiptap/pm/schema-list';
import { canJoin, Mapping } from '@tiptap/pm/transform';
import type { AssetInput, DocumentSnapshot, EventRecord } from '../shared/types';
import { parseDeadline, formatDate, countdown } from '../shared/deadline';
import { DocumentCodec, eventMeta, groups, newEvent, recordsToJSON, preservesOpaqueBodies } from './document';
import { parseQtHtml, serializeQtHtml, plainText,codeStyleCss } from './codec';
import {closeHistory,isHistoryTransaction} from '@tiptap/pm/history';
import {linkEditingPlugin,linkBeforeCursor,unlinkAtEnd} from './link-editing';
import {lineGutter,type GutterRow,type RowAction} from './line-gutter';
import {readParagraphFormat,formatStyles,normalizeFormat,type ParagraphFormat} from './paragraph-format';
import {partitionBlock,outerTextEdge,isFirstBodyPrefix} from './event-structure';
import {searchMatches,searchPattern,searchTest,type SearchOptions} from '../shared/search';
import {MAX_LIST_DEPTH,bulletLevelStyle,effectiveStyle,isBulletStyle,isListStyle,levelStyle,storedStyle,type ListStyle} from './list-style';
import {AsyncTarget,orderedClipboard} from './async-editing';
import {columnDeleteRange,isModifierKey,leavesRangeMode} from './range-editing';
import {installInputTrace,traceInput} from './input-trace';
import {parseRichClipboard} from './rich-clipboard';
import {prepareEventClipboard} from './event-clipboard';
import {imageAssetReferences,remapImageAssets} from './asset-references';
import {imageFiles,type ImageInput} from './image-import';
import {Table,TableRow,TableCell,TableHeader,TableBehavior} from './tables';
import {TableRowSelection,connectedRows,pasteTableRows,tableRowsPaste} from './table-row-selection';
import {CellSelection,TableMap,selectedRect,goToNextCell,isInTable,addRowAfter,addRowBefore,addColumnAfter,addColumnBefore,deleteRow,deleteColumn,deleteTable,mergeCells,splitCell,toggleHeaderRow,handlePaste as tablePaste} from '@tiptap/pm/tables';

export interface EditorBridge {
  change():void; selection():void; error(message:string):void;
  interceptPaste?(clipboard:Awaited<ReturnType<import('../shared/types').DesktopAPI['readClipboard']>>):Promise<boolean>;
  asset(data:Uint8Array,w:number,h:number):Promise<number>;
  assets?(assets:AssetInput[]):Promise<number[]>;
  imageInfo?(data:Uint8Array):Promise<{width:number;height:number}>;
}
const esc=(value:string)=>value.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]!));
const metaAttrs={id:{default:0},created_at:{default:0},deadline_raw:{default:''},deadline_ts:{default:null},done:{default:0}};
const qtFragment=(html:string,text:string)=>[{created_at:Math.floor(Date.now()/1000),deadline_raw:'',deadline_ts:null,done:false,top_divider:false,html,text}];
const Document=Node.create({name:'doc',topNode:true,content:'(block | eventBoundary)+',addAttributes(){return {head:{default:null}};}});
function boundarySelection(doc:PMNode,pos:number,bias=1){
  const resolved=doc.resolve(pos);
  // Root-level divider atoms allow a paragraph at either document edge.
  // Keep a caret there without inserting an empty paragraph on navigation.
  if(pos===0&&doc.firstChild?.type.name==='divider'||pos===doc.content.size&&doc.lastChild?.type.name==='divider')return new GapCursor(resolved);
  return Selection.near(resolved,bias);
}
const TextStyle=Mark.create({name:'textStyle',addAttributes(){return {color:{default:null},fontSize:{default:null},fontFamily:{default:null},backgroundColor:{default:null}};},parseHTML(){return [{tag:'span[style]',getAttrs:element=>{const s=(element as HTMLElement).style;return {color:s.color||null,fontSize:s.fontSize||null,fontFamily:s.fontFamily||null,backgroundColor:s.backgroundColor||null};}}];},renderHTML({mark}){const a=mark.attrs;return ['span',{style:[a.color&&`color:${a.color}`,a.fontSize&&`font-size:${a.fontSize}`,a.fontFamily&&`font-family:${a.fontFamily}`,a.backgroundColor&&`background-color:${a.backgroundColor}`].filter(Boolean).join(';')},0];}});
/** Inline sizes arrive as pt from Qt and px from this editor; both render against the canvas size. */
const cssPixels=(value:unknown,base:number)=>{
  const match=/^\s*(-?[\d.]+)(px|pt|em|rem|%)?\s*$/.exec(String(value??''));
  const size=match?Number(match[1]):NaN;
  if(!Number.isFinite(size))return base;
  return match![2]==='pt'?size*4/3:match![2]==='em'||match![2]==='rem'?size*base:match![2]==='%'?size*base/100:size;
};
const Highlight=Mark.create({name:'highlight',addAttributes(){return {color:{default:'#ead374'}};},parseHTML(){return [{tag:'mark'}];},renderHTML({mark}){return ['mark',{style:`background-color:${mark.attrs.color}`},0];}});
const Superscript=Mark.create({name:'superscript',excludes:'subscript',parseHTML(){return [{tag:'sup'},{style:'vertical-align=super'}];},renderHTML(){return ['sup',{},0];}});
const Subscript=Mark.create({name:'subscript',excludes:'superscript',parseHTML(){return [{tag:'sub'},{style:'vertical-align=sub'}];},renderHTML(){return ['sub',{},0];}});
const ParagraphFormatting=Extension.create({name:'paragraphFormatting',addGlobalAttributes(){return [{types:['paragraph','heading','listItem','orderedList','bulletList','blockquote','codeBlock'],attributes:{format:{default:null,parseHTML:element=>readParagraphFormat(element),renderHTML:attributes=>{const style=formatStyles(attributes.format,true);return style?{style}:{};}}}}];}});
/** A deletion that leaves two lists showing the same marker side by side joins them, so the
 *  numbering below runs on instead of restarting. Lists that were already neighbours before the
 *  edit stay apart: a restart someone chose is not undone by typing elsewhere in them. */
function joinListsAfterDeletion(transactions:readonly Transaction[],before:PMNode,state:EditorState){
  if(transactions.some(tr=>tr.getMeta('restartNumbering')))return null;
  const maps=transactions.flatMap(t=>t.mapping.maps),all=new Mapping(maps),boundaries=new Set<number>();
  maps.forEach((map,index)=>map.forEach((oldStart,oldEnd,newStart)=>{
    if(oldEnd<=oldStart)return;
    const $pos=state.doc.resolve(Math.min(state.doc.content.size,all.slice(index+1).map(newStart,-1)));
    boundaries.add($pos.pos);
    for(let depth=$pos.depth;depth>0;depth--){const node=$pos.node(depth);if(node.type.name==='orderedList'||node.type.name==='bulletList'){boundaries.add($pos.before(depth));boundaries.add($pos.after(depth));}}
  }));
  if(!boundaries.size)return null;
  const back=all.invert(),tr=state.tr;
  for(const boundary of [...boundaries].sort((a,b)=>b-a)){
    const $boundary=tr.doc.resolve(tr.mapping.map(boundary));
    if(!sameMarker($boundary.nodeBefore,$boundary.nodeAfter)||!canJoin(tr.doc,$boundary.pos))continue;
    const $earlier=before.resolve(Math.min(before.content.size,back.map(boundary)));
    const wasList=(node?:PMNode|null)=>node?.type.name==='orderedList'||node?.type.name==='bulletList';
    if(wasList($earlier.nodeBefore)&&wasList($earlier.nodeAfter))continue;
    tr.join($boundary.pos);
  }
  return tr.docChanged?tr:null;
}
/** Neighbouring lists that would render as one: same kind, marker and geometry, and numbering that continues. */
function sameList(a?:PMNode|null,b?:PMNode|null){
  if(!a||!b||a.type!==b.type||(a.type.name!=='orderedList'&&a.type.name!=='bulletList'))return false;
  if(!sameMarker(a,b))return false;
  return a.type.name==='bulletList'||Number(b.attrs.start??1)===Number(a.attrs.start??1)+a.childCount;
}
/** Lists showing the same marker at the same level, whatever their numbering. */
function sameMarker(a?:PMNode|null,b?:PMNode|null){
  if(!a||!b||a.type!==b.type||(a.type.name!=='orderedList'&&a.type.name!=='bulletList'))return false;
  if((a.attrs.listStyle??null)!==(b.attrs.listStyle??null)||(a.attrs.numberPrefix??null)!==(b.attrs.numberPrefix??null)||(a.attrs.numberSuffix??null)!==(b.attrs.numberSuffix??null))return false;
  return (Number(a.attrs.listIndent)||0)===(Number(b.attrs.listIndent)||0)&&JSON.stringify(a.attrs.format??null)===JSON.stringify(b.attrs.format??null);
}
// Qt numbering and bullet markers; defaults stay unset so existing documents are unchanged.
const ListStyling=Extension.create({name:'listStyling',addGlobalAttributes(){return [{types:['orderedList','bulletList'],attributes:{
  listStyle:{default:null,parseHTML:element=>{const value=element.getAttribute('data-list-style');return isListStyle(value)?value:null;},renderHTML:attributes=>attributes.listStyle?{'data-list-style':attributes.listStyle}:{}},
  numberPrefix:{default:null,rendered:false},numberSuffix:{default:null,rendered:false},
  listIndent:{default:null,parseHTML:element=>Number(element.getAttribute('data-list-indent'))||null,renderHTML:attributes=>attributes.listIndent?{'data-list-indent':String(attributes.listIndent)}:{}},
}}];}});
const EditableCodeBlock=CodeBlock.extend({marks:'_',addAttributes(){return {...this.parent?.(),codeStyle:{default:null,renderHTML:attrs=>{const style=codeStyleCss(attrs.codeStyle);return style?{style}:{};}}};}});
const Legacy=Node.create({name:'legacy',group:'block',atom:true,selectable:false,addAttributes(){return {html:{default:''},text:{default:''},reason:{default:''},id:{default:0}};},parseHTML(){return [{tag:'div[data-legacy]'}];},renderHTML(){return ['div',{'data-legacy':'true'}];},addNodeView(){return ({node})=>{const dom=document.createElement('div');dom.className='legacy-content';dom.contentEditable='false';const label=document.createElement('strong');label.textContent='此事件只读 · '+node.attrs.reason;const pre=document.createElement('div');pre.textContent=node.attrs.text;dom.append(label,pre);return {dom};};}});

/** The frames that assigned selectedRanges, skipping the setter itself, for the input trace. */
const callerOf=(stack?:string)=>stack?.split('\n').slice(2,4).map(line=>line.trim().replace(/^at /,'')).join(' < ')??'';
export class TodoEditor {
  editor:Editor;
  codec:DocumentCodec;
  selectedEvents=new Set<number>();
  private ranges:{from:number;to:number;row?:boolean}[]=[];
  /** Column carets and row ranges. Their start and end go into the input trace with the caller,
   *  so a trace exported where a column selection vanishes names the path that ended it. */
  get selectedRanges(){return this.ranges;}
  set selectedRanges(next:{from:number;to:number;row?:boolean}[]){
    if((this.ranges.length>0)!==(next.length>0))traceInput(next.length?'column-start':'column-clear',next.length?`${next.length} ranges`:callerOf(new Error().stack));
    this.ranges=next;
  }
  private matcher:RegExp|null=null;
  private searchWhole=false;
  setSearch(query:string,whole=false,options:SearchOptions={}){this.matcher=searchPattern(query,options);this.searchWhole=whole;this.editor.view.dispatch(this.editor.state.tr.setMeta(selectionKey,true));}
  private rowAnchor:number|null=null;
  private refreshers=new Set<()=>void>();
  private refreshTimer?:ReturnType<typeof setInterval>;
  private mounts=new Map<Element,()=>void>();
  private observer?:IntersectionObserver;
  private createdDividers=0;
  private composition=false;
  /** A key that types was pressed since the column selection was made; see compositionupdate. */
  private columnKeyed=false;
  private imageUrls=new Set<string>();
  private operations=new Set<Promise<void>>();
  private editTail:Promise<unknown>|undefined;
  private imageCount=0;
  get importingImages(){return this.imageCount;}
  private asyncTargets=new Set<AsyncTarget>();
  private applyingAsync=false;
  private captureTarget(restoring=false,wholeEvent=false,snapshot=false){
    // Chromium may deliver selectionchange after the next copy/paste event.
    // Read the visible text selection before taking an asynchronous bookmark.
    const view=this.editor.view,native=document.getSelection();
    if(!restoring&&!this.composition&&!view.composing&&!this.selectedEvents.size&&!this.selectedRanges.length&&view.hasFocus()&&view.state.selection instanceof TextSelection&&native?.anchorNode&&native.focusNode&&view.dom.contains(native.anchorNode)&&view.dom.contains(native.focusNode)){
      try{
        const anchor=view.posAtDOM(native.anchorNode,native.anchorOffset),head=view.posAtDOM(native.focusNode,native.focusOffset);
        if(anchor>=0&&head>=0&&anchor<=view.state.doc.content.size&&head<=view.state.doc.content.size&&view.state.doc.resolve(anchor).parent.isTextblock&&view.state.doc.resolve(head).parent.isTextblock){const selection=TextSelection.create(view.state.doc,anchor,head);if(!selection.eq(view.state.selection))view.dispatch(view.state.tr.setSelection(selection));}
      }catch{/* A transient native range may refer to a node already removed. */}
    }
    const selection=this.editor.state.selection,events=new Set(this.selectedEvents),ranges=this.selectedRanges.map(r=>({...r}));
    if(wholeEvent&&!events.size){const g=groups(this.editor.state.doc,this.codec.head).find(g=>selection.from>=g.start&&selection.from<=g.end);if(g)events.add(g.meta.id);}
    const protectedRanges=events.size?groups(this.editor.state.doc,this.codec.head).filter(g=>events.has(g.meta.id)).map(g=>({from:g.start,to:g.end})):ranges.length?ranges:selection.ranges.map(r=>({from:r.$from.pos,to:r.$to.pos}));
    const target=new AsyncTarget(selection,events,ranges,protectedRanges,restoring,snapshot);target.uiSelection=JSON.stringify([[...this.selectedEvents],this.selectedRanges]);this.asyncTargets.add(target);return target;
  }
  private async commitTarget(target:AsyncTarget,operation:()=>void,validate?:()=>void){
    if(this.composition||this.editor.view.composing)await new Promise<void>(resolve=>{
      const dom=this.editor.view.dom;
      let timer:ReturnType<typeof setTimeout>|undefined;
      const done=()=>{clearTimeout(timer);dom.removeEventListener('compositionend',ended);this.editor.off('destroy',done);resolve();};
      const ended=()=>{clearTimeout(timer);timer=setTimeout(()=>{if(!this.composition&&!this.editor.view.composing)done();},0);};
      dom.addEventListener('compositionend',ended);this.editor.on('destroy',done);
    });
    if(!this.editor.isDestroyed&&target.valid)validate?.();
    this.applyTarget(target,operation);
  }
  private applyTarget(target:AsyncTarget,operation:()=>void){
    this.asyncTargets.delete(target);
    if(this.editor.isDestroyed||this.snapshot.readOnly)return;
    if(!target.valid)throw new Error('等待期间目标内容已被修改，未覆盖新内容。请重新选择后重试。');
    const restore=target.moved?this.captureTarget(true):undefined;
    const focus=!target.moved&&(this.editor.view.hasFocus()||document.activeElement===target.activeElement||document.activeElement===document.body);
    this.applyingAsync=true;
    try{
      this.selectedEvents=new Set(target.events);this.selectedRanges=target.ranges.map(r=>({...r}));
      this.editor.view.dispatch(closeHistory(this.editor.state.tr.setSelection(target.selection).setMeta(selectionKey,true)));
      operation();
      if(restore){const existing=restore.events.size?new Set(groups(this.editor.state.doc,this.codec.head).map(g=>g.meta.id)):new Set<number>();this.selectedEvents=new Set([...restore.events].filter(id=>existing.has(id)));this.selectedRanges=restore.ranges;this.editor.view.dispatch(this.editor.state.tr.setSelection(restore.selection).setMeta(selectionKey,true));}
      this.editor.view.dispatch(closeHistory(this.editor.state.tr));
      if(focus)this.editor.view.focus();
    }finally{if(restore)this.asyncTargets.delete(restore);this.applyingAsync=false;}
  }
  get handle(){return this.snapshot.handle;}
  private beginOperation(){
    let finish!:()=>void;
    const pending=new Promise<void>(resolve=>{finish=resolve;});this.operations.add(pending);
    return ()=>{this.operations.delete(pending);finish();};
  }
  private orderedEdit<T>(operation:()=>Promise<T>,clipboard=false,isCopy=false):Promise<T>{
    // Reserve both queues at invocation, before waiting for either. Reading the
    // current tail inside the callback could make a later operation wait on itself.
    const previous=this.editTail,run=()=>previous?previous.then(operation):operation();
    const next=clipboard?orderedClipboard(run,isCopy):run();
    const settled=next.catch(()=>{});this.editTail=settled;
    void settled.then(()=>{if(this.editTail===settled)this.editTail=undefined;});
    return next;
  }
  async whenIdle(){while(this.operations.size)await Promise.all([...this.operations]);}
  retarget(snapshot:DocumentSnapshot,exported:EventRecord[]){
    if(snapshot.events.length!==exported.length)throw new Error('另存结果与导出的事件数量不一致。');
    const ids:Record<string,number>={};exported.forEach((e,i)=>{ids[e.id]=snapshot.events[i].id;});
    const oldHandle=this.handle;this.codec.remap(ids);this.snapshot=snapshot;
    for(const img of this.editor.view.dom.querySelectorAll<HTMLImageElement>('.image-view img')){
      const prefix=`tde-asset://document/${oldHandle}/`;
      if(img.src.startsWith(prefix))img.src=`tde-asset://document/${snapshot.handle}/${img.src.slice(prefix.length)}`;
    }
  }
  constructor(element:HTMLElement, public snapshot:DocumentSnapshot, private bridge:EditorBridge) {
    installInputTrace();
    this.codec=new DocumentCodec(snapshot.events);
    if(typeof IntersectionObserver!=='undefined')this.observer=new IntersectionObserver(entries=>{for(const entry of entries)if(entry.isIntersecting){this.mounts.get(entry.target)?.();this.mounts.delete(entry.target);this.observer?.unobserve(entry.target);}},{rootMargin:'500px'});
    const owner=this;
    const Divider=Node.create({
      name:'divider',group:'eventBoundary',atom:true,selectable:true,draggable:false,
      addAttributes(){return metaAttrs;},parseHTML(){return [{tag:'div[data-divider]'}];},
      renderHTML({node}){return ['div',{'data-divider':JSON.stringify(node.attrs)}];},
      addNodeView(){return ({node,getPos,editor})=>{
        let current=node;
        const dom=document.createElement('div');dom.className='event-divider';dom.contentEditable='false';
        let check:HTMLButtonElement,input:HTMLInputElement,created:Element,count:Element,ready=false;
        function refresh(){dom.dataset.id=String(current.attrs.id);dom.classList.toggle('done',!!current.attrs.done);if(!ready)return;check.textContent=current.attrs.done?'✓':'';check.setAttribute('aria-pressed',String(!!current.attrs.done));created.textContent=formatDate(current.attrs.created_at);if(document.activeElement!==input)input.value=current.attrs.deadline_raw;input.title=current.attrs.deadline_ts?'已识别截止时间 '+formatDate(current.attrs.deadline_ts):current.attrs.deadline_raw?'未识别为时间，将按原文保留：'+current.attrs.deadline_raw:'输入截止时间，例如 2026-09-30 18:00、明天下午3点、2小时后';count.textContent=current.attrs.deadline_ts?countdown(current.attrs.deadline_ts):'';count.classList.toggle('urgent',!!current.attrs.deadline_ts&&current.attrs.deadline_ts*1000-Date.now()<3600000);}
        function patch(attrs:Record<string,unknown>){if(!editor.isEditable)return;const pos=getPos();if(typeof pos==='number')editor.view.dispatch(editor.state.tr.setNodeMarkup(pos,undefined,{...current.attrs,...attrs}));}
        function mount(){if(ready)return;dom.dataset.ready='true';dom.innerHTML='<span class="divider-side"><button class="event-check" title="标记完成" aria-label="标记完成"></button><span class="divider-stroke"></span></span><span class="event-created"></span><span class="divider-side"><span class="divider-stroke"></span><input class="event-deadline" placeholder="设置截止时间" aria-label="截止时间"><span class="divider-stroke"></span><span class="countdown"></span><span class="divider-stroke divider-tail"></span></span>';check=dom.querySelector('button')!;input=dom.querySelector('input')!;created=dom.querySelector('.event-created')!;count=dom.querySelector('.countdown')!;ready=true;
          check.disabled=!!owner.snapshot.readOnly;input.readOnly=!!owner.snapshot.readOnly;check.addEventListener('click',()=>patch({done:current.attrs.done?0:1}));
          // Leaving the field re-reads it, so "10 分钟后" counts from the moment
          // the caret leaves rather than from the first time it was typed.
          const commit=()=>{const ts=parseDeadline(input.value);if(input.value!==current.attrs.deadline_raw||ts!==current.attrs.deadline_ts)patch({deadline_raw:input.value,deadline_ts:ts});};
          input.addEventListener('change',commit);input.addEventListener('blur',()=>{commit();refresh();});input.addEventListener('keydown',event=>{if(event.key==='Enter'){input.blur();editor.commands.focus();}event.stopPropagation();});refresh();}
        if(!owner.observer||owner.createdDividers++<16)mount();else{dom.innerHTML='<span class="divider-stroke divider-placeholder"></span>';owner.mounts.set(dom,mount);owner.observer.observe(dom);}
        dom.addEventListener('mousedown',event=>{
          if(event.button!==0)return;
          if((event.target as HTMLElement).closest('button,input'))return;
          event.preventDefault();const p=getPos();if(typeof p!=='number')return;
          if(!event.ctrlKey)owner.selectedEvents.clear();
          const id=current.attrs.id;owner.selectedEvents.has(id)?owner.selectedEvents.delete(id):owner.selectedEvents.add(id);
          editor.view.dispatch(editor.state.tr.setSelection(NodeSelection.create(editor.state.doc,p)).setMeta(selectionKey,true));editor.view.focus();owner.bridge.selection();
        });
        const refreshVisible=()=>{const r=dom.getBoundingClientRect();if(r.bottom>0&&r.top<innerHeight)refresh();};owner.refreshers.add(refreshVisible);refresh();
        return {dom,update(next){if(next.type!==current.type)return false;current=next;refresh();return true;},stopEvent(event){return (event.target as HTMLElement).matches('input,button');},ignoreMutation(){return true;},destroy(){owner.refreshers.delete(refreshVisible);owner.mounts.delete(dom);owner.observer?.unobserve(dom);}};
      };},
    });
    const Image=Node.create({
      name:'image',inline:true,group:'inline',atom:true,selectable:true,draggable:true,
      addAttributes(){return {assetId:{default:null},src:{default:null},width:{default:320},height:{default:240},alt:{default:''}};},
      parseHTML(){return [{tag:'img',getAttrs:el=>{const e=el as HTMLImageElement;const m=e.getAttribute('src')?.match(/asset:(\d+)/);return {assetId:m?Number(m[1]):null,width:Number(e.getAttribute('width'))||320,height:Number(e.getAttribute('height'))||240,alt:e.alt};}}];},
      renderHTML({node}){return ['img',{src:`asset:${node.attrs.assetId}`,width:node.attrs.width,height:node.attrs.height,alt:node.attrs.alt}];},
      addNodeView(){return ({node,getPos,editor})=>{
        let current=node;
        const dom=document.createElement('span');dom.className='image-view';dom.contentEditable='false';
        const img=document.createElement('img');img.loading='lazy';img.draggable=false;dom.append(img);
        function refresh(){img.src=`tde-asset://document/${owner.handle}/${current.attrs.assetId}`;img.style.width=current.attrs.width+'px';img.style.height=current.attrs.height+'px';img.alt=current.attrs.alt||'图片';}
        for(let i=0;i<8;i++){
          const grip=document.createElement('span');grip.className=`image-grip grip-${i}`;grip.dataset.handle=String(i);dom.append(grip);
          grip.addEventListener('pointerdown',event=>{
            event.preventDefault();event.stopPropagation();const pos=getPos();if(typeof pos!=='number')return;
            const startX=event.clientX,startY=event.clientY,w=Number(current.attrs.width),h=Number(current.attrs.height);let nw=w,nh=h;
            grip.setPointerCapture(event.pointerId);
            const move=(e:PointerEvent)=>{const dx=e.clientX-startX,dy=e.clientY-startY;const sx=[0,6,7].includes(i)?-1:[2,3,4].includes(i)?1:0;const sy=[0,1,2].includes(i)?-1:[4,5,6].includes(i)?1:0;
              nw=sx?w+sx*dx:w;nh=sy?h+sy*dy:h;
              if(i%2===0){const scale=Math.max(nw/w,nh/h,24/w,24/h);nw=w*scale;nh=h*scale;}
              nw=Math.max(24,Math.min(nw,editor.view.dom.clientWidth-20));nh=Math.max(24,Math.min(nh,4000));img.style.width=nw+'px';img.style.height=nh+'px';};
            const up=()=>{grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',up);grip.removeEventListener('pointercancel',cancel);const p=getPos();if(typeof p==='number')editor.view.dispatch(editor.state.tr.setNodeMarkup(p,undefined,{...current.attrs,width:Math.round(nw),height:Math.round(nh)}));};
            const cancel=()=>{refresh();grip.removeEventListener('pointermove',move);grip.removeEventListener('pointerup',up);grip.removeEventListener('pointercancel',cancel);};
            grip.addEventListener('pointermove',move);grip.addEventListener('pointerup',up);grip.addEventListener('pointercancel',cancel);
          });
        }
        refresh();return {dom,update(next){if(next.type!==current.type)return false;current=next;refresh();return true;},selectNode(){dom.classList.add('ProseMirror-selectednode');},deselectNode(){dom.classList.remove('ProseMirror-selectednode');},stopEvent(event){return (event.target as HTMLElement).classList.contains('image-grip');},ignoreMutation(){return true;}};
      };},
    });
    const Behavior=Extension.create({name:'todolineBehavior',priority:1000,addProseMirrorPlugins(){return [multiTextSelection({get:()=>owner.selectedRanges,set:(ranges,view)=>{owner.selectedEvents.clear();owner.selectedRanges=ranges;owner.columnKeyed=false;const pos=ranges[0]?.from??view.state.selection.head;view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos))).setMeta(selectionKey,true));owner.bridge.selection();}}),owner.behaviorPlugin(),dividerDragSelection(),owner.decorationsPlugin(),linkEditingPlugin(),lineGutter({choose:(row,mode)=>owner.chooseRow(row,mode),selected:row=>owner.rowSelected(row)})];},addKeyboardShortcuts(){return {'Mod-t':()=>{owner.moveCurrentEventToTop();return true;},'Mod-h':()=>owner.split(),'Mod-a':()=>{owner.editor.view.dispatch(owner.editor.state.tr.setSelection(new AllSelection(owner.editor.state.doc)));return true;},'Mod-l':()=>owner.toggleListLines('orderedList'),'Mod-c':()=>{void owner.copy();return true;},'Mod-x':()=>{void owner.copy(false,true);return true;},'Mod-v':()=>{void owner.paste();return true;},'Mod-Shift-c':()=>{void owner.copy(true);return true;},'Mod-Shift-x':()=>{void owner.copy(true,true);return true;},'Mod-Shift-v':()=>{void owner.paste();return true;}};}});
    this.editor=new Editor({element,extensions:[StarterKit.configure({document:false,horizontalRule:false,codeBlock:false,trailingNode:false,undoRedo:{depth:300},link:{openOnClick:false,autolink:false,linkOnPaste:false}}),Document,EditableCodeBlock,TextStyle,Superscript,Subscript,Highlight,ParagraphFormatting,ListStyling,Table,TableRow,TableCell,TableHeader,Divider,Image,Legacy,Behavior,TableBehavior],content:recordsToJSON(snapshot.events),editable:!snapshot.readOnly,injectCSS:false,onUpdate:()=>bridge.change(),onSelectionUpdate:()=>bridge.selection(),editorProps:{attributes:{class:'todo-document',spellcheck:'false','aria-label':'文档正文',role:'textbox','aria-multiline':'true'}}});
    this.codec.prime(this.editor.state.doc);
    this.editor.on('transaction',({transaction,appendedTransactions})=>{for(const tr of [transaction,...appendedTransactions])for(const target of this.asyncTargets){
      if(!this.applyingAsync&&tr.getMeta(selectionKey)&&target.uiSelection!==JSON.stringify([[...this.selectedEvents],this.selectedRanges]))target.moved=true;
      target.map(tr,this.applyingAsync);
    }});
    this.refreshTimer=setInterval(()=>{for(const fn of this.refreshers)fn();},30000);
  }
  private behaviorPlugin() {
    const owner=this;
    return new Plugin({
      appendTransaction(transactions,oldState,state){
        if(!transactions.some(t=>t.docChanged)||transactions.some(t=>t.getMeta('structuralHead')||isHistoryTransaction(t)))return;
        const old=oldState.doc.firstChild,first=state.doc.firstChild;
        if(old?.type.name==='divider'&&first?.type.name!=='divider'){
          let stillExists=false;state.doc.forEach(n=>{if(n.type.name==='divider'&&n.attrs.id===old.attrs.id)stillExists=true;});
          return state.tr.setDocAttribute('head',stillExists?eventMeta(newEvent()):{...old.attrs}).setMeta('structuralHead',true);
        }
        return joinListsAfterDeletion(transactions,oldState.doc,state);
      },
      filterTransaction(tr,state){
        if(owner.snapshot.readOnly&&tr.docChanged)return false;
        if(!tr.docChanged||tr.getMeta('remap'))return true;
        // An accepted history entry may add/remove an opaque event as a whole.
        // Ordinary editing must keep every existing opaque body untouched.
        if(!preservesOpaqueBodies(state.doc,tr.doc,owner.codec.head,isHistoryTransaction(tr))){owner.bridge.error('该事件包含只读内容，已阻止修改。');return false;}return true;
      },
      props:{handleDOMEvents:{
        keydown(view,event){if(!event.altKey&&!isModifierKey(event))owner.columnKeyed=true;if(event.isComposing||owner.composition||view.composing)return true;if(owner.selectedRanges.length&&leavesRangeMode(event)){owner.selectedRanges=[];view.dispatch(view.state.tr.setMeta(selectionKey,true));}return false;},
        compositionstart(view){owner.composition=true;const tr=view.state.tr;if(tr.selection instanceof TableRowSelection)tr.setSelection(Selection.near(tr.selection.$from));view.dispatch(tr.setMeta(selectionKey,true));return false;},
        // Input methods start compositions of their own when the editor gains focus or is clicked:
        // empty ones, and on some systems ones that already carry text. Only text the user composes,
        // with a key pressed after the column selection was made, leaves column mode (it composes at
        // a single caret); anything else would wipe the selection an Alt+drag just made.
        compositionupdate(view,event){if(owner.selectedRanges.length&&event.data&&owner.columnKeyed){owner.selectedRanges=[];view.dispatch(view.state.tr.setMeta(selectionKey,true));}return false;},
        compositionend(view,event){owner.composition=false;if(owner.selectedRanges.length&&event.data&&owner.columnKeyed){owner.selectedRanges=[];view.dispatch(view.state.tr.setMeta(selectionKey,true));}return false;},
        mousedown(view,event){
          if(event.button!==0)return false;
          if(!event.altKey){if(!(event.target as HTMLElement).closest('.event-divider'))owner.selectedEvents.clear();if(owner.selectedRanges.length){owner.selectedRanges=[];view.dispatch(view.state.tr.setMeta(selectionKey,true));}return false;}
          owner.selectedEvents.clear();
          event.preventDefault();const x=event.clientX,y=event.clientY;
          const move=(e:MouseEvent)=>{const line=parseFloat(getComputedStyle(view.dom).lineHeight)||22.5;const ranges:{from:number;to:number}[]=[];
            for(let cy=Math.min(y,e.clientY);cy<=Math.max(y,e.clientY)+1;cy+=line){const a=view.posAtCoords({left:Math.min(x,e.clientX),top:cy}),b=view.posAtCoords({left:Math.max(x,e.clientX),top:cy});if(!a||!b)continue;const $a=view.state.doc.resolve(a.pos),$b=view.state.doc.resolve(b.pos);if(!$a.parent.isTextblock||!$a.sameParent($b))continue;const from=Math.min(a.pos,b.pos),to=Math.max(a.pos,b.pos);if(!ranges.some(r=>r.from===from&&r.to===to))ranges.push({from,to});}
            owner.selectedRanges=ranges;owner.columnKeyed=false;const first=ranges[0];if(first)view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,first.from)).setMeta(selectionKey,true));};
          const up=()=>{document.removeEventListener('mousemove',move);document.removeEventListener('mouseup',up);traceInput('column-drag-end',`${owner.selectedRanges.length} ranges, focused=${view.hasFocus()}`);if(!view.hasFocus())view.focus();};document.addEventListener('mousemove',move);document.addEventListener('mouseup',up);move(event);return true;
        },
        copy(_v,event){event.preventDefault();void owner.copy();return true;},cut(_v,event){event.preventDefault();void owner.copy(false,true);return true;},
      },handleTextInput(_view,_from,_to,text){if(owner.selectedRanges.length&&!owner.composition){owner.replaceRanges(text);return true;}return false;},handlePaste(_v,event){event.preventDefault();void owner.paste();return true;},handleDrop(view,event){
        const files=imageFiles(event.dataTransfer?.files);
        if(!files.length)return false;event.preventDefault();owner.selectedEvents.clear();owner.selectedRanges=[];const p=view.posAtCoords({left:event.clientX,top:event.clientY});if(p)view.dispatch(view.state.tr.setSelection(Selection.near(view.state.doc.resolve(p.pos))));void owner.insertImages(files);return true;
      },handleClick(view,pos,event){
        const link=(event.target as HTMLElement).closest('a');if(link&&event.ctrlKey){void window.desktop.openLink(link.getAttribute('href')??'').catch(e=>owner.bridge.error(String(e)));return true;}
        if(!(event.target as HTMLElement).closest('.event-divider'))owner.selectedEvents.clear();
        // Chromium can move its caret before dispatching selectionchange. Commit
        // a plain click now so an immediate Home/End or typing uses that caret.
        // ProseMirror calls this only for a single click, not drag/Shift ranges.
        const target=event.target as HTMLElement,block=target.closest('p,h1,h2,h3,h4,h5,h6,pre');
        if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&!owner.composition&&!view.composing&&block&&!target.closest('.image-view,.event-divider,.legacy-content')){
          const native=view.dom.ownerDocument.getSelection();let caret=pos;
          if(native?.isCollapsed&&native.anchorNode&&block.contains(native.anchorNode))caret=view.posAtDOM(native.anchorNode,native.anchorOffset);
          if(caret>=0&&caret<=view.state.doc.content.size&&view.state.doc.resolve(caret).parent.isTextblock){owner.rowAnchor=null;view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,caret)).setMeta('pointer',true).setMeta(selectionKey,true));view.focus();return true;}
        }
        return false;
      },handleKeyDown(view,event){
        if(owner.composition||view.composing||event.isComposing)return false;
        if(owner.selectedRanges.length){
          if((event.key==='Delete'||event.key==='Backspace')&&!event.ctrlKey&&!event.metaKey&&!event.altKey){owner.replaceRanges('',event.key==='Backspace'?-1:1);return true;}
        }
        // Native vertical movement can precede Chromium's selectionchange event.
        // Home/End must use the visible caret even when pressed immediately.
        if((event.key==='Home'||event.key==='End')&&view.state.selection instanceof TextSelection&&view.state.selection.empty&&!owner.selectedEvents.size&&!owner.selectedRanges.length&&view.hasFocus()){
          const native=view.dom.ownerDocument.getSelection();
          if(native?.isCollapsed&&native.anchorNode&&view.dom.contains(native.anchorNode)){
            const pos=view.posAtDOM(native.anchorNode,native.anchorOffset);
            if(pos!==view.state.selection.from&&pos>=0&&pos<=view.state.doc.content.size&&view.state.doc.resolve(pos).parent.isTextblock)view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc,pos)));
          }
        }
        const {state}=view,{selection}=state;
        if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!owner.selectedRanges.length&&owner.editor.isEditable&&isInTable(state)){
          const direction=event.shiftKey?-1:1;if(goToNextCell(direction)(state,tr=>view.dispatch(tr)))return true;
          if(direction===1&&addRowAfter(state,tr=>owner.dispatchStructure(tr))){goToNextCell(1)(view.state,tr=>view.dispatch(tr));return true;}return true;
        }
        if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&owner.editor.isEditable&&!owner.selectedEvents.size&&!owner.selectedRanges.length){
          if(event.key==='Backspace'&&owner.backspaceEmptyListLine())return true;
          if(event.key==='Backspace'&&owner.joinListItemBackward())return true;
          if(event.key==='Backspace'){const tr=unlinkAtEnd(state);if(tr){view.dispatch(tr.scrollIntoView());return true;}}
          if(event.key===' '){const tr=state.tr;if(linkBeforeCursor(tr,state)){view.dispatch(closeHistory(tr).insertText(' ').scrollIntoView());return true;}}
          if(event.key==='Enter'&&linkBeforeCursor(state.tr,state)){
            const prefix=selection.$from.parent.textBetween(0,selection.$from.parentOffset),indent=prefix.match(/^[ \t]+/)?.[0];
            if(indent&&selection.$from.parent.type.name==='paragraph'&&selection.$from.depth===1){const tr=closeHistory(state.tr);linkBeforeCursor(tr,state);view.dispatch(tr.split(selection.from).insertText(indent).scrollIntoView());return true;}
            return owner.editor.chain().command(({tr})=>{closeHistory(tr);linkBeforeCursor(tr,state);return true;}).first(({commands})=>[()=>commands.splitListItem('listItem'),()=>commands.splitBlock()]).run();
          }
        }
        if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!owner.selectedRanges.length&&!owner.selectedEvents.size&&owner.indentListItem(event.shiftKey?-1:1))return true;
        if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&!owner.selectedRanges.length&&!owner.selectedEvents.size&&owner.indentLines(event.shiftKey?-1:1))return true;
        if(!event.ctrlKey&&!event.metaKey&&!event.altKey&&!event.shiftKey&&owner.editor.isEditable){
          if(event.key==='Tab'){
            if(owner.selectedRanges.length)owner.replaceRanges('    ');
            else view.dispatch(state.tr.insertText('    ').scrollIntoView());
            return true;
          }
          if(selection.empty&&selection.$from.parent.isTextblock){
            const prefix=selection.$from.parent.textBetween(0,selection.$from.parentOffset);
            if(event.key==='Backspace'&&/^ +$/.test(prefix)){
              view.dispatch(state.tr.delete(selection.from-(prefix.length%4||4),selection.from).scrollIntoView());return true;
            }
            if(event.key==='Enter'&&selection.$from.parent.type.name==='paragraph'&&selection.$from.depth===1){
              const indent=prefix.match(/^[ \t]+/)?.[0];
              if(indent){view.dispatch(state.tr.split(selection.from).insertText(indent).scrollIntoView());return true;}
            }
          }
        }
        if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&!event.shiftKey&&owner.selectedEvents.size){
          const selected=groups(state.doc,owner.codec.head).filter(g=>owner.selectedEvents.has(g.meta.id));
          owner.selectedEvents.clear();
          if(selected.length){const pos=event.key==='ArrowLeft'?selected[0].start:selected.at(-1)!.end;
            view.dispatch(state.tr.setSelection(boundarySelection(state.doc,pos,event.key==='ArrowLeft'?1:-1)).setMeta(selectionKey,true).scrollIntoView());return true;}
        }
        if(event.key==='Home'||event.key==='End'){
          const text=selection.$from.parent.isTextblock?selection:Selection.findFrom(selection.$from,1,true)??Selection.findFrom(selection.$from,-1,true);
          if(!text&&!event.ctrlKey)return false;
          let pos=event.ctrlKey?(event.key==='Home'?0:state.doc.content.size):(event.key==='Home'?text!.$from.start():text!.$from.end());
          if(!event.ctrlKey&&text!.$from.parent.type.spec.code){const value=text!.$from.parent.textContent,offset=text!.$from.parentOffset;const edge=event.key==='Home'?(offset===0?0:value.lastIndexOf('\n',offset-1)+1):value.indexOf('\n',offset);pos=text!.$from.start()+(edge<0?value.length:edge);}
          const next=event.shiftKey?TextSelection.create(state.doc,selection.anchor,Selection.near(state.doc.resolve(pos),event.key==='Home'?1:-1).from):boundarySelection(state.doc,pos,event.key==='Home'?1:-1);
          owner.selectedEvents.clear();view.dispatch(state.tr.setSelection(next).setMeta(selectionKey,true).scrollIntoView());return true;
        }
        if(event.key==='Escape'){owner.selectedRanges=[];owner.selectedEvents.clear();view.dispatch(state.tr.setSelection(boundarySelection(state.doc,selection.from)).setMeta(selectionKey,true));return true;}
        if(owner.selectedRanges.length&&(event.key==='Delete'||event.key==='Backspace')){owner.replaceRanges('');return true;}
        if(owner.selectedRanges.length&&event.key.startsWith('Arrow')){owner.selectedRanges=[];view.dispatch(state.tr.setMeta(selectionKey,true));}
        if((event.key==='ArrowLeft'||event.key==='ArrowRight')&&!event.shiftKey&&!selection.empty){
          owner.selectedEvents.clear();const pos=event.key==='ArrowLeft'?selection.from:selection.to;
          view.dispatch(state.tr.setSelection(boundarySelection(state.doc,pos,event.key==='ArrowLeft'?1:-1)).setMeta(selectionKey,true).scrollIntoView());return true;
        }
        if(event.key==='Delete'||event.key==='Backspace'){
          if(owner.selectedEvents.size){owner.deleteEvents();return true;}
          if(!selection.empty)return false;
          const pos=selection.from;
          if(event.key==='Delete'&&selection instanceof GapCursor&&state.doc.nodeAt(pos)?.type.name==='divider'){const tr=state.tr.delete(pos,pos+1);owner.dispatchStructure(tr.setSelection(Selection.near(tr.doc.resolve(pos))));return true;}
          if(event.key==='Backspace'&&selection instanceof GapCursor&&selection.$from.nodeBefore?.type.name==='divider'){const tr=state.tr.delete(pos-1,pos);owner.dispatchStructure(tr.setSelection(boundarySelection(tr.doc,Math.min(pos-1,tr.doc.content.size))).scrollIntoView());return true;}
          if(event.key==='Backspace'&&outerTextEdge(selection.$from)!==null){
            const before=outerTextEdge(selection.$from)!;const prev=before>0?state.doc.resolve(before).nodeBefore:null;
            if(prev?.type.name==='divider'){const tr=state.tr.delete(before-prev.nodeSize,before);owner.dispatchStructure(tr.setSelection(Selection.near(tr.doc.resolve(Math.max(0,before-prev.nodeSize)))).scrollIntoView());return true;}
          }
          if(event.key==='Delete'&&outerTextEdge(selection.$from,true)!==null){const after=outerTextEdge(selection.$from,true)!;const next=state.doc.nodeAt(after);if(next?.type.name==='divider'){owner.dispatchStructure(state.tr.delete(after,after+next.nodeSize));return true;}}
        }
        if(event.key==='Enter'&&selection instanceof GapCursor&&owner.editor.isEditable&&!event.ctrlKey&&!event.metaKey&&!event.altKey){
          const tr=state.tr.insert(selection.from,state.schema.nodes.paragraph.create());
          owner.dispatchStructure(tr.setSelection(TextSelection.create(tr.doc,selection.from+1)).scrollIntoView());return true;
        }
        if(event.key==='Enter'&&selection instanceof NodeSelection&&selection.node.type.name==='image'){
          const tr=state.tr.setSelection(TextSelection.create(state.doc,selection.to));view.dispatch(tr);owner.editor.commands.splitBlock();return true;
        }
        if(event.key==='ArrowLeft'&&selection.empty&&outerTextEdge(selection.$from)===1&&state.doc.firstChild?.type.name==='divider'){
          view.dispatch(state.tr.setSelection(new GapCursor(state.doc.resolve(0))));return true;
        }
        return false;
      }},
    });
  }
  private decorationsPlugin() {
    const owner=this;
    const decorate=(doc:PMNode,selection:Selection)=>{const ds:Decoration[]=[];let done=!!(doc.attrs.head??owner.codec.head).done;doc.forEach((n,p)=>{if(n.type.name==='divider'){done=!!n.attrs.done;if(owner.selectedEvents.has(n.attrs.id))ds.push(Decoration.node(p,p+n.nodeSize,{class:'selected-event'}));else if(!selection.empty&&selection.from<=p&&selection.to>=p+n.nodeSize)ds.push(Decoration.node(p,p+n.nodeSize,{class:'text-selected-divider'}));}else if(done)ds.push(Decoration.node(p,p+n.nodeSize,{class:'done-content'}));});for(const r of owner.selectedRanges){if(r.from===r.to&&!r.row&&r.from<=doc.content.size)ds.push(Decoration.widget(r.from,()=>{const caret=document.createElement('span');caret.className='column-caret';caret.setAttribute('aria-hidden','true');return caret;},{side:1,key:'column-'+r.from}));if(r.from<r.to&&r.to<=doc.content.size)ds.push(Decoration.inline(r.from,r.to,{class:r.row?'row-selection':'column-selection'}));}if(owner.matcher)doc.descendants((n,p)=>{if(!n.isText)return;for(const [from,to] of searchMatches(n.text!,owner.matcher!))ds.push(Decoration.inline(p+from,p+to,{class:'search-match'}));});
      if(owner.matcher&&owner.searchWhole){let group:[number,PMNode][]=[],hit=false;const flush=()=>{if(hit)for(const [p,n] of group)ds.push(Decoration.node(p,p+n.nodeSize,{class:'search-event'}));group=[];hit=false;};doc.forEach((n,p)=>{if(n.type.name==='divider'){flush();hit=searchTest(String(n.attrs.deadline_raw??''),owner.matcher!);}else if(searchTest(n.textContent,owner.matcher!))hit=true;group.push([p,n]);});flush();}
      return DecorationSet.create(doc,ds);};
    return new Plugin({key:selectionKey,state:{init:(_,state)=>decorate(state.doc,state.selection),apply(tr,value){if(!tr.docChanged&&!tr.selectionSet&&!tr.getMeta(selectionKey))return value.map(tr.mapping,tr.doc);if(tr.docChanged&&owner.rowAnchor!==null)owner.rowAnchor=tr.mapping.map(owner.rowAnchor);if(tr.getMeta('rangeCarets'))owner.selectedRanges=tr.getMeta('rangeCarets');else if(tr.docChanged&&owner.selectedRanges.length&&tr.getMeta('composition')!==undefined)owner.selectedRanges=[];else if(tr.docChanged)owner.selectedRanges=owner.selectedRanges.map(r=>({...r,from:tr.mapping.map(r.from),to:tr.mapping.map(r.to)}));return decorate(tr.doc,tr.selection);}},props:{decorations(state){return selectionKey.getState(state);}}});
  }
  private replaceRanges(text:string,direction?:-1|1){
    const original=[...new Map(this.selectedRanges.map(r=>[`${r.from}:${r.to}:${!!r.row}`,r])).values()],tr=closeHistory(this.editor.state.tr),columns=original.every(r=>!r.row);
    const ranges=original.map(r=>direction?columnDeleteRange(tr.doc,r,direction):r).sort((a,b)=>b.from-a.from),lines=text.split(/\r?\n/);
    for(const [i,r]of ranges.entries()){
      const content=lines.length===ranges.length?lines[lines.length-i-1]:text;
      if(r.row&&!content&&!text){const pos=tr.doc.resolve(r.from);tr.delete(pos.before(),pos.after());}
      else if(content||r.from!==r.to)tr.insertText(content,r.from,r.to);
    }
    const next=columns?[...new Set(original.map(r=>tr.mapping.map(r.to,1)))].map(from=>({from,to:from})):[];
    if(original.length)tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.map(original[0].to,1)),-1));
    this.editor.view.dispatch(tr.setMeta('rangeEditSource',original).setMeta('rangeCarets',next).setMeta(selectionKey,true).scrollIntoView());
  }
  private listAt($pos:ResolvedPos){
    for(let depth=$pos.depth;depth>0;depth--){const node=$pos.node(depth);if(node.type.name==='orderedList'||node.type.name==='bulletList')return {node,pos:$pos.before(depth),depth};}
    return null;
  }
  /** The marker of the innermost list at the caret, or null outside lists. */
  listStyle():ListStyle|null{const list=this.listAt(this.editor.state.selection.$from);return list?effectiveStyle(list.node.type.name as 'orderedList'|'bulletList',list.node.attrs.listStyle):null;}
  /** The level a list shows: one per enclosing list plus any levels each was indented on its own. */
  private listLevelAt(doc:PMNode,listPos:number){
    const $pos=doc.resolve(listPos),list=doc.nodeAt(listPos)!;let level=1+(Number(list.attrs.listIndent)||0);
    for(let depth=1;depth<=$pos.depth;depth++){const node=$pos.node(depth);if(node.type.name==='orderedList'||node.type.name==='bulletList')level+=1+(Number(node.attrs.listIndent)||0);}
    return level;
  }
  /** Tab at the start of a list item, or with several items selected, nests them one level
   *  deeper (five at most) and opens that level with its own marker; Shift+Tab lifts them out. */
  indentListItem(direction:1|-1){
    const {state}=this.editor,{selection}=state,{$from,$to}=selection;
    if(!this.editor.isEditable)return false;
    const itemDepth=($pos:ResolvedPos)=>{for(let depth=$pos.depth;depth>1;depth--)if($pos.node(depth).type.name==='listItem')return depth;return -1;};
    const fromItem=itemDepth($from);
    if(fromItem<0||itemDepth($to)<0)return false;
    if(selection.empty&&($from.parentOffset!==0||$from.depth-1!==fromItem||$from.index(fromItem)!==0))return false;
    // Text selected within one line keeps Tab's ordinary meaning.
    if(!selection.empty&&$from.sameParent($to))return false;
    const itemType=state.schema.nodes.listItem;
    const range=$from.blockRange($to,node=>node.childCount>0&&node.firstChild!.type===itemType);
    if(!range)return false;
    // range.start is before the first selected item, which is the list's start only for the first item.
    const list=range.parent,listPos=range.$from.before(range.depth),level=this.listLevelAt(state.doc,listPos);
    // Levels follow the family of the outermost list: 1. (1) ① ■ ● or ● ○ ■.
    let family='orderedList';for(let depth=1;depth<=range.depth;depth++){const name=$from.node(depth).type.name;if(name==='orderedList'||name==='bulletList'){family=name;break;}}
    const styleAt=(at:number)=>family==='bulletList'?bulletLevelStyle(at):levelStyle(at);
    if(direction<0){
      if(Number(list.attrs.listIndent)>0){const tr=state.tr;this.relevelItems(tr,listPos,range.startIndex,range.endIndex-1,-1,styleAt(level-1));this.dispatchStructure(tr.scrollIntoView());return true;}
      liftListItem(itemType)(state,tr=>this.dispatchStructure(tr.scrollIntoView()));return true;
    }
    if(level>=MAX_LIST_DEPTH)return true;
    // With no item above to nest under, the items move one level deeper on their own and the
    // items below them restart the list's numbering.
    if(range.startIndex===0){const tr=state.tr;this.relevelItems(tr,listPos,0,range.endIndex-1,1,styleAt(level+1));this.dispatchStructure(tr.scrollIntoView());return true;}
    const sunk:{tr?:Transaction}={};sinkListItem(itemType)(state,tr=>{sunk.tr=tr;});
    const tr=sunk.tr;if(!tr)return true;
    // The items now sit in a list two levels below their old one, inside the previous item.
    const listDepth=range.depth+2,$first=tr.doc.resolve(tr.mapping.map(range.start+1));
    if($first.depth>listDepth&&$first.index(listDepth)===0){
      const innerPos=$first.before(listDepth),inner=$first.node(listDepth),before=tr.doc.resolve(innerPos).nodeBefore;
      // Only a list this Tab just opened takes the level's marker. ProseMirror joins an open
      // sub-list only of the same kind, so one of another kind is joined here instead.
      if(before&&(before.type.name==='orderedList'||before.type.name==='bulletList')){tr.setNodeMarkup(innerPos,before.type,before.attrs);tr.join(innerPos);}
      else{
        const style=styleAt(level+1),kind=isBulletStyle(style)?'bulletList':'orderedList';
        tr.setNodeMarkup(innerPos,state.schema.nodes[kind],{...(kind==='orderedList'?{start:1}:{}),format:inner.attrs.format??null,listStyle:storedStyle(kind,style),numberPrefix:null,numberSuffix:null});
      }
    }
    this.dispatchStructure(tr.scrollIntoView());return true;
  }
  /** Moves items [first..last] of a list one level deeper or shallower without an item to nest
   *  under: they get a list of their own with the level's marker. Deeper items join a list
   *  directly above on that level; shallower ones merge back into neighbouring lists showing the
   *  same marker, so the numbering runs on as one list again. */
  private relevelItems(tr:Transaction,listPos:number,first:number,last:number,delta:1|-1,style:ListStyle){
    const list=tr.doc.nodeAt(listPos)!,ordered=list.type.name==='orderedList',origin=Number(list.attrs.start??1),mark=tr.steps.length;
    let offset=listPos+1,firstPos=-1,afterPos=-1;
    list.forEach((item,_offset,index)=>{if(index===first)firstPos=offset;if(index===last+1)afterPos=offset;offset+=item.nodeSize;});
    if(afterPos>=0)tr.split(afterPos);
    if(first>0)tr.split(firstPos);
    const listOf=(pos:number)=>tr.doc.resolve(tr.mapping.slice(mark).map(pos,1)).start()-1;
    // Items left behind at the old level keep numbering from where they were.
    if(afterPos>=0&&ordered&&delta<0){const at=listOf(afterPos);tr.setNodeMarkup(at,undefined,{...tr.doc.nodeAt(at)!.attrs,start:origin+last+1});}
    const middlePos=listOf(firstPos),middle=tr.doc.nodeAt(middlePos)!,kind=isBulletStyle(style)?'bulletList':'orderedList';
    const indent=Math.max(0,(Number(middle.attrs.listIndent)||0)+delta);
    const attrs:Record<string,unknown>={...(kind==='orderedList'?{start:1}:{}),format:middle.attrs.format??null,listStyle:storedStyle(kind,style),numberPrefix:null,numberSuffix:null,listIndent:indent||null};
    const before=tr.doc.resolve(middlePos).nodeBefore,shaped=tr.doc.type.schema.nodes[kind].create(attrs);
    if(delta>0&&kind==='orderedList'&&sameMarker(before,shaped))attrs.start=Number(before!.attrs.start??1)+before!.childCount;
    tr.setNodeMarkup(middlePos,tr.doc.type.schema.nodes[kind],attrs);
    const end=middlePos+tr.doc.nodeAt(middlePos)!.nodeSize;
    for(const boundary of [end,middlePos]){
      const $boundary=tr.doc.resolve(boundary),a=$boundary.nodeBefore,b=$boundary.nodeAfter;
      if((delta<0?sameMarker(a,b):sameList(a,b))&&canJoin(tr.doc,boundary))tr.join(boundary);
    }
  }
  /** The ordered list closest above the one at `listPos` on the same level, within the same event. */
  private previousLevelList(listPos:number){
    const {doc}=this.editor.state,level=this.listLevelAt(doc,listPos);let eventStart=0,found:PMNode|null=null;
    doc.forEach((node,pos)=>{if(node.type.name==='divider'&&pos<listPos)eventStart=pos+node.nodeSize;});
    doc.nodesBetween(eventStart,listPos,(node,pos)=>{
      if(node.type.name==='orderedList'&&pos+node.nodeSize<=listPos&&this.listLevelAt(doc,pos)===level)found=node;
      return true;
    });
    return found as PMNode|null;
  }
  /** Whether the ordered list at the caret has an earlier list on its level to continue. */
  canContinueNumbering(){const list=this.listAt(this.editor.state.selection.$from);return !!list&&list.node.type.name==='orderedList'&&!!this.previousLevelList(list.pos);}
  /** Restart at the current item, retaining preceding items and nested lists. */
  restartNumbering(){
    if(!this.editor.isEditable)return false;
    const {state,view}=this.editor,list=this.listAt(state.selection.$from);
    if(!list||list.node.type.name!=='orderedList')return false;
    const tr=state.tr,index=state.selection.$from.index(list.depth);let pos=list.pos;
    if(index>0){const item=state.selection.$from.before(list.depth+1);tr.split(item);pos=tr.mapping.map(item,1)-1;}
    tr.setNodeMarkup(pos,undefined,{...tr.doc.nodeAt(pos)!.attrs,start:1}).setMeta('restartNumbering',true);
    this.dispatchStructure(tr.scrollIntoView());view.focus();return true;
  }
  /** 继续编号: the ordered list at the caret picks up numbering after the previous list on its level. */
  continueNumbering(){
    if(!this.editor.isEditable)return false;
    const {state,view}=this.editor,list=this.listAt(state.selection.$from);
    if(!list||list.node.type.name!=='orderedList')return false;
    const previous=this.previousLevelList(list.pos);if(!previous)return false;
    view.dispatch(state.tr.setNodeMarkup(list.pos,undefined,{...list.node.attrs,start:Number(previous.attrs.start??1)+previous.childCount}).scrollIntoView());
    view.focus();return true;
  }
  /** Empty list lines lose their marker first, retaining the visual indentation as a
   *  normal paragraph. Further Backspaces remove one indentation unit at a time. */
  backspaceEmptyListLine(){
    const {state}=this.editor,{selection}=state,$from=selection.$from;
    if(!this.editor.isEditable||!selection.empty||$from.parent.type.name!=='paragraph'||$from.parent.content.size)return false;
    const list=this.listAt($from);
    if(list){
      let inset=0;
      for(let depth=1;depth<$from.depth;depth++){
        const node=$from.node(depth);
        if(node.type.name==='orderedList'||node.type.name==='bulletList')inset+=27+30*(Number(node.attrs.listIndent)||0);
      }
      const tr=state.tr;
      // A continuation paragraph must be separated before lifting, so the previous
      // item's text and marker are untouched.
      if($from.node($from.depth-1).type.name==='listItem'&&$from.index($from.depth-1)>0)tr.split($from.before($from.depth));
      while(this.listAt(tr.selection.$from)){
        const current=this.listAt(tr.selection.$from)!,index=tr.selection.$from.index(current.depth);
        // Each lift needs maps relative to its own document, especially after splitting
        // a continuation paragraph or lifting through several nested lists.
        const working=EditorState.create({schema:state.schema,doc:tr.doc,selection:tr.selection});
        const lifted=liftListItem(state.schema.nodes.listItem)(working,next=>{
          for(const step of next.steps)tr.step(step);
          tr.setSelection(Selection.fromJSON(tr.doc,next.selection.toJSON()));
        });
        if(!lifted)return false;
        const after=tr.selection.$from.after(),right=tr.doc.nodeAt(after);
        if(current.node.type.name==='orderedList'&&right?.type===current.node.type)tr.setNodeMarkup(after,undefined,{...right.attrs,start:Number(current.node.attrs.start??1)+index});
      }
      const $caret=tr.selection.$from,format=normalizeFormat($caret.parent.attrs.format);
      format.marginLeft=`${inset+(format.marginLeft===undefined?0:Math.max(0,cssPixels(format.marginLeft,15)))}px`;
      tr.setNodeMarkup($caret.before(),undefined,{...$caret.parent.attrs,format});
      this.dispatchStructure(tr.scrollIntoView());return true;
    }
    const format=normalizeFormat($from.parent.attrs.format);
    const left=format.marginLeft===undefined?0:cssPixels(format.marginLeft,15);
    const first=format.textIndent===undefined?0:cssPixels(format.textIndent,15);
    if(left>0){const next=Math.max(0,left-30);if(next)format.marginLeft=`${next}px`;else delete format.marginLeft;}
    else if(Number(format.qtIndent)>0){if(Number(format.qtIndent)>1)format.qtIndent=Number(format.qtIndent)-1;else delete format.qtIndent;}
    else if(first>0){const next=Math.max(0,first-30);if(next)format.textIndent=`${next}px`;else delete format.textIndent;}
    else return false;
    this.dispatchStructure(state.tr.setNodeMarkup($from.before(),undefined,{...$from.parent.attrs,format:Object.keys(format).length?format:null}).scrollIntoView());return true;
  }
  /** Backspace at the start of a list item other than the first folds it into the item above as
   *  an unnumbered line, the way word processors do: the list stays whole and the numbers below
   *  close up. A second Backspace then merges that line into the text above as usual. */
  joinListItemBackward(){
    const {state}=this.editor,{selection}=state,$from=selection.$from;
    if(!this.editor.isEditable||!selection.empty||$from.parentOffset!==0||$from.depth<3)return false;
    const itemDepth=$from.depth-1;
    if($from.node(itemDepth).type.name!=='listItem'||$from.index(itemDepth)!==0||$from.index(itemDepth-1)===0)return false;
    const boundary=$from.before(itemDepth);
    if(!canJoin(state.doc,boundary))return false;
    this.editor.view.dispatch(state.tr.join(boundary).scrollIntoView());return true;
  }
  /** The lines a selection touches: whole textblocks, and each line inside a code block. */
  private selectedLines(){
    const {doc,selection:{from,to,empty}}=this.editor.state,lines:{start:number;end:number}[]=[];
    doc.nodesBetween(from,to,(node,pos)=>{
      if(!node.isTextblock)return true;
      const start=pos+1,push=(head:number,tail:number)=>{if(start+tail>=from&&start+head<=to)lines.push({start:start+head,end:start+tail});};
      if(!node.type.spec.code)push(0,node.content.size);
      else{const text=node.textContent;let head=0;for(let i=0;i<=text.length;i++)if(i===text.length||text[i]==='\n'){push(head,i);head=i+1;}}
      return false;
    });
    // A selection that ends at the very start of a line does not take that line along.
    if(!empty&&lines.length>1&&lines.at(-1)!.start===to)lines.pop();
    return lines;
  }
  /** Tab with several lines selected indents each of them by one unit instead of replacing the
   *  selection; Shift+Tab takes one unit (a tab, or up to four spaces) off every touched line. */
  indentLines(direction:1|-1){
    const {state}=this.editor,{selection}=state;
    if(!this.editor.isEditable||selection instanceof CellSelection||selection instanceof TableRowSelection)return false;
    const lines=this.selectedLines();
    if(!lines.length||(direction>0&&lines.length<2))return false;
    const tr=state.tr;
    // From the last line up, so the positions of the earlier lines stay valid.
    for(const line of [...lines].reverse()){
      if(direction>0){tr.insertText('    ',line.start);continue;}
      const head=tr.doc.textBetween(line.start,Math.min(line.end,line.start+4),'','');
      const unit=head.startsWith('\t')?1:(/^ {1,4}/.exec(head)?.[0].length??0);
      if(unit)tr.delete(line.start,line.start+unit);
    }
    if(tr.docChanged)this.editor.view.dispatch(tr.scrollIntoView());
    return true;
  }
  /** Turns the selected lines into a list of `kind`. Each line's leading indentation (a tab or four
   *  spaces per level, counted from the least indented line) sets its level, and each level gets
   *  its marker; lines without indentation are level one. Lines that are already lists keep the
   *  old toggle, which switches their kind or unwraps them. */
  toggleListLines(kind:'orderedList'|'bulletList'){
    if(!this.editor.isEditable)return false;
    const {state}=this.editor,{from,to,empty}=state.selection;
    type Run={from:number;to:number;lines:PMNode[]};
    const runs:Run[]=[];let run:Run|null=null;
    state.doc.forEach((node,pos)=>{
      const end=pos+node.nodeSize;
      const touched=empty?pos<from&&from<end:pos<to&&from<end&&!(pos+1===to&&from<pos);
      if(!touched||node.type.name!=='paragraph'){run=null;return;}
      if(!run){run={from:pos,to:end,lines:[]};runs.push(run);}
      run.lines.push(node);run.to=end;
    });
    if(!runs.length){const done=kind==='orderedList'?this.editor.commands.toggleOrderedList():this.editor.commands.toggleBulletList();this.editor.view.focus();return done;}
    const {schema}=state,tr=state.tr;
    const built=runs.map(({lines})=>{
      const parsed=lines.map(node=>{
        const indent=/^[ \t]*/.exec(node.textContent)![0];let units=0,spaces=0;
        for(const char of indent){if(char==='\t'){units++;spaces=0;}else if(++spaces===4){units++;spaces=0;}}
        return {node,units,cut:indent.length};
      });
      // Outline by indentation: a deeper line opens the next level, an equally indented one stays
      // on its level, and a shallower one returns to the level that indentation opened (else one).
      const stack:{units:number;level:number}[]=[];
      const leveled=parsed.map(line=>{
        while(stack.length&&stack[stack.length-1].units>line.units)stack.pop();
        const top=stack[stack.length-1];
        const level=!top?1:top.units===line.units?top.level:Math.min(MAX_LIST_DEPTH,top.level+1);
        if(!top||top.units!==line.units)stack.push({units:line.units,level});
        return {...line,level};
      });
      const build=(index:number,level:number):{node:PMNode;next:number}=>{
        const style=kind==='bulletList'?bulletLevelStyle(level):levelStyle(level),listKind=isBulletStyle(style)?'bulletList':'orderedList',items:PMNode[]=[];
        let i=index;
        while(i<leveled.length&&leveled[i].level>=level){
          if(leveled[i].level>level){const nested=build(i,level+1),last=items.pop()!;items.push(last.copy(last.content.addToEnd(nested.node)));i=nested.next;continue;}
          const {node,cut}=leveled[i];
          items.push(schema.nodes.listItem.create(null,schema.nodes.paragraph.create(node.attrs,node.content.cut(cut),node.marks)));i++;
        }
        return {node:schema.nodes[listKind].create({...(listKind==='orderedList'?{start:1}:{}),listStyle:storedStyle(listKind,style)},items),next:i};
      };
      return {list:build(0,1).node,leveled};
    });
    for(let r=runs.length-1;r>=0;r--)tr.replaceWith(runs[r].from,runs[r].to,built[r].list);
    // Keep the caret or selection on the same text, now inside the list items.
    const place=(pos:number)=>{
      for(let r=0;r<runs.length;r++){
        let at=runs[r].from;
        for(let l=0;l<runs[r].lines.length;l++){
          const line=runs[r].lines[l];
          if(pos>at&&pos<at+line.nodeSize){
            const listPos=tr.mapping.map(runs[r].from,-1),starts:number[]=[];
            tr.doc.nodeAt(listPos)!.descendants((node,p)=>{if(node.type.name!=='paragraph')return true;starts.push(listPos+2+p);return false;});
            const {cut}=built[r].leveled[l];
            return starts[l]+Math.max(0,Math.min(line.content.size-cut,pos-at-1-cut));
          }
          at+=line.nodeSize;
        }
      }
      return tr.mapping.map(pos);
    };
    tr.setSelection(TextSelection.between(tr.doc.resolve(place(from)),tr.doc.resolve(place(to))));
    this.dispatchStructure(tr.scrollIntoView());this.editor.view.focus();return true;
  }
  /** Gives a marker to the list items on the caret's line or under the selection, turning
   *  plain lines into a list first. The list is split around those items so the others keep
   *  their marker and numbering; a piece that ends up matching its neighbour is joined back. */
  setListStyle(style:ListStyle){
    if(!this.editor.isEditable)return false;
    const kind=isBulletStyle(style)?'bulletList':'orderedList';
    if(!this.listAt(this.editor.state.selection.$from)&&!(kind==='bulletList'?this.editor.commands.toggleBulletList():this.editor.commands.toggleOrderedList()))return false;
    const {state,view}=this.editor,{selection}=state,ranges=new Map<number,{first:number;last:number}>();
    // Each line belongs to its innermost item; collect the item range per list.
    const note=($pos:ResolvedPos)=>{
      for(let depth=$pos.depth;depth>1;depth--){
        if($pos.node(depth).type.name!=='listItem')continue;
        const pos=$pos.before(depth-1),index=$pos.index(depth-1),range=ranges.get(pos);
        ranges.set(pos,range?{first:Math.min(range.first,index),last:Math.max(range.last,index)}:{first:index,last:index});return;
      }
    };
    note(selection.$from);
    if(!selection.empty)state.doc.nodesBetween(selection.from,selection.to,(node,pos)=>{if(!node.isTextblock)return true;note(state.doc.resolve(pos+1));return false;});
    if(!ranges.size)return false;
    const tr=state.tr;
    // Deepest and latest lists first, so the positions of the remaining ones stay valid.
    for(const [pos,{first,last}] of [...ranges].sort((a,b)=>b[0]-a[0]))this.styleListItems(tr,tr.mapping.map(pos),first,last,kind,style);
    view.dispatch(tr.scrollIntoView());view.focus();return true;
  }
  private styleListItems(tr:Transaction,listPos:number,first:number,last:number,kind:'orderedList'|'bulletList',style:ListStyle){
    const list=tr.doc.nodeAt(listPos);if(!list||(list.type.name!=='orderedList'&&list.type.name!=='bulletList'))return;
    const origin=Number(list.attrs.start??1),ordered=list.type.name==='orderedList',mark=tr.steps.length;
    let offset=listPos+1,firstPos=-1,afterPos=-1;
    list.forEach((item,_offset,index)=>{if(index===first)firstPos=offset;if(index===last+1)afterPos=offset;offset+=item.nodeSize;});
    if(afterPos>=0)tr.split(afterPos);
    if(first>0)tr.split(firstPos);
    const listOf=(pos:number)=>tr.doc.resolve(tr.mapping.slice(mark).map(pos,1)).start()-1;
    const middlePos=listOf(firstPos),middle=tr.doc.nodeAt(middlePos)!;
    tr.setNodeMarkup(middlePos,tr.doc.type.schema.nodes[kind],{...(kind==='orderedList'?{start:ordered?origin+first:1}:{}),format:middle.attrs.format??null,listStyle:storedStyle(kind,style),numberPrefix:null,numberSuffix:null,listIndent:middle.attrs.listIndent??null});
    if(afterPos>=0&&ordered){const at=listOf(afterPos);tr.setNodeMarkup(at,undefined,{...tr.doc.nodeAt(at)!.attrs,start:origin+last+1});}
    const end=middlePos+tr.doc.nodeAt(middlePos)!.nodeSize;
    for(const boundary of [end,middlePos]){const $boundary=tr.doc.resolve(boundary);if(sameList($boundary.nodeBefore,$boundary.nodeAfter)&&canJoin(tr.doc,boundary))tr.join(boundary);}
  }
  split() {
    const {state,view}=this.editor; if(this.composition||!this.editor.isEditable)return false;
    const s=state.selection;if(!s.$from.parent.isTextblock)return false;
    const tr=closeHistory(state.tr).deleteSelection();let pos:number;
    if(isFirstBodyPrefix(tr.selection.$from)){
      const start=tr.selection.$from.start();tr.delete(start,tr.selection.from);
      const existing=tr.doc.firstChild?.type.name==='divider';
      const meta={...(existing?tr.doc.firstChild!.attrs:tr.doc.attrs.head),created_at:Math.floor(Date.now()/1000)};
      if(existing)tr.setNodeMarkup(0,undefined,meta);else tr.insert(0,state.schema.nodes.divider.create(meta));pos=0;
    }else{
      const at=tr.selection.$from,part=partitionBlock(at),nodes:PMNode[]=[];
      // An empty line turns into the divider where it already sits, unless that
      // would leave the event after it without a body line of its own.
      const following=at.node(0).maybeChild(at.index(0)+1);
      const inPlace=at.depth===1&&!part.left&&!at.parent.content.size&&!!following&&following.type.name!=='divider';
      if(part.left)nodes.push(part.left);
      pos=at.before(1)+(part.left?.nodeSize??0);nodes.push(state.schema.nodes.divider.create(eventMeta(newEvent())));
      if(!inPlace)nodes.push(part.right??state.schema.nodes.paragraph.create());
      tr.replaceWith(at.before(1),at.after(1),Fragment.fromArray(nodes));
    }
    this.dispatchStructure(tr.setSelection(Selection.near(tr.doc.resolve(Math.min(pos+1,tr.doc.content.size)),1)).scrollIntoView());view.focus();return true;
  }
  private dispatchStructure(tr:Transaction){
    this.editor.view.dispatch(closeHistory(tr));
    // A structural operation must remain separate from both preceding and
    // immediately following typing, even inside history's grouping interval.
    this.editor.view.dispatch(closeHistory(this.editor.state.tr));
  }
  tableAction(action:'insert'|'rowBefore'|'rowAfter'|'columnBefore'|'columnAfter'|'deleteRow'|'deleteColumn'|'deleteTable'|'merge'|'split'|'header'){
    if(!this.editor.isEditable)return false;
    const rows=this.editor.state.selection;
    if(rows instanceof TableRowSelection){
      if(action==='deleteRow'){this.dispatchStructure(rows.deleteRows(this.editor.state.tr));this.editor.view.focus();return true;}
      if(!rows.contiguous){this.bridge.error('此操作需要连续的单元格选区，请先重新选择。');return false;}
      this.editor.view.dispatch(this.editor.state.tr.setSelection(rows.asCellSelection()));
    }
    if(action==='insert'){const cell=()=>({type:'table_cell',content:[{type:'paragraph'}]});const table={type:'table',attrs:{layout:{attributes:{border:'1',cellpadding:'6',cellspacing:'0',width:'100%'},style:{'border-style':'solid'}}},content:Array.from({length:3},()=>({type:'table_row',content:Array.from({length:3},cell)}))};const result=this.editor.chain().command(({tr})=>{closeHistory(tr);return true;}).insertContent(table).run();this.editor.view.dispatch(closeHistory(this.editor.state.tr));this.editor.view.focus();return result;}
    const command={rowBefore:addRowBefore,rowAfter:addRowAfter,columnBefore:addColumnBefore,columnAfter:addColumnAfter,deleteRow,deleteColumn,deleteTable,merge:mergeCells,split:splitCell,header:toggleHeaderRow}[action];
    const result=command(this.editor.state,tr=>this.dispatchStructure(tr));this.editor.view.focus();return result;
  }
  records(){return this.codec.records(this.editor.state.doc);}
  remap(ids:Record<string,number>) {
    this.codec.remap(ids);
  }
  focusEvent(id:number,focus=true){
    const g=groups(this.editor.state.doc,this.codec.head).find(g=>this.codec.resolveId(g.meta.id)===id);if(!g)return;
    this.editor.view.dispatch(this.editor.state.tr.setSelection(boundarySelection(this.editor.state.doc,g.start+(g.dividerPos>=0?1:0))));
    if(focus)this.editor.view.focus();
    this.revealTop(g.start);
  }
  /** Locating an event parks it at the top of the canvas, not at whichever edge it entered from. */
  private revealTop(pos:number){
    const view=this.editor.view,scroller=view.dom.closest<HTMLElement>('.document-scroller');if(!scroller)return;
    const node=view.nodeDOM(pos),top=node instanceof HTMLElement?node.getBoundingClientRect().top:view.coordsAtPos(pos).top;
    scroller.scrollTop+=top-scroller.getBoundingClientRect().top-10;
  }
  selectEvent(id:number,toggle=false){const raw=groups(this.editor.state.doc,this.codec.head).find(g=>this.codec.resolveId(g.meta.id)===id)?.meta.id??id;if(!toggle)this.selectedEvents.clear();this.selectedEvents.has(raw)?this.selectedEvents.delete(raw):this.selectedEvents.add(raw);this.editor.view.dispatch(this.editor.state.tr.setMeta(selectionKey,true));this.bridge.selection();}
  selectEvents(ids:readonly number[]){
    const wanted=new Set(ids);
    this.selectedRanges=[];
    this.selectedEvents=new Set(groups(this.editor.state.doc,this.codec.head).filter(g=>wanted.has(this.codec.resolveId(g.meta.id))).map(g=>g.meta.id));
    this.editor.view.dispatch(this.editor.state.tr.setMeta(selectionKey,true));this.bridge.selection();
  }
  setEventDone(id:number,done:boolean){
    if(!this.editor.isEditable)return;
    const {state,view}=this.editor;
    const g=groups(state.doc,this.codec.head).find(g=>this.codec.resolveId(g.meta.id)===id);
    if(!g||Boolean(g.meta.done)===done)return;
    const tr=g.dividerPos>=0?state.tr.setNodeMarkup(g.dividerPos,undefined,{...g.meta,done:done?1:0}):state.tr.setDocAttribute('head',{...state.doc.attrs.head,done:done?1:0});
    view.dispatch(tr);
  }
  setEventDeadline(id:number,raw:string,ts:number|null){
    if(!this.editor.isEditable)return false;
    const {state}=this.editor,g=groups(state.doc,this.codec.head).find(g=>this.codec.resolveId(g.meta.id)===id);
    if(!g)return false;
    const attrs={...g.meta,deadline_raw:raw,deadline_ts:ts};
    const tr=g.dividerPos>=0?state.tr.setNodeMarkup(g.dividerPos,undefined,attrs):state.tr.setDocAttribute('head',{...state.doc.attrs.head,...attrs});
    this.dispatchStructure(tr);return true;
  }
  private rowSelected(row:GutterRow){
    if(row.kind==='divider')return this.selectedEvents.has(row.id);
    const selection=this.editor.state.selection;
    if(selection instanceof TableRowSelection){if(row.kind!=='table')return false;const pos=this.editor.state.doc.resolve(row.pos);return pos.parent===selection.table&&selection.rows.includes(pos.index());}
    if(row.kind==='table'&&selection instanceof CellSelection){const rect=selectedRect(this.editor.state),pos=this.editor.state.doc.resolve(row.pos);return pos.parent===rect.table&&pos.index()>=rect.top&&pos.index()<rect.bottom;}
    return this.selectedRanges.some(r=>r.row&&r.from===row.from)||(!selection.empty&&selection.from<row.to&&selection.to>row.from);
  }
  private chooseRow(row:GutterRow,mode:RowAction){
    const {state,view}=this.editor;
    if(row.kind==='divider'){this.selectedRanges=[];this.selectEvent(row.id,mode==='toggle');view.focus();return;}
    if(row.kind==='table'){
      const pos=state.doc.resolve(row.pos),table=pos.parent,map=TableMap.get(table),index=pos.index(),start=pos.start();
      const selection=state.selection,previous=selection instanceof TableRowSelection&&selection.table===table?selection:selection instanceof CellSelection&&selection.$anchorCell.node(-1)===table?new TableRowSelection(state.doc,start-1,Array.from({length:selectedRect(state).bottom-selectedRect(state).top},(_,i)=>selectedRect(state).top+i)):undefined;
      const anchor=mode==='extend'&&previous?previous.anchorRow:index,group=connectedRows(table,[index]);let rows=mode==='replace'?group:previous?[...previous.rows]:[];
      if(mode==='extend')rows=Array.from({length:Math.abs(index-anchor)+1},(_,i)=>Math.min(index,anchor)+i);
      else if(mode==='toggle'&&group.every(r=>rows.includes(r)))rows=rows.filter(r=>!group.includes(r));
      else rows=[...rows,...group];
      this.selectedRanges=[];this.selectedEvents.clear();const next=rows.length?new TableRowSelection(state.doc,start-1,rows,mode==='add'&&previous?previous.anchorRow:anchor):Selection.near(state.doc.resolve(start+map.map[index*map.width]+1));view.dispatch(state.tr.setSelection(next).setMeta(selectionKey,true));view.focus();return;
    }
    if(row.kind!=='text')return;
    this.selectedEvents.clear();
    if(mode==='extend'&&this.rowAnchor!==null){
      const start=Math.min(this.rowAnchor,row.from),end=Math.max(this.rowAnchor,row.from);this.selectedRanges=[];
      state.doc.descendants((node,pos)=>{if(node.isTextblock&&pos+1>=start&&pos+1<=end)this.selectedRanges.push({from:pos+1,to:pos+node.nodeSize-1,row:true});});
    }else{
      if(mode==='replace')this.selectedRanges=[];
      const index=this.selectedRanges.findIndex(r=>r.from===row.from);
      if(index>=0&&mode==='toggle')this.selectedRanges.splice(index,1);
      else if(index<0)this.selectedRanges.push({from:row.from,to:row.to,row:true});
      if(mode!=='add')this.rowAnchor=row.from;
    }
    view.dispatch(state.tr.setSelection(TextSelection.create(state.doc,row.from)).setMeta(selectionKey,true));view.focus();this.bridge.selection();
  }
  private paragraphRanges(){const s=this.editor.state.selection;return this.selectedEvents.size?groups(this.editor.state.doc,this.codec.head).filter(g=>this.selectedEvents.has(g.meta.id)).map(g=>({from:g.start,to:g.end})):this.selectedRanges.length?this.selectedRanges:s instanceof TableRowSelection?s.ranges.map(r=>({from:r.$from.pos,to:r.$to.pos})):[s];}
  paragraphAlignment(){
    const alignments=new Set<string>();
    for(const range of this.paragraphRanges())this.editor.state.doc.nodesBetween(range.from,range.to,node=>{if(node.isTextblock){const f=normalizeFormat(node.attrs.format);alignments.add(String(f.textAlign??(f.direction==='rtl'?'right':'left')));}});
    return alignments.size===1?[...alignments][0]:undefined;
  }
  private baseFontSize(){return parseFloat(getComputedStyle(this.editor.view.dom).fontSize)||15;}
  /** True when a text range, column selection or whole event is selected. */
  sizedSelection(){return this.selectedEvents.size>0||this.selectedRanges.some(r=>r.from<r.to)||!this.editor.state.selection.empty;}
  fontSize(){
    const sizes=new Set<number>(),base=this.baseFontSize();let scanned=0;
    for(const range of this.paragraphRanges()){
      if(sizes.size>1||scanned>50000)break;
      this.editor.state.doc.nodesBetween(range.from,range.to,node=>{
        if(sizes.size>1||scanned>50000)return false;
        if(!node.isText)return;
        scanned+=node.nodeSize;sizes.add(Math.round(cssPixels(node.marks.find(m=>m.type.name==='textStyle')?.attrs.fontSize,base)));
      });
    }
    return sizes.size===1?[...sizes][0]:undefined;
  }
  changeFontSize(delta:number|null,scope:'selection'|'document'='selection'){
    if(!this.editor.isEditable)return;
    const {state,view}=this.editor,type=state.schema.marks.textStyle,tr=closeHistory(state.tr),base=this.baseFontSize();
    // Qt applies pt and ignores px, so sizes are stored the way the original app reads them.
    const size=(from:unknown)=>delta===null?null:`${Number((Math.max(8,Math.min(96,Math.round(cssPixels(from,base)+delta)))*0.75).toFixed(2))}pt`;
    const ranges=scope==='document'?[{from:0,to:state.doc.content.size}]:this.paragraphRanges();
    for(const range of ranges)state.doc.nodesBetween(range.from,range.to,(node,pos)=>{
      if(!node.isText)return;
      const from=Math.max(pos,range.from),to=Math.min(pos+node.nodeSize,range.to);if(from>=to)return;
      const mark=node.marks.find(m=>m.type===type),attrs={...mark?.attrs,fontSize:size(mark?.attrs.fontSize)};
      if((mark?.attrs.fontSize??null)===attrs.fontSize)return;
      if(mark)tr.removeMark(from,to,mark);
      if(Object.values(attrs).some(value=>value))tr.addMark(from,to,type.create(attrs));
    });
    if(tr.docChanged){view.dispatch(tr.scrollIntoView());view.focus();return;}
    // An empty caret keeps the choice for whatever is typed next.
    if(scope==='selection'&&state.selection.empty){
      const stored=state.storedMarks??state.selection.$from.marks(),mark=stored.find(m=>m.type===type);
      const attrs={...mark?.attrs,fontSize:size(mark?.attrs.fontSize)};
      const rest=stored.filter(m=>m.type!==type);
      view.dispatch(tr.setStoredMarks(Object.values(attrs).some(value=>value)?type.create(attrs).addToSet(rest):rest));
    }
    view.focus();
  }
  formatParagraphs(change:(format:ParagraphFormat)=>ParagraphFormat){
    if(!this.editor.isEditable)return;
    const {state,view}=this.editor,tr=closeHistory(state.tr),seen=new Set<number>();
    const ranges=this.paragraphRanges();
    for(const range of ranges)state.doc.nodesBetween(range.from,range.to,(node,pos)=>{
      if(!node.isTextblock||seen.has(pos))return;seen.add(pos);
      const format=normalizeFormat(change(normalizeFormat(node.attrs.format)));
      if(JSON.stringify(format)!==JSON.stringify(normalizeFormat(node.attrs.format)))tr.setNodeMarkup(pos,undefined,{...node.attrs,format:Object.keys(format).length?format:null});
    });
    if(tr.docChanged)view.dispatch(tr.scrollIntoView());
    view.focus();
  }
  insertEventBelow(id:number){
    if(!this.editor.isEditable)return;
    const {state,view}=this.editor;
    const g=groups(state.doc,this.codec.head).find(g=>this.codec.resolveId(g.meta.id)===id);
    if(!g)return;
    const tr=state.tr.insert(g.end,[state.schema.nodes.divider.create(eventMeta(newEvent())),state.schema.nodes.paragraph.create()]);
    this.selectedEvents.clear();this.dispatchStructure(tr.setSelection(TextSelection.create(tr.doc,g.end+2)).setMeta(selectionKey,true).scrollIntoView());view.focus();
  }
  eventAt(pos:number){
    const all=groups(this.editor.state.doc,this.codec.head);
    const group=all.find(g=>pos>=g.start&&pos<g.end)??all.at(-1);
    return group?this.codec.resolveId(group.meta.id):null;
  }
  /** Move original nodes as one undo step, preserving IDs, metadata and raw HTML. */
  moveCurrentEventToTop(){
    const id=this.selectedEvents.size===1?[...this.selectedEvents][0]:this.eventAt(this.editor.state.selection.from);
    return id===null?false:this.moveEventToTop(id);
  }
  moveEventToTop(id:number){
    if(!this.editor.isEditable)return false;
    const {state,view}=this.editor,all=groups(state.doc,this.codec.head);
    const index=all.findIndex(g=>this.codec.resolveId(g.meta.id)===id);if(index<=0)return false;
    const group=all[index],first=all[0],content=state.doc.slice(group.start,group.end).content;
    const tr=state.tr.delete(group.start,group.end);
    if(first.dividerPos<0)tr.insert(0,state.schema.nodes.divider.create(eventMeta(first.meta)));
    tr.insert(0,content).setDocAttribute('head',eventMeta(group.meta)).setMeta('structuralHead',true);
    this.selectedEvents.clear();this.selectedRanges=[];
    this.dispatchStructure(tr.setSelection(Selection.near(tr.doc.resolve(1))).setMeta(selectionKey,true).scrollIntoView());
    view.focus();this.focusEvent(id);return true;
  }
  deleteEvents(){const tr=this.editor.state.tr;const selected=groups(tr.doc,this.codec.head).filter(g=>this.selectedEvents.has(g.meta.id));for(const g of selected.reverse())tr.delete(g.start,g.end);this.selectedEvents.clear();this.dispatchStructure(tr.setMeta(selectionKey,true));}
  private eventPasteRange(){
    if(!this.selectedEvents.size)return;
    const all=groups(this.editor.state.doc,this.codec.head),indices=all.flatMap((g,i)=>this.selectedEvents.has(g.meta.id)?[i]:[]);
    if(!indices.length)return;
    const contiguous=indices.every((v,i)=>!i||v===indices[i-1]+1),first=contiguous?all[indices[0]]:all.at(-1)!;
    const empty=!first.blocks.length||first.blocks.length===1&&first.blocks[0].type.name==='paragraph'&&!first.blocks[0].content.size;
    return {from:first.start,to:contiguous?all[indices.at(-1)!].end:empty?first.end:first.start};
  }
  private captureInsertionTarget(){const target=this.captureTarget(),range=this.eventPasteRange();if(range)target.setEventRange(range,range);return target;}
  private validateRowPaste(content:JSONContent[],target:AsyncTarget){if(!target.eventRange&&target.selection instanceof TableRowSelection)tableRowsPaste(target.selection,new Slice(Fragment.fromArray(content.map(n=>this.editor.schema.nodeFromJSON(n))),0,0));}
  private insertAtTarget(content:JSONContent[],target:AsyncTarget){
    this.selectedRanges=[];
    if(target.eventRange){
      const blocks=content.length&&this.editor.schema.nodeFromJSON(content[0]).isInline?[{type:'paragraph',content}]:content;
      this.insertRecords([{...newEvent(),top_divider:1,content_html:serializeQtHtml(blocks),content_text:plainText(blocks)}],target.eventRange);
    }else this.editor.commands.insertContent(content);
  }
  private insertRecords(events:EventRecord[],placement?:{from:number;to:number}){
    const range=placement??this.eventPasteRange();
    const tr=this.eventTransaction(events,range);
    this.validateOpaqueTransaction(tr);
    this.selectedEvents.clear();this.dispatchStructure(tr.setMeta(selectionKey,true).scrollIntoView());
  }
  private validateOpaqueTransaction(tr:Transaction){
    if(!preservesOpaqueBodies(this.editor.state.doc,tr.doc,this.codec.head))throw new Error('该事件包含只读内容，已阻止修改。');
  }
  private eventTransaction(events:EventRecord[],range?:{from:number;to:number},selection=this.editor.state.selection){
    const {state}=this.editor,tr=state.tr.setSelection(selection);
    if(range){
        const {from,to}=range;
        const incoming=events.map((e,i)=>({...e,top_divider:i===0&&from>0?1:e.top_divider}));
        const nodes=recordsToJSON(incoming).content!.map(n=>state.schema.nodeFromJSON(n));
        tr.replaceWith(from,to,Fragment.fromArray(nodes));
        if(from===0)tr.setDocAttribute('head',eventMeta(incoming[0])).setMeta('structuralHead',true);
        return tr.setSelection(Selection.near(tr.doc.resolve(Math.min(from+1,tr.doc.content.size))));
    }
    const tail=groups(state.doc,this.codec.head).find(g=>selection.to>=g.start&&selection.to<=g.end)?.meta??newEvent();
    // Supplying a transaction builds the same command chain without dispatch.
    new CommandManager({editor:this.editor}).createChain(tr).insertContent(recordsToJSON(events).content??[]).command(({tr})=>{
      // Opaque HTML is an entire event, never a block that may absorb the
      // editable prefix/suffix produced by ProseMirror's paste fitting.
      const changes:{pos:number;meta:EventRecord;replace?:boolean}[]=[];
      for(const g of groups(tr.doc,this.codec.head)){
        let pos=g.dividerPos>=0?g.dividerPos+1:g.start;
        g.blocks.forEach((node,i)=>{
          if(node.type.name==='legacy'){
            const meta=events.find(e=>e.id===node.attrs.id)??g.meta;
            if(i>0)changes.push({pos,meta});
            else if(g.meta.id!==meta.id){
              if(g.dividerPos>=0)changes.push({pos:g.dividerPos,meta,replace:true});
              else tr.setDocAttribute('head',eventMeta(meta)).setMeta('structuralHead',true);
            }
            if(i+1<g.blocks.length&&g.blocks[i+1].type.name!=='legacy')changes.push({pos:pos+node.nodeSize,meta:{...tail,id:newEvent().id}});
          }
          pos+=node.nodeSize;
        });
      }
      for(const change of changes.sort((a,b)=>b.pos-a.pos)){
        if(change.replace)tr.setNodeMarkup(change.pos,undefined,eventMeta(change.meta));
        else tr.insert(change.pos,state.schema.nodes.divider.create(eventMeta(change.meta)));
      }
      return true;
    }).run();
    return tr;
  }
  async insertImage(bytes:Uint8Array|Promise<Uint8Array>,display?:{width:number;height:number}){
    return this.insertImages([bytes],display);
  }
  async insertImages(sources:readonly ImageInput[],display?:{width:number;height:number}){
    if(!this.editor.isEditable||!sources.length)return;
    const finish=this.beginOperation(),target=this.captureInsertionTarget(),width=this.editor.view.dom.clientWidth||720;
    // Observe rejected byte promises immediately even while an earlier batch waits.
    // File objects are read lazily, one at a time, to avoid decoding a whole drop at once.
    const inputs=sources.map(source=>Promise.resolve(source).then(value=>({value}),error=>({error})));
    this.imageCount+=inputs.length;this.bridge.selection();
    await this.orderedEdit(async()=>{
      try{
        if(this.editor.isDestroyed)return;
        const prepared:Awaited<ReturnType<TodoEditor['decodeImage']>>[]=[];let total=0;
        for(const promise of inputs){
          const input=await promise;if('error'in input)throw input.error;
          const source=input.value;
          try{const data=source instanceof Uint8Array?source:new Uint8Array(await source.arrayBuffer());if(!data.length)throw new Error('图片文件为空。');if(data.length>100*1024*1024||(total+=data.length)>512*1024*1024)throw new Error('图片批次过大，请分批导入');prepared.push(await this.decodeImage(data,display,width));}
          catch(error){throw new Error(`${source instanceof Uint8Array?'图片':source.name}：${String(error)}`);}
        }
        if(!target.valid)throw new Error('等待期间目标内容已被修改，未覆盖新内容。请重新选择后重试。');
        const assets=prepared.map(p=>p.asset),ids=this.bridge.assets?await this.bridge.assets(assets):await Promise.all(assets.map(a=>this.bridge.asset(a.data,a.w,a.h)));
        const images=prepared.map((p,i)=>({type:'image',attrs:{assetId:ids[i],width:p.width,height:p.height}}));
        await this.commitTarget(target,()=>this.insertAtTarget(images,target));
      }catch(error){this.bridge.error(String(error));}
      finally{this.imageCount-=inputs.length;this.asyncTargets.delete(target);finish();this.bridge.selection();}
    });
  }
  private async prepareImage(bytes:Uint8Array,display?:{width:number;height:number},availableWidth=this.editor.view.dom.clientWidth||720):Promise<JSONContent>{
    const prepared=await this.decodeImage(bytes,display,availableWidth),asset=prepared.asset,id=await this.bridge.asset(asset.data,asset.w,asset.h);
    return {type:'image',attrs:{assetId:id,width:prepared.width,height:prepared.height}};
  }
  private async decodeImage(bytes:Uint8Array,display:undefined|{width:number;height:number},availableWidth:number){
    const bitmap=this.bridge.imageInfo?await this.bridge.imageInfo(bytes):await createImageBitmap(new Blob([bytes as BlobPart]));
    try{const scale=Math.min(1,(availableWidth*.72)/bitmap.width,520/bitmap.height);
      return {asset:{data:bytes,w:bitmap.width,h:bitmap.height},width:display?.width??Math.max(1,Math.round(bitmap.width*scale)),height:display?.height??Math.max(1,Math.round(bitmap.height*scale))};
    }finally{if('close' in bitmap)bitmap.close();}
  }
  private cutContent(target:AsyncTarget){
    const doc=this.editor.state.doc;
    // Row/event/cell deletion may cover more than its highlighted text. Compare
    // the entire deletion footprint before cutting, including images at its edges.
    if(target.events.size)return JSON.stringify(groups(doc,this.codec.head).filter(g=>target.events.has(g.meta.id)).map(g=>[g.meta,doc.slice(g.start,g.end).toJSON()]));
    if(target.ranges.length)return JSON.stringify(target.ranges.map(r=>{const pos=doc.resolve(r.from);return doc.slice(r.row?pos.before():r.from,r.row?pos.after():r.to).toJSON();}));
    return JSON.stringify(target.selection.content().toJSON());
  }
  async copy(wholeEvent=false,cut=false){
    if(cut&&!this.editor.isEditable)return;
    const finish=this.beginOperation(),target=this.captureTarget(false,wholeEvent,cut),state=this.editor.state,sel=state.selection;
    const selectedEvents=new Set(target.events),selectedRanges=target.ranges.map(r=>({...r})),records=wholeEvent||target.events.size||sel instanceof AllSelection?this.records():[],handle=this.handle;
    const copiedContent=cut?this.cutContent(target):undefined;
    const ranges=groups(state.doc,this.codec.head),ids=new Map(ranges.map(g=>[g.meta.id,this.codec.resolveId(g.meta.id)]));
    try {await this.orderedEdit(async()=>{
      const remove=async()=>{if(cut)await this.commitTarget(target,()=>{if(target.events.size)this.deleteEvents();else if(target.ranges.length)this.replaceRanges('');else this.editor.commands.deleteSelection();},()=>{if(this.cutContent(target)!==copiedContent)throw new Error('等待期间目标内容已被修改，未覆盖新内容。请重新选择后重试。');});};
      if(!wholeEvent&&!selectedEvents.size&&selectedRanges.length){
        const text=selectedRanges.sort((a,b)=>a.from-b.from).map(r=>state.doc.textBetween(r.from,r.to)).join('\n');await copyToClipboard({text});await remove();return;
      }
      if(!wholeEvent&&!selectedEvents.size&&(sel instanceof CellSelection||sel instanceof TableRowSelection)){
        const content=sel.content().content.toJSON()??[];
        const nodes=content[0]?.type==='table'?content:[{type:'table',attrs:sel instanceof TableRowSelection?sel.table.attrs:sel.$anchorCell.node(-1).attrs,content}];
        const html=serializeQtHtml(nodes),text=plainText(nodes),assets=await this.clipAssets(html,handle);await copyToClipboard({text,html,events:JSON.stringify({events:qtFragment(html,text),fragment:nodes,assets})});await remove();return;
      }
      if(!wholeEvent&&!selectedEvents.size&&sel instanceof NodeSelection&&sel.node.type.name==='image'){
        const a=await window.desktop.asset(handle,sel.node.attrs.assetId);if(!a)throw new Error('原图不存在，复制未完成。');
        const html=serializeQtHtml([sel.node.toJSON()]),payload=JSON.stringify({events:qtFragment(html,'[图片]'),image:{width:sel.node.attrs.width,height:sel.node.attrs.height},assets:[{name:`asset:${a.id}`,data:toBase64(a.data),w:a.w,h:a.h}]});
        await copyToClipboard({text:'[图片]',html,image:a.data,events:payload});await remove();return;
      }
      let chosen:EventRecord[]=[];
      if(wholeEvent||selectedEvents.size){
        const raw=selectedEvents.size?selectedEvents:new Set([ranges.find(g=>sel.from>=g.start&&sel.from<=g.end)?.meta.id??0]);
        const wanted=new Set([...raw].map(id=>ids.get(id))),divided=new Set(ranges.filter(g=>g.dividerPos>=0).map(g=>ids.get(g.meta.id)));chosen=records.filter(e=>wanted.has(e.id)).map(e=>({...e,top_divider:divided.has(e.id)?1:0}));
      }else if(sel instanceof AllSelection)chosen=records;
      else if(!sel.empty){
        let content=state.doc.slice(sel.from,sel.to).content.toJSON()??[];
        const depth=sel.$from.sharedDepth(sel.to),parent=sel.$from.node(depth);
        if(content.length&&content.every((n:JSONContent)=>n.type==='listItem')&&['orderedList','bulletList'].includes(parent.type.name)){
          const attrs={...parent.attrs};if(parent.type.name==='orderedList')attrs.start=(attrs.start??1)+sel.$from.index(depth);
          content=[{type:parent.type.name,attrs,content}];
        }
        if(content.some((n:JSONContent)=>n.type==='divider')){const temp=state.schema.nodeFromJSON({type:'doc',content});chosen=new DocumentCodec([newEvent()]).records(temp);}
        else{const html=serializeQtHtml(content),text=plainText(content),assets=await this.clipAssets(html,handle);await copyToClipboard({text,html,events:JSON.stringify({events:qtFragment(html,text),fragment:content,assets})});await remove();return;}
      }else return;
      const assets=await this.clipAssets(chosen.map(e=>e.content_html).join('\n'),handle);
      await copyToClipboard({text:eventsClipboardText(chosen),html:chosen.map(e=>e.content_html).join('<hr>'),events:JSON.stringify({events:chosen.map(e=>({...e,done:!!e.done,top_divider:!!e.top_divider,html:e.content_html,text:e.content_text})),assets})});await remove();
    },true,true);}catch(e){this.bridge.error(String(e));}finally{this.asyncTargets.delete(target);finish();}
  }
  async paste(){
    if(!this.editor.isEditable)return;
    const finish=this.beginOperation(),target=this.captureInsertionTarget(),availableWidth=this.editor.view.dom.clientWidth||720;
    try{await this.orderedEdit(async()=>{
      const clip=await window.desktop.readClipboard();
      if(!clip.text&&!clip.html&&!clip.events&&!clip.image?.length&&!clip.images?.length)return;
      if(!clip.events&&this.bridge.interceptPaste&&await this.bridge.interceptPaste(clip))return;
      const rich=!!clip.html&&(clip.richText||!clip.text);
      if(target.ranges.length){
        if(clip.text&&!rich&&!clip.events&&!clip.image?.length&&!clip.images?.length&&(target.ranges.some(r=>r.row)||!/[\r\n]/.test(clip.text))){await this.commitTarget(target,()=>this.replaceRanges(clip.text));return;}
        target.ranges=[];
      }
      if(clip.events){
        const data=prepareEventClipboard(clip.events,!!target.eventRange);
        if(data){
          // Validate the exact insertion shape before committing any image BLOB.
          if(data.kind==='events'){
            this.editor.schema.nodeFromJSON(recordsToJSON(data.events)).check();
            this.validateOpaqueTransaction(this.eventTransaction(data.events,target.eventRange,target.selection));
          }
          if(data.kind==='fragment'){
            // Copied edge nodes may be open (for example an outer list item
            // starting at its nested list). Validate types/marks before HTML
            // normalization, and require complete valid nodes afterwards.
            for(const node of data.fragment!)this.editor.schema.nodeFromJSON(node);
            for(const node of parseQtHtml(data.htmls[0]).content)this.editor.schema.nodeFromJSON(node).check();
            this.validateRowPaste(parseQtHtml(data.htmls[0]).content,target);
          }
          const prepared:Awaited<ReturnType<TodoEditor['decodeImage']>>[]=[];
          for(const image of data.assets){try{prepared.push(await this.decodeImage(image.data,data.kind==='image'?data.display:undefined,availableWidth));}catch(error){throw new Error(`asset:${image.id}：${String(error)}`);}}
          if(!target.valid)throw new Error('等待期间目标内容已被修改，未覆盖新内容。请重新选择后重试。');
          const assets=prepared.map(p=>p.asset),ids=!assets.length?[]:this.bridge.assets?await this.bridge.assets(assets):await Promise.all(assets.map(a=>this.bridge.asset(a.data,a.w,a.h))),remap=new Map(data.assets.map((a,i)=>[a.id,ids[i]]));
          if(data.kind==='image'){const image=prepared[0];await this.commitTarget(target,()=>this.insertAtTarget([{type:'image',attrs:{assetId:ids[0],width:image.width,height:image.height}}],target));return;}
          const htmls=data.htmls.map(html=>remapImageAssets(html,id=>`asset:${remap.get(id)!}`));
          if(data.kind==='fragment'){
            const parsed=parseQtHtml(htmls[0]);
            await this.commitTarget(target,()=>{
              const fragment=Fragment.fromArray(parsed.content.map(n=>this.editor.schema.nodeFromJSON(n))),closed=new Slice(fragment,0,0);
              if(target.eventRange){this.insertAtTarget(parsed.content,target);return;}
              if(pasteTableRows(this.editor.view,closed)||tablePaste(this.editor.view,{} as ClipboardEvent,closed))return;
              const {state,view}=this.editor,selection=state.selection;
              if(selection.$from.parent.type.spec.code&&selection.$from.sameParent(selection.$to)&&!prepared.length){view.dispatch(state.tr.insertText(plainText(parsed.content)).scrollIntoView());return;}
              // Text taken from inside a line belongs back inside a line: an open
              // slice merges it into the paragraph at the caret instead of adding one.
              const open=Slice.maxOpen(fragment,false);
              this.selectedRanges=[];
              view.dispatch(state.tr.replaceSelection(new Slice(fragment,fragment.firstChild?.type.name==='paragraph'?open.openStart:0,open.openEnd)).scrollIntoView());
            });return;
          }
          await this.commitTarget(target,()=>this.insertRecords(data.events.map((e,i)=>({...e,content_html:htmls[i]})),target.eventRange));return;
        }
      }
      if(clip.image?.length){const image=await this.prepareImage(clip.image,undefined,availableWidth);await this.commitTarget(target,()=>this.insertAtTarget([image],target));return;}
      if(clip.images?.length){
        const prepared:Awaited<ReturnType<TodoEditor['decodeImage']>>[]=[];
        for(const image of clip.images){try{prepared.push(await this.decodeImage(image.data,undefined,availableWidth));}catch(error){throw new Error(`${image.name}：${String(error)}`);}}
        if(!target.valid)throw new Error('等待期间目标内容已被修改，未覆盖新内容。请重新选择后重试。');
        const assets=prepared.map(p=>p.asset),ids=this.bridge.assets?await this.bridge.assets(assets):await Promise.all(assets.map(a=>this.bridge.asset(a.data,a.w,a.h)));
        await this.commitTarget(target,()=>this.insertAtTarget(prepared.map((p,i)=>({type:'image',attrs:{assetId:ids[i],width:p.width,height:p.height}})),target));return;
      }
      if(rich){
        const parsed=parseRichClipboard(clip.html);if(parsed.empty)return;
        this.validateRowPaste(parsed.content,target);
        const prepared:Awaited<ReturnType<TodoEditor['decodeImage']>>[]=[];
        for(const bytes of parsed.images)prepared.push(await this.decodeImage(bytes,undefined,availableWidth));
        if(!target.valid)throw new Error('等待期间目标内容已被修改，未覆盖新内容。请重新选择后重试。');
        const assets=prepared.map(p=>p.asset),ids=!assets.length?[]:this.bridge.assets?await this.bridge.assets(assets):await Promise.all(assets.map(a=>this.bridge.asset(a.data,a.w,a.h)));
        const remap=(node:JSONContent):JSONContent=>{
          if(node.type==='image'){
            const index=Number(node.attrs?.assetId)-1,p=prepared[index],w=node.attrs?.width,h=node.attrs?.height;
            return {...node,attrs:{...node.attrs,assetId:ids[index],width:w??(h?Math.max(1,Math.round(h*p.asset.w/p.asset.h)):p.width),height:h??(w?Math.max(1,Math.round(w*p.asset.h/p.asset.w)):p.height)}};
          }
          return node.content?{...node,content:node.content.map(remap)}:node;
        };
        const content=parsed.content.map(remap);
        await this.commitTarget(target,()=>{
          this.selectedRanges=[];
          if(target.eventRange){this.insertAtTarget(content,target);return;}
          const {state,view}=this.editor,selection=state.selection;
          if(selection.$from.parent.type.spec.code&&selection.$from.sameParent(selection.$to)&&!prepared.length){view.dispatch(state.tr.insertText(plainText(content)).scrollIntoView());return;}
          const fragment=Fragment.fromArray(content.map(n=>state.schema.nodeFromJSON(n))),open=Slice.maxOpen(fragment,false);
          // A complete leading list/quote/code block owns its wrapper. Opening
          // it like a partial text selection can silently unwrap its first item.
          const slice=new Slice(fragment,fragment.firstChild?.type.name==='paragraph'?open.openStart:0,open.openEnd);
          if(!(pasteTableRows(view,slice)||tablePaste(view,{} as ClipboardEvent,slice)))view.dispatch(state.tr.replaceSelection(slice).scrollIntoView());
        });return;
      }
      if(clip.text)await this.commitTarget(target,()=>{
        const {state,view}=this.editor,selection=state.selection;
        const text=clip.text.replace(/\r\n?/g,'\n');
        if(target.eventRange){this.insertAtTarget(text.split('\n').map(t=>({type:'paragraph',content:t?[{type:'text',text:t}]:[]})),target);return;}
        if(selection instanceof CellSelection||selection instanceof TableRowSelection){const blocks=text.split('\n').map(t=>state.schema.nodes.paragraph.create(null,t?state.schema.text(t):undefined)),slice=new Slice(Fragment.fromArray(blocks),1,1);if(pasteTableRows(view,slice)||tablePaste(view,{} as ClipboardEvent,slice))return;}
        if(!text.includes('\n')||selection.$from.parent.type.spec.code&&selection.$from.sameParent(selection.$to))view.dispatch(state.tr.insertText(text).scrollIntoView());
        else {const marks=state.storedMarks??selection.$from.marks(),blocks=text.split('\n').map(t=>state.schema.nodes.paragraph.create(null,t?state.schema.text(t,marks):undefined));view.dispatch(state.tr.replaceSelection(new Slice(Fragment.fromArray(blocks),1,1)).scrollIntoView());}
      });
    },true);}catch(e){this.bridge.error(String(e));}finally{this.asyncTargets.delete(target);finish();}
  }
  private async clipAssets(html:string,handle=this.handle){const assets:{name:string;data:string;w:number;h:number}[]=[];for(const id of new Set(imageAssetReferences(html).map(ref=>ref.id))){const a=await window.desktop.asset(handle,id);if(!a)throw new Error('原图不存在，复制未完成。');assets.push({name:`asset:${id}`,data:toBase64(a.data),w:a.w,h:a.h});}return assets;}
  destroy(){clearInterval(this.refreshTimer);this.observer?.disconnect();this.mounts.clear();this.refreshers.clear();this.editor.destroy();for(const url of this.imageUrls)URL.revokeObjectURL(url);}
}
const selectionKey=new PluginKey<DecorationSet>('event-decoration');
export function toBase64(bytes:Uint8Array){let s='';for(let i=0;i<bytes.length;i+=8192)s+=String.fromCharCode(...bytes.subarray(i,i+8192));return btoa(s);}
export function fromBase64(s:string){return Uint8Array.from(atob(s),c=>c.charCodeAt(0));}
