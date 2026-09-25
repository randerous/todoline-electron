// @vitest-environment jsdom
import {afterEach,describe,expect,it,vi} from 'vitest';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent} from '../src/renderer/document';
import {parseQtHtml,serializeQtHtml,markdown,plainText} from '../src/renderer/codec';
import {existsSync,mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {DocumentStore} from '../src/main/storage';
import {exportContents} from '../src/renderer/document';
import {linkBeforeCursor} from '../src/renderer/link-editing';

// scripts/build-qt-compat.ps1 links Qt 6.8.3 and the sibling Qt project's
// libtlcore.a, so this harness only exists on a prepared developer machine.
const qtHarness = path.resolve('.cache/qt-compat/qt-compat.exe');
const hasQtHarness = existsSync(qtHarness);

let owner:TodoEditor|undefined;
afterEach(()=>{owner?.destroy();owner=undefined;document.body.innerHTML='';vi.unstubAllGlobals();});
function editor(){const el=document.createElement('div');document.body.append(el);owner=new TodoEditor(el,{handle:'test',path:'test.tde',name:'test',revision:0,events:[{...newEvent(),content_html:'<p>正文</p>'}]},{change:vi.fn(),selection:vi.fn(),error:vi.fn(),asset:vi.fn()});return owner;}
describe('editor structures can be saved and exported',()=>{
  it.each(['codeBlock','blockquote'] as const)('saves a %s created by the editor',kind=>{const e=editor();if(kind==='codeBlock')e.editor.commands.toggleCodeBlock();else e.editor.commands.toggleBlockquote();expect(()=>e.records()).not.toThrow();expect(parseQtHtml(e.records()[0].content_html).readOnly).toBe(false);});
  it('retains inline code in HTML and Markdown without escaping its literal characters',()=>{const content=[{type:'paragraph',content:[{type:'text',text:'a < b & `x`',marks:[{type:'code'}]}]}];expect(serializeQtHtml(content)).toContain('<code');expect(markdown(content)).toBe('`` a < b & `x` ``');expect(plainText(content)).toBe('a < b & `x`');});
  it.each(['','\n','  a\n\n b\nlast','\nstart\n','<tag> & `code`'])('preserves code whitespace and line breaks: %j',value=>{
    const html=serializeQtHtml([{type:'codeBlock',attrs:{language:'typescript'},content:value?[{type:'text',text:value}]:[]}]),parsed=parseQtHtml(html);
    expect(parsed.readOnly).toBe(false);expect(parsed.content[0].type).toBe('codeBlock');expect(parsed.content[0].attrs?.language).toBe('typescript');expect(plainText(parsed.content)).toBe(value);expect(plainText(parseQtHtml(serializeQtHtml(parsed.content)).content)).toBe(value);
  });
  it('reads native pre and code markup without collapsing spaces or losing styled runs',()=>{
    const parsed=parseQtHtml('<pre style="color:#ff0000;font-size:14pt"><code class="language-js">  a\n<b>b</b>\n</code></pre>');expect(parsed.readOnly).toBe(false);expect(plainText(parsed.content)).toBe('  a\nb\n');expect(parsed.content[0].attrs?.codeStyle).toMatchObject({color:'rgb(255, 0, 0)',fontSize:'14pt',fontFamily:'Consolas'});expect(parsed.content[0].content?.some(n=>n.marks?.some(m=>m.type==='bold'))).toBe(true);
  });
  it('keeps unsupported code images read-only instead of dropping them',()=>{expect(parseQtHtml('<pre><img src="asset:1" /></pre>').readOnly).toBe(true);});
  it('quotes paragraphs and nested lists without flattening their newlines',()=>{
    const parsed=parseQtHtml('<blockquote><p>one</p><ul><li>two</li></ul><blockquote><p>three</p></blockquote></blockquote>');expect(parsed.readOnly).toBe(false);expect(plainText(parsed.content)).toBe('one\n- two\nthree');expect(markdown(parsed.content)).toBe('> one\n> \n> - two\n> \n> > three');expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);
  });
  it.each(['   ','`a`','a``b',' a '])('exports literal inline code %j with unambiguous delimiters',value=>{
    const out=markdown([{type:'paragraph',content:[{type:'text',text:value,marks:[{type:'code'}]}]}]);expect(out).not.toContain('\\');if(value==='   ')expect(out).toBe('`   `');if(value==='a``b')expect(out).toBe('```a``b```');if(value===' a ')expect(out).toBe('`  a  `');
  });
  it('chooses a longer fence and keeps indentation in whole-document plain-text exports',()=>{
    const code='  const x = `a`;\n```\n  end',html=serializeQtHtml([{type:'codeBlock',attrs:{language:'js'},content:[{type:'text',text:code}]}]);expect(markdown(parseQtHtml(html).content)).toBe('````js\n'+code+'\n````');expect(exportContents([{...newEvent(),content_html:html}],'txt','test')).toBe(code+'\n');
  });
  it('sanitizes code attributes and never treats language names as HTML or Markdown syntax',()=>{
    const html=serializeQtHtml([{type:'codeBlock',attrs:{language:'js\n```evil',codeStyle:{fontFamily:'bad; color:red',color:'url(https://bad)',fontSize:'12pt'}},content:[{type:'text',text:'<script>'}]}]);expect(html).not.toContain('data-language');expect(html).not.toContain('https://bad');expect(html).toContain('&lt;script&gt;');
  });
  it.each(['codeBlock','code'])('leaves URL tokens literal inside %s',kind=>{const e=editor();e.editor.commands.setContent(kind==='codeBlock'?{type:'doc',content:[{type:'codeBlock',content:[{type:'text',text:'https://example.com'}]}]}:{type:'doc',content:[{type:'paragraph',content:[{type:'text',text:'https://example.com',marks:[{type:'code'}]}]}]});e.editor.commands.setTextSelection(e.editor.state.doc.content.size-1);expect(linkBeforeCursor(e.editor.state.tr,e.editor.state)).toBe(false);});
  it('escapes quoted font names inside serialized code attributes',()=>{
    const html=serializeQtHtml([{type:'codeBlock',attrs:{codeStyle:{fontFamily:'"Fira Code"'}},content:[{type:'text',text:'code'}]}]);
    const dom=new DOMParser().parseFromString(html,'text/html'),pre=dom.querySelector('pre')!;
    expect(pre.attributes.length).toBe(1);expect(pre.style.fontFamily).toContain('Fira Code');expect(parseQtHtml(html).readOnly).toBe(false);
  });
  it('keeps whitespace-only code in plain-text exports',()=>{
    const content_html=serializeQtHtml([{type:'codeBlock',content:[{type:'text',text:'  \n\n  '}]}]);
    expect(exportContents([{...newEvent(),content_html}],'txt','test')).toBe('  \n\n  \n');
  });
  it('pastes multiline plain text into code as literal text and undoes the paste once',async()=>{
    const e=editor();e.editor.view.setProps({handleScrollToSelection:()=>true});e.editor.commands.setContent({type:'doc',content:[{type:'codeBlock',content:[{type:'text',text:'beforeafter'}]}]});e.editor.commands.setTextSelection(7);
    vi.stubGlobal('desktop',{readClipboard:async()=>({text:'  one\r\n\r\n  <two>',html:'',events:''})});
    await e.paste();expect(e.editor.state.doc.firstChild?.type.name).toBe('codeBlock');expect(e.editor.state.doc.firstChild?.textContent).toBe('before  one\n\n  <two>after');
    e.editor.commands.undo();expect(e.editor.state.doc.firstChild?.textContent).toBe('beforeafter');
  });
  it.skipIf(!hasQtHarness)('keeps text, empty lines and monospace formatting through two actual Qt saves',async()=>{
    const root=mkdtempSync(path.join(os.tmpdir(),'todoline-code-')),file=path.join(root,'roundtrip.tde'),source=path.join(root,'source.html'),store=new DocumentStore();
    const original='  const x = `a`;\n\n  中文 < &\nlast';writeFileSync(source,serializeQtHtml([{type:'blockquote',content:[{type:'paragraph',content:[{type:'text',text:'引用正文'}]}]},{type:'codeBlock',content:[{type:'text',text:original}]}]));
    const env={...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH};const qt=(mode:string)=>execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),[mode,file,source],{env,windowsHide:true});
    // Qt normalizes quote/pre/code semantics into paragraph margins and fonts.
    // Compare the surviving content and formatting, not unsupported Qt node identity.
    let handle:string|undefined;
    try{qt('create-html');for(let i=0;i<3;i++){const doc=store.open(file);handle=doc.handle;const parsed=parseQtHtml(doc.events[0].content_html);expect(parsed.readOnly).toBe(false);expect(plainText(parsed.content)).toContain('引用正文\n'+original);expect(doc.events[0].content_text).toContain(original);expect(doc.events[0].content_html).toContain('Consolas');expect(parsed.content[0].attrs?.format?.marginLeft).toBe('40px');if(i===2)break;await store.save({...doc,events:doc.events.map(e=>({...e,content_html:serializeQtHtml(parsed.content),content_text:plainText(parsed.content)}))});store.close(doc.handle);handle=undefined;qt('edit');}}finally{if(handle)store.close(handle);rmSync(root,{recursive:true,force:true});}
  });
});
