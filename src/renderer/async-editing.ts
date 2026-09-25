import {Selection,TextSelection,type Transaction} from '@tiptap/pm/state';

export interface EditRange {from:number;to:number;row?:boolean}
// Shared by every document in this renderer, including cross-tab copies.
let clipboardTail:Promise<unknown>|undefined;
export function orderedClipboard<T>(operation:()=>Promise<T>,isCopy=false):Promise<T>{
  // A paste already queued behind a failed copy must not read stale contents.
  // Clearing the settled tail still allows the user's next attempt to retry.
  const next=clipboardTail?clipboardTail.then(operation,isCopy?operation:undefined):operation();
  clipboardTail=next;
  void next.finally(()=>{if(clipboardTail===next)clipboardTail=undefined;}).catch(()=>{});
  return next;
}
export class AsyncTarget {
  eventRange?:EditRange;
  setEventRange(range:EditRange,protect:EditRange){this.eventRange={...range};this.protectedRanges.push({...protect});}
  valid=true;
  moved=false;
  uiSelection='';
  readonly activeElement=document.activeElement;
  constructor(public selection:Selection,public events:Set<number>,public ranges:EditRange[],private protectedRanges:EditRange[],private restoring=false,private snapshot=false){}
  map(tr:Transaction,applying:boolean){
    const previous=this.selection,previousInsertion=this.eventRange,previousRanges=this.ranges;
    if(tr.docChanged){
      let touched=false;
      const protectedRanges=this.protectedRanges.map(r=>({...r}));
      for(const map of tr.mapping.maps){
        for(const range of protectedRanges){
          map.forEach((from,to)=>{
            if(range.from===range.to?from<range.from&&to>range.to:from<range.to&&to>range.from||from===to&&from>range.from&&from<range.to)touched=true;
          });
          const empty=range.from===range.to;range.from=map.map(range.from,1);range.to=empty?range.from:Math.max(range.from,map.map(range.to,-1));
        }
      }
      if(touched&&(!applying||this.snapshot)&&!this.restoring)this.valid=false;
      this.protectedRanges=protectedRanges;
      this.selection=previous.map(tr.doc,tr.mapping);
      // A cut owns the copied snapshot. Content inserted at either edge was not
      // copied and must stay; replacements inside it invalidate the pending cut.
      if(this.snapshot&&previous instanceof TextSelection&&!previous.empty){
        const from=tr.mapping.map(previous.from,1),to=Math.max(from,tr.mapping.map(previous.to,-1));
        this.selection=TextSelection.between(tr.doc.resolve(previous.anchor<=previous.head?from:to),tr.doc.resolve(previous.anchor<=previous.head?to:from));
      }
      this.ranges=this.ranges.map(r=>{const from=tr.mapping.map(r.from,1);return {...r,from,to:Math.max(from,tr.mapping.map(r.to,-1))};});
      if(previousInsertion){const from=tr.mapping.map(previousInsertion.from,1);this.eventRange={from,to:previousInsertion.from===previousInsertion.to?from:Math.max(from,tr.mapping.map(previousInsertion.to,-1))};}
      // Repeated queued pastes at the same selected content append after the
      // first replacement; AllSelection's ordinary bookmark would select all again.
      const source:EditRange[]|undefined=tr.getMeta('rangeEditSource'),carets:EditRange[]|undefined=tr.getMeta('rangeCarets');
      const sameColumns=source?.length===previousRanges.length&&carets?.length&&previousRanges.every((r,i)=>!r.row&&r.from===source![i].from&&r.to===source![i].to);
      if(sameColumns&&applying&&!this.restoring&&!this.snapshot){
        this.ranges=carets!.map(r=>({...r}));this.selection=TextSelection.create(tr.doc,this.ranges[0].from);this.protectedRanges=this.ranges.map(r=>({...r}));
      }else if(touched&&applying&&!this.restoring&&!this.snapshot){
        this.selection=Selection.near(tr.doc.resolve(tr.mapping.map(previousInsertion?.to??previous.to,1)),-1);
        this.events.clear();this.ranges=[];this.eventRange=undefined;this.protectedRanges=[{from:this.selection.from,to:this.selection.to}];
      }
    }
    if(!applying&&tr.selectionSet&&!tr.selection.eq(previous.map(tr.doc,tr.mapping)))this.moved=true;
  }
}
