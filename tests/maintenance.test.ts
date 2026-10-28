import { describe, expect, it } from 'vitest';
import { buildMigrationPrompt, reformatText } from '../src/core/maintenance';
import { headingForDate, fileForDate } from '../src/core/dates';
import { parseMemos, serializeMemo } from '../src/core/markdown';
import { Repository } from '../src/core/repository';
import { TrashStore } from '../src/core/trash-store';
import { loadSettings } from '../src/core/settings';
import type { Settings } from '../src/core/types';
import { FixtureFiles, makeFixture } from './fixture';

const ids = ['20261021120000001', '20261020120000002', '20261021110000003'] as const;
const path = '小记/2610小记.md';
const settings = (overrides: Partial<Settings> = {}): Settings => loadSettings(overrides);
const records = () => [
  serializeMemo(ids[0], '第一条\n\n#教学/反思', { archived: true, pinned: true, blockId: 'original-block' }),
  serializeMemo(ids[1], '第二条'),
  serializeMemo(ids[2], '第三条'),
];

describe('safe Markdown regrouping', () => {
  it('groups by first appearance, preserving original order within each group', () => {
    const raw = records();
    const result = reformatText(raw.join('\n\n'), path, settings({ grouping: 'day' }));
    expect(result.reason).toBeUndefined();
    expect(result.memos).toBe(3);
    expect(parseMemos(result.text, path).map(memo => memo.id)).toEqual([ids[0], ids[2], ids[1]]);
    expect(result.text.indexOf('### 261021')).toBeLessThan(result.text.indexOf('### 261020'));
    for (const memo of raw) expect(result.text).toContain(memo);
  });

  it('reformats recognized date headings and is idempotent for day, week and no grouping', () => {
    let text = '###### 261021\n\n' + records()[0] + '\n\n## 261020\n\n' + records()[1];
    for (const grouping of ['day', 'week', 'none'] as const) {
      const prefs = settings({ grouping, headingLevel: 2 });
      const result = reformatText(text, path, prefs);
      expect(result.reason).toBeUndefined();
      expect(parseMemos(result.text, path).map(memo => memo.raw)).toEqual(parseMemos(text, path).map(memo => memo.raw));
      expect(reformatText(result.text, path, prefs).text).toBe(result.text);
      if (grouping === 'none') expect(result.text).not.toMatch(/^#{1,6}\s/m);
      else expect(result.text).toContain(headingForDate(new Date(2026, 9, 21), prefs));
      text = result.text;
    }
  });

  it('recognizes a current custom format without guessing unknown historic titles', () => {
    const prefs = settings({ grouping: 'month', headingFormats: { day: 'YYYY[年]MM[月]DD[日]', week: 'GGGG-[W]WW', month: 'YYYY[年]MM[月]' } });
    const current = '## 2026年10月21日\n\n' + records()[0];
    const result = reformatText(current, path, prefs);
    expect(result.reason).toBeUndefined();
    expect(result.text).toContain('### 2026年10月');
    const unknown = '### 我的历史分区\n\n' + records()[0];
    expect(reformatText(unknown, path, prefs)).toMatchObject({ text: unknown, reason: 'content' });
  });

  it('keeps CRLF, complex bodies, original IDs and unknown header tokens byte for byte', () => {
    const ticks = String.fromCharCode(96).repeat(3);
    const body = [
      '# 正文标题', '', '- [ ] 父任务', '  - [x] 子任务', '',
      '| 列 | 内容 |', '| --- | --- |', '| A | **粗体** |', '',
      ticks + 'md', '- 20261022120000000', '  只是代码示例', ticks, '',
      '$$E=mc^2$$', '', '![[图片.png]] [[原文#章节]]', '', '> 引用', '> 第二行',
    ].join('\n');
    const raw = serializeMemo('20261021110727000', body, { archived: true, pinned: true, blockId: 'keep-me' }, '\r\n')
      .replace(' ^keep-me', ' ^keep-me custom-token');
    const source = '### 261021\r\n\r\n' + raw + '\r\n';
    const result = reformatText(source, path, settings({ grouping: 'month', headingLevel: 1 }));
    expect(result.reason).toBeUndefined();
    expect(result.text).toContain('# 2026-10\r\n');
    expect(parseMemos(result.text, path)).toHaveLength(1);
    expect(parseMemos(result.text, path)[0]).toMatchObject({ raw, body, id: '20261021110727000', archived: true, pinned: true, blockId: 'keep-me' });
  });

  it.each([
    ['frontmatter', '---\ntitle: 个人内容\n---\n\n'],
    ['paragraph', '不要修改这段前言。\n\n'],
    ['comment', '<!-- 保留注释 -->\n\n'],
    ['unknown heading', '### 自定义章节\n\n'],
    ['root code', '```md\n示例\n```\n\n'],
    ['ordinary list item', '- 普通条目\n\n'],
  ])('leaves files containing %s unchanged', (_kind, prefix) => {
    const source = prefix + records()[0];
    expect(reformatText(source, path, settings({ grouping: 'week' }))).toMatchObject({ text: source, reason: 'content' });
  });

  it('refuses an ordinary list item mixed into a valid memo list', () => {
    const source = records()[0] + '\n\n- 不属于小记的普通列表\n\n' + records()[1];
    expect(reformatText(source, path, settings())).toMatchObject({ text: source, reason: 'content' });
  });

  it('refuses duplicate identities rather than choosing between them', () => {
    const source = records()[0] + '\n\n' + serializeMemo(ids[0], '同 ID 的另一条');
    expect(reformatText(source, path, settings())).toMatchObject({ text: source, reason: 'duplicate' });
  });

  it.each(['', '\n\n', '只有普通笔记内容'])('does not manufacture records from %j', text => {
    const result = reformatText(text, path, settings());
    expect(result.text).toBe(text);
    expect(result.memos).toBe(0);
  });
});

describe('manual migration prompt', () => {
  it.each(['zh', 'en'] as const)('includes current storage examples in %s', locale => {
    const prefs = settings({ folder: '知识/灵感', period: 'year', grouping: 'month', headingLevel: 2,
      fileFormats: { month: 'YYMM[小记]', quarter: 'YYYY-[Q]Q[小记]', year: 'YYYY[灵感汇总]' },
      headingFormats: { day: 'YYMMDD', week: 'GGGG-[W]WW', month: 'YYYY[年]MM[月]' } });
    const now = new Date(2026, 9, 23, 12, 34, 56, 789);
    const prompt = buildMigrationPrompt(prefs, locale, now);
    expect(prompt).toContain('知识/灵感');
    expect(prompt).toContain(fileForDate(now, prefs).split('/').at(-1)!);
    expect(prompt).toContain(headingForDate(now, prefs));
    expect(prompt).toMatch(/- \d{17}/);
    expect(prompt).toMatch(/\n  \S/u);
    expect(prompt).toContain('×');
    expect(prompt).toContain('↑');
  });

  it('changes with settings and produces ungrouped examples when requested', () => {
    const now = new Date(2026, 9, 23, 12);
    const day = buildMigrationPrompt(settings(), 'zh', now);
    const none = buildMigrationPrompt(settings({ grouping: 'none' }), 'zh', now);
    expect(none).not.toBe(day);
    expect(none).not.toContain('### 261023');
  });
});

describe('backed-up repository maintenance', () => {
  const setup = async () => {
    const { plugin, files } = await makeFixture({ grouping: 'month' });
    const second = '小记/子目录/其他.md';
    files.data.set(second, serializeMemo('20261022120000001', '第二文件内容'));
    await plugin.repo.scan();
    return { plugin, files, second };
  };

  it('creates all exact backups before any source writes and keeps file paths and IDs', async () => {
    const { plugin, files, second } = await setup();
    const before = new Map(files.data);
    const idsBefore = plugin.repo.records.map(memo => memo.id).sort();
    const plan = await plugin.repo.planReformat();
    expect(plan.files.map(file => file.path).sort()).toEqual([path, second].sort());
    const events: string[] = [];
    const create = files.create.bind(files), process = files.process.bind(files);
    files.create = async (target, text) => { events.push('backup:' + target); await create(target, text); };
    files.process = async (target, update) => { events.push('write:' + target); await process(target, update); };
    const result = await plugin.repo.applyReformat(plan);
    expect(result.changed).toBe(2);
    expect(result.failed).toEqual([]);
    expect(events.slice(0, 2).every(event => event.startsWith('backup:'))).toBe(true);
    expect(events.slice(2).every(event => event.startsWith('write:'))).toBe(true);
    expect(result.backupFolder).toBe('小记/_格式备份');
    for (const file of plan.files) {
      const relative = [...files.data.keys()].find(p => p.startsWith(result.backupFolder + '/') && files.data.get(p) === file.before)!.slice(result.backupFolder.length + 1);
      expect(relative.includes('/')).toBe(false);
      expect(files.data.get(result.backupFolder + '/' + relative)).toBe(before.get(file.path));
      expect(files.data.get(file.path)).toBe(file.after);
    }
    await plugin.repo.scan();
    expect(plugin.repo.records.map(memo => memo.id).sort()).toEqual(idsBefore);
    expect((await plugin.repo.planReformat()).files).toEqual([]);
  });

  it('leaves every source untouched when any backup cannot be created', async () => {
    const { plugin, files } = await setup();
    const plan = await plugin.repo.planReformat();
    const create = files.create.bind(files);
    let count = 0;
    files.create = async (target, text) => { if (++count === 2) throw Error('Disk full'); await create(target, text); };
    await expect(plugin.repo.applyReformat(plan)).rejects.toThrow();
    for (const file of plan.files) expect(files.data.get(file.path)).toBe(file.before);
    expect([...files.data.keys()].filter(key => key.includes('/_格式备份/'))).toHaveLength(1);
  });

  it('retains backups and newer source content when one preview becomes stale', async () => {
    const { plugin, files, second } = await setup();
    const plan = await plugin.repo.planReformat();
    const newer = files.data.get(path)! + '\n\n设备同步的新内容';
    files.data.set(path, newer);
    const result = await plugin.repo.applyReformat(plan);
    expect(result.changed).toBe(1);
    expect(result.failed).toEqual([path]);
    expect(files.data.get(path)).toBe(newer);
    expect(files.data.get(second)).toBe(plan.files.find(file => file.path === second)!.after);
    expect([...files.data.entries()].find(([p,v])=>p.startsWith(result.backupFolder + '/') && v === plan.files.find(file=>file.path===path)!.before)?.[1]).toBe(plan.files.find(file => file.path === path)!.before);
  });

  it('reports write failures accurately and leaves their readable backups', async () => {
    const { plugin, files, second } = await setup();
    const plan = await plugin.repo.planReformat();
    const process = files.process.bind(files);
    files.process = async (target, update) => { if (target === path) throw Error('write failed'); await process(target, update); };
    const result = await plugin.repo.applyReformat(plan);
    expect(result).toMatchObject({ changed: 1, failed: [path] });
    expect(files.data.get(path)).toBe(plan.files.find(file => file.path === path)!.before);
    expect(files.data.get(second)).toBe(plan.files.find(file => file.path === second)!.after);
    expect([...files.data.entries()].find(([p,v])=>p.startsWith(result.backupFolder + '/') && v === plan.files.find(file=>file.path===path)!.before)?.[1]).toBe(plan.files.find(file => file.path === path)!.before);
  });

  it.each([{ grouping: 'week' }, { folder: '新目录' }] as Partial<Settings>[])('refuses a plan after changing storage settings %j', async update => {
    const { plugin, files } = await setup();
    const plan = await plugin.repo.planReformat();
    await plugin.updateSettings(update);
    await expect(plugin.repo.applyReformat(plan)).rejects.toThrow('reformatSettingsChanged');
    for (const file of plan.files) expect(files.data.get(file.path)).toBe(file.before);
    expect([...files.data.keys()].some(key => key.includes('/_格式备份/'))).toBe(false);
  });

  it('skips globally duplicate identities and excludes trash and backup directories', async () => {
    const files = new FixtureFiles();
    const first = serializeMemo(ids[0], '第一份');
    files.data.set(path, first);
    files.data.set('小记/重复.md', serializeMemo(ids[0], '第二份'));
    files.data.set('小记/_回收站/旧记录.md', serializeMemo('20261022110000001', '回收站记录'));
    files.data.set('小记/_格式备份/旧批次/备份.md', serializeMemo('20261022110000002', '备份不参与索引'));
    files.data.set('其他目录/原文.md', serializeMemo('20261022110000003', '目录外记录'));
    const repo = new Repository(files, new TrashStore(files, () => settings({ grouping: 'month' }).folder), () => settings({ grouping: 'month' }));
    await repo.scan();
    expect(repo.records.map(memo => memo.path).sort()).toEqual([path, '小记/重复.md'].sort());
    const plan = await repo.planReformat();
    expect(plan.files).toEqual([]);
    expect(plan.skipped.map(file => file.path).sort()).toEqual([path, '小记/重复.md'].sort());
    expect(plan.skipped.every(file => file.reason === 'duplicate')).toBe(true);
  });
});
