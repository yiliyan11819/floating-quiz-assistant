/**
 * 生成 README 用的界面截图（开发辅助脚本，不参与打包）。
 *
 *   npm run shots
 *
 * 做法：用桩掉的 window.api 加载 dist 里的真实页面，脚本化喂一段
 * 流式回答，等渲染完再 capturePage。所以截图是真实界面，不需要 API Key。
 * 产物：docs/screenshot-float.png、docs/screenshot-region.png
 *
 * ── 三个容易踩的坑 ──────────────────────────────────────────
 * 1. ELECTRON_RUN_AS_NODE。带这个变量启动时 electron.exe 会退化成普通 Node，
 *    require('electron') 只拿得到一个路径字符串，`app` 是 undefined，脚本第一行就炸：
 *      TypeError: Cannot read properties of undefined (reading 'whenReady')
 *    脚本开头会自己把这个变量减掉、用真正的 Electron 重开一次，调用方不用管。
 * 2. 全程只用一个窗口。Electron 33 上「destroy 一个窗口 → 立刻新建再 loadFile」
 *    会让渲染进程崩掉（第二次 loadFile 报 ERR_FAILED，整个进程随之退出）。
 *    见下面的 getWindow()。
 * 3. 页面参数不要走 query。file:// 上带非 ASCII 的查询串会被 Chromium 判成
 *    ERR_FAILED，中文提示文字改成加载完直接写 DOM。
 *
 * 想看着窗口跑（调试用）：FLOATQUIZ_SHOT_VISIBLE=1 npm run shots
 */

// 坑 1 的自愈：先减掉 ELECTRON_RUN_AS_NODE，再用真正的 Electron 重跑一遍自己。
if (process.env.ELECTRON_RUN_AS_NODE) {
  const { spawnSync } = require('node:child_process');
  const env = { ...process.env };
  delete env.ELECTRON_RUN_AS_NODE;
  const r = spawnSync(process.execPath, [__filename, ...process.argv.slice(2)], {
    stdio: 'inherit',
    env,
  });
  process.exit(r.status ?? 1);
}
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.join(__dirname, '..');
const RENDERER = path.join(ROOT, 'dist', 'renderer');
const OUT_DIR = path.join(ROOT, 'docs');

const STUB_PRELOAD = `
const { contextBridge } = require('electron');
const listeners = {};
const DEFAULTS = {
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  answerStyle: 'full',
  customStylePrompt: '',
  staticMs: 1000,
  pollMs: 500,
  hammingThreshold: 4,
  cooldownMs: 30000,
  hotkey: 'Control+Shift+A',
  monitorRegion: { x: 120, y: 90, width: 1160, height: 620, displayId: 1 },
  autoStart: false,
  maxEdge: 1600,
  jpegQuality: 85,
  imageDetail: 'high',
  extraBody: '',
  opacity: 1,
  autoCollectAsked: true,
};
const api = {
  async invoke(ch) {
    if (ch === 'settings:get') return { ok: true, data: { settings: DEFAULTS, hasApiKey: true, redactedKey: 'sk-8f2a********91cd' } };
    if (ch === 'mode:get') return { ok: true, data: { mode: 'auto', paused: false } };
    if (ch === 'monitor:state') return { ok: true, data: { running: true, lastHash: 'c3a91f0e5b2d7744', recognizing: false, triggers: 3, stillMs: 830, lastError: null } };
    return { ok: true, data: null };
  },
  on(ch, cb) { (listeners[ch] = listeners[ch] || []).push(cb); return () => {}; },
  once() {},
};
contextBridge.exposeInMainWorld('api', api);
const emit = (ch, p) => (listeners[ch] || []).forEach((f) => f(p));

const ANSWER = [
  '**答案：$a \\\\le 1$**',
  '',
  '**解析**',
  '',
  '二次函数 $f(x)=x^{2}-2ax+3$ 开口向上，对称轴为',
  '',
  '$$x=\\\\frac{-(-2a)}{2}=a$$',
  '',
  '1. 在 $[1,+\\\\infty)$ 上单调递增，等价于对称轴落在区间左端点的左侧或重合，即 $a \\\\le 1$；',
  '2. 也可求导验证：$f\\'(x)=2x-2a\\\\ge 0$ 对一切 $x\\\\ge 1$ 成立，取 $x=1$ 得 $a\\\\le 1$；',
  '3. 端点 $a=1$ 时 $f\\'(1)=0$，区间内仍有 $f\\'(x)\\\\ge 0$，单调性不受影响。',
  '',
  '所以 $a$ 的取值范围是 $(-\\\\infty,\\\\,1]$。',
].join('\\n');

setTimeout(() => {
  emit('evt:mode', { mode: 'auto' });
  emit('evt:monitor', { running: true, lastHash: 'c3a91f0e5b2d7744', recognizing: false, triggers: 3, stillMs: 830, lastError: null });
}, 250);

setTimeout(() => {
  emit('evt:status', { status: 'answering', text: '正在解答…', mode: 'auto' });
  emit('evt:stream', { kind: 'start', requestId: 'shot-1', scope: 'solve' });
  let i = 0;
  const timer = setInterval(() => {
    i += 6;
    emit('evt:stream', { kind: 'chunk', requestId: 'shot-1', scope: 'solve', delta: ANSWER.slice(i - 6, i) });
    if (i >= ANSWER.length) clearInterval(timer);
  }, 60);
}, 700);
`;

const stubPath = path.join(os.tmpdir(), `floatquiz-shot-preload-${process.pid}.js`);

/**
 * 复用一个窗口。
 *
 * 踩过的坑：Electron 33 上「destroy 掉一个窗口 → 马上新建一个再 loadFile」
 * 会让渲染进程直接崩，第二次 loadFile 报 `ERR_FAILED (-2)`，
 * 而且整个进程随后也没了（后面的截图根本轮不到执行）。
 * 所以这里全程只建一次窗口，尺寸用 setContentSize 切，最后统一销毁。
 */
let sharedWin = null;

function getWindow() {
  if (!sharedWin || sharedWin.isDestroyed()) {
    sharedWin = new BrowserWindow({
      width: 380,
      height: 540,
      show: process.env.FLOATQUIZ_SHOT_VISIBLE === '1',
      frame: false,
      backgroundColor: '#e8ecf4',
      webPreferences: {
        preload: stubPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
  }
  return sharedWin;
}

async function shotFloat() {
  const win = getWindow();
  win.setContentSize(380, 540);
  await win.loadFile(path.join(RENDERER, 'float.html'), { query: { collapsed: '0' } });
  // 停在「流式输出到一半」的状态：状态点、光标、监控计数都能入镜。
  // 注意别调太短 —— 增量渲染是按实际耗时自适应节流的，画面比数据流慢半拍，
  // 等太短会截到「只有标题、公式还没画出来」的空壳。
  await new Promise((r) => setTimeout(r, 4600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'screenshot-float.png'), img.toPNG());
}

async function shotOverlay() {
  const win = getWindow();
  win.setContentSize(860, 470);
  // 不用 query 传参：file:// 上带非 ASCII 的查询串会被 Chromium 判成 ERR_FAILED，
  // 提示文字改成加载完直接写 DOM（见下面的 executeJavaScript）。
  await win.loadFile(path.join(RENDERER, 'overlay.html'));
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript(`
    document.getElementById('hintText').textContent = '拖拽框选要监控的区域（比如刷题网页的题目区）';
    document.getElementById('dim').classList.add('hidden');
    var sel = document.getElementById('sel');
    sel.classList.remove('hidden');
    sel.style.left = '150px'; sel.style.top = '110px';
    sel.style.width = '560px'; sel.style.height = '250px';
    var lbl = document.getElementById('sizeLabel');
    lbl.textContent = '560 × 250';
    lbl.style.right = '-1px'; lbl.style.bottom = '-26px';
  `);
  await new Promise((r) => setTimeout(r, 350));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'screenshot-region.png'), img.toPNG());
}

app.whenReady().then(async () => {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(stubPath, STUB_PRELOAD, 'utf8');
  try {
    await shotFloat();
    await shotOverlay();
    console.log('[shot] docs/screenshot-float.png, docs/screenshot-region.png');
  } catch (e) {
    console.error('[shot] failed', e);
    process.exitCode = 1;
  } finally {
    try {
      fs.rmSync(stubPath, { force: true });
    } catch {
      /* ignore */
    }
    try {
      if (sharedWin && !sharedWin.isDestroyed()) sharedWin.destroy();
    } catch {
      /* ignore */
    }
    app.exit(process.exitCode || 0);
  }
});
