// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
import {GapCursor} from '@tiptap/pm/gapcursor';
let owner:TodoEditor;
function setup(html:string,top=0){const el=document.createElement('div');document.body.append(el);owner=new TodoEditor(el,{handle:'test',path:'test.tde',name:'test',revision:0,events:[{...newEvent(),id:71,created_at:1750000000,done:1,deadline_raw:'明天',deadline_ts:1750086400,top_divider:top,content_html:html}]},{change:vi.fn(),selection:vi.fn(),error:vi.fn(),asset:vi.fn()});owner.editor.view.setProps({handleScrollToSelection:()=>true});return owner.editor;}
function caret(text:string,offset=0){let found=-1;owner.editor.state.doc.descendants((n,p)=>{if(n.isText&&n.text===text)found=p+offset;});if(found<0)throw new Error('Missing text '+text);owner.editor.commands.setTextSelection(found);}
function valid(){owner.editor.state.doc.check();owner.editor.state.doc.descendants((n,_p,parent)=>{if(n.type.name==='divider')expect(parent?.type.name).toBe('doc');});expect(()=>owner.records()).not.toThrow();}
function key(key:string){owner.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true}));}
afterEach(()=>{owner?.destroy();document.body.innerHTML='';});
describe('event boundaries in structured content',()=>{
  it.each(['<blockquote><p>甲乙</p></blockquote>','<ol start="5"><li>甲乙</li><li>后文</li></ol>','<ul><li>前文<blockquote><p>甲乙</p></blockquote></li></ul>','<pre>甲乙</pre>'])('splits nested content into real events: %s',html=>{
    const e=setup(html);caret('甲乙',1);const before=e.state.doc.toJSON();expect(owner.split()).toBe(true);valid();expect(owner.records()).toHaveLength(2);expect(owner.records()[0]).toMatchObject({id:71,done:1,deadline_raw:'明天'});expect(owner.records()[1]).toMatchObject({done:0,deadline_raw:''});expect(owner.records()[0].content_text).toContain('甲');expect(owner.records()[1].content_text).toContain('乙');e.commands.undo();expect(e.state.doc.toJSON()).toEqual(before);e.commands.redo();valid();expect(owner.records()).toHaveLength(2);
  });
  it.each(['<blockquote><p>甲乙</p></blockquote>','<ol start="5"><li>甲乙</li></ol>'])('inserts at the structured document head without adding a phantom event: %s',html=>{const e=setup(html);caret('甲乙');owner.split();valid();expect(owner.records()).toHaveLength(1);expect(owner.records()[0]).toMatchObject({id:71,top_divider:1,done:1,deadline_raw:'明天'});expect(e.state.doc.firstChild?.type.name).toBe('divider');});
  it('list wrapping cannot absorb event dividers',()=>{const e=setup('<p>甲乙</p>',1);caret('甲乙',1);owner.split();e.commands.selectAll();e.commands.toggleBulletList();valid();expect(owner.records()).toHaveLength(2);});
  it.each([0,1,2])('keeps ordered-list numbering when splitting an item at offset %i',offset=>{
    const e=setup('<ol start="5"><li>前文</li><li>甲乙</li><li>后文</li></ol>');caret('甲乙',offset);owner.split();valid();const lists:number[]=[];e.state.doc.forEach(n=>{if(n.type.name==='orderedList')lists.push(n.attrs.start);});expect(lists).toEqual([5,offset===2?7:6]);expect(e.state.doc.textContent).toBe('前文甲乙后文');expect(owner.records()).toHaveLength(2);if(offset===0)expect(owner.records()[0].content_text).toBe('5. 前文');
  });
  it.each(['<blockquote><p>甲乙</p></blockquote>','<ol><li>甲乙</li></ol>','<blockquote><ul><li>甲乙</li></ul></blockquote>','<pre>甲乙</pre>'])('arrow and backspace reach the leading boundary through nested containers: %s',html=>{
    const e=setup(html,1);caret('甲乙');key('ArrowLeft');expect(e.state.selection).toBeInstanceOf(GapCursor);expect(e.state.selection.from).toBe(0);key('Delete');valid();expect(owner.records()[0].top_divider).toBe(0);expect(e.state.doc.textContent).toBe('甲乙');e.commands.undo();caret('甲乙');key('Backspace');valid();expect(owner.records()[0].top_divider).toBe(0);
  });
  it('Delete at a nested block end removes only the following event boundary',()=>{
    const e=setup('<blockquote><ol><li>甲乙</li></ol></blockquote>');caret('甲乙',1);owner.split();caret('甲',1);key('Delete');valid();expect(owner.records()).toHaveLength(1);expect(e.state.doc.textContent).toBe('甲乙');e.commands.undo();valid();expect(owner.records()).toHaveLength(2);
  });
  it('Backspace inside a later list item keeps the preceding event boundary',()=>{
    const e=setup('<ol><li>前文</li><li>甲乙</li></ol>',1);caret('甲乙');key('Backspace');valid();expect(owner.records()[0].top_divider).toBe(1);expect(e.state.doc.textContent).toBe('前文甲乙');
  });
  it.each([0,1])('first-line whitespace refreshes the same event metadata with top divider %i',top=>{
    const e=setup('<blockquote><p style="white-space:pre-wrap">  甲乙</p></blockquote>',top);caret('  甲乙',2);const before=e.state.doc.toJSON();owner.split();valid();expect(owner.records()).toHaveLength(1);expect(owner.records()[0]).toMatchObject({id:71,done:1,top_divider:1,deadline_raw:'明天',deadline_ts:1750086400});expect(e.state.doc.textContent).toBe('甲乙');e.commands.undo();expect(e.state.doc.toJSON()).toEqual(before);
  });
  it('keeps an empty paragraph above a later split instead of treating it as the document head',()=>{const e=setup('<p></p><blockquote><p>甲乙</p></blockquote>');caret('甲乙');owner.split();valid();expect(owner.records()).toHaveLength(2);expect(e.state.doc.firstChild?.type.name).toBe('paragraph');});
  it('splitting at the end of a nested event leaves a usable empty body',()=>{const e=setup('<blockquote><ol start="7"><li>甲乙</li></ol></blockquote>');caret('甲乙',2);owner.split();valid();expect(owner.records()).toHaveLength(2);expect(e.state.selection.$from.parent.type.name).toBe('paragraph');e.commands.insertContent('继续');expect(owner.records()[1].content_text).toContain('继续');});
  it('the schema rejects nested dividers before they can become untracked event data',()=>{const e=setup('<p>甲乙</p>');const quote=e.schema.nodes.blockquote.create(null,e.schema.nodes.divider.create({id:42}));expect(()=>quote.check()).toThrow();});
  it('typing immediately after a split has its own undo step',()=>{const e=setup('<blockquote><p>甲乙</p></blockquote>');caret('甲乙',1);owner.split();e.commands.insertContent('新');expect(e.state.doc.textContent).toBe('甲新乙');e.commands.undo();expect(e.state.doc.textContent).toBe('甲乙');expect(owner.records()).toHaveLength(2);e.commands.undo();expect(owner.records()).toHaveLength(1);expect(e.state.doc.textContent).toBe('甲乙');});
  it('keeps images on the correct side and does not mistake an image prefix for whitespace',()=>{const e=setup('<blockquote><p><img src="asset:9" width="80" height="60" />甲乙</p></blockquote>');caret('甲乙');owner.split();valid();expect(owner.records()).toHaveLength(2);expect(owner.records()[0].content_html).toContain('asset:9');expect(owner.records()[1].content_html).not.toContain('asset:9');const images:any[]=[];e.state.doc.descendants(n=>{if(n.type.name==='image')images.push(n.attrs);});expect(images).toHaveLength(1);expect(images[0]).toMatchObject({assetId:9,width:80,height:60});});
  it('completed leading body content stays visibly completed before and after deleting its divider',()=>{const e=setup('<blockquote><p>甲乙</p></blockquote>');expect(e.view.dom.querySelector('blockquote')?.classList.contains('done-content')).toBe(true);caret('甲乙');owner.split();key('Backspace');expect(owner.records()[0].done).toBe(1);expect(e.view.dom.querySelector('blockquote')?.classList.contains('done-content')).toBe(true);});
  it('inserting an event below keeps its history separate from immediate typing',()=>{const e=setup('<p>甲乙</p>');owner.insertEventBelow(71);e.commands.insertContent('新');e.commands.undo();expect(owner.records()).toHaveLength(2);expect(owner.records()[1].content_text).toBe('');e.commands.undo();expect(owner.records()).toHaveLength(1);});
});
