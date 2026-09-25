/** Lightweight enough for TDE's paste path: the Markdown parser is loaded only
 * after this check succeeds and the tab is eligible for automatic conversion. */
export function hasMarkdownFeatures(clipboard: { text: string; html?: string }): boolean {
  const text = clipboard.text.replace(/\r\n/g, '\n');
  // Complete fences, tables and block formula delimiters are strong signals.
  if (/^ {0,3}(`{3,}|~{3,})[^\n]*\n[\s\S]*?\n {0,3}\1\s*$/m.test(text)) return true;
  if (/^\s*\|?.+\|.+\n\s*\|?\s*:?-{3,}:?\s*\|\s*:?-{3,}:?(?:\s*\|\s*:?-{3,}:?)*\s*\|?\s*$/m.test(text)) return true;
  if (/^\s*\$\$[\s\S]+?\$\$\s*$/m.test(text) || /\\\[[\s\S]+?\\\]/.test(text)) return true;
  const headings = text.match(/^ {0,3}#{1,6}\s+\S.*$/gm) ?? [];
  const hasList = /^\s*(?:[-+*]|\d+[.)])\s+\S/m.test(text);
  const hasEmphasis = /(\*\*|__)(?=\S)[^\n]*?\S\1/.test(text);
  const inlineCode=(text.match(/`[^`\n]+`/g)??[]).length;
  const emphasizedSections=(text.match(/^\s*(?:\*\*[^*\n]+\*\*|__[^_\n]+__)\s*$/gm)??[]).length;
  if(hasList&&hasEmphasis&&inlineCode>0||emphasizedSections>=2&&(inlineCode>0||hasList))return true;
  if (headings.length >= 2 || headings.length > 0 && (hasList || hasEmphasis)) return true;
  if (clipboard.html) {
    const doc = new DOMParser().parseFromString(clipboard.html, 'text/html');
    // A generic browser link, bold span or a plain list alone is not sufficient.
    if (doc.querySelector('h1,h2,h3,h4,h5,h6,table,pre,math,annotation[encoding="application/x-tex"],[data-math],[data-latex],.katex')) return true;
    if(doc.querySelector('li')&&doc.querySelector('strong,b')&&doc.querySelector('code'))return true;
    if(doc.querySelectorAll('p > strong:only-child,p > b:only-child').length>=2&&doc.querySelector('code,li'))return true;
  }
  return false;
}
