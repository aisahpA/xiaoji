// @vitest-environment jsdom
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { MemoEditor } from '../src/ui/editor';
import { XiaojiSettings } from '../src/ui/settings';
import XiaojiPlugin from '../src/main';
import { makeFixture } from './fixture';

const editors: MemoEditor[] = [];
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
});
afterEach(() => { for (const editor of editors.splice(0)) editor.unload(); document.body.replaceChildren(); document.body.className = ''; vi.useRealTimers(); });
describe('0.16.3 theme and desktop settings', () => {
  it('updates the dark facet without replacing the editor or losing undo and selection', async () => {
    const { plugin } = await makeFixture(); const host = document.createElement('div'); document.body.append(host);
    const editor = new MemoEditor(host, plugin, { value: '原文', sourcePath: '', onChange: () => undefined, onSubmit: () => undefined }); editors.push(editor);
    const view = editor.view;
    view.dispatch({ changes: { from: 2, insert: '新增' }, selection: { anchor: 4 } });
    document.body.classList.add('theme-dark'); await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.state.facet(EditorView.darkTheme)).toBe(true); expect(editor.view).toBe(view);
    expect(view.state.selection.main.anchor).toBe(4); expect(view.state.doc.toString()).toBe('原文新增');
    expect(undo(view)).toBe(true); expect(view.state.doc.toString()).toBe('原文');
    document.body.classList.remove('theme-dark'); await new Promise(resolve => setTimeout(resolve, 0));
    expect(view.state.facet(EditorView.darkTheme)).toBe(false);
  });
  it('keeps API credentials out of the Codex settings and updates its model catalog in place', async () => {
    const { plugin } = await makeFixture({ aiEnabled: true, aiProvider: 'codex' });
    plugin.inspectCodex = vi.fn(async () => ({ model: 'gpt-6.1-sol', models: [{ id: 'older-model', name: 'Older model' }] }));
    const settings = new XiaojiSettings(plugin.app, plugin); document.body.append(settings.containerEl); settings.display();
    const tab = [...settings.containerEl.querySelectorAll('nav button')].find(button => button.textContent === 'AI') as HTMLButtonElement;
    tab.click(); await new Promise(resolve => setTimeout(resolve, 0));
    expect(settings.containerEl.querySelector('input[type="password"]')).toBeNull();
    const check = [...settings.containerEl.querySelectorAll('button')].find(button => button.textContent === plugin.t('codexConnect'))!;
    check.click(); await vi.waitFor(() => expect(settings.containerEl.textContent).toContain('连接就绪'));
    expect(settings.containerEl.querySelector('option[value="gpt-6.1-sol"]')).not.toBeNull();
    expect(settings.containerEl.querySelector('option[value=""]')?.textContent).toContain('gpt-6.1-sol');
    expect(plugin.prefs.codexModel).toBe('');
    expect(check.isConnected).toBe(true); settings.hide();
  });
  it('flushes a pending custom model before validation and cancels validation when settings close', async () => {
    const { plugin } = await makeFixture({ aiEnabled: true, aiProvider: 'codex' });
    let signal!: AbortSignal;
    plugin.verifyCodexModel = vi.fn(async current => { signal = current; await new Promise<void>((_resolve, reject) => current.addEventListener('abort', () => reject(new DOMException('Aborted', 'AbortError')), { once: true })); });
    const settings = new XiaojiSettings(plugin.app, plugin); document.body.append(settings.containerEl); settings.display();
    ([...settings.containerEl.querySelectorAll('nav button')].find(button => button.textContent === 'AI') as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const advanced = settings.containerEl.querySelector('details')!;
    const inputs = advanced.querySelectorAll('input'); const model = inputs[inputs.length - 1]!;
    model.value = 'gpt-6.1-sol'; model.dispatchEvent(new Event('input', { bubbles: true }));
    ([...advanced.querySelectorAll('button')].find(button => button.textContent === plugin.t('codexValidateModel')) as HTMLButtonElement).click();
    await vi.waitFor(() => expect(plugin.verifyCodexModel).toHaveBeenCalledOnce());
    expect(plugin.prefs.codexModel).toBe('gpt-6.1-sol'); expect(signal.aborted).toBe(false);
    settings.hide(); expect(signal.aborted).toBe(true);
  });
  it('restores a paused global shortcut when its recorder is cancelled or settings close', async () => {
    const { plugin } = await makeFixture({ captureKey: 'Mod-Alt-N' });
    const resume = vi.fn(); plugin.pauseGlobalCapture = vi.fn(() => resume);
    const settings = new XiaojiSettings(plugin.app, plugin); document.body.append(settings.containerEl); settings.display();
    ([...settings.containerEl.querySelectorAll('nav button')].find(button => button.textContent === plugin.t('general')) as HTMLButtonElement).click();
    await new Promise(resolve => setTimeout(resolve, 0));
    const recorder = settings.containerEl.querySelector<HTMLButtonElement>('.xj-capture-setting .xj-shortcut-recorder')!;
    recorder.click(); expect(plugin.pauseGlobalCapture).toHaveBeenCalledOnce();
    recorder.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); expect(resume).toHaveBeenCalledOnce();
    recorder.click(); settings.hide(); expect(resume).toHaveBeenCalledTimes(2);
  });
});
describe('index refresh stability', () => {
  it('preserves record identity on a cache hit but updates changed records', async () => {
    const { plugin, files } = await makeFixture();
    files.revision = (path: string) => files.data.get(path) ?? '';
    await plugin.repo.scan(); const previous = plugin.repo.records; const read = vi.spyOn(files, 'read');
    expect(await plugin.repo.scan()).toBe(previous); expect(read).not.toHaveBeenCalled();
    const path = '小记/2610小记.md'; files.data.set(path, files.data.get(path)!.replace('旧记录内容', '更新后的记录内容'));
    await plugin.repo.scan(); expect(plugin.repo.records).not.toBe(previous);
    expect(plugin.repo.records.some(memo => memo.body.includes('更新后的记录内容'))).toBe(true);
  });
  it('cancels a pending event refresh when an explicit refresh already consumes it', async () => {
    vi.useFakeTimers(); const fixture = await makeFixture();
    const plugin = new XiaojiPlugin(fixture.plugin.app, fixture.plugin.manifest); plugin.data = fixture.plugin.data; plugin.repo = fixture.plugin.repo;
    const scan = vi.spyOn(plugin.repo, 'scan'); plugin.refreshSoon(); await plugin.refresh();
    await vi.advanceTimersByTimeAsync(200); expect(scan).toHaveBeenCalledOnce();
  });
  it('does not reuse a stale tag cache after a memo is created', async () => {
    const fixture = await makeFixture(); const plugin = new XiaojiPlugin(fixture.plugin.app, fixture.plugin.manifest);
    plugin.data = fixture.plugin.data; plugin.repo = fixture.plugin.repo;
    expect(plugin.tags()).not.toContain('新标签'); await plugin.repo.create('新记录 #新标签');
    expect(plugin.tags()).toContain('新标签');
  });
});
