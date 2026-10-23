import { beforeAll, vi } from 'vitest';

beforeAll(() => {
  if (typeof window === 'undefined') vi.stubGlobal('window', {
    setTimeout: (callback: () => void, milliseconds: number) => setTimeout(callback, milliseconds),
    clearTimeout: (id: ReturnType<typeof setTimeout>) => clearTimeout(id),
  });
});
