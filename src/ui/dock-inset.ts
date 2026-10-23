import type { Component } from 'obsidian';

interface Rect { left: number; right: number; top: number; bottom: number; height: number; width: number; }
export function bottomObstruction(panel: Rect, overlays: readonly Rect[], viewportBottom = Infinity): number {
  if (panel.width <= 0 || panel.height <= 0) return 0;
  let inset = Math.max(0, panel.bottom - viewportBottom);
  for (const overlay of overlays) {
    if (overlay.width > 0 && overlay.height > 0 && overlay.left < panel.right && overlay.right > panel.left &&
      overlay.top < panel.bottom && overlay.bottom > panel.top && overlay.top >= panel.top + panel.height / 2) {
      inset = Math.max(inset, panel.bottom - overlay.top);
    }
  }
  return Math.ceil(inset);
}

/** Reserve space only for overlays intersecting this panel, in this window. */
export function reserveDockSpace(owner: Component, root: HTMLElement): void {
  const doc = root.ownerDocument, win = doc.defaultView;
  if (!win) return;
  let stopped = false, frame = 0, last = -1;
  const bars = new Set<Element>();
  const resize = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => schedule());
  const measure = (): void => {
    frame = 0; if (stopped || !root.isConnected) return;
    const current = new Set(doc.querySelectorAll('.status-bar'));
    for (const bar of bars) if (!current.has(bar)) { resize?.unobserve(bar); bars.delete(bar); }
    for (const bar of current) if (!bars.has(bar)) { bars.add(bar); resize?.observe(bar); }
    const overlays = [...bars].filter(bar => { const style = win.getComputedStyle(bar); return style.display !== 'none' && style.visibility !== 'hidden'; }).map(bar => bar.getBoundingClientRect());
    const viewport = win.visualViewport;
    const bottom = viewport ? viewport.offsetTop + viewport.height : win.innerHeight;
    const inset = bottomObstruction(root.getBoundingClientRect(), overlays, bottom);
    if (inset !== last) { last = inset; root.style.setProperty('--xj-bottom-obstruction', inset + 'px'); }
  };
  const schedule = (): void => { if (!stopped && !frame) frame = win.requestAnimationFrame(measure); };
  resize?.observe(root);
  const mutation = new MutationObserver(schedule);
  mutation.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'hidden'] });
  owner.registerDomEvent(win, 'resize', schedule);
  owner.registerDomEvent(doc, 'visibilitychange', schedule);
  if (win.visualViewport) {
    const viewport = win.visualViewport;
    viewport.addEventListener('resize', schedule); viewport.addEventListener('scroll', schedule);
    owner.register(() => { viewport.removeEventListener('resize', schedule); viewport.removeEventListener('scroll', schedule); });
  }
  owner.register(() => { stopped = true; win.cancelAnimationFrame(frame); resize?.disconnect(); mutation.disconnect(); });
  measure();
}
