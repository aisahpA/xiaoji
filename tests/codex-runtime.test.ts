// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { compareCodexVersions, discoverCodexRuntime } from '../src/core/codex-runtime';

afterEach(() => { delete (window as any).require; });
const install = () => {
  const desktop = 'C:\\Local\\OpenAI\\Codex\\bin\\build\\codex.exe', cli = 'C:\\Tools\\codex.exe';
  const files = new Set([desktop, cli]);
  const modules: Record<string, unknown> = {
    'node:fs': { readdirSync: () => [{ name: 'build', isDirectory: () => true }], statSync: (file: string) => { if (!files.has(file)) throw Error('missing'); return { isFile: () => true }; }, realpathSync: (file: string) => file },
    'node:path': path.win32, 'node:os': { homedir: () => 'C:\\Home' },
    'node:process': { platform: 'win32', arch: 'x64', env: { LOCALAPPDATA: 'C:\\Local', PATH: 'C:\\Tools', CODEX_HOME: 'C:\\Config' } },
  };
  (window as any).require = (id: string) => modules[id];
  return { desktop, cli };
};
describe('Codex runtime selection', () => {
  it('orders numeric prereleases and stable versions', () => {
    expect(compareCodexVersions('0.164.0-alpha.11.2', '0.164.0-alpha.11.1')).toBeGreaterThan(0);
    expect(compareCodexVersions('0.164.0-alpha.11', '0.164.0-alpha.9')).toBeGreaterThan(0);
    expect(compareCodexVersions('0.164.0', '0.164.0-alpha.11')).toBeGreaterThan(0);
    expect(compareCodexVersions('0.164.0-alpha.11', '0.146.0')).toBeGreaterThan(0);
  });
  it('selects the newer verified desktop runtime over an old PATH installation', async () => {
    const { desktop } = install();
    expect(await discoverCodexRuntime('', async file => file === desktop ? '0.164.0-alpha.11.1' : '0.146.0')).toEqual({ path: desktop, version: '0.164.0-alpha.11.1', source: 'desktop', home: 'C:\\Config' });
  });
  it('honors an explicit executable even if another installation is newer', async () => {
    const { cli } = install(); const probe = vi.fn(async () => '0.146.0');
    expect((await discoverCodexRuntime(cli, probe)).path).toBe(cli); expect(probe).toHaveBeenCalledOnce();
  });
  it('skips an inaccessible candidate without losing the working installation', async () => {
    const { cli } = install();
    expect((await discoverCodexRuntime('', async file => { if (file !== cli) throw Error('access denied'); return '0.146.0'; })).path).toBe(cli);
    await expect(discoverCodexRuntime('', async () => null)).rejects.toThrow('codexNotFound');
    await expect(discoverCodexRuntime('codex')).rejects.toThrow('codexNotFound');
  });
});
