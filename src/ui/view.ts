import { Component, ItemView, MarkdownRenderer, Menu, Notice, Platform, setIcon, type ViewStateResult, type WorkspaceLeaf } from 'obsidian';
import type XiaojiPlugin from '../main';
import { densityValues } from '../core/settings';
import { compileSearch, selectMemos } from '../core/search';
import { MemoError, type Memo, type NavItem } from '../core/types';
import type { TrashStoreEntry } from '../core/trash-store';
import { bindErrors, button, element, empty, interactiveTarget } from './dom';
import { MemoEditor } from './editor';
import { navigation, surfaceNavigation, reorderSurface, orderedTags, reorderTags, tagSiblings } from '../core/navigation';
import { NavigationSort, sortable, type SortItem } from './navigation-sort';
import { compactQuickWindow } from './quick-chrome';
import { type TagNode } from '../core/tags';
import { AskPanel, type AskState } from './ask';
import { TrashPanel } from './trash';
import { highlightSearch } from './search-highlight';
import { SearchPanel } from './search-panel';
import { TextModal } from './modals';

export const VIEW_TYPE = 'xiaoji-memos';
export const QUICK_TYPE = 'xiaoji-quick-capture';
const icons: Record<string, string> = { all: 'notebook-pen', archive: 'archive', pinned: 'pin', week: 'calendar-days', tasks: 'list-todo', trash: 'trash-2', ask: 'sparkles', review: 'shuffle', tag: 'hash' };

interface Card {
  el: HTMLElement;
  component: Component;
  memo: Memo;
  checkbox: HTMLInputElement;
  body: HTMLElement;
  fold: HTMLButtonElement;
  alive: boolean;
}

export class MemoView extends ItemView {
  private plugin: XiaojiPlugin;
  private root!: HTMLElement;
  private toolbar!: HTMLElement;
  private revealTimer?: number;
  private revealed?: HTMLElement;
  private referenceReturn: Record<string, unknown> | null = null;
  private sidebarEl!: HTMLElement;
  private main!: HTMLElement;
  private composerWrap!: HTMLElement;
  private composer: MemoEditor | null = null;
  private editing: Memo | null = null;
  private recoveryChecked = false;
  private editReturnScroll = 0;
  private special!: HTMLElement;
  private askPanel: AskPanel | null = null;
  private askState: AskState | undefined;
  private panelLocale = '';
  private trashPanel: TrashPanel | null = null;
  private topButton!: HTMLButtonElement;
  private collapsedTags = new Set<string>();
  private searchPanel!: SearchPanel;
  private filterTags: string[] = [];
  private feedFrame: number | null = null;
  private sorter: NavigationSort | null = null;
  private tagPath = '';
  private pinnedFeed!: HTMLElement;
  private regularFeed!: HTMLElement;
  private composerSource = '';
  private scroller!: HTMLElement;
  private status!: HTMLElement;
  private feed!: HTMLElement;
  private sentinel!: HTMLElement;
  private cards = new Map<string, Card>();
  private slots = new Map<string, { el: HTMLElement; memo: Memo }>();
  private visibility: IntersectionObserver | null = null;
  private observer: ResizeObserver | null = null;
  private cardObserver: ResizeObserver | null = null;
  private intersection: IntersectionObserver | null = null;
  private unsubscribe: (() => void) | null = null;
  private draftKey = 'composer-main';
  private currentId = 'all';
  private query = '';
  private allScope = false;
  private includeArchived = false;
  private limit = 40;
  private selected = new Set<string>();
  private selectionMode = false;
  private bulkBusy = false;
  private marqueeCleanup: (() => void) | null = null;
  private suppressCardClick = 0;
  private expanded = new Set<string>();
  private filtered: Memo[] = [];
  private queryCache?: { records: Memo[]; key: string; result: Memo[] };
  private geometryFrame: number | null = null;
  private highlightQueries = new WeakMap<HTMLElement, string>();



  private width = 1000;
  private manualSidebar = false;
  private searchActive = false;
  private chromeSignature = '';
  private chromeRecords?: Memo[];
  private recordsRevision = 0;
  private tagTreeCache?: { records: Memo[]; order: readonly string[]; nodes: TagNode[] };
  private closed = false;
  private saving = false;
  private composerLocale = '';
  private automaticTag = '';
  private restoreScroll = 0;
  private pendingTopScroll = false;
  private positions = new Map<string, { scroll: number; limit: number }>();
  private completedFeedback = new Map<string, { memo: Memo; scope: string; timer: number }>();
  private feedSignature = '';
  private measuredCards = new Set<string>();
  private lastFoldHeight = 0;
  private cardByEl = new WeakMap<HTMLElement, Card>();
  private feedTimer: number | null = null;

  constructor(leaf: WorkspaceLeaf, plugin: XiaojiPlugin) { super(leaf); this.plugin = plugin; }
  getViewType(): string { return VIEW_TYPE; }
  getDisplayText(): string { return this.plugin.locale === 'zh' ? '小记' : 'xiaoji'; }
  getIcon(): string { return 'notebook-pen'; }

  getState(): Record<string, unknown> {
    return { sidebarOpen: this.manualSidebar, filterTags: [...this.filterTags], searchActive: this.searchActive, tagPath: this.tagPath, collapsedTags: [...this.collapsedTags], draftKey: this.draftKey, currentId: this.currentId, query: this.query, allScope: this.allScope, includeArchived: this.includeArchived, scroll: this.scroller?.scrollTop ?? this.restoreScroll, limit: this.limit };
  }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    const oldDraftKey = this.draftKey;
    if (typeof state.sidebarOpen === 'boolean') this.manualSidebar = state.sidebarOpen;
    if (typeof state.searchActive === 'boolean') this.searchActive = state.searchActive;
    if (Array.isArray(state.filterTags)) this.filterTags = state.filterTags.filter((tag): tag is string => typeof tag === 'string' && tag.length < 1000);
    if (typeof state.tagPath === 'string') this.tagPath = state.tagPath;
    if (Array.isArray(state.collapsedTags)) this.collapsedTags = new Set(state.collapsedTags.filter((value): value is string => typeof value === 'string'));
    if (typeof state.draftKey === 'string') this.draftKey = state.draftKey;
    if (typeof state.currentId === 'string') this.currentId = state.currentId;
    if (typeof state.query === 'string') { this.query = state.query; if (typeof state.searchActive !== 'boolean') this.searchActive = Boolean(this.query.trim()); }
    this.allScope = state.allScope === true;
    this.includeArchived = state.includeArchived === true;
    if (typeof state.scroll === 'number' && Number.isFinite(state.scroll)) this.restoreScroll = Math.max(0, state.scroll);
    if (typeof state.limit === 'number' && Number.isFinite(state.limit)) this.limit = Math.max(40, Math.min(10000, state.limit));
    await super.setState(state, result);
    if (this.root) {
      if (oldDraftKey !== this.draftKey) { this.composer?.unload(); this.composer = null; this.buildComposer(); }
      this.render(true);
    }
  }

  async onOpen(): Promise<void> {
    this.closed = false;
    empty(this.contentEl);
    this.contentEl.classList.add('xj-view-content');
    this.root = element(this.contentEl, 'div', 'xj-root' + (Platform.isMobile ? ' is-mobile' : ''));
    bindErrors(this.root, error => this.plugin.report(error));
    this.sorter?.destroy(); this.sorter = new NavigationSort(this.root, (source, target, after) => this.reorder(source, target, after), (item, direction) => this.stepOrder(item, direction), error => this.plugin.report(error));
    this.toolbar = element(this.root, 'header', 'xj-toolbar');
    this.searchPanel = new SearchPanel(this.root, this.plugin, { query: this.query, tags: this.filterTags, all: this.allScope, archived: this.includeArchived }, state => {
      const queryChanged = state.query !== this.query;
      this.rememberPosition(); this.query = state.query; this.filterTags = state.tags; this.allScope = state.all; this.includeArchived = state.archived;
      this.limit = 40; this.selected.clear(); this.saveLayout();
      // Only debounce text input; tag/scope/archive toggles are discrete clicks and should render immediately.
      if (queryChanged) this.scheduleFeedSoon(); else { this.cancelFeedTimer(); this.scheduleFeed(); }
    }, () => { this.cancelFeedTimer(); this.searchActive = false; this.query = ''; this.filterTags = []; this.allScope = false; this.includeArchived = false; this.saveLayout(); this.render(true); });
    const workspace = element(this.root, 'div', 'xj-workspace');
    this.sidebarEl = element(workspace, 'aside', 'xj-sidebar');
    this.sidebarEl.setAttribute('aria-label', this.plugin.t('navigation'));
    const backdrop = element(workspace, 'div', 'xj-sidebar-backdrop');
    backdrop.addEventListener('click', () => { this.manualSidebar = false; this.saveLayout(); this.render(true); });
    this.root.addEventListener('keydown', event => {
      if (event.key === 'Escape' && this.root.classList.contains('has-drawer')) {
        event.stopPropagation(); this.manualSidebar = false; this.saveLayout(); this.render(true);
      }
    });
    this.main = element(workspace, 'main', 'xj-main');
    this.composerWrap = element(this.main, 'div', 'xj-composer-wrap');
    this.scroller = element(this.main, 'div', 'xj-scroller');
    this.special = element(this.scroller, 'div', 'xj-special');
    this.topButton = button(this.main, this.plugin.t('toTop'), () => { this.scroller.scrollTop = 0; this.topButton.hidden = true; }, 'arrow-up', 'xj-back-top');
    this.topButton.hidden = true;
    this.scroller.addEventListener('scroll', () => { this.topButton.hidden = this.scroller.scrollTop < Math.max(200, this.scroller.clientHeight); }, { passive: true });
    this.status = element(this.scroller, 'div', 'xj-status');
    this.feed = element(this.scroller, 'div', 'xj-feed');
    this.pinnedFeed = element(this.feed, 'div', 'xj-card-grid xj-pinned-feed');
    this.regularFeed = element(this.feed, 'div', 'xj-card-grid xj-regular-feed');
    this.pinnedFeed.setAttribute('role', 'list'); this.regularFeed.setAttribute('role', 'list');
    this.sentinel = element(this.scroller, 'div', 'xj-sentinel');
    this.buildComposer();
    this.bindMarquee();
    this.visibility = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const key = (entry.target as HTMLElement).dataset.memoKey;
        const slot = key ? this.slots.get(key) : undefined;
        if (!key || !slot || slot.el !== entry.target || this.closed) continue;
        if (entry.isIntersecting) {
          if (!this.cards.has(key)) {
            const card = this.createCard(slot.memo); this.cards.set(key, card);
            slot.el.setCssProps({ '--xj-slot-height': 'auto' }); slot.el.appendChild(card.el); this.cardObserver?.observe(card.el);
            this.syncCard(card);
          }
        } else {
          const card = this.cards.get(key);
          const selection = this.root.ownerDocument.defaultView?.getSelection();
          if (!card || card.el.contains(this.root.ownerDocument.activeElement) ||
            selection && !selection.isCollapsed && (card.el.contains(selection.anchorNode) || card.el.contains(selection.focusNode))) continue;
          const height = card.el.getBoundingClientRect().height;
          if (height <= 0) continue;
          slot.el.style.setProperty('--xj-slot-height', height + 'px'); this.disposeCard(card); this.cards.delete(key);
        }
      }
    }, { root: this.scroller, rootMargin: '1000px' });
    this.cardObserver = new ResizeObserver(entries => {
      const height = densityValues(this.plugin.prefs).foldHeight;
      for (const entry of entries) {
        const node = entry.target as HTMLElement;
        const card = this.cardByEl.get(node);
        if (card) {
          const folded = card.body.scrollHeight > height + 6;
          card.body.classList.toggle('can-fold', folded);
          card.fold.hidden = !folded;
          this.measuredCards.add(card.memo.key);
        }
        if (this.plugin.prefs.layout !== 'waterfall') continue;
        const gap = densityValues(this.plugin.prefs).gap;
        const span = Math.max(1, Math.ceil(((entry.borderBoxSize?.[0]?.blockSize ?? node.getBoundingClientRect().height) + gap) / 4));
        const host = node.parentElement;
        if (host && host.style.gridRowEnd !== 'span ' + span) host.style.gridRowEnd = 'span ' + span;
      }
    });
    this.observer = new ResizeObserver(entries => {
      const width = entries[0]?.contentRect.width;
      if (!width || Math.abs(width - this.width) < 2) return;
      const breakpointChanged = (this.width < 900) !== (width < 900);
      this.width = width;
      if (breakpointChanged) this.renderChrome();
      if (this.geometryFrame === null) this.geometryFrame = this.root.ownerDocument.defaultView!.requestAnimationFrame(() => {
        this.geometryFrame = null; this.measureCards();
      });
    });
    this.observer.observe(this.root);
    this.intersection = new IntersectionObserver(entries => {
      if (entries.some(entry => entry.isIntersecting) && this.limit < this.filtered.length) {
        this.limit += 40; this.renderFeed();
      }
    }, { root: this.scroller, rootMargin: '500px' });
    this.intersection.observe(this.sentinel);
    this.unsubscribe = this.plugin.subscribe(() => { this.syncComposer(); this.render(); if (this.currentId === 'trash') void this.trashPanel?.refresh().catch(error => this.plugin.report(error)); });
    this.render(true);
  }

  private catalogue(): NavItem[] {
    return navigation(this.plugin.prefs);
  }
  private current(): NavItem {
    if (this.tagPath) return { id: 'tag-tree', kind: 'tag', tag: this.tagPath, title: '#' + this.tagPath, favorite: false };
    return this.catalogue().find(item => item.id === this.currentId) ?? this.catalogue().find(item => item.kind === 'all')!;
  }
  private stateKey(): string { return this.currentId + '::' + this.tagPath + '::' + this.filterTags.join('|') + '::' + this.query + '::' + this.allScope + '::' + this.includeArchived; }
  private rememberPosition(): void { this.positions.set(this.stateKey(), { scroll: this.scroller.scrollTop, limit: this.limit }); }

  private buildComposer(): void {
    this.composer?.unload(); this.composer = null; empty(this.composerWrap);
    const p = this.plugin;
    this.composerLocale = p.locale;
    if (!this.recoveryChecked && !p.loading && !p.data.drafts[this.draftKey] && !p.data.drafts[this.draftKey + '-edit'] && !this.editing) {
      const inUse = new Set([VIEW_TYPE, QUICK_TYPE].flatMap(type => this.app.workspace.getLeavesOfType?.(type) ?? [])
        .filter(leaf => leaf.view !== this).map(leaf => leaf.view.getState().draftKey));
      const previous = Object.entries(p.data.drafts).filter(([key, draft]) =>
        draft.text.trim() && key !== 'quick-capture' && !key.endsWith('-edit') && key !== this.draftKey && !inUse.has(key))
        .sort((a, b) => b[1].updatedAt - a[1].updatedAt)[0];
      if (previous) {
        const [key, draft] = previous;
        if (draft.memoKey) {
          const source = p.repo.records.find(memo => memo.key === draft.memoKey);
          if (source) {
            this.editing = { ...source, raw: draft.originalRaw ?? source.raw };
            p.setDraft(this.draftKey + '-edit', draft.text, this.editing, { sourcePath: source.path });
          } else p.setDraft(this.draftKey, draft.text, undefined, { sourcePath: draft.sourcePath });
          void p.clearDraft(key).catch(error => p.report(error));
        } else this.draftKey = key;
      }
    }
    if (!p.loading) this.recoveryChecked = true;
    const pending = p.data.drafts[this.draftKey + '-edit'];
    if (!this.editing && pending?.memoKey) {
      const source = p.repo.records.find(memo => memo.key === pending.memoKey);
      if (source) this.editing = { ...source, raw: pending.originalRaw ?? source.raw };
      else if (!p.loading) {
        const existing = p.data.drafts[this.draftKey]?.text ?? '';
        p.setDraft(this.draftKey, [existing, pending.text].filter(Boolean).join('\n\n'));
        void p.clearDraft(this.draftKey + '-edit').catch(error => p.report(error));
      }
    }
    const key = this.editing ? this.draftKey + '-edit' : this.draftKey;
    const draft = p.data.drafts[key];
    this.automaticTag = draft?.autoTag ?? this.automaticTag;
    this.composerSource = this.editing?.path ?? draft?.sourcePath ?? p.sourcePath();
    if (this.editing) {
      const heading = element(this.composerWrap, 'div', 'xj-editing-heading');
      element(heading, 'span', 'xj-muted', p.t('editingMemo', { date: p.date(this.editing) }));
      button(heading, p.t('cancel'), () => this.cancelEdit(), undefined, 'xj-text-button');
    }
    this.composer = new MemoEditor(this.composerWrap, p, {
      value: draft?.text ?? this.editing?.body ?? '', sourcePath: this.composerSource,
      onChange: value => p.setDraft(key, value, this.editing ?? undefined, { sourcePath: this.composerSource, kind: 'memo', autoTag: this.editing ? undefined : this.automaticTag }),
      onSubmit: () => this.save(),
      onLateAttachment: value => p.recoverAttachment(value),
    });
    if (this.editing) { this.composer.submitButton.textContent = p.t('saveChanges'); this.composer.submitButton.setAttribute('aria-label', p.t('saveChanges')); }
    else this.applyTag();
  }
  private syncComposer(): void {
    if (this.saving) return;
    if (!this.recoveryChecked && !this.plugin.loading) { this.buildComposer(); return; }
    if (!this.editing && this.plugin.data.drafts[this.draftKey + '-edit']?.memoKey && !this.plugin.loading) {
      this.buildComposer(); return;
    }
    if (this.composerLocale !== this.plugin.locale || this.composer?.shortcut !== this.plugin.prefs.submitKey) { this.buildComposer(); return; }
    const draft = this.plugin.data.drafts[this.editing ? this.draftKey + '-edit' : this.draftKey];
    if (this.composer && !this.composer.view.hasFocus && this.composer.getValue() !== (draft?.text ?? '')) {
      this.composer.setValue(draft?.text ?? this.editing?.body ?? '');
    }
  }
  private appendChatAnswer(text: string): void {
    if (this.editing || this.saving) throw new MemoError('finishEditing');
    this.navigate('all'); this.composer?.appendLine(text); this.focusComposer();
  }
  canReceiveCapture(): boolean { return !this.editing && !this.saving; }
  async receiveCapture(text: string, source: string): Promise<void> {
    if (!this.canReceiveCapture() || !this.composer) throw new MemoError('finishEditing');
    this.navigate('all');
    const editor = this.composer, before = editor.getValue(); editor.setBusy(true);
    const value = [before, this.plugin.rebase(text, source, this.composerSource)].filter(Boolean).join('\n\n');
    try { editor.setValue(value); await this.plugin.persist(); }
    catch (error) { editor.setValue(before); throw error; }
    finally { editor.setBusy(false); }
    this.focusComposer();
  }
  focusComposer(): void { this.scroller.scrollTop = 0; this.composer?.focus(); }
  /** Request the feed to jump to the top on its next render — but only when the
   *  view is already near the top (within one folded card). A user browsing
   *  further down keeps their position (the saved-memo notice already confirms
   *  the capture), while a user near the top sees the freshly added memo. */
  requestTopScroll(): void {
    if (!this.scroller) { this.pendingTopScroll = true; return; }
    const threshold = densityValues(this.plugin.prefs).foldHeight;
    if (this.scroller.scrollTop < threshold) this.pendingTopScroll = true;
  }
  private applyTag(): void {
    if (!this.composer || this.editing) return;
    const value = this.composer.getValue();
    const previous = this.automaticTag ? '\n#' + this.automaticTag : '';
    if (value.trim() && value !== previous && value !== '\n' + previous) return;
    this.automaticTag = this.current().kind === 'tag' ? this.current().tag ?? '' : '';
    this.composer.setValue(this.automaticTag ? '\n#' + this.automaticTag : '');
    this.plugin.setDraft(this.draftKey, this.composer.getValue(), undefined, { sourcePath: this.composerSource, autoTag: this.automaticTag });
    this.composer.moveCursor(0);
  }
  private offerUndo(entries: TrashStoreEntry[]): void {
    const fragment = this.root.ownerDocument.win.createFragment();
    fragment.append(this.plugin.t('deleted') + ' ');
    const undo = fragment.createEl('button'); undo.textContent = this.plugin.t('undoDelete');
    undo.addEventListener('click', () => {
      undo.disabled = true;
      this.run(async () => {
        try { for (const entry of entries) await this.plugin.repo.restore(entry); await this.plugin.refresh(); }
        catch (error) { undo.disabled = false; throw error; }
      });
    });
    fragment.append(undo); new Notice(fragment, 8000);
  }
  async editMemo(memo: Memo): Promise<void> {
    if (this.saving) return;
    if (this.editing && this.editing.key !== memo.key) {
      new Notice(this.plugin.t('finishEditing')); this.focusComposer(); return;
    }
    if (!this.editing) {
      this.editReturnScroll = this.scroller.scrollTop; this.editing = { ...memo };
      this.plugin.setDraft(this.draftKey + '-edit', memo.body, memo, { sourcePath: memo.path });
      this.buildComposer();
    }
    if (['ask', 'trash'].includes(this.currentId)) this.navigate('all');
    this.composer?.focus(); this.composer?.moveCursor(this.composer.getValue().length);
  }
  private async cancelEdit(): Promise<void> {
    if (this.saving) return;
    await this.plugin.clearDraft(this.draftKey + '-edit');
    this.editing = null; this.buildComposer(); this.scroller.scrollTop = this.editReturnScroll;
  }
  private async save(): Promise<void> {
    if (!this.composer || this.saving) return;
    const p = this.plugin, editing = this.editing;
    if (!editing && this.automaticTag && this.composer.getValue().trim() === '#' + this.automaticTag) { new Notice(p.t('emptyMemo')); return; }
    this.saving = true; const editor = this.composer; editor.setBusy(true);
    try {
      await editor.waitForAttachments(); if (this.composer !== editor || this.closed) return;
      const memo = editing ? await p.repo.edit(editing, this.composer.getValue()) :
        await p.createMemo(this.composer.getValue(), this.composerSource);
      await p.clearDraft(editing ? this.draftKey + '-edit' : this.draftKey).catch(error => p.report(error));
      this.editing = null; this.buildComposer();
      // create/edit already updated repo.records and backfilled the scan cache; refreshSoon
      // schedules a debounced scan that will hit the cache, so saving no longer blocks on it.
      p.refreshSoon();
      if (editing) {
        this.scroller.scrollTop = this.editReturnScroll;
        const card = this.cards.get(memo.key); card?.el.classList.add('is-revealed');
      } else this.requestTopScroll();
      new Notice(p.t('savedMemo'));
    } catch (error) { p.report(error); }
    finally { this.saving = false; this.composer?.setBusy(false); }
  }

  private sidebarOpen(): boolean { return this.manualSidebar; }
  private saveLayout(): void { this.app.workspace.requestSaveLayout?.(); }
  private scheduleFeed(): void {
    if (this.feedFrame !== null) return;
    const win = this.root.ownerDocument.defaultView;
    if (win) this.feedFrame = win.requestAnimationFrame(() => { this.feedFrame = null; if (!this.closed) this.renderFeed(); });
  }

  /** Debounced feed refresh for search typing: state updates immediately, render is delayed 80ms.
   *  80ms coalesces rapid backspace/delete (≈30ms interval) without adding perceptible lag to normal typing. */
  private scheduleFeedSoon(): void {
    this.cancelFeedTimer();
    this.feedTimer = window.setTimeout(() => { this.feedTimer = null; this.scheduleFeed(); }, 80);
  }

  private cancelFeedTimer(): void { if (this.feedTimer !== null) { window.clearTimeout(this.feedTimer); this.feedTimer = null; } }

  private render(force = false): void {
    if (this.closed || !this.root) return;
    this.root.classList.toggle('is-selecting', this.selectionMode);
    this.root.classList.toggle('is-asking', this.current().kind === 'ask');
    if (this.panelLocale !== this.plugin.locale || this.askPanel && this.askPanel.saved !== this.plugin.prefs.saveConversations) {
      this.askState = this.askPanel?.snapshot() ?? this.askState;
      this.askPanel?.unload(); this.askPanel = null;
      this.trashPanel?.unload(); this.trashPanel = null;
      this.panelLocale = this.plugin.locale;
    }
    if (!this.plugin.prefs.aiEnabled && this.askPanel) {
      this.askPanel.unload(); this.askPanel = null;
      if (this.currentId === 'ask') this.currentId = 'all';
    }
    if (this.chromeRecords !== this.plugin.repo.records) { this.chromeRecords = this.plugin.repo.records; this.recordsRevision++; }
    const signature = JSON.stringify([this.plugin.prefs, this.plugin.locale, this.recordsRevision, this.currentId, this.tagPath, this.selectionMode, this.selected.size, this.width, this.manualSidebar, this.searchActive]);
    if (force || signature !== this.chromeSignature) {
      this.chromeSignature = signature; this.renderChrome();
    }
    const special = this.current().kind === 'ask' || this.current().kind === 'trash';
    this.composerWrap.hidden = special; this.feed.hidden = special; this.sentinel.hidden = special; this.status.hidden = special;
    this.special.hidden = !special;
    this.searchPanel.setVisible(!special && this.searchActive && !this.selectionMode);
    this.searchPanel.sync({ query: this.query, tags: this.filterTags, all: this.allScope, archived: this.includeArchived }, this.allScope ? this.plugin.t(this.includeArchived ? 'searchAll' : 'allActive') : this.plugin.t('searchWithin', { view: this.plugin.navLabel(this.current()) }));
    if (special) {
      if (this.current().kind === 'ask') {
        if (!this.askPanel) this.askPanel = new AskPanel(this.special, this.plugin, this.askState, text => this.appendChatAnswer(text), menu => this.populateMoreMenu(menu));
        this.askPanel.root.hidden = false; this.askPanel.mountToolbar(this.toolbar.querySelector<HTMLElement>('.xj-toolbar-tools')); if (this.trashPanel) this.trashPanel.root.hidden = true;
      } else {
        if (!this.trashPanel) this.trashPanel = new TrashPanel(this.special, this.plugin);
        this.trashPanel.root.hidden = false; if (this.askPanel) this.askPanel.root.hidden = true;
      }
    } else this.renderFeed();
  }

  private renderChrome(): void {
    const p = this.plugin; this.sorter?.syncDocument();
    const open = this.sidebarOpen();
    const overlay = open && this.width < 900;
    this.root.classList.toggle('has-sidebar', open && !overlay);
    this.root.classList.toggle('has-drawer', overlay);
    this.root.classList.toggle('is-list', p.prefs.layout === 'list');
    this.root.classList.toggle('is-waterfall', p.prefs.layout === 'waterfall');
    const density = densityValues(p.prefs);
    this.root.style.setProperty('--xj-gap', density.gap + 'px');
    this.root.style.setProperty('--xj-padding', density.padding + 'px');
    this.root.style.setProperty('--xj-fold-height', density.foldHeight + 'px');
    this.root.style.setProperty('--xj-list-width', p.prefs.listWidth + 'px');
    this.root.style.setProperty('--xj-card-width', density.cardWidth + 'px');
    empty(this.toolbar); empty(this.sidebarEl);
    this.sidebarEl.hidden = !open;
    if (this.selectionMode) { this.renderSelectionToolbar(); this.renderSidebar(open); return; }
    button(this.toolbar, p.t('navigation'), () => {
      this.manualSidebar = !this.sidebarOpen(); this.saveLayout(); this.renderChrome();
    }, 'panel-left');
    if (this.referenceReturn) button(this.toolbar, p.t('backToPrevious'), async () => {
      const state = this.referenceReturn!; this.referenceReturn = null;
      await this.setState(state, {} as ViewStateResult);
    }, 'arrow-left');
    const nav = element(this.toolbar, 'nav', 'xj-top-nav');
    nav.setAttribute('aria-label', p.t('navigation'));
    const current = this.current();
    const entries = surfaceNavigation(p.prefs, 'top');

    for (const item of entries) {
      const node = button(nav, p.navLabel(item), () => this.activate(item), undefined, 'xj-nav-button');
      sortable(node, { id: item.id, group: 'views-top' }, true);
      node.classList.toggle('is-active', item.id === current.id); node.setAttribute('aria-current', item.id === current.id ? 'page' : 'false');
    }
    if (!entries.some(item => item.id === current.id)) {
      const range = button(nav, p.navLabel(current), () => { this.manualSidebar = true; this.saveLayout(); this.render(true); }, undefined, 'xj-current-view xj-current-range');
      range.setAttribute('aria-current', 'page');
    }
    const right = element(this.toolbar, 'div', 'xj-toolbar-tools');
    if (!['ask', 'trash'].includes(current.kind)) button(right, p.t('search'), () => this.focusSearch(), 'search');
    if (!['ask', 'trash'].includes(current.kind)) button(right, p.t('more'), event => this.moreMenu(event), 'ellipsis');
    this.askPanel?.mountToolbar(current.kind === 'ask' ? right : null);
    this.renderSidebar(open);
  }

  private activate(item: NavItem): void { if (item.kind === 'review') this.plugin.showReview(); else this.navigate(item.id); }
  private async reorder(source: SortItem, target: SortItem, after: boolean): Promise<void> {
    if (source.group !== target.group) return;
    await this.plugin.updateSettings(current => {
      if (source.group.startsWith('views-')) return reorderSurface(current, source.group === 'views-top' ? 'top' : 'sidebar', source.id, target.id, after);
      return { tagOrder: reorderTags(orderedTags(this.plugin.repo.records, current.tagOrder), current.tagOrder, source.id, target.id, after) };
    });
  }
  private async stepOrder(item: SortItem, direction: -1 | 1): Promise<void> {
    await this.plugin.updateSettings(current => {
      const tree = orderedTags(this.plugin.repo.records, current.tagOrder);
      const siblings = item.group.startsWith('views-') ? surfaceNavigation(current, item.group === 'views-top' ? 'top' : 'sidebar').map(item => item.id) : tagSiblings(tree, item.id);
      const target = siblings[siblings.indexOf(item.id) + direction];
      if (!target) return {};
      if (item.group.startsWith('views-')) return reorderSurface(current, item.group === 'views-top' ? 'top' : 'sidebar', item.id, target, direction === 1);
      return { tagOrder: reorderTags(tree, current.tagOrder, item.id, target, direction === 1) };
    });
  }
  private renderSidebar(open: boolean): void {
    if (!open) return;
    const p = this.plugin, heading = element(this.sidebarEl, 'div', 'xj-sidebar-heading');
    element(heading, 'span', 'xj-muted', p.t('navigation'));
    const views = surfaceNavigation(p.prefs, 'sidebar');
    for (const item of views) {
      const row = element(this.sidebarEl, 'div', 'xj-nav-row'); sortable(row, { id: item.id, group: 'views-sidebar' });
      const node = button(row, p.navLabel(item), () => {
        this.activate(item); if (this.width < 900) { this.manualSidebar = false; this.saveLayout(); this.render(true); }
      }, undefined, 'xj-sidebar-item');
      const icon = element(node, 'span', 'xj-sidebar-icon'); setIcon(icon, icons[item.kind] ?? 'hash'); node.prepend(icon);
      node.classList.toggle('is-active', item.id === this.current().id && !this.tagPath);
      node.setAttribute('aria-current', item.id === this.current().id && !this.tagPath ? 'page' : 'false');
    }
    element(this.sidebarEl, 'hr', 'xj-sidebar-divider');
    element(this.sidebarEl, 'small', 'xj-tags-heading', p.t('tags'));
    const tags = element(this.sidebarEl, 'div', 'xj-tag-tree');
    if (!this.tagTreeCache || this.tagTreeCache.records !== p.repo.records || this.tagTreeCache.order !== p.prefs.tagOrder) {
      this.tagTreeCache = { records: p.repo.records, order: p.prefs.tagOrder, nodes: orderedTags(p.repo.records, p.prefs.tagOrder) };
    }
    this.drawTags(tags, this.tagTreeCache.nodes);
  }
  private drawTags(parent: HTMLElement, nodes: TagNode[], depth = 0): void {
    for (const tag of nodes) {
      const row = element(parent, 'div', 'xj-tag-row');
      const item = { id: tag.path, group: 'tags:' + tag.path.split('/').slice(0, -1).join('/') }; sortable(row, item);
      row.style.setProperty('--tag-depth', String(Math.min(depth, 5)));
      if (tag.children.length) {
        const toggle = button(row, this.plugin.t(this.collapsedTags.has(tag.path) ? 'expandTags' : 'collapseTags'), () => {
          if (this.collapsedTags.has(tag.path)) this.collapsedTags.delete(tag.path); else this.collapsedTags.add(tag.path); this.saveLayout(); this.render(true);
        }, this.collapsedTags.has(tag.path) ? 'chevron-right' : 'chevron-down', 'xj-tag-toggle');
        toggle.setAttribute('aria-expanded', String(!this.collapsedTags.has(tag.path)));
      } else element(row, 'span', 'xj-tag-toggle-spacer');
      const label = button(row, '# ' + tag.name, () => this.openTag(tag.path), undefined, 'xj-tag-name');
      label.title = '#' + tag.path; label.classList.toggle('is-active', this.tagPath === tag.path);
      label.setAttribute('aria-current', this.tagPath === tag.path ? 'page' : 'false');
      element(row, 'span', 'xj-tag-count', String(tag.count));
      if (!this.collapsedTags.has(tag.path)) this.drawTags(parent, tag.children, depth + 1);
    }
  }
  private bindMarquee(): void {
    const doc = this.root.ownerDocument;
    let gesture: { x: number; y: number; base: Set<string>; box: HTMLElement | null; additive: boolean } | null = null;
    const stop = (cancel = false): void => {
      if (!gesture) return;
      if (cancel) this.selected = gesture.base;
      if (gesture.box) this.suppressCardClick = Date.now() + 400;
      gesture.box?.remove(); gesture = null; this.render(true);
    };
    const move = (event: PointerEvent): void => {
      if (!gesture) return;
      if (!gesture.box && Math.hypot(event.clientX - gesture.x, event.clientY - gesture.y) < 6) return;
      event.preventDefault();
      gesture.box ??= element(doc.body, 'div', 'xj-marquee');
      const left = Math.min(event.clientX, gesture.x), top = Math.min(event.clientY, gesture.y), right = Math.max(event.clientX, gesture.x), bottom = Math.max(event.clientY, gesture.y);
      Object.assign(gesture.box.style, { left: left + 'px', top: top + 'px', width: right - left + 'px', height: bottom - top + 'px' });
      this.selected = gesture.additive ? new Set(gesture.base) : new Set();
      for (const [key, card] of this.cards) {
        const rect = card.el.getBoundingClientRect();
        if (rect.right > left && rect.left < right && rect.bottom > top && rect.top < bottom) this.selected.add(key);
        card.el.classList.toggle('is-selected', this.selected.has(key)); card.checkbox.checked = this.selected.has(key);
      }
      const count = this.toolbar.querySelector('.xj-selection-count'); if (count) count.textContent = this.plugin.t('selected', { count: this.selectedMemos().length });
      const bounds = this.scroller.getBoundingClientRect(); if (event.clientY > bounds.bottom - 30) this.scroller.scrollTop += 18; else if (event.clientY < bounds.top + 30) this.scroller.scrollTop -= 18;
    };
    const down = (event: PointerEvent): void => {
      if (!this.selectionMode || this.bulkBusy || event.button !== 0 || event.pointerType === 'touch' || (event.target as Element).closest('button,input,a')) return;
      gesture = { x: event.clientX, y: event.clientY, base: new Set(this.selected), box: null, additive: event.shiftKey };
    };
    const up = (): void => stop(); const cancel = (): void => stop(true);
    const key = (event: KeyboardEvent): void => { if (event.key === 'Escape' && gesture) { event.stopPropagation(); stop(true); } };
    this.feed.addEventListener('pointerdown', down); doc.addEventListener('pointermove', move, { passive: false }); doc.addEventListener('pointerup', up); doc.addEventListener('pointercancel', cancel); doc.addEventListener('keydown', key, true); doc.defaultView?.addEventListener('blur', cancel);
    this.marqueeCleanup = () => { gesture?.box?.remove(); gesture = null; this.feed.removeEventListener('pointerdown', down); doc.removeEventListener('pointermove', move); doc.removeEventListener('pointerup', up); doc.removeEventListener('pointercancel', cancel); doc.removeEventListener('keydown', key, true); doc.defaultView?.removeEventListener('blur', cancel); };
  }
  private renderSelectionToolbar(): void {
    const p = this.plugin;
    button(this.toolbar, p.t('cancel'), () => { this.selectionMode = false; this.selected.clear(); this.render(true); });
    element(this.toolbar, 'span', 'xj-selection-count', p.t('selected', { count: this.selectedMemos().length }));
    const actions = element(this.toolbar, 'div', 'xj-toolbar-tools');
    button(actions, p.t('addTag'), () => this.tagSelection(), 'hash');
    button(actions, p.t('delete'), () => this.bulk('delete'), 'trash-2');
    button(actions, p.t(this.isArchiveView() ? 'unarchive' : 'doArchive'), () => this.bulk('archive'), 'archive');
    button(actions, p.t('more'), event => {
      const menu = new Menu();
      menu.addItem(item => item.setTitle(p.t('selectAll')).setIcon('check-check').onClick(() => {
        this.selected = new Set(this.filtered.map(memo => memo.key)); this.render(true);
      }));
      menu.addItem(item => item.setTitle(p.t('copy')).setIcon('copy').onClick(() => this.run(() => p.clipboard(this.selectedMemos().map(memo => memo.body).join('\n\n---\n\n'), this.root.ownerDocument))));
      menu.showAtMouseEvent(event);
    }, 'ellipsis');
  }

  private moreMenu(event: MouseEvent): void { const menu = new Menu(); this.populateMoreMenu(menu); menu.showAtMouseEvent(event); }
  private populateMoreMenu(menu: Menu): void {
    const p = this.plugin;
    if (!['ask', 'trash'].includes(this.current().kind)) menu.addItem(item => item.setTitle(p.t('select')).setIcon('list-checks').onClick(() => { this.selectionMode = true; this.render(true); }));
    if (!['ask', 'trash'].includes(this.current().kind)) {
      menu.addSeparator();
      menu.addItem(item => item.setTitle(p.t('layout')).setIcon(p.prefs.layout === 'list' ? 'columns-2' : 'list').onClick(() => { void p.updateSettings({ layout: p.prefs.layout === 'list' ? 'waterfall' : 'list' }).catch(error => p.report(error)); }));
    }
    menu.addItem(item => item.setTitle(p.t('quickCapture')).setIcon('picture-in-picture-2').onClick(() => this.run(() => p.openQuick())));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(p.t('refresh')).setIcon('refresh-cw').onClick(() => this.run(() => p.refresh())));
    menu.addItem(item => item.setTitle(p.t('settings')).setIcon('settings').onClick(() => {
      const host = this.app as typeof this.app & { setting?: { open(): void; openTabById(id: string): void } };
      host.setting?.open(); host.setting?.openTabById(p.manifest.id);
    }));
  }

  navigate(id: string): void {
    if (id === 'review') { this.plugin.showReview(); return; }
    this.referenceReturn = null;
    this.rememberPosition(); this.tagPath = ''; this.currentId = id;
    this.selectionMode = false; this.selected.clear();
    const remembered = this.positions.get(this.stateKey());
    this.limit = remembered?.limit ?? 40; this.restoreScroll = remembered?.scroll ?? 0;
    this.scroller.scrollTop = 0; if (this.width < 900) this.manualSidebar = false; this.saveLayout(); this.render(true);
    this.applyTag();
    if (id === 'trash') void this.trashPanel?.refresh().catch(error => this.plugin.report(error));
    if (id === 'ask') this.askPanel?.focus();
  }
  focusSearch(): void {
    this.searchActive = true; this.saveLayout(); this.render(true);
    this.searchPanel.input.focus();
  }

  private decorateCard(card: Card): void {
    if (this.highlightQueries.get(card.body) === this.query) return;
    highlightSearch(card.body, this.query); this.highlightQueries.set(card.body, this.query);
    card.el.querySelector('.xj-search-context')?.remove();
    const terms: string[] = [];
    try { compileSearch(this.query, terms); } catch { return; }
    if (!terms.length) return;
    const hit = card.body.querySelector<HTMLElement>('mark.xj-search-hit');
    const hidden = !hit || hit.offsetTop - card.body.offsetTop >= densityValues(this.plugin.prefs).foldHeight;
    if (hidden && !this.expanded.has(card.memo.key)) {
      const normalized = card.memo.body.normalize('NFKC').toLocaleLowerCase();
      const normalizedIndex = terms.map(term => normalized.indexOf(term.normalize('NFKC').toLocaleLowerCase())).find(value => value >= 0);
      if (normalizedIndex !== undefined) {
        let index = 0, foldedOffset = 0;
        for (const part of new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(card.memo.body)) {
          foldedOffset += part.segment.normalize('NFKC').toLocaleLowerCase().length;
          if (foldedOffset > normalizedIndex) { index = part.index; break; }
        }
        const context = element(card.el, 'div', 'xj-search-context');
        const excerpt = element(context, 'span', '', (index > 45 ? '…' : '') + card.memo.body.slice(Math.max(0, index - 45), index + 100) + (index + 100 < card.memo.body.length ? '…' : ''));
        highlightSearch(excerpt, this.query);
        button(context, this.plugin.locale === 'zh' ? '展开小记' : 'Expand memo', () => {
          this.expanded.add(card.memo.key); card.body.classList.remove('is-folded'); context.hidden = true; this.syncCard(card);
          if (hit) hit.scrollIntoView({ block: 'nearest' });
        }, undefined, 'xj-text-button');
      }
    }
  }

  private syncCard(card: Card): void {
    card.checkbox.hidden = !this.selectionMode; card.checkbox.checked = this.selected.has(card.memo.key);
    card.el.classList.toggle('is-selected', this.selected.has(card.memo.key));
    card.body.classList.toggle('is-folded', !this.expanded.has(card.memo.key));
    card.fold.textContent = this.plugin.t(this.expanded.has(card.memo.key) ? 'collapse' : 'expand');
  }

  private measureCards(): void {
    const height = densityValues(this.plugin.prefs).foldHeight;
    if (height !== this.lastFoldHeight) { this.measuredCards.clear(); this.lastFoldHeight = height; }
    for (const card of this.cards.values()) {
      if (this.measuredCards.has(card.memo.key)) continue;
      const folded = card.body.scrollHeight > height + 6;
      card.body.classList.toggle('can-fold', folded);
      card.fold.hidden = !folded;
      this.measuredCards.add(card.memo.key);
    }
  }

  private renderFeed(): void {
    if (!this.feed || this.closed) return;
    const p = this.plugin;
    const sig = JSON.stringify([
      this.recordsRevision, this.stateKey(), this.limit, this.selectionMode,
      [...this.selected].sort().join('|'), [...this.expanded].sort().join('|'),
      [...this.completedFeedback.keys()].sort().join('|'), this.width, densityValues(p.prefs).foldHeight,
      p.locale, p.prefs.dateFormat, p.prefs.tasksIncludeCompleted,
      p.readError ? 1 : 0, p.loading ? 1 : 0, p.repo.duplicates.size,
    ]);
    if (sig === this.feedSignature) return;
    this.feedSignature = sig;
    const top = this.scroller.getBoundingClientRect().top;
    const anchors = [...this.cards.values()].filter(card => card.el.isConnected && card.el.getBoundingClientRect().bottom >= top)
      .slice(0, 3).map(card => ({ key: card.memo.key, offset: card.el.getBoundingClientRect().top - top }));
    empty(this.status);
    if (p.readError) {
      element(this.status, 'p', 'xj-hint', p.t('readFailed'));
      button(this.status, p.t('refresh'), () => this.run(() => p.refresh()), undefined, 'xj-text-button');
    }
    try {
      const key = JSON.stringify([this.stateKey(), this.current(), p.prefs.tasksIncludeCompleted, new Date().toDateString()]);
      if (!this.queryCache || this.queryCache.records !== p.repo.records || this.queryCache.key !== key) {
        this.queryCache = { records: p.repo.records, key, result: selectMemos(p.repo.records, this.current(), this.query, p.prefs, { all: this.allScope, includeArchived: this.includeArchived, tags: this.filterTags }) };
      }
      this.filtered = [...this.queryCache.result];
    }
    catch (error) {
      this.filtered = [];
      element(this.status, 'p', 'xj-hint', p.t(error instanceof MemoError && error.code === 'unsupportedQuery' ? 'unsupportedQuery' : 'invalidQuery'));
    }
    for (const feedback of this.completedFeedback.values()) {
      if (feedback.scope === this.stateKey() && !this.filtered.some(memo => memo.key === feedback.memo.key)) this.filtered.push(feedback.memo);
    }
    if (this.completedFeedback.size) this.filtered.sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.createdAt - a.createdAt || a.key.localeCompare(b.key));
    if (p.repo.duplicates.size) element(this.status, 'p', 'xj-hint', p.t('duplicateWarning', { count: p.repo.duplicates.size }));
    const visible = this.filtered.slice(0, this.limit);
    const keep = new Set(visible.map(memo => memo.key));
    for (const [key, card] of this.cards) if (!keep.has(key)) { this.disposeCard(card); this.cards.delete(key); }
    for (const [key, slot] of this.slots) if (!keep.has(key)) {
      this.visibility?.unobserve(slot.el); slot.el.remove(); this.slots.delete(key);
    }
    let pinCursor = this.pinnedFeed.firstElementChild, regularCursor = this.regularFeed.firstElementChild;
    this.pinnedFeed.hidden = !visible.some(memo => memo.pinned);
    for (const memo of visible) {
      let card = this.cards.get(memo.key);
      if (card && card.memo.raw !== memo.raw) { this.disposeCard(card); this.cards.delete(memo.key); card = undefined; }
      let slot = this.slots.get(memo.key);
      if (!slot) {
        const el = this.root.ownerDocument.win.createFragment().createDiv(); el.className = 'xj-card-slot';
        el.dataset.memoKey = memo.key; slot = { el, memo }; this.slots.set(memo.key, slot);
        if (!this.scroller.clientHeight) {
          card = this.createCard(memo); this.cards.set(memo.key, card); el.appendChild(card.el);
        } else {
          const height = densityValues(p.prefs).foldHeight + 80;
          el.style.setProperty('--xj-slot-height', height + 'px'); el.style.gridRowEnd = 'span ' + Math.ceil((height + densityValues(p.prefs).gap) / 4);
        }
        this.visibility?.observe(el);
      } else if (slot.memo.raw !== memo.raw) {
        slot.memo = memo; slot.el.setCssProps({ '--xj-slot-height': 'auto' });
        card = this.createCard(memo); this.cards.set(memo.key, card); slot.el.appendChild(card.el);
      }
      const zone = memo.pinned ? this.pinnedFeed : this.regularFeed;
      const cursor = memo.pinned ? pinCursor : regularCursor;
      if (cursor !== slot.el) zone.insertBefore(slot.el, cursor);
      else if (memo.pinned) pinCursor = cursor.nextElementSibling;
      else regularCursor = cursor.nextElementSibling;
      if (!card) continue;
      card.checkbox.hidden = !this.selectionMode;
      card.checkbox.checked = this.selected.has(memo.key);
      card.el.classList.toggle('is-selected', this.selected.has(memo.key));
      card.body.classList.toggle('is-folded', !this.expanded.has(memo.key));
      this.decorateCard(card);
      card.fold.textContent = p.t(this.expanded.has(memo.key) ? 'collapse' : 'expand');
      const time = card.el.querySelector('time');
      if (time) time.textContent = p.date(memo);
      card.checkbox.setAttribute('aria-label', p.t('select') + ' ' + p.date(memo));
      const more = card.el.querySelector<HTMLButtonElement>('.xj-card-heading .xj-icon-button');
      if (more) { more.title = p.t('more'); more.setAttribute('aria-label', p.t('more')); }
      this.cardObserver?.observe(card.el);
    }
    this.measureCards();
    if (!visible.length) element(this.status, 'div', 'xj-empty', p.loading ? p.t('loading') : this.query ? p.t('noResults') : p.repo.records.length ? p.t('noResults') : p.t('empty'));
    this.sentinel.hidden = this.limit >= this.filtered.length;
    empty(this.sentinel);
    if (!this.sentinel.hidden) button(this.sentinel, p.t('loadMore'), () => { this.limit += 40; this.renderFeed(); }, undefined, 'xj-text-button');
    if (this.pendingTopScroll) {
      this.scroller.scrollTop = 0; this.pendingTopScroll = false;
    } else if (this.restoreScroll > 0) {
      this.scroller.scrollTop = this.restoreScroll; this.restoreScroll = 0;
    } else {
      const anchor = anchors.find(item => this.cards.has(item.key));
      if (anchor) {
        const next = this.cards.get(anchor.key)!.el.getBoundingClientRect().top - top;
        this.scroller.scrollTop += next - anchor.offset;
      }
    }
  }

  private createCard(memo: Memo): Card {
    const p = this.plugin;
    const node = this.root.ownerDocument.win.createFragment().createEl('article');
    node.className = 'xj-card'; node.setAttribute('role', 'listitem');
    const component = new Component(); component.load();
    const heading = element(node, 'div', 'xj-card-heading');
    const checkbox = element(heading, 'input', 'xj-selection-box');
    checkbox.type = 'checkbox'; checkbox.setAttribute('aria-label', p.t('select') + ' ' + p.date(memo));
    checkbox.addEventListener('change', () => {
      if (checkbox.checked) this.selected.add(memo.key); else this.selected.delete(memo.key);
      this.render(true);
    });
    const time = element(heading, 'time', 'xj-card-time', p.date(memo));
    time.dateTime = new Date(memo.createdAt).toISOString();
    time.title = memo.id;
    if (memo.pinned) element(heading, 'span', 'xj-pin-marker', '↑').setAttribute('aria-label', p.t('pinned'));
    button(heading, p.t('more'), event => this.memoMenu(memo, event), 'ellipsis');
    const body = element(node, 'div', 'xj-card-body xj-markdown markdown-rendered is-folded');
    const fold = button(node, p.t('expand'), () => {
      const open = !this.expanded.has(memo.key);
      if (open) this.expanded.add(memo.key); else this.expanded.delete(memo.key);
      body.classList.toggle('is-folded', !open);
      fold.textContent = p.t(open ? 'collapse' : 'expand');
    }, undefined, 'xj-fold-button');
    fold.hidden = true;
    const tags = element(node, 'div', 'xj-card-tags');
    const card: Card = { el: node, component, memo, checkbox, body, fold, alive: true };
    this.cardByEl.set(node, card);
    let selectedBeforePointer = false;
    node.addEventListener('pointerdown', () => { selectedBeforePointer = Boolean(node.ownerDocument.defaultView?.getSelection()?.toString()); });
    node.addEventListener('dblclick', event => {
      if (this.selectionMode || selectedBeforePointer || interactiveTarget(event)) return;
      event.preventDefault(); node.ownerDocument.defaultView?.getSelection()?.removeAllRanges();
      void this.editMemo(memo).catch(error => p.report(error));
    });
    node.addEventListener('contextmenu', event => { event.preventDefault(); this.memoMenu(memo, event); });
    node.addEventListener('click', event => {
      if (!this.selectionMode) return;
      if (Date.now() < this.suppressCardClick) { event.preventDefault(); event.stopImmediatePropagation(); return; }
      const target = event.target as Element;
      if (target.closest('.xj-selection-box,.xj-card-heading button')) return;
      event.preventDefault(); event.stopImmediatePropagation();
      if (this.selected.has(memo.key)) this.selected.delete(memo.key); else this.selected.add(memo.key);
      this.render(true);
    }, true);
    body.addEventListener('click', event => {
      const target = event.target as Element | null;
      const tag = target?.closest<HTMLAnchorElement>('a.tag');
      if (tag) { event.preventDefault(); event.stopPropagation(); this.openTag(tag.textContent?.replace(/^#/, '') ?? ''); return; }
      const link = target?.closest<HTMLAnchorElement>('a.internal-link');
      if (link) {
        event.preventDefault(); event.stopPropagation();
        const value = link.dataset.href ?? link.getAttribute('href') ?? '';
        this.run(() => this.app.workspace.openLinkText(value, memo.path, event.ctrlKey || event.metaKey));
      }
    });
    void MarkdownRenderer.render(p.app, memo.body, body, memo.path, component).then(() => {
      if (!card.alive) return;
      p.renderReferences(body);
      const footerTags = new Set<string>();
      for (const paragraph of [...body.querySelectorAll('p')]) {
        if (paragraph.querySelectorAll('a.tag').length && /^(?:#[\p{L}\p{N}_/-]+\s*)+$/u.test(paragraph.textContent?.trim() ?? '')) {
          for (const tag of paragraph.querySelectorAll<HTMLAnchorElement>('a.tag')) footerTags.add(tag.textContent?.replace(/^#/, '') ?? '');
          paragraph.remove();
        }
      }
      for (const tag of memo.tags.filter(tag => footerTags.has(tag))) button(tags, '#' + tag, () => this.openTag(tag), undefined, 'xj-tag');
      const tasks = [...body.querySelectorAll<HTMLInputElement>('input.task-list-item-checkbox')];
      tasks.forEach((task, index) => {
        task.disabled = false;
        task.addEventListener('click', event => event.stopPropagation());
        task.addEventListener('change', () => {
          task.disabled = true;
          this.run(async () => {
            try {
              const updated = await p.repo.toggleTask(memo, index);
              const kind = this.current().kind;
              if (kind === 'tasks' && updated.tasks.incomplete === 0 && !p.prefs.tasksIncludeCompleted) {
                const previous = this.completedFeedback.get(updated.key); if (previous) window.clearTimeout(previous.timer);
                const timer = window.setTimeout(() => { this.completedFeedback.delete(updated.key); if (!this.closed) this.renderFeed(); }, 1000);
                this.completedFeedback.set(updated.key, { memo: updated, scope: this.stateKey(), timer });
              }
            } finally { await p.refresh(); }
          });
        });
      });
      const checkFold = (): void => {
        if (!card.alive) return;
        const height = densityValues(p.prefs).foldHeight;
        fold.hidden = body.scrollHeight <= height + 6;
        body.classList.toggle('can-fold', !fold.hidden);
      };
      this.highlightQueries.delete(body); this.decorateCard(card);
      checkFold();
      for (const image of body.querySelectorAll('img')) image.addEventListener('load', checkFold, { once: true });
    }).catch(error => { if (card.alive) { body.textContent = memo.body; p.report(error); } });
    return card;
  }

  private openTag(tag: string): void {
    this.rememberPosition(); this.tagPath = tag; this.currentId = 'all'; this.limit = 40;
    this.selectionMode = false; this.selected.clear(); this.scroller.scrollTop = 0;
    if (this.width < 900) this.manualSidebar = false;
    this.saveLayout(); this.render(true);
    this.applyTag();
  }

  private memoMenu(memo: Memo, event: MouseEvent): void {
    const p = this.plugin;
    const menu = new Menu();
    menu.addItem(item => item.setTitle(p.t('edit')).setIcon('pencil').onClick(() => this.run(() => this.editMemo(memo))));
    menu.addItem(item => item.setTitle(p.t('copy')).setIcon('copy').onClick(() => this.run(() => p.clipboard(memo.body, this.root.ownerDocument))));
    menu.addItem(item => item.setTitle(p.t('citeMemo')).setIcon('at-sign').onClick(() => {
      this.composer?.appendLine('@' + memo.id); this.focusComposer();
    }));
    menu.addItem(item => item.setTitle(p.t('openSource')).setIcon('file-text').onClick(() => this.run(() => p.openSource(memo))));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(p.t(memo.pinned ? 'unpin' : 'pin')).setIcon('pin').onClick(() => this.run(async () => { await p.repo.setPinned(memo, !memo.pinned); this.restoreScroll = 0; await p.refresh(); this.scroller.scrollTop = 0; if (!memo.pinned) new Notice(p.t('pinDone')); })));
    menu.addItem(item => item.setTitle(p.t(memo.archived ? 'unarchive' : 'doArchive')).setIcon('archive').onClick(() => this.run(async () => { await p.repo.setArchived(memo, !memo.archived); await p.refresh(); })));
    menu.addItem(item => item.setTitle(p.t('select')).setIcon('check-square').onClick(() => { this.selectionMode = true; this.selected.add(memo.key); this.render(true); }));
    menu.addSeparator();
    menu.addItem(item => item.setTitle(p.t('delete')).setIcon('trash-2').onClick(() => this.run(async () => {
      const entry = await p.repo.delete(memo); await p.refresh(); this.offerUndo([entry]);
    })));
    menu.showAtMouseEvent(event);
  }

  private selectedMemos(): Memo[] { return this.filtered.filter(memo => this.selected.has(memo.key)); }
  private isArchiveView(): boolean { return this.current().kind === 'archive'; }
  private tagSelection(): void {
    const p = this.plugin;
    new TextModal(p, p.t('addTag'), [{ label: p.t('tagName'), value: '' }], async values => {
      await this.bulk('tag', values[0]);
    }).open();
  }
  private async bulk(action: 'archive' | 'delete' | 'tag', tag?: string): Promise<void> {
    if (this.bulkBusy) return;
    const p = this.plugin;
    const memos = this.selectedMemos();
    if (!memos.length) { new Notice(p.t('noSelection')); return; }
    this.bulkBusy = true;
    for (const control of this.toolbar.querySelectorAll<HTMLButtonElement>('button')) control.disabled = true;
    const deletedEntries: TrashStoreEntry[] = [];
    let done = 0; let failed = 0;
    for (const memo of memos) {
      try {
        if (action === 'archive') await p.repo.setArchived(memo, !this.isArchiveView());
        else if (action === 'delete') deletedEntries.push(await p.repo.delete(memo));
        else await p.repo.addTag(memo, tag ?? '');
        this.selected.delete(memo.key); done++;
      } catch (error) { failed++; p.report(error); }
    }
    if (!failed) this.selectionMode = false;
    try { await p.refresh(); } finally { this.bulkBusy = false; this.render(true); }
    if (failed) new Notice(p.t('partial', { done, failed }), 9000);
    if (deletedEntries.length) this.offerUndo(deletedEntries);
  }

  private run(action: () => Promise<unknown> | void): void { void Promise.resolve().then(action).catch(error => this.plugin.report(error)); }
  private disposeCard(card: Card): void {
    card.alive = false; this.cardObserver?.unobserve(card.el); this.measuredCards.delete(card.memo.key); card.component.unload(); card.el.remove();
  }

  async revealMemo(memo: Memo): Promise<void> {
    this.referenceReturn ??= this.getState();
    this.tagPath = ''; this.currentId = memo.archived ? 'archive' : 'all'; this.query = ''; this.filterTags = []; this.allScope = false; this.includeArchived = false;
    this.selectionMode = false; this.selected.clear(); this.restoreScroll = 0;
    const all = selectMemos(this.plugin.repo.records, this.current(), '', this.plugin.prefs);
    this.limit = Math.max(40, all.findIndex(item => item.key === memo.key) + 1);
    this.expanded.add(memo.key); this.render(true);
    let card = this.cards.get(memo.key);
    const slot = this.slots.get(memo.key);
    if (!card && slot) {
      card = this.createCard(memo); this.cards.set(memo.key, card); slot.el.setCssProps({ '--xj-slot-height': 'auto' });
      slot.el.appendChild(card.el); this.cardObserver?.observe(card.el); this.syncCard(card);
    }
    if (card) { card.el.scrollIntoView({ block: 'center' });
      window.clearTimeout(this.revealTimer); this.revealed?.classList.remove('is-revealed');
      this.revealed = card.el; void card.el.offsetWidth; card.el.classList.add('is-revealed');
      this.revealTimer = window.setTimeout(() => card.el.classList.remove('is-revealed'), 1800); }
  }

  async onClose(): Promise<void> {
    void this.plugin.flushDrafts?.().catch(error => this.plugin.report(error));
    this.marqueeCleanup?.(); this.marqueeCleanup = null;
    this.searchPanel?.destroy();
    this.cancelFeedTimer();
    if (this.feedFrame !== null) this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.feedFrame); this.feedFrame = null;
    if (this.geometryFrame !== null) this.root.ownerDocument.defaultView?.cancelAnimationFrame(this.geometryFrame);
    window.clearTimeout(this.revealTimer);
    this.closed = true; this.sorter?.destroy(); this.sorter = null; this.askPanel?.unload(); this.trashPanel?.unload();
    this.unsubscribe?.(); this.observer?.disconnect(); this.cardObserver?.disconnect(); this.intersection?.disconnect(); this.visibility?.disconnect();
    for (const feedback of this.completedFeedback.values()) window.clearTimeout(feedback.timer);
    this.completedFeedback.clear();
    this.composer?.unload(); this.composer = null;
    for (const card of this.cards.values()) this.disposeCard(card);
    this.cards.clear(); this.slots.clear(); empty(this.contentEl);
  }
}

export class QuickView extends ItemView {
  private editor: MemoEditor | null = null;
  private key = 'quick-capture';
  private windowCleanup: (() => void) | null = null;
  private locale = '';
  private closed = false;
  private editorDocument: Document | null = null;
  private windowDocument: Document | null = null;
  private sourcePath = '';
  private busy = false;
  private unsubscribe: (() => void) | null = null;
  constructor(leaf: WorkspaceLeaf, private plugin: XiaojiPlugin) { super(leaf); }
  getViewType(): string { return QUICK_TYPE; }
  getDisplayText(): string { return this.plugin.t('quickCapture'); }
  getIcon(): string { return 'notebook-pen'; }
  getState(): Record<string, unknown> { return { draftKey: this.key }; }
  async setState(state: Record<string, unknown>, result: ViewStateResult): Promise<void> {
    const oldKey = this.key;
    if (typeof state.draftKey === 'string') this.key = state.draftKey;
    await super.setState(state, result);
    if (this.editor && oldKey !== this.key) { this.editor.unload(); this.editor = null; this.build(); }
  }
  async onOpen(): Promise<void> {
    this.closed = false;
    this.contentEl.classList.add('xj-view-content');
    bindErrors(this.contentEl, error => this.plugin.report(error));
    this.build();
    this.syncWindow();
    this.unsubscribe = this.plugin.subscribe(() => {
      if (this.locale !== this.plugin.locale && !this.busy) {
        const position = this.editor?.view.state.selection.main.head ?? 0; this.editor?.unload(); this.editor = null; const rebuilt = this.build(); rebuilt.moveCursor(position); return;
      }
      const text = this.plugin.data.drafts[this.key]?.text ?? '';
      if (this.editor && !this.editor.view.hasFocus && this.editor.getValue() !== text) this.editor.setValue(text);
    });
  }
  private syncWindow(): void {
    if (this.closed) return;
    const doc = this.contentEl.ownerDocument;
    if (doc !== this.windowDocument) {
      this.windowCleanup?.(); this.windowDocument = doc;
      const mainDocument = this.app.workspace.containerEl?.ownerDocument ?? document;
      if (doc === mainDocument) this.windowCleanup = null;
      else {
        this.plugin.syncQuickWindow(this.leaf);
        const bounds = this.plugin.watchQuickBounds(this.leaf);
        const chrome = compactQuickWindow(doc, this.plugin.quickWindowControls(this.leaf));
        // Cmd+W in this dedicated window hides the reusable popout instead of tearing down
        // the leaf, which would force a fresh window on the next capture.
        const onKey = (event: KeyboardEvent): void => {
          if (event.isComposing) return;
          const key = event.key.toLowerCase();
          if (key === 'w' && (event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
            event.preventDefault(); event.stopPropagation();
            this.plugin.quickWindowAction(this.leaf, 'close');
            return;
          }
          if (event.key === 'Escape' && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey) {
            // Let CodeMirror close its completion popup first; only hide the window otherwise.
            if (this.editor?.hasOpenCompletion()) return;
            event.preventDefault(); event.stopPropagation();
            this.plugin.quickWindowAction(this.leaf, 'close');
          }
        };
        doc.addEventListener('keydown', onKey, true);
        this.windowCleanup = () => { bounds(); chrome(); doc.removeEventListener('keydown', onKey, true); };
      }
      if (doc !== mainDocument && this.plugin.prefs.quickPin && this.plugin.windowPinState(this.leaf) !== true) this.plugin.toggleWindowPin(this.leaf);
    }
    if (this.editor && doc !== this.editorDocument && !this.busy) {
      const position = this.editor.view.state.selection.main.head; this.editor.unload(); this.editor = null;
      const editor = this.build(); editor.moveCursor(position);
    }
  }
  onResize(): void { this.syncWindow(); }
  private build(): MemoEditor {
    const p = this.plugin; this.locale = p.locale; this.editorDocument = this.contentEl.ownerDocument; empty(this.contentEl);
    const root = element(this.contentEl, 'div', 'xj-quick');
    const top = element(root, 'header', 'xj-quick-toolbar');
    const pin = button(top, p.t('windowPin'), () => {
      const state = p.toggleWindowPin(this.leaf);
      pin.classList.toggle('is-active', state === true);
      pin.setAttribute('aria-pressed', String(state === true));
    }, 'pin');
    pin.disabled = this.contentEl.ownerDocument === (this.app.workspace.containerEl?.ownerDocument ?? document);
    pin.classList.toggle('is-active', p.windowPinState(this.leaf) === true);
    pin.setAttribute('aria-pressed', String(p.windowPinState(this.leaf) === true));
    element(top, 'span', 'xj-quick-drag');
    const controls = element(top, 'div', 'xj-quick-window-actions');
    button(controls, p.t('close'), () => p.quickWindowAction(this.leaf, 'close'), 'x', 'xj-window-close');
    const draft = p.data.drafts[this.key];
    this.sourcePath = draft?.sourcePath ?? p.sourcePath();
    this.editor = new MemoEditor(root, p, {
      value: draft?.text ?? '', sourcePath: this.sourcePath,
      onChange: value => p.setDraft(this.key, value, undefined, { sourcePath: this.sourcePath }),
      onSubmit: () => this.save(),
      onContinue: async () => {
        if (this.busy || !this.editor || this.editor.view.composing) return;
        const editor = this.editor; this.busy = true; editor.setBusy(true);
        try { await editor.waitForAttachments(); await p.continueQuick(editor.getValue(), this.sourcePath); await p.clearDraft(this.key); editor.setValue(''); p.quickWindowAction(this.leaf, 'close'); }
        catch (error) { p.report(error); }
        finally { this.busy = false; this.editor?.setBusy(false); }
      },
      onLateAttachment: value => p.recoverAttachment(value),
    });
    this.editor.focus(); return this.editor;
  }
  focusEditor(): void {
    this.syncWindow();
    const doc = this.contentEl.ownerDocument;
    const commit = (): void => {
      if (this.closed || !this.editor) return;
      this.editor.focus();
      // Resume typing at the end of the draft instead of at the first character.
      this.editor.moveCursor(this.editor.view.state.doc.length);
      const pin = this.contentEl.querySelector<HTMLButtonElement>('.xj-quick-toolbar button[aria-pressed]');
      if (pin) { const active = this.plugin.windowPinState(this.leaf) === true; pin.classList.toggle('is-active', active); pin.setAttribute('aria-pressed', String(active)); }
    };
    commit();
    // While the popout is still becoming the key window macOS can hand focus to the first
    // focusable element (the toolbar pin button). Keep nudging the caret into the editor.
    let attempts = 0;
    const retry = (): void => {
      if (this.closed || !this.editor || attempts >= 6) return;
      if (doc.activeElement !== this.editor.view.contentDOM) commit();
      attempts += 1;
      if (attempts < 6) doc.defaultView?.setTimeout(retry, 60);
    };
    doc.defaultView?.setTimeout(retry, 60);
  }
  private async save(): Promise<void> {
    if (!this.editor || this.busy) return;
    const editor = this.editor, draft = this.plugin.data.drafts[this.key];
    this.busy = true; editor.setBusy(true);
    try {
      await editor.waitForAttachments(); if (this.editor !== editor || this.closed) return;
      await this.plugin.createMemo(editor.getValue(), this.sourcePath);
      (this.app.workspace.getLeavesOfType?.(VIEW_TYPE) ?? []).forEach(leaf => (leaf.view as MemoView).requestTopScroll());
      if (this.editor === editor) { editor.setValue(''); await this.plugin.clearDraft(this.key).catch(error => this.plugin.report(error)); }
      else if (this.plugin.data.drafts[this.key] === draft) await this.plugin.clearDraft(this.key).catch(error => this.plugin.report(error));
      await this.plugin.refresh();
      new Notice(this.plugin.t('savedMemo'));
      if (this.contentEl.ownerDocument !== (this.app.workspace.containerEl?.ownerDocument ?? document)) this.plugin.quickWindowAction(this.leaf, 'close');
    } catch (error) { this.plugin.report(error); }
    finally { this.busy = false; this.editor?.setBusy(false); this.syncWindow(); this.editor?.focus(); }
  }
  async onClose(): Promise<void> { void this.plugin.flushDrafts?.().catch(error => this.plugin.report(error)); this.closed = true; this.windowCleanup?.(); this.windowCleanup = null; this.windowDocument = null; this.unsubscribe?.(); this.editor?.unload(); this.editor = null; empty(this.contentEl); }
}
