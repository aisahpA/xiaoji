import { setIcon } from 'obsidian';

export function element<K extends keyof HTMLElementTagNameMap>(parent: HTMLElement, tag: K, className = '', text?: string): HTMLElementTagNameMap[K] {
  const node = parent.ownerDocument.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  parent.appendChild(node);
  return node;
}

export function button(parent: HTMLElement, label: string, action: (event: MouseEvent) => void | Promise<void>, icon?: string, className = ''): HTMLButtonElement {
  const node = element(parent, 'button', className);
  node.type = 'button';
  node.setAttribute('aria-label', label);
  if (icon) { setIcon(node, icon); node.title = label; node.classList.add('xj-icon-button'); }
  else node.textContent = label;
  const report = (error: unknown): void => {
    const notification = parent.ownerDocument.createEvent('CustomEvent');
    notification.initCustomEvent('xiaoji-error', true, true, error);
    if (parent.dispatchEvent(notification)) console.error('[xiaoji]', error);
  };
  node.addEventListener('click', event => {
    try { Promise.resolve(action(event)).catch(report); } catch (error) { report(error); }
  });
  return node;
}

export function bindErrors(parent: HTMLElement, report: (error: unknown) => void): void {
  parent.addEventListener('xiaoji-error', event => {
    event.preventDefault(); event.stopPropagation();
    report((event as CustomEvent<unknown>).detail);
  });
}

export function empty(parent: HTMLElement): void { parent.replaceChildren(); }

export function field(parent: HTMLElement, label: string, value: string, multiline = false): HTMLInputElement | HTMLTextAreaElement {
  const wrapper = element(parent, 'label', 'xj-field');
  element(wrapper, 'span', 'xj-field-label', label);
  const input = multiline ? element(wrapper, 'textarea') : element(wrapper, 'input');
  input.value = value;
  if (input.tagName === 'INPUT') (input as HTMLInputElement).type = 'text';
  return input;
}

export function interactiveTarget(event: Event): boolean {
  const target = event.target;
  return target !== null && typeof (target as Element).closest === 'function' &&
    Boolean((target as Element).closest('a,button,input,textarea,select,.cm-editor,pre,code,[contenteditable="true"]'));
}
