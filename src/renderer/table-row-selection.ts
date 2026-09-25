import {Fragment,Slice,type Node as PMNode} from '@tiptap/pm/model';
import {Selection,SelectionRange,Plugin,EditorState,type Transaction} from '@tiptap/pm/state';
import type {Mappable} from '@tiptap/pm/transform';
import {Decoration,DecorationSet,type EditorView} from '@tiptap/pm/view';
import {CellSelection,TableMap,handlePaste} from '@tiptap/pm/tables';

/** Rows connected by a rowspan are selected together: a cell is never half selected. */
export function connectedRows(table:PMNode,rows:readonly number[]){
  const selected=new Set(rows.filter(r=>Number.isInteger(r)&&r>=0&&r<table.childCount)),map=TableMap.get(table);
  let changed=true;
  while(changed){changed=false;for(const offset of new Set(map.map)){const rect=map.findCell(offset);if(!Array.from({length:rect.bottom-rect.top},(_,i)=>rect.top+i).some(r=>selected.has(r)))continue;for(let r=rect.top;r<rect.bottom;r++)if(!selected.has(r)){selected.add(r);changed=true;}}}
  return [...selected].sort((a,b)=>a-b);
}
export class TableRowSelection extends Selection {
  readonly rows:number[];
  readonly table:PMNode;
  readonly cells:number[];
  constructor(readonly doc:PMNode,readonly tablePos:number,rows:readonly number[],readonly anchorRow=rows[0]){
    const table=doc.nodeAt(tablePos);if(table?.type.spec.tableRole!=='table')throw new RangeError('Table not found');
    const chosen=connectedRows(table,rows);if(!chosen.length)throw new RangeError('No selected rows');
    const map=TableMap.get(table),cells=[...new Set(chosen.flatMap(r=>map.map.slice(r*map.width,(r+1)*map.width)))].sort((a,b)=>a-b);
    const ranges=cells.map(offset=>{const cell=table.nodeAt(offset)!,from=tablePos+offset+2;return new SelectionRange(doc.resolve(from),doc.resolve(from+cell.content.size));});
    super(ranges[0].$from,ranges[0].$to,ranges);this.table=table;this.rows=chosen;this.cells=cells;
  }
  eq(other:Selection){return other instanceof TableRowSelection&&other.tablePos===this.tablePos&&other.anchorRow===this.anchorRow&&String(other.rows)===String(this.rows);}
  map(doc:PMNode,mapping:Mappable):Selection{return this.getBookmark().map(mapping).resolve(doc);}
  content(){return new Slice(Fragment.from(this.table.copy(Fragment.fromArray(this.rows.map(r=>this.table.child(r))))),0,0);}
  replace(tr:Transaction,content=Slice.empty){
    const start=tr.steps.length;
    this.ranges.forEach((range,i)=>{const mapping=tr.mapping.slice(start);tr.replace(mapping.map(range.$from.pos),mapping.map(range.$to.pos),i?Slice.empty:content);});
    tr.setSelection(Selection.near(tr.doc.resolve(tr.mapping.slice(start).map(this.from)),1));
  }
  replaceWith(tr:Transaction,node:PMNode){this.replace(tr,new Slice(Fragment.from(node),0,0));}
  deleteRows(tr:Transaction){
    const retained:PMNode[]=[];this.table.forEach((row,_pos,index)=>{if(!this.rows.includes(index))retained.push(row);});
    if(retained.length)tr.replaceWith(this.tablePos,this.tablePos+this.table.nodeSize,this.table.copy(Fragment.fromArray(retained)));
    else tr.delete(this.tablePos,this.tablePos+this.table.nodeSize);
    return tr.setSelection(Selection.near(tr.doc.resolve(Math.min(this.tablePos,tr.doc.content.size)),1));
  }
  asCellSelection(){const map=TableMap.get(this.table),start=this.tablePos+1;return CellSelection.rowSelection(this.doc.resolve(start+map.map[this.rows[0]*map.width]),this.doc.resolve(start+map.map[(this.rows.at(-1)!+1)*map.width-1]));}
  get contiguous(){return this.rows.every((r,i)=>!i||r===this.rows[i-1]+1);}
  toJSON(){return {type:'tableRows',tablePos:this.tablePos,rows:this.rows,anchorRow:this.anchorRow};}
  static fromJSON(doc:PMNode,json:{tablePos:number;rows:number[];anchorRow:number}){return new TableRowSelection(doc,json.tablePos,json.rows,json.anchorRow);}
  getBookmark(){const positions:number[]=[];let anchor=this.from;this.table.forEach((row,pos,i)=>{if(this.rows.includes(i))positions.push(this.tablePos+pos+2);if(i===this.anchorRow)anchor=this.tablePos+pos+2;});return new RowBookmark(positions,anchor,this.from);}
}
TableRowSelection.prototype.visible=false;
Selection.jsonID('tableRows',TableRowSelection);
class RowBookmark {
  constructor(readonly positions:number[],readonly anchor:number,readonly fallback:number){}
  map(mapping:Mappable){return new RowBookmark(this.positions.flatMap(p=>{const result=mapping.mapResult(p,1);return result.deletedAcross?[]:[result.pos];}),mapping.map(this.anchor,1),mapping.map(this.fallback,1));}
  resolve(doc:PMNode):Selection{
    let tablePos:number|undefined,anchor:number|undefined;const rows:number[]=[];
    for(const p of this.positions){if(p<0||p>doc.content.size)continue;const at=doc.resolve(p);if(at.parent.type.spec.tableRole!=='row')continue;const pos=at.before(at.depth-1);if(tablePos!==undefined&&tablePos!==pos)continue;tablePos=pos;rows.push(at.index(at.depth-1));if(p===this.anchor)anchor=rows.at(-1);}
    return tablePos!==undefined&&rows.length?new TableRowSelection(doc,tablePos,rows,anchor??rows[0]):Selection.near(doc.resolve(Math.max(0,Math.min(doc.content.size,this.fallback))));
  }
}
export function tableRowSelectionPlugin(){return new Plugin({props:{decorations(state){const s=state.selection;if(!(s instanceof TableRowSelection))return null;return DecorationSet.create(state.doc,s.cells.map(offset=>{const pos=s.tablePos+1+offset;return Decoration.node(pos,pos+s.table.nodeAt(offset)!.nodeSize,{class:'selectedCell'});}));}}});}

/** Fit a paste on a projected grid, then map it back without touching skipped rows. */
export function tableRowsPaste(selection:TableRowSelection,slice:Slice):PMNode{
  const schema=selection.doc.type.schema,projected=selection.content().content.firstChild!,doc=schema.topNodeType.create(null,projected),map=TableMap.get(projected);
  const state=EditorState.create({schema,doc,selection:CellSelection.create(doc,1+map.map[0],1+map.map.at(-1)!)});
  let result=projected;
  // handlePaste uses only state and dispatch; this is a pure temporary state,
  // with no Editor, DOM, plugins, history or persistence of its own.
  handlePaste({state,dispatch:(tr:Transaction)=>{result=tr.doc.firstChild!;}} as EditorView,{} as ClipboardEvent,slice);
  const fitted=TableMap.get(result),cells:{column:number;node:PMNode}[][]=selection.rows.map(()=>[]);
  for(const offset of new Set(fitted.map)){
    const rect=fitted.findCell(offset),cell=result.nodeAt(offset)!;let first=true;
    for(let top=rect.top;top<rect.bottom;){let bottom=top+1;while(bottom<rect.bottom&&selection.rows[bottom]===selection.rows[bottom-1]+1)bottom++;
      const attrs={...cell.attrs,rowspan:bottom-top},node=first?cell.type.create(attrs,cell.content,cell.marks):cell.type.createAndFill(attrs)!;
      cells[top].push({column:rect.left,node});first=false;top=bottom;
    }
  }
  const rows:PMNode[]=[];selection.table.forEach((row,_pos,index)=>{const selected=selection.rows.indexOf(index);rows.push(selected<0?row:result.child(selected).copy(Fragment.fromArray(cells[selected].sort((a,b)=>a.column-b.column).map(c=>c.node))));});
  const table=selection.table.copy(Fragment.fromArray(rows));table.check();if(TableMap.get(table).problems)throw new Error('无法将此表格完整粘贴到所选行。');return table;
}
export function pasteTableRows(view:EditorView,slice:Slice){const s=view.state.selection;if(!(s instanceof TableRowSelection))return false;const table=tableRowsPaste(s,slice),tr=view.state.tr.replaceWith(s.tablePos,s.tablePos+s.table.nodeSize,table);tr.setSelection(new TableRowSelection(tr.doc,s.tablePos,s.rows,s.anchorRow));view.dispatch(tr.scrollIntoView());return true;}
