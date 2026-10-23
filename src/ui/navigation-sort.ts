export interface SortItem { id: string; group: string; }
const type = 'application/x-xiaoji-navigation';
/** Reorders navigation only; never changes tag paths or accepts file drags. */
export class NavigationSort {
  private dragged: SortItem | null = null;
  private marker: HTMLElement | null = null;
  private touch: { id: number; x: number; y: number; item: SortItem; node: HTMLElement; active: boolean; timer: number; target?: SortItem; after?: boolean; frame?: number } | null = null;
  private document: Document | null = null;
  private suppress: { ids: string[]; until: number } | null = null;
  constructor(private root: HTMLElement, private move: (source: SortItem, target: SortItem, after: boolean) => Promise<void>, private step: (item: SortItem, direction: -1 | 1) => Promise<void>, private failed: (error: unknown) => void) {
    for (const name of ['dragstart', 'dragover', 'dragleave', 'drop', 'keydown', 'click'] as const) root.addEventListener(name, this.handle, true);
    root.addEventListener('pointerdown', this.pointerDown);
    this.syncDocument();
  }
  syncDocument(): void {
    if (this.document === this.root.ownerDocument) return;
    this.unbind(); this.document = this.root.ownerDocument;
    this.document.addEventListener('dragend', this.clear, true); this.document.addEventListener('drop', this.outsideDrop);
    this.document.addEventListener('pointermove', this.pointerMove, { passive: false }); this.document.addEventListener('pointerup', this.pointerUp); this.document.addEventListener('pointercancel', this.pointerCancel);
    this.document.addEventListener('touchmove', this.touchMove, { passive: false });
    this.document.addEventListener('keydown', this.escape, true); this.document.defaultView?.addEventListener('blur', this.clear);
  }
  private unbind(): void {
    this.clear(); this.document?.removeEventListener('pointermove', this.pointerMove); this.document?.removeEventListener('pointerup', this.pointerUp); this.document?.removeEventListener('pointercancel', this.pointerCancel); this.document?.removeEventListener('touchmove', this.touchMove);
    this.document?.removeEventListener('dragend', this.clear, true); this.document?.removeEventListener('drop', this.outsideDrop);
    this.document?.removeEventListener('keydown', this.escape, true); this.document?.defaultView?.removeEventListener('blur', this.clear);
  }
  private item(node: HTMLElement): SortItem { return { id: node.dataset.sortId!, group: node.dataset.sortGroup! }; }
  private focus(item: SortItem): void {
    const node = [...this.root.querySelectorAll<HTMLElement>('[data-sort-id]')].find(node => node.dataset.sortId === item.id && node.dataset.sortGroup === item.group);
    (node?.matches('button') ? node : node?.querySelector<HTMLElement>('button,input,[tabindex]'))?.focus({ preventScroll: true });
  }
  private handle = (event: Event): void => {
    const target = event.target as Element | null, node = target?.closest<HTMLElement>('[data-sort-id]');
    if (!node || !this.root.contains(node)) return;
    const item = this.item(node);
    if (event.type === 'click' && this.suppress && Date.now() < this.suppress.until && this.suppress.ids.includes(item.id)) { event.preventDefault(); event.stopPropagation(); this.suppress = null; return; }
    if (event.type === 'keydown') {
      const key = event as KeyboardEvent;
      if (!key.altKey || key.ctrlKey || key.metaKey || key.shiftKey || key.isComposing || target?.closest('input,textarea,[contenteditable="true"]')) return;
      const direction = ['ArrowUp', 'ArrowLeft'].includes(key.key) ? -1 : ['ArrowDown', 'ArrowRight'].includes(key.key) ? 1 : 0;
      if (direction) { key.preventDefault(); key.stopPropagation(); void this.step(item, direction).then(() => this.focus(item)).catch(this.failed); }
      return;
    }
    const drag = event as DragEvent;
    if (event.type === 'dragstart') {
      if (target?.closest('input,textarea,[contenteditable="true"],[data-sort-control]')) { event.preventDefault(); return; }
      this.clear(); this.dragged = item; drag.dataTransfer?.setData(type, JSON.stringify(item)); if (drag.dataTransfer) drag.dataTransfer.effectAllowed = 'move'; return;
    }
    if (event.type === 'dragleave') { if (!node.contains(drag.relatedTarget as Node | null)) this.clearMarker(); return; }
    if (!this.dragged || this.dragged.group !== item.group || this.dragged.id === item.id) { this.clearMarker(); return; }
    if (event.type !== 'drop' && event.type !== 'dragover') return;
    const rect = node.getBoundingClientRect(), horizontal = node.dataset.sortAxis === 'horizontal';
    const after = horizontal ? drag.clientX > rect.left + rect.width / 2 : drag.clientY > rect.top + rect.height / 2;
    event.preventDefault(); if (drag.dataTransfer) drag.dataTransfer.dropEffect = 'move';
    if (event.type === 'dragover') { this.clearMarker(); this.marker = node; node.classList.add(after ? 'xj-drop-after' : 'xj-drop-before'); return; }
    event.stopPropagation(); const source = this.dragged; this.clear(); this.suppress = { ids: [source.id, item.id], until: Date.now() + 250 };
    void this.move(source, item, after).then(() => this.focus(source)).catch(this.failed);
  };
  private clearMarker(): void { this.marker?.classList.remove('xj-drop-before', 'xj-drop-after'); this.marker = null; }
  private clear = (): void => {
    const touch = this.touch; this.touch = null;
    if (touch) { window.clearTimeout(touch.timer); if (touch.frame !== undefined) this.document?.defaultView?.cancelAnimationFrame(touch.frame); touch.node.classList.remove('xj-touch-sorting'); try { touch.node.releasePointerCapture(touch.id); } catch { /* Pointer may already be cancelled by the host. */ } }
    this.dragged = null; this.clearMarker();
  };
  private outsideDrop = (): void => { this.clear(); };
  private escape = (event: KeyboardEvent): void => { if (event.key === 'Escape' && (this.dragged || this.touch)) { event.stopPropagation(); this.clear(); } };
  private touchMove = (event: TouchEvent): void => { if (this.touch?.active) event.preventDefault(); };
  private pointerDown = (event: PointerEvent): void => {
    if (!['touch', 'pen'].includes(event.pointerType) || !event.isPrimary) return;
    const target = event.target as Element | null, node = target?.closest<HTMLElement>('[data-sort-id]');
    if (!node || !this.root.contains(node) || target?.closest('input,textarea,[contenteditable="true"]')) return;
    // Settings handles reserve the gesture; list rows remain scrollable until the hold completes.
    this.clear(); const item = this.item(node);
    const touch = { id: event.pointerId, x: event.clientX, y: event.clientY, node, item, active: false, timer: window.setTimeout(() => {
      if (this.touch !== touch) return;
      touch.active = true; node.classList.add('xj-touch-sorting'); try { node.setPointerCapture(event.pointerId); } catch { /* Some host surfaces do not expose capture. */ }
      this.touchFrame();
    }, 380) };
    this.touch = touch;
  };
  private pointerMove = (event: PointerEvent): void => {
    const touch = this.touch; if (!touch || event.pointerId !== touch.id) return;
    if (!touch.active) { if (Math.hypot(event.clientX - touch.x, event.clientY - touch.y) > 8) this.clear(); return; }
    event.preventDefault(); touch.x = event.clientX; touch.y = event.clientY; this.touchTarget();
  };
  private touchTarget(): void {
    const touch = this.touch; if (!touch?.active) return;
    const target = this.document?.elementFromPoint?.(touch.x, touch.y)?.closest<HTMLElement>('[data-sort-id]');
    this.clearMarker(); touch.target = undefined;
    if (!target || !this.root.contains(target)) return;
    const item = this.item(target); if (item.group !== touch.item.group || item.id === touch.item.id) return;
    const rect = target.getBoundingClientRect(), horizontal = target.dataset.sortAxis === 'horizontal';
    touch.after = horizontal ? touch.x > rect.left + rect.width / 2 : touch.y > rect.top + rect.height / 2;
    touch.target = item; this.marker = target; target.classList.add(touch.after ? 'xj-drop-after' : 'xj-drop-before');
  }
  private touchFrame = (): void => {
    const touch = this.touch, win = this.document?.defaultView; if (!touch?.active || !win) return;
    this.touchTarget();
    let scroll: HTMLElement | null = touch.node.parentElement;
    while (scroll && scroll !== this.document?.body) {
      const rect = scroll.getBoundingClientRect(), style = win.getComputedStyle(scroll);
      if (scroll.scrollHeight > scroll.clientHeight && /(auto|scroll)/.test(style.overflowY)) {
        const speed = touch.y < rect.top + 32 ? -7 : touch.y > rect.bottom - 32 ? 7 : 0;
        if (speed) scroll.scrollTop += speed;
        break;
      }
      scroll = scroll.parentElement;
    }
    touch.frame = win.requestAnimationFrame(this.touchFrame);
  };
  private pointerCancel = (event: PointerEvent): void => { if (this.touch?.id === event.pointerId) this.clear(); };
  private pointerUp = (event: PointerEvent): void => {
    const touch = this.touch; if (!touch || touch.id !== event.pointerId) return;
    if (!touch.active) { this.clear(); return; }
    event.preventDefault(); this.touchTarget(); const target = touch.target, after = touch.after;
    this.suppress = { ids: [touch.item.id, ...(target ? [target.id] : [])], until: Date.now() + 700 };
    this.clear(); if (target) void this.move(touch.item, target, after === true).then(() => this.focus(touch.item)).catch(this.failed);
  };
  destroy(): void { this.root.removeEventListener('pointerdown', this.pointerDown); this.unbind(); this.document = null; for (const name of ['dragstart', 'dragover', 'dragleave', 'drop', 'keydown', 'click'] as const) this.root.removeEventListener(name, this.handle, true); }
}
export function sortable(node: HTMLElement, item: SortItem, horizontal = false): void { node.draggable = true; node.dataset.sortId = item.id; node.dataset.sortGroup = item.group; node.dataset.sortAxis = horizontal ? 'horizontal' : 'vertical'; }
