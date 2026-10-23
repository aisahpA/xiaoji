/** Use the plugin window's timer; windowless tests supply a timer-only host. */
export function sleep(milliseconds: number): Promise<void> {
  return new Promise(resolve => { window.setTimeout(resolve, milliseconds); });
}
