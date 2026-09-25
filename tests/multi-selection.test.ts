import {expect,it} from 'vitest';
import {Schema} from '@tiptap/pm/model';
import {EditorState,Selection} from '@tiptap/pm/state';
import {history,undo} from '@tiptap/pm/history';
import {mergeTextRanges,MultiTextSelection,selectedRangesText} from '../src/renderer/multi-selection';
const schema=new Schema({nodes:{doc:{content:'paragraph+'},paragraph:{content:'text*',group:'block'},text:{group:'inline'}}});
const doc=()=>schema.node('doc',null,[schema.node('paragraph',null,schema.text('alpha keep omega'))]);
function state(){const d=doc();return EditorState.create({doc:d,selection:new MultiTextSelection(d,[{from:1,to:6},{from:12,to:17}]),plugins:[history()]});}
it('merges overlaps and orders independent text ranges',()=>{expect(mergeTextRanges([{from:8,to:10},{from:1,to:5},{from:4,to:8},{from:12,to:14},{from:4,to:4}])).toEqual([{from:1,to:10},{from:12,to:14}]);});
it('copies only selected content and preserves separation',()=>{const s=state();expect(selectedRangesText(s.doc,s.selection)).toBe('alpha\nomega');expect(s.selection.content().content.childCount).toBe(2);});
it('deletes disjoint ranges in one undoable transaction without removing the gap',()=>{let s=state();s=s.apply(s.tr.deleteSelection());expect(s.doc.textContent).toBe(' keep ');expect(undo(s,tr=>{s=s.apply(tr);})).toBe(true);expect(s.doc.textContent).toBe('alpha keep omega');expect(s.selection).toBeInstanceOf(MultiTextSelection);});
it('replaces each selected range with the same text and keeps the gap',()=>{const s=state(),tr=s.tr; s.selection.replaceWith(tr,schema.text('X'));expect(tr.doc.textContent).toBe('X keep X');});
it('maps ranges through edits and serializes bookmarks',()=>{const s=state(),tr=s.tr.insertText('new ',1);const mapped=s.selection.map(tr.doc,tr.mapping);expect(selectedRangesText(tr.doc,mapped)).toBe('alpha\nomega');expect(Selection.fromJSON(s.doc,s.selection.toJSON()).eq(s.selection)).toBe(true);expect(s.selection.getBookmark().map(tr.mapping).resolve(tr.doc).eq(mapped)).toBe(true);});
