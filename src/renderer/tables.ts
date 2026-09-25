import {Extension,Node} from '@tiptap/core';
import {tableEditing} from '@tiptap/pm/tables';
import {tableDomAttrs,cellDomAttrs,readTableLayout,span,tableColumnWidths} from './table-format';
import {tableColumnResize} from './table-resize';
import {tableRowSelectionPlugin} from './table-row-selection';
const roles:Record<string,string>={table:'table',table_row:'row',table_cell:'cell',table_header:'header_cell'};
const layout={default:null,parseHTML:(el:HTMLElement)=>readTableLayout(el),renderHTML:()=>({})};
export const Table=Node.create({name:'table',group:'block',content:'table_row+',isolating:true,addAttributes(){return {layout};},parseHTML(){return [{tag:'table'}];},renderHTML({node}){return ['table',tableDomAttrs(node.attrs.layout),['tbody',0]];},addNodeView(){return ({node})=>{
  const dom=document.createElement('table'),columns=dom.appendChild(document.createElement('colgroup')),contentDOM=dom.appendChild(document.createElement('tbody'));let attributes:Record<string,string>={};
  const refresh=(next:typeof node)=>{
    const attrs=tableDomAttrs(next.attrs.layout);for(const key of Object.keys(attributes))if(!(key in attrs))dom.removeAttribute(key);for(const [key,value]of Object.entries(attrs))if(value!==attributes[key])dom.setAttribute(key,value);attributes=attrs;
    const widths=tableColumnWidths(next.toJSON().content??[]);widths.forEach((width,i)=>{const col=columns.children[i] as HTMLElement??columns.appendChild(document.createElement('col'));const value=width?width+'px':'';if(col.style.width!==value)col.style.width=value;});while(columns.children.length>widths.length)columns.lastChild!.remove();
  };
  refresh(node);return {dom,contentDOM,update(next){if(next.type!==node.type)return false;refresh(next);return true;},ignoreMutation(record){return record.type!=='selection'&&(record.type==='attributes'&&record.target===dom||record.target===columns||columns.contains(record.target));}};
};}});
export const TableRow=Node.create({name:'table_row',content:'(table_cell | table_header)*',addAttributes(){return {layout,section:{default:null,renderHTML:()=>({})}};},parseHTML(){return [{tag:'tr'}];},renderHTML({node}){return ['tr',tableDomAttrs(node.attrs.layout),0];}});
function cell(name:string,tag:string){return Node.create({name,content:'block+',isolating:true,addAttributes(){return {layout,colspan:{default:1,parseHTML:el=>span(el.getAttribute('colspan'))},rowspan:{default:1,parseHTML:el=>span(el.getAttribute('rowspan'))},colwidth:{default:null}};},parseHTML(){return [{tag}];},renderHTML({node}){return [tag,cellDomAttrs(node.attrs),0];}});}
export const TableCell=cell('table_cell','td'),TableHeader=cell('table_header','th');
export const TableBehavior=Extension.create({name:'tableBehavior',priority:50,extendNodeSchema(extension){return roles[extension.name]?{tableRole:roles[extension.name]}:{};},addProseMirrorPlugins(){return [tableColumnResize(),tableRowSelectionPlugin(),tableEditing()];}});
