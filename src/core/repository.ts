import { sleep } from './timers';
import { TrashStore, type TrashStoreEntry } from './trash-store';
import { fileForDate, headingForDate, timestamp } from './dates';
import { appendMemo, changeFlag, features, findUnchanged, parseMarkdown, parseMemos, replaceMemo, serializeMemo } from './markdown';
import { normalizeFolder, safeSourcePath, isChatPath } from './settings';
import { MemoError, type FilePort, type Memo, type Settings } from './types';
import type { Nodes } from 'mdast';
import { FORMAT_BACKUPS, reformatText, reformatSettingsKey, type ReformatPlan } from './maintenance';

export const TRASH_FOLDER = '_回收站';
const trashRoot = (settings: Settings): string => normalizeFolder(settings.folder) + '/' + TRASH_FOLDER + '/';
const trashStorePath = (settings: Settings): string => normalizeFolder(settings.folder) + '/回收站.md';

export class Repository {
  records: Memo[] = [];
  duplicates = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private scanVersion = 0;
  private cache = new Map<string, { revision: string | number; memos: Memo[] }>();

  constructor(
    files: FilePort,
    private readonly trash: TrashStore,
    private readonly settings: () => Settings,
    private readonly clock: () => Date = () => new Date(),
  ) { this.files = files; }
  private readonly files: FilePort;

  invalidate(path: string): void {
    this.cache.delete(path);
  }

  /** Discard the in-memory trash snapshot after an external store change. */
  invalidateTrash(): void { this.trash.invalidate(); }

  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.tail.then(work, work);
    this.tail = result.catch(() => undefined);
    return result;
  }

  private async ensureFile(path: string): Promise<void> {
    if (await this.files.exists(path)) return;
    try { await this.files.create(path, ''); }
    catch (error) { if (!(await this.files.exists(path))) throw error; }
  }

  /** Recompute the duplicate-id set from the current records. */
  private recomputeDuplicates(): void {
    const ids = new Set<string>();
    this.duplicates.clear();
    for (const memo of this.records) {
      if (ids.has(memo.id)) this.duplicates.add(memo.id);
      ids.add(memo.id);
    }
  }

  async scan(onProgress?: () => void): Promise<Memo[]> {
    const version = ++this.scanVersion;
    const prefix = normalizeFolder(this.settings().folder) + '/';
    const store = trashStorePath(this.settings());
    const paths = (await this.files.listMarkdown()).filter(path => path.startsWith(prefix) && !isChatPath(path, this.settings()) && !path.startsWith(trashRoot(this.settings())) && path !== store && !path.startsWith(prefix + FORMAT_BACKUPS + '/'));
    const present = new Set(paths);
    for (const path of this.cache.keys()) if (!present.has(path)) this.cache.delete(path);
    const result: Memo[] = [];
    const BATCH = 8;
    // Yield to the main thread every 3 batches (24 files) so the UI stays responsive during a cold scan.
    const YIELD_EVERY = 3;
    let batchCount = 0;
    // Bound parallel reads instead of opening every source file simultaneously.
    for (let i = 0; i < paths.length; i += BATCH) {
      const batch = await Promise.all(paths.slice(i, i + BATCH).map(async path => {
        const revision = this.files.revision(path);
        const cached = this.cache.get(path);
        if (revision !== undefined && cached?.revision === revision) return cached.memos;
        const memos = parseMemos(await this.files.read(path), path);
        if (revision !== undefined) this.cache.set(path, { revision, memos });
        return memos;
      }));
      result.push(...batch.flat());
      if (version === this.scanVersion) {
        // Shallow copy so consumers watching the reference (e.g. view signature gate) re-render.
        this.records = result.slice();
        this.recomputeDuplicates();
        onProgress?.();
      }
      if (++batchCount % YIELD_EVERY === 0) await sleep(0);
    }
    if (version !== this.scanVersion) return this.records;
    return result;
  }

  planReformat(): Promise<ReformatPlan> {
    return this.enqueue(async () => {
      const settings = structuredClone(this.settings()), prefix = normalizeFolder(settings.folder) + '/';
      const plan: ReformatPlan = { settingsKey: reformatSettingsKey(settings), folder: settings.folder, files: [], skipped: [], unchanged: 0 };
      const paths = (await this.files.listMarkdown()).filter(path => path.startsWith(prefix) && !isChatPath(path, settings) && path.endsWith('.md') &&
        !path.startsWith(prefix + TRASH_FOLDER + '/') && path !== trashStorePath(settings) && !path.startsWith(prefix + FORMAT_BACKUPS + '/')).sort();
      const sources: { path: string; text: string; ids: string[] }[] = [], ids = new Set<string>(), duplicates = new Set<string>();
      for (const path of paths) {
        const text = await this.files.read(path), memos = parseMemos(text, path);
        for (const memo of memos) { if (ids.has(memo.id)) duplicates.add(memo.id); ids.add(memo.id); }
        sources.push({ path, text, ids: memos.map(memo => memo.id) });
      }
      for (const source of sources) {
        if (source.ids.some(id => duplicates.has(id))) { plan.skipped.push({ path: source.path, reason: 'duplicate' }); continue; }
        const result = reformatText(source.text, source.path, settings);
        if (result.reason) plan.skipped.push({ path: source.path, reason: result.reason });
        else if (result.text === source.text) plan.unchanged++;
        else plan.files.push({ path: source.path, before: source.text, after: result.text, memos: result.memos });
      }
      return plan;
    });
  }

  applyReformat(plan: ReformatPlan): Promise<{ changed: number; failed: string[]; backupFolder: string }> {
    return this.enqueue(async () => {
      const settings = structuredClone(this.settings());
      if (plan.settingsKey !== reformatSettingsKey(settings) || plan.folder !== settings.folder) throw new MemoError('reformatSettingsChanged');
      const prefix = normalizeFolder(settings.folder) + '/';
      const batch = prefix + FORMAT_BACKUPS;
      const backupPaths = new Map<string,string>();
      for (const file of plan.files) {
        const base = file.path.split('/').at(-1)!.replace(/\.md$/, '') + '_' + timestamp(this.clock()).replace(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{3})$/, '$1-$2-$3_$4$5$6-$7');
        let name = batch + '/' + base + '.md', n = 2;
        while (await this.files.exists(name) || [...backupPaths.values()].includes(name)) name = batch + '/' + base + '_' + n++ + '.md';
        backupPaths.set(file.path, name);
      }
      // Validate the entire plan before creating any backup or changing a source file.
      for (const file of plan.files) {
        if (safeSourcePath(file.path) !== file.path || !file.path.startsWith(prefix) || isChatPath(file.path, settings) || file.path.startsWith(trashRoot(settings)) || file.path.startsWith(prefix + FORMAT_BACKUPS + '/')) throw new MemoError('invalidFolder');
        const check = reformatText(file.before, file.path, settings);
        if (check.reason || check.text !== file.after || check.memos !== file.memos) throw new MemoError('conflict');
      }
      // All backups must succeed before the first write. Retain them on any later conflict/failure.
      try {
        for (const file of plan.files) await this.files.create(backupPaths.get(file.path)!, file.before);
      } catch { throw new MemoError('reformatBackupFailed'); }
      const failed: string[] = []; let changed = 0;
      for (const file of plan.files) {
        if (reformatSettingsKey(this.settings()) !== plan.settingsKey) { failed.push(file.path); continue; }
        try {
          await this.files.process(file.path, current => {
            if (current !== file.before || reformatSettingsKey(this.settings()) !== plan.settingsKey) throw new MemoError('conflict');
            return file.after;
          });
          this.invalidate(file.path); changed++;
        } catch { failed.push(file.path); }
      }
      return { changed, failed, backupFolder: plan.files.length ? batch : '' };
    });
  }

  /**
   * Backfill the scan cache after a local write so the post-write refresh does
   * not re-parse. Only `start`/`end`/`line` are recomputed from the written
   * text by locating each memo's `raw`; all other fields (body, tags, tasks,
   * ...) are reused from `memos` since the write does not change them.
   */
  private backfill(path: string, text: string, memos: Memo[]): void {
    const revision = this.files.revision(path);
    if (revision === undefined) return;
    // Memos normally appear in the file in array order, so search with a forward
    // cursor to avoid re-scanning text already covered. Fall back to a full
    // search when a memo is out of order (e.g. restored into the middle).
    const positions: number[] = new Array(memos.length).fill(-1);
    let cursor = 0;
    for (let i = 0; i < memos.length; i++) {
      const memo = memos[i]!;
      let start = text.indexOf(memo.raw, cursor);
      if (start < 0) start = text.indexOf(memo.raw);
      if (start >= 0) {
        positions[i] = start;
        cursor = start + memo.raw.length;
      }
    }
    // Sort located memos by position so line numbers come from a single forward
    // newline count instead of slicing + splitting the prefix for every memo.
    const order: number[] = [];
    for (let i = 0; i < memos.length; i++) if (positions[i]! >= 0) order.push(i);
    order.sort((a, b) => positions[a]! - positions[b]!);
    const refreshed = memos.slice();
    let line = 0;
    let prev = 0;
    for (const i of order) {
      const start = positions[i]!;
      for (let j = prev; j < start; j++) if (text.charCodeAt(j) === 10) line++;
      const memo = memos[i]!;
      refreshed[i] = { ...memo, start, end: start + memo.raw.length, line };
      prev = start;
    }
    this.cache.set(path, { revision, memos: refreshed });
  }

  /** Return the cached memos for a path if the revision still matches; otherwise parse the text. */
  private existingFor(path: string, text: string): Memo[] {
    const revision = this.files.revision(path);
    const cached = this.cache.get(path);
    if (revision !== undefined && cached?.revision === revision) return cached.memos;
    return parseMemos(text, path);
  }

  async create(body: string, prepare?: (body: string, path: string) => string): Promise<Memo> {
    if (!body.trim()) throw new MemoError('emptyMemo');
    return this.enqueue(async () => {
      const settings = this.settings();
      for (let attempt = 0; attempt < 8; attempt++) {
        const date = this.clock();
        const id = timestamp(date);
        if (this.records.some(memo => memo.id === id)) { await sleep(2); continue; }
        const path = fileForDate(date, settings);
        await this.ensureFile(path);
        let result: Memo | undefined;
        let nextText = '';
        let allMemos: Memo[] = [];
        try {
          await this.files.process(path, current => {
            const existing = this.existingFor(path, current);
            if (existing.some(memo => memo.id === id)) throw new MemoError('duplicate');
            const finalBody = prepare ? prepare(body, path) : body;
            const eol = current.includes('\r\n') ? '\r\n' : '\n';
            const raw = serializeMemo(id, finalBody, {}, eol);
            const next = appendMemo(current, raw, date.valueOf(), settings, headingForDate(date, settings), existing);
            const start = next.indexOf(raw);
            const end = start + raw.length;
            const occurrence = existing.filter(memo => memo.id === id).length;
            result = {
              id, key: path + '::' + id + '::' + occurrence, path,
              body: finalBody, raw, header: '- ' + id,
              start, end, line: next.slice(0, start).split('\n').length - 1,
              occurrence, createdAt: date.valueOf(),
              archived: false, pinned: false, blockId: null,
              ...features(finalBody),
            };
            allMemos = [...existing, result];
            nextText = next;
            return next;
          });
        } catch (error) {
          if (error instanceof MemoError && error.code === 'duplicate') { await sleep(2); continue; }
          throw error;
        }
        if (!result) throw new MemoError('writeFailed');
        this.records.push(result);
        this.backfill(path, nextText, allMemos);
        return result;
      }
      throw new MemoError('duplicate');
    });
  }

  private mutate(snapshot: Memo, transform: (current: string, existing: Memo[]) => { text: string; memo: Memo }): Promise<Memo> {
    return this.enqueue(async () => {
      let result: Memo | undefined;
      let nextText = '';
      let allMemos: Memo[] = [];
      await this.files.process(snapshot.path, current => {
        const existing = this.existingFor(snapshot.path, current);
        const { text: next, memo } = transform(current, existing);
        result = memo;
        allMemos = existing.map(memo => memo.key === snapshot.key ? result! : memo);
        nextText = next;
        return next;
      });
      if (!result) throw new MemoError('writeFailed');
      this.records = this.records.map(memo => memo.key === snapshot.key ? result! : memo);
      this.backfill(snapshot.path, nextText, allMemos);
      return result;
    });
  }

  edit(snapshot: Memo, body: string): Promise<Memo> {
    return this.mutate(snapshot, (current, existing) => replaceMemo(current, snapshot, body, existing));
  }

  setArchived(snapshot: Memo, enabled: boolean): Promise<Memo> {
    return this.mutate(snapshot, (current, existing) => changeFlag(current, snapshot, '×', enabled, existing));
  }

  setPinned(snapshot: Memo, enabled: boolean): Promise<Memo> {
    return this.mutate(snapshot, (current, existing) => changeFlag(current, snapshot, '↑', enabled, existing));
  }

  addTag(snapshot: Memo, value: string): Promise<Memo> {
    const tag = value.trim().replace(/^#/, '');
    if (features('#' + tag).tags[0] !== tag) return Promise.reject(new MemoError('invalidTag'));
    if (snapshot.tags.some(existing => existing.toLocaleLowerCase() === tag.toLocaleLowerCase())) return Promise.resolve(snapshot);
    return this.edit(snapshot, snapshot.body + '\n\n#' + tag);
  }

  toggleTask(snapshot: Memo, index: number): Promise<Memo> {
    const items: { offset: number; checked: boolean }[] = [];
    const visit = (node: Nodes): void => {
      if (node.type === 'listItem' && typeof node.checked === 'boolean' && node.position?.start.offset !== undefined) {
        items.push({ offset: node.position.start.offset, checked: node.checked });
      }
      if ('children' in node) for (const child of node.children) visit(child);
    };
    visit(parseMarkdown(snapshot.body));
    const item = items[index];
    if (!item) return Promise.reject(new MemoError('conflict'));
    const suffix = snapshot.body.slice(item.offset);
    const match = /^(?:[-*+]|\d+[.)])\s+\[([ xX])\]/.exec(suffix);
    if (!match) return Promise.reject(new MemoError('conflict'));
    const checkbox = match[0].lastIndexOf('[') + 1;
    const position = item.offset + checkbox;
    return this.edit(snapshot, snapshot.body.slice(0, position) + (item.checked ? ' ' : 'x') + snapshot.body.slice(position + 1));
  }

  delete(snapshot: Memo): Promise<TrashStoreEntry> {
    return this.enqueue(async () => {
      const text = await this.files.read(snapshot.path);
      const existing = this.existingFor(snapshot.path, text);
      findUnchanged(text, snapshot, existing);
      // Copy the memo into the trash first: cross-file operations are not atomic, so a failed
      // source removal must leave a readable backup behind.
      const entry = await this.trash.append(this.clock().toISOString(), snapshot);
      let nextText = '';
      try {
        await this.files.process(snapshot.path, current => {
          const target = findUnchanged(current, snapshot, existing);
          nextText = current.slice(0, target.start) + current.slice(target.end);
          return nextText;
        });
      } catch { throw new MemoError('deleteBackupSaved'); }
      this.records = this.records.filter(memo => memo.key !== snapshot.key);
      this.backfill(snapshot.path, nextText, existing.filter(memo => memo.key !== snapshot.key));
      return entry;
    });
  }

  async listTrash(): Promise<TrashStoreEntry[]> {
    return (await this.trash.list()).sort((a, b) => b.deletedAt.localeCompare(a.deletedAt));
  }

  purgeTrash(snapshot: TrashStoreEntry): Promise<void> {
    return this.enqueue(async () => {
      const entry = await this.trash.get(snapshot.key);
      if (!entry) throw new MemoError('invalidTrash');
      if (entry.memo.raw !== snapshot.memo.raw || entry.deletedAt !== snapshot.deletedAt) throw new MemoError('conflict');
      if (!await this.trash.remove(snapshot.key)) throw new MemoError('invalidTrash');
    });
  }

  restore(snapshot: TrashStoreEntry): Promise<Memo> {
    return this.enqueue(async () => {
      const entry = await this.trash.get(snapshot.key);
      if (!entry) throw new MemoError('invalidTrash');
      if (entry.memo.raw !== snapshot.memo.raw) throw new MemoError('conflict');
      // The original file is not persisted; derive the target from the memo's creation time
      // using the current settings so restored memos always match the active storage scheme.
      const path = fileForDate(entry.memo.createdAt, this.settings());
      await this.ensureFile(path);
      let restored: Memo | undefined;
      let nextText = '';
      let allMemos: Memo[] = [];
      await this.files.process(path, current => {
        const existing = this.existingFor(path, current);
        if (existing.some(memo => memo.id === snapshot.memo.id)) throw new MemoError('restoreDuplicate');
        const next = appendMemo(current, entry.memo.raw, snapshot.memo.createdAt, this.settings(), headingForDate(snapshot.memo.createdAt, this.settings()), existing);
        const start = next.indexOf(entry.memo.raw);
        const end = start + entry.memo.raw.length;
        const occurrence = existing.filter(memo => memo.id === snapshot.memo.id).length;
        restored = {
          ...snapshot.memo,
          path,
          key: path + '::' + snapshot.memo.id + '::' + occurrence,
          start, end,
          line: next.slice(0, start).split('\n').length - 1,
          occurrence,
        };
        allMemos = [...existing, restored].sort((a, b) => a.start - b.start);
        nextText = next;
        return next;
      });
      if (!restored) throw new MemoError('writeFailed');
      this.records.push(restored);
      this.backfill(path, nextText, allMemos);
      let removed = false;
      try { removed = await this.trash.remove(snapshot.key); } catch { throw new MemoError('restoreBackupRemains'); }
      if (!removed) throw new MemoError('restoreBackupRemains');
      return restored;
    });
  }
}
