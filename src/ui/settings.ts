import { secretStore } from '../core/secret-store';
import { PluginSettingTab, Setting, Platform, type App, type TextComponent } from 'obsidian';
import type XiaojiPlugin from '../main';
import { DEFAULT_SETTINGS, densityValues, loadSettings, normalizeFolder } from '../core/settings';
import { fileForDate, headingForDate, validateStorageSettings } from '../core/dates';
import { MemoError, type Settings } from '../core/types';
import { isMessageKey, type MessageKey } from '../i18n';
import { bindErrors, button, element, empty } from './dom';
import { eventShortcut } from '../core/shortcuts';
import { normalizeGlobalShortcut } from '../core/shortcuts';
import type { CodexInfo } from '../core/codex';
import { shortcutLabel } from './submit';
import { chatEndpoint, DEFAULT_AI_PROMPT } from '../core/ai';
import { surfaceNavigation, reorderSurface, type NavSurface } from '../core/navigation';
import { NavigationSort, sortable } from './navigation-sort';
import { AutoSave } from './auto-save';
import { buildMigrationPrompt } from '../core/maintenance';
import { ReformatModal } from './maintenance';

type Section = 'storage' | 'appearance' | 'navigation' | 'enhancements' | 'general';

export class XiaojiSettings extends PluginSettingTab {
  private section: Section = 'storage';
  private navSurface: NavSurface = 'top';
  private preview: HTMLElement | null = null;
  private saves = new Set<AutoSave>();
  private sorter: NavigationSort | null = null;
  private codexInfo: CodexInfo | null = null;
  private codexInfoPath: string | null = null;
  private codexProbe: AbortController | null = null;
  private resumeCapture: (() => void) | null = null;
  constructor(app: App, private plugin: XiaojiPlugin) {
    super(app, plugin);
    bindErrors(this.containerEl, error => plugin.report(error));
  }

  display(): void { this.render(); }

  private render(): void {
    this.codexProbe?.abort(); this.codexProbe = null;
    this.resumeCapture?.(); this.resumeCapture = null;
    const p = this.plugin; this.sorter?.destroy(); this.sorter = null;
    for (const save of this.saves) void save.close(); this.saves.clear();
    empty(this.containerEl); this.containerEl.classList.add('xj-settings');
    const navigation = element(this.containerEl, 'nav', 'xj-settings-tabs');
    for (const section of ['storage', 'appearance', 'enhancements', 'general'] as const) {
      const node = button(navigation, p.t(section), async () => { await this.flush(); this.section = section; this.render(); }, undefined, 'xj-nav-button');
      node.classList.toggle('is-active', section === this.section);
    }
    const panel = element(this.containerEl, 'div', 'xj-settings-panel');
    switch (this.section) {
      case 'storage': this.storage(panel); break;
      case 'appearance': this.appearance(panel); this.navigation(panel); break;
      case 'navigation': this.navigation(panel); break;
      case 'enhancements': this.enhancements(panel); break;
      case 'general': this.general(panel); break;
    }
  }

  private redisplay(): void { const host = this.containerEl.closest<HTMLElement>('.vertical-tab-content') ?? this.containerEl; const scroll = host.scrollTop; this.render(); host.scrollTop = scroll; }
  private async flush(): Promise<void> { await Promise.all([...this.saves].map(save => save.flush())); }
  hide(): void { this.codexProbe?.abort(); this.codexProbe = null; this.resumeCapture?.(); this.resumeCapture = null; this.sorter?.destroy(); this.sorter = null; for (const save of this.saves) void save.close(); this.saves.clear(); }
  private fieldError(input: HTMLElement, error?: unknown): void {
    const row = input.closest<HTMLElement>('.setting-item');
    if (!row) return;
    let message = row.querySelector<HTMLElement>('.xj-setting-error');
    if (!message) { message = element(row.querySelector('.setting-item-info') ?? row, 'div', 'xj-setting-error'); message.setAttribute('role', 'status'); message.id = 'xj-setting-error-' + crypto.randomUUID(); }
    message.hidden = !error;
    input.setAttribute('aria-invalid', String(Boolean(error)));
    if (error) {
      message.textContent = error instanceof MemoError && isMessageKey(error.code) ? this.plugin.t(error.code) : this.plugin.t('settingsSaveFailed');
      input.setAttribute('aria-describedby', message.id);
      if (!row.isConnected) this.plugin.report(error);
    } else { message.textContent = ''; input.removeAttribute('aria-describedby'); }
  }
  private autoText(input: HTMLInputElement | HTMLTextAreaElement, commit: (value: string) => Promise<void> | void): AutoSave {
    const save = new AutoSave(error => this.fieldError(input, error), 400, input.ownerDocument.defaultView ?? window); this.saves.add(save);
    let revision = 0;
    const changed = (): void => {
      const value = input.value, current = ++revision;
      save.schedule(async () => { await commit(value); if (revision === current) this.fieldError(input); });
    };
    input.addEventListener('input', changed);
    input.addEventListener('compositionstart', () => save.composition(true));
    input.addEventListener('compositionend', () => { save.composition(false); changed(); });
    input.addEventListener('blur', () => { void save.flush(); });
    return save;
  }
  private change(update: Partial<Settings> | ((current: Settings) => Partial<Settings>), redraw = false): void {
    void (async () => {
      await this.flush(); await this.plugin.updateSettings(update); this.updatePreview();
      if (redraw) {
        const scroll = this.containerEl.scrollTop;
        const host = this.containerEl.closest<HTMLElement>('.vertical-tab-content'); const hostScroll = host?.scrollTop;
        this.render(); this.containerEl.scrollTop = scroll; if (host && hostScroll !== undefined) host.scrollTop = hostScroll;
      }
    })().catch(error => this.plugin.report(error));
  }

  private storage(panel: HTMLElement): void {
    const p = this.plugin, draft = loadSettings(p.prefs);
    let filename!: TextComponent, heading!: TextComponent;
    let headingLevel!: Setting, headingFormat!: Setting;
    let source: HTMLElement = panel;
    const save = new AutoSave(error => this.fieldError(source, error), 400, panel.ownerDocument.defaultView ?? window); this.saves.add(save);
    const sample = element(panel, 'div', 'xj-storage-preview');
    sample.title = p.t('storageHint');
    const preview = (): void => {
      try { sample.textContent = p.t('sample', { value: fileForDate(new Date(), draft) }) + (draft.grouping === 'none' ? '' : '\n' + headingForDate(new Date(), draft)); sample.classList.remove('is-error'); }
      catch { sample.textContent = p.t('invalidStoragePreview'); sample.classList.add('is-error'); }
    };
    const changed = (input: HTMLElement, immediate = false): void => {
      source = input; preview();
      const next = loadSettings(draft); next.folder = draft.folder;
      save.schedule(async () => {
        try {
          next.folder = normalizeFolder(next.folder); validateStorageSettings(next);
          await p.updateSettings({ folder: next.folder, period: next.period, fileFormats: next.fileFormats,
            grouping: next.grouping, headingLevel: next.headingLevel, headingFormats: next.headingFormats }, true);
          for (const field of panel.querySelectorAll<HTMLElement>('[aria-invalid]')) this.fieldError(field);
        } catch (error) { this.fieldError(input, error); }
      }, immediate);
    };
    const bind = (input: HTMLInputElement, update: (value: string) => void): void => {
      input.addEventListener('input', () => { update(input.value); changed(input); });
      input.addEventListener('compositionstart', () => save.composition(true));
      input.addEventListener('compositionend', () => { save.composition(false); update(input.value); changed(input); });
      input.addEventListener('blur', () => { void save.flush(); });
    };
    new Setting(panel).setName(p.t('memoFolder')).addText(text => { text.setValue(draft.folder); bind(text.inputEl, value => { draft.folder = value; }); });
    new Setting(panel).setName(p.t('period')).addDropdown(dropdown => {
      for (const key of ['month', 'quarter', 'year'] as const) dropdown.addOption(key, p.t(key));
      dropdown.setValue(draft.period).onChange(value => { draft.period = value as Settings['period']; filename.setValue(draft.fileFormats[draft.period]); changed(dropdown.selectEl, true); });
    });
    new Setting(panel).setName(p.t('fileFormat')).setDesc(p.t('formatHint')).addText(text => {
      filename = text; text.setValue(draft.fileFormats[draft.period]); bind(text.inputEl, value => { draft.fileFormats[draft.period] = value; });
    });
    new Setting(panel).setName(p.t('grouping')).addDropdown(dropdown => {
      dropdown.addOption('none', p.t('noGroup')).addOption('day', p.t('dayGroup')).addOption('week', p.t('weekGroup')).addOption('month', p.t('monthGroup'));
      dropdown.setValue(draft.grouping).onChange(value => {
        draft.grouping = value as Settings['grouping']; headingLevel.settingEl.hidden = headingFormat.settingEl.hidden = draft.grouping === 'none';
        if (draft.grouping !== 'none') heading.setValue(draft.headingFormats[draft.grouping]); changed(dropdown.selectEl, true);
      });
    });
    headingLevel = new Setting(panel).setName(p.t('headingLevel')).addDropdown(dropdown => {
      for (let level = 1; level <= 6; level++) dropdown.addOption(String(level), 'H' + level + ' · ' + '#'.repeat(level));
      dropdown.setValue(String(draft.headingLevel)).onChange(value => { draft.headingLevel = Number(value); changed(dropdown.selectEl, true); });
    });
    headingFormat = new Setting(panel).setName(p.t('headingFormat')).addText(text => {
      heading = text; text.setValue(draft.grouping === 'none' ? '' : draft.headingFormats[draft.grouping]);
      bind(text.inputEl, value => { if (draft.grouping !== 'none') draft.headingFormats[draft.grouping] = value; });
    });
    headingLevel.settingEl.hidden = headingFormat.settingEl.hidden = draft.grouping === 'none'; preview();
    const ready = async (): Promise<boolean> => {
      await this.flush(); return !panel.querySelector('[aria-invalid="true"]');
    };
    const maintenance = element(panel, 'details', 'xj-settings-advanced');
    element(maintenance, 'summary', '', p.t('maintenanceTools'));
    new Setting(maintenance).setName(p.t('migrationPrompt')).setDesc(p.t('migrationPromptHint')).addButton(control =>
      control.setButtonText(p.t('copyMigrationPrompt')).onClick(() => {
        void (async () => { if (await ready()) await p.clipboard(buildMigrationPrompt(p.prefs, p.locale), panel.ownerDocument); })().catch(error => p.report(error));
      }));
    new Setting(maintenance).setName(p.t('reformatMemos')).setDesc(p.t('reformatHint')).addButton(control =>
      control.setButtonText(p.t('previewFormat')).onClick(() => {
        void (async () => { if (await ready()) new ReformatModal(p).open(); })().catch(error => p.report(error));
      }));
  }

  private appearance(panel: HTMLElement): void {
    const p = this.plugin;
    new Setting(panel).setName(p.t('layout')).addDropdown(dropdown => {
      dropdown.addOption('waterfall', p.t('waterfall')).addOption('list', p.t('list'))
        .setValue(p.prefs.layout).onChange(value => this.change({ layout: value as Settings['layout'] }, true));
    });
    new Setting(panel).setName(p.t('dateFormat')).addText(text => {
      text.setValue(p.prefs.dateFormat); this.autoText(text.inputEl, value => p.updateSettings({ dateFormat: value || DEFAULT_SETTINGS.dateFormat }));
    });
    new Setting(panel).setName(p.t('density')).addDropdown(dropdown => {
      for (const key of ['compact', 'comfortable', 'spacious', 'custom'] as const) dropdown.addOption(key, p.t(key));
      dropdown.setValue(p.prefs.density).onChange(value => this.change({ density: value as Settings['density'] }, true));
    });
    const density = densityValues(p.prefs);
    if (p.prefs.density === 'custom') {
      this.slider(panel, 'gap', p.prefs.gap, 4, 40, value => this.change({ gap: value }));
      this.slider(panel, 'padding', p.prefs.padding, 8, 40, value => this.change({ padding: value }));
      this.slider(panel, 'cardWidth', p.prefs.layout === 'list' ? p.prefs.listWidth : p.prefs.cardWidth,
        p.prefs.layout === 'list' ? 320 : 220, p.prefs.layout === 'list' ? 1400 : 640,
        value => this.change(p.prefs.layout === 'list' ? { listWidth: value } : { cardWidth: value }));
      this.slider(panel, 'foldHeight', p.prefs.foldHeight, 100, 1000, value => this.change({ foldHeight: value }));
    }
    this.preview = element(panel, 'div', 'xj-density-preview');
    for (let i = 0; i < 3; i++) {
      const card = element(this.preview, 'div', 'xj-preview-card');
      element(card, 'small', 'xj-muted', '2026-10-21 11:07');
      element(card, 'p', '', p.locale === 'zh' ? '留住一个想法，让思考自然发生。' : 'Keep a thought. Let it grow.');
    }
    this.preview.style.gap = density.gap + 'px'; this.updatePreview();
    new Setting(panel).addButton(control => control.setButtonText(p.t('resetAppearance')).onClick(() => this.change({
      density: DEFAULT_SETTINGS.density, gap: DEFAULT_SETTINGS.gap, padding: DEFAULT_SETTINGS.padding,
      cardWidth: DEFAULT_SETTINGS.cardWidth, listWidth: DEFAULT_SETTINGS.listWidth,
      foldHeight: DEFAULT_SETTINGS.foldHeight, dateFormat: DEFAULT_SETTINGS.dateFormat,
    }, true)));
  }

  private updatePreview(): void {
    if (!this.preview?.isConnected) return;
    const value = densityValues(this.plugin.prefs);
    this.preview.style.gap = value.gap + 'px';
    for (const card of this.preview.querySelectorAll<HTMLElement>('.xj-preview-card')) card.style.padding = value.padding + 'px';
  }

  private slider(panel: HTMLElement, name: MessageKey, value: number, min: number, max: number, change: (value: number) => void): void {
    const save = new AutoSave(error => this.plugin.report(error), 180, panel.ownerDocument.defaultView ?? window);
    this.saves.add(save);
    new Setting(panel).setName(this.plugin.t(name)).addSlider(slider => {
      slider.setLimits(min, max, 1).setValue(value).setDynamicTooltip().onChange(next => {
        const variable = name === 'cardWidth' ? (this.plugin.prefs.layout === 'list' ? 'list-width' : 'card-width') : name === 'foldHeight' ? 'fold-height' : name;
        for (const root of panel.ownerDocument.querySelectorAll<HTMLElement>('.xj-root')) root.style.setProperty('--xj-' + variable, next + 'px');
        save.schedule(() => change(next));
      });
      slider.sliderEl.addEventListener('change', () => { void save.flush(); });
      slider.sliderEl.addEventListener('blur', () => { void save.flush(); });
    });
  }

  private navigation(panel: HTMLElement): void {
    const p = this.plugin;
    const tabs = element(panel, 'div', 'xj-nav-surface');
    for (const surface of ['top', 'sidebar'] as const) {
      const node = button(tabs, p.t(surface), async () => { await this.flush(); this.navSurface = surface; this.redisplay(); }, undefined, 'xj-nav-button');
      node.classList.toggle('is-active', this.navSurface === surface); node.setAttribute('aria-pressed', String(this.navSurface === surface));
    }
    element(panel, 'p', 'xj-hint', p.t('navHint'));
    const entries = surfaceNavigation(p.prefs, this.navSurface, true), surface = this.navSurface;
    const move = async (source: string, target: string, after: boolean): Promise<void> => {
      await this.flush(); await p.updateSettings(current => reorderSurface(current, surface, source, target, after)); this.redisplay();
    };
    this.sorter = new NavigationSort(panel, (source, target, after) => move(source.id, target.id, after), async (item, direction) => {
      const ids = surfaceNavigation(p.prefs, surface, true).map(item => item.id), target = ids[ids.indexOf(item.id) + direction];
      if (target) await move(item.id, target, direction === 1);
    }, error => p.report(error));
    for (const entry of entries) {
      const setting = new Setting(panel).setName(p.navLabel(entry));
      setting.settingEl.classList.add('xj-nav-setting');
      const handle = element(setting.nameEl, 'span', 'xj-drag-handle', '⠿');
      setting.nameEl.prepend(handle); handle.draggable = true;
      handle.setAttribute('aria-label', p.t('reorder'));
      sortable(setting.settingEl, { id: entry.id, group: 'views-' + surface }); setting.settingEl.draggable = false;
      if (entry.kind === 'tag') setting.setDesc('#' + entry.tag);
      setting.addToggle(toggle => toggle.setValue(surface === 'top' ? entry.favorite : entry.sidebarVisible !== false).setTooltip(p.t('showView')).onChange(value => {
        this.change(current => ({ nav: current.nav.map(item => item.id === entry.id ? { ...item, [surface === 'top' ? 'favorite' : 'sidebarVisible']: value } : item) }));
      }));
      if (entry.kind === 'tag') {
        setting.nameEl.replaceChildren(handle);
        const title = element(setting.nameEl, 'input', 'xj-nav-title'); title.value = p.navLabel(entry); title.maxLength = 80; title.setAttribute('aria-label', p.t('viewName'));
        this.autoText(title, value => p.updateSettings(current => ({ nav: current.nav.map(item => item.id === entry.id ? { ...item, title: value.trim() || '#' + entry.tag } : item) })));
        setting.addExtraButton(control => control.setIcon('x').setTooltip(p.t('removeView')).onClick(() => {
          this.change(current => ({ nav: current.nav.filter(item => item.id !== entry.id) }), true);
        }));
      }
    }

  }

  private enhancements(panel: HTMLElement): void {
    const p = this.plugin;
    new Setting(panel).setName('AI').setDesc(p.t('aiHint')).addToggle(toggle =>
      toggle.setValue(p.prefs.aiEnabled).onChange(value => this.change({ aiEnabled: value }, true)));
    if (!p.prefs.aiEnabled) return;
    new Setting(panel).setName(p.t('aiProvider')).addDropdown(control => control
      .addOption('api', p.t('apiProvider')).addOption('codex', p.t('codexProvider')).setValue(p.prefs.aiProvider)
      .onChange(value => {
        if (value === 'codex' && Platform.isMobile) { control.setValue(p.prefs.aiProvider); p.report(new MemoError('codexDesktopOnly')); return; }
        this.change({ aiProvider: value as Settings['aiProvider'] }, true);
      }));
    if (p.prefs.aiProvider === 'codex') this.codexConnection(panel);
    else this.apiConnection(panel);
    new Setting(panel).setName(p.t('saveConversations')).setDesc(p.t('saveConversationsHint')).addToggle(control => control.setValue(p.prefs.saveConversations).onChange(value => this.change({ saveConversations: value }, true)));
    if (p.prefs.saveConversations) {
      new Setting(panel).setName(p.t('chatFolder')).addText(control => {
        control.setValue(p.prefs.chatFolder);
        this.autoText(control.inputEl, value => p.updateSettings({ chatFolder: normalizeFolder(value) }));
      });
    }
    new Setting(panel).setName(p.t('memoAccess')).addDropdown(control => control.addOption('auto', p.t('memoAuto')).addOption('strict', p.t('memoStrict')).addOption('off', p.t('memoOff')).setValue(p.prefs.aiMemoMode).onChange(value => this.change({ aiMemoMode: value as Settings['aiMemoMode'] })));
    const advanced = element(panel, 'details', 'xj-settings-advanced');
    element(advanced, 'summary', '', p.t('aiAdvanced'));
    element(advanced, 'p', 'xj-hint', p.t('aiHowItWorks'));
    new Setting(advanced).setName(p.t('systemPrompt')).setDesc(p.t('systemPromptHint'))
      .addTextArea(control => { control.setValue(p.prefs.aiSystemPrompt || DEFAULT_AI_PROMPT + (p.prefs.aiInstructions ? '\n' + p.prefs.aiInstructions : '')); this.autoText(control.inputEl, value => p.updateSettings({ aiSystemPrompt: value })); control.inputEl.maxLength = 12000; control.inputEl.rows = 9; control.inputEl.classList.add('xj-system-prompt'); })
      .addExtraButton(control => control.setIcon('rotate-ccw').setTooltip(p.t('restoreDefaults')).onClick(() => { this.change({ aiSystemPrompt: '', aiInstructions: '' }, true); }));
    this.slider(advanced, 'maxEvidence', p.prefs.aiMaxMemos, 1, 40, value => this.change({ aiMaxMemos: value }));
    this.slider(advanced, 'maxCharacters', p.prefs.aiMaxCharacters, 2000, 80000, value => this.change({ aiMaxCharacters: value }));
  }

  private codexConnection(panel: HTMLElement): void {
    const p = this.plugin;
    if (Platform.isMobile) { element(panel, 'p', 'xj-hint', p.t('codexDesktopOnly')); return; }
    element(panel, 'p', 'xj-hint', p.t('codexHint'));
    if (this.codexInfoPath !== p.prefs.codexPath) { this.codexInfo = null; this.codexInfoPath = p.prefs.codexPath; }
    let modelControl: HTMLSelectElement;
    let probeStatus: HTMLElement | null = null;
    const stopProbe = (): void => { this.codexProbe?.abort(); this.codexProbe = null; if (probeStatus) probeStatus.textContent = ''; };
    const fillModels = (): void => {
      modelControl.replaceChildren();
      const defaultModel = this.codexInfo?.model;
      const models = [{ id: '', name: p.t('codexDefault') + (defaultModel ? ' · ' + defaultModel : '') }, ...(this.codexInfo?.models ?? [])];
      if (defaultModel && !models.some(model => model.id === defaultModel)) models.push({ id: defaultModel, name: defaultModel + ' · ' + p.t('codexConfiguredDefault') });
      if (p.prefs.codexModel && !models.some(model => model.id === p.prefs.codexModel)) models.push({ id: p.prefs.codexModel, name: p.prefs.codexModel });
      for (const model of models) { const option = modelControl.ownerDocument.win.createFragment().createEl('option'); option.value = model.id; option.textContent = model.name; modelControl.append(option); }
      modelControl.value = p.prefs.codexModel;
    };
    new Setting(panel).setName(p.t('model')).addDropdown(control => { modelControl = control.selectEl; fillModels(); control.onChange(value => { stopProbe(); this.change({ codexModel: value }); }); });
    const connection = new Setting(panel).setName(p.t('codexConnect')).setDesc(p.t('codexCheckHint'));
    const status = element(connection.infoEl, 'div', 'xj-connection-status'); status.setAttribute('role', 'status');
    connection.addButton(control => control.setButtonText(p.t('codexConnect')).onClick(() => {
      void (async () => {
        control.setDisabled(true); status.textContent = p.t('codexChecking'); status.classList.remove('is-error');
        try {
          stopProbe();
          await this.flush(); const info = await p.inspectCodex();
          if (!control.buttonEl.isConnected) return;
          this.codexInfo = info; fillModels(); drawDetails(); status.textContent = p.t('codexConnected');
          if (!p.prefs.codexModel && info.model && !info.models.some(model => model.id === info.model)) status.textContent += '\n' + p.t('codexDefaultMissing');
        } catch (error) {
          if (status.isConnected) { status.classList.add('is-error'); status.textContent = p.t(error instanceof MemoError && isMessageKey(error.code) ? error.code : 'codexDisconnected'); }
        } finally { control.setDisabled(false); }
      })();
    }));
    const advanced = element(panel, 'details', 'xj-settings-advanced'); element(advanced, 'summary', '', p.t('codexAdvanced'));
    const details = element(advanced, 'dl', 'xj-codex-details');
    const drawDetails = (): void => {
      empty(details); const info = this.codexInfo; if (!info) return;
      const values: [MessageKey, string | undefined][] = [
        ['codexRuntimePath', info.runtime?.path], ['codexRuntimeVersion', info.runtime?.version],
        ['codexRuntimeSource', info.runtime ? p.t(info.runtime.source === 'desktop' ? 'codexSourceDesktop' : info.runtime.source === 'configured' ? 'codexSourceConfigured' : 'codexSourcePath') : undefined],
        ['codexSignInMethod', info.signIn ? p.t(info.signIn === 'chatgpt' ? 'codexLoginChatGPT' : info.signIn === 'apiKey' ? 'apiKey' : 'codexLoginExternal') : undefined],
        ['codexProviderId', info.provider], ['codexRuntimeHome', info.runtime?.home], ['codexConfiguredDefault', info.model],
      ];
      for (const [key, value] of values) if (value) { element(details, 'dt', '', p.t(key)); element(details, 'dd', '', value); }
    };
    drawDetails();
    new Setting(advanced).setName(p.t('codexPath')).setDesc(p.t('codexPathHint')).addText(control => {
      control.setValue(p.prefs.codexPath); this.autoText(control.inputEl, async value => { stopProbe(); await p.updateSettings({ codexPath: value.trim() }); this.codexInfo = null; this.codexInfoPath = p.prefs.codexPath; fillModels(); drawDetails(); status.textContent = ''; });
    });
    new Setting(advanced).setName(p.t('codexCustomModel')).setDesc(p.t('codexCustomHint')).addText(control => {
      control.setValue(p.prefs.codexModel); this.autoText(control.inputEl, async value => { stopProbe(); await p.updateSettings({ codexModel: value.trim() }); fillModels(); });
    });
    const validation = new Setting(advanced).setName(p.t('codexValidateModel')).setDesc(p.t('codexValidateHint'));
    probeStatus = element(validation.infoEl, 'div', 'xj-connection-status'); probeStatus.setAttribute('role', 'status');
    validation.addButton(control => control.setButtonText(p.t('codexValidateModel')).onClick(() => {
      void (async () => {
        stopProbe(); let controller: AbortController | undefined, timer: number | undefined;
        control.setDisabled(true);
        try {
          await this.flush(); if (!control.buttonEl.isConnected) return;
          controller = new AbortController(); this.codexProbe = controller;
          probeStatus.textContent = p.t('codexChecking'); probeStatus.classList.remove('is-error');
          timer = window.setTimeout(() => controller?.abort(), 45000);
          await p.verifyCodexModel(controller.signal);
          if (probeStatus?.isConnected && this.codexProbe === controller) probeStatus.textContent = p.t('codexModelReady');
        }
        catch (error) { if (probeStatus?.isConnected && (!controller || this.codexProbe === controller)) { probeStatus.classList.add('is-error'); probeStatus.textContent = p.t(controller?.signal.aborted ? 'codexTimeout' : error instanceof MemoError && isMessageKey(error.code) ? error.code : 'codexRequestFailed'); } }
        finally { window.clearTimeout(timer); if (this.codexProbe === controller) this.codexProbe = null; control.setDisabled(false); }
      })();
    }));
  }

  private apiConnection(panel: HTMLElement): void {
    const p = this.plugin;
    new Setting(panel).setName(p.t('endpoint')).addText(text => { text.setValue(p.prefs.aiBaseUrl); this.autoText(text.inputEl, value => { if (value.trim()) chatEndpoint(value); return p.updateSettings({ aiBaseUrl: value }); }); });
    new Setting(panel).setName(p.t('model')).addText(text => { text.setValue(p.prefs.aiModel); this.autoText(text.inputEl, value => p.updateSettings({ aiModel: value })); });
    let password!: TextComponent, secretSave!: AutoSave;
    const key = new Setting(panel).setName(p.t('apiKey')).setDesc(p.t(secretStore(p.app) ? 'secretSaved' : 'sessionSecret'));
    key.addText(text => {
      password = text; text.inputEl.type = 'password'; text.inputEl.autocomplete = 'off'; text.setPlaceholder(p.apiKey() ? '••••••••' : '');
      secretSave = this.autoText(text.inputEl, value => { p.setApiKey(value.trim()); text.setPlaceholder(value.trim() ? '••••••••' : ''); });
    });
    key.addExtraButton(control => control.setIcon('eye').setTooltip(p.t('showSecret')).onClick(() => {
      void (async () => {
        await secretSave.flush();
        const visible = password.inputEl.type === 'password';
        if (visible && !password.getValue()) password.setValue(p.apiKey());
        password.inputEl.type = visible ? 'text' : 'password';
        control.setIcon(visible ? 'eye-off' : 'eye').setTooltip(p.t(visible ? 'hideSecret' : 'showSecret'));
      })().catch(error => p.report(error));
    }));
    key.addExtraButton(control => control.setIcon('x').setTooltip(p.t('clearSecret')).onClick(() => {
      password.setValue(''); secretSave.schedule(() => { p.setApiKey(''); password.setPlaceholder(''); this.fieldError(password.inputEl); }, true);
    }));
  }

  private shortcutSetting(panel: HTMLElement, field: 'submitKey' | 'newlineKey' | 'captureKey'): void {
    const p = this.plugin;
    const capture = field === 'captureKey';
    const setting = new Setting(panel).setName(p.t(capture ? 'quickCapture' : field));
    const status = (): void => { if (capture) setting.setDesc(p.t(Platform.isMobile ? 'quickShortcutHint' : 'captureScopeHint') + ' ' + p.t(p.captureStatus())); };
    status();
    if (capture) setting.settingEl.classList.add('xj-capture-setting');
    setting.addButton(control => {
      let recording = false;
      const label = (): void => { control.setButtonText(p.prefs[field] ? shortcutLabel(p.prefs[field], panel.ownerDocument) : p.t('captureOff')); control.buttonEl.setAttribute('aria-pressed', 'false'); };
      const resume = (): void => { this.resumeCapture?.(); this.resumeCapture = null; };
      label(); control.buttonEl.classList.add('xj-shortcut-recorder');
      control.onClick(() => { if (capture && !recording) this.resumeCapture = p.pauseGlobalCapture(); recording = true; control.setButtonText(p.t('pressShortcut')); control.buttonEl.setAttribute('aria-pressed', 'true'); control.buttonEl.focus(); });
      control.buttonEl.addEventListener('blur', () => { if (recording) { recording = false; resume(); label(); } });
      control.buttonEl.addEventListener('keydown', event => {
        if (!recording || event.isComposing || event.keyCode === 229) return;
        event.preventDefault(); event.stopPropagation();
        if (event.key === 'Escape') { recording = false; resume(); label(); return; }
        if (event.repeat || ['Control', 'Meta', 'Alt', 'Shift'].includes(event.key)) return;
        const chord = eventShortcut(event, (Platform.isMacOS || Platform.isIosApp));
        if (!chord) { p.report(new MemoError('invalidShortcut')); return; }
        if (capture && !normalizeGlobalShortcut(chord)) { p.report(new MemoError('invalidGlobalShortcut')); return; }
        if (!capture && chord === p.prefs[field === 'submitKey' ? 'newlineKey' : 'submitKey']) { p.report(new MemoError('shortcutConflict')); return; }
        recording = false; control.setDisabled(true);
        resume();
        void p.updateSettings({ [field]: chord }).catch(error => p.report(error)).finally(() => { label(); control.setDisabled(false); status(); });
      });
    });
    if (capture) {
      if (!Platform.isMobile) setting.addToggle(control => {
        control.setValue(p.prefs.captureGlobal).setTooltip(p.t('captureGlobal'));
        control.toggleEl.setAttribute('aria-label', p.t('captureGlobal'));
        const scope = element(control.toggleEl.parentElement!, 'span', 'xj-capture-scope');
        element(scope, 'span', 'xj-capture-scope-label', p.t('captureGlobal')); scope.append(control.toggleEl);
        control.onChange(value => {
          control.setDisabled(true);
          void this.flush().then(() => p.updateSettings({ captureGlobal: value })).catch(error => p.report(error)).finally(() => { control.setValue(p.prefs.captureGlobal); control.setDisabled(false); status(); });
        });
      });
      setting.addExtraButton(control => control.setIcon('x').setTooltip(p.t('clear')).onClick(() => this.change({ captureKey: '' }, true)));
    }
  }
  private general(panel: HTMLElement): void {
    const p = this.plugin;
    new Setting(panel).setName(p.t('review')).setDesc(p.t('reviewHint')).addToggle(toggle =>
      toggle.setValue(p.prefs.reviewEnabled).onChange(value => this.change({ reviewEnabled: value }, true)));
    new Setting(panel).setName(p.t('tasksCompleted')).setDesc(p.t('tasksCompletedHint')).addToggle(toggle =>
      toggle.setValue(p.prefs.tasksIncludeCompleted).onChange(value => this.change({ tasksIncludeCompleted: value })));

    new Setting(panel).setName(p.t('inputShortcuts')).setDesc(p.t('inputShortcutsHint'))
      .addExtraButton(control => control.setIcon('arrow-right-left').setTooltip(p.t('swapInputKeys')).onClick(() => this.change({ submitKey: p.prefs.newlineKey, newlineKey: p.prefs.submitKey }, true)))
      .addExtraButton(control => control.setIcon('rotate-ccw').setTooltip(p.t('restoreDefaults')).onClick(() => this.change({ submitKey: 'Shift-Enter', newlineKey: 'Enter' }, true)));
    this.shortcutSetting(panel, 'submitKey'); this.shortcutSetting(panel, 'newlineKey');
    this.shortcutSetting(panel, 'captureKey');
    new Setting(panel).setName(p.t('quickPin')).addToggle(control => control.setValue(p.prefs.quickPin).onChange(value => this.change({ quickPin: value })));
    new Setting(panel).setName(p.t('language')).addDropdown(dropdown =>
      dropdown.addOption('auto', p.t('auto')).addOption('zh', '简体中文').addOption('en', 'English')
        .setValue(p.prefs.language).onChange(value => this.change({ language: value as Settings['language'] }, true)));

  }
}
