const modifiers = ['Mod', 'Alt', 'Shift'] as const;
const keys = /^(Enter|Tab|Backspace|Delete|Space|ArrowUp|ArrowDown|ArrowLeft|ArrowRight|F(?:[1-9]|1[0-2])|[A-Z0-9])$/;
export function normalizeShortcut(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const parts = value.split('-'), key = parts.pop();
  if (!key || !keys.test(key) || parts.some(part => !['Mod', 'Ctrl', 'Meta', 'Alt', 'Shift'].includes(part))) return null;
  const normalized = parts.map(part => part === 'Ctrl' || part === 'Meta' ? 'Mod' : part);
  if (new Set(normalized).size !== normalized.length || key !== 'Enter' && !normalized.includes('Mod') && !normalized.includes('Alt')) return null;
  return [...modifiers.filter(mod => normalized.includes(mod)), key].join('-');
}
export function eventShortcut(event: KeyboardEvent, mac: boolean): string | null {
  if (event.isComposing || event.keyCode === 229 || event.ctrlKey && event.metaKey) return null;
  const key = event.key === ' ' ? 'Space' : event.key.length === 1 ? event.key.toUpperCase() : event.key;
  // Do not silently translate the other platform's physical modifier.
  if (mac ? event.ctrlKey : event.metaKey) return null;
  return normalizeShortcut([(mac ? event.metaKey : event.ctrlKey) ? 'Mod' : '', event.altKey ? 'Alt' : '', event.shiftKey ? 'Shift' : '', key].filter(Boolean).join('-'));
}
export function normalizeGlobalShortcut(value: unknown): string | null {
  const chord = normalizeShortcut(value);
  return chord && /^(?:Mod|Alt)(?:-|$)/.test(chord) ? chord : null;
}
export function normalizeInputKeys(submit: unknown, newline: unknown): { submitKey: string; newlineKey: string } {
  const submitKey = normalizeShortcut(submit) ?? 'Shift-Enter';
  let newlineKey = normalizeShortcut(newline) ?? (submitKey === 'Enter' ? 'Shift-Enter' : 'Enter');
  if (newlineKey === submitKey) newlineKey = submitKey === 'Enter' ? 'Shift-Enter' : 'Enter';
  return { submitKey, newlineKey };
}
