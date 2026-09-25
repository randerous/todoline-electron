import {Plugin,PluginKey,TextSelection,type EditorState,type Transaction} from '@tiptap/pm/state';
import {Mark} from '@tiptap/pm/model';
import {closeHistory} from '@tiptap/pm/history';
import {safeLink} from './codec';

interface UnlinkedRange {from:number;to:number;text:string}
const unlinkedKey=new PluginKey<UnlinkedRange|null>('explicitlyUnlinked');

export function plainLinkMarks(marks:readonly Mark[]):Mark[]{
  return marks.flatMap(mark=>{
    if(mark.type.name==='link'||mark.type.name==='underline')return [];
    if(mark.type.name==='textStyle'&&mark.attrs.color){
      const attrs={...mark.attrs,color:null};
      return Object.values(attrs).some(Boolean)?[mark.type.create(attrs)]:[];
    }
    return [mark];
  });
}

/** Qt treats adjacent anchors as one run, even if their hrefs differ. */
export function linkEndRange(state:EditorState):{from:number;to:number}|null{
  const s=state.selection;if(!(s instanceof TextSelection)||!s.empty)return null;
  const {$from}=s;if(!$from.parent.isTextblock||!$from.parentOffset)return null;
  const linked=(marks:readonly Mark[])=>marks.some(m=>m.type.name==='link');
  if($from.nodeAfter&&linked($from.nodeAfter.marks))return null;
  let start=-1;
  $from.parent.forEach((node,offset)=>{if(offset>=$from.parentOffset)return;if(linked(node.marks)){if(start<0)start=offset;}else start=-1;});
  return start<0?null:{from:$from.start()+start,to:s.from};
}

export function removeLinkStyle(tr:Transaction,from:number,to:number):Transaction{
  const nodes:{from:number;to:number;marks:readonly Mark[]}[]=[];
  tr.doc.nodesBetween(from,to,(node,pos)=>{if(node.isInline&&node.marks.some(m=>m.type.name==='link'))nodes.push({from:Math.max(from,pos),to:Math.min(to,pos+node.nodeSize),marks:node.marks});});
  for(const node of nodes){tr.removeMark(node.from,node.to);for(const mark of plainLinkMarks(node.marks))tr.addMark(node.from,node.to,mark);}
  return tr;
}

export function unlinkAtEnd(state:EditorState):Transaction|null{
  const range=linkEndRange(state);if(!range)return null;
  const marks=state.storedMarks??state.selection.$from.marks();
  return removeLinkStyle(closeHistory(state.tr),range.from,range.to)
    .setStoredMarks(plainLinkMarks(marks))
    .setMeta(unlinkedKey,{...range,text:state.doc.textBetween(range.from,range.to)});
}

export function unlinkSelection(tr:Transaction):Transaction{
  const {from,to}=tr.selection;
  removeLinkStyle(closeHistory(tr),from,to);
  tr.setStoredMarks(plainLinkMarks(tr.storedMarks??tr.selection.$from.marks()));
  if(from<to)tr.setMeta(unlinkedKey,{from,to,text:tr.doc.textBetween(from,to)});
  return tr;
}

/** Only an explicit space or Enter invokes this; paste and IME are not rewritten. */
export function linkBeforeCursor(tr:Transaction,state:EditorState):boolean{
  const s=tr.selection;if(!(s instanceof TextSelection)||!s.empty||!s.$from.parent.isTextblock||s.$from.parent.type.spec.code||(tr.storedMarks??s.$from.marks()).some(m=>m.type.name==='code'))return false;
  const prefix=s.$from.parent.textBetween(0,s.$from.parentOffset,'\n','\ufffc');
  const token=prefix.match(/[\x21-\x7e]+$/)?.[0];if(!token)return false;
  const label=token.replace(/[.,;:!?)\]}"']+$/,'');
  const href=/^https?:\/\//i.test(label)?label:/^www\.[^.]+\./i.test(label)?'http://'+label:null;
  if(!safeLink(href))return false;
  const from=s.from-token.length,to=from+label.length,guard=unlinkedKey.getState(state);
  if(guard?.from===from&&guard.to===to&&guard.text===label)return false;
  // Preserve explicitly authored anchors and never extend them into later typing.
  if(tr.doc.rangeHasMark(from,to,state.schema.marks.link))return false;
  tr.addMark(from,to,state.schema.marks.link.create({href}));return true;
}

export function linkEditingPlugin(){
  return new Plugin<UnlinkedRange|null>({key:unlinkedKey,state:{
    init:()=>null,
    apply(tr,guard){
      const explicit=tr.getMeta(unlinkedKey);if(explicit!==undefined)return explicit;
      if(!guard)return null;
      const from=tr.mapping.map(guard.from,1),to=tr.mapping.map(guard.to,-1);
      if(from>=to||to>tr.doc.content.size||tr.doc.textBetween(from,to)!==guard.text||tr.doc.rangeHasMark(from,to,tr.doc.type.schema.marks.link))return null;
      if(tr.selectionSet&&tr.selection.from<to)return null;
      return {...guard,from,to};
    },
  },appendTransaction(transactions,_old,state){
    if(!transactions.some(tr=>tr.docChanged||tr.selectionSet))return;
    if(!linkEndRange(state))return;
    const marks=state.storedMarks??state.selection.$from.marks(),plain=plainLinkMarks(marks);
    if(!Mark.sameSet(marks,plain))return state.tr.setStoredMarks(plain);
  }});
}
