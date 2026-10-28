import { Component, MarkdownRenderer, Modal } from 'obsidian';
import type XiaojiPlugin from '../main';
import { bindErrors, button, element, empty, field } from './dom';

export class ConfirmModal extends Modal {
  private settled = false;
  constructor(private plugin: XiaojiPlugin, private message: string, private finish: (result: boolean) => void) {
    super(plugin.app); bindErrors(this.contentEl, error => plugin.report(error));
  }
  onOpen(): void {
    this.contentEl.classList.add('xj-modal');
    element(this.contentEl, 'p', '', this.message);
    const actions = element(this.contentEl, 'div', 'xj-modal-actions');
    const cancel = button(actions, this.plugin.t('cancel'), () => this.close());
    button(actions, this.plugin.t('confirm'), () => { this.settled = true; this.finish(true); this.close(); }, undefined, 'mod-warning');
    cancel.focus();
  }
  onClose(): void { if (!this.settled) this.finish(false); empty(this.contentEl); }
}

export const confirm = (plugin: XiaojiPlugin, message: string): Promise<boolean> =>
  new Promise(resolve => new ConfirmModal(plugin, message, resolve).open());

export class TextModal extends Modal {
  constructor(
    private plugin: XiaojiPlugin,
    private title: string,
    private inputs: { label: string; value: string }[],
    private submit: (values: string[]) => void | Promise<void>,
  ) { super(plugin.app); bindErrors(this.contentEl, error => plugin.report(error)); }
  onOpen(): void {
    this.contentEl.classList.add('xj-modal');
    element(this.contentEl, 'h2', '', this.title);
    const form = element(this.contentEl, 'form');
    const controls = this.inputs.map(input => field(form, input.label, input.value));
    const actions = element(form, 'div', 'xj-modal-actions');
    button(actions, this.plugin.t('cancel'), () => this.close());
    const save = button(actions, this.plugin.t('save'), () => undefined, undefined, 'mod-cta');
    save.type = 'submit';
    // Form submission handles both Enter and clicking, without an async listener leaking a rejection.
    const actualSave = save;
    form.addEventListener('submit', event => {
      event.preventDefault();
      actualSave.disabled = true;
      void Promise.resolve(this.submit(controls.map(input => input.value.trim())))
        .then(() => this.close()).catch(error => this.plugin.report(error))
        .finally(() => { actualSave.disabled = false; });
    });
    controls[0]?.focus();
  }
  onClose(): void { empty(this.contentEl); }
}

export class ReviewModal extends Modal {
  private component: Component | null = null;
  private previous: string | null = null;
  constructor(private plugin: XiaojiPlugin) { super(plugin.app); bindErrors(this.contentEl, error => plugin.report(error)); }
  onOpen(): void { void this.render().catch(error => this.plugin.report(error)); }
  private async render(): Promise<void> {
    const p = this.plugin;
    this.component?.unload(); this.component = new Component(); this.component.load();
    empty(this.contentEl); this.contentEl.classList.add('xj-modal');
    element(this.contentEl, 'h2', '', p.t('review'));
    const all = p.repo.records.filter(memo => !memo.archived);
    const pool = all.length > 1 ? all.filter(memo => memo.id !== this.previous) : all;
    const memo = pool[Math.floor(Math.random() * pool.length)];
    if (!memo) { element(this.contentEl, 'p', 'xj-hint', p.t('noResults')); return; }
    this.previous = memo.id;
    element(this.contentEl, 'small', 'xj-muted', p.date(memo));
    const body = element(this.contentEl, 'div', 'xj-markdown markdown-rendered');
    await MarkdownRenderer.render(this.app, memo.body, body, memo.path, this.component);
    const footer = element(this.contentEl, 'div', 'xj-modal-actions');
    button(footer, p.t('openSource'), () => p.openSource(memo).catch(error => p.report(error)), 'file-text');
    button(footer, p.t('edit'), () => { this.close(); p.showEdit(memo); }, 'pencil');
    button(footer, p.t('another'), () => this.render(), undefined, 'mod-cta');
  }
  onClose(): void { this.component?.unload(); empty(this.contentEl); }
}
