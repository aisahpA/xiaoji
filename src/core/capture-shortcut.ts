import { eventShortcut, normalizeGlobalShortcut } from './shortcuts';
import { MemoError, type Settings } from './types';

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

/** 只持有本插件实例成功注册过的那个快捷键。 */
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
    // 先拿到新键再释放旧键：改键失败时旧快捷键仍然可用。
    const previous = this.owned;
    const previousPort = this.ownerPort;
    this.owned = chord;
    this.ownerPort = chord ? bridge : null;
    if (previous) { try { previousPort?.unregister(globalAccelerator(previous)); } catch { /* 宿主可能正在关闭。 */ } }
  }
  dispose(): void { this.bind(''); }
}

export function desktopShortcuts(): ShortcutPort | null {
  try {
    const remote = (window as Window & { require?: (id: string) => unknown }).require?.('@electron/remote') as { globalShortcut?: ShortcutPort } | undefined;
    const port = remote?.globalShortcut;
    if (!port || typeof port.register !== 'function' || typeof port.unregister !== 'function') return null;
    return {
      // Obsidian 的 Electron 主进程不随最后一个窗口退出，上一次渲染进程注册的快捷键会残留在主进程里；
      // 这里先释放同名 accelerator 再注册，避免重载插件后被自己的残留注册顶掉。
      register: (key, callback) => {
        try { port.unregister(key); } catch { /* 没有已注册的同名快捷键。 */ }
        return port.register(key, callback);
      },
      unregister: key => port.unregister(key),
    };
  } catch { return null; }
}

export type ShortcutSettings = Pick<Settings, 'captureKey' | 'captureGlobal'>;

/** 快速记录快捷键需要宿主提供的能力；main.ts 负责把 Obsidian 的 App 接进来。 */
export interface CaptureHost {
  /** 桌面端才能注册系统级快捷键。 */
  desktop: boolean;
  /** macOS 上 Ctrl 与 Cmd 的物理键位不同。 */
  mac: boolean;
  settings(): ShortcutSettings;
  /** 应用内 keydown 兜底要覆盖的文档：主窗口与所有弹窗。 */
  documents(): Document[];
  capture(): void;
  report(error: unknown): void;
  onWindowOpen(callback: (win: Window) => void): void;
  onWindowClose(callback: (win: Window) => void): void;
  /** 随插件卸载清理，等价于 Plugin.register。 */
  keep(dispose: () => void): void;
  /** 测试或特殊宿主可覆盖系统级快捷键端口；默认走 desktopShortcuts()。 */
  port?(): ShortcutPort | null;
}

/**
 * 快速记录快捷键的统一入口：系统级注册、应用内兜底、录制时暂停与状态文案都收敛在这里。
 * main.ts 只负责在 onload/onunload/设置变更时调用，不再自己持有注册状态。
 */
export class CaptureShortcut {
  private readonly stored: GlobalCaptureShortcut;
  private readonly documents = new Map<Document, () => void>();
  private pauses = 0;
  private installed = false;
  private disposed = false;
  constructor(private host: CaptureHost) {
    this.stored = new GlobalCaptureShortcut(
      () => this.host.desktop ? (this.host.port?.() ?? desktopShortcuts()) : null,
      () => { if (!this.disposed) this.host.capture(); },
    );
  }

  /** 当前应该注册的 accelerator 文本；空表示不注册（未设置、仅应用内或正在录制）。 */
  private chord(settings: ShortcutSettings = this.host.settings()): string {
    return settings.captureGlobal && !this.pauses ? settings.captureKey : '';
  }
  changed(next: ShortcutSettings, previous: ShortcutSettings): boolean {
    return this.host.desktop && (next.captureKey !== previous.captureKey || next.captureGlobal !== previous.captureGlobal);
  }
  /** 设置在持久化之前先绑定；失败时抛错，由调用方保留旧设置。 */
  apply(next: ShortcutSettings): void { if (this.host.desktop) this.stored.bind(this.chord(next)); }
  /** 持久化失败时退回旧设置对应的绑定。 */
  rollback(previous: ShortcutSettings): void {
    if (!this.host.desktop) return;
    try { this.stored.bind(this.chord(previous)); } catch (error) { this.host.report(error); }
  }
  /** 布局就绪后按当前设置首次注册；失败只上报，不阻塞启动。 */
  initial(): void {
    if (!this.host.desktop) return;
    try { this.stored.bind(this.chord()); } catch (error) { this.host.report(error); }
  }
  status(): CaptureStatus {
    const settings = this.host.settings();
    if (!settings.captureKey) return 'captureOff';
    if (!settings.captureGlobal || !this.host.desktop) return 'captureLocal';
    return this.stored.status(settings.captureKey);
  }
  /** 录制快捷键时临时停用全局响应，返回幂等的恢复函数。 */
  pause(): () => void {
    this.pauses++;
    this.stored.bind('');
    let resumed = false;
    return () => {
      if (resumed) return;
      resumed = true;
      this.pauses--;
      if (this.disposed) return;
      try { this.stored.bind(this.chord()); } catch (error) { this.host.report(error); }
    };
  }
  /** 全局快捷键与所有窗口里的应用内监听一并接上；重复调用无副作用。 */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    for (const doc of this.host.documents()) this.track(doc);
    this.host.onWindowOpen(win => this.track(win.document));
    this.host.onWindowClose(win => { this.documents.get(win.document)?.(); this.documents.delete(win.document); });
    this.host.keep(() => this.dispose());
  }
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.stored.dispose();
    for (const dispose of this.documents.values()) dispose();
    this.documents.clear();
    this.pauses = 0;
  }
  private track(doc: Document): void {
    if (this.disposed || this.documents.has(doc)) return;
    const keydown = (event: KeyboardEvent): void => {
      const settings = this.host.settings();
      if (this.pauses || (settings.captureGlobal && this.host.desktop) || !settings.captureKey || event.repeat || event.defaultPrevented) return;
      if (eventShortcut(event, this.host.mac) !== settings.captureKey) return;
      event.preventDefault(); event.stopImmediatePropagation(); this.host.capture();
    };
    doc.addEventListener('keydown', keydown, true);
    this.documents.set(doc, () => doc.removeEventListener('keydown', keydown, true));
  }
}
