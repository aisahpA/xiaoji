// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { navigation, moveRelative, orderedTags, reorderTags } from '../src/core/navigation';
import { loadSettings } from '../src/core/settings';
import { parseMemos, serializeMemo } from '../src/core/markdown';
import { NavigationSort, sortable } from '../src/ui/navigation-sort';
import { AskPanel } from '../src/ui/chat-panel';
import { XiaojiSettings } from '../src/ui/settings';
import { makeFixture } from './fixture';
import { Menu } from './obsidian-mock';
const panels: AskPanel[] = [], sorts: NavigationSort[] = [], tabs: XiaojiSettings[] = [];
afterEach(() => { for (const panel of panels.splice(0)) panel.unload(); for (const sort of sorts.splice(0)) sort.destroy(); for (const tab of tabs.splice(0)) tab.hide(); document.body.replaceChildren(); vi.restoreAllMocks(); });
const tick = async () => { for (let i = 0; i < 15; i++) await Promise.resolve(); };
const memo = (id: string, body: string) => parseMemos(serializeMemo(id, body), '小记/test.md')[0]!;
const memos = [memo('20261021110000001', '#工作/计划 #工作/复盘 #生活/阅读 #灵感'), memo('20261021110000002', '#工作/计划')];
describe('durable navigation ordering', () => {
  it('keeps all existing views and only changes the requested order', () => {
    const settings = loadSettings({ aiEnabled: true, reviewEnabled: true }); const ids = settings.nav.map(item => item.id);
    const next = moveRelative(settings.nav, 'ask', 'all', false, item => item.id);
    expect(next.map(item => item.id)).toEqual(['ask', ...ids.filter(id => id !== 'ask')]); expect(settings.nav.map(item => item.id)).toEqual(ids);
    expect(loadSettings({ ...settings, nav: next }).nav.map(item => item.id)).toEqual(next.map(item => item.id));
  });
  it('orders disabled optional destinations without losing their settings on re-enable', () => {
    const settings = loadSettings({ aiEnabled: false, reviewEnabled: false }); settings.nav = moveRelative(settings.nav, 'ask', 'all', false, item => item.id);
    expect(navigation(settings).some(item => item.id === 'ask' || item.id === 'review')).toBe(false);
    expect(navigation(loadSettings({ ...settings, aiEnabled: true }))[0]!.id).toBe('ask');
  });
  it('leaves invalid and self drops unchanged', () => {
    for (const [source, target] of [['bad', 'all'], ['all', 'bad'], ['all', 'all']]) expect(moveRelative(['all', 'archive'], source!, target!, false, id => id)).toEqual(['all', 'archive']);
  });
  it('deduplicates and validates persisted tag order', () => {
    expect(loadSettings({ tagOrder: ['工作', '工作', '工作/计划', 'bad//tag', {}, 4] }).tagOrder).toEqual(['工作', '工作/计划']);
  });
});
describe('tag order without renaming or changing hierarchy', () => {
  it('moves an entire parent and preserves descendants, counts and source bytes', () => {
    const before = memos.map(memo => memo.raw), tree = orderedTags(memos, []);
    const order = reorderTags(tree, [], '生活', '工作', false), result = orderedTags(memos, order);
    expect(result[0]!.path).toBe('生活'); expect(result.find(node => node.path === '工作')!.count).toBe(2);
    expect(result.find(node => node.path === '工作')!.children.map(node => node.path).sort()).toEqual(['工作/复盘', '工作/计划'].sort()); expect(memos.map(memo => memo.raw)).toEqual(before);
  });
  it('reorders only siblings and rejects cross-parent drops', () => {
    const tree = orderedTags(memos, []); const order = reorderTags(tree, [], '工作/计划', '工作/复盘', false);
    expect(orderedTags(memos, order).find(node => node.path === '工作')!.children.map(node => node.path)).toEqual(['工作/计划', '工作/复盘']);
    expect(reorderTags(tree, order, '工作/计划', '生活/阅读', false)).toEqual(order);
  });
  it('retains a custom sibling order after new tags appear and after reopening', () => {
    const order = reorderTags(orderedTags(memos, []), [], '工作/计划', '工作/复盘', false);
    const settings = loadSettings(JSON.parse(JSON.stringify({ tagOrder: order })));
    const result = orderedTags([...memos, memo('20261021110000003', '#工作/新增')], settings.tagOrder);
    expect(result.find(node => node.path === '工作')!.children.map(node => node.path)).toEqual(['工作/计划', '工作/复盘', '工作/新增']);
  });
});
const drag = (node: HTMLElement, name: string, x = 0, y = 0) => {
  const event = new Event(name, { bubbles: true, cancelable: true }); Object.defineProperties(event, { clientX: { value: x }, clientY: { value: y }, dataTransfer: { value: { setData: vi.fn(), effectAllowed: '', dropEffect: '' } } }); node.dispatchEvent(event); return event;
};
const sortableFixture = (group = 'views', horizontal = false) => {
  const root = document.createElement('div'); document.body.append(root);
  const a = document.createElement('button'), b = document.createElement('button'); a.textContent = 'A'; b.textContent = 'B'; root.append(a, b);
  sortable(a, { id: 'a', group }, horizontal); sortable(b, { id: 'b', group }, horizontal);
  b.getBoundingClientRect = () => ({ x: 0, y: 0, top: 0, left: 0, width: 100, height: 40, bottom: 40, right: 100, toJSON: () => ({}) });
  const move = vi.fn(async () => undefined), step = vi.fn(async () => undefined), failed = vi.fn(); const sort = new NavigationSort(root, move, step, failed); sorts.push(sort); return { root, a, b, move, step, failed, sort };
};
describe('navigation drag lifecycle', () => {
  it.each([false, true])('marks before/after and commits exactly one %s-axis drop', async horizontal => {
    const { a, b, move } = sortableFixture('views', horizontal); drag(a, 'dragstart'); drag(b, 'dragover', 90, 35); expect(b.classList.contains('xj-drop-after')).toBe(true); drag(b, 'drop', 90, 35); await tick();
    expect(move).toHaveBeenCalledExactlyOnceWith({ id: 'a', group: 'views' }, { id: 'b', group: 'views' }, true); expect(b.classList.contains('xj-drop-after')).toBe(false);
  });
  it.each(['escape', 'blur', 'dragend', 'outside'])('cancels %s without persisting a stale drop', async cause => {
    const { a, b, move } = sortableFixture(); drag(a, 'dragstart'); drag(b, 'dragover', 0, 0);
    if (cause === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    if (cause === 'blur') window.dispatchEvent(new Event('blur'));
    if (cause === 'dragend') document.dispatchEvent(new Event('dragend', { bubbles: true }));
    if (cause === 'outside') document.body.dispatchEvent(new Event('drop', { bubbles: true }));
    drag(b, 'drop'); await tick(); expect(move).not.toHaveBeenCalled(); expect(b.classList.contains('xj-drop-before')).toBe(false);
  });
  it('does not accept files or another tag parent group', async () => {
    const { a, b, move } = sortableFixture('tags:工作'); expect(drag(b, 'drop').defaultPrevented).toBe(false);
    drag(a, 'dragstart'); b.dataset.sortGroup = 'tags:生活'; expect(drag(b, 'drop').defaultPrevented).toBe(false); await tick(); expect(move).not.toHaveBeenCalled();
  });
  it('allows Alt+Arrow navigation order but never intercepts text editing', async () => {
    const { a, root, step } = sortableFixture(); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', altKey: true, bubbles: true, cancelable: true })); await tick(); expect(step).toHaveBeenCalledWith({ id: 'a', group: 'views' }, 1);
    const field = document.createElement('input'); const row = document.createElement('div'); sortable(row, { id: 'edit', group: 'views' }); row.append(field); root.append(row); field.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowUp', altKey: true, bubbles: true })); expect(step).toHaveBeenCalledTimes(1);
  });
  it('removes listeners and does not suppress ordinary clicks after cancel', async () => {
    const { a, b, sort, move } = sortableFixture(); drag(a, 'dragstart'); sort.destroy(); drag(b, 'drop'); await tick(); expect(move).not.toHaveBeenCalled(); const click = new MouseEvent('click', { bubbles: true, cancelable: true }); a.dispatchEvent(click); expect(click.defaultPrevented).toBe(false);
  });
});
describe('quiet settings and AI navigation', () => {
  it('removes tag-view creation and vault-wide tag completion settings', async () => {
    const { plugin } = await makeFixture(); const tab = new XiaojiSettings(plugin.app, plugin); tabs.push(tab); document.body.append(tab.containerEl); tab.display(); [...tab.containerEl.querySelectorAll<HTMLButtonElement>('nav button')].find(b => b.textContent === '界面')!.click(); await tick();
    expect(tab.containerEl.textContent).not.toContain('添加标签视图'); expect(tab.containerEl.textContent).not.toContain('标签补全包含全库标签');
  });
  it('puts archive scope in one mode menu and updates the mode without losing the input', async () => {
    const { plugin } = await makeFixture({ aiEnabled: true, saveConversations: false }); const root = document.createElement('div'); document.body.append(root); const panel = new AskPanel(root, plugin); panels.push(panel);
    const input = root.querySelector('textarea')!; input.value = '未发送'; expect(root.querySelector('.xj-ai-range')).toBeNull(); root.querySelector<HTMLButtonElement>('.xj-ai-mode')!.click(); Menu.last!.items.find(item => item.title === '包含归档')!.callback(); expect(panel.snapshot().archives).toBe(true);
    root.querySelector<HTMLButtonElement>('.xj-ai-mode')!.click(); Menu.last!.items.find(item => item.title === '不使用小记')!.callback(); await tick(); expect(plugin.prefs.aiMemoMode).toBe('off'); expect(input.value).toBe('未发送');
  });
  it('retains accessible region names when toolbar mounts move and history remains reachable', async () => {
    const { plugin } = await makeFixture({ aiEnabled: true, saveConversations: true }); const root = document.createElement('div'), slot = document.createElement('div'); document.body.append(root, slot); const panel = new AskPanel(root, plugin); panels.push(panel); panel.mountToolbar(slot);
    expect(slot.querySelector('.xj-chat-toolbar')).not.toBeNull(); expect(root.querySelector('textarea')?.getAttribute('aria-label')).toBe('你想了解什么？'); expect(root.querySelector('[role="log"]')?.getAttribute('aria-label')).toBe('历史对话');
    slot.querySelector<HTMLButtonElement>('button[aria-label="更多"]')!.click(); expect(Menu.last!.items.some(item => item.title === '历史对话')).toBe(true); panel.mountToolbar(null); expect(root.querySelector('.xj-chat-toolbar')).not.toBeNull();
  });
});
