/**
 * 浮窗渲染逻辑：三模式切换、流式答案、多轮追问、状态指示、折叠胶囊。
 */
import { call, on, toast, fmtDuration } from './client';
import { renderMarkdown, createThrottledRenderer } from './markdown';
import type { StreamEvent, MonitorState, Mode, StatusPayload, SettingsPayload } from './global';

/* ------------------------------- DOM ------------------------------- */

const $ = <T extends HTMLElement>(id: string): T => {
  const el = document.getElementById(id);
  if (!el) throw new Error(`缺少元素 #${id}`);
  return el as T;
};

const els = {
  card: $('card'),
  capsule: $<HTMLButtonElement>('capsule'),
  capsuleDot: $('capsuleDot'),
  status: $('status'),
  modes: $('modes'),
  hintbar: $('hintbar'),
  answer: $('answer'),
  empty: $('empty'),
  emptySub: $('emptySub'),
  hotkeyText: $('hotkeyText'),
  setupTip: $('setupTip'),
  btnGoSettings: $<HTMLButtonElement>('btnGoSettings'),
  btnSettings: $<HTMLButtonElement>('btnSettings'),
  btnNotebook: $<HTMLButtonElement>('btnNotebook'),
  btnCollapse: $<HTMLButtonElement>('btnCollapse'),
  btnHide: $<HTMLButtonElement>('btnHide'),
  btnSolve: $<HTMLButtonElement>('btnSolve'),
  btnPause: $<HTMLButtonElement>('btnPause'),
  btnReanswer: $<HTMLButtonElement>('btnReanswer'),
  btnCancel: $<HTMLButtonElement>('btnCancel'),
  btnSend: $<HTMLButtonElement>('btnSend'),
  ask: $<HTMLTextAreaElement>('ask'),
  meta: $('meta'),
  grip: $('grip'),
};

/* ------------------------------- 状态 ------------------------------- */

interface Entry {
  kind: 'assistant' | 'asked' | 'error';
  el: HTMLElement;
  body?: HTMLElement;
  renderer?: ReturnType<typeof createThrottledRenderer>;
  text: string;
  done: boolean;
}

let entries: Entry[] = [];
let activeRequestId: string | null = null;
let pendingQuestion = '';
let mode: Mode = 'manual';
let autoPaused = false;
let status: StatusPayload['status'] = 'idle';
let reasoningChars = 0;
let lastMonitor: MonitorState | null = null;
let hasApiKey = true;

/* ------------------------------- 工具 ------------------------------- */

function setStatusBadge(s: StatusPayload['status'], text: string): void {
  status = s;
  const map: Record<string, string> = {
    idle: '',
    reading: 'reading',
    answering: 'answering',
    error: 'danger',
    paused: 'warn',
  };
  els.status.className = `badge ${map[s] ?? ''}`;
  els.status.textContent = text;
  updateCapsuleDot();
}

function updateCapsuleDot(): void {
  const busy = status === 'reading' || status === 'answering';
  els.capsuleDot.className = `capsule-dot ${busy ? 'busy' : status === 'error' ? 'err' : ''} ${
    mode === 'auto' && !autoPaused && !busy ? 'run' : ''
  }`;
}

function scrollToEnd(): void {
  els.answer.scrollTop = els.answer.scrollHeight;
}

function removeEmpty(): void {
  if (els.empty && els.empty.parentElement) els.empty.remove();
}

function warnEmpty(): void {
  if (!document.getElementById('empty')) {
    els.answer.appendChild(els.empty);
  }
}

function clearEntries(): void {
  for (const e of entries) e.el.remove();
  entries = [];
  els.answer.innerHTML = '';
  els.answer.appendChild(els.empty);
}

function addEntry(kind: Entry['kind'], text: string, opts: { cached?: boolean; streaming?: boolean } = {}): Entry {
  removeEmpty();

  const wrap = document.createElement('div');
  wrap.className = `entry ${kind === 'asked' ? 'asked' : 'assistant'}`;

  const head = document.createElement('div');
  head.className = 'entry-head';
  const role = document.createElement('span');
  role.className = 'entry-role';
  role.textContent = kind === 'asked' ? '追问' : kind === 'error' ? '出错了' : '解答';
  head.appendChild(role);

  if (opts.cached) {
    const b = document.createElement('span');
    b.className = 'badge ok';
    b.textContent = '已答过 · 秒出缓存';
    head.appendChild(b);
  }

  const body = document.createElement('div');
  body.className = kind === 'error' ? 'error-box' : 'entry-body md';

  wrap.appendChild(head);
  wrap.appendChild(body);
  els.answer.appendChild(wrap);

  const entry: Entry = {
    kind,
    el: wrap,
    body,
    text,
    done: !opts.streaming,
  };

  if (kind === 'error') {
    body.textContent = text;
  } else {
    entry.renderer = createThrottledRenderer(body, 55);
    entry.renderer.update(text, !!opts.streaming);
  }

  entries.push(entry);
  scrollToEnd();
  return entry;
}

function activeEntry(): Entry | null {
  for (let i = entries.length - 1; i >= 0; i--) {
    if (!entries[i].done) return entries[i];
  }
  return null;
}

function finalizeEntry(text: string): void {
  const e = activeEntry();
  if (!e) return;
  e.done = true;
  e.text = text;
  if (e.kind === 'error') e.body!.textContent = text;
  else {
    e.renderer!.update(text, false);
    e.renderer!.flush();
  }
  scrollToEnd();
}

function setBusy(busy: boolean): void {
  els.btnCancel.classList.toggle('hidden', !busy);
  els.btnSolve.disabled = busy;
  els.btnReanswer.disabled = busy;
  els.btnSend.disabled = busy;
}

function showHint(text: string, kind: 'info' | 'warn' | 'danger' = 'info', ms = 5000): void {
  if (!text) {
    els.hintbar.classList.add('hidden');
    return;
  }
  els.hintbar.className = `hintbar ${kind === 'info' ? '' : kind}`;
  els.hintbar.textContent = text;
  els.hintbar.classList.remove('hidden');
  if (ms > 0) {
    window.clearTimeout((els.hintbar as any).__t);
    (els.hintbar as any).__t = window.setTimeout(() => els.hintbar.classList.add('hidden'), ms);
  }
}

/* ------------------------------- 事件 ------------------------------- */

function handleStream(evt: StreamEvent): void {
  switch (evt.kind) {
    case 'start': {
      activeRequestId = evt.requestId;
      reasoningChars = 0;
      setBusy(true);
      if (evt.scope === 'solve') {
        clearEntries();
        addEntry('assistant', evt.fromCache ? evt.answer || '' : '', {
          cached: !!evt.fromCache,
          streaming: !evt.fromCache,
        });
      } else {
        addEntry('asked', pendingQuestion);
        addEntry('assistant', '', { streaming: true });
      }
      break;
    }
    case 'chunk': {
      if (evt.requestId !== activeRequestId) return;
      const e = activeEntry();
      if (!e) return;
      e.text += evt.delta;
      e.renderer?.update(e.text, true);
      scrollToEnd();
      break;
    }
    case 'reasoning': {
      if (evt.requestId !== activeRequestId) return;
      reasoningChars += evt.delta.length;
      els.meta.textContent = `思考中 ${reasoningChars} 字…`;
      break;
    }
    case 'done': {
      if (evt.requestId !== activeRequestId) return;
      activeRequestId = null;
      finalizeEntry(evt.answer);
      setBusy(false);
      els.meta.textContent = evt.cached ? '来自缓存，没有消耗 token' : '';
      break;
    }
    case 'cancelled': {
      if (evt.requestId !== activeRequestId) return;
      activeRequestId = null;
      const e = activeEntry();
      if (e) finalizeEntry(e.text + '\n\n*（已中断）*');
      setBusy(false);
      break;
    }
    case 'error': {
      if (evt.requestId !== activeRequestId) return;
      activeRequestId = null;
      // 把流到一半的正文收尾，再补一个错误块
      const e = activeEntry();
      if (e) finalizeEntry(e.text);
      const box = addEntry('error', evt.message);
      if (evt.retryable) {
        const row = document.createElement('div');
        row.className = 'retry';
        const btn = document.createElement('button');
        btn.className = 'primary small';
        btn.textContent = '重试';
        btn.onclick = () => {
          void call('solve:retry').catch((err) => toast(err.message, 'error'));
        };
        row.appendChild(btn);
        box.body!.appendChild(row);
      }
      setBusy(false);
      break;
    }
  }
}

function handleMonitor(state: MonitorState | null): void {
  lastMonitor = state;
  if (mode !== 'auto') {
    els.meta.textContent = '';
    return;
  }
  if (!state || !state.running) {
    els.meta.textContent = '自动识别已暂停';
    return;
  }
  if (state.recognizing) {
    els.meta.textContent = '识别中…';
    return;
  }
  const s = Math.min(state.stillMs / 1000, 99);
  els.meta.textContent = `静止 ${s.toFixed(1)}s · 已触发 ${state.triggers} 次`;
}

/* ------------------------------- 初始化 ------------------------------- */

async function refreshSettings(): Promise<void> {
  const p = await call<SettingsPayload>('settings:get');
  hasApiKey = p.hasApiKey;
  els.setupTip.classList.toggle('hidden', hasApiKey);
  if (p.settings.hotkey) {
    els.hotkeyText.textContent = p.settings.hotkey
      .replace(/CommandOrControl|Control|CmdOrCtrl/g, 'Ctrl')
      .replace(/\+/g, ' + ');
  }
}

function setModeUi(m: Mode): void {
  mode = m;
  els.modes.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('active', (b as HTMLElement).dataset.mode === m);
  });
  els.btnPause.classList.toggle('hidden', m !== 'auto');
  els.btnPause.textContent = autoPaused ? '恢复' : '暂停';
  updateCapsuleDot();
  if (m !== 'auto') els.meta.textContent = '';
}

async function init(): Promise<void> {
  const q = new URLSearchParams(location.search);
  // 关掉硬件加速时主进程会改用不透明窗口，这里同步切到降级样式（去圆角）
  if (q.get('opaque') === '1') document.body.classList.add('opaque');
  const collapsed = q.get('collapsed') === '1';
  applyCollapsed(collapsed);

  await refreshSettings();

  const m = await call<{ mode: Mode; paused: boolean }>('mode:get');
  autoPaused = m.paused;
  setModeUi(m.mode);

  const mon = await call<MonitorState | null>('monitor:state');
  handleMonitor(mon);

  /* ---- 主进程事件 ---- */
  on('evt:stream', (e: StreamEvent) => handleStream(e));
  on('evt:status', (p: StatusPayload) => setStatusBadge(p.status, p.text));
  on('evt:mode', (p: { mode: Mode }) => setModeUi(p.mode));
  on('evt:monitor', (p: MonitorState | null) => handleMonitor(p));
  on('evt:settings', () => void refreshSettings());
  on('evt:shortcut-hint', (p: { ok: boolean; text: string }) =>
    showHint(p.text, p.ok ? 'info' : 'warn', 6000)
  );

  /* ---- 模式切换 ---- */
  els.modes.querySelectorAll('button').forEach((b) => {
    (b as HTMLButtonElement).onclick = async () => {
      const target = (b as HTMLElement).dataset.mode as Mode;
      if (target === 'shot') {
        setModeUi('shot');
        await call('mode:set', { mode: 'shot' });
        await call('pick:open');
        return;
      }
      await call('mode:set', { mode: target });
      const s = await call<{ mode: Mode; paused: boolean }>('mode:get');
      autoPaused = s.paused;
      setModeUi(s.mode);
      void call<MonitorState | null>('monitor:state').then(handleMonitor);
    };
  });

  /* ---- 按钮 ---- */
  els.btnSolve.onclick = () => {
    if (!hasApiKey) {
      void call('ui:openSettings');
      showHint('先填上 API Key 才能识别', 'warn');
      return;
    }
    void call('solve:manual').catch((e) => toast(e.message, 'error'));
  };

  els.btnPause.onclick = async () => {
    await call('monitor:toggle');
    const s = await call<{ mode: Mode; paused: boolean }>('mode:get');
    autoPaused = s.paused;
    setModeUi(s.mode);
    handleMonitor(await call<MonitorState | null>('monitor:state'));
  };

  els.btnReanswer.onclick = () =>
    void call('solve:reanswer').catch((e) => toast(e.message, 'error'));

  els.btnCancel.onclick = () => void call('solve:cancel');

  els.btnSettings.onclick = () => void call('ui:openSettings');
  els.btnGoSettings.onclick = () => void call('ui:openSettings');
  els.btnNotebook.onclick = () => void call('ui:openNotebook');
  els.btnHide.onclick = () => void call('window:hide');

  els.btnCollapse.onclick = () => {
    applyCollapsed(true);
    void call('window:collapse', { collapsed: true });
  };
  els.capsule.onclick = (e) => {
    // 拖动小胶囊时不要误触展开
    if (dragged) return;
    applyCollapsed(false);
    void call('window:collapse', { collapsed: false });
  };

  /* ---- 追问 ---- */
  const send = async () => {
    const text = els.ask.value.trim();
    if (!text) return;
    if (!hasApiKey) {
      void call('ui:openSettings');
      showHint('先填上 API Key 才能追问', 'warn');
      return;
    }
    pendingQuestion = text;
    els.ask.value = '';
    autoGrow();
    try {
      await call('chat:send', { text });
    } catch (e: any) {
      toast(e?.message || '发送失败', 'error');
    }
  };

  els.btnSend.onclick = () => void send();
  els.ask.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      void send();
    }
  });
  els.ask.addEventListener('input', autoGrow);

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (activeRequestId) void call('solve:cancel');
    }
  });

  /* ---- 拖拽调整大小 ---- */
  setupResize();

  /* ---- 折叠胶囊的拖动区分 ---- */
  setupCapsuleDrag();

  // 主进程可能在渲染前就发过状态，这里再拉一次兜底
  void refreshSettings();
}

function autoGrow(): void {
  els.ask.style.height = 'auto';
  els.ask.style.height = `${Math.min(88, els.ask.scrollHeight)}px`;
}

function applyCollapsed(collapsed: boolean): void {
  document.body.classList.toggle('collapsed-mode', collapsed);
  els.card.classList.toggle('hidden', collapsed);
  els.capsule.classList.toggle('hidden', !collapsed);
}

/* ------------------------- 自定义缩放手柄 ------------------------- */

function setupResize(): void {
  let startX = 0;
  let startY = 0;
  let startW = 0;
  let startH = 0;
  let active = false;

  els.grip.addEventListener('mousedown', (e) => {
    e.preventDefault();
    active = true;
    startX = e.screenX;
    startY = e.screenY;
    startW = window.innerWidth;
    startH = window.innerHeight;
    document.body.classList.add('resizing');
  });

  window.addEventListener('mousemove', (e) => {
    if (!active) return;
    const w = startW + (e.screenX - startX);
    const h = startH + (e.screenY - startY);
    void call('window:resize', { width: w, height: h });
  });

  window.addEventListener('mouseup', () => {
    if (!active) return;
    active = false;
    document.body.classList.remove('resizing');
  });
}

/* 小胶囊：手动实现拖动（用位移量区分「点击展开」和「拖动」） */
let dragged = false;

function setupCapsuleDrag(): void {
  let dragging = false;

  els.capsule.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    dragging = true;
    dragged = false;
  });

  window.addEventListener('mousemove', (e) => {
    if (!dragging) return;
    const dx = e.movementX || 0;
    const dy = e.movementY || 0;
    if (!dragged && Math.abs(dx) + Math.abs(dy) < 2) return;
    dragged = true;
    void call('window:moveBy', { dx, dy });
  });

  window.addEventListener('mouseup', () => {
    dragging = false;
  });
}

void init();
