/**
 * 生成 README 用的界面截图（开发辅助脚本，不参与打包）。
 *
 *   node_modules/electron/dist/electron.exe scripts/make-screenshot.js
 *
 * 做法：用桩掉的 window.api 加载 dist 里的真实页面，脚本化喂一段
 * 流式回答，等渲染完再 capturePage。所以截图是真实界面，不需要 API Key。
 */
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

async function shotFloat() {
  const win = new BrowserWindow({
    width: 380,
    height: 540,
    show: true,
    frame: false,
    backgroundColor: '#e8ecf4',
    webPreferences: { preload: stubPath, contextIsolation: true, nodeIntegration: false, sandbox: false },
  });
  await win.loadFile(path.join(RENDERER, 'float.html'), { query: { collapsed: '0' } });
  // 停在「流式输出到一半」的状态：状态点、光标、监控计数都能入镜
  await new Promise((r) => setTimeout(r, 2600));
  const img = await win.webContents.capturePage();
  fs.writeFileSync(path.join(OUT_DIR, 'screenshot-float.png'), img.toPNG());
  win.destroy();
}

async function shotOverlay() {
  const win = new BrowserWindow({
    width: 860,
    height: 470,
    show: true,
    frame: false,
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  });
  await win.loadFile(path.join(RENDERER, 'overlay.html'), {
    query: { hint: encodeURIComponent('拖拽框选要监控的区域（比如刷题网页的题目区）'), displayId: '1' },
  });
  await new Promise((r) => setTimeout(r, 500));
  await win.webContents.executeJavaScript(`
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
  win.destroy();
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
    app.exit(process.exitCode || 0);
  }
});
