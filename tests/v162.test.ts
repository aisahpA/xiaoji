// @vitest-environment jsdom
import { afterEach, beforeAll, expect, it, vi } from 'vitest';
import type { WorkspaceLeaf } from 'obsidian';
import { compileSearch } from '../src/core/search';
import { highlightSearch } from '../src/ui/search-highlight';
import { MemoView } from '../src/ui/view';
import { makeFixture } from './fixture';
class IntersectionMock {
  static instances: IntersectionMock[] = [];
  constructor(readonly callback: IntersectionObserverCallback) { IntersectionMock.instances.push(this); }
  targets = new Set<Element>();
  observe(target: Element): void { this.targets.add(target); } unobserve(target: Element): void { this.targets.delete(target); } disconnect(): void {}
  fire(target: Element, isIntersecting: boolean): void { this.callback([{ target, isIntersecting } as IntersectionObserverEntry], this as unknown as IntersectionObserver); }
}
class ResizeMock {
  static instances: ResizeMock[] = [];
  constructor(readonly callback: ResizeObserverCallback) { ResizeMock.instances.push(this); }
  observe(): void {} unobserve(): void {} disconnect(): void {}
  fire(width: number): void { this.callback([{ contentRect: { width } } as ResizeObserverEntry], this as unknown as ResizeObserver); }
}
let view: MemoView | undefined;
beforeAll(() => {
  globalThis.IntersectionObserver = IntersectionMock as unknown as typeof IntersectionObserver;
  globalThis.ResizeObserver = ResizeMock as unknown as typeof ResizeObserver;
  Range.prototype.getClientRects = () => [] as unknown as DOMRectList;
  Range.prototype.getBoundingClientRect = () => new DOMRect();
  HTMLElement.prototype.scrollIntoView = () => undefined;
});
afterEach(async () => { await view?.onClose(); view = undefined; vi.restoreAllMocks(); document.body.replaceChildren(); IntersectionMock.instances = []; ResizeMock.instances = []; });
it('collects positive terms through nested negation without changing query semantics', () => {
  const terms: string[] = []; compileSearch('教学 -(考试 OR tag:焦虑) --阅读 "长期主义"', terms);
  expect(terms).toEqual(['教学', '阅读', '长期主义']);
});
it('highlights normalized graphemes and phrases across formatting, preserving link actions', () => {
  const root = document.createElement('div'); root.innerHTML = '<p>长<strong>期</strong>主义 ＡＢＣ ﬃ é <a href="#">教学</a></p>';
  const click = vi.fn(); root.querySelector('a')!.addEventListener('click', click);
  const text = root.textContent;
  highlightSearch(root, '"长期主义" OR abc OR ffi OR é OR 教学');
  expect([...root.querySelectorAll('mark')].map(mark => mark.textContent).join('')).toBe('长期主义ＡＢＣﬃé教学');
  root.querySelector('a')!.click(); expect(click).toHaveBeenCalledOnce(); expect(root.textContent).toBe(text);
  highlightSearch(root, 'abc'); expect(root.querySelectorAll('mark')).toHaveLength(1);
  highlightSearch(root, ''); expect(root.querySelector('mark')).toBeNull(); expect(root.textContent).toBe(text);
});
it('does not highlight excluded groups or invalid expressions', () => {
  const root = document.createElement('div'); root.textContent = '教学 考试 焦虑';
  highlightSearch(root, '教学 -(考试 OR 焦虑)'); expect(root.querySelectorAll('mark')).toHaveLength(1);
  highlightSearch(root, '"unfinished'); expect(root.querySelector('mark')).toBeNull();
});
it('preserves navigation nodes during continuous width changes and sidebar opening', async () => {
  const { plugin } = await makeFixture(); view = new MemoView({ app: plugin.app } as unknown as WorkspaceLeaf, plugin);
  document.body.append(view.containerEl); await view.onOpen();
  const toolbar = view.contentEl.querySelector('.xj-toolbar')!, button = toolbar.querySelector('button')!;
  const firstCard = view.contentEl.querySelector('.xj-card');
  ResizeMock.instances.at(-1)!.fire(1000); ResizeMock.instances.at(-1)!.fire(1100);
  expect(toolbar.querySelector('button')).toBe(button);
  button.click(); expect(view.contentEl.querySelector('.xj-card')).toBe(firstCard);
});
it('releases distant Markdown and restores expanded content and working task controls', async () => {
  const { plugin } = await makeFixture(); view = new MemoView({ app: plugin.app } as unknown as WorkspaceLeaf, plugin);
  document.body.append(view.containerEl); await view.onOpen(); await new Promise(resolve => setTimeout(resolve, 40));
  const slot = view.contentEl.querySelector<HTMLElement>('.xj-card-slot')!;
  const card = slot.querySelector<HTMLElement>('.xj-card')!;
  vi.spyOn(card, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 300, 250));
  IntersectionMock.instances.find(observer => observer.targets.has(slot))!.fire(slot, false); expect(slot.querySelector('.xj-card')).toBeNull(); expect(slot.style.getPropertyValue('--xj-slot-height')).toBe('250px');
  IntersectionMock.instances.find(observer => observer.targets.has(slot))!.fire(slot, true); await new Promise(resolve => setTimeout(resolve, 40));
  expect(slot.querySelector('.xj-card')).not.toBeNull(); expect(slot.style.getPropertyValue('--xj-slot-height')).toBe('auto');
});
it('creates lightweight slots instead of rendering ten thousand preceding Markdown bodies for a deep link', async () => {
  const { plugin } = await makeFixture();
  const memo = plugin.repo.records[0]!;
  plugin.repo.records = Array.from({ length: 10000 }, (_, i) => ({ ...memo, id: '202610211000' + String(i).padStart(5, '0'), createdAt: memo.createdAt - i }));
  vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockImplementation(function(this: HTMLElement) { return this.classList.contains('xj-scroller') ? 640 : 0; });
  view = new MemoView({ app: plugin.app } as unknown as WorkspaceLeaf, plugin); document.body.append(view.containerEl); await view.onOpen();
  expect(view.contentEl.querySelectorAll('.xj-card')).toHaveLength(0);
  await view.revealMemo(plugin.repo.records[9999]!);
  expect(view.contentEl.querySelectorAll('.xj-card-slot')).toHaveLength(10000);
  expect(view.contentEl.querySelectorAll('.xj-card')).toHaveLength(1);
});
