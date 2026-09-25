import {afterEach,describe,expect,it,vi} from 'vitest';
import {existsSync,mkdtempSync,rmSync} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
import {parseQtHtml,serializeQtHtml,plainText,markdown} from '../src/renderer/codec';

// scripts/build-qt-compat.ps1 links Qt 6.8.3 and the sibling Qt project's
// libtlcore.a, so this harness only exists on a prepared developer machine.
const qtHarness = path.resolve('.cache/qt-compat/qt-compat.exe');
const hasQtHarness = existsSync(qtHarness);

import {formatStyles} from '../src/renderer/paragraph-format';
import {DocumentStore} from '../src/main/storage';
import {TodoEditor} from '../src/renderer/editor';
import {newEvent,exportContents} from '../src/renderer/document';
let owner:TodoEditor|undefined;
afterEach(()=>{owner?.destroy();owner=undefined;document.body.innerHTML='';});
const html='<p align="center" style="margin-left:12px;margin-right:24px;margin-top:6px;margin-bottom:8px;-qt-block-indent:2;text-indent:-16px;line-height:150%">面积 x<sup>2</sup> 与 H<sub>2</sub>O</p>';
describe('editable paragraph and character formats',()=>{
  it('inherits fixed line-height units through a list but permits a percentage override',()=>{const parsed=parseQtHtml('<ol><li style="line-height:28;-qt-line-height-type:fixed">fixed<p style="line-height:150%">relative</p></li></ol>');expect(parsed.readOnly).toBe(false);const item=parsed.content[0].content![0];expect(formatStyles(item.content![0].attrs?.format,true)).toContain('line-height:28px;');expect(item.content![1].attrs?.format).toEqual({lineHeight:'150%'});expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);});
  it('normalizes logical alignment to Qt physical alignment using the paragraph direction',()=>{const parsed=parseQtHtml('<p dir="rtl" style="text-align:start">RTL start</p><p dir="rtl" style="text-align:end">RTL end</p><p style="text-align:end">LTR end</p>');expect(parsed.content.map(n=>n.attrs?.format.textAlign)).toEqual(['right','left','right']);expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);});
  it('round-trips Qt alignment, hanging indent, margins, line height and superscripts',()=>{
    const parsed=parseQtHtml(html);expect(parsed.readOnly).toBe(false);expect(parsed.content[0].attrs?.format).toMatchObject({textAlign:'center',qtIndent:2,textIndent:'-16px',marginLeft:'12px',lineHeight:'150%'});expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);expect(plainText(parsed.content)).toBe('面积 x2 与 H2O');expect(markdown(parsed.content)).toBe('面积 x<sup>2</sup> 与 H<sub>2</sub>O');
  });
  it.each(['left','center','right','justify'])('supports %s alignment with Qt and CSS attributes',align=>{expect(parseQtHtml(`<p align="${align}">正文</p>`)).toEqual(parseQtHtml(`<p style="text-align:${align}">正文</p>`));});
  it('inherits container alignment and direction, honoring explicit paragraph resets',()=>{const parsed=parseQtHtml('<div align="center" dir="rtl" style="text-indent:20px"><p>עברית</p><p align="left" dir="ltr" style="text-indent:0px">plain</p></div>');expect(parsed.readOnly).toBe(false);expect(parsed.content[0].attrs?.format).toMatchObject({textAlign:'center',direction:'rtl',textIndent:'20px'});expect(parsed.content[1].attrs?.format).toMatchObject({textAlign:'left',direction:'ltr',textIndent:'0px'});expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);});
  it('preserves list item margins once and an inner paragraph indentation reset',()=>{const parsed=parseQtHtml('<ol><li style="margin-left:10px;text-indent:5px"><p style="text-indent:0px">one</p></li></ol>');expect(parsed.readOnly).toBe(false);const item=parsed.content[0].content![0];expect(item.attrs?.format).toEqual({marginLeft:'10px',textIndent:'5px'});expect(item.content![0].attrs?.format).toEqual({textIndent:'0px'});expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);});
  it('allows baseline resets inside a superscript and retains emphasis',()=>{const parsed=parseQtHtml('<p><b><span style="vertical-align:super">up<span style="vertical-align:baseline">normal</span></span><sub>down</sub></b></p>');expect(parsed.readOnly).toBe(false);expect(parsed.content[0].content!.map(n=>n.marks?.map(m=>m.type))).toEqual([['bold','superscript'],['bold'],['bold','subscript']]);expect(parseQtHtml(serializeQtHtml(parsed.content))).toEqual(parsed);});
  it.each(['margin-left:50%','text-indent:calc(20px + 5%)','vertical-align:8px','-qt-line-height-type:minimum;line-height:24px'])('retains unsupported geometry read-only: %s',style=>{expect(parseQtHtml(`<p style="${style}">保留</p>`).readOnly).toBe(true);});
  it('sanitizes paragraph JSON without inserting untrusted CSS into exports',()=>{expect(formatStyles({textAlign:'center;position:fixed',marginLeft:'10px; background:url(x)',qtIndent:-1,direction:'rtl'},true)).toBe('direction:rtl;');});
  it('renders Qt indentation for Chromium and PDF without changing file semantics',()=>{const parsed=parseQtHtml(html);expect(serializeQtHtml(parsed.content)).toContain('-qt-block-indent:2;');expect(serializeQtHtml(parsed.content,true)).toContain('margin-left:calc(12px + 80px);');const pdf=exportContents([{...newEvent(),content_html:html}], 'pdf','test');expect(pdf).toContain('margin-left:calc(12px + 80px);');expect(pdf).toContain('<sup>2</sup>');});
  it('creates editable editor nodes and keeps imported layout after a text transaction',()=>{const el=document.createElement('div');document.body.append(el);owner=new TodoEditor(el,{handle:'test',name:'format.tde',path:'format.tde',revision:0,events:[{...newEvent(),id:1,content_html:html}]},{change:vi.fn(),selection:vi.fn(),error:vi.fn(),asset:vi.fn()});expect(owner.editor.state.doc.firstChild!.type.name).toBe('paragraph');owner.editor.view.dispatch(owner.editor.state.tr.insertText('新',1));expect(owner.records()[0].content_html).toContain('align="center"');expect(owner.records()[0].content_html).toContain('<sup>2</sup>');expect((el.querySelector('p') as HTMLElement).style.marginLeft).toBe('calc(92px)');});
  it.skipIf(!hasQtHarness)('sizes selected text in the unit Qt applies and hands it back on request',async()=>{
    const el=document.createElement('div');document.body.append(el);
    owner=new TodoEditor(el,{handle:'size',name:'size.tde',path:'size.tde',revision:0,events:[{...newEvent(),id:1,content_html:'<p>放大文字</p>',content_text:'放大文字'}]},{change:vi.fn(),selection:vi.fn(),error:vi.fn(),asset:vi.fn()});
    owner.editor.view.dom.style.fontSize='15px';
    owner.editor.commands.selectAll();
    owner.changeFontSize(2);
    const sized=owner.records()[0].content_html;
    expect(sized).toContain('font-size:12.75pt');
    const root=mkdtempSync(path.join(os.tmpdir(),'todoline-size-')),file=path.join(root,'size.tde'),store=new DocumentStore();
    const env={...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\\\Qt\\\\6.8.3\\\\mingw_64\\\\bin;E:\\\\Qt\\\\Tools\\\\mingw1310_64\\\\bin;'+process.env.PATH};
    try{
      const doc=store.open(file,true);
      await store.save({handle:doc.handle,revision:doc.revision,events:[{...newEvent(),id:-1,content_html:sized,content_text:'放大文字'}]});
      store.close(doc.handle);
      // Qt reports the point size only when it actually applied the run format.
      const runs=JSON.parse(execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),['inspect-format',file],{env,windowsHide:true,encoding:'utf8'}))[0].runs;
      expect(runs[0]).toMatchObject({text:'放大文字',fontSize:12.75});
    }finally{rmSync(root,{recursive:true,force:true});}
    owner.changeFontSize(null,'document');
    expect(owner.records()[0].content_html).not.toContain('font-size');
  },60000);
  it.skipIf(!hasQtHarness)('preserves actual Qt block properties and run positions after two file round-trips',async()=>{
    const root=mkdtempSync(path.join(os.tmpdir(),'todoline-format-')),file=path.join(root,'roundtrip.tde'),store=new DocumentStore();
    const env={...process.env,QT_QPA_PLATFORM:'offscreen',PATH:'E:\\Qt\\6.8.3\\mingw_64\\bin;E:\\Qt\\Tools\\mingw1310_64\\bin;'+process.env.PATH};
    const qt=(mode:string)=>execFileSync(path.resolve('.cache/qt-compat/qt-compat.exe'),[mode,file],{env,windowsHide:true,encoding:'utf8'});
    try{qt('create-format');const before=JSON.parse(qt('inspect-format'));for(let i=0;i<2;i++){const doc=store.open(file);const parsed=parseQtHtml(doc.events[0].content_html);expect(parsed.readOnly).toBe(false);await store.save({...doc,events:doc.events.map(e=>({...e,content_html:serializeQtHtml(parsed.content)}))});store.close(doc.handle);const after=JSON.parse(qt('inspect-format'));expect(after.slice(0,before.length)).toEqual(before);qt('edit');}
    }finally{rmSync(root,{recursive:true,force:true});}
  });
});
