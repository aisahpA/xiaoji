import type { NavItem, Settings } from './types';
import { tagTree, type TagNode } from './tags';

export function navigation(settings: Settings): NavItem[] {
  return settings.nav.filter(item => (item.kind !== 'ask' || settings.aiEnabled) && (item.kind !== 'review' || settings.reviewEnabled));
}
export type NavSurface = 'top' | 'sidebar';
export function surfaceNavigation(settings: Settings, surface: NavSurface, includeHidden = false): NavItem[] {
  const order = surface === 'top' ? settings.topOrder : settings.sidebarOrder;
  const ranks = new Map(order.map((id, index) => [id, index]));
  return navigation(settings).filter(item => includeHidden || (surface === 'top' ? item.favorite : item.sidebarVisible !== false))
    .sort((a, b) => (ranks.get(a.id) ?? Infinity) - (ranks.get(b.id) ?? Infinity));
}
export function reorderSurface(settings: Settings, surface: NavSurface, source: string, target: string, after: boolean): Partial<Settings> {
  const field = surface === 'top' ? 'topOrder' : 'sidebarOrder';
  const ids = [...settings[field], ...settings.nav.map(item => item.id).filter(id => !settings[field].includes(id))];
  return { [field]: moveRelative(ids, source, target, after, id => id) };
}
export function moveRelative<T>(items: readonly T[], source: string, target: string, after: boolean, id: (item: T) => string): T[] {
  if (source === target || !items.some(item => id(item) === source) || !items.some(item => id(item) === target)) return [...items];
  const result = items.filter(item => id(item) !== source), item = items.find(item => id(item) === source)!;
  result.splice(result.findIndex(item => id(item) === target) + Number(after), 0, item);
  return result;
}
export function orderedTags(memos: Parameters<typeof tagTree>[0], order: readonly string[]): TagNode[] {
  const ranks = new Map(order.map((path, index) => [path, index]));
  const sort = (nodes: TagNode[]): TagNode[] => nodes.sort((a, b) => (ranks.get(a.path) ?? Infinity) - (ranks.get(b.path) ?? Infinity) || a.path.localeCompare(b.path, 'zh-CN', { numeric: true })).map(node => ({ ...node, children: sort(node.children) }));
  return sort(tagTree(memos));
}
export function tagSiblings(nodes: readonly TagNode[], path: string): string[] {
  for (const node of nodes) {
    if (node.path === path) return nodes.map(node => node.path);
    const result = tagSiblings(node.children, path); if (result.length) return result;
  }
  return [];
}
export function reorderTags(nodes: readonly TagNode[], order: readonly string[], source: string, target: string, after: boolean): string[] {
  const siblings = tagSiblings(nodes, source);
  if (!siblings.includes(target) || source === target) return [...order];
  const next = moveRelative(siblings, source, target, after, value => value);
  return [...order.filter(path => !siblings.includes(path)), ...next];
}
