import { Component, MarkdownRenderer } from 'obsidian';
import { Decoration, MatchDecorator, ViewPlugin } from '@codemirror/view';
import { syntaxTree } from '@codemirror/language';
import type XiaojiPlugin from '../main';
import { button, element } from './dom';

export function sourceReferences(plugin: XiaojiPlugin) {
  const matcher = new MatchDecorator({
    regexp: /(?<![\p{L}\p{N}_])@(\d{17}|\d{14})(?!\d)/gu,
    decoration: (match, view, from) => {
      for (let node = syntaxTree(view.state).resolveInner(from, 1); node.parent; node = node.parent) {
        if (/CodeBlock|FencedCode|InlineCode/.test(node.name)) return null;
      }
      return Decoration.mark({ class: 'xj-reference xj-source-reference', attributes: { 'data-xj-id': match[1]! } });
    },
  });
  return ViewPlugin.fromClass(class {
    decorations;
    constructor(view: import('@codemirror/view').EditorView) {
      this.decorations = matcher.createDeco(view); plugin.bindReferences(view.dom);
    }
    update(update: import('@codemirror/view').ViewUpdate): void { this.decorations = matcher.updateDeco(update, this.decorations); }
  }, { decorations: value => value.decorations });
}

/** A local, read-only preview. It never changes editor contents or steals keyboard focus. */
export class ReferencePreview extends Component {
  private roots = new WeakSet<HTMLElement>();
  private docs = new WeakSet<Document>();
  private controllers = new WeakMap<Document, AbortController>();
  private target: HTMLElement | null = null;
  private popup: HTMLElement | null = null;
  private content: Component | null = null;
  private revision = 0;
  private hold: number | undefined;
  private closeTimer: number | undefined;
  private touchStart: { x: number; y: number } | null = null;
  private suppress: HTMLElement | null = null;
  constructor(private plugin: XiaojiPlugin) { super(); this.register(() => this.close()); this.load(); }
  bind(root: HTMLElement): void {
    if (this.roots.has(root)) return; this.roots.add(root);
    const doc = root.ownerDocument;
    let controller = this.controllers.get(doc);
    if (!controller) { controller = new (doc.defaultView!.AbortController)(); this.controllers.set(doc, controller); this.register(() => controller!.abort()); }
    const options = { signal: controller.signal };
    const target = (event: Event): HTMLElement | null => {
      const node = event.target as Element | null;
      return node?.closest?.<HTMLElement>('[data-xj-id]') ?? null;
    };
    root.addEventListener('pointerover', event => {
      const link = target(event); if (!link) return;
      if (this.target !== link) this.close(); this.target = link;
      if (event.ctrlKey || event.metaKey) void this.show(link);
    }, options);
    root.addEventListener('pointerout', event => {
      const link = target(event); if (!link || link.contains(event.relatedTarget as Node | null)) return;
      this.clearHold();
      if (this.popup?.contains(event.relatedTarget as Node | null)) return;
      this.scheduleClose();
    }, options);
    root.addEventListener('pointerdown', event => {
      const link = target(event); if (!link) return;
      this.clearHold(); this.target = link; this.suppress = null; this.touchStart = { x: event.clientX, y: event.clientY };
      if (event.pointerType === 'touch') this.hold = window.setTimeout(() => {
        this.suppress = link; void this.show(link);
      }, 500);
    }, options);
    for (const name of ['pointerup', 'pointercancel']) root.addEventListener(name, () => this.clearHold(), options);
    root.addEventListener('pointermove', event => { if (this.touchStart && Math.hypot(event.clientX - this.touchStart.x, event.clientY - this.touchStart.y) > 8) this.clearHold(); }, options);
    root.addEventListener('mousedown', event => {
      if (target(event)?.classList.contains('xj-source-reference') && (event.ctrlKey || event.metaKey)) event.preventDefault();
    }, options);
    root.addEventListener('click', event => {
      const link = target(event); if (!link) return;
      if (this.suppress === link) { event.preventDefault(); event.stopPropagation(); this.suppress = null; return; }
      if (link.classList.contains('xj-source-reference') && !(event.ctrlKey || event.metaKey)) return;
      event.preventDefault(); event.stopPropagation(); this.close();
      void this.plugin.openMemo(link.dataset.xjId!).catch(error => this.plugin.report(error));
    }, options);
    root.addEventListener('contextmenu', event => { if (this.suppress === target(event)) event.preventDefault(); }, options);
    if (this.docs.has(doc)) return; this.docs.add(doc);
    this.registerDomEvent(doc, 'keydown', event => {
      if (event.key === 'Escape') this.close();
      else if ((event.key === 'Control' || event.key === 'Meta') && this.target?.isConnected) void this.show(this.target);
    });
    this.registerDomEvent(doc, 'keyup', event => { if (event.key === 'Control' || event.key === 'Meta') this.close(); });
    this.registerDomEvent(doc, 'pointerdown', event => {
      const node = event.target as Node;
      if (!this.popup?.contains(node) && !this.target?.contains(node)) this.close();
    });
    this.registerDomEvent(doc, 'scroll', event => { if (!this.popup?.contains(event.target as Node)) this.close(); }, true);
    const win = doc.defaultView;
    if (win) { this.registerDomEvent(win, 'blur', () => this.close()); this.registerDomEvent(win, 'resize', () => this.close()); }
  }
  private clearHold(): void { window.clearTimeout(this.hold); this.hold = undefined; this.touchStart = null; }
  private scheduleClose(): void { window.clearTimeout(this.closeTimer); this.closeTimer = window.setTimeout(() => this.close(), 180); }
  close(): void {
    this.revision++; this.clearHold(); window.clearTimeout(this.closeTimer);
    this.content?.unload(); this.content = null; this.popup?.remove(); this.popup = null; this.target = null;
  }
  private async show(link: HTMLElement): Promise<void> {
    window.clearTimeout(this.closeTimer);
    if (this.target === link && this.popup) return;
    this.close(); this.target = link; const revision = this.revision, p = this.plugin;
    const doc = link.ownerDocument, popup = element(doc.body, 'aside', 'xj-reference-preview');
    this.popup = popup; popup.setAttribute('role', 'region'); popup.setAttribute('aria-label', p.t('referencePreview'));
    popup.addEventListener('click', event => {
      const anchor = (event.target as Element).closest<HTMLAnchorElement>('a.internal-link');
      if (anchor) { event.preventDefault(); void p.app.workspace.openLinkText(anchor.dataset.href ?? anchor.getAttribute('href') ?? '', popup.dataset.sourcePath ?? '', false).catch(error => p.report(error)); }
    });
    popup.addEventListener('pointerenter', () => window.clearTimeout(this.closeTimer));
    popup.addEventListener('pointerleave', () => this.scheduleClose());
    const header = element(popup, 'div', 'xj-reference-preview-heading');
    element(header, 'span', 'xj-muted', '@' + link.dataset.xjId);
    button(header, p.t('close'), () => this.close(), 'x');
    const body = element(popup, 'div', 'xj-markdown markdown-rendered', p.t('loading'));
    const rect = link.getBoundingClientRect(), win = doc.defaultView!;
    popup.style.width = Math.min(420, win.innerWidth - 24) + 'px';
    popup.style.left = Math.max(12, Math.min(rect.left, win.innerWidth - popup.offsetWidth - 12)) + 'px';
    popup.style.top = Math.max(12, Math.min(rect.bottom + 8, win.innerHeight - popup.offsetHeight - 12)) + 'px';
    try {
      await p.repo.scan();
      if (revision !== this.revision || !link.isConnected) { if (revision === this.revision) this.close(); return; }
      const matches = p.repo.records.filter(memo => memo.id === link.dataset.xjId);
      if (matches.length !== 1) { body.textContent = p.t(matches.length ? 'chooseReference' : 'referenceMissing'); return; }
      const memo = matches[0]!;
      header.firstElementChild!.textContent = p.date(memo) + (memo.archived ? ' · ' + p.t('archive') : '');
      popup.dataset.sourcePath = memo.path;
      body.textContent = ''; const component = new Component(); component.load(); this.content = component;
      await MarkdownRenderer.render(p.app, memo.body, body, memo.path, component);
      if (revision !== this.revision) return;
      for (const input of body.querySelectorAll<HTMLInputElement>('input')) input.disabled = true;
      p.renderReferences(body);
      popup.style.top = Math.max(12, Math.min(rect.bottom + 8, win.innerHeight - popup.offsetHeight - 12)) + 'px';
    } catch { if (revision === this.revision) body.textContent = p.t('readFailed'); }
  }
}
