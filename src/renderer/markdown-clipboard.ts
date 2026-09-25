export interface NormalizedMarkdownHtml { html: string; warnings: string[] }
const inlineTags = new Set(['span', 'strong', 'b', 'em', 'i', 's', 'del', 'code', 'a', 'br', 'sub', 'sup', 'img']);
const blockTags = new Set(['p', 'div', 'h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'blockquote', 'pre', 'ul', 'ol', 'li', 'hr', 'table', 'thead', 'tbody', 'tfoot', 'tr', 'td', 'th']);

/** File content with unknown nested elements must stay editable as raw source. */
export function isSupportedMarkdownHtml(html:string):boolean {
  const document=new DOMParser().parseFromString(html,'text/html');
  return Array.from(document.querySelectorAll('body *')).every(element=>{
    const tag=element.tagName.toLowerCase();
    return (inlineTags.has(tag)||blockTags.has(tag))&&!['sub','sup'].includes(tag);
  });
}

/** Allow portable image/link references but never active content or local file URLs. */
export function markdownUrl(value: string, image = false): string | null {
  const url = value.trim();
  if (!url || /[\u0000-\u001f\u007f]/.test(url)) return null;
  if (image && /^data:image\/(png|jpeg|gif|webp|avif);base64,[a-z\d+/=\s]+$/i.test(url)) return url;
  if (/^(https?:|mailto:)/i.test(url)) return image && /^mailto:/i.test(url) ? null : url;
  if (/^[a-z][a-z\d+.-]*:/i.test(url) || /^[\\/]{2}/.test(url)) return null;
  return url;
}

/** Convert browser clipboard HTML into bounded semantic HTML before editor parsing.
 * This is deliberately separate from TDE's Qt/internal clipboard importer. */
export function normalizeMarkdownClipboardHtml(html: string): NormalizedMarkdownHtml {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const warnings: string[] = [];
  document.querySelectorAll('script,style,iframe,object,embed,link,meta,button,nav,textarea,select,svg,[aria-hidden="true"]:not(.katex-html)').forEach(node => node.remove());

  // Work from the outer rendered formula inwards. Replacing the complete KaTeX
  // subtree prevents its HTML and accessibility MathML being pasted twice.
  for (const element of Array.from(document.querySelectorAll('.katex-display,.katex,math,[data-latex],[data-math]'))) {
    if (!document.body.contains(element)) continue;
    const annotation = element.querySelector('annotation[encoding="application/x-tex"],annotation[encoding="application/x-latex"]');
    const latex = element.getAttribute('data-latex') ?? element.getAttribute('data-math') ?? annotation?.textContent;
    const display = element.classList.contains('katex-display') || element.getAttribute('display') === 'block' || element.getAttribute('data-display') === 'true';
    if (latex?.trim()) {
      const replacement = document.createElement(display ? 'div' : 'span');
      replacement.setAttribute(display ? 'data-md-math-block' : 'data-md-math-inline', latex.trim());
      replacement.textContent = latex.trim(); element.replaceWith(replacement);
    } else {
      // Keep a single textual representation, with an explicit limitation.
      const text = element.querySelector('math')?.textContent ?? element.textContent ?? '';
      element.replaceWith(document.createTextNode(text));
      warnings.push('部分公式未携带 LaTeX 源码，已保留其文本内容。');
    }
  }

  // Code blocks often include a language label and action toolbar around <code>.
  for (const pre of Array.from(document.querySelectorAll('pre'))) {
    const code = pre.querySelector('code');
    const language = /(?:^|\s)language-([\w+-]+)/.exec(code?.className ?? pre.className)?.[1];
    const clean = document.createElement('code'); clean.textContent = code?.textContent ?? pre.textContent ?? '';
    if (language) clean.setAttribute('class', 'language-' + language);
    pre.replaceChildren(clean);
  }

  const output = document.implementation.createHTMLDocument('');
  function clean(node: globalThis.Node, parent: HTMLElement) {
    if (node.nodeType === 3) { parent.appendChild(output.createTextNode(node.textContent ?? '')); return; }
    if (node.nodeType !== 1) return;
    const element = node as HTMLElement, tag = element.tagName.toLowerCase();
    if (tag === 'input') {
      if (element.getAttribute('type') === 'checkbox' && parent.tagName === 'LI') {
        parent.setAttribute('data-task', 'true'); parent.setAttribute('data-checked', String(element.hasAttribute('checked')));
      }
      return;
    }
    if (!inlineTags.has(tag) && !blockTags.has(tag)) { for (const child of Array.from(element.childNodes)) clean(child, parent); return; }
    const target = output.createElement(tag);
    const blockMath = element.getAttribute('data-md-math-block'), inlineMath = element.getAttribute('data-md-math-inline');
    if (blockMath !== null) target.setAttribute('data-md-math-block', blockMath);
    if (inlineMath !== null) target.setAttribute('data-md-math-inline', inlineMath);
    for(const attr of ['data-md-raw-inline','data-md-raw-block']){const source=element.getAttribute(attr);if(source!==null)target.setAttribute(attr,source);}
    if(tag==='li'&&element.getAttribute('data-task')==='true'){target.setAttribute('data-task','true');target.setAttribute('data-checked',String(element.getAttribute('data-checked')==='true'));}
    if (tag === 'a') { const url = markdownUrl(element.getAttribute('href') ?? ''); if (url) target.setAttribute('href', url); }
    if (tag === 'img') {
      const url = markdownUrl(element.getAttribute('src') ?? '', true);
      if (!url) { if (element.getAttribute('alt')) parent.appendChild(output.createTextNode(element.getAttribute('alt')!)); return; }
      target.setAttribute('src', url); target.setAttribute('alt', element.getAttribute('alt') ?? '');
    }
    if (tag === 'a' || tag === 'img') { const title = element.getAttribute('title'); if (title) target.setAttribute('title', title); }
    if (tag === 'code') { const language = /^language-([\w+-]+)$/.exec(element.className); if (language) target.setAttribute('class', language[0]); }
    if (tag === 'ol') { const start = Number(element.getAttribute('start')); if (Number.isSafeInteger(start) && start > 0) target.setAttribute('start', String(start)); }
    if (tag === 'td' || tag === 'th') for (const attr of ['colspan', 'rowspan']) {
      const value = Number(element.getAttribute(attr)); if (Number.isInteger(value) && value > 1 && value <= 1000) target.setAttribute(attr, String(value));
    }
    if(tag==='td'||tag==='th'){const align=element.style.textAlign||element.getAttribute('align');if(align&&['left','center','right'].includes(align))target.setAttribute('align',align);}
    for (const child of Array.from(element.childNodes)) clean(child, target);
    parent.appendChild(target);
  }
  for (const node of Array.from(document.body.childNodes)) clean(node, output.body);
  return { html: output.body.innerHTML, warnings: [...new Set(warnings)] };
}
