import { Component } from 'obsidian';
import { Compartment, EditorState } from '@codemirror/state';
import { EditorView, keymap, placeholder, drawSelection, tooltips } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap, insertNewlineAndIndent } from '@codemirror/commands';
import { bracketMatching, indentOnInput } from '@codemirror/language';
import { markdown, insertNewlineContinueMarkup, deleteMarkupBackward } from '@codemirror/lang-markdown';
import { autocompletion, startCompletion, completionStatus, insertCompletionText, acceptCompletion, currentCompletions, setSelectedCompletion, type CompletionContext, type CompletionResult } from '@codemirror/autocomplete';
import type XiaojiPlugin from '../main';
import { button, element } from './dom';
import { sourceReferences } from './references';
import { bindSubmit, shortcutLabel } from './submit';

export interface EditorOptions {
  value: string;
  sourcePath: string;
  onChange: (value: string) => void;
  onSubmit: () => void | Promise<void>;
  onLateAttachment?: (value: string) => void;
  placeholder?: string;
  expanded?: boolean;
  onContinue?: () => void | Promise<void>;
}

export class MemoEditor extends Component {
  readonly root: HTMLElement;
  readonly view: EditorView;
  readonly submitButton: HTMLButtonElement;
  get shortcut(): string { return this.plugin.prefs.submitKey; }
  private readonly sourceElement: HTMLElement;
  private busy = false;
  private destroyed = false;
  private attachments: Promise<void> = Promise.resolve();
  private editability = new Compartment();
  private tooltipConfig = new Compartment();
  private completionClass = 'xj-completion-' + crypto.randomUUID();
  private completionCleanup: (() => void) | null = null;

  constructor(parent: HTMLElement, private readonly plugin: XiaojiPlugin, private readonly options: EditorOptions) {
    super();
    this.root = element(parent, 'div', 'xj-composer' + (options.expanded ? ' is-expanded' : ''));
    this.sourceElement = element(this.root, 'div', 'xj-editor-source');
    this.view = new EditorView({
      parent: this.sourceElement,
      root: parent.ownerDocument,
      state: EditorState.create({
        doc: options.value,
        extensions: [
          this.tooltipConfig.of(tooltips({ parent: parent.ownerDocument.body, position: 'fixed' })),
          history(), drawSelection(), bracketMatching(), indentOnInput(),
          this.editability.of([]),
          markdown(),
          sourceReferences(plugin),
          EditorView.lineWrapping,
          placeholder(options.placeholder ?? plugin.t('capture')),
          keymap.of([
            { key: 'Enter', run: insertNewlineContinueMarkup }, { key: 'Backspace', run: deleteMarkupBackward },
            ...defaultKeymap, ...historyKeymap,
          ]),
          EditorView.updateListener.of(update => {
            if (update.docChanged) options.onChange(update.state.doc.toString());
          }),
          autocompletion({ tooltipClass: () => 'xj-completions ' + this.completionClass, override: [context => this.complete(context)] }),
          EditorView.domEventHandlers({
            paste: event => {
              const files = [...(event.clipboardData?.files ?? [])];
              if (!files.length) return false;
              event.preventDefault();
              void this.addFiles(files);
              return true;
            },
            drop: event => {
              const files = [...(event.dataTransfer?.files ?? [])];
              if (!files.length) return false;
              event.preventDefault();
              void this.addFiles(files);
              return true;
            },
            dragover: event => {
              if (event.dataTransfer?.types.includes('Files')) { event.preventDefault(); return true; }
              return false;
            },
          }),
          EditorView.contentAttributes.of({ 'aria-label': plugin.t('capture'), spellcheck: 'true', autocapitalize: 'sentences' }),
          EditorView.theme({
            '&': { fontSize: 'var(--font-text-size)', backgroundColor: 'transparent' },
            '.cm-content': { fontFamily: 'var(--font-text)', padding: '12px 0', minHeight: options.expanded ? '240px' : '58px' },
            '.cm-line': { padding: '0 14px', fontSize: 'inherit', fontWeight: 'normal', lineHeight: '1.6' },
            '.cm-scroller': { fontFamily: 'inherit' },
            '&.cm-focused': { outline: 'none' },
            '.cm-gutters': { display: 'none' },
          }),
        ],
      }),
    });
    this.bindCompletionMouse(this.root.ownerDocument);
    this.root.addEventListener('focusin', () => { const owner = this.root.ownerDocument; if (this.view.root !== owner) { this.bindCompletionMouse(owner); this.view.setRoot(owner); this.view.dispatch({ effects: this.tooltipConfig.reconfigure(tooltips({ parent: owner.body, position: 'fixed' })) }); } });
    const flush = (): void => { void plugin.flushDrafts?.().catch(error => plugin.report(error)); };
    const owner = this.root.ownerDocument, win = owner.defaultView;
    this.view.contentDOM.addEventListener('blur', flush); win?.addEventListener('blur', flush);
    const visibility = (): void => { if (owner.hidden) flush(); }; owner.addEventListener('visibilitychange', visibility);
    this.register(() => { win?.removeEventListener('blur', flush); owner.removeEventListener('visibilitychange', visibility); });
    const footer = element(this.root, 'div', 'xj-composer-actions');
    const left = element(footer, 'div', 'xj-composer-tools');
    button(left, plugin.t('attach'), () => {
      const input = this.root.ownerDocument.win.createFragment().createEl('input');
      input.type = 'file'; input.multiple = true;
      input.addEventListener('change', () => { if (input.files) void this.addFiles([...input.files]); });
      input.click();
    }, 'paperclip');
    button(left, plugin.t('addTag'), () => this.addTag(), 'hash');
    button(left, plugin.t('addTask'), () => this.addTask(), 'list-todo');
    if (options.onContinue) button(left, plugin.t('continueInMemo'), options.onContinue, 'arrow-up-right');
    else {
    const expand = button(left, plugin.t('expandEditor'), () => {
      const expanded = this.root.classList.toggle('is-expanded');
      expand.setAttribute('aria-expanded', String(expanded));
      expand.setAttribute('aria-label', plugin.t(expanded ? 'collapseEditor' : 'expandEditor'));
      expand.title = plugin.t(expanded ? 'collapseEditor' : 'expandEditor');
      this.view.requestMeasure();
    }, 'maximize-2');
    expand.setAttribute('aria-expanded', String(Boolean(options.expanded)));
    }
    this.submitButton = button(footer, plugin.t(options.expanded ? 'save' : 'record'), () => options.onSubmit(), undefined, 'mod-cta xj-submit');
    const syncHint = (): void => { this.submitButton.title = plugin.t(options.expanded ? 'save' : 'record') + ' · ' + shortcutLabel(plugin.prefs.submitKey, parent.ownerDocument) + '\n' + plugin.t('newlineKey') + ' · ' + shortcutLabel(plugin.prefs.newlineKey, parent.ownerDocument); };
    syncHint(); this.register(plugin.subscribe(syncHint));
    bindSubmit(this, this.view.contentDOM, plugin, () => { if (!this.busy) return options.onSubmit(); }, () => this.view.composing, () => {
      if (!this.busy && !insertNewlineContinueMarkup(this.view)) insertNewlineAndIndent(this.view);
    }, event => {
      if (this.busy || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey || !['Enter', 'Tab'].includes(event.key) || completionStatus(this.view.state) !== 'active') return false;
      acceptCompletion(this.view); return true;
    });
    this.register(() => {
      this.completionCleanup?.(); this.completionCleanup = null;
      this.destroyed = true;
      this.view.destroy();
      this.root.remove();
    });
    this.load();
  }

  private bindCompletionMouse(doc: Document): void {
    this.completionCleanup?.();
    const option = (event: Event): number => {
      const target = event.target as Element | null, row = target?.closest('li');
      if (!row?.isConnected || !row.closest('.' + this.completionClass)) return -1;
      const match = /-(\d+)$/.exec(row.id); return match ? Number(match[1]) : -1;
    };
    const down = (event: PointerEvent): void => {
      if (event.pointerType === 'touch' || event.button !== 0) return;
      const index = option(event); if (index < 0 || index >= currentCompletions(this.view.state).length) return;
      event.preventDefault(); event.stopPropagation(); this.view.dispatch({ effects: setSelectedCompletion(index) }); acceptCompletion(this.view); this.view.focus();
    };
    const hover = (event: PointerEvent): void => { if (event.pointerType === 'touch') return; const index = option(event); if (index >= 0 && index < currentCompletions(this.view.state).length) this.view.dispatch({ effects: setSelectedCompletion(index) }); };
    doc.addEventListener('pointerdown', down, true); doc.addEventListener('pointermove', hover, true);
    this.completionCleanup = () => { doc.removeEventListener('pointerdown', down, true); doc.removeEventListener('pointermove', hover, true); };
  }
  private complete(context: CompletionContext): CompletionResult | null {
    const tag = context.matchBefore(/#[\p{L}\p{N}_/-]*/u);
    if (tag) return {
      from: tag.from,
      options: this.plugin.tags().map(value => ({
        label: '#' + value, type: 'keyword',
        apply: (view: EditorView, completion: { label: string }, from: number, to: number) => {
          const existingSpace = view.state.doc.sliceString(to, to + 1) === ' ';
          view.dispatch(insertCompletionText(view.state, completion.label + ' ', from, to + (existingSpace ? 1 : 0)));
        },
      })),
      validFor: /^#[\p{L}\p{N}_/-]*$/u,
    };
    const wiki = context.matchBefore(/\[\[[^\]\n]*/);
    if (wiki) return {
      from: wiki.from,
      options: this.plugin.app.vault.getMarkdownFiles().map(file => ({
        label: '[[' + file.basename, displayLabel: file.basename, detail: file.parent?.path,
        apply: this.plugin.app.fileManager.generateMarkdownLink(file, this.options.sourcePath),
        type: 'text',
      })),
      validFor: /^\[\[[^\]\n]*$/,
    };
    return null;
  }

  getValue(): string { return this.view.state.doc.toString(); }
  setSourcePath(path: string): void { this.options.sourcePath = path; }
  setValue(value: string): void {
    if (value === this.getValue()) return;
    this.view.dispatch({ changes: { from: 0, to: this.view.state.doc.length, insert: value } });
  }
  insert(value: string): void {
    if (this.busy) return;
    this.view.dispatch(this.view.state.replaceSelection(value));
    this.focus();
  }
  focus(): void { this.view.focus(); }
  moveCursor(position: number): void { this.view.dispatch({ selection: { anchor: Math.max(0, Math.min(position, this.view.state.doc.length)) } }); }
  appendLine(text: string): void {
    if (this.busy) return;
    const value = this.getValue(), suffix = value && !value.endsWith('\n') ? '\n' : '';
    this.view.dispatch({ changes: { from: value.length, insert: suffix + text }, selection: { anchor: value.length + suffix.length + text.length } });
    this.focus();
  }
  private addTag(): void {
    if (this.busy) return;
    const selection = this.view.state.selection.main;
    const before = this.view.state.doc.sliceString(this.view.state.doc.lineAt(selection.head).from, selection.head);
    if (!selection.empty || !/(?:^|\s)#[\p{L}\p{N}_/-]*$/u.test(before)) {
      this.insert((before && !/\s$/.test(before) ? ' ' : '') + '#');
    }
    this.focus();
    startCompletion(this.view);
  }
  private addTask(): void {
    if (this.busy) return;
    const selection = this.view.state.selection.main, line = this.view.state.doc.lineAt(selection.head);
    if (/^\s*[-*+] \[[ xX]\] /.test(line.text)) { this.moveCursor(line.to); this.focus(); return; }
    const start = line.from;
    this.view.dispatch({ changes: { from: start, insert: '- [ ] ' }, selection: { anchor: selection.head + 6 } });
    this.focus();
  }
  setBusy(busy: boolean): void {
    this.busy = busy;
    this.submitButton.disabled = busy;
    this.root.classList.toggle('is-busy', busy);
    this.view.dispatch({ effects: this.editability.reconfigure(busy ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []) });
  }

  waitForAttachments(): Promise<void> { return this.attachments; }
  private addFiles(files: File[]): Promise<void> {
    if (this.busy) return Promise.resolve();
    this.attachments = this.attachments.then(async () => {
      for (const file of files) {
        try {
          const link = await this.plugin.addAttachment(file, this.options.sourcePath);
          if (this.destroyed) { this.options.onLateAttachment?.(this.getSafeValue() + '\n' + link); continue; }
          // An attachment already in progress must finish before the submitted body is read.
          this.view.dispatch(this.view.state.replaceSelection('\n' + link + '\n'));
          if (!this.busy) this.focus();
        } catch (error) { this.plugin.report(error); }
      }
    });
    return this.attachments;
  }

  private getSafeValue(): string { return this.view.state.doc.toString(); }

}
