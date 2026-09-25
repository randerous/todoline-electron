import {afterEach,beforeAll,expect,it,vi} from 'vitest';
import {PlainTextEditor,searchPlainText} from '../src/renderer/plain-text-editor';
import {DocumentTab} from '../src/renderer/runtime';
import type {DesktopAPI} from '../src/shared/types';
let owner:PlainTextEditor|undefined,tab:DocumentTab|undefined;
beforeAll(()=>{Range.prototype.getClientRects=()=>[] as unknown as DOMRectList;Range.prototype.getBoundingClientRect=()=>({left:0,right:0,top:0,bottom:0,width:0,height:0} as DOMRect);Element.prototype.getClientRects=()=>[] as unknown as DOMRectList;});
afterEach(()=>{owner?.destroy();owner=undefined;tab?.destroy();tab=undefined;document.body.innerHTML='';});
const snapshot=(source:string)=>({kind:'text' as const,handle:'text',name:'a.cfg',path:'a.cfg',draft:false,revision:0,source});
function setup(source:string){window.desktop={copy:vi.fn().mockResolvedValue(undefined),readClipboard:vi.fn().mockResolvedValue({text:'**literal**\n\tsecond\n',html:'<b>literal</b>',events:''})} as unknown as DesktopAPI;const el=document.createElement('div');document.body.append(el);owner=new PlainTextEditor(el,snapshot(source),{change:vi.fn(),selection:vi.fn(),error:vi.fn()});return owner;}
it('preserves original whitespace, displays Markdown literally and undoes edits',()=>{
 const source='# header\r\n\r\n  **bold**\t \r\n',plain=setup(source);expect(plain.source()).toBe(source);expect(plain.editor.view.dom.querySelector('strong,h1')).toBeNull();
 plain.editor.commands.setTextSelection(1);plain.editor.commands.insertContent({type:'text',text:'prefix '});expect(plain.source()).toBe('prefix # header\n\n  **bold**\t \n');plain.editor.commands.undo();expect(plain.source()).toBe(source);
});
it('pastes and copies text only, retaining tabs and empty lines',async()=>{
 const plain=setup('AB');plain.editor.commands.setTextSelection(2);await plain.paste();expect(plain.text()).toBe('A**literal**\n\tsecond\nB');
 plain.editor.commands.selectAll();await plain.copy();expect(window.desktop.copy).toHaveBeenCalledWith({text:'A**literal**\n\tsecond\nB'});
});
it('uses identical positions for mounted and unmounted text search',()=>{
 const plain=setup('\n  plan\n计划 plan\n');expect(plain.search('plan')).toEqual(searchPlainText(plain.source(),'plan'));plain.setSearch('plan');expect(plain.editor.view.dom.querySelectorAll('.text-search-match')).toHaveLength(2);plain.setSearch('');expect(plain.editor.view.dom.querySelectorAll('.text-search-match')).toHaveLength(0);
});
it('loads a text tab independently of the Markdown editor and saves through the file store',async()=>{
 window.desktop={markdown:{save:vi.fn().mockResolvedValue({revision:1})},save:vi.fn()} as unknown as DesktopAPI;const el=document.createElement('div');document.body.append(el);
 tab=new DocumentTab(snapshot('# literal'),vi.fn(),vi.fn());tab.mount(el);await tab.whenReady();expect(tab.isPlainText).toBe(true);expect(tab.isMarkdown).toBe(false);expect(tab.markdown).toBeUndefined();expect(tab.editor).toBeUndefined();expect(tab.records()).toEqual([]);
 tab.currentEditor!.commands.setTextSelection(1);tab.currentEditor!.commands.insertContent({type:'text',text:'new '});await tab.flush();expect(window.desktop.markdown.save).toHaveBeenCalledWith(expect.objectContaining({source:'new # literal'}));expect(window.desktop.save).not.toHaveBeenCalled();
});
it('persists undo and redo after an acknowledged autosave changes the shared snapshot',async()=>{
 window.desktop={markdown:{save:vi.fn().mockImplementation(async request=>({revision:request.revision+1}))}} as unknown as DesktopAPI;const el=document.createElement('div');document.body.append(el);
 tab=new DocumentTab(snapshot('original\r\n'),vi.fn(),vi.fn());tab.mount(el);await tab.whenReady();const editor=tab.currentEditor!;
 editor.commands.setTextSelection(1);editor.commands.insertContent({type:'text',text:'new '});await tab.flush();expect(tab.source()).toBe('new original\n');
 editor.commands.undo();expect(tab.source()).toBe('original\r\n');await tab.flush();expect(window.desktop.markdown.save).toHaveBeenLastCalledWith(expect.objectContaining({source:'original\r\n'}));
 editor.commands.redo();await tab.flush();expect(window.desktop.markdown.save).toHaveBeenLastCalledWith(expect.objectContaining({source:'new original\n'}));
});
