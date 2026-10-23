export interface WindowBounds { x: number; y: number; width: number; height: number; }
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);
export function quickBounds(stored: unknown, workAreas: readonly WindowBounds[]): WindowBounds {
  const data = stored && typeof stored === 'object' ? stored as Partial<WindowBounds> : {};
  const areas = workAreas.filter(area => Object.values(area).every(finite) && area.width > 0 && area.height > 0);
  const fallback = areas[0] ?? { x: 0, y: 0, width: 1200, height: 800 };
  const width = finite(data.width) ? Math.max(300, Math.min(1000, data.width)) : 400;
  const height = finite(data.height) ? Math.max(280, Math.min(1000, data.height)) : 360;
  let area = fallback, overlap = 0;
  if (finite(data.x) && finite(data.y)) for (const candidate of areas) {
    const visible = Math.max(0, Math.min(data.x + width, candidate.x + candidate.width) - Math.max(data.x, candidate.x)) *
      Math.max(0, Math.min(data.y + height, candidate.y + candidate.height) - Math.max(data.y, candidate.y));
    if (visible > overlap) { area = candidate; overlap = visible; }
  }
  const w = Math.min(width, area.width), h = Math.min(height, area.height);
  const x = overlap && finite(data.x) ? data.x : area.x + (area.width - w) / 2;
  const y = overlap && finite(data.y) ? data.y : area.y + (area.height - h) / 2;
  return { x: Math.round(Math.max(area.x, Math.min(area.x + area.width - w, x))),
    y: Math.round(Math.max(area.y, Math.min(area.y + area.height - h, y))), width: Math.floor(w), height: Math.floor(h) };
}
