import { parseMarkdown, parseMemos } from './markdown';
import { MemoError, type FilePort } from './types';

const marker = '<!-- xiaoji-trash-store:1 -->';
const entryMarker = '<!-- xiaoji-trash-entry ';
interface Entry { name: string; source: string; deletedAt: string; state: string; raw: string; }
function decode(text: string, name: string): Entry {
  const match = /^---\r?\nxiaoji-trash: 1\r?\nsource: (".*")\r?\ndeletedAt: (".*")\r?\nstate: (backup|deleted)\r?\n---\r?\n\r?\n/.exec(text);
  if (!match) throw new MemoError('invalidTrash');
  const source: unknown = JSON.parse(match[1]!), deletedAt: unknown = JSON.parse(match[2]!);
  if (typeof source !== 'string' || typeof deletedAt !== 'string') throw new MemoError('invalidTrash');
  const memos = parseMemos(text.slice(match[0].length), source);
  if (memos.length !== 1) throw new MemoError('invalidTrash');
  return { name, source, deletedAt, state: match[3]!, raw: memos[0]!.raw };
}
const legacy = (e: Entry): string => '---\nxiaoji-trash: 1\nsource: ' + JSON.stringify(e.source) + '\ndeletedAt: ' + JSON.stringify(e.deletedAt) + '\nstate: ' + e.state + '\n---\n\n' + e.raw + '\n';
function parse(text: string): Entry[] {
  if (!text.startsWith(marker + '\n')) throw new MemoError('invalidTrash');
  const nodes = parseMarkdown(text).children.filter(n => n.type === 'html' && n.value.startsWith(entryMarker));
  const entries: Entry[] = [];
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    if (node.type !== 'html' || !node.value.endsWith(' -->')) throw new MemoError('invalidTrash');
    const metadata = JSON.parse(node.value.slice(entryMarker.length, -4)) as Entry & { length: number };
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
const serialize = (entries: Entry[]): string => marker + '\n\n' + entries.map(({raw, ...metadata}) =>
  entryMarker + JSON.stringify({ ...metadata, length: raw.length }).replace(/</g, '\\u003c').replace(/>/g, '\\u003e') + ' -->\n' + raw).join('\n\n') + (entries.length ? '\n' : '');

/** Virtual legacy entries keep recovery semantics while the vault contains one readable Markdown file. */
export class TrashFiles implements FilePort {
  private loaded: string | null = null;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(private files: FilePort, private folder: () => string) {}
  /** Forward the wrapped port's revision so Repository.scan's read cache stays effective through this wrapper. */
  revision(path: string): string | number | undefined {
    // Virtual trash entries are slices of the store file and have no per-file revision.
    return path.startsWith(this.root()) ? undefined : this.files.revision?.(path);
  }
  private root(): string { return this.folder() + '/_回收站/'; }
  private store(): string { return this.folder() + '/回收站.md'; }
  private queue<T>(fn: () => Promise<T>): Promise<T> { const p = this.tail.then(fn, fn); this.tail = p.catch(() => {}); return p; }
  private async entries(): Promise<Entry[]> { this.loaded = await this.files.exists(this.store()) ? await this.files.read(this.store()) : null; return this.loaded === null ? [] : parse(this.loaded); }
  private async write(entries: Entry[]): Promise<void> {
    const next = serialize(entries);
    if (await this.files.exists(this.store())) {
      const before = await this.files.read(this.store()); if (before !== this.loaded) throw new MemoError('conflict'); parse(before);
      await this.files.process(this.store(), current => { if (current !== before) throw new MemoError('conflict'); return next; });
    } else { if (this.loaded !== null) throw new MemoError('conflict'); await this.files.create(this.store(), next); }
    this.loaded = next;
  }
  listMarkdown(): Promise<string[]> { return this.queue(async () => {
    const paths = await this.files.listMarkdown(), entries = await this.entries();
    return [...new Set([...paths.filter(p => p !== this.store()), ...entries.map(e => this.root() + e.name)])];
  }); }
  read(path: string): Promise<string> { return path.startsWith(this.root()) ? this.queue(async () => { const e = (await this.entries()).find(e => this.root() + e.name === path); return e ? legacy(e) : this.files.read(path); }) : this.files.read(path); }
  exists(path: string): Promise<boolean> { return path.startsWith(this.root()) ? this.queue(async () => (await this.entries()).some(e => this.root() + e.name === path) || await this.files.exists(path)) : this.files.exists(path); }
  create(path: string, text: string): Promise<void> { return path.startsWith(this.root()) ? this.queue(async () => { const entries = await this.entries(); if (entries.some(e => this.root() + e.name === path)) throw new MemoError('conflict'); entries.push(decode(text, path.slice(this.root().length))); await this.write(entries); }) : this.files.create(path, text); }
  process(path: string, update: (current: string) => string): Promise<void> { return path.startsWith(this.root()) ? this.queue(async () => { const entries = await this.entries(), index = entries.findIndex(e => this.root() + e.name === path); if (index < 0) return this.files.process(path, update); entries[index] = decode(update(legacy(entries[index]!)), entries[index]!.name); await this.write(entries); }) : this.files.process(path, update); }
  remove(path: string): Promise<void> { return path.startsWith(this.root()) ? this.queue(async () => { const entries = await this.entries(), next = entries.filter(e => this.root() + e.name !== path); if (next.length === entries.length) return this.files.remove(path); await this.write(next); }) : this.files.remove(path); }
}
