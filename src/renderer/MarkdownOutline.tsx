import React, { useState } from 'react';
import { ChevronDown, ChevronRight } from 'lucide-react';
import type { MarkdownHeading } from '../shared/native-document';
import { visibleHeadings } from './markdown-outline';
import './markdown-outline.css';

export function MarkdownOutline({ headings, active, onNavigate }: {
  headings: MarkdownHeading[]; active?: string; onNavigate: (pos: number) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const children = new Set(headings.filter((h, i) => headings[i + 1]?.level > h.level).map(h => h.id));
  return <nav className="markdown-outline" aria-label="目录导航">
    <div className="markdown-outline-title">目录 <span>{headings.length}</span></div>
    {!headings.length && <p className="markdown-outline-empty">添加标题后显示目录</p>}
    {visibleHeadings(headings, collapsed).map(heading => <div key={heading.id} className={'markdown-outline-row' + (active === heading.id ? ' active' : '')} style={{ paddingLeft: 8 + (heading.level - 1) * 14 }}>
      {children.has(heading.id) ? <button className="markdown-outline-toggle" aria-label={(collapsed.has(heading.id) ? '展开 ' : '折叠 ') + heading.text} aria-expanded={!collapsed.has(heading.id)} onClick={() => setCollapsed(previous => {
        const next = new Set(previous); if (next.has(heading.id)) next.delete(heading.id); else next.add(heading.id); return next;
      })}>{collapsed.has(heading.id) ? <ChevronRight size={13}/> : <ChevronDown size={13}/>}</button> : <span className="markdown-outline-toggle"/>}
      <button className="markdown-outline-heading" title={heading.text} aria-current={active === heading.id ? 'location' : undefined} onClick={() => onNavigate(heading.pos)}>{heading.text}</button>
    </div>)}
  </nav>;
}
