import {afterEach,beforeAll,describe,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
import {linkBeforeCursor,linkEndRange} from '../src/renderer/link-editing';
let owner:TodoEditor;
beforeAll(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0} as DOMRect);Element.prototype.getClientRects=()=>[] as unknown as DOMRectList;});
afterEach(()=>{owner?.destroy();document.body.innerHTML='';});
function setup(html:string){const el=document.createElement('div');document.body.append(el);owner=new TodoEditor(el,{handle:'test',name:'links.tde',path:'links.tde',revision:0,events:[{...newEvent(),id:1,pos:0,content_html:html}]},{change:vi.fn(),selection:vi.fn(),error:vi.fn(),asset:vi.fn()});const ed=owner.editor;ed.commands.setTextSelection(ed.state.doc.content.size-1);return ed;}
function key(key:string,extra:KeyboardEventInit={}){owner.editor.view.dom.dispatchEvent(new KeyboardEvent('keydown',{key,bubbles:true,cancelable:true,...extra}));}
const anchors=()=>owner.editor.view.dom.querySelectorAll('a');
describe('Qt link editing rules',()=>{
  it.each([
    ['https://example.com','https://example.com'],['HTTP://example.com/a','HTTP://example.com/a'],['www.example.com','http://www.example.com'],
    ['中文https://example.com。',''],['中文https://example.com','https://example.com'],['https://example.com.,!?)]}', 'https://example.com'],
    ['example.com',''],['me@example.com',''],['www.local',''],['https://',''],['https://user:secret@example.com',''],['javascript:alert(1)',''],
  ])('links only the Qt token %s on a space', (text,href)=>{
    const ed=setup(`<p>${text}</p>`);expect(anchors()).toHaveLength(0);key(' ');expect(anchors()).toHaveLength(href?1:0);if(href){expect(anchors()[0].getAttribute('href')).toBe(href);expect(ed.state.doc.textContent).toBe(text+' ');ed.commands.undo();expect(ed.state.doc.textContent).toBe(text);expect(anchors()).toHaveLength(0);}
  });
  it('Enter converts and splits as one undo step with indentation',()=>{const ed=setup('<p style="white-space:pre-wrap">    https://example.com</p>');key('Enter');expect(anchors()).toHaveLength(1);expect(owner.records()[0].content_text).toBe('    https://example.com\n    ');ed.commands.undo();expect(ed.state.doc.childCount).toBe(1);expect(anchors()).toHaveLength(0);});
  it('Enter in a numbered item keeps the list and creates the next item',()=>{const ed=setup('<ol><li><p>https://example.com</p></li></ol>');ed.commands.setTextSelection(22);key('Enter');expect(ed.view.dom.querySelectorAll('li')).toHaveLength(2);expect(anchors()).toHaveLength(1);ed.commands.undo();expect(ed.view.dom.querySelectorAll('li')).toHaveLength(1);expect(anchors()).toHaveLength(0);});
  it('Backspace at a loaded anchor end removes styling without removing text and undo restores it',()=>{
    const ed=setup('<p><a href="https://example.com"><span style="font-size:18pt;color:#2e86de;text-decoration:underline"><b>第一</b><i>第二</i></span></a></p>');key('Backspace');expect(ed.state.doc.textContent).toBe('第一第二');expect(anchors()).toHaveLength(0);const html=owner.records()[0].content_html;expect(html).toContain('font-size:18pt');expect(html).toContain('<strong>');expect(html).toContain('<em>');expect(html).not.toMatch(/color:|<u>|href=/);ed.commands.undo();expect(anchors()).toHaveLength(1);ed.commands.redo();expect(anchors()).toHaveLength(0);
  });
  it('does not relink the explicitly unlinked token until its text changes',()=>{
    const ed=setup('<p><a href="https://example.com">https://example.com</a></p>');key('Backspace');expect(linkBeforeCursor(ed.state.tr,ed.state)).toBe(false);ed.view.dispatch(ed.state.tr.insertText('/new'));key(' ');expect(anchors()).toHaveLength(1);expect(anchors()[0].textContent).toBe('https://example.com/new');
  });
  it('keeps the interior of links editable while a selection is not treated as link-end Backspace',()=>{
    const ed=setup('<p><a href="https://example.com">abc</a></p>');ed.commands.setTextSelection(2);expect(linkEndRange(ed.state)).toBeNull();ed.view.dispatch(ed.state.tr.insertText('X'));expect(anchors()[0].textContent).toBe('aXbc');ed.commands.setTextSelection({from:1,to:3});key('Backspace');expect(anchors()).toHaveLength(1);
  });
  it('typing at the end keeps font emphasis without inheriting the anchor color or underline',()=>{
    const ed=setup('<p><a href="https://example.com"><span style="color:blue;text-decoration:underline;font-size:18pt"><b>link</b></span></a></p>');ed.view.dispatch(ed.state.tr.insertText('中文'));expect(anchors()[0].textContent).toBe('link');const node=ed.state.doc.firstChild!.lastChild!;expect(node.text).toBe('中文');expect(node.marks.map(m=>m.type.name)).toEqual(expect.arrayContaining(['bold','textStyle']));expect(node.marks.some(m=>m.type.name==='link'||m.type.name==='underline'||m.attrs.color)).toBe(false);
  });
  it('typing after an existing anchor does not rewrite its authored href on the next space',()=>{const ed=setup('<p><a href="https://target.test">https://display.test</a></p>');ed.view.dispatch(ed.state.tr.insertText('/tail'));key(' ');expect(anchors()[0].getAttribute('href')).toBe('https://target.test');expect(anchors()[0].textContent).toBe('https://display.test');});
  it('composition and modified keys never trigger link rewriting',()=>{setup('<p>https://example.com</p>');key(' ',{isComposing:true});key(' ',{ctrlKey:true});expect(anchors()).toHaveLength(0);});
  it('composing Enter bypasses every editor keymap without preventing native IME handling',()=>{const ed=setup('<p>https://example.com</p>'),event=new KeyboardEvent('keydown',{key:'Enter',isComposing:true,bubbles:true,cancelable:true});expect(ed.view.dom.dispatchEvent(event)).toBe(true);expect(event.defaultPrevented).toBe(false);expect(ed.state.doc.childCount).toBe(1);expect(anchors()).toHaveLength(0);});
});
