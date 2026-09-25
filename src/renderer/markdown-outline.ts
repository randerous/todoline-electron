import type { Node as PMNode } from '@tiptap/pm/model';
import type { MarkdownHeading } from '../shared/native-document';

export function markdownHeadings(doc: PMNode): MarkdownHeading[] {
  const headings: MarkdownHeading[] = [], counts = new Map<string, number>();
  doc.descendants((node, pos) => {
    if (node.type.name !== 'heading') return;
    const level = Math.max(1, Math.min(6, Number(node.attrs.level) || 1));
    const text = node.textContent.trim() || '未命名标题', base = `${level}:${text}`;
    const count = (counts.get(base) ?? 0) + 1; counts.set(base, count);
    headings.push({ id: `${base}:${count}`, pos, level, text });
  });
  return headings;
}

export function visibleHeadings(headings: MarkdownHeading[], collapsed: ReadonlySet<string>): MarkdownHeading[] {
  let hiddenBelow: number | undefined;
  return headings.filter(heading => {
    if (hiddenBelow !== undefined && heading.level > hiddenBelow) return false;
    hiddenBelow = collapsed.has(heading.id) ? heading.level : undefined;
    return true;
  });
}

export function activeHeading(headings: MarkdownHeading[], pos: number): string | undefined {
  let active: string | undefined;
  for (const heading of headings) { if (heading.pos > pos) break; active = heading.id; }
  return active;
}
