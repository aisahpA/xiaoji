export interface WindowBounds { x: number; y: number; width: number; height: number; }
/** A quick-capture window is a companion panel, never a full-screen workspace. */
const DEFAULT_WIDTH = 400, DEFAULT_HEIGHT = 360;
const MAX_WIDTH = 720, MAX_HEIGHT = 560;
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function quickBounds(stored: unknown, workAreas: readonly WindowBounds[]): WindowBounds {
  const data = stored && typeof stored === 'object' ? stored as Partial<WindowBounds> : {};
  const areas = workAreas.filter(area => Object.values(area).every(finite) && area.width > 0 && area.height > 0);
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1200, height: 800 };
  // Geometry at or above the compact ceiling was recorded while the window was maximized,
  // full-screened or stretched across the screen; reuse only the compact default instead.
  const savedWidth = finite(data.width) && data.width <= MAX_WIDTH ? Math.max(300, data.width) : null;
  const savedHeight = finite(data.height) && data.height <= MAX_HEIGHT ? Math.max(280, data.height) : null;
  const width = savedWidth ?? DEFAULT_WIDTH, height = savedHeight ?? DEFAULT_HEIGHT;
  const restorable = savedWidth !== null && savedHeight !== null;
  let area = fallback, overlap = 0;
  if (restorable && finite(data.x) && finite(data.y)) for (const candidate of areas) {
    const visible = Math.max(0, Math.min(data.x + width, candidate.x + candidate.width) - Math.max(data.x, candidate.x)) *
      Math.max(0, Math.min(data.y + height, candidate.y + candidate.height) - Math.max(data.y, candidate.y));
    if (visible > overlap) { area = candidate; overlap = visible; }
  }
  const w = Math.min(width, area.width), h = Math.min(height, area.height);
  const x = overlap && restorable && finite(data.x) ? data.x : area.x + (area.width - w) / 2;
  const y = overlap && restorable && finite(data.y) ? data.y : area.y + (area.height - h) / 2;
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - w, x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - h, y))), width: Math.floor(w), height: Math.floor(h) };
}
