/**
 * 设置页：所有改动即时保存到本地 JSON（防抖 300ms）。
 */
import { call, on, toast } from './client';
import type { SettingsPayload, AppInfoPayload, TestResult, Settings, Region } from './global';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  apiKey: $<HTMLInputElement>('apiKey'),
  toggleKey: $<HTMLButtonElement>('toggleKey'),
  btnClearKey: $<HTMLButtonElement>('btnClearKey'),
  keyHint: $('keyHint'),
  baseUrl: $<HTMLInputElement>('baseUrl'),
  model: $<HTMLInputElement>('model'),
  btnTest: $<HTMLButtonElement>('btnTest'),
  testResult: $('testResult'),

  styleGroup: $('styleGroup'),
  customStyleRow: $('customStyleRow'),
  customStylePrompt: $<HTMLTextAreaElement>('customStylePrompt'),

  regionText: $('regionText'),
  btnPickRegion: $<HTMLButtonElement>('btnPickRegion'),
  btnClearRegion: $<HTMLButtonElement>('btnClearRegion'),
  staticMs: $<HTMLInputElement>('staticMs'),
  staticMsOut: $('staticMsOut'),
  pollMs: $<HTMLInputElement>('pollMs'),
  pollMsOut: $('pollMsOut'),
  hammingThreshold: $<HTMLInputElement>('hammingThreshold'),
  hammingThresholdOut: $('hammingThresholdOut'),
  cooldownMs: $<HTMLInputElement>('cooldownMs'),
  cooldownMsOut: $('cooldownMsOut'),

  maxEdge: $<HTMLInputElement>('maxEdge'),
  maxEdgeOut: $('maxEdgeOut'),
  jpegQuality: $<HTMLInputElement>('jpegQuality'),
  jpegQualityOut: $('jpegQualityOut'),
  imageDetail: $<HTMLSelectElement>('imageDetail'),

  hotkey: $<HTMLInputElement>('hotkey'),
  btnResetHotkey: $<HTMLButtonElement>('btnResetHotkey'),
  opacity: $<HTMLInputElement>('opacity'),
  opacityOut: $('opacityOut'),
  autoStart: $<HTMLInputElement>('autoStart'),
  autoCollectAsked: $<HTMLInputElement>('autoCollectAsked'),

  extraBody: $<HTMLTextAreaElement>('extraBody'),

  cacheCount: $('cacheCount'),
  noteCount: $('noteCount'),
  dataPath: $('dataPath'),
  btnClearCache: $<HTMLButtonElement>('btnClearCache'),
  btnClearNotebook: $<HTMLButtonElement>('btnClearNotebook'),
  btnOpenNotebook: $<HTMLButtonElement>('btnOpenNotebook'),
  btnOpenData: $<HTMLButtonElement>('btnOpenData'),

  aboutVersion: $('aboutVersion'),
  aboutPlatform: $('aboutPlatform'),
  btnResetAll: $<HTMLButtonElement>('btnResetAll'),
};

let saving = false;

/* ------------------------------ 保存 ------------------------------ */

let saveTimer: number | null = null;
let pending: Partial<Settings> = {};

function save(patch: Partial<Settings>, immediate = false): void {
  pending = { ...pending, ...patch };
  if (saveTimer !== null) window.clearTimeout(saveTimer);
  const run = async () => {
    saveTimer = null;
    const body = pending;
    pending = {};
    if (!Object.keys(body).length) return;
    saving = true;
    try {
      await call('settings:set', body);
      if (body.hotkey) toast(`热键已改为 ${body.hotkey.replace(/Control/g, 'Ctrl').replace(/\+/g, ' + ')}`);
    } catch (e: any) {
      toast(`保存失败：${e?.message || e}`, 'error');
    } finally {
      saving = false;
    }
  };
  if (immediate) void run();
  else saveTimer = window.setTimeout(run, 300);
}

/* ------------------------------ 渲染 ------------------------------ */

function fmtRegion(r: Region | null): string {
  if (!r) return '未设置';
  return `${Math.round(r.x)}, ${Math.round(r.y)} · ${Math.round(r.width)}×${Math.round(r.height)}`;
}

function applySettings(
  s: Omit<Settings, 'apiKey'>,
  hasApiKey: boolean,
  redacted: string,
  keyBroken = false
): void {
  el.baseUrl.value = s.baseUrl;
  el.model.value = s.model;

  el.apiKey.value = '';
  el.apiKey.placeholder = hasApiKey ? redacted || 'sk-••••••••' : 'sk-...';
  if (keyBroken) {
    el.keyHint.textContent =
      '本机存着的 Key 解不开了（一般是换了 Windows 账户或换过电脑），请重新填一次。';
  } else if (hasApiKey) {
    el.keyHint.textContent = '已保存。留空表示不修改；想换 Key 就直接输入新的覆盖。';
  } else {
    el.keyHint.textContent = '还没有填写。到 platform.deepseek.com 申请一个。';
  }
  el.keyHint.style.color = keyBroken ? 'var(--danger)' : hasApiKey ? 'var(--ok)' : '';

  el.styleGroup.querySelectorAll<HTMLInputElement>('input[name=style]').forEach((r) => {
    r.checked = r.value === s.answerStyle;
  });
  el.customStylePrompt.value = s.customStylePrompt;
  el.customStyleRow.style.display = s.answerStyle === 'custom' ? '' : 'none';

  el.regionText.textContent = fmtRegion(s.monitorRegion);

  el.staticMs.value = String(s.staticMs);
  el.staticMsOut.textContent = `${s.staticMs} ms`;
  el.pollMs.value = String(s.pollMs);
  el.pollMsOut.textContent = `${s.pollMs} ms`;
  el.hammingThreshold.value = String(s.hammingThreshold);
  el.hammingThresholdOut.textContent = String(s.hammingThreshold);
  el.cooldownMs.value = String(s.cooldownMs);
  el.cooldownMsOut.textContent = `${Math.round(s.cooldownMs / 1000)} s`;

  el.maxEdge.value = String(s.maxEdge);
  el.maxEdgeOut.textContent = s.maxEdge === 0 ? '不压缩' : `${s.maxEdge} px`;
  el.jpegQuality.value = String(s.jpegQuality);
  el.jpegQualityOut.textContent = String(s.jpegQuality);
  el.imageDetail.value = s.imageDetail;

  el.hotkey.value = s.hotkey.replace(/Control|CommandOrControl|CmdOrCtrl/g, 'Ctrl').replace(/\+/g, ' + ');
  el.opacity.value = String(Math.round(s.opacity * 100));
  el.opacityOut.textContent = `${Math.round(s.opacity * 100)}%`;
  el.autoStart.checked = s.autoStart;
  el.autoCollectAsked.checked = s.autoCollectAsked;

  el.extraBody.value = s.extraBody;
}

async function refresh(): Promise<void> {
  const p = await call<SettingsPayload>('settings:get');
  applySettings(p.settings, p.hasApiKey, p.redactedKey, !!p.keyBroken);
  await refreshCounts();
}

async function refreshCounts(): Promise<void> {
  const cache = await call<any[]>('cache:list');
  const notes = await call<any[]>('notebook:list');
  el.cacheCount.textContent = `${cache.length} 条`;
  el.noteCount.textContent = `${notes.length} 条`;
}

/* ------------------------------ 事件绑定 ------------------------------ */

function bind(): void {
  // --- API Key ---
  el.toggleKey.onclick = () => {
    const show = el.apiKey.type === 'password';
    el.apiKey.type = show ? 'text' : 'password';
    el.toggleKey.textContent = show ? '隐藏' : '显示';
  };
  el.apiKey.oninput = () => {
    // 只在用户输入了内容时保存；清空输入框不会误删已保存的 Key
    const v = el.apiKey.value.trim();
    if (v) save({ apiKey: v });
  };
  el.btnClearKey.onclick = async () => {
    if (!confirm('清除本机保存的 API Key？')) return;
    await call('settings:set', { apiKey: '' });
    await refresh();
    toast('API Key 已清除');
  };

  el.baseUrl.oninput = () => save({ baseUrl: el.baseUrl.value.trim() });
  el.model.oninput = () => save({ model: el.model.value.trim() });

  el.btnTest.onclick = async () => {
    el.btnTest.disabled = true;
    el.testResult.className = 'test-result';
    el.testResult.textContent = '正在测试…';
    try {
      const typed = el.apiKey.value.trim();
      const r = await call<TestResult>('settings:test', {
        apiKey: typed || undefined,
        baseUrl: el.baseUrl.value.trim(),
      });
      el.testResult.className = `test-result ${r.ok ? 'ok' : 'err'}`;
      el.testResult.textContent = r.message;
    } catch (e: any) {
      el.testResult.className = 'test-result err';
      el.testResult.textContent = e?.message || '测试失败';
    } finally {
      el.btnTest.disabled = false;
    }
  };

  // --- 答案风格 ---
  el.styleGroup.querySelectorAll<HTMLInputElement>('input[name=style]').forEach((r) => {
    r.onchange = () => {
      if (!r.checked) return;
      el.customStyleRow.style.display = r.value === 'custom' ? '' : 'none';
      save({ answerStyle: r.value as Settings['answerStyle'] });
    };
  });
  el.customStylePrompt.oninput = () => save({ customStylePrompt: el.customStylePrompt.value });

  // --- 监控区域 ---
  el.btnPickRegion.onclick = async () => {
    el.btnPickRegion.disabled = true;
    const old = el.regionText.textContent;
    el.regionText.textContent = '框选中…';
    try {
      const r = await call<Region | null>('monitor:pickRegion');
      const p = await call<SettingsPayload>('settings:get');
      el.regionText.textContent = fmtRegion(p.settings.monitorRegion);
      if (!r) el.regionText.textContent = old || '未设置';
      else toast('监控区域已更新');
    } finally {
      el.btnPickRegion.disabled = false;
    }
  };
  el.btnClearRegion.onclick = async () => {
    await call('monitor:clearRegion');
    el.regionText.textContent = '未设置';
    toast('已清除监控区域');
  };

  // --- 滑条 ---
  const bindRange = (
    input: HTMLInputElement,
    out: HTMLElement,
    key: keyof Settings,
    fmt: (v: number) => string,
    transform: (v: number) => number = (v) => v
  ) => {
    input.oninput = () => {
      const v = Number(input.value);
      out.textContent = fmt(v);
      save({ [key]: transform(v) } as Partial<Settings>);
    };
  };

  bindRange(el.staticMs, el.staticMsOut, 'staticMs', (v) => `${v} ms`);
  bindRange(el.pollMs, el.pollMsOut, 'pollMs', (v) => `${v} ms`);
  bindRange(el.hammingThreshold, el.hammingThresholdOut, 'hammingThreshold', (v) => String(v));
  bindRange(el.cooldownMs, el.cooldownMsOut, 'cooldownMs', (v) => `${Math.round(v / 1000)} s`);
  bindRange(el.maxEdge, el.maxEdgeOut, 'maxEdge', (v) => (v === 0 ? '不压缩' : `${v} px`));
  bindRange(el.jpegQuality, el.jpegQualityOut, 'jpegQuality', (v) => String(v));
  bindRange(el.opacity, el.opacityOut, 'opacity', (v) => `${v}%`, (v) => v / 100);

  el.imageDetail.onchange = () =>
    save({ imageDetail: el.imageDetail.value as Settings['imageDetail'] });
  el.extraBody.oninput = () => {
    const v = el.extraBody.value.trim();
    if (!v) {
      save({ extraBody: '' });
      return;
    }
    try {
      JSON.parse(v);
      el.extraBody.style.borderColor = '';
      save({ extraBody: v });
    } catch {
      el.extraBody.style.borderColor = 'var(--danger)';
    }
  };

  // --- 热键 ---
  el.hotkey.onfocus = () => {
    el.hotkey.value = '';
    el.hotkey.placeholder = '请按下组合键…';
  };
  el.hotkey.onblur = () => {
    if (!el.hotkey.value) el.hotkey.placeholder = '点击后按下想用的组合键';
  };
  el.hotkey.onkeydown = (e) => {
    e.preventDefault();
    if (e.key === 'Escape') {
      el.hotkey.blur();
      void refresh();
      return;
    }
    const acc = toAccelerator(e);
    if (!acc) return;
    el.hotkey.value = acc.display;
    save({ hotkey: acc.value }, true);
  };
  el.btnResetHotkey.onclick = () => {
    save({ hotkey: 'Control+Shift+A' }, true);
    void refresh();
  };

  el.autoStart.onchange = () => save({ autoStart: el.autoStart.checked }, true);
  el.autoCollectAsked.onchange = () => save({ autoCollectAsked: el.autoCollectAsked.checked }, true);

  // --- 数据 ---
  el.btnClearCache.onclick = async () => {
    if (!confirm('清空后，同一道题再次出现会重新调用 API。确定清空吗？')) return;
    await call('cache:clear');
    await refreshCounts();
    toast('答案缓存已清空');
  };
  el.btnClearNotebook.onclick = async () => {
    if (!confirm('确定清空整个错题本？此操作不可撤销。')) return;
    await call('notebook:clear');
    await refreshCounts();
    toast('错题本已清空');
  };
  el.btnOpenNotebook.onclick = () => void call('ui:openNotebook');
  el.btnOpenData.onclick = () => {
    const p = el.dataPath.textContent || '';
    if (p) void call('ui:openExternal', { url: `file:///${p.replace(/\\/g, '/')}` });
  };

  el.btnResetAll.onclick = async () => {
    if (!confirm('恢复所有设置为默认值？API Key 会保留。')) return;
    await call('settings:reset');
    await refresh();
    toast('已恢复默认设置');
  };

  // --- 外部变更（例如在浮窗里改了模式） ---
  on('evt:settings', async () => {
    const p = await call<SettingsPayload>('settings:get');
    el.regionText.textContent = fmtRegion(p.settings.monitorRegion);
    if (p.hasApiKey) {
      el.apiKey.placeholder = p.redactedKey || 'sk-••••••••';
      el.keyHint.textContent = '已保存。留空表示不修改；想换 Key 就直接输入新的覆盖。';
      el.keyHint.style.color = 'var(--ok)';
    }
  });
  on('evt:notebook', () => void refreshCounts());
}

/* ------------------------------ 热键加速器 ------------------------------ */

const KEY_NAMES: Record<string, string> = {
  ' ': 'Space',
  ArrowUp: 'Up',
  ArrowDown: 'Down',
  ArrowLeft: 'Left',
  ArrowRight: 'Right',
  Escape: 'Esc',
  Enter: 'Return',
  '+': 'Plus',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'PageUp',
  PageDown: 'PageDown',
  Tab: 'Tab',
};

function toAccelerator(e: KeyboardEvent): { value: string; display: string } | null {
  const mods: string[] = [];
  if (e.ctrlKey) mods.push('Control');
  if (e.altKey) mods.push('Alt');
  if (e.shiftKey) mods.push('Shift');
  if (e.metaKey) mods.push('Super');

  const k = e.key;
  // 只按了修饰键，等他按下真正的键
  if (['Control', 'Alt', 'Shift', 'Meta', 'OS'].includes(k)) return null;

  let key: string;
  if (KEY_NAMES[k]) key = KEY_NAMES[k];
  else if (/^[a-zA-Z]$/.test(k)) key = k.toUpperCase();
  else if (/^[0-9]$/.test(k)) key = k;
  else if (/^F([1-9]|1[0-9]|2[0-4])$/.test(k)) key = k;
  else if (k.length === 1) key = k.toUpperCase();
  else return null;

  // 无修饰键的加速器会抢占全局输入，必须拦掉
  if (!mods.length) {
    toast('至少要带一个 Ctrl / Alt / Shift', 'error');
    return null;
  }

  const value = [...mods, key].join('+');
  const display = value.replace('Control', 'Ctrl').replace('Super', 'Win').replace(/\+/g, ' + ');
  return { value, display };
}

/* ------------------------------ 启动 ------------------------------ */

async function main(): Promise<void> {
  bind();
  await refresh();

  const info = await call<AppInfoPayload>('app:info');
  el.aboutVersion.textContent = `浮窗刷题助手 v${info.version}`;
  el.aboutPlatform.textContent = `Electron ${info.electron} · ${info.platform}`;
  el.dataPath.textContent = info.userDataPath;
  el.dataPath.title = info.userDataPath;
}

void main();
