import { describe, expect, it } from 'vitest';
import { appendMemo, changeFlag, features, parseMemos, replaceMemo, serializeMemo } from '../src/core/markdown';
import { dateFromId, fileForDate, groupKey, headingForDate, validateStorageSettings, withinWeek } from '../src/core/dates';
import { DEFAULT_SETTINGS, loadSettings, normalizeFolder, safeFileName } from '../src/core/settings';
import { compileSearch, inView, selectMemos } from '../src/core/search';
import { Repository } from '../src/core/repository';
import { TrashStore } from '../src/core/trash-store';
import type { FilePort, Memo, Settings } from '../src/core/types';

const id = '20261021110727123';
const settings = (): Settings => loadSettings(undefined);
const memo = (body: string, other: Partial<Memo> = {}): Memo =>
  ({ ...parseMemos(serializeMemo(id, body), '小记/2610小记.md')[0]!, ...other });
const ticks = String.fromCharCode(96).repeat(3);

class MemoryFiles implements FilePort {
  data = new Map<string, string>();
  failProcess: string | null = null;
  failCreate = false;
  failRemove = false;
  revision(path: string): string | number | undefined {
    const text = this.data.get(path);
    return text === undefined ? undefined : text;
  }
  async listMarkdown(): Promise<string[]> { return [...this.data.keys()].filter(path => path.endsWith('.md')); }
  async read(path: string): Promise<string> {
    if (!this.data.has(path)) throw Error('missing');
    return this.data.get(path)!;
  }
  async exists(path: string): Promise<boolean> { return this.data.has(path); }
  async create(path: string, text: string): Promise<void> {
    if (this.failCreate || this.data.has(path)) throw Error('create failed');
    this.data.set(path, text);
  }
  async process(path: string, update: (text: string) => string): Promise<void> {
    if (path === this.failProcess) throw Error('write failed');
    this.data.set(path, update(await this.read(path)));
  }
  async remove(path: string): Promise<void> {
    if (this.failRemove) throw Error('remove failed');
    this.data.delete(path);
  }
}

describe('Markdown records', () => {
  const bodies = [
    '中文与 English 🙂',
    '第一段\n\n第二段\n\n第三段',
    '- 第一项\n  - 子项\n    - 更深的子项\n- 第二项',
    '- [ ] 备课\n- [x] 阅读\n  - [ ] 子任务',
    '| 项目 | 内容 |\n| --- | --- |\n| A | 中文 |\n| B | **粗体** |',
    ticks + 'ts\nconst pattern = "- 20261021110727123";\n\nconsole.log(pattern);\n' + ticks,
    '$E=mc^2$\n\n$$\na^2+b^2=c^2\n$$',
    '![[图片.png]]\n\n[[另一个笔记#章节]]\n\n[链接](https://example.com/a#section)',
    '> 引用\n>\n> 第二段\n\n> [!note]\n> 提示',
    '# 正文一级标题\n\n### 正文三级标题\n\n---\n\n正文',
  ];
  it.each(bodies)('round-trips rich body without splitting or stripping: %s', body => {
    const parsed = parseMemos(serializeMemo(id, body), 'test.md');
    expect(parsed).toHaveLength(1);
    expect(parsed[0]!.body).toBe(body);
    expect(parsed[0]!.id).toBe(id);
  });
  it('does not parse timestamp examples inside root fences, quotes or nested lists', () => {
    const text = ticks + 'md\n- ' + id + '\n  示例\n' + ticks + '\n\n> - ' + id +
      '\n>   引用\n\n- 普通列表\n  - ' + id + '\n    子列表\n\n' + serializeMemo(id, '真的');
    expect(parseMemos(text, 'test.md').map(entry => entry.body)).toEqual(['真的']);
  });
  it('keeps duplicate identities visible with distinct keys', () => {
    const parsed = parseMemos(serializeMemo(id, '一') + '\n\n' + serializeMemo(id, '二'), 'test.md');
    expect(parsed).toHaveLength(2);
    expect(parsed[0]!.key).not.toBe(parsed[1]!.key);
    expect(() => replaceMemo(parsed.map(entry => entry.raw).join('\n\n'), parsed[0]!, '三')).toThrow('conflict');
  });
  it('preserves all unrelated source, CRLF, and unknown header metadata when archiving', () => {
    const text = '# 私人原文\r\n\r\n- ' + id + ' ^my-block custom-token\r\n  内容\r\n\r\n## 其他\r\n不要改。\r\n';
    const snapshot = parseMemos(text, 'test.md')[0]!;
    const next = changeFlag(text, snapshot, '×', true);
    expect(next).toBe(text.replace('- ' + id, '- ' + id + ' ×'));
    expect(parseMemos(next, 'test.md')[0]!.blockId).toBe('my-block');
  });
  it('preserves source outside the edited record', () => {
    const text = '# 前文\n\n' + serializeMemo(id, '旧内容') + '\n\n## 后文\n\n不要修改';
    const snapshot = parseMemos(text, 'test.md')[0]!;
    const next = replaceMemo(text, snapshot, '新内容\n\n- [ ] 新任务');
    expect(next).toBe('# 前文\n\n' + serializeMemo(id, '新内容\n\n- [ ] 新任务') + '\n\n## 后文\n\n不要修改');
  });
  it('refuses stale snapshots rather than overwriting a second editor', () => {
    const text = serializeMemo(id, '旧内容');
    const snapshot = parseMemos(text, 'test.md')[0]!;
    expect(() => replaceMemo(text.replace('旧内容', '另一台设备'), snapshot, '我的编辑')).toThrow('conflict');
  });
  it('recognizes 14 digits and rejects impossible dates', () => {
    expect(parseMemos('- 20261021110727\n  秒级\n\n- 20261321110727123\n  坏日期', 'test.md')).toHaveLength(1);
  });
  it('reads actual tags and tasks, excluding code, links, wiki headings and HTML', () => {
    const body = '#教学/反思 #阅读\n\n' + ticks + 'md\n#假标签\n- [ ] 假任务\n' + ticks +
      '\n\n[链接](https://example.com/#假)\n\n[[#章节]]\n\n' + String.fromCharCode(96) + '#行内' + String.fromCharCode(96) +
      '\n\n- [ ] 真任务\n  - [x] 完成\n\n<!-- #注释 -->';
    expect(features(body)).toEqual({ tags: ['教学/反思', '阅读'], tasks: { total: 2, incomplete: 1 } });
  });
  it('appends into an existing group and preserves surrounding sections', () => {
    const s = settings();
    const first = serializeMemo(id, '第一条');
    const source = '### 261021\n\n' + first + '\n\n### 261022\n\n保留这段。';
    const next = appendMemo(source, serializeMemo('20261021120000000', '第二条'), dateFromId(id)!, s, '### 261021');
    expect(next.indexOf('第二条')).toBeLessThan(next.indexOf('### 261022'));
    expect(next.endsWith('保留这段。')).toBe(true);
  });
});

describe('Dates and settings', () => {
  it.each([
    ['month', '小记/2610小记.md'],
    ['quarter', '小记/2026-Q4小记.md'],
    ['year', '小记/2026小记.md'],
  ] as const)('supports %s files and literal text', (period, expected) => {
    const s = settings(); s.period = period;
    expect(fileForDate(new Date(2026, 9, 21, 11), s)).toBe(expected);
  });
  it('uses H3 by default, separately from the group granularity', () => {
    const s = settings();
    expect(headingForDate(new Date(2026, 9, 21), s)).toBe('### 261021');
    s.headingLevel = 6; s.grouping = 'month';
    expect(headingForDate(new Date(2026, 9, 21), s)).toBe('###### 2026-10');
  });
  it('uses ISO week year for dates near New Year', () => {
    expect(groupKey(new Date(2027, 0, 1).valueOf(), 'week')).toBe('2026-W53');
    expect(withinWeek(new Date(2026, 9, 19).valueOf(), new Date(2026, 9, 21).valueOf())).toBe(true);
    expect(withinWeek(new Date(2026, 9, 18, 23, 59).valueOf(), new Date(2026, 9, 21).valueOf())).toBe(false);
  });
  it('detects a filename format that reuses the same name across years', () => {
    const s = settings(); s.fileFormats.month = 'MM[小记]';
    expect(() => validateStorageSettings(s)).toThrow('templateCollision');
    expect(() => validateStorageSettings(settings())).not.toThrow();
  });
  it.each(['../秘密', '/绝对路径', '.obsidian', '合法/../../其他', 'C:\\笔记', 'CON', '末尾.'])('rejects unsafe folder %s', path => {
    expect(() => normalizeFolder(path)).toThrow();
  });
  it.each(['a/b', 'a:b', 'NUL.md', '..', 'a?', ''])('rejects unsafe file %s', path => {
    expect(() => safeFileName(path)).toThrow();
  });
  it('sanitizes damaged settings without accepting hidden or duplicate navigation', () => {
    const s = loadSettings({ folder: '../bad', gap: NaN, nav: [{ id: 'all', kind: 'archive', favorite: false }, { id: 'all' }], headingLevel: 99 });
    expect(s.folder).toBe(DEFAULT_SETTINGS.folder);
    expect(s.gap).toBe(12);
    expect(s.headingLevel).toBe(6);
    expect(s.nav.filter(item => item.id === 'all')).toHaveLength(1);
    expect(s.nav.find(item => item.id === 'all')!.kind).toBe('all');
  });
});

describe('Per-memo search', () => {
  const both = memo('教学，需要更多反馈。 #教学/反思');
  it('does not combine keywords across different records in the same file', () => {
    const s = settings();
    expect(selectMemos([memo('教学'), memo('反馈'), both], s.nav[0]!, '教学 反馈', s)).toEqual([both]);
  });
  it.each([
    ['教学 反馈', true],
    ['教学 -反馈', false],
    ['不存在 OR 反馈', true],
    ['教学 (反馈 OR 不存在)', true],
    ['tag:#教学', true],
    ['#教学/反思', true],
    ['#教学/反', false],
    ['"需要更多反馈"', true],
    ['-(教学 OR 反馈)', false],
  ] as const)('evaluates %s', (query, expected) => expect(compileSearch(query)(both)).toBe(expected));
  it.each(['"未闭合', '教学 OR', '()', '(教学', '教学)', 'path:小记', '/regex/'])('reports unsupported or invalid query: %s', query => {
    expect(() => compileSearch(query)).toThrow();
  });
  it('pinning never moves old records into this week', () => {
    expect(inView(memo('旧记录', { pinned: true, createdAt: new Date(2026, 8, 1).valueOf() }), { id: 'week', kind: 'week', favorite: true }, settings(), new Date(2026, 9, 21).valueOf())).toBe(false);
  });
  it('excludes archived records except in archive or explicit custom scope', () => {
    const record = memo('内容', { archived: true });
    expect(inView(record, settings().nav[0]!, settings())).toBe(false);
    expect(inView(record, { id: 'archive', kind: 'archive', favorite: true }, settings())).toBe(true);
  });
});

describe('Safe repository operations', () => {
  const setup = async (body = '原始内容') => {
    const files = new MemoryFiles();
    const path = '小记/2610小记.md';
    files.data.set(path, '# 不相关前文\n\n' + serializeMemo(id, body) + '\n\n## 保留\n\n其他内容');
    const repo = new Repository(files, new TrashStore(files, () => settings().folder), settings, () => new Date(2026, 9, 21, 12, 30, 40, 123));
    await repo.scan();
    return { files, repo, snapshot: repo.records[0]!, path };
  };
  it('edits only the record and preserves its identity', async () => {
    const { files, repo, snapshot, path } = await setup();
    const edited = await repo.edit(snapshot, '更新后的表格\n\n| A |\n| --- |\n| B |');
    expect(edited.id).toBe(id);
    expect(await files.read(path)).toContain('## 保留\n\n其他内容');
  });
  it('leaves original untouched when backup creation fails', async () => {
    const { files, repo, snapshot, path } = await setup();
    const original = await files.read(path); files.failCreate = true;
    await expect(repo.delete(snapshot)).rejects.toThrow();
    expect(await files.read(path)).toBe(original);
  });
  it('retains both readable copies if deletion fails after backup', async () => {
    const { files, repo, snapshot, path } = await setup();
    const original = await files.read(path); files.failProcess = path;
    await expect(repo.delete(snapshot)).rejects.toThrow('deleteBackupSaved');
    expect(await files.read(path)).toBe(original);
    const trash = await repo.listTrash();
    expect(trash.entries[0]!.memo.body).toBe(snapshot.body);
    expect(trash.entries[0]!.state).toBe('backup');
  });
  it('deletes and restores rich content with original state and identity', async () => {
    const { files, repo, snapshot, path } = await setup('文字\n\n- [ ] 任务\n\n$$x^2$$');
    const pinned = await repo.setPinned(snapshot, true);
    await repo.delete(pinned);
    expect(parseMemos(await files.read(path), path)).toHaveLength(0);
    const trash = await repo.listTrash();
    expect(trash.entries).toHaveLength(1);
    const restored = await repo.restore(trash.entries[0]!);
    expect(restored.body).toBe(snapshot.body);
    expect(restored.pinned).toBe(true);
    expect(restored.id).toBe(id);
    expect((await repo.listTrash()).entries).toHaveLength(0);
  });
  it('never overwrites an existing source record on restore', async () => {
    const { files, repo, snapshot, path } = await setup();
    await repo.delete(snapshot);
    const entry = (await repo.listTrash()).entries[0]!;
    files.data.set(path, serializeMemo(id, '另外恢复的版本'));
    await expect(repo.restore(entry)).rejects.toThrow('restoreDuplicate');
    expect(await files.read(path)).toContain('另外恢复的版本');
    expect((await repo.listTrash()).entries).toHaveLength(1);
  });
  it('blocks a stale edit and keeps newer text', async () => {
    const { files, repo, snapshot, path } = await setup();
    files.data.set(path, (await files.read(path)).replace('原始内容', '手机写入'));
    await expect(repo.edit(snapshot, '电脑写入')).rejects.toThrow('conflict');
    expect(await files.read(path)).toContain('手机写入');
  });
  it('toggles nested tasks without touching code examples or surrounding Markdown', async () => {
    const { repo, snapshot } = await setup(ticks + 'md\n- [ ] 示例\n' + ticks + '\n\n- [ ] 父任务\n  - [x] 子任务');
    const edited = await repo.toggleTask(snapshot, 1);
    expect(edited.body).toContain('- [ ] 示例');
    expect(edited.body).toContain('  - [ ] 子任务');
    expect(edited.body).toContain('- [ ] 父任务');
  });
  it('ignores the recycle area in the normal index', async () => {
    const { repo, snapshot } = await setup();
    await repo.delete(snapshot); await repo.scan();
    expect(repo.records).toHaveLength(0);
  });
  it('permanently removes only a verified plugin recycle entry', async () => {
    const { files, repo, snapshot, path } = await setup();
    files.data.set('附件/shared.png', 'shared');
    await repo.delete(snapshot);
    const entry = (await repo.listTrash()).entries[0]!;
    await expect(repo.purgeTrash({ ...entry, path })).rejects.toThrow('invalidTrash');
    await repo.purgeTrash(entry);
    expect((await repo.listTrash()).entries).toHaveLength(0);
    expect(await files.read('附件/shared.png')).toBe('shared');
    expect(await files.exists(path)).toBe(true);
  });
  it('refuses to purge a recycle entry changed after it was displayed', async () => {
    const { files, repo, snapshot } = await setup();
    await repo.delete(snapshot);
    const entry = (await repo.listTrash()).entries[0]!;
    files.data.set('小记/回收站.md', (await files.read('小记/回收站.md')).replace(snapshot.body, '回收站外部修改'));
    await expect(repo.purgeTrash(entry)).rejects.toThrow(/conflict|invalidTrash/);
    expect(await files.exists('小记/回收站.md')).toBe(true);
  });
  it('retains readable recycle content when permanent removal fails', async () => {
    const { files, repo, snapshot } = await setup();
    await repo.delete(snapshot); const process = files.process.bind(files); files.process = async (p, fn) => { if (p.endsWith('/回收站.md')) throw Error('write failed'); await process(p, fn); };
    const entry = (await repo.listTrash()).entries[0]!;
    await expect(repo.purgeTrash(entry)).rejects.toThrow();
    expect((await repo.listTrash()).entries[0]!.memo.body).toBe(snapshot.body);
  });
});
