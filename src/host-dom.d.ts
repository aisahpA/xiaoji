export {};

declare global {
  interface Window {
    /** Obsidian's global DOM helper, called in the owning document's realm. */
    createFragment(): DocumentFragment;
  }
}
