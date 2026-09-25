export type DiffRange=[number,number];
export type DiffCell={line:number;text:string;ranges:DiffRange[]};
export type DiffRow={kind:'equal'|'add'|'delete'|'change';left?:DiffCell;right?:DiffCell};
export type DiffResult={rows:DiffRow[];changes:number[];added:number;deleted:number;modified:number;coarse:boolean;leftColumns:number;rightColumns:number};
type Edit={kind:'equal'|'delete'|'insert';a:number;b:number};
type Budget={remaining:number;coarse:boolean};

/** Bounded Myers search. A large unrelated block still retains every input line. */
function sequence(a:string[],b:string[],a0:number,a1:number,b0:number,b1:number,budget:Budget,limit=512):Edit[]{
 const prefix:Edit[]=[],suffix:Edit[]=[];
 while(a0<a1&&b0<b1&&a[a0]===b[b0])prefix.push({kind:'equal',a:a0++,b:b0++});
 while(a0<a1&&b0<b1&&a[a1-1]===b[b1-1])suffix.push({kind:'equal',a:--a1,b:--b1});
 const n=a1-a0,m=b1-b0;
 const coarse=()=>[...Array.from({length:n},(_,i):Edit=>({kind:'delete',a:a0+i,b:b0})),...Array.from({length:m},(_,i):Edit=>({kind:'insert',a:a1,b:b0+i}))];
 if(!n||!m)return prefix.concat(coarse(),suffix.reverse());
 const max=Math.min(n+m,limit),offset=max+1,v=new Int32Array(2*max+3).fill(-1),trace:Int32Array[]=[];v[offset+1]=0;
 for(let d=0;d<=max&&budget.remaining>0;d++){
  trace.push(v.slice());
  for(let k=-d;k<=d;k+=2){
   budget.remaining--;let x=k===-d||(k!==d&&v[offset+k-1]<v[offset+k+1])?v[offset+k+1]:v[offset+k-1]+1,y=x-k;
   while(x<n&&y<m&&a[a0+x]===b[b0+y]){x++;y++;budget.remaining--;}
   v[offset+k]=x;
   if(x>=n&&y>=m){
    const edits:Edit[]=[];let ax=n,by=m;
    for(let step=d;step>=0;step--){
     const old=trace[step],diag=ax-by,previous=diag===-step||(diag!==step&&old[offset+diag-1]<old[offset+diag+1])?diag+1:diag-1;
     const px=old[offset+previous],py=px-previous;
     while(ax>px&&by>py)edits.push({kind:'equal',a:a0+--ax,b:b0+--by});
     if(step){if(ax===px)edits.push({kind:'insert',a:a0+ax,b:b0+--by});else edits.push({kind:'delete',a:a0+--ax,b:b0+by});}
    }
    return prefix.concat(edits.reverse(),suffix.reverse());
   }
  }
 }
 budget.coarse=true;return prefix.concat(coarse(),suffix.reverse());
}

/** Unique common lines provide anchors so distant edits do not consume a quadratic trace. */
function lineEdits(a:string[],b:string[],budget:Budget):Edit[]{
 const positions=(lines:string[])=>{const map=new Map<string,number>();lines.forEach((line,i)=>map.set(line,map.has(line)?-1:i));return map;};
 const left=positions(a),right=positions(b),pairs:[number,number][]=[];
 for(const [text,i] of left){const j=right.get(text);if(i>=0&&j!==undefined&&j>=0)pairs.push([i,j]);}
 const tails:number[]=[],previous=new Int32Array(pairs.length).fill(-1);
 pairs.forEach((pair,i)=>{let lo=0,hi=tails.length;while(lo<hi){const mid=(lo+hi)>>>1;if(pairs[tails[mid]][1]<pair[1])lo=mid+1;else hi=mid;}if(lo)previous[i]=tails[lo-1];tails[lo]=i;});
 const anchors:[number,number][]=[];for(let i=tails.at(-1)??-1;i>=0;i=previous[i])anchors.push(pairs[i]);anchors.reverse();
 const result:Edit[]=[];let ai=0,bi=0;
 for(const [i,j] of [...anchors,[a.length,b.length]]){for(const edit of sequence(a,b,ai,i,bi,j,budget))result.push(edit);if(i<a.length){result.push({kind:'equal',a:i,b:j});ai=i+1;bi=j+1;}}
 return result;
}
function inline(a:string,b:string,budget:Budget):[DiffRange[],DiffRange[]]{
 const left=Array.from(a),right=Array.from(b),ranges:[DiffRange[],DiffRange[]]=[[],[]];let x=0,y=0;
 for(const edit of sequence(left,right,0,left.length,0,right.length,budget,128)){
  const length=(edit.kind==='insert'?right[edit.b]:left[edit.a]).length;
  if(edit.kind==='equal'){x+=length;y+=length;continue;}
  const side=edit.kind==='delete'?0:1,start=side===0?x:y,previous=ranges[side].at(-1);
  if(previous&&previous[1]===start)previous[1]+=length;else ranges[side].push([start,start+length]);
  if(side===0)x+=length;else y+=length;
 }
 return ranges;
}
export function diffLines(source:string){return source===''?[]:source.replace(/\r\n|\r/g,'\n').split('\n');}
function columns(text:string){let width=0;for(const char of text)width+=char==='\t'?4-width%4:char.codePointAt(0)!>255?2:1;return width;}
export function compareText(left:string,right:string):DiffResult{
 const a=diffLines(left),b=diffLines(right),budget:Budget={remaining:4_000_000,coarse:false},edits=lineEdits(a,b,budget);
 const result:DiffResult={rows:[],changes:[],added:0,deleted:0,modified:0,coarse:false,leftColumns:0,rightColumns:0};
 const cell=(lines:string[],index:number):DiffCell=>({line:index+1,text:lines[index],ranges:[]});
 for(let i=0;i<edits.length;){
  const edit=edits[i];if(edit.kind==='equal'){result.rows.push({kind:'equal',left:cell(a,edit.a),right:cell(b,edit.b)});i++;continue;}
  const removed:number[]=[],added:number[]=[];result.changes.push(result.rows.length);
  while(i<edits.length&&edits[i].kind!=='equal'){const e=edits[i++];if(e.kind==='delete')removed.push(e.a);else added.push(e.b);}
  for(let j=0;j<Math.max(removed.length,added.length);j++){
   const l=j<removed.length?cell(a,removed[j]):undefined,r=j<added.length?cell(b,added[j]):undefined;
   if(l&&r&&l.text===r.text)result.rows.push({kind:'equal',left:l,right:r});
   else if(l&&r){[l.ranges,r.ranges]=inline(l.text,r.text,budget);result.modified++;result.rows.push({kind:'change',left:l,right:r});}
   else if(l){result.deleted++;result.rows.push({kind:'delete',left:l});}else{result.added++;result.rows.push({kind:'add',right:r});}
  }
 }
 result.changes=[];
 result.rows.forEach((row,index)=>{if(row.kind!=='equal'&&(index===0||result.rows[index-1].kind==='equal'))result.changes.push(index);if(row.left)result.leftColumns=Math.max(result.leftColumns,columns(row.left.text));if(row.right)result.rightColumns=Math.max(result.rightColumns,columns(row.right.text));});
 result.coarse=budget.coarse;return result;
}
