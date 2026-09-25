import { expect, it } from 'vitest';
import { highlightMarkdownCode } from '../src/renderer/markdown-highlight';
it('loads the requested grammar and produces ranges matching the unchanged source',async()=>{
  const text='const value = "hello";\n  return 42;';const tokens=await highlightMarkdownCode('js',text);
  expect(tokens.some(token=>token.classes.includes('hljs-keyword')&&text.slice(token.from,token.to)==='const')).toBe(true);
  expect(tokens.some(token=>token.classes.includes('hljs-string')&&text.slice(token.from,token.to)==='"hello"')).toBe(true);
});
it('unknown languages and oversized blocks remain plain code',async()=>{
  expect(await highlightMarkdownCode('unknown-language','x')).toEqual([]);expect(await highlightMarkdownCode('js','x'.repeat(100001))).toEqual([]);
  expect(await highlightMarkdownCode('constructor','x')).toEqual([]);expect(await highlightMarkdownCode('__proto__','x')).toEqual([]);
});
