import { createLowlight } from 'lowlight';
import type { LanguageFn } from 'highlight.js';

const highlighter = createLowlight();
const loaders: Record<string, () => Promise<{ default: LanguageFn }>> = {
  javascript: () => import('highlight.js/lib/languages/javascript'), typescript: () => import('highlight.js/lib/languages/typescript'),
  python: () => import('highlight.js/lib/languages/python'), json: () => import('highlight.js/lib/languages/json'),
  css: () => import('highlight.js/lib/languages/css'), xml: () => import('highlight.js/lib/languages/xml'),
  bash: () => import('highlight.js/lib/languages/bash'), cpp: () => import('highlight.js/lib/languages/cpp'),
  c: () => import('highlight.js/lib/languages/c'), java: () => import('highlight.js/lib/languages/java'),
  csharp: () => import('highlight.js/lib/languages/csharp'), go: () => import('highlight.js/lib/languages/go'),
  rust: () => import('highlight.js/lib/languages/rust'), sql: () => import('highlight.js/lib/languages/sql'),
  yaml: () => import('highlight.js/lib/languages/yaml'), markdown: () => import('highlight.js/lib/languages/markdown'),
  powershell: () => import('highlight.js/lib/languages/powershell'),
};
const aliases: Record<string, string> = { js: 'javascript', jsx: 'javascript', ts: 'typescript', tsx: 'typescript', py: 'python', html: 'xml', sh: 'bash', shell: 'bash', cs: 'csharp', yml: 'yaml', md: 'markdown', ps1: 'powershell' };
const loading = new Map<string, Promise<void>>();
export interface CodeToken { from: number; to: number; classes: string }
const cache = new Map<string, CodeToken[]>();
export async function highlightMarkdownCode(language: string, text: string): Promise<CodeToken[]> {
  const keyName=language.toLowerCase(),name=Object.hasOwn(aliases,keyName)?aliases[keyName]:keyName,loader=Object.hasOwn(loaders,name)?loaders[name]:undefined;
  // Unknown languages and very large blocks remain fully editable plain code.
  if (!loader || text.length > 100_000) return [];
  const key = name + '\0' + text, cached = cache.get(key); if (cached) return cached;
  if (!loading.has(name)) loading.set(name, loader().then(module => { highlighter.register(name, module.default); }).catch(error => { loading.delete(name); throw error; }));
  await loading.get(name);
  const result: CodeToken[] = []; let offset = 0;
  type Tree = { type: string; value?: string; children?: Tree[]; properties?: { className?: unknown } };
  const walk = (node: Tree, inherited: string[] = []) => {
    if (node.type === 'text') { const end = offset + (node.value?.length ?? 0); if (inherited.length && end > offset) result.push({ from: offset, to: end, classes: inherited.join(' ') }); offset = end; return; }
    const classes = Array.isArray(node.properties?.className) ? node.properties.className.filter((v): v is string => typeof v === 'string') : [];
    node.children?.forEach(child => walk(child, [...inherited, ...classes]));
  };
  walk(highlighter.highlight(name, text));
  cache.set(key, result); if (cache.size > 100) cache.delete(cache.keys().next().value!);
  return result;
}
