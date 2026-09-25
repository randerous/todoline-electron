import {Plugin,Selection,SelectionRange,TextSelection,type Transaction,type SelectionBookmark} from '@tiptap/pm/state';
import {Fragment,Slice,type Node as PMNode} from '@tiptap/pm/model';
import type {Mappable} from '@tiptap/pm/transform';
import {Decoration,DecorationSet,type EditorView} from '@tiptap/pm/view';
export type TextRange={from:number;to:number};
export function mergeTextRanges(ranges:TextRange[]):TextRange[]{
 const result:TextRange[]=[];
 for(const r of ranges.filter(r=>r.to>r.from).map(r=>({...r})).sort((a,b)=>a.from-b.from)){
  const last=result.at(-1);if(last&&r.from<=last.to)last.to=Math.max(last.to,r.to);else result.push(r);
 }return result;
}
export class MultiTextSelection extends Selection {
 constructor(doc:PMNode,readonly parts:TextRange[]){super(doc.resolve(parts[0].from),doc.resolve(parts[0].to),parts.map(r=>new SelectionRange(doc.resolve(r.from),doc.resolve(r.to))));}
 map(doc:PMNode,mapping:Mappable):Selection{const parts=mergeTextRanges(this.parts.map(r=>({from:mapping.map(r.from,1),to:mapping.map(r.to,-1)})));return parts.length?new MultiTextSelection(doc,parts):Selection.near(doc.resolve(Math.min(doc.content.size,mapping.map(this.head))));}
 eq(other:Selection){return other instanceof MultiTextSelection&&JSON.stringify(other.parts)===JSON.stringify(this.parts);}
 toJSON(){return {type:'multiText',parts:this.parts};}
 static fromJSON(doc:PMNode,json:{parts:TextRange[]}){return new MultiTextSelection(doc,mergeTextRanges(json.parts));}
 getBookmark():SelectionBookmark{return new MultiBookmark(this.parts);}
 content(){let content=Fragment.empty;for(const r of this.parts){const part=this.$from.doc.slice(r.from,r.to).content;content=content.append(part.firstChild?.isInline?Fragment.from(this.$from.doc.type.schema.nodes.paragraph.create(null,part)):part);}return new Slice(content,0,0);}
 replace(tr:Transaction,content=Slice.empty){const start=tr.steps.length;for(const r of [...this.parts].reverse()){const map=tr.mapping.slice(start);tr.replaceRange(map.map(r.from,1),map.map(r.to,-1),content);}tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.slice(start).map(this.parts[0].from,1))));}
 replaceWith(tr:Transaction,node:PMNode){this.replace(tr,new Slice(Fragment.from(node),0,0));}
}
MultiTextSelection.prototype.visible=false;
Selection.jsonID('multiText',MultiTextSelection);
class MultiBookmark implements SelectionBookmark{
 constructor(private parts:TextRange[]){}
 map(mapping:Mappable){return new MultiBookmark(this.parts.map(r=>({from:mapping.map(r.from,1),to:mapping.map(r.to,-1)})));}
 resolve(doc:PMNode){const parts=mergeTextRanges(this.parts.map(r=>({from:Math.max(0,Math.min(doc.content.size,r.from)),to:Math.max(0,Math.min(doc.content.size,r.to))})));return parts.length?new MultiTextSelection(doc,parts):Selection.atStart(doc);}
}
export function selectedRangesText(doc:PMNode,selection:Selection){return selection.ranges.map(r=>doc.textBetween(r.$from.pos,r.$to.pos,'\n',n=>n.attrs.latex??n.attrs.alt??'')).join('\n');}
const words=new Intl.Segmenter(undefined,{granularity:'word'});
function wordAt(view:EditorView,pos:number):TextRange|undefined{
 const $pos=view.state.doc.resolve(pos);if(!$pos.parent.isTextblock)return;
 const text=$pos.parent.textBetween(0,$pos.parent.content.size,'','\uFFFC');
 for(const part of words.segment(text))if(part.isWordLike&&part.index<= $pos.parentOffset&&part.index+part.segment.length>=$pos.parentOffset)return {from:$pos.start()+part.index,to:$pos.start()+part.index+part.segment.length};
}
/** Capture Ctrl drags before native selection collapses the earlier ranges. */
export function multiTextSelection(adapter?:{get():TextRange[];set(ranges:TextRange[],view:EditorView):void}){
 return new Plugin({props:{
  decorations(state){const s=state.selection;if(!(s instanceof MultiTextSelection))return null;return DecorationSet.create(state.doc,s.parts.flatMap(r=>[Decoration.inline(r.from,r.to,{class:'multi-text-selection'})]));},
  handleTextInput(view,_from,_to,text){if(!(view.state.selection instanceof MultiTextSelection)||!view.editable)return false;const tr=view.state.tr;view.state.selection.replaceWith(tr,view.state.schema.text(text));view.dispatch(tr.scrollIntoView());return true;},
  handleKeyDown(view,event){if(!(view.state.selection instanceof MultiTextSelection))return false;if(event.key==='Escape'||(!event.ctrlKey&&!event.metaKey&&/^(Arrow|Home|End|Page)/.test(event.key))){view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.selection.$head)));return event.key==='Escape';}return false;},
  handleDOMEvents:{compositionstart(view){if(view.state.selection instanceof MultiTextSelection)view.dispatch(view.state.tr.setSelection(TextSelection.between(view.state.selection.$anchor,view.state.selection.$head)));return false;}},
 },view(view){
  let clean=()=>{};
  const down=(event:MouseEvent)=>{
   if(event.button===2&&view.state.selection instanceof MultiTextSelection){const at=view.posAtCoords({left:event.clientX,top:event.clientY});if(at&&view.state.selection.parts.some(r=>at.pos>=r.from&&at.pos<=r.to)){event.preventDefault();event.stopImmediatePropagation();return;}}
   // A plain drag starts a fresh selection, never an HTML drag of the first range.
   if(event.button===0&&!event.ctrlKey&&!event.metaKey&&!event.altKey&&view.state.selection instanceof MultiTextSelection){
    const pos=view.posAtCoords({left:event.clientX,top:event.clientY});if(pos)view.dispatch(view.state.tr.setSelection(TextSelection.near(view.state.doc.resolve(pos.pos))));
   }
   if(event.button!==0||!event.ctrlKey||event.altKey||event.shiftKey||view.composing||(event.target as Element).closest('a[href],input,button,.event-divider,.legacy-content,img'))return;
   const start=view.posAtCoords({left:event.clientX,top:event.clientY});if(!start||!view.state.doc.resolve(start.pos).parent.isTextblock)return;
   clean();event.preventDefault();event.stopImmediatePropagation();
   const selection=view.state.selection,existing=adapter?.get()??(selection instanceof MultiTextSelection?selection.parts:[]),base=existing.length?existing:selection instanceof TextSelection&&!selection.empty?[{from:selection.from,to:selection.to}]:[];
   const doc=view.dom.ownerDocument;let moved=false,last=start.pos;
   const set=(ranges:TextRange[])=>{const merged=mergeTextRanges(ranges);if(adapter)adapter.set(merged,view);else view.dispatch(view.state.tr.setSelection(merged.length?new MultiTextSelection(view.state.doc,merged):TextSelection.near(view.state.doc.resolve(last))));};
   const move=(e:MouseEvent)=>{if(Math.abs(e.clientX-event.clientX)+Math.abs(e.clientY-event.clientY)<3&&!moved)return;moved=true;const end=view.posAtCoords({left:e.clientX,top:e.clientY});if(!end)return;last=end.pos;set([...base,{from:Math.min(start.pos,last),to:Math.max(start.pos,last)}]);};
   const up=()=>{if(!moved){const inside=base.find(r=>r.from<=start.pos&&r.to>=start.pos),word=wordAt(view,start.pos);set(inside?base.filter(r=>r!==inside):word?[...base,word]:base);}clean();view.focus();};
   const blur=()=>clean();
   clean=()=>{doc.removeEventListener('mousemove',move);doc.removeEventListener('mouseup',up);doc.defaultView?.removeEventListener('blur',blur);clean=()=>{};};
   doc.addEventListener('mousemove',move);doc.addEventListener('mouseup',up);doc.defaultView?.addEventListener('blur',blur);view.focus();
  };
  // Prevent the click following a Ctrl drag from replacing the custom selection.
  const click=(event:MouseEvent)=>{if(event.ctrlKey&&!(event.target as Element).closest('a[href],input,button,.event-divider,.legacy-content,img')){event.preventDefault();event.stopImmediatePropagation();}};
  view.dom.addEventListener('mousedown',down,true);view.dom.addEventListener('click',click,true);
  return {destroy(){clean();view.dom.removeEventListener('mousedown',down,true);view.dom.removeEventListener('click',click,true);}};
 }});
}

export function plainCanvasCaret(){return new Plugin({view(view){
 const canvas=view.dom.closest<HTMLElement>('.document-scroller');
 const down=(event:MouseEvent)=>{if(event.button!==0||event.ctrlKey||event.metaKey||event.altKey||event.shiftKey)return;const target=event.target as Element;if(target!==canvas&&target!==view.dom&&target!==view.dom.parentElement)return;const last=view.dom.lastElementChild;if(last&&event.clientY<last.getBoundingClientRect().bottom)return;event.preventDefault();view.dispatch(view.state.tr.setSelection(Selection.atEnd(view.state.doc)));view.focus();};
 canvas?.addEventListener('mousedown',down);return {destroy(){canvas?.removeEventListener('mousedown',down);}};
}});}
