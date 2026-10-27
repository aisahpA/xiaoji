import { Platform } from 'obsidian';
import { MemoError } from './types';

export interface CodexRuntime { path: string; version: string; source: 'configured' | 'desktop' | 'path'; home: string; }
export interface CodexCandidate { path: string; source: CodexRuntime['source']; }

export function desktopNode() {
  if (!Platform.isDesktop) throw new MemoError('codexDesktopOnly');
  const host = window as Window & { require?: (id: string) => unknown };
  if (!host.require) throw new MemoError('codexUnavailable');
  return {
    fs: host.require('node:fs') as typeof import('node:fs'), path: host.require('node:path') as typeof import('node:path'),
    os: host.require('node:os') as typeof import('node:os'), runtime: host.require('node:process') as typeof import('node:process'),
    modules: host.require('node:module') as typeof import('node:module'), childProcess: host.require('node:child_process') as typeof import('node:child_process'),
  };
}

/** Version order, with stable releases preferred to prereleases of the same version. */
export function compareCodexVersions(left: string, right: string): number {
  const parse = (value: string): number[] => (value.match(/^\d+\.\d+\.\d+/)?.[0] ?? '0.0.0').split('.').map(Number);
  const a = parse(left), b = parse(right);
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  const stable = Number(!left.includes('-')) - Number(!right.includes('-'));
  if (stable) return stable;
  const preA = left.split('-')[1]?.split('.') ?? [], preB = right.split('-')[1]?.split('.') ?? [];
  for (let i = 0; i < Math.max(preA.length, preB.length); i++) {
    const x = preA[i], y = preB[i];
    if (x === y) continue;
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    const numericX = /^\d+$/.test(x), numericY = /^\d+$/.test(y);
    return numericX && numericY ? Number(x) - Number(y) : numericX !== numericY ? (numericX ? -1 : 1) : x.localeCompare(y);
  }
  return 0;
}

export function codexCandidates(executable = ''): CodexCandidate[] {
  const { fs, path, os, runtime, modules } = desktopNode();
  if (executable && (!path.isAbsolute(executable) || /[\r\n\0]/.test(executable))) throw new MemoError('codexNotFound');
  const windows = runtime.platform === 'win32';
  const platform = windows ? 'win32' : runtime.platform === 'darwin' ? 'darwin' : 'linux';
  const triple = (runtime.arch === 'arm64' ? 'aarch64' : 'x86_64') + (windows ? '-pc-windows-msvc' : platform === 'darwin' ? '-apple-darwin' : '-unknown-linux-musl');
  const entries: CodexCandidate[] = [];
  if (executable) entries.push({ path: executable, source: 'configured' });
  else {
    if (windows && runtime.env.LOCALAPPDATA) {
      const root = path.join(runtime.env.LOCALAPPDATA, 'OpenAI', 'Codex', 'bin');
      try {
        const folders = fs.readdirSync(root, { withFileTypes: true }).filter(item => item.isDirectory() && /^[\w.-]+$/.test(item.name)).slice(0, 8);
        for (const folder of folders) entries.push({ path: path.join(root, folder.name, 'codex.exe'), source: 'desktop' });
      } catch { /* A desktop Codex installation is optional. */ }
    }
    if (runtime.platform === 'darwin') for (const applications of ['/Applications', path.join(os.homedir(), 'Applications')]) {
      const resources = path.join(applications, 'ChatGPT.app', 'Contents', 'Resources');
      for (const binary of ['codex', path.join('codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'codex'), path.join('codex-cli', 'CodexCLI.app', 'Contents', 'MacOS', 'CodexCLI')]) entries.push({ path: path.join(resources, binary), source: 'desktop' });
    }
    const names = windows ? ['codex.exe', 'codex.cmd', 'codex.ps1'] : ['codex'];
    for (const folder of (runtime.env.PATH ?? '').split(path.delimiter).filter(Boolean)) for (const name of names) entries.push({ path: path.resolve(folder, name), source: 'path' });
    for (const candidate of windows ? [path.join(runtime.env.APPDATA ?? '', 'npm', 'codex.cmd')] : [path.join(os.homedir(), '.local/bin/codex'), path.join(os.homedir(), '.cargo/bin/codex'), '/opt/homebrew/bin/codex', '/usr/local/bin/codex']) entries.push({ path: candidate, source: 'path' });
  }
  const found: CodexCandidate[] = [], seen = new Set<string>();
  const add = (file: string, source: CodexRuntime['source']): void => {
    if (!fs.statSync(file).isFile()) return;
    const real = fs.realpathSync(file), key = windows ? real.toLowerCase() : real;
    if (!seen.has(key)) { seen.add(key); found.push({ path: real, source }); }
  };
  for (const candidate of entries) try {
    if (!fs.statSync(candidate.path).isFile()) continue;
    const real = fs.realpathSync(candidate.path);
    if (!/\.(?:cmd|ps1|js)$/i.test(real)) { add(real, candidate.source); continue; }
    const root = /\.js$/i.test(real) ? path.dirname(path.dirname(real)) : path.join(path.dirname(real), 'node_modules', '@openai', 'codex');
    const vendors = [path.join(root, 'vendor')];
    try { vendors.unshift(path.join(path.dirname(modules.createRequire(path.join(root, 'package.json')).resolve('@openai/codex-' + platform + '-' + runtime.arch + '/package.json')), 'vendor')); } catch { /* Older npm packages contain vendor directly. */ }
    for (const vendor of vendors) for (const folder of ['bin', 'codex']) { try { add(path.join(vendor, triple, folder, windows ? 'codex.exe' : 'codex'), candidate.source); } catch { /* Not installed in this layout. */ } }
  } catch { /* Skip unavailable paths without invoking a command shell. */ }
  return found;
}

export function probeCodexVersion(binary: string): Promise<string | null> {
  const { childProcess: { spawn }, os } = desktopNode();
  return new Promise(resolve => {
    const child = spawn(binary, ['--version'], { cwd: os.tmpdir(), windowsHide: true, shell: false, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '', settled = false;
    const finish = (value: string | null): void => { if (settled) return; settled = true; window.clearTimeout(timer); resolve(value); };
    const timer = window.setTimeout(() => { child.kill(); finish(null); }, 2500);
    child.stdout.setEncoding('utf8'); child.stdout.on('data', (chunk: string) => { output = (output + chunk).slice(0, 2048); }); child.stderr.on('data', () => undefined);
    child.on('error', () => finish(null)); child.on('close', code => finish(code === 0 ? /^codex(?:-cli)?\s+(\d+\.\d+\.\d+(?:-[\w.-]+)?)/m.exec(output)?.[1] ?? null : null));
  });
}

export async function discoverCodexRuntime(executable = '', probe = probeCodexVersion): Promise<CodexRuntime> {
  const { runtime, os, path } = desktopNode();
  const candidates = codexCandidates(executable).slice(0, 12);
  const versions = await Promise.all(candidates.map(async candidate => ({ ...candidate, version: await probe(candidate.path).catch(() => null) })));
  const available = versions.filter((item): item is CodexCandidate & { version: string } => Boolean(item.version));
  available.sort((a, b) => compareCodexVersions(b.version, a.version));
  const selected = available[0]; if (!selected) throw new MemoError('codexNotFound');
  return { ...selected, home: runtime.env.CODEX_HOME || path.join(os.homedir(), '.codex') };
}
