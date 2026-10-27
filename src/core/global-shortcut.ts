import { normalizeGlobalShortcut } from './shortcuts';
import { MemoError } from './types';

export interface ShortcutPort {
  register(key: string, callback: () => void): boolean;
  unregister(key: string): void;
}
export type CaptureStatus = 'captureOff' | 'captureReady' | 'captureLocal' | 'captureUnavailable' | 'captureConflict';

export function globalAccelerator(chord: string): string {
  const normalized = normalizeGlobalShortcut(chord);
  if (!normalized) throw new MemoError('invalidGlobalShortcut');
  return normalized.split('-').map(key => key === 'Mod' ? 'CommandOrControl' : key === 'ArrowUp' ? 'Up' :
    key === 'ArrowDown' ? 'Down' : key === 'ArrowLeft' ? 'Left' : key === 'ArrowRight' ? 'Right' : key).join('+');
}

/** Owns only the accelerator successfully registered by this plugin instance. */
export class GlobalCaptureShortcut {
  private owned = '';
  private ownerPort: ShortcutPort | null = null;
  private failure: CaptureStatus = 'captureUnavailable';
  constructor(private port: () => ShortcutPort | null, private capture: () => void) {}
  status(configured: string): CaptureStatus { return !configured ? 'captureOff' : configured === this.owned ? 'captureReady' : this.failure; }
  bind(chord: string): void {
    if (chord === this.owned) return;
    const bridge = this.port();
    const accelerator = chord ? globalAccelerator(chord) : '';
    if (chord) {
      if (!bridge) { this.failure = 'captureUnavailable'; throw new MemoError(this.failure); }
      let registered = false;
      try { registered = bridge.register(accelerator, this.capture); }
      catch { this.failure = 'captureUnavailable'; throw new MemoError(this.failure); }
      if (!registered) { this.failure = 'captureConflict'; throw new MemoError(this.failure); }
    }
    // Reserve the new key before releasing the old key: a failed change keeps working.
    const previous = this.owned;
    const previousPort = this.ownerPort;
    this.owned = chord;
    this.ownerPort = chord ? bridge : null;
    if (previous) { try { previousPort?.unregister(globalAccelerator(previous)); } catch { /* The host may be closing. */ } }
  }
  dispose(): void { this.bind(''); }
}

export function desktopShortcuts(): ShortcutPort | null {
  try {
    const remote = (window as Window & { require?: (id: string) => unknown }).require?.('@electron/remote') as { globalShortcut?: ShortcutPort } | undefined;
    const port = remote?.globalShortcut;
    return port && typeof port.register === 'function' && typeof port.unregister === 'function' ? port : null;
  } catch { return null; }
}
