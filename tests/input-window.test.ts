import { describe, expect, it } from 'vitest';
import { normalizeInputKeys, normalizeShortcut } from '../src/core/shortcuts';
import { quickBounds } from '../src/core/quick-window';
import { bottomObstruction } from '../src/ui/dock-inset';
import { loadSettings } from '../src/core/settings';

describe('input shortcut validation', () => {
  it.each(['Enter', 'Shift-Enter', 'Mod-Enter', 'Alt-Enter', 'Mod-Shift-K', 'Mod-Alt-Enter'])('accepts %s', chord => expect(normalizeShortcut(chord)).toBe(chord));
  it.each(['A', 'Shift-A', 'Control-Enter', 'Mod-Mod-K', 'Ctrl-Meta-K', 'Escape', 'Mod-', 'Mod-Unknown'])('rejects unsafe or ambiguous %s', chord => expect(normalizeShortcut(chord)).toBeNull());
  it('normalizes platform modifiers and supplies a distinct newline for existing Enter-submit settings', () => {
    expect(normalizeShortcut('Shift-Ctrl-K')).toBe('Mod-Shift-K');
    expect(normalizeInputKeys('Enter', undefined)).toEqual({ submitKey: 'Enter', newlineKey: 'Shift-Enter' });
    expect(loadSettings({ submitKey: 'Mod-K', newlineKey: 'Mod-K' })).toMatchObject({ submitKey: 'Mod-K', newlineKey: 'Enter' });
    expect(loadSettings({ submitKey: 'Shift-Enter' }).newlineKey).toBe('Enter');
  });
});
const rect = (left: number, top: number, width: number, height: number) => ({ left, top, width, height, right: left + width, bottom: top + height });
describe('per-panel bottom obstruction', () => {
  const panel = rect(0, 40, 1000, 760);
  it('reserves the actual floating status-bar height', () => expect(bottomObstruction(panel, [rect(700, 775, 300, 25)])).toBe(25));
  it('does not add a gap for a status bar in normal flow below the panel', () => expect(bottomObstruction(panel, [rect(700, 800, 300, 25)])).toBe(0));
  it('does not reserve space in a different side-by-side pane', () => expect(bottomObstruction(rect(0, 40, 450, 760), [rect(700, 775, 300, 25)])).toBe(0));
  it('handles hidden or empty panels and overlays', () => {
    expect(bottomObstruction(rect(0, 0, 0, 0), [rect(0, 0, 50, 25)])).toBe(0);
    expect(bottomObstruction(panel, [rect(700, 775, 0, 25)])).toBe(0);
  });
  it('uses the visual viewport edge when a keyboard overlaps the layout', () => expect(bottomObstruction(panel, [rect(700, 775, 300, 25)], 500)).toBe(300));
});
describe('quick window placement', () => {
  const primary = { x: 0, y: 0, width: 1920, height: 1040 };
  const secondary = { x: -1280, y: 0, width: 1280, height: 720 };
  it('centers a compact new window on the primary work area', () => expect(quickBounds(null, [primary])).toEqual({ x: 760, y: 340, width: 400, height: 360 }));
  it('keeps a visible saved position including negative monitor coordinates', () => expect(quickBounds({ x: -1200, y: 50, width: 450, height: 400 }, [primary, secondary])).toEqual({ x: -1200, y: 50, width: 450, height: 400 }));
  it('recovers a window from a disconnected monitor', () => expect(quickBounds({ x: 4000, y: 2000, width: 400, height: 360 }, [primary])).toEqual({ x: 760, y: 340, width: 400, height: 360 }));
  it('clamps partially offscreen windows and fits small screens', () => {
    expect(quickBounds({ x: 1800, y: 950, width: 500, height: 400 }, [primary])).toEqual({ x: 1420, y: 640, width: 500, height: 400 });
    expect(quickBounds({ width: 900, height: 900 }, [{ x: 0, y: 0, width: 320, height: 240 }])).toEqual({ x: 0, y: 0, width: 320, height: 240 });
  });
  it('rejects nonfinite stored geometry and broken work areas', () => {
    const bounds = quickBounds({ x: NaN, y: Infinity, width: NaN, height: -1 }, [{ x: 0, y: 0, width: NaN, height: 10 }, primary]);
    expect(Object.values(bounds).every(Number.isFinite)).toBe(true); expect(bounds.width).toBe(400); expect(bounds.height).toBe(280);
  });
});
