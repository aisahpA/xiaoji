import { Component, MarkdownRenderer, Notice, Menu } from 'obsidian';
import type XiaojiPlugin from '../main';
import type { TrashStoreEntry } from '../core/trash-store';
import { button, element, empty } from './dom';
import { confirm } from './modals';

export class TrashPanel extends Component {
  readonly root: HTMLElement;
  private entries: TrashStoreEntry[] = [];
  private selected = new Set<string>();
  private generation = 0;
  private busy = false;
  private disposed = false;
  private body: HTMLElement;
  private controls: HTMLElement;
  private renderComponent: Component | null = null;
  private listSignature = '';
  private expanded = new Set<string>();
  private search = '';
  constructor(parent: HTMLElement, private plugin: XiaojiPlugin) {
    super();
    this.root = element(parent, 'section', 'xj-trash-panel');
    const heading = element(this.root, 'div', 'xj-panel-heading xj-trash-toolbar');

    const search = element(heading, 'input', 'xj-trash-search'); search.type = 'search';
    search.placeholder = plugin.t('search'); search.setAttribute('aria-label', plugin.t('searchWithin', { view: plugin.t('trash') }));
    search.addEventListener('input', () => { this.search = search.value; void this.draw().catch(error => plugin.report(error)); });
    this.controls = element(heading, 'div', 'xj-trash-controls');
    this.body = element(this.root, 'div', 'xj-trash-list');
    this.register(() => { this.disposed = true; this.generation++; this.renderComponent?.unload(); this.root.remove(); });
    this.load(); void this.refresh().catch(error => plugin.report(error));
  }

  async refresh(): Promise<void> {
    if (this.busy || this.disposed) return;
    const revision = ++this.generation;
    const entries = await this.plugin.repo.listTrash();
    if (this.disposed || revision !== this.generation) return;
    this.entries = entries;
    this.selected = new Set([...this.selected].filter(key => this.entries.some(entry => entry.key === key)));
    this.expanded = new Set([...this.expanded].filter(key => this.entries.some(entry => entry.key === key)));
    await this.draw();
  }

  private async draw(): Promise<void> {
    if (this.disposed) return;
    const signature = JSON.stringify([this.search, this.busy, this.entries.map(entry => [entry.key, entry.memo.raw])]);
    const rebuild = signature !== this.listSignature; this.listSignature = signature;
    if (rebuild) { this.renderComponent?.unload(); this.renderComponent = new Component(); this.renderComponent.load(); empty(this.body); }
    empty(this.controls);
    const p = this.plugin;
    const selected = this.entries.filter(entry => this.selected.has(entry.key));
    const count = selected.length, total = this.entries.length;
    const targets = count ? selected : this.entries;
    if (count) {
      button(this.controls, p.t('cancel'), () => { this.selected.clear(); void this.draw().catch(error => p.report(error)); }, 'x').disabled = this.busy;
      element(this.controls, 'span', 'xj-muted', p.t('selected', { count }));
      button(this.controls, p.t('restore'), () => this.act('restore', selected), undefined, 'xj-text-button').disabled = this.busy;
    }
    button(this.controls, p.t('more'), event => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle(p.t('selectAll')).setIcon('check-check').setDisabled(!this.filtered().length).onClick(() => {
        this.selected = new Set(this.filtered().map(entry => entry.key)); void this.draw().catch(error => p.report(error));
      }));
      menu.addSeparator();
      menu.addItem(item => item.setTitle(p.t(count ? 'permanentlyDelete' : 'emptyTrash')).setIcon('trash-2').onClick(() => { void this.act('purge', targets); }));
      menu.showAtMouseEvent(event);
    }, 'ellipsis').disabled = this.busy || !total;
    if (!rebuild) { for (const input of this.body.querySelectorAll<HTMLInputElement>('input[data-path]')) input.checked = this.selected.has(input.dataset.path!); return; }
    const entries = this.filtered();
    if (!entries.length) element(this.body, 'p', 'xj-empty', p.t(total ? 'noResults' : 'noTrash'));
    for (const entry of entries) {
      const row = element(this.body, 'article', 'xj-trash-entry');
      const header = element(row, 'div', 'xj-card-heading');
      const selected = element(header, 'input'); selected.type = 'checkbox'; selected.dataset.path = entry.key; selected.checked = this.selected.has(entry.key);
      selected.disabled = this.busy; selected.setAttribute('aria-label', p.t('select') + ' ' + p.date(entry.memo));
      selected.addEventListener('change', () => {
        if (selected.checked) this.selected.add(entry.key); else this.selected.delete(entry.key);
        void this.draw().catch(error => p.report(error));
      });
      element(header, 'time', 'xj-muted', p.date(entry.memo));
      element(header, 'small', 'xj-trash-deleted xj-muted', p.t('deletedAt', { date: new Date(entry.deletedAt).toLocaleString(p.locale, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }) }));
      const actions = element(header, 'div', 'xj-trash-actions');
      button(actions, p.t('restore'), () => this.act('restore', [entry]), undefined, 'xj-text-button').disabled = this.busy;
      button(actions, p.t('more'), event => { const menu = new Menu(); menu.addItem(item => item.setTitle(p.t('permanentlyDelete')).onClick(() => { void this.act('purge', [entry]); })); menu.showAtMouseEvent(event); }, 'ellipsis').disabled = this.busy;
      const body = element(row, 'div', 'xj-trash-body xj-markdown markdown-rendered');
      const toggle = button(row, p.t('expand'), () => {
        if (this.expanded.has(entry.key)) this.expanded.delete(entry.key); else this.expanded.add(entry.key);
        measure();
      }, undefined, 'xj-text-button xj-trash-expand');
      toggle.hidden = true;
      const measure = (): void => {
        if (!body.isConnected || this.disposed) return;
        const expanded = this.expanded.has(entry.key);
        const foldedHeight = parseFloat(body.ownerDocument.defaultView!.getComputedStyle(body).getPropertyValue('--xj-trash-fold-height')) || 96;
        const long = body.scrollHeight > foldedHeight + 2;
        toggle.hidden = !long;
        body.classList.toggle('is-folded', long && !expanded);
        toggle.textContent = p.t(expanded ? 'collapse' : 'expand');
        toggle.setAttribute('aria-expanded', String(expanded));
      };
      const component = this.renderComponent!;
      if (typeof ResizeObserver !== 'undefined') {
        const observer = new ResizeObserver(measure); observer.observe(body);
        component.register(() => observer.disconnect());
      }
      body.addEventListener('load', measure, true);
      void MarkdownRenderer.render(p.app, entry.memo.body, body, entry.memo.path, component)
        .then(measure).catch(error => p.report(error));

    }
  }
  private filtered(): TrashStoreEntry[] {
    const query = this.search.trim().toLocaleLowerCase();
    return this.entries.filter(entry => !query || (entry.memo.body + ' ' + entry.memo.id).toLocaleLowerCase().includes(query));
  }
  private async act(action: 'restore' | 'purge', entries: TrashStoreEntry[]): Promise<void> {
    const total = entries.length;
    if (this.busy || !total) return;
    const p = this.plugin;
    if (action === 'purge' && !(await confirm(p, p.t('confirmPurge', { count: total })))) return;
    if (this.busy || this.disposed) return;
    this.busy = true; await this.draw();
    let done = 0;
    try {
      for (const entry of entries) {
        try { if (action === 'restore') await p.repo.restore(entry); else await p.repo.purgeTrash(entry); this.selected.delete(entry.key); done++; }
        catch (error) { p.report(error); }
      }
      new Notice(p.t(done === total ? action === 'restore' ? 'restored' : 'purged' : 'partial', { done, failed: total - done }));
      await p.refresh();
    } finally { this.busy = false; if (!this.disposed) await this.refresh(); }
  }
}
