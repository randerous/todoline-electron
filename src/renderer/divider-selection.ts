import {Plugin,Selection,TextSelection,type SelectionBookmark} from '@tiptap/pm/state';
import type {Node as PMNode,ResolvedPos} from '@tiptap/pm/model';
import type {Mappable} from '@tiptap/pm/transform';

/** A text range may end immediately before/after a divider, outside a textblock. */
export class DividerRangeSelection extends Selection {
  static create(doc:PMNode,anchor:number,head:number):Selection{
    const $anchor=doc.resolve(anchor),$head=doc.resolve(head);
    if(anchor===head)return Selection.near($head);
    if($anchor.parent.isTextblock&&$head.parent.isTextblock)return TextSelection.create(doc,anchor,head);
    return new DividerRangeSelection($anchor,$head);
  }
  map(doc:PMNode,mapping:Mappable){return DividerRangeSelection.create(doc,mapping.map(this.anchor),mapping.map(this.head));}
  eq(other:Selection){return other instanceof DividerRangeSelection&&other.anchor===this.anchor&&other.head===this.head;}
  toJSON(){return {type:'dividerRange',anchor:this.anchor,head:this.head};}
  static fromJSON(doc:PMNode,json:{anchor:number;head:number}){return DividerRangeSelection.create(doc,json.anchor,json.head);}
  getBookmark(){return new DividerRangeBookmark(this.anchor,this.head);}
}
class DividerRangeBookmark implements SelectionBookmark{
  constructor(private anchor:number,private head:number){}
  map(mapping:Mappable){return new DividerRangeBookmark(mapping.map(this.anchor),mapping.map(this.head));}
  resolve(doc:PMNode){return DividerRangeSelection.create(doc,this.anchor,this.head);}
}
Selection.jsonID('dividerRange',DividerRangeSelection);
const atDivider=($pos:ResolvedPos)=>!$pos.parent.isTextblock&&($pos.nodeAfter?.type.name==='divider'||$pos.nodeBefore?.type.name==='divider');

export function dividerDragSelection(){
  let anchor:number|null=null,boundary:number|null=null;
  return new Plugin({
    props:{
      handleDOMEvents:{mousedown(view,event){
        anchor=null;boundary=null;
        if(event.button!==0||event.altKey||event.ctrlKey||event.metaKey||(event.target as HTMLElement).closest('.event-divider,input,button,.image-view,.legacy-content'))return false;
        const hit=view.posAtCoords({left:event.clientX,top:event.clientY});
        if(hit&&view.state.doc.resolve(hit.pos).parent.isTextblock)anchor=event.shiftKey?view.state.selection.anchor:hit.pos;
        return false;
      }},
      createSelectionBetween(view,$anchor,$head){
        if(anchor!==null&&boundary!==null)return DividerRangeSelection.create(view.state.doc,anchor,boundary);
        return atDivider($anchor)||atDivider($head)?DividerRangeSelection.create(view.state.doc,$anchor.pos,$head.pos):null;
      },
    },
    view(view){
      const doc=view.dom.ownerDocument;
      const move=(event:MouseEvent)=>{
        if(anchor===null)return;
        if(!(event.buttons&1)){anchor=null;boundary=null;return;}
        const divider=doc.elementFromPoint(event.clientX,event.clientY)?.closest('.event-divider');
        boundary=null;
        if(!divider||!view.dom.contains(divider))return;
        const pos=view.posAtDOM(divider,0),node=view.state.doc.nodeAt(pos);
        if(node?.type.name!=='divider')return;
        boundary=anchor>pos?pos:pos+node.nodeSize;
        const selection=DividerRangeSelection.create(view.state.doc,anchor,boundary);
        if(!selection.eq(view.state.selection))view.dispatch(view.state.tr.setSelection(selection));
        event.preventDefault();
      };
      let finish:ReturnType<typeof setTimeout>|undefined;
      const up=()=>{
        const selection=anchor!==null&&boundary!==null?DividerRangeSelection.create(view.state.doc,anchor,boundary):null;
        // Let Chromium finish its native mouse selection before committing the atom edge.
        clearTimeout(finish);finish=setTimeout(()=>{anchor=null;boundary=null;if(selection&&!view.isDestroyed&&selection.$from.doc===view.state.doc&&!selection.eq(view.state.selection))view.dispatch(view.state.tr.setSelection(selection));},0);
      };
      doc.addEventListener('mousemove',move);doc.addEventListener('mouseup',up);
      return {destroy(){clearTimeout(finish);doc.removeEventListener('mousemove',move);doc.removeEventListener('mouseup',up);}};
    },
  });
}
