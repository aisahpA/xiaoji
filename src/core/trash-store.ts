import { parseMarkdown, parseMemos } from './markdown';
import { MemoError, type FilePort, type Memo } from './types';

const marker = '<!-- xiaoji-trash-store:1 -->';
const entryMarker = '<!-- xiaoji-trash-entry ';

/**
 * One deleted memo inside the aggregate trash file (小记/回收站.md).
 *
 * The body is an ordinary memo, so `memo` is exactly what the normal index would produce.
 * The original file is not stored: `restore()` derives the target from `memo.createdAt`
 * using the current settings, so restored memos always land in the currently-active scheme.
 */
export interface TrashStoreEntry {
  key: string;        // in-memory identity: <id>@<deletedAt>
  deletedAt: string;
  memo: Memo;
}

interface Meta { deletedAt: string }

function decodeMeta(value: string): Meta {
  if (!value.startsWith(entryMarker) || !value.endsWith(' -->')) throw new MemoError('invalidTrash');
  let meta: { deletedAt?: unknown };
  try { meta = JSON.parse(value.slice(entryMarker.length, -4)) as { deletedAt?: unknown }; }
  catch { throw new MemoError('invalidTrash'); }
  if (!meta || typeof meta.deletedAt !== 'string') throw new MemoError('invalidTrash');
  return { deletedAt: meta.deletedAt };
}

/**
 * Entries are delimited by Markdown structure: a metadata comment followed by exactly one
 * top-level list item, which is the memo itself. No length prefix is needed because the list
 * item already tells the parser where the body ends.
 */
function parse(text: string): TrashStoreEntry[] {
  if (!text.startsWith(marker + '\n')) throw new MemoError('invalidTrash');
  const entries: TrashStoreEntry[] = [];
  let meta: Meta | null = null;
  for (const node of parseMarkdown(text).children) {
    if (node.type === 'html') {
      if (!node.value.startsWith(entryMarker)) continue;
      if (meta) throw new MemoError('invalidTrash');
      meta = decodeMeta(node.value);
      continue;
    }
    const start = node.position?.start.offset, end = node.position?.end.offset;
    if (node.type !== 'list' || !meta || start === undefined || end === undefined) throw new MemoError('invalidTrash');
    const memos = parseMemos(text.slice(start, end), '');
    if (memos.length !== 1) throw new MemoError('invalidTrash');
    entries.push({ key: memos[0]!.id + '@' + meta.deletedAt, deletedAt: meta.deletedAt, memo: memos[0]! });
    meta = null;
  }
  if (meta) throw new MemoError('invalidTrash');
  return entries;
}

const serialize = (entries: TrashStoreEntry[]): string => marker + '\n\n' + entries.map(entry =>
  entryMarker + JSON.stringify({ deletedAt: entry.deletedAt }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e') + ' -->\n' + entry.memo.raw
).join('\n\n') + (entries.length ? '\n' : '');

/**
 * Aggregate trash storage backed by a single Markdown file (小记/回收站.md).
 *
 * Loads the store once into an in-memory snapshot and reuses it for subsequent reads; every
 * write goes through a serial queue and detects conflicts against the last known store bytes.
 */
export class TrashStore {
  private tail: Promise<unknown> = Promise.resolve();
  private loaded: string | null = null;
  private entries: TrashStoreEntry[] | null = null;

  constructor(private files: FilePort, private folder: () => string) {}

  private store(): string { return this.folder() + '/回收站.md'; }

  private queue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(fn, fn);
    this.tail = p.catch(() => undefined);
    return p;
  }

  private async load(): Promise<TrashStoreEntry[]> {
    if (this.entries !== null) return this.entries;
    this.loaded = await this.files.exists(this.store()) ? await this.files.read(this.store()) : null;
    this.entries = this.loaded === null ? [] : parse(this.loaded);
    return this.entries;
  }

  private async write(entries: TrashStoreEntry[]): Promise<void> {
    const next = serialize(entries);
    if (await this.files.exists(this.store())) {
      const before = await this.files.read(this.store());
      if (before !== this.loaded) throw new MemoError('conflict');
      parse(before);
      await this.files.process(this.store(), current => { if (current !== before) throw new MemoError('conflict'); return next; });
    } else {
      if (this.loaded !== null) throw new MemoError('conflict');
      await this.files.create(this.store(), next);
    }
    this.loaded = next;
    this.entries = entries;
  }

  /** Return all entries (cached snapshot). Callers must not mutate the result. */
  list(): Promise<TrashStoreEntry[]> {
    return this.queue(async () => [...await this.load()]);
  }

  /** Return a single entry by key, or undefined if absent. */
  get(key: string): Promise<TrashStoreEntry | undefined> {
    return this.queue(async () => (await this.load()).find(entry => entry.key === key));
  }

  /** Append one deleted memo and return its stored entry. */
  append(deletedAt: string, memo: Memo): Promise<TrashStoreEntry> {
    return this.queue(async () => {
      const entries = [...await this.load()];
      const entry: TrashStoreEntry = { key: memo.id + '@' + deletedAt, deletedAt, memo };
      entries.push(entry);
      await this.write(entries);
      return entry;
    });
  }

  /** Remove an entry by key. Returns false if not found. */
  remove(key: string): Promise<boolean> {
    return this.queue(async () => {
      const entries = await this.load();
      const next = entries.filter(entry => entry.key !== key);
      if (next.length === entries.length) return false;
      await this.write(next);
      return true;
    });
  }

  /** Discard the in-memory snapshot; the next list/get reloads from disk. */
  invalidate(): void {
    this.entries = null;
    this.loaded = null;
  }
}
