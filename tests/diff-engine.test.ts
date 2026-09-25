// @vitest-environment node
import {expect,it} from 'vitest';
import {compareText,diffLines,type DiffCell} from '../src/renderer/diff-engine';
import {diffDocument} from '../src/renderer/diff-document';
import type {DocumentTab} from '../src/renderer/runtime';
function unchanged(cell:DiffCell){let text='',pos=0;for(const [start,end] of cell.ranges){expect(start).toBeGreaterThanOrEqual(pos);expect(end).toBeGreaterThan(start);expect(end).toBeLessThanOrEqual(cell.text.length);text+=cell.text.slice(pos,start);pos=end;}return text+cell.text.slice(pos);}
function verify(a:string,b:string){const result=compareText(a,b);expect(result.rows.flatMap(row=>row.left?[row.left.text]:[])).toEqual(diffLines(a));expect(result.rows.flatMap(row=>row.right?[row.right.text]:[])).toEqual(diffLines(b));for(const row of result.rows){if(row.kind==='equal')expect(row.left?.text).toBe(row.right?.text);if(row.kind==='change')expect(unchanged(row.left!)).toBe(unchanged(row.right!));}return result;}
it('aligns additions and deletions while preserving independent original line numbers',()=>{
 const result=verify('one\ndeleted\nanchor\nlast','one\nanchor\nadded\nlast');expect(result.rows.map(row=>row.kind)).toEqual(['equal','delete','equal','add','equal']);expect(result).toMatchObject({added:1,deleted:1,modified:0,changes:[1,3]});expect(result.rows[2]).toMatchObject({left:{line:3},right:{line:2}});
});
it('highlights multiple changed regions within a line including Unicode and whitespace',()=>{
 const result=verify('中文😀 alpha=12 beta=old \t','中文😃 alpha=16 beta=new  \t');expect(result.modified).toBe(1);expect(result.rows[0].left!.ranges.length).toBeGreaterThan(1);expect(result.rows[0].right!.ranges.length).toBeGreaterThan(1);expect(result.rows[0].left!.ranges[0]).toEqual([2,4]);
});
it('handles empty files, blank lines, final newlines and normalized line-ending styles',()=>{
 expect(verify('','').changes).toEqual([]);expect(verify('','one').added).toBe(1);expect(verify('one','').deleted).toBe(1);expect(verify('one','one\n').added).toBe(1);expect(verify('a\r\n\r\nb\r\n','a\n\nb\n').changes).toEqual([]);
});
it('preserves all text across repeated lines, shifts and randomized insertions and removals',()=>{
 let seed=123456;const rand=()=>((seed=(seed*1664525+1013904223)>>>0)/2**32),tokens=['same','重复','a=1','a=2','', '\tspace  ','😀'];
 for(let round=0;round<250;round++){const make=()=>Array.from({length:Math.floor(rand()*24)},()=>tokens[Math.floor(rand()*tokens.length)]).join('\n');verify(make(),make());}
});
it('anchors large files and bounds expensive unrelated blocks without dropping any lines',()=>{
 const a=Array.from({length:20_000},(_,i)=>`line ${i}`),b=[...a];b.splice(100,0,'inserted');b[15000]='changed content';const result=verify(a.join('\n'),b.join('\n'));expect(result.added).toBe(1);expect(result.modified).toBe(1);expect(result.coarse).toBe(false);
 const huge=verify(Array.from({length:1500},(_,i)=>'left '+i).join('\n'),Array.from({length:1600},(_,i)=>'right '+i).join('\n'));expect(huge.rows).toHaveLength(1600);expect(huge.coarse).toBe(true);
});
it('compares live text sources and stable TDE metadata without IDs or ticking time',()=>{
 expect(diffDocument({isText:true,source:()=>'* raw *'} as unknown as DocumentTab)).toBe('* raw *');
 const event={id:1,pos:0,created_at:1700000000,deadline_raw:'1分钟后',deadline_ts:1700000060,done:0,top_divider:1,content_html:'<b>body</b>',content_text:'body'};
 const input=(record:typeof event)=>({isText:false,records:()=>[record]} as unknown as DocumentTab);
 expect(diffDocument(input(event))).toContain('截止 1分钟后');expect(diffDocument(input(event))).toBe(diffDocument(input({...event,id:100,pos:500})));expect(diffDocument(input({...event,done:1}))).toContain('已完成');
 const head={...event,top_divider:0,deadline_raw:'',deadline_ts:null as number|null};
 expect(diffDocument(input(head as typeof event))).not.toBe(diffDocument(input({...head,done:1} as typeof event)));
 expect(diffDocument(input({...head,deadline_raw:'明天'} as typeof event))).toContain('截止 明天');
});
