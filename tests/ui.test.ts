// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { QuickView, MemoView } from '../src/ui/view';
import { TextModal } from '../src/ui/modals';
import { XiaojiSettings } from '../src/ui/settings';
import { makeFixture } from './fixture';
import { ReferencePreview } from '../src/ui/references';
import { Menu, Notice, Platform } from './obsidian-mock';
import type { ViewStateResult, WorkspaceLeaf } from 'obsidian';
import { EditorView } from '@codemirror/view';
import XiaojiPlugin from '../src/main';
import { submitMatches } from '../src/ui/submit';

class ResizeMock {
  static instances: ResizeMock[] = [];
  constructor(private callback: ResizeObserverCallback) { ResizeMock.instances.push(this); }
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
  trigger(width: number): void { this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
}
class IntersectionMock { observe(): void {} disconnect(): void {} unobserve(): void {} }

beforeAll(() => {
  globalThis.ResizeObserver = ResizeMock as unknown as typeof ResizeObserver;
  globalThis.IntersectionObserver = IntersectionMock as unknown as typeof IntersectionObserver;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) });
  HTMLElement.prototype.scrollIntoView = () => undefined;
});
const opened: MemoView[] = [];
const quickViews: QuickView[] = [];
const previews: ReferencePreview[] = [];
afterEach(async () => {
  for (const quick of quickViews.splice(0)) await quick.onClose();
  for (const preview of previews.splice(0)) preview.unload();
  Notice.messages = [];
  for (const view of opened.splice(0)) await view.onClose();
  document.body.replaceChildren(); Platform.isMobile = false; Menu.last = null;
});
const flush = async (): Promise<void> => { await new Promise(resolve => setTimeout(resolve, 30)); };
const setup = async (settings = {}) => {
  const fixture = await makeFixture(settings);
  const view = new MemoView({ app: fixture.plugin.app } as unknown as WorkspaceLeaf, fixture.plugin);
  document.body.append(view.containerEl);
  opened.push(view); await view.onOpen(); if ((settings as { sidebar?: string }).sidebar === 'open') await view.setState({ sidebarOpen: true }, {} as ViewStateResult); await flush();
  return { ...fixture, view, root: view.contentEl };
};
const clickMore = (root: HTMLElement): Menu => {
  (root.querySelector('.xj-toolbar button[aria-label="更多"]') as HTMLButtonElement).click();
  return Menu.last!;
};

describe('stable source capture and trustworthy queries', () => {
  it('keeps Markdown source and the same editor when the caret moves or focus changes', async () => {
    const { root } = await setup();
    const dom = root.querySelector<HTMLElement>('.cm-editor')!, editor = EditorView.findFromDOM(dom)!;
    const source = '**粗体**\n\n- [ ] 待办\n\n$$a^2$$\n\n@20261021120000001';
    editor.dispatch({ changes: { from: 0, insert: source } });
    for (const anchor of [0, 5, source.length, 10, 1]) editor.dispatch({ selection: { anchor } });
    editor.focus(); editor.contentDOM.blur(); await flush();
    expect(editor.state.doc.toString()).toBe(source);
    expect(root.querySelector('.cm-editor')).toBe(dom);
    expect(root.querySelectorAll('.xj-live-block,.xj-editor-source strong,.xj-editor-source mjx-container')).toHaveLength(0);
    expect(root.querySelector('.xj-source-reference')?.getAttribute('data-xj-id')).toBe('20261021120000001');
  });
  it('counts a complete date range offline and never reports a single-turn deletion as recycled', async () => {
    const { root, plugin, view } = await setup({ aiEnabled: true });
    const fetch = vi.spyOn(globalThis, 'fetch');
    view.navigate('ask'); const input = root.querySelector<HTMLTextAreaElement>('.xj-ask-panel textarea')!;
    input.value = '2026-10-21 记了几条小记？';
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true, cancelable: true }));
    await flush(); await flush();
    expect(root.querySelector('.xj-ai-answer')?.textContent).toContain('3');
    expect(root.querySelector('.xj-query-scope')?.textContent).toContain('2026-10-21');
    expect(root.querySelector('.xj-query-scope')?.textContent).toContain('包含归档');
    expect(fetch).not.toHaveBeenCalled();
    expect(root.querySelector('.xj-chat-turn')?.textContent).not.toContain('此回答没有可验证的来源编号');
    (root.querySelector('.xj-chat-turn-actions button[aria-label="更多"]') as HTMLButtonElement).click(); Menu.last!.items.find(item => item.title === '删除本轮')!.callback(); await flush();
    expect(Notice.messages.some(message => message.includes('已移入回收站'))).toBe(false);
    expect((await plugin.chats.list()).chats[0]?.turns).toHaveLength(0);
    expect(root.querySelector('.xj-trash-chat')).toBeNull();
  });
  it('does not submit newline, IME composition or repeated keys, and follows changed shortcut settings', async () => {
    const { root, plugin, view } = await setup({ aiEnabled: true }); view.navigate('ask');
    const input = root.querySelector<HTMLTextAreaElement>('.xj-ask-panel textarea')!; input.value = '共有几条小记';
    for (const event of [new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }), new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, isComposing: true, bubbles: true }), new KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, repeat: true, bubbles: true })]) input.dispatchEvent(event);
    await flush(); expect(root.querySelector('.xj-chat-turn')).toBeNull();
    await plugin.updateSettings({ submitKey: 'Alt-Enter' });
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true })); await flush(); await flush();
    expect(root.querySelectorAll('.xj-chat-turn')).toHaveLength(1);
    expect(root.querySelector('.xj-ai-answer')?.textContent).toContain('4');
    expect(submitMatches(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true }), 'Mod-Enter', false)).toBe(true);
    expect(submitMatches(new KeyboardEvent('keydown', { key: 'Enter', metaKey: true }), 'Mod-Enter', true)).toBe(true);
    expect(submitMatches(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, shiftKey: true }), 'Mod-Enter', false)).toBe(false);
  });
  it('cancels counts if the current index cannot be read completely, preserving the question', async () => {
    const { root, plugin, view } = await setup({ aiEnabled: true }); view.navigate('ask');
    vi.spyOn(plugin.repo, 'scan').mockRejectedValue(new Error('read failed'));
    const input = root.querySelector<HTMLTextAreaElement>('.xj-ask-panel textarea')!; input.value = '共有几条小记';
    (root.querySelector('button[aria-label="提问"]') as HTMLButtonElement).click(); await flush();
    expect(root.querySelector('[role="status"]')?.textContent).toContain('取消本次查询');
    expect(input.value).toBe('共有几条小记'); expect(root.querySelector('.xj-chat-turn')).toBeNull();
  });
  it('returns bounded full source cards for local lists and excludes deleted memos', async () => {
    const { root, plugin, view } = await setup({ aiEnabled: true, aiMaxMemos: 1 });
    await plugin.repo.delete(plugin.repo.records[0]!); view.navigate('ask');
    (root.querySelector('.xj-ask-panel textarea') as HTMLTextAreaElement).value = '2026-10-21 有哪些小记';
    (root.querySelector('button[aria-label="提问"]') as HTMLButtonElement).click(); await flush(); await flush();
    expect(root.querySelector('.xj-ai-answer')?.textContent).toContain('2');
    expect(root.querySelectorAll('.xj-chat-source')).toHaveLength(1);
    const disclosure = root.querySelector<HTMLDetailsElement>('.xj-chat-sources')!; disclosure.open = true; disclosure.dispatchEvent(new Event('toggle')); await flush();
    expect(root.querySelector('.xj-chat-source')?.textContent).toContain('教学反馈应具体');
    expect(root.querySelector('.xj-chat-source input')?.hasAttribute('disabled')).toBe(true);
    const chat = (await plugin.chats.list()).chats[0]!;
    expect(chat.turns[0]?.query).toMatchObject({ total: 2, shown: 1, action: 'list' });
  });
  it('executes a model count plan locally without a second generation request', async () => {
    const { root, view, plugin } = await setup({ aiEnabled: true, aiModel: 'test' }); plugin.apiKey = () => 'synthetic';
    const fetch = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({ choices: [{ message: { content: '{"queries":[],"query":{"action":"count","tags":["教学"]}}' } }] }), { headers: { 'content-type': 'application/json' } }));
    view.navigate('ask'); (root.querySelector('.xj-ask-panel textarea') as HTMLTextAreaElement).value = '帮我统计教学相关标签的记录数量';
    (root.querySelector('button[aria-label="提问"]') as HTMLButtonElement).click(); await flush(); await flush();
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(root.querySelector('.xj-ai-answer')?.textContent).toContain('1');
  });
  it('previews local references with Ctrl, preserves focus, and removes listeners on unload', async () => {
    const { plugin } = await makeFixture(); const preview = new ReferencePreview(plugin); previews.push(preview);
    plugin.bindReferences = root => preview.bind(root);
    const body = document.createElement('div'), input = document.createElement('textarea'); document.body.append(input, body); input.focus();
    body.textContent = '@20261021120000001'; XiaojiPlugin.prototype.renderReferences.call(plugin, body);
    const link = body.querySelector<HTMLElement>('.xj-reference')!;
    link.dispatchEvent(new MouseEvent('pointerover', { bubbles: true, ctrlKey: true })); await flush();
    expect(document.querySelector('.xj-reference-preview')?.textContent).toContain('留出思考');
    expect(document.activeElement).toBe(input);
    document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    expect(document.querySelector('.xj-reference-preview')).toBeNull();
    const open = vi.spyOn(plugin, 'openMemo'); preview.unload(); link.click(); await flush(); expect(open).not.toHaveBeenCalled();
  });
  it('locates an archived reference, then returns to the previous filter without losing capture', async () => {
    const { root, view, plugin } = await setup();
    const input = root.querySelector<HTMLInputElement>('.xj-search')!; input.value = '教学'; input.dispatchEvent(new Event('input', { bubbles: true })); await flush();
    const editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!; editor.dispatch({ changes: { from: 0, insert: '未发送内容' } });
    await view.revealMemo(plugin.repo.records.find(memo => memo.archived)!);
    expect(view.getState().currentId).toBe('archive'); expect(root.querySelector('.is-revealed')).toBeTruthy();
    (root.querySelector('button[aria-label="返回之前的位置"]') as HTMLButtonElement).click(); await flush();
    expect(view.getState().query).toBe('教学');
    expect(EditorView.findFromDOM(root.querySelector('.cm-editor')!)!.state.doc.toString()).toBe('未发送内容');
  });
});

describe('quiet memo navigation', () => {
  it('has one toolbar, no standalone title or date-group headings, and dates on every memo', async () => {
    const { root, errors } = await setup();
    expect(root.querySelectorAll('.xj-toolbar')).toHaveLength(1);
    expect(root.querySelectorAll('h1,h2,.xj-date-group')).toHaveLength(0);
    expect(root.querySelectorAll('.xj-card')).toHaveLength(3);
    expect([...root.querySelectorAll('time')].every(time => time.textContent!.startsWith('2026-10-21'))).toBe(true);
    expect(errors).toEqual([]);
  });
  it('keeps optional tools hidden until enabled', async () => {
    const { root, plugin } = await setup();
    let menu = clickMore(root);
    expect(menu.items.some(item => item.title === plugin.t('review'))).toBe(false);
    await plugin.updateSettings({ reviewEnabled: true, aiEnabled: true });
    menu = clickMore(root);
    expect(menu.items.some(item => item.title === plugin.t('review'))).toBe(false);
    (root.querySelector('button[aria-label="导航"]') as HTMLButtonElement).click();
    expect(root.querySelector('button[aria-label="随便翻翻"]')).toBeTruthy();
    expect(menu.items.some(item => item.title === '根据这些小记回答')).toBe(false);
    expect(root.querySelector('button[aria-label="询问小记"]')).toBeTruthy();
  });
  it('switches archive range without moving records', async () => {
    const { root } = await setup();
    const archive = [...root.querySelectorAll<HTMLButtonElement>('.xj-top-nav button')].find(button => button.textContent === '归档')!;
    archive.click(); await flush();
    expect(root.querySelectorAll('.xj-card')).toHaveLength(1);
    expect(root.querySelector('.xj-card-body')!.textContent).toContain('旧记录');
  });
  it('matches all keywords inside one memo rather than combining records', async () => {
    const { root } = await setup();
    const input = root.querySelector<HTMLInputElement>('.xj-search')!;
    input.value = '教学 反馈'; input.dispatchEvent(new Event('input', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 250));
    expect(root.querySelectorAll('.xj-card')).toHaveLength(1);
    expect(root.querySelector('.xj-card-body')!.textContent).toContain('教学反馈');
  });
  it('shows a nonfavorite current view even in a narrow panel', async () => {
    const { root, plugin, view } = await setup();
    await plugin.updateSettings({ nav: [...plugin.prefs.nav, { id: 'teaching', kind: 'tag', tag: '教学', title: '教学资料', favorite: false }] });
    (root.querySelector('button[aria-label="导航"]') as HTMLButtonElement).click();
    (root.querySelector('button[aria-label="教学资料"]') as HTMLButtonElement).click();
    (root.querySelector('button[aria-label="导航"]') as HTMLButtonElement).click();
    const resize = ResizeMock.instances.at(-1)!;
    resize.trigger(330); await flush();
    expect(root.querySelector('.xj-top-nav')!.textContent).toContain('教学资料');
    expect(view.getState().currentId).toBe('teaching');
  });
  it('keeps top navigation visible beside an explicitly opened sidebar and narrow overlay', async () => {
    const { root } = await setup({ navigation: 'sidebar', sidebar: 'open' });
    expect(root.querySelector('.xj-root')!.classList.contains('has-sidebar')).toBe(true);
    expect(root.querySelectorAll('.xj-top-nav button')).toHaveLength(2);
    expect(root.querySelectorAll('.xj-sidebar-item')).toHaveLength(6);
    ResizeMock.instances.at(-1)!.trigger(500);
    expect(root.querySelector('.xj-root')!.classList.contains('has-drawer')).toBe(true);
    (root.querySelector('.xj-sidebar-backdrop') as HTMLElement).click();
    expect(root.querySelector('.xj-root')!.classList.contains('has-drawer')).toBe(false);
  });
  it('keeps the user choice while resizing between sidebar and drawer', async () => {
    const { root, view } = await setup();
    await view.setState({ sidebarOpen: true }, {} as ViewStateResult);
    const observer = ResizeMock.instances.at(-1)!;
    for (const width of [950, 890, 950, 1000]) {
      observer.trigger(width); expect(view.getState().sidebarOpen).toBe(true);
      expect(root.querySelector('.xj-root')!.classList.contains(width < 900 ? 'has-drawer' : 'has-sidebar')).toBe(true);
    }
  });
  it('preserves existing card elements and drafts on an unrelated notification', async () => {
    const { root, plugin } = await setup();
    const card = root.querySelector('.xj-card');
    const editor = root.querySelector('.cm-content')!;
    expect(editor).toBeTruthy();
    plugin.notify(); await flush();
    expect(root.querySelector('.xj-card')).toBe(card);
    expect(root.querySelector('.cm-content')).toBe(editor);
  });
  it('keeps selected records across layout changes', async () => {
    const { root, plugin } = await setup();
    root.querySelector('.xj-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    Menu.last!.items.find(item => item.title === plugin.t('select'))!.callback();
    expect(root.querySelector('.xj-card.is-selected')).toBeTruthy();
    await plugin.updateSettings({ layout: 'list' });
    expect(root.querySelector('.xj-card.is-selected')).toBeTruthy();
    expect(root.querySelector('.xj-selection-count')!.textContent).toContain('1');
  });
  it('persists native task checkbox changes in Markdown', async () => {
    const { root, plugin, errors } = await setup();
    const checkbox = root.querySelector<HTMLInputElement>('.task-list-item-checkbox:not(:checked)')!;
    checkbox.click(); await flush();
    expect(plugin.repo.records.find(memo => memo.body.includes('准备课件'))!.tasks.incomplete).toBe(0);
    expect(errors).toEqual([]);
  });
  it('keeps mobile capture in the same page and same editor', async () => {
    Platform.isMobile = true;
    const { root } = await setup();
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(root.querySelector('.xj-root')!.classList.contains('is-mobile')).toBe(true);
  });
  it('updates interface language and preserves user-provided navigation text', async () => {
    const { root, plugin } = await setup();
    await plugin.updateSettings({ language: 'en', nav: [...plugin.prefs.nav, { id: 'mine', kind: 'tag', title: '我的教学', tag: '教学', favorite: true }] });
    await flush();
    expect(root.querySelector('.xj-top-nav')!.textContent).toContain('Memos');
    expect(root.querySelector('.xj-top-nav')!.textContent).toContain('我的教学');
    expect(root.querySelector('.xj-composer-actions')!.textContent).toContain('Save memo');
  });
  it('restores view scope and a persistent draft key', async () => {
    const { view, root, plugin } = await setup();
    plugin.setDraft('restored-draft', '未保存内容');
    await view.setState({ currentId: 'archive', draftKey: 'restored-draft', query: '', allScope: false }, {} as ViewStateResult);
    expect(view.getState().draftKey).toBe('restored-draft');
    expect(root.querySelector('.cm-content')!.textContent).toContain('未保存内容');
    expect(root.querySelector('.xj-card-body')!.textContent).toContain('旧记录');
  });
});

describe('settings and forms', () => {
  it('submits the text dialog exactly once', async () => {
    const { plugin } = await makeFixture();
    let calls = 0;
    const modal = new TextModal(plugin, '名称', [{ label: '名称', value: '教学' }], () => { calls++; });
    modal.open();
    (modal.contentEl.querySelector('button[type="submit"]') as HTMLButtonElement).click();
    await flush(); expect(calls).toBe(1);
  });
  it('offers native previews and preserves the last valid folder during invalid input', async () => {
    const { plugin, errors } = await makeFixture();
    const tab = new XiaojiSettings(plugin.app, plugin);
    document.body.append(tab.containerEl); tab.display();
    expect(tab.containerEl.querySelector('.xj-storage-preview')!.textContent).toContain('小记.md');
    const folder = tab.containerEl.querySelector<HTMLInputElement>('.setting-item input')!;
    folder.value = '../错误目录'; folder.dispatchEvent(new Event('input'));
    expect(plugin.prefs.folder).toBe('小记');
    folder.dispatchEvent(new Event('blur')); await flush();
    expect(plugin.prefs.folder).toBe('小记'); expect(folder.getAttribute('aria-invalid')).toBe('true'); expect(errors).toEqual([]);
    tab.hide();
  });
});

describe('fixed capture workflow', () => {
  it('keeps capture outside the feed scroller and has no preview button', async () => {
    const { root } = await setup();
    expect(root.querySelector('.xj-scroller .xj-composer-wrap')).toBeNull();
    expect(root.querySelector('.xj-main > .xj-composer-wrap')).toBeTruthy();
    expect(root.querySelector('button[aria-label="预览"]')).toBeNull();
    expect(root.querySelector('button[aria-label="添加待办"]')).toBeTruthy();
  });
  it('inserts references on a new line without overwriting current input', async () => {
    const { root, plugin } = await setup(), editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    editor.dispatch({ changes: { from: 0, insert: '当前内容' } });
    root.querySelector('.xj-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    Menu.last!.items.find(item => item.title === '引用')!.callback();
    expect(editor.state.doc.toString()).toBe('当前内容\n@' + plugin.repo.records[0]!.id);
  });
  it('seeds only an empty capture with the selected tag and preserves typed content on switching', async () => {
    const { root } = await setup({ navigation: 'sidebar', sidebar: 'open' });
    (root.querySelector('button[title="#教学/反思"]') as HTMLButtonElement).click();
    let editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    expect(editor.state.doc.toString()).toBe('\n#教学/反思');
    (root.querySelector('button[title="#备课"]') as HTMLButtonElement).click();
    expect(editor.state.doc.toString()).toBe('\n#备课');
    editor.dispatch({ changes: { from: 0, insert: '已经输入正文' } });
    (root.querySelector('button[title="#教学/反思"]') as HTMLButtonElement).click();
    editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    expect(editor.state.doc.toString()).toBe('已经输入正文\n#备课');
  });
  it('clicking a card body in selection mode toggles selection without changing tasks', async () => {
    const { root, plugin } = await setup();
    root.querySelector('.xj-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    Menu.last!.items.find(item => item.title === '选择多条')!.callback();
    const before = plugin.repo.records.map(memo => memo.raw);
    const card = root.querySelectorAll('.xj-card')[1]!;
    (card.querySelector('.xj-card-body') as HTMLElement).click();
    expect(card.classList.contains('is-selected')).toBe(true);
    (card.querySelector('.xj-card-body') as HTMLElement).click();
    expect(card.classList.contains('is-selected')).toBe(false);
    expect(plugin.repo.records.map(memo => memo.raw)).toEqual(before);
  });
  it('moves a memo into recycle immediately without confirmation', async () => {
    const { root, plugin } = await setup();
    const count = plugin.repo.records.length;
    root.querySelector('.xj-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    Menu.last!.items.find(item => item.title === '移入回收站')!.callback(); await flush();
    expect(document.querySelector('.modal')).toBeNull();
    expect(plugin.repo.records).toHaveLength(count - 1);
    expect(await plugin.repo.listTrash()).toHaveLength(1);
  });
  it('adds a task at the active line and keeps valid Markdown', async () => {
    const { root } = await setup();
    (root.querySelector('button[aria-label="添加待办"]') as HTMLButtonElement).click();
    const editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    expect(editor.state.doc.toString()).toBe('- [ ] ');
  });
});

describe('V2 direct editing and navigation', () => {
  it('renders only real ID references, ignoring code and existing links', async () => {
    const { plugin } = await makeFixture();
    const preview = new ReferencePreview(plugin); previews.push(preview); plugin.bindReferences = root => preview.bind(root);
    const open = vi.fn(async () => undefined); plugin.openMemo = open;
    const body = document.createElement('div');
    body.innerHTML = '<p>参照 @20261021120000001</p><code>@20261021120000001</code><a href="#">@20261021120000001</a><p>mail@20261021120000001</p>';
    XiaojiPlugin.prototype.renderReferences.call(plugin, body);
    expect(body.querySelectorAll('.xj-reference')).toHaveLength(1);
    (body.querySelector('.xj-reference') as HTMLAnchorElement).click();
    await flush(); expect(open).toHaveBeenCalledWith('20261021120000001');
    XiaojiPlugin.prototype.renderReferences.call(plugin, body);
    expect(body.querySelectorAll('.xj-reference')).toHaveLength(1);
  });
  it('double-click edits in the single top composer and restores unsubmitted capture text after save', async () => {
    const { root, plugin, view } = await setup();
    const original = plugin.repo.records[0]!;
    let editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    editor.dispatch({ changes: { from: 0, insert: '还没提交的新想法' } });
    root.querySelector('.xj-card')!.dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }));
    await flush();
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(document.querySelector('.modal')).toBeNull();
    expect(root.querySelector('.xj-editing-heading')?.textContent).toContain('正在编辑');
    editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: original.body + '\n修改保留原 ID' } });
    (root.querySelector('.xj-submit') as HTMLButtonElement).click(); await flush();
    expect(plugin.repo.records.find(memo => memo.id === original.id)?.body).toContain('修改保留原 ID');
    expect(root.querySelector('.xj-editing-heading')).toBeNull();
    expect(root.querySelector('.cm-content')?.textContent).toContain('还没提交的新想法');
    expect(view.getState().draftKey).toBe('composer-main');
  });
  it('keeps a conflicting edit in the composer without overwriting external changes', async () => {
    const { root, plugin, view } = await setup();
    const memo = plugin.repo.records[0]!;
    await view.editMemo(memo);
    const editor = EditorView.findFromDOM(root.querySelector('.cm-editor')!)!;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: '尚未保存的修改' } });
    await plugin.repo.edit(memo, '外部窗口的新版本');
    (root.querySelector('.xj-submit') as HTMLButtonElement).click(); await flush();
    expect(plugin.repo.records.find(item => item.id === memo.id)?.body).toBe('外部窗口的新版本');
    expect(root.querySelector('.cm-content')?.textContent).toContain('尚未保存的修改');
    expect(root.querySelector('.xj-editing-heading')).toBeTruthy();
  });
  it('cancel restores capture text and switching records cannot silently discard the current edit', async () => {
    const { root, plugin, view } = await setup();
    const [first, second] = plugin.repo.records;
    await view.editMemo(first!); await view.editMemo(second!);
    expect(root.querySelector('.cm-content')?.textContent).toContain(first!.body.split('\n')[0]);
    (root.querySelector('.xj-editing-heading button') as HTMLButtonElement).click(); await flush();
    expect(root.querySelector('.xj-editing-heading')).toBeNull();
    expect(plugin.repo.records.find(memo => memo.id === first!.id)?.body).toBe(first!.body);
  });
  it('pin puts the record in a separate first region and unpin restores chronology', async () => {
    const { root, plugin } = await setup();
    const oldest = plugin.repo.records.filter(memo => !memo.archived).at(-1)!;
    await plugin.repo.setPinned(oldest, true); await plugin.refresh(); await flush();
    expect(root.querySelector('.xj-pinned-feed time')?.getAttribute('title')).toBe(oldest.id);
    expect(root.querySelectorAll('.xj-regular-feed .xj-card')).toHaveLength(2);
    await plugin.repo.setPinned(plugin.repo.records.find(memo => memo.id === oldest.id)!, false);
    await plugin.refresh();
    expect((root.querySelector('.xj-pinned-feed') as HTMLElement).hidden).toBe(true);
    expect(root.querySelector('.xj-regular-feed time')?.getAttribute('title')).toBe(plugin.repo.records[0]!.id);
  });
  it('expand keeps the same editor and no longer opens a modal or resizable duplicate', async () => {
    const { root } = await setup();
    const editor = root.querySelector('.cm-editor');
    const button = root.querySelector('button[aria-label="展开编辑"]') as HTMLButtonElement;
    button.click(); expect(button.getAttribute('aria-expanded')).toBe('true');
    expect(root.querySelectorAll('.cm-editor')).toHaveLength(1);
    expect(root.querySelector('.cm-editor')).toBe(editor);
    expect(root.querySelector('.xj-composer.is-expanded')).toBeTruthy();
    button.click(); expect(button.getAttribute('aria-expanded')).toBe('false');
  });
  it('shows nested native tags, deduplicates parent counts and filters descendants', async () => {
    const { root, plugin } = await setup({ navigation: 'sidebar', sidebar: 'open' });
    const memo = plugin.repo.records[0]!;
    await plugin.repo.edit(memo, memo.body + '\n#教学 #教学/反思/课堂'); await plugin.refresh(); await flush();
    const parent = root.querySelector('button[title="#教学"]') as HTMLButtonElement;
    expect(parent.parentElement?.querySelector('.xj-tag-count')?.textContent).toBe('1');
    expect(root.querySelector('button[title="#教学/反思/课堂"]')).toBeTruthy();
    parent.click();
    expect(root.querySelectorAll('.xj-card')).toHaveLength(1);
    expect(root.querySelector('.xj-top-nav')?.textContent).toContain('#教学');
    (root.querySelector('.xj-tag-toggle') as HTMLButtonElement).click();
    expect(root.querySelector('button[title="#教学/反思/课堂"]')).toBeNull();
  });
  it('opens recycle bin inside the page and restores original memo identity', async () => {
    const { root, plugin, view } = await setup();
    const memo = plugin.repo.records[0]!;
    await plugin.repo.delete(memo); await plugin.refresh(); view.navigate('trash'); await flush();
    expect(root.querySelector('.xj-trash-panel')).toBeTruthy();
    expect(document.querySelector('.modal')).toBeNull();
    expect((root.querySelector('.xj-composer-wrap') as HTMLElement).hidden).toBe(true);
    (root.querySelector('.xj-trash-entry button[aria-label="恢复"]') as HTMLButtonElement).click(); await flush();
    expect(plugin.repo.records.find(item => item.id === memo.id)?.body).toBe(memo.body);
    expect(root.querySelectorAll('.xj-trash-entry')).toHaveLength(0);
  });
  it('has a compact tools menu and exactly one ID reference action', async () => {
    const { root, plugin } = await setup({ aiEnabled: true });
    const menu = clickMore(root);
    for (const label of ['保存当前筛选', '根据这些小记回答', '整理成正式笔记', '草稿', '复制小记链接']) {
      expect(menu.items.some(item => item.title === label)).toBe(false);
    }
    const copy = vi.fn(); plugin.clipboard = copy;
    root.querySelector('.xj-card')!.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }));
    const reference = Menu.last!.items.find(item => item.title === '引用')!;
    await reference.callback();
    expect(root.querySelector('.cm-content')?.textContent).toContain('@' + plugin.repo.records[0]!.id);
    expect(copy).not.toHaveBeenCalled();
    expect(Menu.last!.items.some(item => item.title.includes('原生块'))).toBe(false);
  });
  it('only shows the back-to-top control after scrolling and returns to zero', async () => {
    const { root } = await setup();
    const scroll = root.querySelector('.xj-scroller') as HTMLElement, top = root.querySelector('.xj-back-top') as HTMLButtonElement;
    expect(top.hidden).toBe(true);
    scroll.scrollTop = 500; scroll.dispatchEvent(new Event('scroll'));
    expect(top.hidden).toBe(false); top.click();
    expect(scroll.scrollTop).toBe(0); expect(top.hidden).toBe(true);
  });
  it('opens AI within the page and plans the question before sending bounded evidence', async () => {
    const { root, view, plugin } = await setup({ aiEnabled: true, aiModel: 'test' });
    const requests: any[] = [];
    plugin.apiKey = () => 'test-key';
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn(async (_url, init) => {
      const body = JSON.parse(init!.body as string); requests.push(body);
      return new Response(JSON.stringify({ choices: [{ message: { content: requests.length === 1 ?
        '{"queries":["教学 课堂"]}' : '依据课堂小记，应留出思考时间。[1]' } }] }), { headers: { 'content-type': 'application/json' } });
    });
    try {
      view.navigate('ask');
      expect(document.querySelector('.modal')).toBeNull();
      const input = root.querySelector('.xj-ask-panel textarea') as HTMLTextAreaElement;
      input.value = '如何改善课堂教学？';
      (root.querySelector('.xj-ask-panel button[aria-label="提问"]') as HTMLButtonElement).click();
      await flush(); await flush();
      expect(requests).toHaveLength(2);
      expect(requests[0].messages[1].content).toBe('如何改善课堂教学？');
      expect(requests[0].messages[1].content).not.toContain('好的课堂提问');
      expect(requests[1].messages.at(-1).content).toContain('Local context');
      expect(requests[1].messages[1].content).not.toContain('旧记录内容');
      expect(root.querySelector('.xj-ai-answer')?.textContent).toContain('留出思考时间');
      expect(root.querySelector('.xj-evidence-link')?.textContent).toBe('[1]');
    } finally { globalThis.fetch = originalFetch; }
  });
  it('stops question planning without sending a second request or modifying any memo', async () => {
    const { root, view, plugin } = await setup({ aiEnabled: true, aiModel: 'test' });
    const before = plugin.repo.records.map(memo => memo.raw); plugin.apiKey = () => 'test-key';
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = vi.fn((_url, init) => {
      calls++;
      return new Promise<Response>((_resolve, reject) => init!.signal!.addEventListener('abort', () =>
        reject(new DOMException('Aborted', 'AbortError')), { once: true }));
    });
    try {
      view.navigate('ask');
      (root.querySelector('.xj-ask-panel textarea') as HTMLTextAreaElement).value = '课堂';
      (root.querySelector('.xj-ask-panel button[aria-label="提问"]') as HTMLButtonElement).click();
      await flush();
      (root.querySelector('.xj-ask-panel button[aria-label="停止"]') as HTMLButtonElement).click();
      await flush();
      expect(calls).toBe(1); expect(plugin.repo.records.map(memo => memo.raw)).toEqual(before);
      expect(root.querySelector('.xj-ask-panel [role="status"]')?.textContent).toBe('');
    } finally { globalThis.fetch = original; }
  });
  it('changes AI language without losing the question typed in the page', async () => {
    const { root, view, plugin } = await setup({ aiEnabled: true });
    view.navigate('ask');
    (root.querySelector('.xj-ask-panel textarea') as HTMLTextAreaElement).value = '尚未发送的问题';
    await plugin.updateSettings({ language: 'en' });
    expect(root.querySelector('.xj-chat-title')?.textContent).toBe('Ask your memos');
    expect((root.querySelector('.xj-ask-panel textarea') as HTMLTextAreaElement).value).toBe('尚未发送的问题');
  });
  it('falls back to local retrieval when planning returns invalid JSON', async () => {
    const { root, view, plugin } = await setup({ aiEnabled: true, aiModel: 'test' });
    plugin.apiKey = () => 'synthetic-key';
    const original = globalThis.fetch; let calls = 0;
    globalThis.fetch = vi.fn(async () => new Response(JSON.stringify({ choices: [{ message: {
      content: ++calls === 1 ? 'not JSON' : '应给学生思考时间。[1]',
    } }] }), { headers: { 'content-type': 'application/json' } }));
    try {
      view.navigate('ask'); (root.querySelector('.xj-ask-panel textarea') as HTMLTextAreaElement).value = '课堂提问';
      (root.querySelector('.xj-ask-panel button[aria-label="提问"]') as HTMLButtonElement).click(); await flush(); await flush();
      expect(calls).toBe(2);
      expect(root.querySelector('.xj-ask-panel [role="status"]')?.textContent).toBe('');
      expect(root.querySelector('.xj-ai-answer')?.textContent).toContain('思考时间');
    } finally { globalThis.fetch = original; }
  });
});


describe('independent input keys and reusable quick capture', () => {
  it('supports a custom letter chord for submit and a separate newline without replacing the editor', async () => {
    const { root, plugin } = await setup();
    const dom = root.querySelector<HTMLElement>('.cm-editor')!, editor = EditorView.findFromDOM(dom)!;
    editor.dispatch({ changes: { from: 0, insert: '第一行' } }); editor.dispatch({ selection: { anchor: editor.state.doc.length } });
    await plugin.updateSettings({ submitKey: 'Mod-K', newlineKey: 'Alt-Enter' });
    expect(root.querySelector('.cm-editor')).toBe(dom);
    editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true }));
    expect(editor.state.doc.toString()).toBe('第一行\n');
    const count = plugin.repo.records.length;
    editor.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true }));
    await flush(); await flush(); expect(plugin.repo.records.length).toBe(count + 1);
  });
  it('uses the same configured newline in AI textarea and does not submit during IME composition', async () => {
    const { root, view } = await setup({ aiEnabled: true, submitKey: 'Mod-K', newlineKey: 'Alt-Enter' }); view.navigate('ask');
    const input = root.querySelector<HTMLTextAreaElement>('.xj-ask-panel textarea')!; input.value = '2026-10-21 记了几条小记'; input.setSelectionRange(input.value.length, input.value.length);
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', altKey: true, bubbles: true, cancelable: true })); expect(input.value.endsWith('\n')).toBe(true);
    input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); await flush(); expect(root.querySelector('.xj-chat-turn')).toBeNull();
    input.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); await flush(); await flush(); expect(root.querySelectorAll('.xj-chat-turn')).toHaveLength(1);
  });
  it('records shortcuts and rejects assigning the newline chord to submit', async () => {
    const { plugin, errors } = await makeFixture(); const settings = new XiaojiSettings(plugin.app, plugin); settings.display();
    [...settings.containerEl.querySelectorAll<HTMLButtonElement>('nav button')].find(button => button.textContent === '通用')!.click(); await flush();
    const recorders = settings.containerEl.querySelectorAll<HTMLButtonElement>('.xj-shortcut-recorder');
    recorders[0]!.click(); recorders[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
    expect(plugin.prefs.submitKey).toBe('Shift-Enter'); expect(errors).toHaveLength(1);
    recorders[0]!.dispatchEvent(new KeyboardEvent('keydown', { key: 'k', ctrlKey: true, bubbles: true, cancelable: true })); await flush();
    expect(plugin.prefs.submitKey).toBe('Mod-K'); expect(recorders[0]!.textContent).toContain('K');
  });
  it('quick capture reflects changed keys, saves once and restores focus', async () => {
    const { plugin } = await makeFixture(); const view = new QuickView({ app: plugin.app } as unknown as WorkspaceLeaf, plugin); quickViews.push(view); document.body.append(view.containerEl); await view.onOpen();
    const editor = EditorView.findFromDOM(view.contentEl.querySelector<HTMLElement>('.cm-editor')!)!;
    editor.dispatch({ changes: { from: 0, insert: '快速记录内容' } });
    await plugin.updateSettings({ submitKey: 'Mod-K', newlineKey: 'Alt-Enter' });
    expect(view.contentEl.querySelector<HTMLButtonElement>('.xj-submit')!.title).toContain('K'); const count = plugin.repo.records.length;
    view.contentEl.querySelector<HTMLButtonElement>('.xj-submit')!.click(); await flush(); await flush();
    expect(plugin.repo.records.length).toBe(count + 1); expect(editor.state.doc.toString()).toBe(''); expect(editor.hasFocus).toBe(true);
  });
  it('reopening quick capture restores its own draft without main capture adopting it', async () => {
    const { plugin } = await makeFixture(); const quick = new QuickView({ app: plugin.app } as unknown as WorkspaceLeaf, plugin); quickViews.push(quick); document.body.append(quick.containerEl); await quick.onOpen();
    EditorView.findFromDOM(quick.contentEl.querySelector<HTMLElement>('.cm-editor')!)!.dispatch({ changes: { from: 0, insert: '小窗草稿' } });
    await quick.onClose();
    const main = new MemoView({ app: plugin.app } as unknown as WorkspaceLeaf, plugin); opened.push(main); document.body.append(main.containerEl); await main.onOpen();
    expect(EditorView.findFromDOM(main.contentEl.querySelector<HTMLElement>('.cm-editor')!)!.state.doc.toString()).toBe('');
    const next = new QuickView({ app: plugin.app } as unknown as WorkspaceLeaf, plugin); quickViews.push(next); document.body.append(next.containerEl); await next.onOpen();
    expect(EditorView.findFromDOM(next.contentEl.querySelector<HTMLElement>('.cm-editor')!)!.state.doc.toString()).toBe('小窗草稿');
  });
  it('serializes concurrent quick-window opens and focuses the existing leaf on later calls', async () => {
    const fixture = await makeFixture({ quickPin: false });
    const leaf: any = { view: { containerEl: document.createElement('div'), focusEditor: vi.fn() } };
    let resolve!: () => void; const gate = new Promise<void>(done => { resolve = done; });
    const workspace: any = { getLeavesOfType: vi.fn(() => []), openPopoutLeaf: vi.fn(() => leaf), revealLeaf: vi.fn(async () => undefined) };
    leaf.setViewState = vi.fn(async () => { await gate; workspace.getLeavesOfType.mockReturnValue([leaf]); });
    const plugin = new XiaojiPlugin({ ...fixture.plugin.app, workspace } as any, fixture.plugin.manifest); plugin.data = fixture.plugin.data;
    vi.spyOn(window, 'focus').mockImplementation(() => undefined);
    const first = plugin.openQuick(), second = plugin.openQuick(); resolve(); await Promise.all([first, second]);
    expect(workspace.openPopoutLeaf).toHaveBeenCalledTimes(1);
    await plugin.openQuick(); expect(workspace.openPopoutLeaf).toHaveBeenCalledTimes(1); expect(workspace.revealLeaf).toHaveBeenCalledWith(leaf);
  });
});
