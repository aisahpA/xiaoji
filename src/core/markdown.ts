import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Root } from 'mdast';
import { dateFromId, groupKey } from './dates';
import { MemoError, type Memo, type Settings } from './types';

export const parseMarkdown = (text: string): Root =>
  fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

const SKIP_TYPES = new Set(['code', 'inlineCode', 'html', 'link', 'image', 'definition']);

/**
 * Shared tag/task extraction over an AST. When `stripFirstParagraphHeader` is
 * provided, text nodes inside the first paragraph have the memo header
 * (id + flags) stripped before tag extraction — used when walking a memo's
 * listItem node directly so the timestamp doesn't pollute tags.
 */
function collectFeatures(
  root: Nodes,
  stripFirstParagraphHeader?: (text: string) => string,
): Pick<Memo, 'tags' | 'tasks'> {
  const tags = new Set<string>();
  const tasks = { total: 0, incomplete: 0 };

  const visit = (node: Nodes, inFirstParagraph: boolean): void => {
    if (SKIP_TYPES.has(node.type)) return;
    if (node.type === 'text') {
      let text = inFirstParagraph && stripFirstParagraphHeader
        ? stripFirstParagraphHeader(node.value)
        : node.value;
      text = text.replace(/\[\[[\s\S]*?\]\]/g, '');
      for (const match of text.matchAll(/(?:^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
        const tag = match[1]?.replace(/\/+$/, '');
        if (tag && /[\p{L}_/-]/u.test(tag) && !tag.includes('//')) tags.add(tag);
      }
    }
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      tasks.total++;
      if (!node.checked) tasks.incomplete++;
    }
    if ('children' in node) for (const child of node.children) visit(child, inFirstParagraph);
  };

  if (stripFirstParagraphHeader && 'children' in root) {
    let firstParagraphSeen = false;
    for (const child of root.children) {
      const isFirstParagraph = !firstParagraphSeen && child.type === 'paragraph';
      if (child.type === 'paragraph') firstParagraphSeen = true;
      visit(child, isFirstParagraph);
    }
  } else {
    visit(root, false);
  }

  return { tags: [...tags], tasks };
}

export function features(body: string): Pick<Memo, 'tags' | 'tasks'> {
  return collectFeatures(parseMarkdown(body));
}

/**
 * Extract tags/tasks directly from a memo's listItem AST node without re-parsing the body.
 * The first paragraph contains the header (id + flags), which is skipped before tag extraction.
 */
function featuresFromItem(item: Nodes): Pick<Memo, 'tags' | 'tasks'> {
  let headerConsumed = false;
  const stripHeader = (text: string): string => {
    if (headerConsumed) return text;
    const idMatch = /^(\d{17}|\d{14})/.exec(text);
    if (!idMatch) return text;
    headerConsumed = true;
    // Remove the id and any flag tokens (×, ↑, ^blockId) that immediately follow it.
    return text.slice(idMatch[0].length).replace(/^([ \t]*(?:×|↑|\^[A-Za-z0-9-]+))*[ \t]*/, '');
  };
  return collectFeatures(item, stripHeader);
}

export function parseMemos(text: string, path: string): Memo[] {
  const result: Memo[] = [];
  const occurrences = new Map<string, number>();
  for (const block of parseMarkdown(text).children) {
    if (block.type !== 'list' || block.ordered) continue;
    for (const item of block.children) {
      if (item.position?.start.column !== 1) continue;
      const start = item.position.start.offset;
      const end = item.position.end.offset;
      if (start === undefined || end === undefined) continue;
      const raw = text.slice(start, end);
      const newline = raw.indexOf('\n');
      const header = (newline < 0 ? raw : raw.slice(0, newline)).replace(/\r$/, '');
      const match = /^- (\d{17}|\d{14})(?:[ \t]+(.*))?$/.exec(header);
      if (!match?.[1]) continue;
      const createdAt = dateFromId(match[1]);
      if (createdAt === null) continue;
      const tail = match[2] ?? '';
      const body = newline < 0 ? '' : raw.slice(newline + 1).replace(/\r\n/g, '\n')
        .split('\n').map(line => line.startsWith('  ') ? line.slice(2) : line.startsWith('\t') ? line.slice(1) : line).join('\n');
      const occurrence = occurrences.get(match[1]) ?? 0;
      occurrences.set(match[1], occurrence + 1);
      result.push({
        id: match[1], key: path + '::' + match[1] + '::' + occurrence, path,
        body, raw, header, start, occurrence,
        createdAt, archived: /(?:^|\s)×(?:\s|$)/.test(tail),
        pinned: /(?:^|\s)↑(?:\s|$)/.test(tail),
        blockId: /(?:^|\s)\^([A-Za-z0-9-]+)(?:\s|$)/.exec(tail)?.[1] ?? null,
        ...featuresFromItem(item),
      });
    }
  }
  return result;
}

export function serializeMemo(id: string, body: string, flags: { archived?: boolean; pinned?: boolean; blockId?: string | null } = {}, eol = '\n'): string {
  if (dateFromId(id) === null) throw new MemoError('invalidTimestamp');
  const status = [flags.archived ? '×' : '', flags.pinned ? '↑' : '', flags.blockId ? '^' + flags.blockId : ''].filter(Boolean);
  const header = '- ' + id + (status.length ? ' ' + status.join(' ') : '');
  if (!body) return header;
  return header + eol + body.replace(/\r\n/g, '\n').split('\n').map(line => '  ' + line).join(eol);
}

export function findUnchanged(text: string, snapshot: Memo): Memo {
  // Locate the memo by its unique raw text. Cached offsets are not trusted
  // because neighbouring writes shift them; indexOf is cheap and unambiguous.
  const start = text.indexOf(snapshot.raw);
  if (start >= 0) {
    // Guard against duplicate ids: a regex header count is far cheaper than a full parse.
    const idHeader = new RegExp('^- ' + snapshot.id + '(?:[ \\t]|$)', 'gm');
    if ((text.match(idHeader) ?? []).length > 1) throw new MemoError('conflict');
    return { ...snapshot, start };
  }
  // The raw text is gone (e.g. external edit or deletion). Re-parse to decide.
  const candidates = parseMemos(text, snapshot.path).filter(memo => memo.id === snapshot.id);
  if (candidates.length !== 1 || candidates[0]?.raw !== snapshot.raw) throw new MemoError('conflict');
  return candidates[0];
}

export function replaceMemo(text: string, snapshot: Memo, body: string): { text: string; memo: Memo } {
  if (!body.trim()) throw new MemoError('emptyMemo');
  const current = findUnchanged(text, snapshot);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // Preserve unknown header tokens and the original identity.
  const replacement = current.header + eol + body.replace(/\r\n/g, '\n').split('\n').map(line => '  ' + line).join(eol);
  const next = text.slice(0, current.start) + replacement + text.slice(current.start + current.raw.length);
  const memo: Memo = {
    ...snapshot,
    body,
    raw: replacement,
    header: current.header,
    start: current.start,
    ...features(body),
  };
  return { text: next, memo };
}

export function changeFlag(text: string, snapshot: Memo, flag: '×' | '↑', enabled: boolean): { text: string; memo: Memo } {
  const current = findUnchanged(text, snapshot);
  const tokens = current.header.slice(2).split(/[ \t]+/).filter(token => token !== flag);
  if (enabled) tokens.splice(1, 0, flag);
  const header = '- ' + tokens.join(' ');
  const next = text.slice(0, current.start) + header + text.slice(current.start + current.header.length);
  const raw = header + current.raw.slice(current.header.length);
  const memo: Memo = {
    ...snapshot,
    raw,
    header,
    start: current.start,
    archived: flag === '×' ? enabled : snapshot.archived,
    pinned: flag === '↑' ? enabled : snapshot.pinned,
  };
  return { text: next, memo };
}

export function appendMemo(text: string, raw: string, time: number, settings: Settings, heading: string, existing?: Memo[]): string {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  if (settings.grouping === 'none') {
    return text + (text ? (text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol) : '') + raw + eol;
  }
  const memos = existing ?? parseMemos(text, '');
  const sameGroup = memos.filter(memo => groupKey(memo.createdAt, settings.grouping) === groupKey(time, settings.grouping));
  const last = sameGroup.at(-1);
  if (last) {
    // Locate the last group memo by its raw text; cached offsets may be stale.
    const lastEnd = text.indexOf(last.raw) + last.raw.length;
    return text.slice(0, lastEnd) + eol + eol + raw + text.slice(lastEnd);
  }
  // Reuse an existing empty heading, without matching headings inside code fences.
  const nodes = parseMarkdown(text).children;
  const headingText = heading.replace(/^#{1,6} /, '');
  const index = nodes.findIndex(node => node.type === 'heading' && node.depth === settings.headingLevel &&
    node.children.every(child => child.type === 'text') && node.children.map(child => 'value' in child ? child.value : '').join('') === headingText);
  if (index >= 0) {
    let end = text.length;
    for (let i = index + 1; i < nodes.length; i++) {
      const node = nodes[i];
      if (node?.type === 'heading' && node.depth <= settings.headingLevel) { end = node.position?.start.offset ?? end; break; }
    }
    const before = text.slice(0, end);
    return before + (before.endsWith(eol + eol) ? '' : before.endsWith(eol) ? eol : eol + eol) + raw + eol + eol + text.slice(end);
  }
  return text + (text ? (text.endsWith(eol + eol) ? '' : text.endsWith(eol) ? eol : eol + eol) : '') +
    heading + eol + eol + raw + eol;
}
