import { withinWeek } from './dates';
import { MemoError, type Memo, type NavItem, type Settings } from './types';

type Predicate = (memo: Memo) => boolean;
type Token = { kind: 'term' | 'or' | 'not' | 'left' | 'right'; value: string; quoted?: boolean };
const fold = (text: string): string => text.normalize('NFKC').toLocaleLowerCase();

export function matchesTag(tags: readonly string[], query: string): boolean {
  const target = fold(query.replace(/^#/, ''));
  return tags.some(tag => fold(tag) === target || fold(tag).startsWith(target + '/'));
}

function tokenize(query: string): Token[] {
  const result: Token[] = [];
  let i = 0;
  while (i < query.length) {
    const c = query[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (c === '(' || c === ')' || c === '-') {
      result.push({ kind: c === '(' ? 'left' : c === ')' ? 'right' : 'not', value: c }); i++; continue;
    }
    let value = '';
    let quoted = false;
    while (i < query.length && !/\s|[()]/.test(query[i]!)) {
      if (query[i] !== '"') { value += query[i++]; continue; }
      quoted = true;
      i++;
      let closed = false;
      while (i < query.length) {
        const character = query[i++]!;
        if (character === '"') { closed = true; break; }
        if (character === '\\' && (query[i] === '"' || query[i] === '\\')) value += query[i++];
        else value += character;
      }
      if (!closed) throw new MemoError('invalidQuery');
    }
    if (!value) throw new MemoError('invalidQuery');
    result.push({ kind: value === 'OR' && !quoted ? 'or' : 'term', value, quoted });
  }
  return result;
}

export function compileSearch(query: string): Predicate {
  if (!query.trim()) return () => true;
  const tokens = tokenize(query);
  let cursor = 0;
  const atom = (): Predicate => {
    const token = tokens[cursor++];
    if (!token) throw new MemoError('invalidQuery');
    if (token.kind === 'not') { const next = atom(); return memo => !next(memo); }
    if (token.kind === 'left') {
      const nested = or();
      if (tokens[cursor++]?.kind !== 'right') throw new MemoError('invalidQuery');
      return nested;
    }
    if (token.kind !== 'term') throw new MemoError('invalidQuery');
    const tag = token.value.startsWith('tag:') ? token.value.slice(4).replace(/^#/, '') :
      token.value.startsWith('#') ? token.value.slice(1) : null;
    if (tag !== null) {
      if (!tag || /\s/.test(tag)) throw new MemoError('invalidQuery');
      return memo => matchesTag(memo.tags, tag);
    }
    if (!token.quoted && /^[\p{L}_][\w-]*:/u.test(token.value) && !/^(?:https?|obsidian):\/\//i.test(token.value)) {
      throw new MemoError('unsupportedQuery', token.value);
    }
    if (!token.quoted && token.value.startsWith('/')) throw new MemoError('unsupportedQuery', token.value);
    const needle = fold(token.value);
    return memo => fold(memo.body).includes(needle);
  };
  const and = (): Predicate => {
    const parts = [atom()];
    while (cursor < tokens.length && tokens[cursor]?.kind !== 'or' && tokens[cursor]?.kind !== 'right') parts.push(atom());
    return memo => parts.every(test => test(memo));
  };
  const or = (): Predicate => {
    const parts = [and()];
    while (tokens[cursor]?.kind === 'or') { cursor++; parts.push(and()); }
    return memo => parts.some(test => test(memo));
  };
  const result = or();
  if (cursor !== tokens.length) throw new MemoError('invalidQuery');
  return result;
}

export function inView(memo: Memo, view: NavItem, settings: Settings, now = Date.now()): boolean {
  const kind = view.kind;
  if (kind === 'archive') {
    if (!memo.archived) return false;
  } else if (memo.archived && !view.includeArchived) return false;
  if (kind === 'pinned' && !memo.pinned) return false;
  if (kind === 'week' && !withinWeek(memo.createdAt, now)) return false;
  if (kind === 'tasks' && (settings.tasksIncludeCompleted ? memo.tasks.total === 0 : memo.tasks.incomplete === 0)) return false;
  if ((kind === 'tag' || view.tag) && !matchesTag(memo.tags, view.tag ?? '')) return false;
  return true;
}

export function selectMemos(memos: readonly Memo[], view: NavItem, query: string, settings: Settings,
  options: { all?: boolean; now?: number; includeArchived?: boolean; tags?: readonly string[] } = {}): Memo[] {
  const { all = false, now = Date.now() } = options;
  const scope = { ...view, includeArchived: options.includeArchived ?? view.includeArchived };
  const search = compileSearch(query);
  return memos.filter(memo => (all ? scope.includeArchived || !memo.archived : inView(memo, scope, settings, now)) &&
    search(memo) && (options.tags ?? []).every(tag => matchesTag(memo.tags, tag))).sort((a, b) =>
    Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || a.key.localeCompare(b.key));
}
