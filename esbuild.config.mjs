import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import fs from 'node:fs/promises';
import path from 'node:path';

const context = await esbuild.context({
  entryPoints: ['src/main.ts'],
  bundle: true,
  metafile: true,
  external: [
    'obsidian', 'electron', ...builtinModules,
    '@codemirror/autocomplete', '@codemirror/commands',
    '@codemirror/language', '@codemirror/state', '@codemirror/view',
    '@lezer/common', '@lezer/highlight', '@lezer/lr',
  ],
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  outfile: 'main.js',
  sourcemap: false,
  minify: !process.argv.includes('--watch'),
  logLevel: 'info',
  banner: { js: '/* xiaoji · Plain Markdown. Your thoughts stay yours. */' },
});
if (process.argv.includes('--watch')) await context.watch();
else {
  const result = await context.rebuild(); await context.dispose();
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /^node_modules\/((?:@[^/]+\/)?[^/]+)/.exec(input.replace(/\\/g, '/'));
    if (match) packages.add(match[1]);
  }
  const notices = ['# Bundled third-party licenses', '', 'Host-provided dependencies are external to this bundle.', ''];
  for (const name of [...packages].sort()) {
    const folder = path.join('node_modules', name);
    const pkg = JSON.parse(await fs.readFile(path.join(folder, 'package.json'), 'utf8'));
    const license = (await fs.readdir(folder)).find(file => /^licen[sc]e(?:\.|$)/i.test(file));
    if (!license) throw Error('Missing license text for bundled package: ' + name);
    notices.push('## ' + name + ' ' + pkg.version, '', await fs.readFile(path.join(folder, license), 'utf8'), '');
  }
  const text = notices.join('\n');
  await fs.writeFile('THIRD_PARTY_NOTICES.md', text);
  await fs.appendFile('main.js', '\n/*!\n' + text.replace(/\*\//g, '* /') + '\n*/\n');
}
