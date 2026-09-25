export type SearchOptions = { caseSensitive?: boolean; wholeWord?: boolean };

// A word edge for "whole word": letters, digits and the underscore. CJK text has
// no spaces, so Han characters count as letters here exactly as they do in other
// editors - a whole-word search for 事件 does not match inside 事件列表.
const EDGE = '[\\p{L}\\p{N}_]';
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** One matcher for the result list and the canvas highlight, so both agree. */
export function searchPattern(query: string, { caseSensitive, wholeWord }: SearchOptions = {}): RegExp | null {
  const needle = query.trim();
  if (!needle) return null;
  const body = escape(needle);
  const source = wholeWord ? `(?<!${EDGE})${body}(?!${EDGE})` : body;
  try { return new RegExp(source, caseSensitive ? 'gu' : 'giu'); }
  catch { return null; }
}

/** Every match in one string; the pattern's own cursor is never left behind. */
export function searchMatches(text: string, pattern: RegExp): [number, number][] {
  const found: [number, number][] = [];
  pattern.lastIndex = 0;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    found.push([match.index, match.index + match[0].length]);
    if (!match[0].length) pattern.lastIndex++;
  }
  pattern.lastIndex = 0;
  return found;
}

export function searchTest(text: string, pattern: RegExp): boolean {
  pattern.lastIndex = 0;
  const hit = pattern.test(text);
  pattern.lastIndex = 0;
  return hit;
}
