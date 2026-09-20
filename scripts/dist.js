/**
 * Windows 打包入口，等价于 `electron-builder --win portable`，
 * 但会在「没有符号链接权限」的 Windows 上自动降级。
 *
 * 要解决的问题
 * ------------
 * electron-builder 给 win-unpacked 里的主程序打图标 / 写版本信息时会调用
 * 内置的 rcedit，而 rcedit-x64.exe 来自它自动下载的 winCodeSign-2.6.0.7z。
 * 那个包里带有两个 **符号链接**（macOS 用的 .dylib），
 * Windows 上创建符号链接需要管理员权限或「开发者模式」，普通账户解压会直接失败：
 *
 *   ERROR: Cannot create symbolic link : 客户端没有所需的特权。 : ...libcrypto.dylib
 *
 * 而且这个解压是 electron-builder 的 Go 组件做的，JS 层拦不住，
 * 缓存里放好文件也会被重新解压覆盖。
 *
 * 降级做法
 * -------
 * 自己把那两个用不到的 darwin 文件排除掉再解压，拿到 rcedit-x64.exe，
 * 然后：
 *   1. `--dir` 生成 win-unpacked（跳过 electron-builder 自带的 rcedit）
 *   2. 用我们手上的 rcedit 给 **win-unpacked 里的主程序** 打图标 + 版本信息
 *   3. `--prepackaged` 拿这个目录直接做 portable exe
 *
 * ⚠️ 第 4 步「再给最外层的 portable exe 打一次图标」是**错的**，别再加回来：
 * NSIS 的免安装 exe 是「引导器 + 后面追加的 7z 载荷」，rcedit 改写 PE 资源时
 * 会把最后一个节之后的数据整段丢掉，而且是静默的（退出码 0），
 * 表现为 75MB 的成品被截成 56KB、双击没反应。
 * 外壳的图标和版本信息 electron-builder 是通过 VIAddVersionKey / MUI_ICON
 * 交给 makensis 写进去的，本来就不需要我们插手。
 *
 * 如果本机权限正常（CI、开了开发者模式），检测阶段会直接返回，
 * 走 electron-builder 原生流程，不会有任何额外行为。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const SEVEN_ZIP = path.join(ROOT, 'node_modules', '7zip-bin', 'win', 'x64', '7za.exe');
const TOOLS_DIR = path.join(ROOT, '.codesign-tools');
const RCEDIT = path.join(TOOLS_DIR, 'rcedit-x64.exe');
const ICON = path.join(ROOT, 'build', 'icon.ico');

const MIRRORS = [
  process.env.ELECTRON_BUILDER_BINARIES_MIRROR,
  'https://npmmirror.com/mirrors/electron-builder-binaries/',
  'https://github.com/electron-userland/electron-builder-binaries/releases/download/',
].filter(Boolean);

function cacheRoot() {
  return (
    process.env.ELECTRON_BUILDER_CACHE ||
    path.join(os.homedir(), 'AppData', 'Local', 'electron-builder', 'Cache')
  );
}

function log(msg) {
  console.log(`[dist] ${msg}`);
}

/** 找一份已经下好的 winCodeSign .7z */
function findCachedArchive() {
  const roots = [path.join(cacheRoot(), 'winCodeSign')];
  try {
    for (const e of fs.readdirSync(cacheRoot(), { withFileTypes: true })) {
      if (e.isDirectory() && /^winCodeSign/i.test(e.name)) {
        roots.push(path.join(cacheRoot(), e.name));
      }
    }
  } catch {
    /* ignore */
  }

  const found = [];
  for (const dir of roots) {
    try {
      for (const f of fs.readdirSync(dir)) {
        if (f.toLowerCase().endsWith('.7z') && /winCodeSign/i.test(f)) {
          found.push(path.join(dir, f));
        }
      }
    } catch {
      /* ignore */
    }
  }
  found.sort((a, b) => fs.statSync(b).size - fs.statSync(a).size);
  return found[0] || null;
}

/** 没有缓存就自己下一份 */
async function downloadArchive() {
  const dest = path.join(TOOLS_DIR, 'winCodeSign-2.6.0.7z');
  if (fs.existsSync(dest) && fs.statSync(dest).size > 1_000_000) return dest;

  for (const mirror of MIRRORS) {
    const base = mirror.endsWith('/') ? mirror : `${mirror}/`;
    const url = `${base}winCodeSign-2.6.0/winCodeSign-2.6.0.7z`;
    try {
      log(`下载 winCodeSign：${url}`);
      const res = await fetch(url, { redirect: 'follow' });
      if (!res.ok) continue;
      const buf = Buffer.from(await res.arrayBuffer());
      if (buf.length < 1_000_000) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, buf);
      return dest;
    } catch {
      /* 试下一个镜像 */
    }
  }
  return null;
}

/**
 * 解压出 rcedit（跳过 darwin）。
 * archive 由调用方传进来，避免这里重新找一次、结果把自己刚下的包漏掉。
 * 返回 true 表示可用。
 */
function prepareRcedit(archive) {
  if (fs.existsSync(RCEDIT)) return true;
  if (process.platform !== 'win32' || !fs.existsSync(SEVEN_ZIP)) return false;
  if (!archive) return false;

  try {
    fs.mkdirSync(TOOLS_DIR, { recursive: true });
    execFileSync(SEVEN_ZIP, ['x', '-y', '-xr!darwin', `-o${TOOLS_DIR}`, archive], {
      stdio: 'ignore',
      windowsHide: true,
    });
  } catch {
    return false;
  }
  return fs.existsSync(RCEDIT);
}

/** 在目录里找第一个匹配的 exe（productName 会变，不能硬编码文件名） */
function findFile(dir, re) {
  try {
    return (
      fs
        .readdirSync(dir, { withFileTypes: true })
        .filter((e) => e.isFile() && re.test(e.name))
        .map((e) => path.join(dir, e.name))
        .sort((a, b) => fs.statSync(b).size - fs.statSync(a).size)[0] || null
    );
  } catch {
    return null;
  }
}

/** 用本机 rcedit 给 exe 写图标与版本信息（只用于 win-unpacked 里的主程序） */
function applyResources(exePath) {
  if (!fs.existsSync(exePath) || !fs.existsSync(RCEDIT)) return false;
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const args = [
    exePath,
    '--set-icon', ICON,
    '--set-file-version', pkg.version,
    '--set-product-version', `${pkg.version}.0`,
    '--set-version-string', 'ProductName', '浮窗刷题助手',
    '--set-version-string', 'FileDescription', pkg.description,
    '--set-version-string', 'CompanyName', pkg.author,
    '--set-version-string', 'LegalCopyright', `Copyright © 2026 ${pkg.author}`,
  ];
  try {
    const r = spawnSync(RCEDIT, args, { windowsHide: true, encoding: 'utf8' });
    if (r.status !== 0) {
      log(`rcedit 失败：${(r.stderr || r.stdout || '').trim()}`);
      return false;
    }
    return true;
  } catch (e) {
    log(`rcedit 异常：${e.message}`);
    return false;
  }
}

/** 调 electron-builder 的 CLI（同一进程内跑，避免引一堆 spawn 细节） */
function runBuilder(args, outDir) {
  const cli = require.resolve('electron-builder/cli.js');
  const r = spawnSync(process.execPath, [cli, ...args], {
    cwd: ROOT,
    stdio: 'inherit',
    env: {
      ...process.env,
      // app-builder.exe（Go 写的）不读 .npmrc，只认这个环境变量。
      // 不设置的话它会去 github.com 直接下 nsis，国内网络基本必失败。
      ELECTRON_BUILDER_BINARIES_MIRROR:
        process.env.ELECTRON_BUILDER_BINARIES_MIRROR || MIRRORS[1],
      ELECTRON_BUILDER_CACHE_HIT: '1',
    },
  });
  return r.status === 0;
}

async function main() {
  const outDir = process.env.FLOATQUIZ_OUT || 'release';
  // 脚本自己决定 target / output / prepackaged，所以把这些参数从透传里剔掉，
  // 否则 `npm run dist`（= `dist.js --win portable`）会和下面的参数撞车。
  const OWNED = /^(-c\.|--win$|--dir$|--prepackaged$|portable$|--mac$|--linux$)/;
  const passthrough = process.argv.slice(2).filter((a) => !OWNED.test(a));

  // 先看现场能不能自己搞定 rcedit
  let archive = findCachedArchive();
  if (!archive) archive = await downloadArchive();

  if (!prepareRcedit(archive)) {
    log('未找到可用的 winCodeSign 包，交给 electron-builder 自己处理');
    const ok = runBuilder(['--win', 'portable', `-c.directories.output=${outDir}`, ...passthrough], outDir);
    process.exit(ok ? 0 : 1);
  }

  log('已就绪：使用本地 rcedit 逐 exe 写入图标与版本信息');

  // electron-builder 生成 win-unpacked 前要先清空同名目录，而它用的是
  // Go 侧的 EnsureEmptyDir —— 一旦遇到 Windows 文件锁（杀毒软件扫描、
  // 上一个进程没退干净），它既不会跳过也不会快速失败，会一直重试，
  // 表现为「打包卡住十几分钟然后报 app.asar 被占用」。
  // 所以这里先自己尝试清一次，清不掉就干脆换一个全新的目录名。
  let stepDir = path.join(ROOT, process.env.FLOATQUIZ_STEP || '.dist-step');
  if (fs.existsSync(path.join(stepDir, 'win-unpacked'))) {
    try {
      fs.rmSync(path.join(stepDir, 'win-unpacked'), {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 300,
      });
    } catch {
      const alt = `${stepDir}-${Date.now().toString(36)}`;
      log(`步骤目录被占用，改用 ${path.basename(alt)}`);
      stepDir = alt;
    }
  }

  // 1) 先出 unpacked 目录（跳过 electron-builder 自带的 rcedit）
  log('步骤 1/3：生成 win-unpacked');
  if (
    !runBuilder(
      [
        '--win',
        '--dir',
        '-c.win.signAndEditExecutable=false',
        `-c.directories.output=${stepDir}`,
        ...passthrough,
      ],
      stepDir
    )
  ) {
    log('步骤 1 失败');
    process.exit(1);
  }

  // 2) 给主程序补上图标与版本信息
  //    注意：只对 win-unpacked 里的主程序做，绝不能对外层的 portable exe 做。
  //    NSIS 生成的免安装 exe 是「56KB 引导器 + 后面追加的 7z 载荷」这种结构，
  //    rcedit 改写 PE 资源时会把最后一个节之后的数据整段丢掉 —— 而且是静默的
  //    （退出码 0），结果就是 75MB 的成品被截成 56KB。
  //    外壳的图标与版本信息由 NSIS 自己写（electron-builder 把 win.icon /
  //    version 通过 VIAddVersionKey、MUI_ICON 传给 makensis），不需要我们插手。
  const appExe = findFile(path.join(stepDir, 'win-unpacked'), /\.exe$/i);
  log(`步骤 2/3：写入主程序资源 ${appExe ? path.relative(ROOT, appExe) : '(未找到)'}`);
  if (appExe) applyResources(appExe, { isPortable: false });

  // 3) 用这个目录直接做 portable
  log('步骤 3/3：生成免安装单文件 exe');
  if (
    !runBuilder(
      [
        '--win',
        'portable',
        '--prepackaged',
        path.join(stepDir, 'win-unpacked'),
        '-c.win.signAndEditExecutable=false',
        `-c.directories.output=${outDir}`,
        ...passthrough,
      ],
      outDir
    )
  ) {
    log('步骤 3 失败');
    process.exit(1);
  }

  const portable = findFile(outDir, /\.exe$/i);
  if (!portable) {
    log('未找到产物 exe');
    process.exit(1);
  }
  const mb = fs.statSync(portable).size / 1024 / 1024;
  log(`完成：${path.relative(ROOT, portable)}（${mb.toFixed(1)} MB）`);
  if (mb < 20) {
    log('警告：产物偏小，可能载荷没被打进去，请检查');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('[dist] 失败：', e);
  process.exit(1);
});
