// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it } from 'vitest';
import { CompletionContext, completionStatus } from '@codemirror/autocomplete';
import { MemoEditor } from '../src/ui/editor';
import { TrashPanel } from '../src/ui/trash';
import { SearchPanel } from '../src/ui/search-panel';
import { executeMemoQuery } from '../src/core/query';
import { makeFixture } from './fixture';
const cleanup: (() => void)[] = [];
beforeAll(() => {
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => ({ width: 0, height: 0, top: 0, bottom: 0, left: 0, right: 0, x: 0, y: 0, toJSON: () => ({}) });
});
afterEach(() => { for (const fn of cleanup.splice(0)) fn(); document.body.replaceChildren(); });
const tick = () => new Promise(resolve => setTimeout(resolve, 80));
const editor = async (value: string) => {
  const { plugin } = await makeFixture();
  const e = new MemoEditor(document.body, plugin, { value, sourcePath: '', onChange: () => {}, onSubmit: () => {} });
  cleanup.push(() => e.unload()); e.moveCursor(value.length); return e;
};
it.each(['Enter', 'Tab'])('toolbar activates completion and %s accepts before newline', async key => {
  const e = await editor('#');
  (e.root.querySelector('[aria-label="添加标签"]') as HTMLButtonElement).click(); await tick();
  expect(e.getValue()).toBe('#'); expect(completionStatus(e.view.state)).toBe('active');
  await new Promise(resolve => setTimeout(resolve, 150)); e.view.contentDOM.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, cancelable: true })); expect(e.getValue()).toMatch(/^#[^ ]+ $/u);
});
it.each(['', ' ', '\n正文', ' 正文'])('completion keeps a separating space and preserves following content %j', async suffix => {
  const e = await editor('#备' + suffix); e.moveCursor(2);
  const source = (e as unknown as { complete(c: CompletionContext): { options: { label: string; apply: Function }[] } }).complete(new CompletionContext(e.view.state, 2, true));
  const option = source.options.find(o => o.label === '#备课')!;
  option.apply(e.view, option, 0, 2);
  expect(e.getValue()).toBe('#备课 ' + (suffix.startsWith(' ') ? suffix.slice(1) : suffix));
  expect(e.view.state.selection.main.head).toBe(4);
});
it('toolbar separates a new tag from the preceding prose', async () => {
  const e = await editor('正文'); (e.root.querySelector('[aria-label="添加标签"]') as HTMLButtonElement).click();
  expect(e.getValue()).toBe('正文 #');
});
it('recycle renders a single inline body and retains it while selecting', async () => {
  const { plugin, errors } = await makeFixture(); const memo = plugin.repo.records[0]!;
  await plugin.repo.delete(memo);
  const panel = new TrashPanel(document.body, plugin); cleanup.push(() => panel.unload()); await tick();
  const body = panel.root.querySelector('.xj-trash-body')!;
  expect(body.textContent).toContain('好的课堂提问'); expect(panel.root.querySelector('.xj-trash-preview, details')).toBeNull();
  expect((panel.root.querySelector('.xj-trash-expand') as HTMLElement).hidden).toBe(true);
  const check = panel.root.querySelector('input[data-path]') as HTMLInputElement; check.click();
  expect(panel.root.querySelector('.xj-trash-body')).toBe(body); expect(errors).toEqual([]);
});
it('removing scope chips synchronizes open filter controls', async () => {
  const { plugin } = await makeFixture(); const panel = new SearchPanel(document.body, plugin, { query: '正文', tags: [], all: true, archived: true }, () => {}, () => {});
  cleanup.push(() => panel.destroy()); (panel.root.querySelector('[aria-haspopup]') as HTMLButtonElement).click();
  const find = panel.root.querySelector('.xj-search-filters input[type="search"]') as HTMLInputElement; find.value = '教学';
  const chips = panel.root.querySelectorAll<HTMLButtonElement>('.xj-scope-chip'); chips[0]!.click(); chips[1]!.click();
  expect((panel.root.querySelector('select') as HTMLSelectElement).value).toBe('current');
  expect((panel.root.querySelector('.xj-search-filters input[type="checkbox"]') as HTMLInputElement).checked).toBe(false);
  expect(find.value).toBe('教学'); expect(panel.input.value).toBe('正文');
});
it('AI structured tag queries use the same normalized hierarchical matching as browsing', async () => {
  const { plugin } = await makeFixture(); const memo = { ...plugin.repo.records[0]!, tags: ['Ｗork/主题'] };
  expect(executeMemoQuery({ action: 'list', tags: ['work'] }, [memo])).toHaveLength(1);
  expect(executeMemoQuery({ action: 'list', tags: ['wor'] }, [memo])).toHaveLength(0);
});
