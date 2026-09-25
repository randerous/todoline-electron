import { Plugin, PluginKey } from '@tiptap/pm/state';
import { Decoration, DecorationSet } from '@tiptap/pm/view';

const key = new PluginKey<DecorationSet>('markdownCodeHighlight');
export function markdownCodeHighlight() {
  return new Plugin<DecorationSet>({
    key,
    state: { init: () => DecorationSet.empty, apply(tr, previous) { const updated = tr.getMeta(key); return updated ?? (tr.docChanged ? previous.map(tr.mapping, tr.doc) : previous); } },
    props: { decorations(state) { return key.getState(state); } },
    view(view) {
      let generation = 0, destroyed = false, timer: ReturnType<typeof setTimeout> | undefined;
      const refresh = () => {
        const current = ++generation, doc = view.state.doc, blocks: { pos: number; language: string; text: string }[] = [];
        doc.descendants((node, pos) => { if (node.type.name === 'codeBlock' && node.attrs.language) blocks.push({ pos, language: node.attrs.language, text: node.textContent }); });
        if (!blocks.length) return;
        void import('./markdown-highlight').then(async ({ highlightMarkdownCode }) => {
          const ranges = await Promise.all(blocks.map(async block => (await highlightMarkdownCode(block.language, block.text)).map(token => Decoration.inline(block.pos + 1 + token.from, block.pos + 1 + token.to, { class: token.classes }))));
          if (!destroyed && current === generation && view.state.doc === doc) view.dispatch(view.state.tr.setMeta(key, DecorationSet.create(doc, ranges.flat())));
        }).catch(() => { /* Highlighting failure never prevents editing or saving code. */ });
      };
      refresh();
      return { update(next, previous) { if (next.state.doc !== previous.doc) { generation++; clearTimeout(timer); timer = setTimeout(refresh, 80); } }, destroy() { destroyed = true; clearTimeout(timer); } };
    },
  });
}
