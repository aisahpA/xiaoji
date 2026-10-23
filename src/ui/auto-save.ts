/** Coalesces typing, respects IME composition and serializes commits without losing later edits. */
export class AutoSave {
  private pending: (() => Promise<void> | void) | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private tail: Promise<void> = Promise.resolve();
  private composing = false;
  private closed = false;
  constructor(private readonly failed: (error: unknown) => void, private readonly delay = 400) {}
  schedule(commit: () => Promise<void> | void, immediate = false): void {
    if (this.closed) return;
    clearTimeout(this.timer); this.pending = commit;
    if (!this.composing) {
      if (immediate) void this.flush();
      else this.timer = setTimeout(() => { void this.flush(); }, this.delay);
    }
  }
  composition(active: boolean): void {
    this.composing = active; clearTimeout(this.timer);
    if (!active && this.pending && !this.closed) this.timer = setTimeout(() => { void this.flush(); }, this.delay);
  }
  flush(): Promise<void> {
    clearTimeout(this.timer);
    if (this.composing || !this.pending) return this.tail;
    const commit = this.pending; this.pending = null;
    this.tail = this.tail.then(commit).catch(error => { this.failed(error); });
    return this.tail;
  }
  close(): Promise<void> { const result = this.flush(); this.closed = true; this.pending = null; clearTimeout(this.timer); return result; }
}
