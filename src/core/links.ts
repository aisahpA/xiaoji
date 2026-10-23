import type { Nodes } from 'mdast';
import { parseMarkdown } from './markdown';

export interface LinkTarget { target: string; label: string; embed: boolean; wiki: boolean; }

/** Rewrite only actual Markdown links and wiki links; leave code and unrelated source byte-for-byte intact. */
export function rewriteLinks(body: string, resolve: (link: LinkTarget) => string | null): string {
  const replacements: { start: number; end: number; text: string }[] = [];
  const tree = parseMarkdown(body);
  const definitions = new Map<string, Extract<Nodes, { type: 'definition' }>>();
  const collect = (node: Nodes): void => {
    if (node.type === 'definition') definitions.set(node.identifier.toUpperCase(), node);
    if ('children' in node) for (const child of node.children) collect(child as Nodes);
  };
  collect(tree);
  const titled = (replacement: string, label: string, title: string | null | undefined, embed: boolean): string => {
    if (!title) return replacement;
    const wiki = /^!?\[\[([^|\]]+)(?:\|[^\]]*)?\]\]$/.exec(replacement);
    const parsed = parseMarkdown(replacement).children[0];
    const link = parsed?.type === 'paragraph' ? parsed.children[0] : undefined;
    const target = wiki?.[1] ?? (link?.type === 'link' || link?.type === 'image' ? link.url : undefined);
    if (!target) return replacement;
    return (embed ? '!' : '') + '[' + label + '](<' + target.replace(/>/g, '%3E') + '> "' + title.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '")';
  };
  const visit = (node: Nodes): void => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html' || node.type === 'definition') return;
    const start = node.position?.start.offset;
    const end = node.position?.end.offset;
    if (start === undefined || end === undefined) return;
    if (node.type === 'link' || node.type === 'image' || node.type === 'linkReference' || node.type === 'imageReference') {
      const reference = node.type === 'linkReference' || node.type === 'imageReference';
      const target = reference ? definitions.get(node.identifier.toUpperCase()) : node;
      if (!target || /^[a-z][a-z0-9+.-]*:/i.test(target.url) || target.url.startsWith('//')) return;
      const embed = node.type === 'image' || node.type === 'imageReference';
      const label = node.type === 'image' || node.type === 'imageReference' ? node.alt ?? '' : node.children.map(child => 'value' in child ? child.value : '').join('');
      const replacement = resolve({ target: target.url, label, embed, wiki: false });
      if (replacement) replacements.push({ start, end, text: titled(replacement, label, target.title, embed) });
      return;
    }
    if (node.type === 'text') {
      const source = body.slice(start, end);
      for (const match of source.matchAll(/(!?)\[\[([^\]\n]+)\]\]/g)) {
        const parts = match[2]!.split('|');
        const replacement = resolve({ target: parts[0]!, label: parts.slice(1).join('|'), embed: match[1] === '!', wiki: true });
        if (replacement) replacements.push({ start: start + match.index!, end: start + match.index! + match[0].length, text: replacement });
      }
      return;
    }
    if ('children' in node) for (const child of node.children) visit(child as Nodes);
  };
  visit(tree);
  let result = body;
  for (const replacement of replacements.sort((a, b) => b.start - a.start)) {
    result = result.slice(0, replacement.start) + replacement.text + result.slice(replacement.end);
  }
  return result;
}
