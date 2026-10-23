import type XiaojiPlugin from '../main';
import { button, element, empty } from './dom';

export interface SearchState { query: string; tags: string[]; all: boolean; archived: boolean; }
/** A stable input: navigation and index updates never replace the field or its IME session. */
export class SearchPanel {
  readonly root: HTMLElement;
  readonly input: HTMLInputElement;
  private filter: HTMLButtonElement;
  private chips: HTMLElement;
  private popup: HTMLElement;
  private composing = false;
  private scopeControl?: HTMLSelectElement;
  private archiveControl?: HTMLInputElement;
  private state: SearchState;
  private locale: string;
  constructor(parent: HTMLElement, private plugin: XiaojiPlugin, state: SearchState, private changed: (state: SearchState) => void, private close: () => void) {
    this.state = state; this.locale = plugin.locale;
    this.root = element(parent, 'section', 'xj-search-panel');
    const line = element(this.root, 'div', 'xj-search-line');
    this.input = element(line, 'input', 'xj-search'); this.input.type = 'search';
    this.filter = button(line, plugin.t('filter'), () => { this.popup.hidden = !this.popup.hidden; this.filter.setAttribute('aria-expanded', String(!this.popup.hidden)); if (!this.popup.hidden) this.drawFilters(); }, 'list-filter');
    this.filter.setAttribute('aria-haspopup', 'true'); this.filter.setAttribute('aria-expanded', 'false'); this.filter.setAttribute('aria-controls', 'xj-filters-' + crypto.randomUUID());
    button(line, plugin.t('close'), close, 'x');
    this.chips = element(this.root, 'div', 'xj-search-chips');
    this.popup = element(this.root, 'div', 'xj-search-filters'); this.popup.id = this.filter.getAttribute('aria-controls')!; this.popup.hidden = true;
    this.input.addEventListener('compositionstart', () => { this.composing = true; });
    this.input.addEventListener('compositionend', () => { this.composing = false; this.emit({ query: this.input.value }); });
    this.input.addEventListener('input', () => { if (!this.composing) this.emit({ query: this.input.value }); });
    this.root.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || event.isComposing || this.composing) return;
      event.stopPropagation(); event.preventDefault();
      if (!this.popup.hidden) { this.popup.hidden = true; this.filter.setAttribute('aria-expanded', 'false'); this.filter.focus(); }
      else this.close();
    });
    this.root.ownerDocument.addEventListener('pointerdown', this.outside, true);
    this.sync(state, plugin.t('search'));
  }
  setVisible(value: boolean): void { this.root.hidden = !value; if (!value) { this.popup.hidden = true; this.filter.setAttribute('aria-expanded', 'false'); } }
  private outside = (event: Event): void => { if (!this.root.contains(event.target as Node)) { this.popup.hidden = true; this.filter.setAttribute('aria-expanded', 'false'); } };
  private emit(patch: Partial<SearchState>): void { this.state = { ...this.state, ...patch }; this.changed(this.state); this.drawChips(); }
  sync(state: SearchState, placeholder: string): void {
    this.state = { ...state, tags: [...state.tags] };
    if (!this.composing && this.input.value !== state.query) this.input.value = state.query;
    this.input.placeholder = placeholder; this.input.setAttribute('aria-label', placeholder);
    this.filter.classList.toggle('is-active', state.tags.length > 0 || state.all || state.archived);
    if (this.locale !== this.plugin.locale) { this.locale = this.plugin.locale; this.filter.setAttribute('aria-label', this.plugin.t('filter')); this.filter.title = this.plugin.t('filter'); this.popup.hidden = true; }
    this.drawChips();
  }
  private drawChips(): void {
    if (this.scopeControl) this.scopeControl.value = this.state.all ? 'all' : 'current';
    if (this.archiveControl) this.archiveControl.checked = this.state.archived;
    empty(this.chips);
    const chip = (text: string, remove: () => void): void => { const node = button(this.chips, text + ' ×', remove, undefined, 'xj-scope-chip'); node.setAttribute('aria-label', this.plugin.t('removeView') + ' ' + text); };
    for (const tag of this.state.tags) chip('#' + tag, () => { this.emit({ tags: this.state.tags.filter(item => item !== tag) }); if (!this.popup.hidden) this.drawFilters(); });
    if (this.state.all) chip(this.plugin.t('allMemos'), () => this.emit({ all: false }));
    if (this.state.archived) chip(this.plugin.t('includeArchived'), () => this.emit({ archived: false }));
    this.chips.hidden = !this.chips.childElementCount;
    this.filter.classList.toggle('is-active', this.state.tags.length > 0 || this.state.all || this.state.archived);
  }
  private drawFilters(): void {
    empty(this.popup); const p = this.plugin;
    const scope = this.scopeControl = element(this.popup, 'select'); scope.setAttribute('aria-label', p.t('search'));
    for (const [value, title] of [['current', p.t('searchWithin', { view: p.t('currentView') })], ['all', p.t('allMemos')]]) { const option = element(scope, 'option', '', title); option.value = value!; }
    scope.value = this.state.all ? 'all' : 'current'; scope.addEventListener('change', () => this.emit({ all: scope.value === 'all' }));
    const check = (parent: HTMLElement, text: string, value: boolean, action: (value: boolean) => void): HTMLInputElement => {
      const label = element(parent, 'label', 'xj-filter-choice'), input = element(label, 'input'); input.type = 'checkbox'; input.checked = value;
      element(label, 'span', '', text); input.addEventListener('change', () => action(input.checked)); return input;
    };
    this.archiveControl = check(this.popup, p.t('includeArchived'), this.state.archived, value => this.emit({ archived: value }));
    const find = element(this.popup, 'input'); find.type = 'search'; find.placeholder = p.t('filterTags'); find.setAttribute('aria-label', find.placeholder);
    const list = element(this.popup, 'div', 'xj-filter-tags');
    const tags = new Set([...p.tags(), ...this.state.tags]);
    for (const tag of [...tags]) { const parts = tag.split('/'); for (let i = 1; i < parts.length; i++) tags.add(parts.slice(0, i).join('/')); }
    const draw = (): void => {
      empty(list);
      for (const tag of [...tags].sort((a, b) => a.localeCompare(b)).filter(tag => tag.toLocaleLowerCase().includes(find.value.trim().replace(/^#/, '').toLocaleLowerCase())))
        check(list, '#' + tag, this.state.tags.includes(tag), value => this.emit({ tags: value ? [...this.state.tags, tag] : this.state.tags.filter(item => item !== tag) }));
    };
    find.addEventListener('input', draw); draw();
    button(this.popup, p.t('clearFilters'), () => { this.emit({ tags: [], all: false, archived: false }); this.drawFilters(); }, undefined, 'xj-text-button');
  }
  destroy(): void { this.root.ownerDocument.removeEventListener('pointerdown', this.outside, true); this.root.remove(); }
}
