import { parseMarkdown, parseMemos } from './markdown';
import { MemoError, type FilePort } from './types';

const marker = '<!-- xiaoji-trash-store:1 -->';
const entryMarker = '<!-- xiaoji-trash-entry ';

/** One entry inside the aggregate trash store (小记/回收站.md). */
export interface TrashStoreEntry {
  name: string;          // <id>-<timestamp>.md
  source: string;
  deletedAt: string;
  state: 'backup' | 'deleted';
  raw: string;           // original memo markdown
}

function decode(text: string, name: string): TrashStoreEntry {
  const match = /^---\r?\nxiaoji-trash: 1\r?\nsource: (".*")\r?\ndeletedAt: (".*")\r?\nstate: (backup|deleted)\r?\n---\r?\n\r?\n/.exec(text);
  if (!match) throw new MemoError('invalidTrash');
  const source: unknown = JSON.parse(match[1]!), deletedAt: unknown = JSON.parse(match[2]!);
  if (typeof source !== 'string' || typeof deletedAt !== 'string') throw new MemoError('invalidTrash');
  const memos = parseMemos(text.slice(match[0].length), source);
  if (memos.length !== 1) throw new MemoError('invalidTrash');
  return { name, source, deletedAt, state: match[3] as 'backup' | 'deleted', raw: memos[0]!.raw };
}

const legacy = (e: TrashStoreEntry): string => '---\nxiaoji-trash: 1\nsource: ' + JSON.stringify(e.source) + '\ndeletedAt: ' + JSON.stringify(e.deletedAt) + '\nstate: ' + e.state + '\n---\n\n' + e.raw + '\n';

function parse(text: string): TrashStoreEntry[] {
  if (!text.startsWith(marker + '\n')) throw new MemoError('invalidTrash');
  const nodes = parseMarkdown(text).children.filter(n => n.type === 'html' && n.value.startsWith(entryMarker));
  const entries: TrashStoreEntry[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type !== 'html' || !node.value.endsWith(' -->')) throw new MemoError('invalidTrash');
    const metadata = JSON.parse(node.value.slice(entryMarker.length, -4)) as TrashStoreEntry & { length: number };
    if (!metadata || typeof metadata.name !== 'string' || !/^[\w-]+\.md$/.test(metadata.name) || entries.some(e => e.name === metadata.name)) throw new MemoError('invalidTrash');
    if (metadata.length !== undefined && (!Number.isSafeInteger(metadata.length) || metadata.length < 0)) throw new MemoError('invalidTrash');
    const start = node.position!.end.offset! + 1;
    const raw = metadata.length === undefined ? text.slice(start, nodes[i + 1]?.position?.start.offset ?? text.length).replace(/\n\n$|\n$/, '') : text.slice(start, start + metadata.length);
    const entry = decode(legacy({ ...metadata, raw }), metadata.name);
    if (entry.raw !== raw) throw new MemoError('invalidTrash');
    entries.push(entry);
  }
  if (serialize(entries).trim() !== text.trim() && serialize(entries).replace(/,"length":\d+/g, '').trim() !== text.trim()) throw new MemoError('invalidTrash');
  return entries;
}

const serialize = (entries: TrashStoreEntry[]): string => marker + '\n\n' + entries.map(({raw, ...metadata}) =>
  entryMarker + JSON.stringify({ ...metadata, length: raw.length }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e') + ' -->\n' + raw).join('\n\n') + (entries.length ? '\n' : '');

/**
 * Aggregate trash storage backed by a single Markdown file (小记/回收站.md).
 *
 * Loads the store once into an in-memory snapshot and reuses it for subsequent
 * reads; every write goes through a serial queue and detects conflicts against
 * the last known store bytes. The on-disk format is byte-identical to the
 * previous TrashFiles implementation.
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
    return this.queue(async () => this.load());
  }

  /** Return a single entry by name, or undefined if absent. */
  get(name: string): Promise<TrashStoreEntry | undefined> {
    return this.queue(async () => (await this.load()).find(e => e.name === name));
  }

  /** Append a new entry. Throws 'conflict' if the name already exists. */
  append(entry: TrashStoreEntry): Promise<void> {
    return this.queue(async () => {
      const entries = [...await this.load()];
      if (entries.some(e => e.name === entry.name)) throw new MemoError('conflict');
      entries.push(entry);
      await this.write(entries);
    });
  }

  /** Mutate an existing entry in place. Throws 'invalidTrash' if not found. */
  update(name: string, mutate: (entry: TrashStoreEntry) => TrashStoreEntry): Promise<void> {
    return this.queue(async () => {
      const entries = [...await this.load()];
      const index = entries.findIndex(e => e.name === name);
      if (index < 0) throw new MemoError('invalidTrash');
      entries[index] = mutate(entries[index]!);
      await this.write(entries);
    });
  }

  /** Remove an entry by name. Returns false if not found. */
  remove(name: string): Promise<boolean> {
    return this.queue(async () => {
      const entries = await this.load();
      const next = entries.filter(e => e.name !== name);
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
