import { sleep } from './timers';
import { TrashFiles } from './trash-files';
import { fileForDate, headingForDate, timestamp } from './dates';
import { appendMemo, changeFlag, features, findUnchanged, parseMarkdown, parseMemos, replaceMemo, serializeMemo } from './markdown';
import { normalizeFolder, safeSourcePath, isChatPath } from './settings';
import { MemoError, type FilePort, type Memo, type Settings, type TrashEntry } from './types';
import type { Nodes } from 'mdast';
import { FORMAT_BACKUPS, reformatText, reformatSettingsKey, type ReformatPlan } from './maintenance';

export const TRASH_FOLDER = '_回收站';
const trashRoot = (settings: Settings): string => normalizeFolder(settings.folder) + '/' + TRASH_FOLDER + '/';

export function parseTrash(text: string, path: string): TrashEntry {
  const metadata = /^---\r?\nxiaoji-trash: 1\r?\nsource: (".*")\r?\ndeletedAt: (".*")\r?\nstate: (backup|deleted)\r?\n---\r?\n\r?\n/.exec(text);
  if (!metadata?.[1] || !metadata[2] || !metadata[3]) throw new MemoError('invalidTrash');
  let source: unknown;
  let deletedAt: unknown;
  try { source = JSON.parse(metadata[1]); deletedAt = JSON.parse(metadata[2]); } catch { throw new MemoError('invalidTrash'); }
  if (typeof source !== 'string' || typeof deletedAt !== 'string') throw new MemoError('invalidTrash');
  safeSourcePath(source);
  if (source.split('/').includes(TRASH_FOLDER)) throw new MemoError('invalidTrash');
  const memos = parseMemos(text.slice(metadata[0].length), source);
  if (memos.length !== 1 || !memos[0]) throw new MemoError('invalidTrash');
  return { path, source, deletedAt, state: metadata[3] as TrashEntry['state'], memo: memos[0] };
}

export class Repository {
  records: Memo[] = [];
  duplicates = new Set<string>();
  private tail: Promise<unknown> = Promise.resolve();
  private scanVersion = 0;
  private cache = new Map<string, { revision: string | number; memos: Memo[] }>();

  constructor(
    files: FilePort,
    private readonly settings: () => Settings,
    private readonly clock: () => Date = () => new Date(),
  ) { this.files = new TrashFiles(files, () => this.settings().folder); }
  private readonly files: FilePort;

  invalidate(path?: string): void {
    if (path === undefined) this.cache.clear();
    else this.cache.delete(path);
  }

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

  async scan(): Promise<Memo[]> {
    const version = ++this.scanVersion;
    const prefix = normalizeFolder(this.settings().folder) + '/';
    const paths = (await this.files.listMarkdown()).filter(path => path.startsWith(prefix) && !isChatPath(path, this.settings()) && !path.startsWith(trashRoot(this.settings())) && !path.startsWith(prefix + FORMAT_BACKUPS + '/'));
    const present = new Set(paths);
    for (const path of this.cache.keys()) if (!present.has(path)) this.cache.delete(path);
    const result: Memo[] = [];
    // Bound parallel reads instead of opening every source file simultaneously.
    for (let i = 0; i < paths.length; i += 8) {
      const batch = await Promise.all(paths.slice(i, i + 8).map(async path => {
        const revision = this.files.revision?.(path);
        const cached = this.cache.get(path);
        if (revision !== undefined && cached?.revision === revision) return cached.memos;
        const memos = parseMemos(await this.files.read(path), path);
        if (revision !== undefined) this.cache.set(path, { revision, memos });
        return memos;
      }));
      result.push(...batch.flat());
    }
    if (version === this.scanVersion) {
      this.records = result;
      const ids = new Set<string>();
      this.duplicates.clear();
      for (const memo of result) {
        if (ids.has(memo.id)) this.duplicates.add(memo.id);
        ids.add(memo.id);
      }
    }
    return result;
  }

  planReformat(): Promise<ReformatPlan> {
    return this.enqueue(async () => {
      const settings = structuredClone(this.settings()), prefix = normalizeFolder(settings.folder) + '/';
      const plan: ReformatPlan = { settingsKey: reformatSettingsKey(settings), folder: settings.folder, files: [], skipped: [], unchanged: 0 };
      const paths = (await this.files.listMarkdown()).filter(path => path.startsWith(prefix) && !isChatPath(path, settings) && path.endsWith('.md') &&
        !path.startsWith(prefix + TRASH_FOLDER + '/') && !path.startsWith(prefix + FORMAT_BACKUPS + '/')).sort();
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
        try {
          await this.files.process(path, current => {
            if (parseMemos(current, path).some(memo => memo.id === id)) throw new MemoError('duplicate');
            const raw = serializeMemo(id, prepare ? prepare(body, path) : body, {}, current.includes('\r\n') ? '\r\n' : '\n');
            const next = appendMemo(current, raw, date.valueOf(), settings, headingForDate(date, settings));
            result = parseMemos(next, path).find(memo => memo.id === id);
            if (!result) throw new MemoError('invalidMarkdown');
            return next;
          });
        } catch (error) {
          if (error instanceof MemoError && error.code === 'duplicate') { await sleep(2); continue; }
          throw error;
        }
        if (!result) throw new MemoError('writeFailed');
        this.invalidate(path);
        this.records.push(result);
        return result;
      }
      throw new MemoError('duplicate');
    });
  }

  private mutate(snapshot: Memo, transform: (current: string) => string): Promise<Memo> {
    return this.enqueue(async () => {
      let result: Memo | undefined;
      await this.files.process(snapshot.path, current => {
        const next = transform(current);
        result = parseMemos(next, snapshot.path).find(memo => memo.id === snapshot.id);
        if (!result) throw new MemoError('invalidMarkdown');
        return next;
      });
      if (!result) throw new MemoError('writeFailed');
      this.invalidate(snapshot.path);
      this.records = this.records.map(memo => memo.key === snapshot.key ? result! : memo);
      return result;
    });
  }

  edit(snapshot: Memo, body: string): Promise<Memo> {
    return this.mutate(snapshot, current => replaceMemo(current, snapshot, body));
  }

  setArchived(snapshot: Memo, enabled: boolean): Promise<Memo> {
    return this.mutate(snapshot, current => changeFlag(current, snapshot, '×', enabled));
  }

  setPinned(snapshot: Memo, enabled: boolean): Promise<Memo> {
    return this.mutate(snapshot, current => changeFlag(current, snapshot, '↑', enabled));
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

  delete(snapshot: Memo): Promise<TrashEntry> {
    return this.enqueue(async () => {
      findUnchanged(await this.files.read(snapshot.path), snapshot);
      const root = trashRoot(this.settings());
      const deletedAt = this.clock();
      let path = root + snapshot.id + '-' + timestamp(deletedAt) + '.md';
      let suffix = 1;
      while (await this.files.exists(path)) path = root + snapshot.id + '-' + timestamp(deletedAt) + '-' + suffix++ + '.md';
      const backup = '---\nxiaoji-trash: 1\nsource: ' + JSON.stringify(snapshot.path) +
        '\ndeletedAt: ' + JSON.stringify(deletedAt.toISOString()) + '\nstate: backup\n---\n\n' + snapshot.raw + '\n';
      // Copy first. Cross-file operations are not atomic; a failed move must leave a readable backup.
      await this.files.create(path, backup);
      try {
        await this.files.process(snapshot.path, current => {
          const target = findUnchanged(current, snapshot);
          return current.slice(0, target.start) + current.slice(target.end);
        });
      } catch { throw new MemoError('deleteBackupSaved'); }
      this.records = this.records.filter(memo => memo.key !== snapshot.key);
      this.invalidate(snapshot.path);
      try { await this.files.process(path, current => current.replace('\nstate: backup\n', '\nstate: deleted\n')); }
      catch { /* The readable backup remains recoverable even if its status update failed. */ }
      return parseTrash(backup, path);
    });
  }

  async listTrash(): Promise<{ entries: TrashEntry[]; damaged: string[] }> {
    const paths = (await this.files.listMarkdown()).filter(path => path.startsWith(trashRoot(this.settings())));
    const entries: TrashEntry[] = [];
    const damaged: string[] = [];
    for (const path of paths) {
      try { entries.push(parseTrash(await this.files.read(path), path)); }
      catch { damaged.push(path); }
    }
    return { entries: entries.sort((a, b) => b.deletedAt.localeCompare(a.deletedAt)), damaged };
  }

  purgeTrash(snapshot: TrashEntry): Promise<void> {
    return this.enqueue(async () => {
      if (!snapshot.path.startsWith(trashRoot(this.settings()))) throw new MemoError('invalidTrash');
      const entry = parseTrash(await this.files.read(snapshot.path), snapshot.path);
      if (entry.memo.raw !== snapshot.memo.raw || entry.source !== snapshot.source || entry.deletedAt !== snapshot.deletedAt) throw new MemoError('conflict');
      await this.files.remove(snapshot.path);
    });
  }

  restore(snapshot: TrashEntry): Promise<Memo> {
    return this.enqueue(async () => {
      const entry = parseTrash(await this.files.read(snapshot.path), snapshot.path);
      if (entry.memo.raw !== snapshot.memo.raw || entry.source !== snapshot.source) throw new MemoError('conflict');
      const path = safeSourcePath(entry.source);
      await this.ensureFile(path);
      let restored: Memo | undefined;
      await this.files.process(path, current => {
        if (parseMemos(current, path).some(memo => memo.id === entry.memo.id)) throw new MemoError('restoreDuplicate');
        const next = appendMemo(current, entry.memo.raw, entry.memo.createdAt, this.settings(), headingForDate(entry.memo.createdAt, this.settings()));
        restored = parseMemos(next, path).find(memo => memo.id === entry.memo.id);
        if (!restored) throw new MemoError('invalidMarkdown');
        return next;
      });
      if (!restored) throw new MemoError('writeFailed');
      this.invalidate(path);
      this.records.push(restored);
      try { await this.files.remove(entry.path); }
      catch { throw new MemoError('restoreBackupRemains'); }
      return restored;
    });
  }
}
