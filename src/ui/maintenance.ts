import { Modal, Notice } from 'obsidian';
import type XiaojiPlugin from '../main';
import { type ReformatPlan } from '../core/maintenance';
import { bindErrors, button, element, empty } from './dom';

/** Explicit maintenance action: a read-only plan precedes any file write. */
export class ReformatModal extends Modal {
  private plan: ReformatPlan | null = null;
  private closed = false;
  constructor(private plugin: XiaojiPlugin) { super(plugin.app); bindErrors(this.contentEl, error => plugin.report(error)); }
  onOpen(): void {
    this.closed = false; this.contentEl.classList.add('xj-modal', 'xj-reformat-modal');
    element(this.contentEl, 'p', 'xj-muted', this.plugin.t('loading'));
    void this.preview().catch(error => { this.plugin.report(error); this.close(); });
  }
  private async preview(): Promise<void> {
    const p = this.plugin, plan = await p.repo.planReformat();
    if (this.closed) return;
    this.plan = plan; empty(this.contentEl);
    element(this.contentEl, 'h2', '', p.t('reformatMemos'));
    element(this.contentEl, 'p', '', p.t('reformatSummary', { files: plan.files.length, skipped: plan.skipped.length, unchanged: plan.unchanged }));
    element(this.contentEl, 'p', 'xj-hint', p.t('reformatScope'));
    const list = element(this.contentEl, 'div', 'xj-reformat-files');
    for (const file of plan.files) {
      const details = element(list, 'details');
      element(details, 'summary', '', file.path + ' · ' + p.t('reformatMemoCount', { count: file.memos }));
      let rendered = false;
      details.addEventListener('toggle', () => {
        if (!details.open || rendered) return; rendered = true;
        for (const [title, text] of [[p.t('beforeFormat'), file.before], [p.t('afterFormat'), file.after]]) {
          element(details, 'small', 'xj-muted', title);
          element(element(details, 'pre'), 'code', '', text!);
        }
      });
    }
    if (plan.skipped.length) {
      const details = element(list, 'details'); element(details, 'summary', '', p.t('reformatSkipped', { count: plan.skipped.length }));
      for (const file of plan.skipped) element(details, 'p', 'xj-hint', file.path + ' · ' + p.t(file.reason === 'duplicate' ? 'reformatDuplicate' : 'reformatMixed'));
    }
    const actions = element(this.contentEl, 'div', 'xj-modal-actions');
    button(actions, p.t('cancel'), () => this.close());
    if (plan.files.length) {
      const apply = button(actions, p.t('reformatApply'), async () => {
        if (!this.plan || apply.disabled) return; apply.disabled = true;
        try {
          const result = await p.repo.applyReformat(this.plan);
          new Notice(p.t('reformatDone', { changed: result.changed, failed: result.failed.length }));
          await p.refresh().catch(error => p.report(error));
          if (this.closed) return;
          empty(this.contentEl);
          element(this.contentEl, 'p', '', p.t('reformatDone', { changed: result.changed, failed: result.failed.length }));
          if (result.backupFolder) element(this.contentEl, 'p', 'xj-hint xj-backup-path', p.t('reformatBackupAt', { path: result.backupFolder }));
          for (const path of result.failed) element(this.contentEl, 'p', 'xj-hint', path);
          button(this.contentEl, p.t('close'), () => this.close());
        } catch (error) { p.report(error); if (!this.closed) apply.disabled = false; }
      }, undefined, 'mod-cta');
    }
  }
  onClose(): void { this.closed = true; this.plan = null; empty(this.contentEl); }
}
