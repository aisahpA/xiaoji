import { describe, expect, it, vi } from 'vitest';
import { GlobalCaptureShortcut, globalAccelerator, type ShortcutPort } from '../src/core/global-shortcut';
import { loadSettings } from '../src/core/settings';

const setup = () => {
  const keys = new Map<string, () => void>();
  const port: ShortcutPort = { register: vi.fn((key, action) => { if (keys.has(key)) return false; keys.set(key, action); return true; }), unregister: vi.fn(key => { keys.delete(key); }) };
  const capture = vi.fn(); const owner = new GlobalCaptureShortcut(() => port, capture);
  return { keys, port, capture, owner };
};
describe('owned desktop shortcuts', () => {
  it('migrates the legacy key, defaults to global scope and preserves an explicit local preference', () => {
    expect(loadSettings({ globalCaptureKey: 'Ctrl-Shift-K' })).toMatchObject({ captureKey: 'Mod-Shift-K', captureGlobal: true });
    expect(loadSettings({ captureKey: 'Alt-N', captureGlobal: false, globalCaptureKey: 'Ctrl-Shift-K' })).toMatchObject({ captureKey: 'Alt-N', captureGlobal: false });
    expect(loadSettings({ captureKey: '', globalCaptureKey: 'Ctrl-Shift-K' }).captureKey).toBe('');
  });
  it('normalizes accelerators and never accepts an unmodified global key', () => {
    expect(globalAccelerator('Mod-Alt-N')).toBe('CommandOrControl+Alt+N');
    expect(globalAccelerator('Mod-ArrowUp')).toBe('CommandOrControl+Up');
    expect(() => globalAccelerator('Enter')).toThrow('invalidGlobalShortcut');
    expect(loadSettings({ globalCaptureKey: 'Enter' }).captureKey).toBe('');
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
});
