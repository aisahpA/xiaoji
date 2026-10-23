export { default as moment } from 'moment';
import 'moment/locale/zh-cn';

// Obsidian installs these helpers in every desktop/popout document.
if (typeof window !== 'undefined') {
  Object.defineProperty(window.Document.prototype, 'win', { configurable: true, get() { return this.defaultView; } });
  Object.defineProperty(window.HTMLElement.prototype, 'setCssProps', { configurable: true, value: function(this: HTMLElement, props: Record<string, string>) { for (const [key, value] of Object.entries(props)) this.style.setProperty(key, value); } });
  Object.defineProperty(window.DocumentFragment.prototype, 'createDiv', { configurable: true, value: function(this: DocumentFragment) { return this.createEl('div'); } });
  window.createFragment = () => window.document.createDocumentFragment();
  for (const prototype of [window.HTMLElement.prototype, window.DocumentFragment.prototype]) {
    Object.defineProperty(prototype, 'createEl', { configurable: true, value: function(this: HTMLElement | DocumentFragment, tag: string) {
      const node = this.ownerDocument.createElement(tag); this.appendChild(node); return node;
    } });
  }
}
import { parseMarkdown } from '../src/core/markdown';
import type { Nodes } from 'mdast';

export class Component {
  private cleanup: (() => void)[] = [];
  load(): void {}
  unload(): void { for (const cleanup of this.cleanup.splice(0)) cleanup(); }
  register(callback: () => void): void { this.cleanup.push(callback); }
  registerDomEvent(target: EventTarget, name: string, callback: EventListener): void {
    target.addEventListener(name, callback);
    this.register(() => target.removeEventListener(name, callback));
  }
}
export class Plugin extends Component {
  app: unknown;
  manifest = { id: 'xiaoji', version: '0.1.0' };
  constructor(app: unknown) { super(); this.app = app; }
}
export class ItemView extends Component {
  app: any;
  contentEl: HTMLElement;
  containerEl: HTMLElement;
  constructor(public leaf: any) {
    super(); this.app = leaf.app;
    this.containerEl = document.createElement('div');
    this.contentEl = document.createElement('div');
    this.containerEl.append(this.contentEl);
  }
  async setState(_state: unknown, _result: unknown): Promise<void> {}
}
export class Modal {
  app: any;
  modalEl = document.createElement('div');
  contentEl = document.createElement('div');
  constructor(app: unknown) {
    this.app = app; this.modalEl.className = 'modal';
    this.contentEl.className = 'modal-content'; this.modalEl.append(this.contentEl);
  }
  onOpen(): void {}
  onClose(): void {}
  open(): void { document.body.append(this.modalEl); this.onOpen(); }
  close(): void { this.onClose(); this.modalEl.remove(); }
}
export class PluginSettingTab {
  containerEl = document.createElement('div');
  constructor(public app: unknown, public plugin: unknown) {}
}
export class TFile {
  extension = 'md';
  stat = { mtime: 1, size: 1, ctime: 1 };
  path: string;
  basename: string;
  name: string;
  parent: { path: string };
  constructor(path = '') {
    this.path = path; this.name = path.split('/').at(-1) ?? path;
    this.basename = this.name.replace(/\.md$/, ''); this.parent = { path: path.split('/').slice(0, -1).join('/') };
  }
}
export class TFolder { constructor(public path = '') {} }
export class Notice {
  static messages: string[] = [];
  constructor(message: string | DocumentFragment, _duration?: number) { Notice.messages.push(typeof message === 'string' ? message : message.textContent ?? ''); }
}
export const Platform = { isMobile: false, isDesktop: true, isMacOS: false, isIosApp: false };
export const getLanguage = (): string => 'zh';
export const getAllTags = (cache: { tags?: { tag: string }[] }): string[] => cache.tags?.map(item => item.tag) ?? [];
export function setIcon(element: HTMLElement, name: string): void {
  const svg = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 24 24'); svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor'); svg.setAttribute('stroke-width', '1.7'); svg.setAttribute('aria-hidden', 'true');
  const paths: Record<string, string> = {
    ellipsis: 'M5 12h.01M12 12h.01M19 12h.01', search: 'M21 21l-5-5M18 10a8 8 0 1 1-16 0 8 8 0 0 1 16 0',
    list: 'M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01',
    'columns-2': 'M3 3h18v18H3zM12 3v18', paperclip: 'M21 11l-9 9a6 6 0 0 1-8-8L14 2a4 4 0 0 1 6 6L9 19a2 2 0 0 1-3-3L16 6',
    hash: 'M4 9h16M3 15h16M11 3L7 21M17 3l-4 18', eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12M15 12a3 3 0 1 1-6 0 3 3 0 0 1 6 0',
    'maximize-2': 'M8 3H3v5M16 3h5v5M3 16v5h5M21 16v5h-5', 'panel-left': 'M3 3h18v18H3zM9 3v18',
    pin: 'M16 3l5 5-4 1-4 4v5l-3-3-5 5 5-5-3-3h5l4-4z',
    'notebook-pen': 'M4 3h14v18H4zM8 7h6M8 11h4', archive: 'M3 3h18v5H3zM5 8v13h14V8M10 12h4',
    shuffle: 'M3 7h3l12 10h3M17 3l4 4-4 4M3 17h3l3-3M14 9l4-2h3',
    sparkles: 'M12 3l2 6 6 3-6 2-2 7-2-7-7-2 7-3z',
  };
  const path = element.ownerDocument.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', paths[name] ?? 'M5 5h14v14H5z');
  path.setAttribute('stroke-linecap', 'round'); path.setAttribute('stroke-linejoin', 'round');
  svg.append(path); element.append(svg);
}
export class MenuItem {
  title = ''; disabled = false; checked = false; icon = '';
  callback: () => unknown = () => undefined;
  setTitle(value: string): this { this.title = value; return this; }
  setIcon(value: string): this { this.icon = value; return this; }
  setDisabled(value: boolean): this { this.disabled = value; return this; }
  setChecked(value: boolean): this { this.checked = value; return this; }
  onClick(callback: () => unknown): this { this.callback = callback; return this; }
}
export class Menu {
  static last: Menu | null = null;
  items: MenuItem[] = [];
  addItem(callback: (item: MenuItem) => unknown): this { const item = new MenuItem(); callback(item); this.items.push(item); return this; }
  addSeparator(): this { return this; }
  showAtMouseEvent(_event: MouseEvent): void {
    Menu.last = this;
    document.querySelector('.mock-menu')?.remove();
    if (!(globalThis as { XIAOJI_PREVIEW?: boolean }).XIAOJI_PREVIEW) return;
    const menu = document.createElement('div'); menu.className = 'mock-menu';
    for (const item of this.items) {
      const button = document.createElement('button'); button.textContent = item.title; button.disabled = item.disabled;
      button.addEventListener('click', () => { menu.remove(); void item.callback(); }); menu.append(button);
    }
    document.body.append(menu);
  }
}

export const MarkdownRenderer = {
  async render(_app: unknown, body: string, target: HTMLElement, _source: string, _component: Component): Promise<void> {
    const appendText = (parent: Node, text: string): void => {
      const pattern = /(!?)\[\[([^\]\n]+)\]\]|#[\p{L}\p{N}_/-]+/gu;
      let cursor = 0;
      for (const match of text.matchAll(pattern)) {
        parent.appendChild(document.createTextNode(text.slice(cursor, match.index)));
        const anchor = document.createElement('a');
        if (match[0].startsWith('#')) { anchor.className = 'tag'; anchor.textContent = match[0]; anchor.href = match[0]; }
        else {
          const parts = match[2]!.split('|'); anchor.className = 'internal-link'; anchor.dataset.href = parts[0];
          anchor.textContent = parts[1] ?? parts[0] ?? '';
        }
        parent.appendChild(anchor); cursor = match.index! + match[0].length;
      }
      parent.appendChild(document.createTextNode(text.slice(cursor)));
    };
    const render = (node: Nodes, parent: Node): void => {
      if (node.type === 'text') { appendText(parent, node.value); return; }
      if (node.type === 'html') { parent.appendChild(document.createTextNode(node.value)); return; }
      if (node.type === 'thematicBreak') { parent.appendChild(document.createElement('hr')); return; }
      if (node.type === 'break') { parent.appendChild(document.createElement('br')); return; }
      if (node.type === 'code' || node.type === 'inlineCode') {
        const code = document.createElement('code'); code.textContent = node.value;
        if (node.type === 'code') { const pre = document.createElement('pre'); pre.append(code); parent.appendChild(pre); }
        else parent.appendChild(code);
        return;
      }
      if (node.type === 'image') {
        const image = document.createElement('img'); image.alt = node.alt ?? ''; image.src = node.url; parent.appendChild(image); return;
      }
      const tag = node.type === 'paragraph' ? 'p' : node.type === 'heading' ? 'h' + node.depth :
        node.type === 'list' ? node.ordered ? 'ol' : 'ul' : node.type === 'listItem' ? 'li' :
        node.type === 'blockquote' ? 'blockquote' : node.type === 'table' ? 'table' :
        node.type === 'tableRow' ? 'tr' : node.type === 'tableCell' ? 'td' :
        node.type === 'strong' ? 'strong' : node.type === 'emphasis' ? 'em' :
        node.type === 'delete' ? 'del' : node.type === 'link' ? 'a' : null;
      const container = tag ? document.createElement(tag) : parent;
      if (tag) parent.appendChild(container);
      if (node.type === 'link') (container as HTMLAnchorElement).href = node.url;
      if (node.type === 'listItem' && typeof node.checked === 'boolean') {
        const checkbox = document.createElement('input'); checkbox.type = 'checkbox';
        checkbox.checked = node.checked; checkbox.disabled = true; checkbox.className = 'task-list-item-checkbox';
        container.appendChild(checkbox);
      }
      if ('children' in node) for (const child of node.children) render(child as Nodes, container);
    };
    render(parseMarkdown(body), target);
  },
};
export const requestUrl = async (): Promise<never> => { throw new Error('Host network bridge is not provided by the test harness'); };

class TextControl {
  inputEl: HTMLInputElement;
  constructor(parent: HTMLElement) { this.inputEl = document.createElement('input'); parent.append(this.inputEl); }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  getValue(): string { return this.inputEl.value; }
  setPlaceholder(value: string): this { this.inputEl.placeholder = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
}
class TextAreaControl {
  inputEl: HTMLTextAreaElement;
  constructor(parent: HTMLElement) { this.inputEl = document.createElement('textarea'); parent.append(this.inputEl); }
  setValue(value: string): this { this.inputEl.value = value; return this; }
  getValue(): string { return this.inputEl.value; }
  onChange(callback: (value: string) => unknown): this { this.inputEl.addEventListener('input', () => callback(this.inputEl.value)); return this; }
}
class Dropdown {
  selectEl: HTMLSelectElement;
  constructor(parent: HTMLElement) { this.selectEl = document.createElement('select'); parent.append(this.selectEl); }
  addOption(key: string, label: string): this { const option = document.createElement('option'); option.value = key; option.textContent = label; this.selectEl.append(option); return this; }
  setValue(value: string): this { this.selectEl.value = value; return this; }
  onChange(callback: (value: string) => unknown): this { this.selectEl.addEventListener('change', () => callback(this.selectEl.value)); return this; }
}
class Toggle {
  toggleEl: HTMLInputElement;
  constructor(parent: HTMLElement) { this.toggleEl = document.createElement('input'); this.toggleEl.type = 'checkbox'; parent.append(this.toggleEl); }
  setValue(value: boolean): this { this.toggleEl.checked = value; return this; }
  setTooltip(value: string): this { this.toggleEl.title = value; return this; }
  onChange(callback: (value: boolean) => unknown): this { this.toggleEl.addEventListener('change', () => callback(this.toggleEl.checked)); return this; }
}
class ButtonControl {
  buttonEl: HTMLButtonElement;
  constructor(parent: HTMLElement) { this.buttonEl = document.createElement('button'); parent.append(this.buttonEl); }
  setButtonText(value: string): this { this.buttonEl.textContent = value; return this; }
  setIcon(value: string): this { setIcon(this.buttonEl, value); return this; }
  setTooltip(value: string): this { this.buttonEl.title = value; return this; }
  setCta(): this { return this; }
  setDisabled(value: boolean): this { this.buttonEl.disabled = value; return this; }
  onClick(callback: () => unknown): this { this.buttonEl.addEventListener('click', () => callback()); return this; }
}
class Slider {
  sliderEl: HTMLInputElement;
  constructor(parent: HTMLElement) { this.sliderEl = document.createElement('input'); this.sliderEl.type = 'range'; parent.append(this.sliderEl); }
  setLimits(min: number, max: number, step: number): this { this.sliderEl.min = String(min); this.sliderEl.max = String(max); this.sliderEl.step = String(step); return this; }
  setValue(value: number): this { this.sliderEl.value = String(value); return this; }
  setDynamicTooltip(): this { return this; }
  onChange(callback: (value: number) => unknown): this { this.sliderEl.addEventListener('input', () => callback(Number(this.sliderEl.value))); return this; }
}
export class Setting {
  settingEl: HTMLElement; nameEl: HTMLElement; private description: HTMLElement; private control: HTMLElement;
  constructor(parent: HTMLElement) {
    this.settingEl = document.createElement('div'); this.settingEl.className = 'setting-item'; parent.append(this.settingEl);
    const info = document.createElement('div'); info.className = 'setting-item-info'; this.settingEl.append(info);
    this.nameEl = document.createElement('div'); this.nameEl.className = 'setting-item-name'; info.append(this.nameEl);
    this.description = document.createElement('div'); this.description.className = 'setting-item-description'; info.append(this.description);
    this.control = document.createElement('div'); this.control.className = 'setting-item-control'; this.settingEl.append(this.control);
  }
  setName(value: string): this { this.nameEl.textContent = value; return this; }
  setDesc(value: string): this { this.description.textContent = value; return this; }
  addText(callback: (control: TextControl) => unknown): this { callback(new TextControl(this.control)); return this; }
  addTextArea(callback: (control: TextAreaControl) => unknown): this { callback(new TextAreaControl(this.control)); return this; }
  addDropdown(callback: (control: Dropdown) => unknown): this { callback(new Dropdown(this.control)); return this; }
  addToggle(callback: (control: Toggle) => unknown): this { callback(new Toggle(this.control)); return this; }
  addButton(callback: (control: ButtonControl) => unknown): this { callback(new ButtonControl(this.control)); return this; }
  addExtraButton(callback: (control: ButtonControl) => unknown): this { callback(new ButtonControl(this.control)); return this; }
  addSlider(callback: (control: Slider) => unknown): this { callback(new Slider(this.control)); return this; }
}
