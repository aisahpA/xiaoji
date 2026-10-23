// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { XiaojiSettings } from '../src/ui/settings';
import { ReformatModal } from '../src/ui/maintenance';
import { TrashPanel } from '../src/ui/trash';
import type { Settings } from '../src/core/types';
import { makeFixture } from './fixture';
import { Menu } from './obsidian-mock';

const cleanups: (() => void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) cleanup();
  await Promise.resolve(); vi.restoreAllMocks(); document.body.replaceChildren();
});
const settingTab = async (overrides: Partial<Settings> = {}) => {
  const fixture = await makeFixture(overrides), tab = new XiaojiSettings(fixture.plugin.app, fixture.plugin);
  cleanups.push(() => tab.hide()); document.body.append(tab.containerEl); tab.display();
  const row = (name: string) => [...tab.containerEl.querySelectorAll<HTMLElement>('.setting-item')]
    .find(item => item.querySelector('.setting-item-name')?.textContent === name)!;
  return { ...fixture, tab, row };
};
const changeInput = (input: HTMLInputElement, value: string): void => {
  input.value = value; input.dispatchEvent(new Event('input'));
};

describe('storage maintenance actions', () => {
  it('copies a prompt with the latest pending storage edits without enabling AI or reading notes', async () => {
    const { plugin, files, tab, row, errors } = await settingTab({ aiEnabled: false });
    const copy = vi.spyOn(plugin, 'clipboard'), read = vi.spyOn(files, 'read');
    const plan = vi.spyOn(plugin.repo, 'planReformat');
    changeInput(row('文件名格式').querySelector('input')!, 'YYMM[迁移]');
    row('迁入旧笔记').querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(copy).toHaveBeenCalledTimes(1));
    const prompt = copy.mock.calls[0]![0];
    expect(plugin.prefs.aiEnabled).toBe(false);
    expect(plugin.prefs.fileFormats.month).toBe('YYMM[迁移]');
    expect(prompt).toContain('"filenameFormat": "YYMM[迁移]"');
    expect(copy.mock.calls[0]![1]).toBe(document);
    expect(tab.containerEl.querySelector('textarea')).toBeNull();
    expect(tab.containerEl.textContent).not.toContain('YYYYMMDDHHmmssSSS');
    expect(read).not.toHaveBeenCalled(); expect(plan).not.toHaveBeenCalled(); expect(errors).toEqual([]);
  });

  it('does not export a misleading prompt when a pending storage setting is invalid', async () => {
    const { plugin, row, errors } = await settingTab(); const copy = vi.spyOn(plugin, 'clipboard');
    const folder = row('小记目录').querySelector('input')!;
    changeInput(folder, '../无效目录');
    row('迁入旧笔记').querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(folder.getAttribute('aria-invalid')).toBe('true'));
    expect(copy).not.toHaveBeenCalled(); expect(plugin.prefs.folder).toBe('小记'); expect(errors).toEqual([]);
  });

  it('opens a read-only format preview and leaves source files untouched when canceled', async () => {
    const { plugin, files, row } = await settingTab(); const before = [...files.data.entries()];
    const plan = vi.spyOn(plugin.repo, 'planReformat'), apply = vi.spyOn(plugin.repo, 'applyReformat');
    row('整理已有小记').querySelector<HTMLButtonElement>('button')!.click();
    await vi.waitFor(() => expect(document.querySelector('.xj-reformat-files')).not.toBeNull());
    expect(plan).toHaveBeenCalledTimes(1); expect(apply).not.toHaveBeenCalled();
    expect([...files.data.entries()]).toEqual(before);
    document.querySelector<HTMLButtonElement>('.xj-reformat-modal button[aria-label="取消"]')!.click();
    expect(document.querySelector('.xj-reformat-modal')).toBeNull();
    expect(apply).not.toHaveBeenCalled(); expect([...files.data.entries()]).toEqual(before);
  });

  it('applies only on explicit confirmation, ignores repeated clicks, then refreshes the index', async () => {
    const { plugin, errors } = await makeFixture();
    const plan = await plugin.repo.planReformat(); expect(plan.files.length).toBeGreaterThan(0);
    vi.spyOn(plugin.repo, 'planReformat').mockResolvedValue(plan);
    let finish!: (result: { changed: number; failed: string[]; backupFolder: string }) => void;
    const apply = vi.spyOn(plugin.repo, 'applyReformat').mockImplementation(() => new Promise(resolve => { finish = resolve; }));
    const refresh = vi.spyOn(plugin, 'refresh').mockResolvedValue(undefined);
    const modal = new ReformatModal(plugin); cleanups.push(() => modal.close()); modal.open();
    await vi.waitFor(() => expect(modal.contentEl.querySelector('button.mod-cta')).not.toBeNull());
    expect(apply).not.toHaveBeenCalled(); expect(refresh).not.toHaveBeenCalled();
    const confirm = modal.contentEl.querySelector<HTMLButtonElement>('button.mod-cta')!;
    confirm.click(); confirm.click(); expect(apply).toHaveBeenCalledOnce(); expect(apply).toHaveBeenCalledWith(plan);
    expect(confirm.disabled).toBe(true); expect(refresh).not.toHaveBeenCalled();
    finish({ changed: 1, failed: [], backupFolder: '小记/_格式备份/测试' });
    await vi.waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    await vi.waitFor(() => expect(modal.contentEl.querySelector('.xj-backup-path')?.textContent).toContain('小记/_格式备份/测试'));
    expect(errors).toEqual([]);
  });

  it('removes the redundant storage reload button', async () => { const {row}=await settingTab(); expect(row('整理已有小记').querySelectorAll('button')).toHaveLength(1); });

  it('keeps the system prompt and retrieval limits inside a closed optional AI section', async () => {
    const { tab } = await settingTab({ aiEnabled: true });
    [...tab.containerEl.querySelectorAll<HTMLButtonElement>('nav button')].find(button => button.textContent === 'AI')!.click();
    await vi.waitFor(() => expect(tab.containerEl.querySelector('textarea.xj-system-prompt')).not.toBeNull());
    const advanced = tab.containerEl.querySelector<HTMLDetailsElement>('details.xj-settings-advanced')!;
    expect(advanced.open).toBe(false); expect(advanced.querySelector('summary')?.textContent).toBe('提示词与上下文');
    expect(advanced.querySelectorAll('textarea.xj-system-prompt')).toHaveLength(1);
    expect(advanced.querySelectorAll('input[type="range"]')).toHaveLength(2);
    expect(tab.containerEl.querySelectorAll('textarea')).toHaveLength(1);
  });
});

const trashPanel = async (deleted = true) => {
  const fixture = await makeFixture();
  if (deleted) for (const memo of fixture.plugin.repo.records.slice(0, 2)) await fixture.plugin.repo.delete(memo);
  const panel = new TrashPanel(document.body, fixture.plugin); cleanups.push(() => panel.unload());
  await vi.waitFor(() => expect(panel.root.querySelectorAll('.xj-trash-entry')).toHaveLength(deleted ? 2 : 0));
  // Empty state is drawn asynchronously after listing, unlike the initial constructor DOM.
  if (!deleted) await vi.waitFor(() => expect(panel.root.querySelector('.xj-empty')).not.toBeNull());
  return { ...fixture, panel };
};

describe('compact recycle-bin toolbar', () => {
  it('shows search and one overflow button before any records are selected', async () => {
    const { panel } = await trashPanel(); const toolbar = panel.root.querySelector('.xj-trash-toolbar')!;
    expect(toolbar.querySelectorAll('input[type="search"]')).toHaveLength(1);
    expect(toolbar.querySelectorAll('button')).toHaveLength(1);
    expect(toolbar.querySelector('button')?.getAttribute('aria-label')).toBe('更多');
    expect(toolbar.textContent).not.toContain('选择全部筛选结果');
  });

  it('selects only filtered records through overflow and cancels without rebuilding memo content', async () => {
    const { panel, plugin } = await trashPanel(); const restore = vi.spyOn(plugin.repo, 'restore');
    const search = panel.root.querySelector<HTMLInputElement>('input[type="search"]')!;
    changeInput(search, '课堂');
    expect(panel.root.querySelectorAll('.xj-trash-entry')).toHaveLength(1);
    const body = panel.root.querySelector('.xj-trash-body')!;
    panel.root.querySelector<HTMLButtonElement>('.xj-trash-controls button[aria-label="更多"]')!.click();
    const selectAll = Menu.last!.items.find(item => item.title === '选择全部筛选结果')!;
    expect(selectAll.disabled).toBe(false); selectAll.callback();
    expect(panel.root.querySelectorAll('input[data-path]:checked')).toHaveLength(1);
    expect(panel.root.querySelector('.xj-trash-controls')?.textContent).toContain('已选 1 条');
    expect(panel.root.querySelector('.xj-trash-body')).toBe(body);
    panel.root.querySelector<HTMLButtonElement>('.xj-trash-controls button[aria-label="取消"]')!.click();
    expect(panel.root.querySelectorAll('input[data-path]:checked')).toHaveLength(0);
    expect(panel.root.querySelector('.xj-trash-body')).toBe(body);
    expect(panel.root.querySelector('.xj-trash-controls')!.querySelectorAll('button')).toHaveLength(1);
    expect(search.value).toBe('课堂'); expect(restore).not.toHaveBeenCalled();
  });

  it('disables overflow for an empty bin and disables filtered selection when search has no matches', async () => {
    const empty = await trashPanel(false);
    expect(empty.panel.root.querySelector<HTMLButtonElement>('.xj-trash-controls button')!.disabled).toBe(true);
    const populated = await trashPanel();
    changeInput(populated.panel.root.querySelector<HTMLInputElement>('input[type="search"]')!, '找不到的内容');
    populated.panel.root.querySelector<HTMLButtonElement>('.xj-trash-controls button[aria-label="更多"]')!.click();
    expect(Menu.last!.items.find(item => item.title === '选择全部筛选结果')?.disabled).toBe(true);
    expect(populated.panel.root.querySelector('.xj-empty')?.textContent).toBe(populated.plugin.t('noResults'));
  });
});
