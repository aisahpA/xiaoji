import { matchesTag } from './search';
import type { Memo } from './types';
import { MemoError } from './types';

export interface MemoQuery {
  action: 'count' | 'list' | 'answer';
  from?: string; until?: string;
  tags?: string[];
  tasks?: 'incomplete' | 'any';
  archive?: 'all' | 'active' | 'archived';
  text?: string;
  pinned?: boolean;
}
export function dayString(date: Date): string {
  return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
}
function day(value: unknown): Date {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new MemoError('invalidQuery');
  const [year, month, date] = value.split('-').map(Number) as [number, number, number];
  const result = new Date(year, month - 1, date);
  if (dayString(result) !== value || year < 1900 || year > 9999) throw new MemoError('invalidQuery');
  return result;
}
/** Only a small read-only schema is executable. No model-supplied operators or code. */
export function validateMemoQuery(value: unknown): MemoQuery {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new MemoError('invalidQuery');
  const q = value as Record<string, unknown>;
  if (Object.keys(q).some(key => !['action', 'from', 'until', 'tags', 'tasks', 'archive', 'text', 'pinned'].includes(key)) ||
    !['count', 'list', 'answer'].includes(q.action as string)) throw new MemoError('invalidQuery');
  const result: MemoQuery = { action: q.action as MemoQuery['action'] };
  if (q.from !== undefined) { day(q.from); result.from = q.from as string; }
  if (q.until !== undefined) { day(q.until); result.until = q.until as string; }
  if (result.from && result.until && result.from >= result.until) throw new MemoError('invalidQuery');
  if (q.tags !== undefined) {
    if (!Array.isArray(q.tags) || q.tags.length > 8 || q.tags.some(tag => typeof tag !== 'string' || !/^[\p{L}\p{N}_/-]{1,160}$/u.test(tag))) throw new MemoError('invalidQuery');
    result.tags = [...new Set(q.tags as string[])];
  }
  if (q.archive !== undefined) {
    if (!['all', 'active', 'archived'].includes(q.archive as string)) throw new MemoError('invalidQuery');
    result.archive = q.archive as MemoQuery['archive'];
  }
  if (q.tasks !== undefined) {
    if (!['incomplete', 'any'].includes(q.tasks as string)) throw new MemoError('invalidQuery');
    result.tasks = q.tasks as MemoQuery['tasks'];
  }
  if (q.pinned !== undefined) {
    if (typeof q.pinned !== 'boolean') throw new MemoError('invalidQuery');
    result.pinned = q.pinned;
  }
  if (q.text !== undefined) {
    if (typeof q.text !== 'string' || q.text.length > 200) throw new MemoError('invalidQuery');
    result.text = q.text.trim();
  }
  return result;
}
export function executeMemoQuery(query: MemoQuery, records: readonly Memo[], includeArchived = false): Memo[] {
  const q = validateMemoQuery(query);
  const from = q.from ? day(q.from).getTime() : -Infinity, until = q.until ? day(q.until).getTime() : Infinity;
  const archive = q.archive ?? (q.action !== 'answer' || includeArchived ? 'all' : 'active');
  const text = q.text?.toLocaleLowerCase().normalize('NFKC');
  return records.filter(memo => memo.createdAt >= from && memo.createdAt < until &&
    (archive === 'all' || memo.archived === (archive === 'archived')) &&
    (q.pinned === undefined || memo.pinned === q.pinned) &&
    (!q.tasks || (q.tasks === 'incomplete' ? memo.tasks.incomplete > 0 : memo.tasks.total > 0)) &&
    (!q.tags?.length || q.tags.every(tag => matchesTag(memo.tags, tag))) &&
    (!text || memo.body.toLocaleLowerCase().normalize('NFKC').includes(text)))
    .sort((a, b) => b.createdAt - a.createdAt || a.key.localeCompare(b.key));
}

/** Conservative offline path: unknown topic words fall through to model planning. */
export function localMemoQuery(question: string, now = new Date()): MemoQuery | null {
  if (/多少(?:个|项).*(?:待办|任务)|(?:待办|任务).*(?:多少个|多少项)|how many (?:tasks|todos)/i.test(question)) return null;
  let text = question.toLocaleLowerCase().normalize('NFKC');
  const action = /几条|多少(?:条|篇|个)|数量|总数|\bhow many\b|\bcount\b/.test(text) ? 'count' :
    /列出|找出|有哪些|有什么|\blist\b|\bshow\b/.test(text) ? 'list' : null;
  if (!action) return null;
  const query: MemoQuery = { action };
  const tags = [...question.normalize('NFKC').matchAll(/#([\p{L}\p{N}_/-]+)/gu)].map(match => match[1]!);
  if (tags.length) { query.tags = tags; text = text.replace(/#[\p{L}\p{N}_/-]+/gu, ''); }
  const ranges: [RegExp, () => [Date, Date]][] = [];
  const base = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const offset = (n: number) => new Date(base.getFullYear(), base.getMonth(), base.getDate() + n);
  const week = (n: number): [Date, Date] => { const start = n * 7 - (base.getDay() + 6) % 7; return [offset(start), offset(start + 7)]; };
  ranges.push([/今天|今日|\btoday\b/g, () => [base, offset(1)]], [/昨天|昨日|\byesterday\b/g, () => [offset(-1), base]],
    [/前天/g, () => [offset(-2), offset(-1)]], [/本周|这周|\bthis week\b/g, () => week(0)],
    [/上周|\blast week\b/g, () => week(-1)], [/本月|这个月|\bthis month\b/g, () => [new Date(base.getFullYear(), base.getMonth(), 1), new Date(base.getFullYear(), base.getMonth() + 1, 1)]],
    [/上个月|上月|\blast month\b/g, () => [new Date(base.getFullYear(), base.getMonth() - 1, 1), new Date(base.getFullYear(), base.getMonth(), 1)]],
    [/今年|本年|\bthis year\b/g, () => [new Date(base.getFullYear(), 0, 1), new Date(base.getFullYear() + 1, 0, 1)]]);
  let found = false;
  for (const [pattern, range] of ranges) if (pattern.test(text)) {
    if (found) return null; found = true;
    const [from, until] = range(); query.from = dayString(from); query.until = dayString(until);
    text = text.replace(pattern, '');
  }
  const absolute = text.match(/\b\d{4}-\d{2}-\d{2}\b/);
  if (absolute) {
    if (found) return null;
    try { const from = day(absolute[0]), until = new Date(from.getFullYear(), from.getMonth(), from.getDate() + 1); query.from = dayString(from); query.until = dayString(until); }
    catch { return null; }
    text = text.replace(absolute[0], '');
  }
  if (/未归档|非归档|\bunarchived\b/.test(text)) { query.archive = 'active'; text = text.replace(/未归档|非归档|\bunarchived\b/g, ''); }
  else if (/仅归档|已归档|只看归档|\barchived only\b/.test(text)) { query.archive = 'archived'; text = text.replace(/仅归档|已归档|只看归档|\barchived only\b/g, ''); }
  if (/未完成|待办|\bincomplete\b|\btodo\b/.test(text)) { query.tasks = 'incomplete'; text = text.replace(/未完成|待办|\bincomplete\b|\btodo\b/g, ''); }
  if (/置顶|\bpinned\b/.test(text)) { query.pinned = true; text = text.replace(/置顶|\bpinned\b/g, ''); }
  text = text.replace(/多少(?:条|篇|个)|几条|有哪些|有什么|数量|总数|列出|找出|告诉我|帮我|请问|请|我|的|了|一共|总共|共|记录|小记|笔记|记|写|创建|新增|包含|带有|标签|全部|所有|有|是|吗|呢|条|篇|\b(?:how many|count|list|show|memos?|notes?|did|i|have|written|write|created|create|recorded|record|in|on|the|all|my|please|with|are|there)\b|[\s?？。.,，!！:：]/g, '');
  return text ? null : query;
}

export function queryScope(q: MemoQuery, zh: boolean, includeArchived = false): string {
  let range = zh ? '全部日期' : 'all dates';
  if (q.from && q.until) {
    const end = day(q.until); end.setDate(end.getDate() - 1); const last = dayString(end);
    range = q.from === last ? q.from : q.from + (zh ? ' 至 ' : ' to ') + last;
  } else if (q.from) range = (zh ? '自 ' : 'from ') + q.from;
  else if (q.until) { const end = day(q.until); end.setDate(end.getDate() - 1); range = (zh ? '截至 ' : 'through ') + dayString(end); }
  const archive = q.archive ?? (q.action !== 'answer' || includeArchived ? 'all' : 'active');
  return [range, zh ? ({ all: '包含归档', active: '未归档', archived: '仅归档' })[archive] : ({ all: 'including archived', active: 'unarchived', archived: 'archived only' })[archive],
    ...(q.tags ?? []).map(tag => '#' + tag + (zh ? '（含子标签）' : ' (including subtags)')),
    q.tasks ? zh ? (q.tasks === 'incomplete' ? '含未完成待办' : '含待办') : (q.tasks === 'incomplete' ? 'with unfinished tasks' : 'with tasks') : '',
    q.pinned === undefined ? '' : zh ? (q.pinned ? '置顶' : '未置顶') : (q.pinned ? 'pinned' : 'not pinned'),
    q.text ? (zh ? '正文包含：' : 'text contains: ') + q.text : ''].filter(Boolean).join(' · ');
}
