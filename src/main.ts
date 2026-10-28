import {
  Plugin, TFile, TFolder, Notice, Platform, Menu, getLanguage,
  type App, type WorkspaceLeaf,
} from 'obsidian';
import { secretStore } from './core/secret-store';
import { quickBounds, type WindowBounds } from './core/quick-window';
import { CaptureShortcut, type CaptureStatus } from './core/capture-shortcut';
import { Repository } from './core/repository';
import { TrashStore } from './core/trash-store';
import { Conversations } from './core/conversations';
import { fileForDate, displayDate, timestamp, validateStorageSettings } from './core/dates';
import { parseMemos } from './core/markdown';
import { rewriteLinks } from './core/links';
import { hasControlCharacters, loadSettings, normalizeFolder, safeFileName, isChatPath } from './core/settings';
import { MemoError, type Draft, type FilePort, type Memo, type NavItem, type PluginData, type Settings } from './core/types';
import { isMessageKey, resolveLanguage, translate, type Locale, type MessageKey } from './i18n';
import { MemoView, QuickView, VIEW_TYPE, QUICK_TYPE } from './ui/view';
import { XiaojiSettings } from './ui/settings';
import { ReviewModal } from './ui/modals';
import { ReferencePreview } from './ui/references';
import { CodexClient, type CodexInfo } from './core/codex';
import { createAIBackend, type AIBackend } from './ui/ai-backend';

interface QuickNativeWindow {
  isAlwaysOnTop(): boolean; setAlwaysOnTop(value: boolean): void;
  getBounds?(): WindowBounds; setBounds?(bounds: WindowBounds): void; isMinimized?(): boolean; isMaximized?(): boolean;
  isFullScreen?(): boolean; setFullScreen?(value: boolean): void; isSimpleFullScreen?(): boolean; setSimpleFullScreen?(value: boolean): void;
  isFullScreenable?(): boolean; setFullScreenable?(value: boolean): void; setMaximizable?(value: boolean): void; setMinimizable?(value: boolean): void;
  setWindowButtonVisibility?(visible: boolean): void;
  setVisibleOnAllWorkspaces?(visible: boolean, options?: { visibleOnFullScreen?: boolean; skipTransformProcessType?: boolean }): void;
  restore?(): void; hide?(): void; show?(): void; focus?(): void; minimize?(): void; maximize?(): void; unmaximize?(): void;
  on?(event: string, callback: () => void): void;
  removeListener?(event: string, callback: () => void): void;
}

export class VaultFiles implements FilePort {
  constructor(private readonly app: App) {}
  revision(path: string): string | number | undefined {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    return file.stat.mtime + ':' + file.stat.size;
  }
  async listMarkdown(): Promise<string[]> { return this.app.vault.getMarkdownFiles().map(file => file.path); }
  private file(path: string): TFile {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) throw new MemoError('writeFailed');
    return file;
  }
  async read(path: string): Promise<string> { return this.app.vault.read(this.file(path)); }
  async exists(path: string): Promise<boolean> { return this.app.vault.getAbstractFileByPath(path) !== null; }
  async ensureFolder(path: string): Promise<void> {
    const parts = path.split('/').filter(Boolean);
    for (let i = 1; i <= parts.length; i++) {
      const current = parts.slice(0, i).join('/');
      const existing = this.app.vault.getAbstractFileByPath(current);
      if (existing instanceof TFolder) continue;
      if (existing) throw new MemoError('invalidFolder');
      try { await this.app.vault.createFolder(current); }
      catch (error) { if (!(this.app.vault.getAbstractFileByPath(current) instanceof TFolder)) throw error; }
    }
  }
  async create(path: string, text: string): Promise<void> {
    const slash = path.lastIndexOf('/');
    await this.ensureFolder(slash < 0 ? '' : path.slice(0, slash));
    await this.app.vault.create(path, text);
  }
  async process(path: string, update: (current: string) => string): Promise<void> {
    await this.app.vault.process(this.file(path), update);
  }
  async remove(path: string): Promise<void> {
    if (!path.includes('/_回收站/')) throw new MemoError('invalidTrash');
    await this.app.vault.delete(this.file(path));
  }
  async erase(path: string, expected: string): Promise<void> {
    const file = this.file(path);
    await this.app.vault.process(file, current => { if (current !== expected) throw new MemoError('chatConflict'); return current; });
    await this.app.vault.delete(file);
  }
  async move(from: string, to: string): Promise<void> {
    if (await this.exists(to)) throw new MemoError('restoreDuplicate');
    const slash = to.lastIndexOf('/'); await this.ensureFolder(slash < 0 ? '' : to.slice(0, slash));
    await this.app.fileManager.renameFile(this.file(from), to);
  }
}

export default class XiaojiPlugin extends Plugin {
  data!: PluginData;
  files!: VaultFiles;
  repo!: Repository;
  chats!: Conversations;
  private subscribers = new Set<() => void>();
  private refreshTimer: number | null = null;
  private saving: Promise<void> | null = null;
  private dirty = false;
  private draftTimer: number | null = null;
  private settingsTail: Promise<unknown> = Promise.resolve();
  private sessionApiKey = '';
  private codexClient: CodexClient | null = null;
  private tagCache: string[] | null = null;
  private stopped = false;
  private openingQuick: Promise<void> | null = null;
  private capture = new CaptureShortcut({
    desktop: !Platform.isMobile,
    mac: Platform.isMacOS || Platform.isIosApp,
    settings: () => this.prefs,
    documents: () => {
      const docs = [this.app.workspace.containerEl.ownerDocument];
      this.app.workspace.iterateAllLeaves(leaf => {
        const doc = leaf.view.containerEl.ownerDocument;
        if (!docs.includes(doc)) docs.push(doc);
      });
      return docs;
    },
    capture: () => { if (!this.stopped) void this.openQuick().catch(error => this.report(error)); },
    report: error => { this.report(error); },
    onWindowOpen: callback => { this.registerEvent(this.app.workspace.on('window-open', (_host, win) => callback(win))); },
    onWindowClose: callback => { this.registerEvent(this.app.workspace.on('window-close', (_host, win) => callback(win))); },
    keep: dispose => { this.register(dispose); },
  });
  private initialScanStarted = false;
  loading = true;
  readError = false;

  get prefs(): Settings { return this.data.settings; }
  get locale(): Locale { return resolveLanguage(this.prefs.language, getLanguage()); }
  t(key: MessageKey, values: Record<string, string | number> = {}): string { return translate(this.locale, key, values); }
  navLabel(item: NavItem): string { return item.title || this.t(item.kind); }
  date(memo: Memo): string { return displayDate(memo.createdAt, this.prefs.dateFormat, this.locale); }

  async onload(): Promise<void> {
    const raw: unknown = await this.loadData();
    const stored = raw && typeof raw === 'object' ? raw as Record<string, unknown> : {};
    const drafts = this.parseDrafts(stored.drafts);
    const chatInputs = Object.fromEntries(Object.entries(stored.chatInputs && typeof stored.chatInputs === 'object' ? stored.chatInputs : {})
      .filter(([key, value]) => /^(new|\d{17})$/.test(key) && typeof value === 'string').map(([key, value]) => [key, (value as string).slice(0, 12000)]));
    this.data = { schema: 1, settings: loadSettings(stored.settings), drafts, chatInputs,
      lastChatId: typeof stored.lastChatId === 'string' && /^\d{17}$/.test(stored.lastChatId) ? stored.lastChatId : undefined };
    this.files = new VaultFiles(this.app);
    this.repo = new Repository(this.files, new TrashStore(this.files, () => this.prefs.folder), () => this.prefs);
    const stateRoot = this.app.vault.configDir + '/plugins/' + this.manifest.id + '/conversations';
    const adapter = this.app.vault.adapter;
    const statePath = (id: string): string => { if (!/^\d{17}$/.test(id)) throw new MemoError('chatInvalid'); return stateRoot + '/' + id + '.json'; };
    this.chats = new Conversations(this.files, () => this.prefs.chatFolder, () => this.prefs.folder, {
      read: async id => await adapter.exists(statePath(id)) ? adapter.read(statePath(id)) : null,
      write: async (id, raw) => { if (!(await adapter.exists(stateRoot))) { try { await adapter.mkdir(stateRoot); } catch (error) { if (!(await adapter.exists(stateRoot))) throw error; } } await adapter.write(statePath(id), raw); },
      remove: async id => { if (await adapter.exists(statePath(id))) await adapter.remove(statePath(id)); },
    }, () => this.prefs.chatFolders ?? []);
    this.registerView(VIEW_TYPE, leaf => new MemoView(leaf, this));
    this.registerView(QUICK_TYPE, leaf => new QuickView(leaf, this));
    this.addSettingTab(new XiaojiSettings(this.app, this));
    this.addRibbonIcon('notebook-pen', this.t('openWorkspace'), () => { void this.openView().catch(error => this.report(error)); });
    this.addCommand({ id: 'open', name: this.t('openWorkspace'), callback: () => { void this.openView().catch(error => this.report(error)); } });
    this.addCommand({ id: 'capture', name: this.t('quickCapture'), callback: () => { void this.openQuick().catch(error => this.report(error)); } });
    this.capture.install();
    this.addCommand({ id: 'search', name: this.t('search'), callback: () => { void this.openView().then(view => view.focusSearch()).catch(error => this.report(error)); } });
    this.addCommand({ id: 'recycle-bin', name: this.t('trash'), callback: () => { this.showTrash(); } });
    this.addCommand({ id: 'review', name: this.t('review'), checkCallback: checking => {
      if (!this.prefs.reviewEnabled) return false;
      if (!checking) new ReviewModal(this).open();
      return true;
    } });
    this.addCommand({ id: 'ask', name: this.t('ask'), checkCallback: checking => {
      if (!this.prefs.aiEnabled) return false;
      if (!checking) this.showAi();
      return true;
    } });
    this.registerMarkdownPostProcessor(element => this.renderReferences(element));
    this.registerObsidianProtocolHandler('xiaoji', params => { void this.handleLink(params).catch(error => this.report(error)); });
    const changed = (file: { path: string }, oldPath?: string): void => {
      if (isChatPath(file.path, this.prefs) && (!oldPath || isChatPath(oldPath, this.prefs))) return;
      const folder = this.prefs.folder;
      if (file.path === folder || file.path.startsWith(folder + '/') || oldPath === folder || oldPath?.startsWith(folder + '/')) {
        if (file.path === folder + '/回收站.md' || oldPath === folder + '/回收站.md') this.repo.invalidateTrash();
        this.repo.invalidate(file.path); if (oldPath) this.repo.invalidate(oldPath); this.refreshSoon();
      }
    };
    this.registerEvent(this.app.vault.on('modify', changed));
    this.registerEvent(this.app.vault.on('create', changed));
    this.registerEvent(this.app.vault.on('delete', changed));
    this.registerEvent(this.app.vault.on('rename', changed));
    this.app.workspace.onLayoutReady(() => { this.capture.initial(); });
  }

  onunload(): void {
    this.stopped = true;
    this.capture.dispose();
    this.codexClient?.dispose(); this.codexClient = null;
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.subscribers.clear();
    this.sessionApiKey = '';
    void this.flushDrafts().catch(() => undefined);
  }

  subscribe(callback: () => void): () => void {
    this.subscribers.add(callback);
    return () => { this.subscribers.delete(callback); };
  }
  notify(): void { if (!this.stopped) for (const callback of this.subscribers) callback(); }
  refreshSoon(): void {
    if (this.refreshTimer) window.clearTimeout(this.refreshTimer);
    this.refreshTimer = window.setTimeout(() => { this.refreshTimer = null; void this.refresh().catch(error => this.report(error)); }, 180);
  }
  async refresh(): Promise<void> {
    try { await this.repo.scan(() => this.notify()); this.tagCache = null; this.readError = false; }
    catch (error) { this.readError = true; console.error('[xiaoji] Index refresh failed', error); throw new MemoError('readFailed'); }
    finally { this.loading = false; this.notify(); }
  }

  updateSettings(update: Partial<Settings> | ((current: Settings) => Partial<Settings>), validateStorage = false): Promise<void> {
    const patch = typeof update === 'function' ? update : JSON.parse(JSON.stringify(update)) as Partial<Settings>;
    const next = this.settingsTail.then(() => this.applySettings(typeof patch === 'function' ? patch(this.prefs) : patch, validateStorage));
    this.settingsTail = next.catch(() => undefined); return next;
  }
  private async applySettings(update: Partial<Settings>, validateStorage: boolean): Promise<void> {
    const targetMemo = normalizeFolder(update.folder ?? this.prefs.folder), targetChat = normalizeFolder(update.chatFolder ?? this.prefs.chatFolder);
    if (targetMemo === targetChat || targetMemo.startsWith(targetChat + '/') || ['_回收站','_格式备份','格式备份'].some(n => targetChat === targetMemo+'/'+n || targetChat.startsWith(targetMemo+'/'+n+'/'))) throw new MemoError('invalidFolder');
    const next = loadSettings({ ...this.prefs, ...update });
    next.chatFolders = [...new Set([...(this.prefs.chatFolders ?? []), this.prefs.chatFolder, next.chatFolder])];
    const notes = normalizeFolder(next.folder), chats = normalizeFolder(next.chatFolder);
    if (notes === chats || notes.startsWith(chats + '/')) throw new MemoError('invalidFolder');
    if (validateStorage) validateStorageSettings(next);
    const previous = this.data.settings;
    const changedKey = this.capture.changed(next, previous);
    if (changedKey) this.capture.apply(next);
    this.data.settings = next;
    try { await this.persist(); }
    catch (error) {
      this.data.settings = previous;
      if (changedKey) this.capture.rollback(previous);
      throw error;
    }
    if (next.codexPath !== previous.codexPath || next.aiProvider !== previous.aiProvider || !next.aiEnabled && previous.aiEnabled) { this.codexClient?.dispose(); this.codexClient = null; }
    this.tagCache = null;
    if (next.folder !== previous.folder || next.chatFolder !== previous.chatFolder) await this.refresh();
    else this.notify();
  }

  private codex(): CodexClient {
    if (Platform.isMobile) throw new MemoError('codexDesktopOnly');
    return this.codexClient ??= new CodexClient(this.prefs.codexPath);
  }
  inspectCodex(): Promise<CodexInfo> { return this.codex().inspect(); }
  async verifyCodexModel(signal: AbortSignal): Promise<void> {
    await this.codex().complete({ model: this.prefs.codexModel, stream: true, messages: [
      { role: 'system', content: 'This is a connection test. Reply only OK. Do not use tools.' },
      { role: 'user', content: 'Reply OK.' },
    ] }, signal, () => undefined);
  }
  aiBackend(): AIBackend { return createAIBackend(this.prefs, this.prefs.aiProvider === 'api' ? this.apiKey() : '', this.prefs.aiProvider === 'codex' ? this.codex() : undefined); }

  persist(): Promise<void> {
    if (this.draftTimer) { window.clearTimeout(this.draftTimer); this.draftTimer = null; }
    this.dirty = true;
    if (this.saving) return this.saving;
    this.saving = (async () => {
      while (this.dirty) {
        this.dirty = false;
        const snapshot = JSON.parse(JSON.stringify(this.data)) as PluginData;
        await this.saveData(snapshot);
      }
    })().finally(() => {
      this.saving = null;
      if (this.dirty && !this.stopped) void this.persist().catch(error => this.report(error));
    });
    return this.saving;
  }

  scheduleDraftSave(): void {
    if (this.draftTimer) window.clearTimeout(this.draftTimer);
    this.draftTimer = window.setTimeout(() => { this.draftTimer = null; void this.persist().catch(error => this.report(error)); }, 250);
  }
  flushDrafts(): Promise<void> {
    if (!this.draftTimer) return this.saving ?? Promise.resolve();
    window.clearTimeout(this.draftTimer); this.draftTimer = null; return this.persist();
  }
  setDraft(key: string, text: string, memo?: Memo, metadata: Partial<Draft> = {}): void {
    if (text) this.data.drafts[key] = { ...metadata, text, updatedAt: Date.now(), memoId: memo?.id, originalRaw: memo?.raw };
    else delete this.data.drafts[key];
    this.scheduleDraftSave();
  }
  recoverAttachment(text: string): void {
    this.setDraft('attachment-' + crypto.randomUUID(), text);
    new Notice(this.t('attachmentRecovered'));
  }
  async clearDraft(key: string): Promise<void> { delete this.data.drafts[key]; await this.persist(); }
  sourcePath(): string { return fileForDate(new Date(), this.prefs); }

  private optionalText = (value: unknown): string | undefined => typeof value === 'string' ? value : undefined;

  /** Drafts live in one JSON blob keyed by input location, so every entry is validated as untrusted data. */
  private parseDrafts(value: unknown): Record<string, Draft> {
    const drafts: Record<string, Draft> = {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) return drafts;
    for (const [key, entry] of Object.entries(value)) {
      if (!entry || typeof entry !== 'object') continue;
      const draft = entry as Record<string, unknown>;
      if (typeof draft.text !== 'string' || typeof draft.updatedAt !== 'number') continue;
      const memoId = typeof draft.memoId === 'string' && /^\d{17}$/.test(draft.memoId) ? draft.memoId : undefined;
      // Drafts from before ids were the identity cannot be restored, so drop them outright.
      if (!memoId && (typeof draft.memoKey === 'string' || key.endsWith('-edit'))) continue;
      drafts[key] = {
        text: draft.text, updatedAt: draft.updatedAt,
        memoId,
        originalRaw: this.optionalText(draft.originalRaw),
        sourcePath: this.optionalText(draft.sourcePath),
        kind: 'memo',
        title: this.optionalText(draft.title),
        folder: this.optionalText(draft.folder),
        autoTag: this.optionalText(draft.autoTag),
      };
    }
    return drafts;
  }

  tags(): string[] {
    if (this.tagCache) return this.tagCache;
    const tags = new Set(this.repo.records.flatMap(memo => memo.tags));
    this.tagCache = [...tags].sort((a, b) => a.localeCompare(b));
    return this.tagCache;
  }

  async addAttachment(file: File, sourcePath: string): Promise<string> {
    const supplied = file.name || 'attachment-' + timestamp();
    const name = safeFileName([...supplied].map(character => /[\\/:*?"<>|]/.test(character) || hasControlCharacters(character) ? '-' : character).join('').replace(/[. ]+$/, '') || 'attachment');
    const path = await this.app.fileManager.getAvailablePathForAttachment(name, sourcePath);
    const slash = path.lastIndexOf('/');
    await this.files.ensureFolder(slash < 0 ? '' : path.slice(0, slash));
    const buffer = await file.arrayBuffer();
    const target = await this.app.vault.createBinary(path, buffer);
    const link = this.app.fileManager.generateMarkdownLink(target, sourcePath);
    return (/^(?:image|audio|video)\//.test(file.type) || /\.pdf$/i.test(name) ? '!' : '') + link;
  }

  report(error: unknown): void {
    if (error instanceof MemoError && isMessageKey(error.code)) new Notice(this.t(error.code), 8000);
    else { console.error('[xiaoji]', error); new Notice(this.t('writeFailed'), 7000); }
  }

  async continueQuick(text: string, source: string): Promise<void> {
    const doc = this.app.workspace.containerEl.ownerDocument;
    let leaf = this.app.workspace.getLeavesOfType(VIEW_TYPE).find(leaf => leaf.view.containerEl.ownerDocument === doc && (leaf.view as MemoView).canReceiveCapture());
    if (!leaf) { leaf = this.app.workspace.getLeaf('tab'); await leaf.setViewState({ type: VIEW_TYPE, active: true }); }
    const view = leaf.view as MemoView;
    if (text.trim()) await view.receiveCapture(text, source);
    await this.app.workspace.revealLeaf(leaf);
    const native = this.nativeWindow(leaf); if (native?.isMinimized?.()) native.restore?.(); native?.show?.(); native?.focus?.();
    view.focusComposer();
  }
  ensureInitialScan(): void {
    if (!this.initialScanStarted) { this.initialScanStarted = true; void this.refresh().catch(error => this.report(error)); }
  }
  async openView(): Promise<MemoView> {
    this.ensureInitialScan();
    const existing = this.app.workspace.getLeavesOfType(VIEW_TYPE)[0];
    const leaf = existing ?? this.app.workspace.getLeaf('tab');
    if (!existing) await leaf.setViewState({ type: VIEW_TYPE, active: true });
    await this.app.workspace.revealLeaf(leaf);
    return leaf.view as MemoView;
  }

  quickWindowControls(leaf: WorkspaceLeaf): boolean {
    const native = this.nativeWindow(leaf);
    return native !== null && native !== undefined && ['minimize', 'maximize', 'unmaximize', 'isMaximized'].every(key => typeof Reflect.get(native, key) === 'function');
  }
  quickWindowMaximized(leaf: WorkspaceLeaf): boolean { try { return this.nativeWindow(leaf)?.isMaximized?.() ?? false; } catch { return false; } }
  quickWindowAction(leaf: WorkspaceLeaf, action: 'minimize' | 'maximize' | 'close'): void {
    const native = this.nativeWindow(leaf);
    if (action === 'close') {
      // Keep the popout alive and only hide it: the next open reuses this window instead of
      // paying for a fresh create + flash cycle on every capture.
      try { if (native?.hide) { native.hide(); return; } } catch { /* Fall back to detaching the leaf. */ }
      leaf.detach(); return;
    }
    try {
      if (action === 'minimize' && native?.minimize) { native.minimize(); return; }
      if (action === 'maximize' && native?.maximize && native.unmaximize) {
        if (native.isMaximized?.()) native.unmaximize(); else native.maximize(); return;
      }
    } catch { /* Keep native window chrome available if the bridge is unavailable. */ }
    new Notice(this.t('windowUnavailable'));
  }
  captureStatus(): CaptureStatus { return this.capture.status(); }
  /** 录制快捷键时临时停用全局响应，返回幂等的恢复函数。 */
  pauseGlobalCapture(): () => void { return this.capture.pause(); }
  async openQuick(): Promise<void> {
    if (Platform.isMobile) { await this.openView().then(view => view.focusComposer()); return; }
    if (this.openingQuick) return this.openingQuick;
    this.openingQuick = this.activateQuick();
    try { await this.openingQuick; } finally { this.openingQuick = null; }
  }
  private async activateQuick(): Promise<void> {
    const existing = this.app.workspace.getLeavesOfType(QUICK_TYPE)[0];
    if (existing) {
      await this.app.workspace.revealLeaf(existing);
      const native = this.nativeWindow(existing);
      if (native?.isMinimized?.()) native.restore?.();
      // Leave full screen before touching window capabilities: setFullScreenable(false)
      // while still full screen would trap the window on the full-screen Space.
      if (this.exitQuickFullScreen(native)) {
        // A quick window that was full-screened earlier must come back as a compact panel.
        this.restoreQuickBounds(native, quickBounds(this.app.loadLocalStorage('xiaoji-quick-size'), this.quickWorkAreas()));
      }
      this.configureQuickWindow(native);
      native?.show?.(); native?.focus?.();
      existing.view.containerEl.ownerDocument.defaultView?.focus();
      (existing.view as QuickView).focusEditor(); return;
    }
    const areas = this.quickWorkAreas();
    const bounds = quickBounds(this.app.loadLocalStorage('xiaoji-quick-size'), areas);
    const leaf = this.app.workspace.openPopoutLeaf({ x: bounds.x, y: bounds.y, size: { width: bounds.width, height: bounds.height } });
    // The popout is created with the host window geometry and is already visible before the
    // view finishes loading; from a full-screen Space it can even arrive full screen. Leave
    // full screen and re-apply the compact bounds right away so the first visible frame is
    // the small window instead of a full-screen flash.
    const early = this.nativeWindow(leaf);
    const earlyExited = early ? this.exitQuickFullScreen(early) : false;
    if (early?.setBounds) early.setBounds(bounds);
    else window.setTimeout(() => {
      // Right after openPopoutLeaf() the leaf can still be mounted in the host document, so
      // the native window is not addressable yet. Retry on the next task, before the popout
      // paints its first frame, instead of waiting for the full view switch below.
      const late = this.nativeWindow(leaf);
      if (!late?.setBounds) return;
      this.exitQuickFullScreen(late);
      late.setBounds(bounds);
    }, 0);
    await leaf.setViewState({ type: QUICK_TYPE, active: true });
    const native = this.nativeWindow(leaf) ?? early;
    if (native?.setBounds) {
      // A popout opened from a full-screen Space can arrive already full screen; leave it
      // before sizing and only then lock down the window capabilities.
      const exitedFullScreen = this.exitQuickFullScreen(native) || earlyExited;
      native.setBounds(bounds);
      const actual = native.getBounds?.();
      if (actual) {
        // Fractional display scaling can round a requested DIP up by one on Windows.
        // Correct only tiny rounding differences; leave OS size constraints alone.
        const corrected = { ...bounds }; let changed = false;
        for (const field of ['x', 'y', 'width', 'height'] as const) {
          const delta = actual[field] - bounds[field];
          if (delta && Math.abs(delta) <= 2) { corrected[field] -= delta; changed = true; }
        }
        if (changed) native.setBounds(corrected);
      }
      // macOS animates the native full-screen transition; re-apply the compact bounds once
      // the window is back on a regular space so the restore cannot land at screen size.
      if (exitedFullScreen) this.restoreQuickBounds(native, bounds);
    }
    this.configureQuickWindow(native);
    if (native && this.prefs.quickPin && this.windowPinState(leaf) !== true) this.toggleWindowPin(leaf);
    (leaf.view as QuickView).focusEditor();
  }
  watchQuickBounds(leaf: WorkspaceLeaf): () => void {
    const win = leaf.view.containerEl.ownerDocument.defaultView, native = this.nativeWindow(leaf);
    let timer: number | undefined;
    const save = (): void => {
      try {
        if (native?.isMinimized?.() || native?.isMaximized?.()) return;
        // Never persist a full-screen frame: only compact geometry may come back next time.
        if (native?.isFullScreen?.() || native?.isSimpleFullScreen?.()) return;
        const bounds = native?.getBounds?.() ?? (win ? { x: win.screenX, y: win.screenY, width: win.outerWidth, height: win.outerHeight } : null);
        if (bounds && Object.values(bounds).every(Number.isFinite) && bounds.width > 0 && bounds.height > 0) this.app.saveLocalStorage('xiaoji-quick-size', bounds);
      } catch { /* A closing native window may already be destroyed. */ }
    };
    const schedule = (): void => { window.clearTimeout(timer); timer = window.setTimeout(save, 150); };
    native?.on?.('move', schedule); native?.on?.('resize', schedule);
    win?.addEventListener('resize', schedule); win?.addEventListener('blur', schedule);
    return () => { window.clearTimeout(timer); save();
      try { native?.removeListener?.('move', schedule); native?.removeListener?.('resize', schedule); } catch { /* Window already closed. */ }
      win?.removeEventListener('resize', schedule); win?.removeEventListener('blur', schedule);
    };
  }

  /** Work areas of every display, used to confine and center the quick window. */
  private quickWorkAreas(): WindowBounds[] {
    let areas: WindowBounds[] = [];
    try {
      const remote = (window as Window & { require?: (id: string) => unknown }).require?.('@electron/remote') as {
        screen?: { getAllDisplays(): { workArea: WindowBounds }[]; getPrimaryDisplay(): { workArea: WindowBounds } };
      } | undefined;
      if (remote?.screen) areas = [remote.screen.getPrimaryDisplay().workArea, ...remote.screen.getAllDisplays().map(display => display.workArea)];
    } catch { /* Use the current screen if no native screen bridge is available. */ }
    if (areas.length) return areas;
    const screen = window.screen as Screen & { availLeft?: number; availTop?: number };
    return [{ x: screen.availLeft ?? 0, y: screen.availTop ?? 0, width: screen.availWidth || 1200, height: screen.availHeight || 800 }];
  }

  /**
   * Re-apply native-window chrome whenever the quick view mounts in a separate popout.
   * Obsidian restores saved popout leaves on relaunch, which would otherwise surface the
   * capture window unrequested and with native traffic lights visible. If the window was
   * not opened through openQuick(), hide it so it does not steal focus on startup; the next
   * openQuick() reuses the existing hidden leaf instead of creating a new popout.
   */
  syncQuickWindow(leaf: WorkspaceLeaf): void {
    const native = this.nativeWindow(leaf);
    if (!native) return;
    this.configureQuickWindow(native);
    if (this.openingQuick === null) {
      try { native.hide?.(); } catch { /* The native window may already be closing. */ }
    }
  }

  /** Keep the quick window a plain floating panel: no native traffic lights, no full screen, visible on every Space. */
  private configureQuickWindow(native: QuickNativeWindow | null): void {
    if (!native) return;
    try { native.setMaximizable?.(false); } catch { /* Older Electron builds may not expose this control. */ }
    try { native.setMinimizable?.(false); } catch { /* Older Electron builds may not expose this control. */ }
    try { native.setWindowButtonVisibility?.(false); } catch { /* Older Electron builds may not expose this control. */ }
    try { native.setVisibleOnAllWorkspaces?.(true, { visibleOnFullScreen: true, skipTransformProcessType: true }); } catch { /* Older Electron builds may not expose this control. */ }
    // Last: a window that is still full screen cannot leave once it stops being full-screenable.
    if (!native.isFullScreen?.() && !native.isSimpleFullScreen?.()) {
      try { native.setFullScreenable?.(false); } catch { /* Older Electron builds may not expose this control. */ }
    }
  }

  /** Re-apply compact bounds after a native full-screen transition finishes animating. */
  private restoreQuickBounds(native: QuickNativeWindow | null, bounds: WindowBounds): void {
    const apply = (): void => { try { native?.setBounds?.(bounds); } catch { /* Window already closed. */ } };
    apply();
    // The macOS full-screen exit animation runs for several hundred milliseconds and ends by
    // restoring the pre-full-screen frame, which would otherwise snap the window back to
    // screen size. Re-apply both on a timer and when the window reports the transition done.
    window.setTimeout(apply, 350);
    window.setTimeout(apply, 900);
    window.setTimeout(apply, 1600);
    try {
      const onLeave = (): void => {
        window.setTimeout(apply, 80);
        try { native?.removeListener?.('leave-full-screen', onLeave); } catch { /* Window already closed. */ }
      };
      native?.on?.('leave-full-screen', onLeave);
    } catch { /* Older Electron bridges may not expose full-screen events. */ }
  }

  /** Leave native full screen before positioning the quick window. */
  private exitQuickFullScreen(native: QuickNativeWindow | null): boolean {
    let exited = false;
    try {
      if (native?.isFullScreen?.()) {
        // A window created inside a full-screen Space can arrive already full screen. If an
        // earlier configuration pass disabled full-screenability, re-enable it so the exit works.
        if (native.isFullScreenable?.() === false) native.setFullScreenable?.(true);
        native.setFullScreen?.(false); exited = true;
      }
      if (native?.isSimpleFullScreen?.()) { native.setSimpleFullScreen?.(false); exited = true; }
    } catch { /* Older Electron bridges may not expose full-screen controls. */ }
    return exited;
  }

  private nativeWindow(leaf: WorkspaceLeaf): QuickNativeWindow | null {
    if (Platform.isMobile) return null;
    const hostDoc = this.app.workspace.containerEl?.ownerDocument ?? document;
    const doc = leaf.view.containerEl.ownerDocument;
    // A leaf whose view is still mounted in the host document has no independent native
    // window: this covers a quick view shown in the main window and the short moment right
    // after openPopoutLeaf() before the popout page takes ownership of the leaf. Treating
    // the host window as the quick window here would resize the whole Obsidian window.
    if (doc === hostDoc) return null;
    const target = doc.defaultView as (Window & { require?: (name: string) => unknown }) | null;
    try {
      const remote = target?.require?.('@electron/remote') as { getCurrentWindow?: () => QuickNativeWindow } | undefined;
      return remote?.getCurrentWindow?.() ?? null;
    } catch { return null; }
  }

  windowPinState(leaf: WorkspaceLeaf): boolean | null {
    try { return this.nativeWindow(leaf)?.isAlwaysOnTop() ?? null; } catch { return null; }
  }

  toggleWindowPin(leaf: WorkspaceLeaf): boolean | null {
    const native = this.nativeWindow(leaf);
    if (native) {
      try { const pinned = !native.isAlwaysOnTop(); native.setAlwaysOnTop(pinned); return pinned; }
      catch { /* Try the host command on platforms without a usable window bridge. */ }
    }
    const host = this.app as App & { commands?: { listCommands?(): { id: string; name: string }[]; executeCommandById?(id: string): boolean } };
    const command = host.commands?.listCommands?.().find(item => /always.?on.?top|窗口置顶/i.test(item.id + ' ' + item.name));
    if (!command || !host.commands?.executeCommandById) { new Notice(this.t('pinUnavailable'), 8000); return null; }
    leaf.view.containerEl.ownerDocument.defaultView?.focus();
    host.commands.executeCommandById(command.id);
    return this.windowPinState(leaf);
  }

  async openSource(snapshot: Memo): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(snapshot.path);
    if (!(file instanceof TFile)) throw new MemoError('conflict');
    const text = await this.app.vault.read(file);
    const candidates = parseMemos(text, file.path).filter(memo => memo.id === snapshot.id);
    // Prefer the freshly parsed offset; the cached snapshot offset may have moved.
    // With duplicate ids, pick the copy whose text matches so each one opens in place.
    const memo = candidates.length === 1 ? candidates[0] : candidates.find(candidate => candidate.raw === snapshot.raw);
    const start = memo?.start ?? text.indexOf(snapshot.raw);
    const line = start >= 0 ? text.slice(0, start).split('\n').length - 1 : 0;
    const leaf = this.app.workspace.getLeaf('tab');
    await leaf.openFile(file, { active: true, eState: { line } });
    leaf.setEphemeralState({ line });
  }

  memoLink(memo: Memo): string {
    return 'obsidian://xiaoji?' + new URLSearchParams({ vault: this.app.vault.getName(), id: memo.id }).toString();
  }
  sourceLink(memo: Memo, sourcePath = ''): string {
    const file = this.app.vault.getAbstractFileByPath(memo.path);
    return file instanceof TFile ? this.app.fileManager.generateMarkdownLink(file, sourcePath, '', this.date(memo)) : memo.path;
  }
  quote(memo: Memo, sourcePath = ''): string {
    return memo.body.split('\n').map(line => '> ' + line).join('\n') + '\n>\n> ' +
      '[' + this.date(memo) + '](' + this.memoLink(memo) + ') · ' + this.sourceLink(memo, sourcePath);
  }
  async clipboard(value: string, document: Document = window.document, notify = true): Promise<void> {
    try {
      if (!document.defaultView?.navigator.clipboard) throw new Error('Clipboard unavailable');
      await document.defaultView.navigator.clipboard.writeText(value); if (notify) new Notice(this.t('copied'));
    }
    catch {
      const area = document.win.createFragment().createEl('textarea');
      area.value = value; area.className = 'xj-clipboard-fallback';
      const active = document.activeElement as HTMLElement | null, selection = document.getSelection();
      const ranges = selection ? Array.from({ length: selection.rangeCount }, (_, index) => selection.getRangeAt(index).cloneRange()) : [];
      document.body.appendChild(area); area.select();
      try { if (!document.execCommand('copy')) throw new MemoError('permissionClipboard'); }
      finally {
        area.remove(); active?.focus?.({ preventScroll: true });
        if (selection && ranges.length) { selection.removeAllRanges(); for (const range of ranges) selection.addRange(range); }
      }
      if (notify) new Notice(this.t('copied'));
    }
  }

  rebase(body: string, from: string, to: string): string {
    if (from === to) return body;
    return rewriteLinks(body, link => {
      const split = link.target.indexOf('#');
      let path = split >= 0 ? link.target.slice(0, split) : link.target;
      const subpath = split >= 0 ? link.target.slice(split) : '';
      try { path = decodeURIComponent(path); } catch { /* keep literal path */ }
      const target = path ? this.app.metadataCache.getFirstLinkpathDest(path, from) : this.app.vault.getAbstractFileByPath(from);
      if (!(target instanceof TFile)) return null;
      return (link.embed ? '!' : '') + this.app.fileManager.generateMarkdownLink(target, to, subpath, link.label || undefined);
    });
  }

  createMemo(body: string, sourcePath: string): Promise<Memo> {
    return this.repo.create(body, (text, path) => this.rebase(text, sourcePath, path));
  }

  private async handleLink(params: Record<string, string>): Promise<void> {
    if (params.vault && params.vault !== this.app.vault.getName()) return;
    const findMemo = (): Memo | undefined => this.repo.records.find(memo => memo.id === params.id);
    let memo = findMemo();
    if (!memo) { await this.refresh(); memo = findMemo(); }
    if (!memo) throw new MemoError('conflict');
    const view = await this.openView();
    await view.revealMemo(memo);
  }

  private referencePreview?: ReferencePreview;
  bindReferences(root: HTMLElement): void {
    if (!this.referencePreview) { this.referencePreview = new ReferencePreview(this); this.register(() => this.referencePreview?.unload()); }
    this.referencePreview.bind(root);
  }
  renderReferences(root: HTMLElement): void {
    this.bindReferences(root);
    const walker = root.ownerDocument.createTreeWalker(root, 4);
    const nodes: Text[] = []; let current: Node | null;
    while ((current = walker.nextNode())) if (!(current.parentElement?.closest('a,code,pre,script,style,textarea,mjx-container,.math'))) nodes.push(current as Text);
    for (const node of nodes) {
      const text = node.data, matches = [...text.matchAll(/(?<![\p{L}\p{N}_])@(\d{17})(?!\d)/gu)];
      if (!matches.length) continue;
      const fragment = root.ownerDocument.win.createFragment(); let cursor = 0;
      for (const match of matches) {
        fragment.append(text.slice(cursor, match.index));
        const link = fragment.createEl('a'); link.className = 'xj-reference'; link.textContent = match[0]; link.href = '#';
        link.dataset.xjId = match[1]!;
        fragment.append(link); cursor = match.index + match[0].length;
      }
      fragment.append(text.slice(cursor)); node.replaceWith(fragment);
    }
  }

  apiKey(): string {
    return secretStore(this.app)?.getSecret(this.prefs.aiSecretName) || this.sessionApiKey;
  }
  setApiKey(value: string): void {
    const store = secretStore(this.app);
    if (store) store.setSecret(this.prefs.aiSecretName, value);
    else this.sessionApiKey = value;
  }

  showTrash(): void { void this.openView().then(view => view.navigate('trash')).catch(error => this.report(error)); }
  showReview(): void { if (this.prefs.reviewEnabled) new ReviewModal(this).open(); }
  showAi(): void { if (this.prefs.aiEnabled) void this.openView().then(view => view.navigate('ask')).catch(error => this.report(error)); }
  showEdit(memo?: Memo): void { void this.openView().then(view => memo ? view.editMemo(memo) : view.focusComposer()).catch(error => this.report(error)); }
  async openMemo(id: string): Promise<void> {
    let matches = this.repo.records.filter(memo => memo.id === id);
    if (!matches.length) { await this.refresh(); matches = this.repo.records.filter(memo => memo.id === id); }
    if (!matches.length) { new Notice(this.t('referenceMissing')); return; }
    if (matches.length === 1) { await (await this.openView()).revealMemo(matches[0]!); return; }
    const menu = new Menu();
    new Notice(this.t('chooseReference'));
    for (const memo of matches) menu.addItem(item => item.setTitle(memo.path + ' · ' + memo.body.slice(0, 60)).onClick(() => {
      void this.openView().then(view => view.revealMemo(memo)).catch(error => this.report(error));
    }));
    menu.showAtPosition({ x: 180, y: 140 });
  }
}
