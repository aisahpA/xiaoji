// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadSettings } from '../src/core/settings';
import { appendMemo, parseMemos, serializeMemo } from '../src/core/markdown';
import { headingForDate, fileForDate, validateStorageSettings } from '../src/core/dates';
import { Repository } from '../src/core/repository';
import { TrashStore } from '../src/core/trash-store';
import { FixtureFiles, makeFixture } from './fixture';
import { AskPanel } from '../src/ui/chat-panel';
import { compactQuickWindow } from '../src/ui/quick-chrome';
const panels: AskPanel[] = [];
afterEach(() => { for (const panel of panels.splice(0)) panel.unload(); document.body.replaceChildren(); vi.restoreAllMocks(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 10));
const setup = async () => {
  const fixture = await makeFixture({ aiEnabled: true, saveConversations: false, aiModel: 'test-model' });
  fixture.plugin.apiKey = () => 'synthetic';
  const root = document.createElement('div'); document.body.append(root);
  const panel = new AskPanel(root, fixture.plugin); panels.push(panel);
  return { ...fixture, root, panel };
};
const send = async (root: HTMLElement, question: string) => {
  root.querySelector('textarea')!.value = question;
  root.querySelector<HTMLButtonElement>('.xj-chat-submit')!.click();
  for (let i = 0; i < 100; i++) { await tick(); if (!root.querySelector('textarea')!.disabled) return; }
  throw Error('Chat timed out');
};
describe('heading-free storage', () => {
  it.each(['month', 'quarter', 'year'] as const)('keeps %s filenames and full record bodies without temporal headings', async period => {
    const prefs = loadSettings({ grouping: 'none', period }); const files = new FixtureFiles();
    let now = new Date(2026, 9, 21, 10);
    const repo = new Repository(files, new TrashStore(files, () => prefs.folder), () => prefs, () => now);
    validateStorageSettings(prefs); expect(headingForDate(now, prefs)).toBe('');
    const one = await repo.create('# 正文标题\n\n- [ ] 任务');
    now = new Date(2026, 9, 22, 11); const two = await repo.create('第二条');
    expect(one.path).toBe(fileForDate(now, prefs)); expect(two.path).toBe(one.path);
    const source = await files.read(one.path);
    expect(source).toBe(serializeMemo(one.id, one.body) + '\n\n' + serializeMemo(two.id, two.body) + '\n');
    const trashed = await repo.delete(one); const restored = await repo.restore(trashed);
    expect(restored.id).toBe(one.id); expect(restored.body).toBe(one.body);
    expect((await files.read(one.path))).not.toMatch(/^#{1,6} /m);
    expect(await repo.scan()).toHaveLength(2);
  });
  it('preserves old headings and CRLF when switching off grouping', () => {
    const prefs = loadSettings({ grouping: 'none' });
    const old = '### 旧标题\r\n\r\n- 20261021110000000\r\n  旧正文\r\n';
    const next = appendMemo(old, serializeMemo('20261022110000000', '新正文', {}, '\r\n'), Date.now(), prefs, '');
    expect(next.startsWith(old)).toBe(true); expect(next.match(/^### /gm)).toHaveLength(1);
    expect(parseMemos(next, 'memo.md').map(m => m.body)).toEqual(['旧正文', '新正文']);
  });
});
describe('compact sources and stable chat controls', () => {
  it('collapses sources, opens them through citations and preserves expansion after another answer', async () => {
    const { root, panel, plugin } = await setup();
    const source = { number: 1, memo: plugin.repo.records[0]!, content: plugin.repo.records[0]!.body };
    const chat: any = { id: '20261022110000000', title: '引用', turns: [{ id: '20261022110000001', question: '问题', answer: '回答 [1]', sources: [source], status: 'complete' }] };
    (panel as any).chat = chat; await (panel as any).draw();
    const group = root.querySelector<HTMLDetailsElement>('.xj-chat-sources')!;
    expect(group.open).toBe(false); expect(group.querySelector('.xj-markdown')?.textContent).toBe('');
    const scroll = vi.fn(); root.querySelector<HTMLElement>('.xj-chat-source')!.scrollIntoView = scroll;
    root.querySelector<HTMLAnchorElement>('.xj-evidence-link')!.click(); await tick();
    expect(group.querySelector('.xj-markdown')?.textContent?.replace(/\s/g, '')).toBe(source.memo.body.replace(/\s/g, ''));
    expect(group.open).toBe(true); expect(scroll).toHaveBeenCalled(); expect(root.querySelector('.is-highlighted')).not.toBeNull();
    chat.turns.push({ id: '20261022110000002', question: '第二问', answer: '回答', sources: [source], status: 'complete' });
    await (panel as any).draw();
    expect([...root.querySelectorAll<HTMLDetailsElement>('details')].map(g => g.open)).toEqual([true, false]);
    root.querySelector<HTMLDetailsElement>('details')!.open = false; await (panel as any).draw();
    expect(root.querySelector<HTMLDetailsElement>('details')!.open).toBe(false);
  });
  it('uses exactly one enabled submit/stop control through planning, cancellation and completion', async () => {
    const { root } = await setup();
    vi.spyOn(globalThis, 'fetch').mockImplementation((_url, init) => new Promise((_resolve, reject) => init!.signal!.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })));
    const input = root.querySelector('textarea')!, button = root.querySelector<HTMLButtonElement>('.xj-chat-submit')!;
    const tools = root.querySelector('.xj-chat-compose-tools')!, count = tools.children.length;
    input.value = '查找课堂小记'; button.click(); await tick(); await tick();
    expect(button.textContent).toBe('停止'); expect(button.disabled).toBe(false);
    expect(tools.children.length).toBe(count); expect(root.querySelectorAll('.xj-chat-submit')).toHaveLength(1);
    button.click(); await tick(); await tick();
    expect(button.textContent).toBe('提问'); expect(button.disabled).toBe(false); expect(input.disabled).toBe(false);
    expect(tools.children.length).toBe(count); expect(root.querySelector('[role="status"]')?.textContent).toBe('');
  });
  it('does not create an empty sources disclosure for plain answers', async () => {
    const { root } = await setup(); await send(root, '你是什么模型');
    expect(root.querySelector('.xj-chat-sources')).toBeNull();
  });
});
describe('dedicated quick window', () => {
  it('restores all host chrome when another view joins and on teardown', async () => {
    const leaf = document.createElement('div'); leaf.className = 'workspace-leaf-content'; leaf.dataset.type = 'xiaoji-quick-capture'; document.body.append(leaf);
    const cleanup = compactQuickWindow(document, true);
    expect(document.body.classList.contains('xj-quick-native-controls')).toBe(true);
    const other = leaf.cloneNode() as HTMLElement; other.dataset.type = 'markdown'; document.body.append(other); await tick();
    expect(document.body.classList.contains('xj-quick-window')).toBe(false);
    other.remove(); await tick(); expect(document.body.classList.contains('xj-quick-window')).toBe(true);
    cleanup(); expect(document.body.classList.contains('xj-quick-window')).toBe(false);
  });
  it('retains native titlebar when window controls are unavailable', () => {
    document.body.innerHTML = '<div class="workspace-leaf-content" data-type="xiaoji-quick-capture"></div>';
    const cleanup = compactQuickWindow(document, false);
    expect(document.body.classList.contains('xj-quick-window')).toBe(true);
    expect(document.body.classList.contains('xj-quick-native-controls')).toBe(false); cleanup();
  });
});
