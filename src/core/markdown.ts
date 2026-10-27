import { fromMarkdown } from 'mdast-util-from-markdown';
import { gfm } from 'micromark-extension-gfm';
import { gfmFromMarkdown } from 'mdast-util-gfm';
import type { Nodes, Root } from 'mdast';
import { dateFromId, groupKey } from './dates';
import { MemoError, type Memo, type Settings } from './types';

export const parseMarkdown = (text: string): Root =>
  fromMarkdown(text, { extensions: [gfm()], mdastExtensions: [gfmFromMarkdown()] });

export function features(body: string): Pick<Memo, 'tags' | 'tasks'> {
  const tags = new Set<string>();
  const tasks = { total: 0, incomplete: 0 };
  const visit = (node: Nodes): void => {
    if (node.type === 'code' || node.type === 'inlineCode' || node.type === 'html' ||
      node.type === 'link' || node.type === 'image' || node.type === 'definition') return;
    if (node.type === 'text') {
      const text = node.value.replace(/\[\[[\s\S]*?\]\]/g, '');
      for (const match of text.matchAll(/(?:^|[\s([{])#([\p{L}\p{N}_/-]+)/gu)) {
        const tag = match[1]?.replace(/\/+$/, '');
        if (tag && /[\p{L}_/-]/u.test(tag) && !tag.includes('//')) tags.add(tag);
      }
    }
    if (node.type === 'listItem' && typeof node.checked === 'boolean') {
      tasks.total++;
      if (!node.checked) tasks.incomplete++;
    }
    if ('children' in node) for (const child of node.children) visit(child);
  };
  visit(parseMarkdown(body));
  return { tags: [...tags], tasks };
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
        body, raw, header, start, end, occurrence, line: item.position.start.line - 1,
        createdAt, archived: /(?:^|\s)×(?:\s|$)/.test(tail),
        pinned: /(?:^|\s)↑(?:\s|$)/.test(tail),
        blockId: /(?:^|\s)\^([A-Za-z0-9-]+)(?:\s|$)/.exec(tail)?.[1] ?? null,
        ...features(body),
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

export function findUnchanged(text: string, snapshot: Memo, existing?: Memo[]): Memo {
  const candidates = (existing ?? parseMemos(text, snapshot.path)).filter(memo => memo.id === snapshot.id);
  // An identical duplicated record is ambiguous too: never guess which one to edit.
  if (candidates.length !== 1 || candidates[0]?.raw !== snapshot.raw) throw new MemoError('conflict');
  return candidates[0];
}

export function replaceMemo(text: string, snapshot: Memo, body: string, existing?: Memo[]): { text: string; memo: Memo } {
  if (!body.trim()) throw new MemoError('emptyMemo');
  const current = findUnchanged(text, snapshot, existing);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  // Preserve unknown header tokens and the original identity.
  const replacement = current.header + eol + body.replace(/\r\n/g, '\n').split('\n').map(line => '  ' + line).join(eol);
  const next = text.slice(0, current.start) + replacement + text.slice(current.end);
  const memo: Memo = {
    ...snapshot,
    body,
    raw: replacement,
    header: current.header,
    start: current.start,
    end: current.start + replacement.length,
    line: next.slice(0, current.start).split('\n').length - 1,
    ...features(body),
  };
  return { text: next, memo };
}

export function changeFlag(text: string, snapshot: Memo, flag: '×' | '↑', enabled: boolean, existing?: Memo[]): { text: string; memo: Memo } {
  const current = findUnchanged(text, snapshot, existing);
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
    end: current.end + (header.length - current.header.length),
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
    return text.slice(0, last.end) + eol + eol + raw + text.slice(last.end);
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
