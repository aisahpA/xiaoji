// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import XiaojiPlugin from '../src/main';
import { makeFixture } from './fixture';

afterEach(() => document.body.replaceChildren());
const setup = async () => {
  const fixture = await makeFixture({ captureKey: 'Mod-Shift-K', captureGlobal: false });
  const callbacks = new Map<string, Function>();
  const workspace = { containerEl: document.body, iterateAllLeaves: () => undefined, on: (name: string, fn: Function) => { callbacks.set(name, fn); return {}; } };
  const plugin = new XiaojiPlugin({ ...fixture.plugin.app, workspace } as any, fixture.plugin.manifest);
  plugin.data = fixture.plugin.data; plugin.persist = vi.fn(async () => undefined); plugin.openQuick = vi.fn(async () => undefined);
  (plugin as any).registerEvent = vi.fn();
  return { plugin, callbacks };
};
const key = (doc = document) => doc.dispatchEvent(new KeyboardEvent('keydown', { key: 'K', ctrlKey: true, shiftKey: true, bubbles: true, cancelable: true }));
describe('unified capture shortcut', () => {
  it('dispatches locally once, pauses during recording and removes listeners on unload', async () => {
    const { plugin } = await setup(); (plugin as any).installCaptureKeys();
    key(); expect(plugin.openQuick).toHaveBeenCalledOnce(); expect(plugin.captureStatus()).toBe('captureLocal');
    const resume = plugin.pauseGlobalCapture(); key(); expect(plugin.openQuick).toHaveBeenCalledOnce();
    resume(); resume(); key(); expect(plugin.openQuick).toHaveBeenCalledTimes(2);
    plugin.prefs.captureGlobal = true; key(); expect(plugin.openQuick).toHaveBeenCalledTimes(2);
    plugin.prefs.captureGlobal = false; plugin.unload(); key(); expect(plugin.openQuick).toHaveBeenCalledTimes(2);
  });
  it('tracks added and closed popout documents without duplicate listeners', async () => {
    const { plugin, callbacks } = await setup(); (plugin as any).installCaptureKeys();
    const frame = document.createElement('iframe'); document.body.append(frame); const win = frame.contentWindow!;
    callbacks.get('window-open')!({}, win); callbacks.get('window-open')!({}, win);
    key(win.document); expect(plugin.openQuick).toHaveBeenCalledOnce();
    callbacks.get('window-close')!({}, win); key(win.document); expect(plugin.openQuick).toHaveBeenCalledOnce(); plugin.unload();
  });
  it('keeps native bindings when importing the key cannot be persisted', async () => {
    const { plugin } = await setup(); plugin.prefs.captureKey = '';
    const manager = { customKeys: { 'xiaoji:capture': [{ key: 'K', modifiers: ['Ctrl', 'Shift'] }] }, setHotkeys: vi.fn(), removeHotkeys: vi.fn(), save: vi.fn() };
    (plugin.app as any).hotkeyManager = manager; plugin.persist = vi.fn(async () => { throw Error('disk full'); }); plugin.report = vi.fn();
    await (plugin as any).migrateQuickHotkeys(); expect(plugin.prefs.captureKey).toBe(''); expect(manager.removeHotkeys).not.toHaveBeenCalled(); expect(plugin.report).toHaveBeenCalledOnce();
  });
  it('keeps an already configured key and restores native keys if the host save fails', async () => {
    const { plugin } = await setup();
    const keys = [{ key: 'Q', modifiers: ['Alt'] }];
    const manager = { customKeys: { 'xiaoji:capture': keys }, setHotkeys: vi.fn(), removeHotkeys: vi.fn(), save: vi.fn(async () => { throw Error('disk full'); }) };
    (plugin.app as any).hotkeyManager = manager; plugin.report = vi.fn();
    await (plugin as any).migrateQuickHotkeys(); expect(plugin.prefs.captureKey).toBe('Mod-Shift-K'); expect(manager.setHotkeys).toHaveBeenCalledWith('xiaoji:capture', keys); expect(plugin.persist).not.toHaveBeenCalled();
  });
});
