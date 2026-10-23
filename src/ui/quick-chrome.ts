/** Compact only a dedicated quick-capture document. Restore chrome if another view joins it. */
export function compactQuickWindow(doc: Document, nativeControls: boolean): () => void {
  const update = (): void => {
    const views = [...doc.querySelectorAll<HTMLElement>('.workspace-leaf-content[data-type]')];
    const dedicated = views.length === 1 && views[0]?.dataset.type === 'xiaoji-quick-capture';
    doc.body.classList.toggle('xj-quick-window', dedicated);
    doc.body.classList.toggle('xj-quick-native-controls', dedicated && nativeControls);
  };
  update();
  const Observer = doc.defaultView?.MutationObserver ?? MutationObserver;
  const observer = new Observer(update);
  observer.observe(doc.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-type'] });
  return () => { observer.disconnect(); doc.body.classList.remove('xj-quick-window', 'xj-quick-native-controls'); };
}
