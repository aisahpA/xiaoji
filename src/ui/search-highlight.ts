import { compileSearch } from '../core/search';

/** Decorations only: never change stored Markdown or replace interactive elements. */
export function highlightSearch(root: HTMLElement, query: string): void {
  for (const mark of root.querySelectorAll('mark.xj-search-hit')) mark.replaceWith(...mark.childNodes);
  root.normalize();
  const terms: string[] = [];
  try { compileSearch(query, terms); } catch { return; }
  if (!terms.length) return;
  const doc = root.ownerDocument;
  const walker = doc.createTreeWalker(root, 4);
  const groups = new Map<Element, Text[]>();
  let current: Node | null;
  while ((current = walker.nextNode())) {
    const node = current as Text;
    if (!node.parentElement || node.parentElement.closest('script,style,svg,math,button,textarea')) continue;
    const block = node.parentElement.closest('p,li,pre,td,th,h1,h2,h3,h4,h5,h6') ?? root;
    const nodes = groups.get(block) ?? []; nodes.push(node); groups.set(block, nodes);
  }
  const needles = [...new Set(terms.map(term => term.normalize('NFKC').toLocaleLowerCase()))].filter(Boolean);
  for (const nodes of groups.values()) {
    const text = nodes.map(node => node.data).join('');
    const starts: number[] = [], ends: number[] = [];
    let normalized = '';
    // Graphemes preserve normalization offsets for ligatures, combining marks and emoji.
    const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });
    for (const part of segmenter.segment(text)) {
      const folded = part.segment.normalize('NFKC').toLocaleLowerCase();
      for (let i = 0; i < folded.length; i++) { starts.push(part.index); ends.push(part.index + part.segment.length); }
      normalized += folded;
    }
    normalized = text.normalize('NFKC').toLocaleLowerCase();
    const ranges: { start: number; end: number }[] = [];
    for (const needle of needles) {
      let cursor = 0, index: number;
      while ((index = normalized.indexOf(needle, cursor)) !== -1) {
        ranges.push({ start: starts[index]!, end: ends[index + needle.length - 1]! }); cursor = index + needle.length;
      }
    }
    ranges.sort((a, b) => a.start - b.start);
    const merged: typeof ranges = [];
    for (const range of ranges) {
      const last = merged.at(-1);
      if (last && range.start <= last.end) last.end = Math.max(last.end, range.end); else merged.push({ ...range });
    }
    let offset = 0;
    for (const node of nodes) {
      const length = node.length;
      const local = merged.filter(range => range.end > offset && range.start < offset + length);
      if (local.length) {
        const fragment = doc.win.createFragment(); let cursor = 0;
        for (const range of local) {
          const start = Math.max(0, range.start - offset), end = Math.min(length, range.end - offset);
          fragment.appendChild(doc.createTextNode(node.data.slice(cursor, start)));
          const mark = doc.win.createFragment().createEl('mark'); mark.className = 'xj-search-hit'; mark.textContent = node.data.slice(start, end);
          fragment.appendChild(mark); cursor = end;
        }
        fragment.appendChild(doc.createTextNode(node.data.slice(cursor))); node.replaceWith(fragment);
      }
      offset += length;
    }
  }
}
