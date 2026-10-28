import type { Memo } from './types';

export interface TagNode { name: string; path: string; count: number; children: TagNode[]; }

/** Count each memo once per ancestor, including ancestors without a direct tag. */
export function tagTree(memos: readonly Memo[]): TagNode[] {
  const counts = new Map<string, Set<string>>();
  for (const memo of memos) {
    if (memo.archived) continue;
    for (const tag of memo.tags) {
      const parts = tag.split('/').filter(Boolean);
      for (let depth = 1; depth <= parts.length; depth++) {
        const path = parts.slice(0, depth).join('/');
        const entries = counts.get(path) ?? new Set<string>();
        entries.add(memo.id); counts.set(path, entries);
      }
    }
  }
  const roots: TagNode[] = [], nodes = new Map<string, TagNode>();
  for (const [path, entries] of [...counts].sort(([a], [b]) => a.localeCompare(b, 'zh-CN', { numeric: true }))) {
    const parts = path.split('/');
    const node: TagNode = { name: parts.at(-1)!, path, count: entries.size, children: [] };
    nodes.set(path, node);
    const parent = nodes.get(parts.slice(0, -1).join('/'));
    if (parent) parent.children.push(node); else roots.push(node);
  }
  return roots;
}
