// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf, ViewStateResult } from 'obsidian';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { loadSettings } from '../src/core/settings';
import { surfaceNavigation, reorderSurface } from '../src/core/navigation';
import { selectMemos } from '../src/core/search';
import { MemoView } from '../src/ui/view';
import { XiaojiSettings } from '../src/ui/settings';
import { NavigationSort, sortable } from '../src/ui/navigation-sort';
import XiaojiPlugin from '../src/main';
import { makeFixture } from './fixture';
class ResizeMock {
  static latest: ResizeMock;
  constructor(private callback: ResizeObserverCallback) { ResizeMock.latest = this; }
  observe(): void {} disconnect(): void {} unobserve(): void {}
  resize(width: number): void { this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
}
beforeAll(() => {
  globalThis.ResizeObserver = ResizeMock as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver = class { observe(): void {} disconnect(): void {} } as unknown as typeof IntersectionObserver;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0, toJSON: () => ({}) });
  HTMLElement.prototype.scrollIntoView = () => undefined;
});
const views: MemoView[] = [], tabs: XiaojiSettings[] = [], sorts: NavigationSort[] = [];
const tick = async () => { for (let i = 0; i < 20; i++) await Promise.resolve(); };
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
afterEach(async () => { vi.useRealTimers(); for (const sort of sorts.splice(0)) sort.destroy(); for (const tab of tabs.splice(0)) tab.hide(); for (const view of views.splice(0)) await view.onClose(); document.body.replaceChildren(); vi.restoreAllMocks(); });
const setup = async () => {
  const f = await makeFixture(); const view = new MemoView({ app: f.plugin.app } as unknown as WorkspaceLeaf, f.plugin); views.push(view); document.body.append(view.containerEl); await view.onOpen(); await settle();
  return { ...f, view, root: view.contentEl };
};
const setInput = (input: HTMLInputElement, text: string) => { input.value = text; input.dispatchEvent(new Event('input', { bubbles: true })); };
describe('independent navigation preferences', () => {
  it('migrates legacy order and favorites without retaining obsolete layout modes', () => {
    const prefs = loadSettings({ navigation: 'sidebar', sidebar: 'open', nav: [{ id: 'archive', kind: 'archive', favorite: false }] });
    expect(prefs.topOrder[0]).toBe('archive'); expect(prefs.sidebarOrder[0]).toBe('archive'); expect(surfaceNavigation(prefs, 'top').map(item => item.id)).not.toContain('archive'); expect(surfaceNavigation(prefs, 'sidebar').map(item => item.id)).toContain('archive'); expect(prefs).not.toHaveProperty('navigation'); expect(prefs).not.toHaveProperty('sidebar');
  });
  it('reorders either surface without moving the other and retains hidden destinations', () => {
    const prefs = loadSettings({ aiEnabled: true }); const side = [...prefs.sidebarOrder];
    const next = loadSettings({ ...prefs, ...reorderSurface(prefs, 'top', 'ask', 'all', false) }); expect(next.topOrder[0]).toBe('ask'); expect(next.sidebarOrder).toEqual(side);
    const later = loadSettings({ ...next, ...reorderSurface(next, 'sidebar', 'trash', 'all', false) }); expect(later.sidebarOrder[0]).toBe('trash'); expect(later.topOrder).toEqual(next.topOrder);
  });
  it('supports independent visibility while sharing the same view identity', () => {
    const prefs = loadSettings({ nav: [{ id: 'all', kind: 'all', favorite: true, sidebarVisible: false }] });
    expect(surfaceNavigation(prefs, 'top').some(item => item.id === 'all')).toBe(true); expect(surfaceNavigation(prefs, 'sidebar').some(item => item.id === 'all')).toBe(false); expect(surfaceNavigation(prefs, 'sidebar', true).some(item => item.id === 'all')).toBe(true);
  });
  it('sanitizes unknown duplicate order IDs and restores enabled optional views at their place', () => {
    const prefs = loadSettings({ topOrder: ['ask', 'ask', 'bad', 3, 'all'] }); expect(prefs.topOrder.slice(0, 2)).toEqual(['ask', 'all']);
    expect(surfaceNavigation(prefs, 'top', true)[0]!.id).toBe('all'); expect(surfaceNavigation(loadSettings({ ...prefs, aiEnabled: true }), 'top', true)[0]!.id).toBe('ask');
  });
  it('combines structured labels and text using parent tags and AND semantics', async () => {
    const { plugin } = await makeFixture(); const all = plugin.prefs.nav.find(item => item.id === 'all')!;
    expect(selectMemos(plugin.repo.records, all, '课堂', plugin.prefs, { tags: ['教学'] })).toHaveLength(1);
    expect(selectMemos(plugin.repo.records, all, '', plugin.prefs, { tags: ['教学', '备课'] })).toHaveLength(0);
  });
});
describe('stable search, editing and per-tab layout', () => {
  it('keeps the entire top navigation visible during narrow search and sidebar expansion', async () => {
    const { root, view } = await setup(); ResizeMock.latest.resize(420); view.focusSearch();
    expect(root.querySelector<HTMLElement>('.xj-top-nav')!.hidden).toBe(false); expect(root.querySelectorAll('.xj-top-nav button')).toHaveLength(2);
    await view.setState({ ...view.getState(), sidebarOpen: true }, {} as ViewStateResult); expect(root.querySelectorAll('.xj-top-nav button')).toHaveLength(2); expect(root.querySelector('.xj-root')!.classList.contains('has-drawer')).toBe(true);
  });
  it('keeps the input, focus and IME composition intact during unrelated settings and resize', async () => {
    const { root, view, plugin } = await setup(); view.focusSearch(); const input = root.querySelector<HTMLInputElement>('.xj-search')!; input.focus(); input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })); setInput(input, 'jiao');
    await plugin.updateSettings({ gap: 19 }); ResizeMock.latest.resize(480); expect(root.querySelector('.xj-search')).toBe(input); expect(input.value).toBe('jiao'); expect(document.activeElement).toBe(input); expect(view.getState().query).toBe('');
    input.value = '教学'; input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })); await settle(); expect(view.getState().query).toBe('教学'); expect(root.querySelectorAll('.xj-card')).toHaveLength(2);
  });
  it('filters through the compact tag panel and retains conditions across ordinary views', async () => {
    const { root, view } = await setup(); view.focusSearch(); root.querySelector<HTMLButtonElement>('.xj-search-line button[aria-label="筛选"]')!.click();
    const choice = [...root.querySelectorAll<HTMLLabelElement>('.xj-filter-choice')].find(e => e.textContent === '#教学')!; choice.querySelector<HTMLInputElement>('input')!.click(); await settle(); expect(root.querySelectorAll('.xj-card')).toHaveLength(1);
    expect(view.getState().filterTags).toEqual(['教学']); view.navigate('pinned'); expect(view.getState().filterTags).toEqual(['教学']); view.navigate('all'); expect(root.querySelectorAll('.xj-card')).toHaveLength(1);
    root.querySelector<HTMLButtonElement>('.xj-search-chips button')!.click(); await settle(); expect(root.querySelectorAll('.xj-card')).toHaveLength(3);
  });
  it('restores sidebar choice per tab and keeps editor selection and undo when restoring layout', async () => {
    const a = await setup(), b = await setup(); const editor = EditorView.findFromDOM(a.root.querySelector('.cm-editor')!)!;
    editor.dispatch({ changes: { from: 0, insert: '可撤销的正文' }, selection: { anchor: 3 } }); await a.view.setState({ ...a.view.getState(), sidebarOpen: true }, {} as ViewStateResult);
    expect(a.view.getState().sidebarOpen).toBe(true); expect(b.view.getState().sidebarOpen).toBe(false); expect(EditorView.findFromDOM(a.root.querySelector('.cm-editor')!)).toBe(editor); expect(editor.state.selection.main.head).toBe(3); expect(undo(editor)).toBe(true); expect(editor.state.doc.toString()).toBe('');
    const c = await setup(); await c.view.setState(a.view.getState(), {} as ViewStateResult); expect(c.view.getState().sidebarOpen).toBe(true);
  });
  it('temporarily clears restrictive label filters for reference location and restores them on return', async () => {
    const { view, root, plugin } = await setup(); await view.setState({ ...view.getState(), filterTags: ['不存在'], searchActive: true }, {} as ViewStateResult); await view.revealMemo(plugin.repo.records[0]!); expect(root.querySelector('.is-revealed')).not.toBeNull(); expect(view.getState().filterTags).toEqual([]);
    root.querySelector<HTMLButtonElement>('[aria-label="返回之前的位置"]')!.click(); await settle(); expect(view.getState().filterTags).toEqual(['不存在']);
  });
  it('waits for an in-flight attachment before creating the memo and submits once', async () => {
    const { view, plugin, root } = await setup(); const editor = (view as any).composer; let finish!: (link: string) => void;
    vi.spyOn(plugin, 'addAttachment').mockImplementation(() => new Promise(resolve => { finish = resolve; })); const create = vi.spyOn(plugin, 'createMemo'); editor.setValue('附件正文'); void editor.addFiles([new File(['x'], 'x.png')]); await tick();
    root.querySelector<HTMLButtonElement>('.xj-submit')!.click(); root.querySelector<HTMLButtonElement>('.xj-submit')!.click(); await tick(); expect(create).not.toHaveBeenCalled(); finish('![[x.png]]'); await settle(); expect(create).toHaveBeenCalledTimes(1); expect(create.mock.calls[0]![0]).toContain('![[x.png]]'); expect(plugin.repo.records.some(memo => memo.body.includes('![[x.png]]'))).toBe(true);
  });
  it('does not expose obsolete layout or arrow ordering settings', async () => {
    const { plugin } = await makeFixture(); const tab = new XiaojiSettings(plugin.app, plugin); tabs.push(tab); document.body.append(tab.containerEl); tab.display(); [...tab.containerEl.querySelectorAll<HTMLButtonElement>('.xj-settings-tabs button')].find(e => e.textContent === '界面')!.click(); await tick();
    expect(tab.containerEl.textContent).not.toMatch(/导航位置|侧栏行为/); expect(tab.containerEl.querySelector('[aria-label="上移"],[aria-label="下移"]')).toBeNull(); expect(tab.containerEl.querySelectorAll('.xj-nav-surface button')).toHaveLength(2);
    const top = plugin.prefs.nav[0]!.favorite; [...tab.containerEl.querySelectorAll<HTMLButtonElement>('.xj-nav-surface button')].find(e => e.textContent === '侧边栏')!.click(); await tick(); const toggle = tab.containerEl.querySelector<HTMLInputElement>('.xj-nav-setting input[type=checkbox]')!; toggle.click(); await tick(); expect(plugin.prefs.nav[0]!.favorite).toBe(top); expect(plugin.prefs.nav[0]!.sidebarVisible).toBe(false);
  });
});
const pointer = (node: EventTarget, type: string, x = 0, y = 0) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { pointerType: { value: 'touch' }, pointerId: { value: 7 }, isPrimary: { value: true }, clientX: { value: x }, clientY: { value: y } }); node.dispatchEvent(event); return event; };
const touchFixture = () => {
  const root = document.createElement('div'), a = document.createElement('button'), b = document.createElement('button'); document.body.append(root); root.append(a, b); sortable(a, { id: 'a', group: 'views-top' }); sortable(b, { id: 'b', group: 'views-top' });
  b.getBoundingClientRect = () => ({ x: 0, y: 20, width: 100, height: 40, left: 0, right: 100, top: 20, bottom: 60, toJSON: () => ({}) }); Object.defineProperty(document, 'elementFromPoint', { configurable: true, value: () => b });
  const move = vi.fn(async () => undefined); sorts.push(new NavigationSort(root, move, async () => undefined, error => { throw error; })); return { a, b, move };
};
describe('touch ordering without arrow buttons', () => {
  it('does not cancel desktop HTML dragging when Chromium emits mouse pointercancel', async () => {
    const { a, b, move } = touchFixture();
    const drag = (node: HTMLElement, type: string) => { const event = new Event(type, { bubbles: true, cancelable: true }); Object.defineProperties(event, { clientX: { value: 5 }, clientY: { value: 55 }, dataTransfer: { value: { setData: () => undefined } } }); node.dispatchEvent(event); };
    drag(a, 'dragstart'); pointer(document, 'pointercancel'); drag(b, 'drop'); await tick(); expect(move).toHaveBeenCalledTimes(1);
  });
  it('starts after a deliberate hold, marks the target and commits exactly once', async () => {
    vi.useFakeTimers(); const { a, b, move } = touchFixture(); pointer(a, 'pointerdown'); await vi.advanceTimersByTimeAsync(390); pointer(document, 'pointermove', 5, 55); expect(b.classList.contains('xj-drop-after')).toBe(true); pointer(document, 'pointerup', 5, 55); await tick(); expect(move).toHaveBeenCalledExactlyOnceWith({ id: 'a', group: 'views-top' }, { id: 'b', group: 'views-top' }, true); expect(b.classList.contains('xj-drop-after')).toBe(false);
  });
  it.each(['scroll', 'cancel', 'escape', 'blur'])('does not commit after %s', async reason => {
    vi.useFakeTimers(); const { a, move } = touchFixture(); pointer(a, 'pointerdown');
    if (reason === 'scroll') pointer(document, 'pointermove', 0, 20); else { await vi.advanceTimersByTimeAsync(390); if (reason === 'cancel') pointer(document, 'pointercancel'); if (reason === 'escape') document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); if (reason === 'blur') window.dispatchEvent(new Event('blur')); }
    pointer(document, 'pointerup', 5, 55); await tick(); expect(move).not.toHaveBeenCalled(); expect(document.querySelector('.xj-touch-sorting,.xj-drop-after')).toBeNull();
  });
});
describe('coalesced draft persistence', () => {
  it('does not rewrite unchanged JSON on blur or unload after drafts have already flushed', async () => {
    const f = await makeFixture(), p = new XiaojiPlugin(f.plugin.app, f.plugin.manifest); p.data = f.plugin.data; const write = vi.spyOn(p, 'persist').mockResolvedValue(undefined);
    await p.flushDrafts(); p.onunload(); expect(write).not.toHaveBeenCalled();
  });
  it('updates memory immediately, coalesces disk writes and explicitly flushes pending text', async () => {
    vi.useFakeTimers(); const f = await makeFixture(); const p = new XiaojiPlugin(f.plugin.app, f.plugin.manifest); p.data = f.plugin.data; const write = vi.spyOn(p, 'persist').mockResolvedValue(undefined);
    for (const text of ['a', 'ab', 'abc']) p.setDraft('input', text); expect(p.data.drafts.input!.text).toBe('abc'); expect(write).not.toHaveBeenCalled(); await vi.advanceTimersByTimeAsync(250); expect(write).toHaveBeenCalledTimes(1);
    p.setDraft('input', '完成'); await p.flushDrafts(); expect(write).toHaveBeenCalledTimes(2); p.onunload();
  });
});
