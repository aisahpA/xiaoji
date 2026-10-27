// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AutoSave } from '../src/ui/auto-save';
import { XiaojiSettings } from '../src/ui/settings';
import { AskPanel } from '../src/ui/chat-panel';
import XiaojiPlugin from '../src/main';
import { makeFixture } from './fixture';
import { Menu } from './obsidian-mock';
import { MemoError } from '../src/core/types';
const tabs: XiaojiSettings[] = [], panels: AskPanel[] = [];
afterEach(async () => { for (const tab of tabs.splice(0)) tab.hide(); for (const panel of panels.splice(0)) panel.unload(); await Promise.resolve(); vi.useRealTimers(); vi.restoreAllMocks(); document.body.replaceChildren(); });
const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const settings = async (extra = {}) => {
  const f = await makeFixture(extra); const tab = new XiaojiSettings(f.plugin.app, f.plugin); tabs.push(tab); document.body.append(tab.containerEl); tab.display();
  const row = (name: string) => [...tab.containerEl.querySelectorAll<HTMLElement>('.setting-item')].find(row => row.querySelector('.setting-item-name')?.textContent === name)!;
  const go = async (name: string) => { [...tab.containerEl.querySelectorAll<HTMLButtonElement>('nav button')].find(b => b.textContent === name)!.click(); await tick(); };
  return { ...f, tab, row, go };
};
const input = (control: HTMLInputElement | HTMLTextAreaElement, text: string) => { control.value = text; control.dispatchEvent(new Event('input')); };
describe('automatic setting commits', () => {
  it('coalesces typing and does not save an intermediate path', async () => {
    vi.useFakeTimers(); const { plugin, row } = await settings(); const update = vi.spyOn(plugin, 'updateSettings');
    const folder = row('小记目录').querySelector('input')!;
    input(folder, '我的'); await vi.advanceTimersByTimeAsync(200); input(folder, '我的小记'); await vi.advanceTimersByTimeAsync(399);
    expect(update).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(1); expect(plugin.prefs.folder).toBe('我的小记'); expect(update).toHaveBeenCalledTimes(1);
  });
  it('flushes a valid path on blur without a confirmation button or recreating the field', async () => {
    const { plugin, row, tab } = await settings(); const folder = row('小记目录').querySelector('input')!;
    input(folder, '新小记'); folder.dispatchEvent(new Event('blur')); await tick();
    expect(plugin.prefs.folder).toBe('新小记'); expect(row('小记目录').querySelector('input')).toBe(folder);
    expect([...tab.containerEl.querySelectorAll('button')].some(b => /确认|应用/.test(b.textContent ?? ''))).toBe(false);
  });
  it('leaves the valid configuration unchanged on invalid input and clears the inline error on correction', async () => {
    const { plugin, row, errors } = await settings(); const folder = row('小记目录').querySelector('input')!;
    input(folder, '../错误'); folder.dispatchEvent(new Event('blur')); await tick(); expect(plugin.prefs.folder).toBe('小记'); expect(folder.getAttribute('aria-invalid')).toBe('true'); expect(errors).toEqual([]);
    input(folder, '有效目录'); folder.dispatchEvent(new Event('blur')); await tick(); expect(plugin.prefs.folder).toBe('有效目录'); expect(folder.getAttribute('aria-invalid')).toBe('false'); expect(row('小记目录').querySelector<HTMLElement>('.xj-setting-error')!.hidden).toBe(true);
  });
  it('does not save an unfinished Chinese composition, even when the debounce interval elapses', async () => {
    vi.useFakeTimers(); const { plugin, row } = await settings(); const folder = row('小记目录').querySelector('input')!;
    folder.dispatchEvent(new CompositionEvent('compositionstart')); input(folder, 'we'); await vi.advanceTimersByTimeAsync(1000); expect(plugin.prefs.folder).toBe('小记');
    folder.value = '我的小记'; folder.dispatchEvent(new CompositionEvent('compositionend')); await vi.advanceTimersByTimeAsync(400); expect(plugin.prefs.folder).toBe('我的小记');
  });
  it('saves related dropdown and filename changes together and rejects filename collisions', async () => {
    const { plugin, row } = await settings(); const format = row('文件名格式').querySelector('input')!;
    input(format, 'YYMM[新的]'); const grouping = row('文件内时间分组').querySelector('select')!; grouping.value = 'none'; grouping.dispatchEvent(new Event('change')); await tick();
    expect(plugin.prefs.grouping).toBe('none'); expect(plugin.prefs.fileFormats.month).toBe('YYMM[新的]');
    input(format, '[固定名称]'); format.dispatchEvent(new Event('blur')); await tick(); expect(plugin.prefs.fileFormats.month).toBe('YYMM[新的]'); expect(format.getAttribute('aria-invalid')).toBe('true');
  });
  it('flushes before switching settings sections and when closing settings', async () => {
    const { plugin, row, go, tab } = await settings(); input(row('小记目录').querySelector('input')!, '切换保存'); await go('通用'); expect(plugin.prefs.folder).toBe('切换保存');
    await go('存储'); input(row('小记目录').querySelector('input')!, '关闭保存'); tab.hide(); await tick(); expect(plugin.prefs.folder).toBe('关闭保存');
  });
  it('does not show success when persistence fails, and a later valid change can retry', async () => {
    const { plugin, row } = await settings(); const write = vi.spyOn(plugin, 'updateSettings').mockRejectedValueOnce(Error('Synthetic save error')); const folder = row('小记目录').querySelector('input')!;
    input(folder, '失败目录'); folder.dispatchEvent(new Event('blur')); await tick(); expect(plugin.prefs.folder).toBe('小记'); expect(folder.getAttribute('aria-invalid')).toBe('true');
    input(folder, '成功目录'); folder.dispatchEvent(new Event('blur')); await tick(); expect(write).toHaveBeenCalledTimes(2); expect(plugin.prefs.folder).toBe('成功目录');
  });
  it('saves API keys without an extra button, masks the input, and clearing cancels a queued replacement', async () => {
    vi.useFakeTimers(); const { plugin, row, go } = await settings({ aiEnabled: true }); await go('AI');
    const set = vi.spyOn(plugin, 'setApiKey'), keyRow = row('API 密钥'), field = keyRow.querySelector('input')!;
    expect(field.type).toBe('password'); input(field, 'synthetic-key'); await vi.advanceTimersByTimeAsync(400); expect(set).toHaveBeenLastCalledWith('synthetic-key');
    input(field, 'replacement'); keyRow.querySelector<HTMLButtonElement>('button[title="清除密钥"]')!.click(); await tick(); await vi.advanceTimersByTimeAsync(500); expect(set).toHaveBeenLastCalledWith('');
    expect([...keyRow.querySelectorAll('button')].some(b => /保存/.test(b.textContent ?? ''))).toBe(false);
  });
  it('reveals an existing secret only on request and never resurrects a pending cleared key', async () => {
    const { plugin, row, go } = await settings({ aiEnabled: true }); let secret = 'synthetic-stored';
    plugin.apiKey = () => secret; plugin.setApiKey = value => { secret = value; };
    await go('AI'); const key = row('API 密钥'), field = key.querySelector('input')!;
    expect(field.value).toBe(''); key.querySelector<HTMLButtonElement>('button[title="显示密钥"]')!.click(); await tick(); expect(field.value).toBe('synthetic-stored'); expect(field.type).toBe('text');
    key.querySelector<HTMLButtonElement>('button[title="隐藏密钥"]')!.click(); await tick();
    input(field, ''); key.querySelector<HTMLButtonElement>('button[title="显示密钥"]')!.click(); await tick(); expect(field.value).toBe(''); expect(secret).toBe('');
  });
  it('rejects an invalid API endpoint and preserves a valid one', async () => {
    const { plugin, row, go } = await settings({ aiEnabled: true }); await go('AI'); const endpoint = row('兼容服务地址').querySelector('input')!, before = plugin.prefs.aiBaseUrl;
    input(endpoint, 'file:///secret'); endpoint.dispatchEvent(new Event('blur')); await tick(); expect(plugin.prefs.aiBaseUrl).toBe(before); expect(endpoint.getAttribute('aria-invalid')).toBe('true');
  });
  it('keeps one capture row with its recorder and global scope toggle', async () => {
    const { row, go, tab } = await settings(); await go('通用'); expect(row('回收站')).toBeUndefined(); expect(tab.containerEl.textContent).not.toContain('纯 Markdown'); expect(tab.containerEl.textContent).not.toContain('xiaoji 0.'); expect(row('快速记录').querySelector('.xj-shortcut-recorder')).not.toBeNull(); expect(tab.containerEl.querySelectorAll('.xj-capture-setting')).toHaveLength(1); expect(row('快速记录').textContent).toContain('全局生效');
  });
});
describe('serialized settings persistence', () => {
  it('does not let a failed earlier write roll back a later change', async () => {
    const f = await makeFixture(); const p = new XiaojiPlugin(f.plugin.app, f.plugin.manifest); p.data = f.plugin.data;
    let fail!: (e: Error) => void; const gate = new Promise<void>((_resolve, reject) => { fail = reject; });
    const persist = vi.spyOn(p, 'persist').mockImplementationOnce(() => gate).mockResolvedValue(undefined);
    const first = p.updateSettings({ aiModel: 'will-fail' }); const rejected = expect(first).rejects.toThrow('Synthetic');
    const second = p.updateSettings({ layout: 'list' }); await tick(); expect(persist).toHaveBeenCalledTimes(1);
    fail(Error('Synthetic')); await rejected; await second; expect(p.prefs.aiModel).toBe(''); expect(p.prefs.layout).toBe('list'); expect(persist).toHaveBeenCalledTimes(2);
  });
  it('merges concurrent navigation edits against the latest committed state', async () => {
    const f = await makeFixture(); const p = new XiaojiPlugin(f.plugin.app, f.plugin.manifest); p.data = f.plugin.data; vi.spyOn(p, 'persist').mockResolvedValue(undefined);
    const id = p.prefs.nav[0]!.id;
    await Promise.all([
      p.updateSettings(current => ({ nav: current.nav.map(item => item.id === id ? { ...item, title: '新名称' } : item) })),
      p.updateSettings(current => ({ nav: current.nav.map(item => item.id === id ? { ...item, favorite: false } : item) })),
    ]);
    expect(p.prefs.nav[0]!.title).toBe('新名称'); expect(p.prefs.nav[0]!.favorite).toBe(false);
  });
  it('snapshots nested setting updates so a caller cannot mutate a queued write', async () => {
    const f = await makeFixture(); const p = new XiaojiPlugin(f.plugin.app, f.plugin.manifest); p.data = f.plugin.data; vi.spyOn(p, 'persist').mockResolvedValue(undefined);
    const formats = { ...p.prefs.fileFormats, month: 'YYYY-MM' }; const write = p.updateSettings({ fileFormats: formats }); formats.month = '[broken]'; await write; expect(p.prefs.fileFormats.month).toBe('YYYY-MM');
  });
  it('does not lose an edit scheduled while a previous auto-save is still running', async () => {
    const writes: number[] = []; let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; }); const save = new AutoSave(() => undefined);
    save.schedule(async () => { await gate; writes.push(1); }, true); await tick(); save.schedule(() => { writes.push(2); }, true); release(); await save.flush(); expect(writes).toEqual([1, 2]); await save.close();
  });
});
const chatSetup = async () => {
  const f = await makeFixture({ aiEnabled: true, saveConversations: false }); const root = document.createElement('div'); document.body.append(root); const insert = vi.fn();
  const panel = new AskPanel(root, f.plugin, undefined, insert); panels.push(panel);
  const memo = f.plugin.repo.records[0]!;
  const turn = { id: '20261022120000001', question: '原问题', answer: '**原始 Markdown**\n\n```ts\nconst x = 1;\n```\n\n参考 [1]', status: 'complete', sources: [{ number: 1, memo, content: memo.body }] };
  (panel as any).chat = { id: '20261022120000000', title: '会话', turns: [turn] }; await (panel as any).draw();
  return { ...f, root, panel, turn, insert };
};
describe('AI message actions', () => {
  it('copies the exact question and Markdown answer without a success notice', async () => {
    const { plugin, root, turn } = await chatSetup(); const copy = vi.spyOn(plugin, 'clipboard');
    root.querySelector<HTMLButtonElement>('.xj-chat-question-actions .xj-chat-copy')!.click(); await tick(); expect(copy).toHaveBeenLastCalledWith(turn.question, document, false);
    root.querySelector<HTMLButtonElement>('.xj-chat-turn-actions .xj-chat-copy')!.click(); await tick(); expect(copy).toHaveBeenLastCalledWith(turn.answer, document, false); expect(root.querySelector('.xj-chat-turn-actions .xj-chat-copy')?.getAttribute('aria-label')).toBe('已复制');
  });
  it('copies a code block without copying action labels', async () => {
    const { plugin, root } = await chatSetup(); const copy = vi.spyOn(plugin, 'clipboard'); const code = root.querySelector('pre code')!.textContent;
    root.querySelector<HTMLButtonElement>('.xj-chat-code-actions button')!.click(); await tick(); expect(copy).toHaveBeenCalledWith(code, document, false); expect(root.querySelectorAll('pre .xj-chat-copy')).toHaveLength(1);
  });
  it('keeps question input when reusing an earlier question, without sending or editing history', async () => {
    const { root, turn } = await chatSetup(); const text = root.querySelector('textarea')!; text.value = '尚未发送'; const fetch = vi.spyOn(globalThis, 'fetch');
    root.querySelector<HTMLButtonElement>('button[aria-label="再次编辑"]')!.click(); expect(text.value).toBe('尚未发送\n\n原问题'); expect(turn.question).toBe('原问题'); expect(fetch).not.toHaveBeenCalled();
  });
  it('inserts only the chosen answer and its references without creating a memo', async () => {
    const { root, insert, plugin, turn } = await chatSetup(); const create = vi.spyOn(plugin.repo, 'create');
    root.querySelector<HTMLButtonElement>('.xj-chat-turn-actions button[aria-label="更多"]')!.click(); Menu.last!.items.find(i => i.title === '放入小记记录框')!.callback();
    expect(insert).toHaveBeenCalledWith(turn.answer + '\n\n[1] @' + turn.sources[0]!.memo.id); expect(create).not.toHaveBeenCalled();
  });
  it('does not show a copied checkmark when the clipboard fails', async () => {
    const { root, plugin, errors } = await chatSetup(); vi.spyOn(plugin, 'clipboard').mockRejectedValue(new MemoError('permissionClipboard'));
    const copy = root.querySelector<HTMLButtonElement>('.xj-chat-turn-actions .xj-chat-copy')!; copy.click(); await tick(); expect(copy.getAttribute('aria-label')).toBe('复制'); expect(errors).toHaveLength(1);
  });
});
