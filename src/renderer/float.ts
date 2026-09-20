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
  btnCollect: $<HTMLButtonElement>('btnCollect'),
  collectCat: $<HTMLSelectElement>('collectCat'),
  newCat: $<HTMLInputElement>('newCat'),
  quoteBtn: $<HTMLButtonElement>('quoteBtn'),
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

/**
 * 滚到底部。
 *
 * 两个讲究：
 * 1. 用户自己往上翻看前面的步骤时，不要每来一段就把他拽回底部；
 * 2. 用 rAF 合并同一帧里的多次调用，避免一直在触发布局。
 */
let scrollScheduled = false;

function scrollToEnd(force = false): void {
  if (scrollScheduled && !force) return;
  scrollScheduled = true;
  requestAnimationFrame(() => {
    scrollScheduled = false;
    const box = els.answer;
    // 距离底部超过 80px，认为用户正在翻看上面，别打断
    const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
    if (!force && !nearBottom) return;
    box.scrollTop = box.scrollHeight;
  });
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
    // onPaint：只在真正写进 DOM 之后再滚动，避免每个 chunk 都触发布局
    entry.renderer = createThrottledRenderer(body, {
      delayMs: 70,
      onPaint: () => scrollToEnd(),
    });
    entry.renderer.update(text, !!opts.streaming);

    // 解答块给个一键复制（复制的是 Markdown 原文，公式和代码都能带走）
    if (kind === 'assistant') {
      const copy = document.createElement('button');
      copy.type = 'button';
      copy.className = 'copy-btn';
      copy.textContent = '复制';
      copy.title = '复制这一整段（Markdown 原文）';
      copy.onclick = () => void copyText(entry.text);
      head.appendChild(copy);
    }
  }

  entries.push(entry);
  scrollToEnd(true);
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

/* --------------------------- 复制 / 引用 --------------------------- */

/** 复制到剪贴板：先走主进程原生剪贴板，再退浏览器 API，最后 execCommand */
async function copyText(text: string): Promise<void> {
  const t = (text || '').trim();
  if (!t) {
    toast('这一段还是空的');
    return;
  }
  try {
    await call('clipboard:write', { text: t });
    toast('已复制到剪贴板');
    return;
  } catch {
    /* 落到浏览器 API */
  }
  try {
    await navigator.clipboard.writeText(t);
    toast('已复制到剪贴板');
    return;
  } catch {
    /* 落到下面的兜底 */
  }
  const ta = document.createElement('textarea');
  ta.value = t;
  ta.setAttribute('readonly', '');
  ta.style.position = 'fixed';
  ta.style.left = '-9999px';
  document.body.appendChild(ta);
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch {
    ok = false;
  }
  ta.remove();
  toast(ok ? '已复制到剪贴板' : '复制失败，请选中后按 Ctrl+C', ok ? 'info' : 'error');
}

/** 选中答案里的文字 → 把这一段引用进追问框 */
let quoteRange: Range | null = null;

function hideQuoteBtn(): void {
  els.quoteBtn.classList.add('hidden');
  quoteRange = null;
}

function updateQuoteBtn(): void {
  const sel = window.getSelection();
  if (!sel || sel.isCollapsed || !sel.rangeCount) {
    hideQuoteBtn();
    return;
  }
  const text = sel.toString().trim();
  if (text.length < 2) {
    hideQuoteBtn();
    return;
  }
  // 只认答案区里的选择，免得和追问框里选字打架
  const node = sel.anchorNode;
  if (!node || !els.answer.contains(node)) {
    hideQuoteBtn();
    return;
  }

  const range = sel.getRangeAt(0).cloneRange();
  const rect = range.getBoundingClientRect();
  if (!rect.width && !rect.height) {
    hideQuoteBtn();
    return;
  }
  quoteRange = range;

  const W = 118;
  let left = Math.max(8, Math.min(rect.right - W / 2, window.innerWidth - W - 8));
  let top = rect.bottom + 6;
  if (top > window.innerHeight - 34) top = Math.max(6, rect.top - 32);
  els.quoteBtn.style.left = `${left}px`;
  els.quoteBtn.style.top = `${top}px`;
  els.quoteBtn.classList.remove('hidden');
}

function insertQuote(text: string): void {
  const quoted = text
    .split('\n')
    .map((l) => `> ${l}`)
    .join('\n');
  const cur = els.ask.value.replace(/\s+$/, '');
  els.ask.value = cur ? `${cur}\n${quoted}\n` : `${quoted}\n`;
  autoGrow();
  els.ask.focus();
  const end = els.ask.value.length;
  els.ask.setSelectionRange(end, end);
}

/* --------------------------- 错题本收藏 --------------------------- */

let categories: string[] = [];
let defaultCat = '';

function renderCategorySelect(): void {
  const sel = els.collectCat;
  sel.innerHTML = '';
  const items: { value: string; label: string }[] = [
    { value: '', label: '未分类' },
    ...categories.map((c) => ({ value: c, label: c })),
    { value: '__new__', label: '＋ 新建分类…' },
  ];
  for (const it of items) {
    const o = document.createElement('option');
    o.value = it.value;
    o.textContent = it.label;
    sel.appendChild(o);
  }
  sel.value = categories.includes(defaultCat) ? defaultCat : '';
  els.collectCat.title = `收藏到：${sel.value || '未分类'}`;
}

async function setDefaultCat(name: string): Promise<void> {
  defaultCat = name;
  renderCategorySelect();
  try {
    await call('settings:set', { lastNotebookCategory: name });
  } catch {
    /* 只是记住偏好，失败不影响收藏本身 */
  }
}

/** 收藏按钮旁的「新建分类」内联输入 */
let committingCat = false;

async function commitNewCategory(): Promise<void> {
  committingCat = true;
  const name = els.newCat.value.trim();
  els.newCat.classList.add('hidden');
  els.collectCat.classList.remove('hidden');
  try {
    if (!name) {
      renderCategorySelect();
      return;
    }
    categories = await call<string[]>('categories:add', { name });
    await setDefaultCat(name);
    toast(`已新建分类「${name}」`);
  } catch (e: any) {
    toast(e?.message || '新建分类失败', 'error');
    renderCategorySelect();
  } finally {
    committingCat = false;
  }
}

function cancelNewCategory(): void {
  if (committingCat) return;
  els.newCat.value = '';
  els.newCat.classList.add('hidden');
  els.collectCat.classList.remove('hidden');
  renderCategorySelect();
}

/** 收藏成功时按钮闪一下，比 toast 更直观 */
function flashCollected(): void {
  els.btnCollect.classList.add('done');
  els.btnCollect.textContent = '★ 已收藏';
  window.setTimeout(() => {
    els.btnCollect.classList.remove('done');
    els.btnCollect.textContent = '☆ 收藏';
  }, 1400);
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
      // 滚动交给渲染器的 onPaint —— 每个 chunk 都调一次滚动会一直触发布局
      e.renderer?.update(e.text, true);
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
  categories = p.settings.notebookCategories || [];
  defaultCat = p.settings.lastNotebookCategory || '';
  // 正在输入新分类名的时候别把输入框顶掉
  if (els.collectCat && els.newCat.classList.contains('hidden')) renderCategorySelect();
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

  /* ---- 错题本收藏 ---- */
  els.btnCollect.onclick = async () => {
    const chosen = els.collectCat.value;
    if (chosen === '__new__') {
      els.collectCat.classList.add('hidden');
      els.newCat.classList.remove('hidden');
      els.newCat.value = '';
      els.newCat.focus();
      return;
    }
    els.btnCollect.disabled = true;
    // 看门狗：万一主进程那边卡住（或返回了一个永远不 settle 的 Promise），
    // 也保证按钮一定会恢复可点，不会出现「点一次之后就再也点不动」。
    const watchdog = window.setTimeout(() => {
      els.btnCollect.disabled = false;
    }, 8000);
    try {
      const r = await call<{ status: string; message: string }>('notebook:add', {
        category: chosen,
      });
      if (r.status === 'empty') toast(r.message, 'error');
      else {
        toast(r.message);
        flashCollected();
      }
    } catch (e: any) {
      toast(e?.message || '收藏失败', 'error');
    } finally {
      window.clearTimeout(watchdog);
      els.btnCollect.disabled = false;
    }
  };

  els.collectCat.onchange = () => {
    if (els.collectCat.value === '__new__') {
      els.collectCat.classList.add('hidden');
      els.newCat.classList.remove('hidden');
      els.newCat.value = '';
      els.newCat.focus();
      return;
    }
    void setDefaultCat(els.collectCat.value);
  };

  els.newCat.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      void commitNewCategory();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      cancelNewCategory();
    }
  };
  els.newCat.onblur = () => cancelNewCategory();

  /* ---- 复制 / 引用到追问 ---- */
  let quoteTick = false;
  document.addEventListener('selectionchange', () => {
    if (quoteTick) return;
    quoteTick = true;
    requestAnimationFrame(() => {
      quoteTick = false;
      updateQuoteBtn();
    });
  });
  els.answer.addEventListener('scroll', hideQuoteBtn, { passive: true });
  // 保住选区，免得点按钮时选择先被清掉
  els.quoteBtn.addEventListener('mousedown', (e) => e.preventDefault());
  els.quoteBtn.onclick = () => {
    const text = (quoteRange?.toString() || window.getSelection()?.toString() || '').trim();
    hideQuoteBtn();
    if (!text) return;
    insertQuote(text);
    showHint('已引用到追问框，接着写你的问题就行', 'info', 4000);
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
