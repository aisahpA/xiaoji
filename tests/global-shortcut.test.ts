// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GlobalCaptureShortcut, desktopShortcuts, globalAccelerator, type ShortcutPort } from '../src/core/capture-shortcut';
import { loadSettings } from '../src/core/settings';

afterEach(() => { delete (window as Window & { require?: unknown }).require; });

const setup = () => {
  const keys = new Map<string, () => void>();
  const port: ShortcutPort = {
    register: vi.fn((key, action) => { if (keys.has(key)) return false; keys.set(key, action); return true; }),
    unregister: vi.fn(key => { keys.delete(key); }),
  };
  const capture = vi.fn(); const owner = new GlobalCaptureShortcut(() => port, capture);
  return { keys, port, capture, owner };
};

describe('global capture shortcuts', () => {
  it('loads defaults and validates the configured chord without migrating old settings', () => {
    expect(loadSettings({})).toMatchObject({ captureKey: '', captureGlobal: true });
    expect(loadSettings({ captureKey: 'Alt-N', captureGlobal: false })).toMatchObject({ captureKey: 'Alt-N', captureGlobal: false });
    expect(loadSettings({ captureKey: 'Enter' }).captureKey).toBe('');
    expect(loadSettings({ captureKey: 42 }).captureKey).toBe('');
    // 旧版 quickHotkey 与上游 globalCaptureKey 都不再迁移，升级后需要重新录制。
    expect(loadSettings({ quickHotkey: 'CommandOrControl+Alt+K' }).captureKey).toBe('');
    expect(loadSettings({ globalCaptureKey: 'Ctrl-Shift-K' }).captureKey).toBe('');
  });
  it('normalizes chords into Electron accelerators and rejects chords without Ctrl/Cmd or Alt', () => {
    expect(globalAccelerator('Mod-Alt-N')).toBe('CommandOrControl+Alt+N');
    expect(globalAccelerator('Mod-ArrowUp')).toBe('CommandOrControl+Up');
    expect(() => globalAccelerator('Enter')).toThrow('invalidGlobalShortcut');
  });
  it('fires the capture action and releases only its own key', () => {
    const { keys, port, capture, owner } = setup(); keys.set('Alt+X', vi.fn());
    owner.bind('Mod-Alt-N'); keys.get('CommandOrControl+Alt+N')!();
    expect(capture).toHaveBeenCalledOnce(); expect(owner.status('Mod-Alt-N')).toBe('captureReady');
    owner.dispose(); owner.dispose(); expect(port.unregister).toHaveBeenCalledTimes(1);
    expect(keys.has('Alt+X')).toBe(true);
  });
  it('keeps the old binding when another app or vault owns the replacement', () => {
    const { keys, owner, port } = setup(); owner.bind('Mod-Alt-N'); keys.set('Alt+K', vi.fn());
    expect(() => owner.bind('Alt-K')).toThrow('captureConflict');
    expect(keys.has('CommandOrControl+Alt+N')).toBe(true); expect(port.unregister).not.toHaveBeenCalled();
    expect(owner.status('Mod-Alt-N')).toBe('captureReady');
  });
  it('releases the originally acquired bridge even if a later capability probe fails', () => {
    const { port } = setup(); let available = true;
    const owner = new GlobalCaptureShortcut(() => available ? port : null, vi.fn());
    owner.bind('Alt-N'); available = false; owner.dispose(); expect(port.unregister).toHaveBeenCalledWith('Alt+N');
  });
  it('reports an unavailable host without losing the configured choice', () => {
    const owner = new GlobalCaptureShortcut(() => null, vi.fn());
    expect(() => owner.bind('Mod-Alt-N')).toThrow('captureUnavailable');
    expect(owner.status('Mod-Alt-N')).toBe('captureUnavailable');
  });
  it('reclaims a stale binding left by a previous renderer before registering again', () => {
    const registered = new Map<string, () => void>();
    const bridge = {
      register: vi.fn((key: string, callback: () => void) => { if (registered.has(key)) return false; registered.set(key, callback); return true; }),
      unregister: vi.fn((key: string) => { registered.delete(key); }),
    };
    (window as Window & { require?: (id: string) => unknown }).require = () => ({ globalShortcut: bridge });
    const port = desktopShortcuts()!;
    registered.set('CommandOrControl+Shift+J', vi.fn());
    expect(port.register('CommandOrControl+Shift+J', vi.fn())).toBe(true);
    expect(bridge.unregister).toHaveBeenCalledWith('CommandOrControl+Shift+J');
    expect(registered.has('CommandOrControl+Shift+J')).toBe(true);
  });
});
