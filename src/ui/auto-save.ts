/** Coalesces typing, respects IME composition and serializes commits without losing later edits. */
export class AutoSave {
  private pending: (() => Promise<void> | void) | null = null;
  private timer: number | undefined;
  private tail: Promise<void> = Promise.resolve();
  private composing = false;
  private closed = false;
  constructor(private readonly failed: (error: unknown) => void, private readonly delay = 400, private readonly owner: Window = window) {}
  schedule(commit: () => Promise<void> | void, immediate = false): void {
    if (this.closed) return;
    this.owner.clearTimeout(this.timer); this.pending = commit;
    if (!this.composing) {
      if (immediate) void this.flush();
      else this.timer = this.owner.setTimeout(() => { void this.flush(); }, this.delay);
    }
  }
  composition(active: boolean): void {
    this.composing = active; this.owner.clearTimeout(this.timer);
    if (!active && this.pending && !this.closed) this.timer = this.owner.setTimeout(() => { void this.flush(); }, this.delay);
  }
  flush(): Promise<void> {
    this.owner.clearTimeout(this.timer);
    if (this.composing || !this.pending) return this.tail;
    const commit = this.pending; this.pending = null;
    this.tail = this.tail.then(commit).catch(error => { this.failed(error); });
    return this.tail;
  }
  close(): Promise<void> { const result = this.flush(); this.closed = true; this.pending = null; this.owner.clearTimeout(this.timer); return result; }
}
