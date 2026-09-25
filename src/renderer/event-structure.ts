import {Fragment,type Node as PMNode,type ResolvedPos} from '@tiptap/pm/model';
import {TableMap} from '@tiptap/pm/tables';

/** Divide a root block at the caret, retaining each side's nested formatting. */
export function partitionBlock(pos:ResolvedPos,depth=1):{left:PMNode|null;right:PMNode|null}{
  const node=pos.node(depth);
  if(node.type.spec.tableRole==='table'&&pos.depth>=depth+2)return partitionTable(pos,depth);
  if(depth===pos.depth){const offset=pos.parentOffset;return {left:offset?node.copy(node.content.cut(0,offset)):null,right:offset<node.content.size||!offset?node.copy(node.content.cut(offset)):null};}
  const index=pos.index(depth),part=partitionBlock(pos,depth+1);
  const before:PMNode[]=[],after:PMNode[]=[];node.forEach((child,_offset,i)=>{if(i<index)before.push(child);if(i>index)after.push(child);});
  if(part.left)before.push(part.left);if(part.right)after.unshift(part.right);
  const create=(children:PMNode[],right=false)=>{
    if(!children.length)return null;
    const attrs=node.type.name==='orderedList'&&right?{...node.attrs,start:Number(node.attrs.start??1)+index+(part.right?0:1)}:node.attrs;
    // A split inside a quote nested in a list item may require an empty leading
    // paragraph on the new item. Let the schema provide its required content.
    const result=node.type.createAndFill(attrs,Fragment.fromArray(children),node.marks);
    if(!result)throw new Error('无法保留分隔线两侧的内容结构。');
    return result;
  };
  return {left:create(before),right:create(after,true)};
}

/** Clip both rectangular grids at the current row; text belongs to one side only. */
function partitionTable(pos:ResolvedPos,depth:number):{left:PMNode|null;right:PMNode|null}{
  const table=pos.node(depth),map=TableMap.get(table),rowIndex=pos.index(depth),cellPos=pos.before(depth+2)-pos.start(depth),part=partitionBlock(pos,depth+2);
  const entries:{node:PMNode;pos:number;top:number;bottom:number;left:number}[]=[];
  table.forEach((row,rowPos)=>row.forEach((cell,offset)=>{const p=rowPos+offset+1;entries.push({node:cell,pos:p,...map.findCell(p)});}));
  const half=(right:boolean)=>{
    if(!entries.some(e=>right?e.pos>cellPos:e.pos<cellPos)&&!(right?part.right:part.left))return null;
    const first=right?rowIndex:0,last=right?map.height:rowIndex+1,rows:PMNode[]=[];
    for(let r=first;r<last;r++){
      const cells=entries.filter(e=>Math.max(e.top,first)===r&&e.bottom>first&&e.top<last).sort((a,b)=>a.left-b.left).map(e=>{
        const chosen=e.pos===cellPos?(right?part.right:part.left):((e.pos>cellPos)===right?e.node:null);
        const content=chosen?.content??e.node.type.createAndFill()!.content;
        return e.node.type.create({...e.node.attrs,rowspan:Math.min(e.bottom,last)-Math.max(e.top,first)},content,e.node.marks);
      });
      rows.push(table.child(r).copy(Fragment.fromArray(cells)));
    }
    return table.copy(Fragment.fromArray(rows));
  };
  return {left:half(false),right:half(true)};
}

/** Root boundary only when the caret is at the corresponding edge at all depths. */
export function outerTextEdge(pos:ResolvedPos,end=false):number|null{
  if(!pos.parent.isTextblock||pos.parentOffset!==(end?pos.parent.content.size:0))return null;
  for(let depth=pos.depth-1;depth>0;depth--)if(end?pos.indexAfter(depth)!==pos.node(depth).childCount:pos.index(depth)!==0)return null;
  return end?pos.after(1):pos.before(1);
}

export function isFirstBodyPrefix(pos:ResolvedPos):boolean{
  const first=pos.doc.firstChild?.type.name==='divider'?1:0;
  if(pos.index(0)!==first||!pos.parent.isTextblock)return false;
  for(let depth=1;depth<pos.depth;depth++)if(pos.index(depth)!==0)return false;
  return !pos.parent.content.cut(0,pos.parentOffset).textBetween(0,pos.parentOffset,'\n','\ufffc').trim();
}
