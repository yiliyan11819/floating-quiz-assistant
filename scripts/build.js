/**
 * 构建脚本：esbuild 打包主进程 / preload / 各渲染页，并搬运静态资源。
 * 不用 webpack/vite 是为了让「克隆 → npm install → npm run dist」这条路最少坑。
 */
const esbuild = require('esbuild');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const DIST = path.join(ROOT, 'dist');
const SRC = path.join(ROOT, 'src');

function rimraf(p) {
  if (!fs.existsSync(p)) return;
  try {
    fs.rmSync(p, { recursive: true, force: true });
  } catch (e) {
    // 某些受管控的环境会拦截批量删除。dist 只是构建产物，
    // 删不掉也无所谓 —— esbuild 会直接覆盖同名文件。
    console.warn('[build] 清理 dist 失败（忽略，继续构建）:', e && e.message);
  }
}

function copyFile(from, to) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}

function copyDir(from, to) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const s = path.join(from, entry.name);
    const d = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(s, d);
    else fs.copyFileSync(s, d);
  }
}

async function main() {
  rimraf(DIST);

  const shared = {
    bundle: true,
    sourcemap: true,
    logLevel: 'warning',
    target: 'es2022',
  };

  // ---- 主进程 & preload（Node / CommonJS） ----
  await esbuild.build({
    ...shared,
    entryPoints: [path.join(SRC, 'main', 'main.ts')],
    outfile: path.join(DIST, 'main', 'main.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  });

  await esbuild.build({
    ...shared,
    entryPoints: [path.join(SRC, 'main', 'preload.ts')],
    outfile: path.join(DIST, 'main', 'preload.js'),
    platform: 'node',
    format: 'cjs',
    target: 'node20',
    external: ['electron'],
  });

  // ---- 渲染层（浏览器 / IIFE） ----
  const pages = ['float', 'overlay', 'settings', 'notebook'];
  await esbuild.build({
    ...shared,
    entryPoints: pages.map((p) => path.join(SRC, 'renderer', `${p}.ts`)),
    outdir: path.join(DIST, 'renderer'),
    platform: 'browser',
    format: 'iife',
    target: 'chrome120',
    minify: true,
  });

  // ---- 静态资源 ----
  const rendererSrc = path.join(SRC, 'renderer');
  for (const f of fs.readdirSync(rendererSrc)) {
    if (f.endsWith('.html') || f.endsWith('.css')) {
      copyFile(path.join(rendererSrc, f), path.join(DIST, 'renderer', f));
    }
  }

  // KaTeX 的样式与字体（公式必须的）
  const katexDist = path.join(ROOT, 'node_modules', 'katex', 'dist');
  copyFile(
    path.join(katexDist, 'katex.min.css'),
    path.join(DIST, 'renderer', 'vendor', 'katex', 'katex.min.css')
  );
  copyDir(
    path.join(katexDist, 'fonts'),
    path.join(DIST, 'renderer', 'vendor', 'katex', 'fonts')
  );

  // 应用图标（由 make-icon.js 产出到 build/，这里同步到 dist/assets 供运行时使用）
  for (const name of ['tray.png', 'icon.png']) {
    const from = path.join(ROOT, 'build', name);
    if (fs.existsSync(from)) copyFile(from, path.join(DIST, 'assets', name));
  }

  console.log('[build] done →', DIST);
}

main().catch((e) => {
  console.error('[build] failed:', e);
  process.exit(1);
});
