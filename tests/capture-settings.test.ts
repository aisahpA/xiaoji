// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureShortcut, type CaptureHost, type ShortcutPort } from '../src/core/capture-shortcut';

afterEach(() => document.body.replaceChildren());

const setup = (overrides: Partial<{ captureKey: string; captureGlobal: boolean }> = {}) => {
  const keys = new Map<string, () => void>();
  const port: ShortcutPort = {
    register: vi.fn((key, action) => { if (keys.has(key)) return false; keys.set(key, action); return true; }),
    unregister: vi.fn(key => { keys.delete(key); }),
  };
  const settings = { captureKey: 'Mod-Shift-K', captureGlobal: false, ...overrides };
  const capture = vi.fn(); const reported: unknown[] = [];
  const open: Array<(win: Window) => void> = [], close: Array<(win: Window) => void> = [], kept: Array<() => void> = [];
  const host: CaptureHost = {
    desktop: true, mac: false, settings: () => settings, port: () => port, capture,
    report: error => { reported.push(error); },
    documents: () => [document],
    onWindowOpen: callback => { open.push(callback); },
    onWindowClose: callback => { close.push(callback); },
    keep: dispose => { kept.push(dispose); },
  };
  return { keys, settings, capture, reported, open, close, kept, shortcut: new CaptureShortcut(host) };
};
const key = (doc: Document = document) => doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));

describe('capture shortcut controller', () => {
  it('dispatches locally once, pauses during recording and cleans up on unload', () => {
    const { shortcut, settings, capture, kept } = setup(); shortcut.install();
    key(); expect(capture).toHaveBeenCalledOnce(); expect(shortcut.status()).toBe('captureLocal');
    const resume = shortcut.pause(); key(); expect(capture).toHaveBeenCalledOnce();
    resume(); resume(); key(); expect(capture).toHaveBeenCalledTimes(2);
    settings.captureGlobal = true; key(); expect(capture).toHaveBeenCalledTimes(2);
    for (const dispose of kept) dispose(); key(); expect(capture).toHaveBeenCalledTimes(2);
    shortcut.dispose(); expect(() => shortcut.dispose()).not.toThrow();
  });
  it('tracks added and closed popout documents without duplicate listeners', () => {
    const { shortcut, capture, open, close } = setup(); shortcut.install();
    const frame = document.createElement('iframe'); document.body.append(frame); const win = frame.contentWindow!;
    open[0]!(win); open[0]!(win);
    key(win.document); expect(capture).toHaveBeenCalledOnce();
    close[0]!(win); key(win.document); expect(capture).toHaveBeenCalledOnce(); shortcut.dispose();
  });
  it('reserves the replacement key before releasing the old one and can roll back', () => {
    const { shortcut, settings, keys } = setup({ captureGlobal: true }); shortcut.initial();
    expect(keys.has('CommandOrControl+Shift+K')).toBe(true);
    shortcut.apply({ captureKey: 'Alt-N', captureGlobal: true });
    expect(keys.has('Alt+N')).toBe(true); expect(keys.has('CommandOrControl+Shift+K')).toBe(false);
    shortcut.rollback(settings);
    expect(keys.has('CommandOrControl+Shift+K')).toBe(true); expect(keys.has('Alt+N')).toBe(false);
  });
  it('keeps the old binding and reports the conflict status when the replacement is taken', () => {
    const { shortcut, settings, keys, reported } = setup({ captureGlobal: true }); shortcut.initial();
    keys.set('Alt+N', vi.fn()); // 模拟已被其他应用或笔记库占用
    expect(() => shortcut.apply({ captureKey: 'Alt-N', captureGlobal: true })).toThrow('captureConflict');
    expect(keys.has('CommandOrControl+Shift+K')).toBe(true);
    settings.captureKey = 'Alt-N'; expect(shortcut.status()).toBe('captureConflict');
    settings.captureGlobal = false; shortcut.rollback(settings);
    expect(keys.has('CommandOrControl+Shift+K')).toBe(false); expect(reported).toEqual([]);
  });
  it('requires rebinding only when the chord or the global scope changes', () => {
    const { shortcut } = setup();
    expect(shortcut.changed({ captureKey: 'Alt-N', captureGlobal: false }, { captureKey: 'Alt-N', captureGlobal: false })).toBe(false);
    expect(shortcut.changed({ captureKey: 'Alt-M', captureGlobal: false }, { captureKey: 'Alt-N', captureGlobal: false })).toBe(true);
    expect(shortcut.changed({ captureKey: 'Alt-N', captureGlobal: true }, { captureKey: 'Alt-N', captureGlobal: false })).toBe(true);
  });
});
