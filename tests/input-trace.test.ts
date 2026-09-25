// @vitest-environment jsdom
import { beforeEach, expect, it } from 'vitest';
import { INPUT_TRACE_LIMIT, clearInputTrace, inputTraceReport, installInputTrace, traceInput } from '../src/renderer/input-trace';

beforeEach(() => { clearInputTrace(); document.body.innerHTML = ''; });

it('records key, composition and mouse events without the text that was typed', () => {
  installInputTrace();
  const el = document.createElement('div'); el.className = 'todo-document ProseMirror'; document.body.append(el);
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'q', code: 'KeyQ', bubbles: true }));
  el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Process', altKey: true, bubbles: true }));
  el.dispatchEvent(new CompositionEvent('compositionupdate', { data: '机密', bubbles: true }));
  el.dispatchEvent(new MouseEvent('mouseup', { button: 0, altKey: true, bubbles: true }));
  const report = inputTraceReport();
  expect(report).toMatch(/keydown\s+key=char code=- keyCode=- mods=-/);
  expect(report).toMatch(/keydown\s+key=Process code=\S* keyCode=\d+ mods=alt/);
  expect(report).toMatch(/compositionupdate\s+data=2ch target=div\.todo-document\.ProseMirror/);
  expect(report).toMatch(/mouseup\s+button=0 detail=0 mods=alt target=div/);
  expect(report).not.toMatch(/机密|KeyQ|key=q/);
});

it('keeps only the most recent entries', () => {
  for (let i = 0; i < INPUT_TRACE_LIMIT + 50; i++) traceInput('probe', String(i));
  const report = inputTraceReport();
  expect(report).toContain(`events: ${INPUT_TRACE_LIMIT} `);
  expect(report).not.toMatch(/probe\s+49$/m);
  expect(report).toMatch(/probe\s+50$/m);
  expect(report).toMatch(new RegExp(`probe\\s+${INPUT_TRACE_LIMIT + 49}$`, 'm'));
});
