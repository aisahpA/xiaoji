import { Component, Scope, Platform, type Modifier } from 'obsidian';
import type XiaojiPlugin from '../main';
import { eventShortcut, normalizeShortcut } from '../core/shortcuts';

export function submitMatches(event: KeyboardEvent, key: string, mac: boolean): boolean {
  const chord = eventShortcut(event, mac); return chord !== null && chord === normalizeShortcut(key);
}
export function shortcutLabel(key: string, _doc: Document): string {
  return key.replace('Mod', (Platform.isMacOS || Platform.isIosApp) ? '⌘' : 'Ctrl').replace(/-/g, ' + ');
}
/** Exact, live chords shared by CodeMirror, textarea and the host's focused scope. */
export function bindSubmit(owner: Component, target: HTMLElement, plugin: XiaojiPlugin,
  submit: () => void | Promise<void>, composing: () => boolean = () => false, newline?: () => void, beforeShortcut?: (event: KeyboardEvent) => boolean): void {
  const doc = target.ownerDocument, mac = (Platform.isMacOS || Platform.isIosApp);
  let ime = false;
  owner.registerDomEvent(target, 'compositionstart', () => { ime = true; });
  owner.registerDomEvent(target, 'compositionend', () => { ime = false; });
  const insertLine = (): void => {
    if (newline) { newline(); return; }
    if (target.tagName !== 'TEXTAREA') return;
    const input = target as HTMLTextAreaElement;
    if (input.disabled || input.readOnly || input.maxLength >= 0 && input.value.length - (input.selectionEnd - input.selectionStart) + 1 > input.maxLength) return;
    if (doc.execCommand?.('insertText', false, '\n')) return;
    input.setRangeText('\n', input.selectionStart, input.selectionEnd, 'end');
    input.dispatchEvent(new (doc.defaultView!.Event)('input', { bubbles: true }));
  };
  const run = (event: KeyboardEvent): boolean => {
    if (ime || composing() || target.getAttribute('aria-disabled') === 'true') return false;
    if (beforeShortcut?.(event)) return true;
    if (submitMatches(event, plugin.prefs.submitKey, mac)) {
      if (!event.repeat) void Promise.resolve().then(submit).catch(error => plugin.report(error));
      return true;
    }
    if (submitMatches(event, plugin.prefs.newlineKey, mac)) { insertLine(); return true; }
    return false;
  };
  owner.registerDomEvent(target, 'keydown', event => {
    if (event.defaultPrevented) return;
    if (run(event)) { event.preventDefault(); event.stopPropagation(); }
  });
  if (!plugin.app.keymap) return;
  const scope = new Scope(plugin.app.scope); let active = false;
  let handlers: ReturnType<Scope['register']>[] = [];
  const sync = (): void => {
    for (const handler of handlers) scope.unregister(handler);
    handlers = [...new Set([plugin.prefs.submitKey, plugin.prefs.newlineKey])].map(chord => {
      const parts = chord.split('-'), key = parts.pop()!;
      return scope.register(parts as Modifier[], key === 'Space' ? ' ' : key, event => {
        const origin = (event.target as Node | null)?.ownerDocument ?? (event.target === doc ? doc : event.view?.document);
        if (origin === target.ownerDocument && target.ownerDocument.activeElement === target && run(event)) return false;
        return undefined;
      });
    });
  };
  sync(); owner.register(plugin.subscribe(sync));
  owner.registerDomEvent(target, 'focus', () => { if (!active) { plugin.app.keymap.pushScope(scope); active = true; } });
  owner.registerDomEvent(target, 'blur', () => { if (active) { plugin.app.keymap.popScope(scope); active = false; } ime = false; });
  owner.register(() => { if (active) plugin.app.keymap.popScope(scope); for (const handler of handlers) scope.unregister(handler); });
}
