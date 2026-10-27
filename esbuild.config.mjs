import esbuild from 'esbuild';
import { builtinModules } from 'node:module';
import { copyFileSync, mkdirSync, watch } from 'node:fs';

// `dist/` 就是插件本身：main.js、manifest.json、styles.css。项目根只放源码。
const OUT_DIR = 'dist';
const CSS_SOURCE = 'styles.css';
const MANIFEST = 'manifest.json';

const isProd = process.argv.includes('--prod');
const isWatch = process.argv.includes('--watch');

mkdirSync(OUT_DIR, { recursive: true });

const js = {
  entryPoints: ['src/main.ts'],
  bundle: true,
  external: [
    'obsidian', 'electron', ...builtinModules,
    '@codemirror/autocomplete', '@codemirror/commands',
    '@codemirror/language', '@codemirror/state', '@codemirror/view',
    '@lezer/common', '@lezer/highlight', '@lezer/lr',
  ],
  format: 'cjs',
  target: 'es2022',
  platform: 'browser',
  outfile: `${OUT_DIR}/main.js`,
  sourcemap: isProd ? false : 'inline',
  minify: isProd,
  logLevel: 'info',
  banner: { js: '/* xiaoji · Plain Markdown. Your thoughts stay yours. */' },
};

// 样式表：生产构建压缩它，开发构建直接拷贝（保留注释，方便在 devtools 里定位规则来源）。
async function writeStyles() {
  if (isProd) {
    await esbuild.build({
      entryPoints: [CSS_SOURCE],
      outfile: `${OUT_DIR}/${CSS_SOURCE}`,
      bundle: false,
      minify: true,
      sourcemap: false,
      logLevel: 'warning',
    });
  } else {
    copyFileSync(CSS_SOURCE, `${OUT_DIR}/${CSS_SOURCE}`);
  }
}

function writeManifest() {
  copyFileSync(MANIFEST, `${OUT_DIR}/${MANIFEST}`);
}

if (isWatch) {
  const ctx = await esbuild.context(js);
  await ctx.watch();
  await writeStyles();
  writeManifest();
  // ctx.watch() 只跟 JS 的 import 图，样式表和 manifest 不在其中，各自配一个 watcher。
  watch(CSS_SOURCE, () => void writeStyles());
  watch(MANIFEST, () => writeManifest());
  console.log(`watching src/, ${CSS_SOURCE} and ${MANIFEST} …`);
} else {
  writeManifest();
  await writeStyles();
  await esbuild.build(js);
}
