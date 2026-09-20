/**
 * 主进程入口：应用生命周期、IPC、识别/追问编排、托盘与全局热键。
 */
import {
  app,
  globalShortcut,
  ipcMain,
  screen,
  dialog,
  shell,
  nativeTheme,
} from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

import { Store } from './store';
import { WindowManager } from './windows';
import { GPU_DISABLED, transparentOk } from './gpu';
import { AutoMonitor } from './monitor';
import { captureRegion, encodeForModel, makeThumb, CapturedFrame } from './capture';
import { computeDHash } from './dhash';
import { streamChat, testConnection, ApiError, ChatMessage } from './deepseek';
import { buildSystemPrompt, FOLLOWUP_PREFIX } from '../shared/prompts';
import {
  Settings,
  Region,
  Status,
  Mode,
  StreamEvent,
  ChatTurn,
  DEFAULT_SETTINGS,
} from '../shared/types';

/* ------------------------------------------------------------------ */
/* 单实例：第二次启动时把已有窗口唤到前面                              */
/* ------------------------------------------------------------------ */
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
}

const isDev = process.argv.includes('--dev');

/*
 * 老显卡驱动 / 远程桌面 / 虚拟机里硬件加速可能直接崩掉（GPU 进程退出），
 * 这类机器可以设环境变量 FLOATQUIZ_DISABLE_GPU=1 走软件渲染。
 *
 * ⚠️ 关掉硬件加速会让 `transparent: true` 的窗口变成不透明纯黑
 * （Windows 上没法在软件渲染下合成透明通道），所以窗口那边会同步切成
 * 不透明模式，见 gpu.ts 与 windows.ts 的 transparentOk()。
 */
if (GPU_DISABLED) {
  app.disableHardwareAcceleration();
}

/* ------------------------------------------------------------------ */

const NO_QUESTION_RE = /^[\s"'「『]*未检测到题目[^\u4e00-\u9fa5]{0,3}$/;

interface CurrentQuestion {
  hash: string;
  imageDataUrl: string;
  thumb: string;
  answer: string;
  /** 本地时间 */
  at: number;
}

class Controller {
  store = new Store();
  windows = new WindowManager();
  monitor: AutoMonitor | null = null;

  mode: Mode = 'manual';
  status: Status = 'idle';
  statusText = '待机';

  private currentQuestion: CurrentQuestion | null = null;
  private followUps: ChatTurn[] = [];
  private abort: AbortController | null = null;
  private activeRequestId: string | null = null;
  private activeScope: 'solve' | 'chat' = 'solve';
  /** 供重试使用：上一次的抓取参数 */
  private lastCapture: { region: Region | null; force: boolean } | null = null;
  autoPaused = false;

  /* ---------------- 生命周期 ---------------- */

  bootstrap(): void {
    app.setAppUserModelId('com.floatquiz.helper');

    const ws = this.store.getWindowState();
    const defaults = this.defaultFloatBounds();
    const bounds = ws.floatBounds ?? defaults;

    this.windows.createFloatWindow(sanitizeBounds(bounds, defaults), !!ws.collapsed);
    this.windows.createTray({
      rebuildMenu: () => this.rebuildTrayMenu(),
      toggleFloat: () => this.windows.toggleFloat(),
      showFloat: () => this.windows.showFloat(),
    });

    this.registerHotkey();
    this.syncAutoStart();
    this.applySettingsToRuntime();
    this.trackFloatBounds();
    this.setStatus('idle', '待机');

    // 首次启动且没填 Key → 自动打开设置，别让同学一脸茫然
    if (!this.store.getSettings().apiKey && !process.env.FLOATQUIZ_NO_AUTOSETTINGS) {
      setTimeout(() => this.windows.openSettings(), 700);
    }
  }

  defaultFloatBounds() {
    const primary = screen.getPrimaryDisplay().workAreaSize;
    const width = 380;
    const height = 540;
    return {
      x: Math.max(0, primary.width - width - 40),
      y: Math.max(0, Math.round((primary.height - height) / 2)),
      width,
      height,
    };
  }

  private trackFloatBounds(): void {
    const win = this.windows.floatWin;
    if (!win) return;
    let t: NodeJS.Timeout | null = null;
    const save = () => {
      if (t) clearTimeout(t);
      t = setTimeout(() => {
        if (!win || win.isDestroyed()) return;
        const ws = this.store.getWindowState();
        const b = win.getBounds();
        if (ws.collapsed) {
          // 折叠状态下只记位置，别把 64×64 当成展开尺寸存下来
          this.store.setWindowState({ floatBounds: { ...(ws.expandedBounds ?? b), x: b.x, y: b.y } });
        } else {
          this.store.setWindowState({ floatBounds: b });
        }
      }, 400);
    };
    win.on('moved', save);
    win.on('resized', save);
  }

  /* ---------------- 设置 ---------------- */

  private applySettingsToRuntime(): void {
    const s = this.store.getSettings();
    this.monitor?.updateOptions({
      pollMs: s.pollMs,
      staticMs: s.staticMs,
      hammingThreshold: s.hammingThreshold,
      cooldownMs: s.cooldownMs,
    });
    if (s.monitorRegion) this.monitor?.updateOptions({ region: s.monitorRegion });
    this.windows.floatWin?.setOpacity(s.opacity);
  }

  private registerHotkey(): void {
    globalShortcut.unregisterAll();
    const acc = this.store.getSettings().hotkey || DEFAULT_SETTINGS.hotkey;
    let ok = false;
    try {
      ok = globalShortcut.register(acc, () => void this.startFreeShot());
    } catch {
      ok = false;
    }
    if (!ok) {
      this.windows.toFloat('evt:shortcut-hint', {
        ok: false,
        text: `热键 ${prettyAccel(acc)} 注册失败（可能被别的软件占用），可在设置里换一个。`,
      });
    }
  }

  private syncAutoStart(): void {
    const want = this.store.getSettings().autoStart;
    try {
      app.setLoginItemSettings({ openAtLogin: want, path: process.execPath });
    } catch {
      /* 便携版在某些受限环境不支持，忽略 */
    }
  }

  /* ---------------- 状态广播 ---------------- */

  private setStatus(status: Status, text: string): void {
    this.status = status;
    this.statusText = text;
    this.windows.toFloat('evt:status', { status, text, mode: this.mode });
  }

  private broadcastMonitor(): void {
    this.windows.toFloat('evt:monitor', this.monitor?.snapshot() ?? null);
  }

  setMode(mode: Mode): void {
    this.mode = mode;
    this.windows.toFloat('evt:mode', { mode });
    if (mode === 'auto') {
      if (!this.autoPaused) this.ensureMonitorRunning();
    } else {
      this.monitor?.stop();
    }
    this.rebuildTrayMenu();
    this.broadcastMonitor();
  }

  /* ---------------- 识别链路 ---------------- */

  private newRequestId(): string {
    return crypto.randomUUID();
  }

  private emit(evt: StreamEvent): void {
    this.windows.toFloat('evt:stream', evt);
  }

  abortActive(reason: 'user' | 'interrupt'): void {
    if (!this.abort) return;
    const id = this.activeRequestId;
    const scope = this.activeScope;
    this.abort.abort();
    this.abort = null;
    this.activeRequestId = null;
    if (id) {
      this.emit({ kind: 'cancelled', requestId: id, scope });
    }
  }

  /** 用户点「停止」 */
  cancelActive(): void {
    this.abortActive('user');
    this.setStatus('idle', '已取消');
  }

  /** ① 手动一键识别：截监控区域（没设就整屏） */
  async solveManual(): Promise<void> {
    const s = this.store.getSettings();
    const region = s.monitorRegion ?? this.regionOfFloatDisplay();
    await this.runSolve(region, { force: false });
  }

  /** ② 自由截图：先框选，再只识别选中区域 */
  async startFreeShot(): Promise<void> {
    if (this.windows.isPickerOpen()) return;
    const region = await this.windows.openRegionPicker('拖拽框选要识别的题目区域 · ESC 取消');
    if (!region) return;
    this.mode = 'shot';
    this.windows.toFloat('evt:mode', { mode: 'shot' });
    this.rebuildTrayMenu();
    await this.runSolve(region, { force: false });
  }

  /** ③ 自动模式触发 */
  private async onAutoTrigger(frame: CapturedFrame, hash: string): Promise<void> {
    const reqId = this.newRequestId();
    try {
      await this.runSolve(frame.region, { force: false }, { frame, hash, reqId });
      this.monitor?.markRecognized(hash);
    } catch (e: any) {
      const msg = e?.message || '识别失败';
      this.monitor?.markFailed(hash, msg);
      this.windows.toFloat('evt:status', {
        status: 'error',
        text: `${msg}（${Math.round(this.store.getSettings().cooldownMs / 1000)}s 内不再重试）`,
        mode: this.mode,
      });
    }
    this.broadcastMonitor();
  }

  /** 重试上一次识别（强制重调 API） */
  async retry(force = true): Promise<void> {
    const last = this.lastCapture;
    if (!last) {
      await this.solveManual();
      return;
    }
    await this.runSolve(last.region, { force });
  }

  /** 「重新回答」：对当前题目强制重调 API */
  async reanswer(): Promise<void> {
    if (this.currentQuestion) {
      await this.runSolve(this.lastCapture?.region ?? null, { force: true });
    } else {
      await this.solveManual();
    }
  }

  /**
   * 核心识别流程。
   * @param pre 自动模式已经抓好帧时直接复用，避免重复截图
   */
  private async runSolve(
    region: Region | null,
    opts: { force: boolean },
    pre?: { frame: CapturedFrame; hash: string; reqId: string }
  ): Promise<void> {    // 新识别开始前中断旧的
    if (this.abort) this.abortActive('user');

    const s = this.store.getSettings();
    this.lastCapture = { region, force: opts.force };
    const requestId = pre?.reqId ?? this.newRequestId();
    this.activeScope = 'solve';

    this.setStatus('reading', '正在读题…');

    let frame: CapturedFrame;
    let hash: string;
    if (pre) {
      frame = pre.frame;
      hash = pre.hash;
    } else {
      try {
        frame = await captureRegion(region);
        const h = computeDHash(frame.image);
        if (h.blank) throw new Error('画面全黑（可能被全屏独占应用挡住了），请换个窗口再试');
        hash = h.hash;
      } catch (e: any) {
        this.setStatus('error', e?.message || '截图失败');
        this.emit({
          kind: 'error',
          requestId,
          scope: 'solve',
          message: e?.message || '截图失败',
          retryable: true,
        });
        throw e;
      }
    }

    const thumb = makeThumb(frame.image);

    // ---- 缓存命中（需求 §F3）----
    if (!opts.force) {
      const hit = this.store.findCacheByHash(hash, s.hammingThreshold);
      if (hit) {
        this.currentQuestion = {
          hash,
          imageDataUrl: '',
          thumb,
          answer: hit.answer,
          at: Date.now(),
        };
        this.followUps = [];
        this.emit({
          kind: 'start',
          requestId,
          scope: 'solve',
          fromCache: true,
          answer: hit.answer,
        });
        this.emit({
          kind: 'done',
          requestId,
          scope: 'solve',
          answer: hit.answer,
          cached: true,
        });
        this.setStatus('idle', '已答过（缓存）');
        if (this.mode === 'auto') setTimeout(() => this.setStatus('idle', '等画面静止…'), 1500);
        return;
      }
    }

    // ---- 编码送模型 ----
    let dataUrl: string;
    try {
      const enc = encodeForModel(frame.image, s.maxEdge, s.jpegQuality);
      dataUrl = enc.dataUrl;
    } catch (e: any) {
      const msg = `图片编码失败：${e?.message || e}`;
      this.setStatus('error', msg);
      this.emit({ kind: 'error', requestId, scope: 'solve', message: msg, retryable: true });
      throw new Error(msg);
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(s.answerStyle, s.customStylePrompt) },
      {
        role: 'user',
        content: [
          { type: 'text', text: '请解答这道题。' },
          { type: 'image_url', image_url: { url: dataUrl, detail: s.imageDetail } },
        ],
      },
    ];

    this.emit({ kind: 'start', requestId, scope: 'solve' });
    this.setStatus('answering', '正在解答…');

    const ctl = new AbortController();
    this.abort = ctl;
    this.activeRequestId = requestId;

    let reasoning = '';
    try {
      const answer = await streamChat(
        {
          apiKey: s.apiKey,
          baseUrl: s.baseUrl,
          model: s.model,
          messages,
          signal: ctl.signal,
          extraBody: parseExtraBody(s.extraBody),
        },
        {
          onChunk: (delta) => this.emit({ kind: 'chunk', requestId, scope: 'solve', delta }),
          onReasoning: (delta) => {
            reasoning += delta;
            this.emit({ kind: 'reasoning', requestId, scope: 'solve', delta });
          },
        }
      );

      if (this.abort !== ctl) return; // 已被新请求取代
      this.abort = null;
      this.activeRequestId = null;

      const trimmed = answer.trim();
      const noQuestion = !trimmed || NO_QUESTION_RE.test(trimmed);

      this.currentQuestion = {
        hash,
        imageDataUrl: dataUrl,
        thumb,
        answer: trimmed,
        at: Date.now(),
      };
      this.followUps = [];

      if (noQuestion) {
        // §8：没有题目 → 弱提示展示，不计入缓存
        this.emit({ kind: 'done', requestId, scope: 'solve', answer: trimmed, cached: false });
        this.setStatus('idle', '未检测到题目');
      } else {
        this.store.addCache(hash, '', trimmed);
        this.emit({ kind: 'done', requestId, scope: 'solve', answer: trimmed, cached: false });
        this.setStatus('idle', '已回答');
      }

      if (this.mode === 'auto' && !this.autoPaused) {
        setTimeout(() => {
          if (this.status === 'idle' && this.mode === 'auto') this.setStatus('idle', '等画面静止…');
        }, 1500);
      }
    } catch (e: any) {
      if (this.abort === ctl) {
        this.abort = null;
        this.activeRequestId = null;
      }
      if (e?.name === 'AbortError') {
        // abort 由 abortActive 统一广播 cancelled
        return;
      }
      const message =
        e instanceof ApiError ? e.message : `出错了：${e?.message || '未知错误'}`;
      const retryable = e instanceof ApiError ? e.retryable : true;
      this.setStatus('error', message);
      this.emit({ kind: 'error', requestId, scope: 'solve', message, retryable });
      throw new Error(message);
    }
  }

  /* ---------------- 追问（需求 §F4）---------------- */

  async sendChat(text: string): Promise<void> {
    const s = this.store.getSettings();
    const q = this.currentQuestion;
    const clean = (text || '').trim();
    if (!clean) return;

    if (this.abort) this.abortActive('user');

    const requestId = this.newRequestId();
    this.activeScope = 'chat';

    const messages: ChatMessage[] = [
      { role: 'system', content: buildSystemPrompt(s.answerStyle, s.customStylePrompt) },
    ];

    if (q) {
      // ★ 首次的图片消息保留在历史里，不重复上传（靠服务端上下文缓存省钱）
      messages.push({
        role: 'user',
        content: [
          { type: 'text', text: '请解答这道题。' },
          { type: 'image_url', image_url: { url: q.imageDataUrl, detail: s.imageDetail } },
        ],
      });
      messages.push({ role: 'assistant', content: q.answer });
    }

    for (const t of this.followUps) {
      messages.push({ role: t.role, content: t.text });
    }
    messages.push({ role: 'user', content: `${FOLLOWUP_PREFIX}${clean}）` });

    this.emit({ kind: 'start', requestId, scope: 'chat' });
    this.setStatus('answering', '正在思考…');

    const ctl = new AbortController();
    this.abort = ctl;
    this.activeRequestId = requestId;

    let acc = '';
    try {
      const answer = await streamChat(
        {
          apiKey: s.apiKey,
          baseUrl: s.baseUrl,
          model: s.model,
          messages,
          signal: ctl.signal,
          extraBody: parseExtraBody(s.extraBody),
        },
        {
          onChunk: (delta) => {
            acc += delta;
            this.emit({ kind: 'chunk', requestId, scope: 'chat', delta });
          },
        }
      );

      if (this.abort !== ctl) return;
      this.abort = null;
      this.activeRequestId = null;

      this.followUps.push({ role: 'user', text: clean });
      this.followUps.push({ role: 'assistant', text: answer });

      // 追问过的题自动进错题本（需求 §F6）
      if (q && s.autoCollectAsked) {
        this.store.upsertNotebookByHash(
          q.hash,
          {
            hash: q.hash,
            question: '',
            answer: q.answer + (acc ? `\n\n---\n\n**追问：${clean}**\n\n${answer}` : ''),
            thumb: q.thumb,
            askedFollowUp: true,
          },
          s.hammingThreshold
        );
        this.windows.broadcast('evt:notebook');
      }

      this.emit({ kind: 'done', requestId, scope: 'chat', answer });
      this.setStatus('idle', '已回答');
    } catch (e: any) {
      if (this.abort === ctl) {
        this.abort = null;
        this.activeRequestId = null;
      }
      if (e?.name === 'AbortError') return;
      const message = e instanceof ApiError ? e.message : `出错了：${e?.message || '未知错误'}`;
      this.setStatus('error', message);
      this.emit({
        kind: 'error',
        requestId,
        scope: 'chat',
        message,
        retryable: e instanceof ApiError ? e.retryable : true,
      });
    }
  }

  /* ---------------- 自动模式 ---------------- */

  private ensureMonitorRunning(): void {
    const s = this.store.getSettings();
    if (!s.monitorRegion) {
      this.setStatus('paused', '先框选监控区域');
      void this.pickMonitorRegion().then((r) => {
        if (r) this.ensureMonitorRunning();
        else this.setStatus('idle', '待机');
      });
      return;
    }

    if (!this.monitor) {
      this.monitor = new AutoMonitor(
        {
          region: s.monitorRegion,
          pollMs: s.pollMs,
          staticMs: s.staticMs,
          hammingThreshold: s.hammingThreshold,
          cooldownMs: s.cooldownMs,
        },
        {
          onTrigger: (frame, hash) => this.onAutoTrigger(frame, hash),
          onInterrupt: () => this.abortActive('interrupt'),
          onState: () => this.broadcastMonitor(),
        }
      );
    } else {
      this.monitor.updateOptions({
        region: s.monitorRegion,
        pollMs: s.pollMs,
        staticMs: s.staticMs,
        hammingThreshold: s.hammingThreshold,
        cooldownMs: s.cooldownMs,
      });
    }
    this.monitor.start();
    this.autoPaused = false;
    this.setStatus('idle', '等画面静止…');
    this.broadcastMonitor();
    this.rebuildTrayMenu();
  }

  private pauseAuto(): void {
    this.autoPaused = true;
    this.monitor?.stop();
    this.setStatus('paused', '自动模式已暂停');
    this.broadcastMonitor();
    this.rebuildTrayMenu();
  }

  toggleAutoPause(): void {
    if (this.mode !== 'auto') {
      this.setMode('auto');
      if (this.autoPaused) this.ensureMonitorRunning();
      return;
    }
    if (this.autoPaused) this.ensureMonitorRunning();
    else this.pauseAuto();
  }

  async pickMonitorRegion(): Promise<Region | null> {
    const r = await this.windows.openRegionPicker(
      '拖拽框选要监控的区域（比如刷题网页的题目区）· ESC 取消'
    );
    if (r) {
      this.store.updateSettings({ monitorRegion: r });
      this.monitor?.updateOptions({ region: r });
      this.monitor?.reset();
      this.windows.broadcast('evt:settings', this.getSettingsPayload());
    }
    return r;
  }

  private regionOfFloatDisplay(): Region | null {
    const win = this.windows.floatWin;
    if (!win || win.isDestroyed()) return null;
    const b = win.getBounds();
    const d = screen.getDisplayMatching(b);
    return { x: 0, y: 0, width: d.bounds.width, height: d.bounds.height, displayId: d.id };
  }

  /* ---------------- 托盘 ---------------- */

  private rebuildTrayMenu(): void {
    const items: Electron.MenuItemConstructorOptions[] = [
      { label: '显示 / 隐藏浮窗', click: () => this.windows.toggleFloat() },
      { type: 'separator' },
      {
        label: '自动模式（持续读屏）',
        type: 'radio',
        checked: this.mode === 'auto',
        click: () => this.setMode('auto'),
      },
      {
        label: '手动模式（按一下答一次）',
        type: 'radio',
        checked: this.mode === 'manual',
        click: () => this.setMode('manual'),
      },
      {
        label: '自由截图模式',
        type: 'radio',
        checked: this.mode === 'shot',
        click: () => this.setMode('shot'),
      },
      { type: 'separator' },
      {
        label: this.autoPaused ? '▶ 恢复自动识别' : '⏸ 暂停自动识别',
        enabled: this.mode === 'auto',
        click: () => this.toggleAutoPause(),
      },
      { label: '识别本页', click: () => void this.solveManual() },
      {
        label: `自由截图（${prettyAccel(this.store.getSettings().hotkey)}）`,
        click: () => void this.startFreeShot(),
      },
      { type: 'separator' },
      { label: '重新框选监控区域', click: () => void this.pickMonitorRegion() },
      { label: '设置…', click: () => this.windows.openSettings() },
      { label: '错题本…', click: () => this.windows.openNotebook() },
      { type: 'separator' },
      {
        label: '关于',
        click: () => {
          void dialog.showMessageBox({
            type: 'info',
            title: '关于',
            message: `浮窗刷题助手 v${app.getVersion()}`,
            detail:
              '截图 / 自动读屏 → DeepSeek 多模态模型流式解题。\n\n' +
              'API Key 只保存在本机（系统级加密），不会上传到任何第三方。\n' +
              '项目主页：https://github.com/',
            buttons: ['好'],
          });
        },
      },
      { type: 'separator' },
      {
        label: '退出',
        click: () => {
          this.windows.markQuitting();
          app.quit();
        },
      },
    ];
    this.windows.setTrayMenu(items);
  }

  /* ---------------- IPC 支持 ---------------- */

  getSettingsPayload() {
    const s = this.store.getSettings();
    const { apiKey, ...rest } = s;
    return {
      settings: rest,
      hasApiKey: !!s.apiKey,
      redactedKey: this.store.getRedactedKey(),
    };
  }

  updateSettings(patch: Partial<Settings>) {
    const before = this.store.getSettings();
    const after = this.store.updateSettings(patch);
    this.applySettingsToRuntime();
    if (patch.hotkey && patch.hotkey !== before.hotkey) this.registerHotkey();
    if (patch.autoStart !== undefined && patch.autoStart !== before.autoStart) this.syncAutoStart();
    if (patch.opacity !== undefined) this.windows.floatWin?.setOpacity(after.opacity);

    // 自动模式相关参数变了 → 立刻生效
    if (this.mode === 'auto' && !this.autoPaused) {
      if (after.monitorRegion) this.ensureMonitorRunning();
    }
    const payload = this.getSettingsPayload();
    this.windows.broadcast('evt:settings', payload);
    return payload;
  }

  /* ---------------- 浮窗几何 ---------------- */

  runSolvePublic(region: Region | null, force: boolean): Promise<void> {
    return this.runSolve(region, { force });
  }

  setCollapsed(v: boolean): void {
    const win = this.windows.floatWin;
    if (!win || win.isDestroyed()) return;
    const ws = this.store.getWindowState();
    const b = win.getBounds();
    if (v) {
      this.store.setWindowState({ collapsed: true, floatBounds: b, expandedBounds: b });
      const size = 64;
      win.setMinimumSize(size, size);
      win.setBounds({ x: b.x, y: b.y, width: size, height: size }, false);
    } else {
      const target = ws.expandedBounds ?? { x: b.x, y: b.y, width: 380, height: 540 };
      this.store.setWindowState({ collapsed: false, expandedBounds: undefined });
      win.setMinimumSize(300, 320);
      win.setBounds({ x: b.x, y: b.y, width: target.width, height: target.height }, false);
    }
  }

  resizeFloat(w: number, h: number): { width: number; height: number } {    const win = this.windows.floatWin;
    if (!win || win.isDestroyed()) return { width: 0, height: 0 };
    const b = win.getBounds();
    const width = Math.max(300, Math.min(900, Math.round(w)));
    const height = Math.max(320, Math.min(1100, Math.round(h)));
    win.setBounds({ x: b.x, y: b.y, width, height }, false);
    this.store.setWindowState({ floatBounds: { x: b.x, y: b.y, width, height } });
    return { width, height };
  }

  moveFloatBy(dx: number, dy: number): void {
    const win = this.windows.floatWin;
    if (!win || win.isDestroyed()) return;
    const b = win.getBounds();
    const nx = Math.round(b.x + dx);
    const ny = Math.round(b.y + dy);
    if (nx === b.x && ny === b.y) return;
    win.setBounds({ x: nx, y: ny, width: b.width, height: b.height }, false);
  }

  /* ---------------- 错题本导出 ---------------- */

  async exportNotebook(): Promise<string | null> {
    const list = this.store.listNotebook();
    if (!list.length) {
      await dialog.showMessageBox({ type: 'info', message: '错题本还是空的。', buttons: ['好'] });
      return null;
    }
    const stamp = new Date().toISOString().slice(0, 10);
    const res = await dialog.showSaveDialog({
      title: '导出错题本',
      defaultPath: `错题本-${stamp}.md`,
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (res.canceled || !res.filePath) return null;

    const lines: string[] = [`# 错题本 · 导出时间 ${new Date().toLocaleString('zh-CN')}`, ''];
    list.forEach((e, i) => {
      lines.push(
        `## ${i + 1}. ${new Date(e.createdAt).toLocaleString('zh-CN')}${
          e.askedFollowUp ? ' · 追问过' : ''
        }`
      );
      lines.push('');
      if (e.thumb) {
        lines.push(`![题目截图](${e.thumb})`);
        lines.push('');
      }
      lines.push(e.answer || '（无答案）');
      lines.push('');
      lines.push('---');
      lines.push('');
    });
    fs.writeFileSync(res.filePath, lines.join('\n'), 'utf8');
    const dir = path.dirname(res.filePath);
    const r = await dialog.showMessageBox({
      type: 'info',
      message: `已导出 ${list.length} 道题`,
      detail: res.filePath,
      buttons: ['打开所在文件夹', '好'],
      defaultId: 0,
      cancelId: 1,
    });
    if (r.response === 0) void shell.openPath(dir);
    return res.filePath;
  }
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

function prettyAccel(acc: string): string {
  return (acc || '')
    .replace(/CommandOrControl|Control|CmdOrCtrl/g, 'Ctrl')
    .replace(/\+/g, ' + ');
}

function parseExtraBody(raw: string): Record<string, unknown> | undefined {
  if (!raw || !raw.trim()) return undefined;
  try {
    const j = JSON.parse(raw);
    if (j && typeof j === 'object' && !Array.isArray(j)) return j as Record<string, unknown>;
    return undefined;
  } catch {
    return undefined;
  }
}

function sanitizeBounds(
  b: { x: number; y: number; width: number; height: number },
  fallback: { x: number; y: number; width: number; height: number }
): { x: number; y: number; width: number; height: number } {
  const displays = screen.getAllDisplays();
  const visible = displays.some((d) => {
    const a = d.bounds;
    // 至少要有一块屏幕和窗口有交集，否则说明显示器拔了/分辨率变了
    return (
      b.x < a.x + a.width &&
      b.x + Math.max(b.width, 64) > a.x &&
      b.y < a.y + a.height &&
      b.y + Math.max(b.height, 64) > a.y
    );
  });
  if (!visible || !Number.isFinite(b.x) || !Number.isFinite(b.y)) return fallback;
  return {
    x: Math.round(b.x),
    y: Math.round(b.y),
    width: Math.max(300, Math.round(b.width)),
    height: Math.max(320, Math.round(b.height)),
  };
}

/* ------------------------------------------------------------------ */
/* 启动                                                                */
/* ------------------------------------------------------------------ */

const ctrl = new Controller();

app.on('second-instance', () => {
  ctrl.windows.showFloat();
});

app.whenReady().then(() => {
  nativeTheme.themeSource = 'system';
  registerIpc();
  ctrl.bootstrap();

  screen.on('display-removed', () => {
    // 显示器拔掉了，把浮窗拉回主屏
    const win = ctrl.windows.floatWin;
    if (!win || win.isDestroyed()) return;
    const b = sanitizeBounds(win.getBounds(), ctrl.defaultFloatBounds());
    win.setBounds(b);
  });

  // 冒烟自检：FLOATQUIZ_SMOKE=5000 时启动 5 秒后自动退出，并汇报关键对象是否就绪
  const smoke = Number(process.env.FLOATQUIZ_SMOKE || 0);
  if (smoke > 0) {
    setTimeout(() => {
      const settingsPath = path.join(app.getPath('userData'), 'settings.json');
      const before = ctrl.store.getSettings();
      const hadFile = fs.existsSync(settingsPath);

      // 设置持久化 + 密钥加密往返验证（需求 §7 MUST：Key 不得明文落盘）
      const probe = 'sk-smoke-probe-abcdefghijklmnop';
      let encrypted = false;
      let roundTrip = false;
      let noPlaintext = false;
      try {
        ctrl.store.updateSettings({ apiKey: probe, model: '__smoke__' });
        const raw = fs.readFileSync(settingsPath, 'utf8');
        noPlaintext = !raw.includes(probe) && !raw.includes('sk-smoke');
        encrypted = /"apiKey":\s*"enc:v1:/.test(raw);
        const reopened = new Store().getSettings();
        roundTrip = reopened.apiKey === probe && reopened.model === '__smoke__';
      } catch (e) {
        console.error('[smoke] store error', e);
      } finally {
        ctrl.store.updateSettings({ apiKey: before.apiKey, model: before.model });
        if (!hadFile) {
          try {
            fs.rmSync(settingsPath, { force: true });
          } catch {
            /* ignore */
          }
        }
      }

      const fw = ctrl.windows.floatWin;
      const report = {
        floatWindow: !!fw && !fw.isDestroyed(),
        tray: !!ctrl.windows.tray,
        hotkeyRegistered: globalShortcut.isRegistered(ctrl.store.getSettings().hotkey),
        storeEncrypted: encrypted,
        storeRoundTrip: roundTrip,
        keyNotPlaintextOnDisk: noPlaintext,
        // 窗口模式：硬件加速关掉时不能再用透明窗口（软件渲染下会变纯黑），
        // 这两个字段用来确认降级是否按预期生效
        gpuDisabled: GPU_DISABLED,
        transparentWindows: transparentOk(),
        floatWindowVisible: !!fw && !fw.isDestroyed() && fw.isVisible(),
        floatBounds: fw && !fw.isDestroyed() ? fw.getBounds() : null,
        userDataPath: app.getPath('userData'),
      };
      console.log('[smoke]', JSON.stringify(report));

      // Windows 上 GUI 程序没有控制台，console.log 重定向到文件也是空的，
      // 所以额外写一份 JSON 到临时目录，便于自动化或事后排查。
      try {
        fs.writeFileSync(
          path.join(app.getPath('temp'), 'floatquiz-smoke.json'),
          JSON.stringify(report, null, 2),
          'utf8'
        );
      } catch (e) {
        console.error('[smoke] 写报告失败', e);
      }

      const failed = Object.entries(report).filter(([k, v]) => v === false).map(([k]) => k);
      if (failed.length) console.error('[smoke] FAILED:', failed.join(', '));

      ctrl.windows.markQuitting();
      app.exit(failed.length ? 1 : 0);
    }, smoke);
  }
});

app.on('window-all-closed', () => {
  // 常驻托盘，不跟着窗口退出
});

app.on('before-quit', () => {
  ctrl.windows.markQuitting();
});

app.on('will-quit', () => {
  globalShortcut.unregisterAll();
});

/* ------------------------------------------------------------------ */
/* IPC                                                                 */
/* ------------------------------------------------------------------ */

function registerIpc(): void {
  const h = (channel: string, fn: (payload: any, e: Electron.IpcMainInvokeEvent) => any) => {
    ipcMain.handle(channel, async (e, payload) => {
      try {
        return { ok: true, data: await fn(payload, e) };
      } catch (err: any) {
        return { ok: false, error: err?.message || String(err) };
      }
    });
  };

  h('settings:get', () => ctrl.getSettingsPayload());
  h('settings:set', (patch: Partial<Settings>) => ctrl.updateSettings(patch || {}));
  h('settings:reset', () => {
    const cur = ctrl.store.getSettings();
    return ctrl.updateSettings({
      ...DEFAULT_SETTINGS,
      apiKey: cur.apiKey, // 重置设置不该顺手把 Key 删了
      monitorRegion: null,
    });
  });
  h('settings:test', async (p: { apiKey?: string; baseUrl?: string }) => {
    const s = ctrl.store.getSettings();
    return testConnection(p?.apiKey || s.apiKey, p?.baseUrl || s.baseUrl);
  });

  h('app:info', () => ({
    version: app.getVersion(),
    platform: `${process.platform} ${process.arch}`,
    electron: process.versions.electron,
    userDataPath: app.getPath('userData'),
    configured: !!ctrl.store.getSettings().apiKey,
  }));

  h('mode:get', () => ({ mode: ctrl.mode, paused: ctrl.autoPaused }));
  h('mode:set', (p: { mode: Mode }) => {
    ctrl.setMode(p?.mode || 'manual');
    return { mode: ctrl.mode, paused: ctrl.autoPaused };
  });

  h('monitor:toggle', () => {
    ctrl.toggleAutoPause();
    return ctrl.monitor?.snapshot() ?? null;
  });
  h('monitor:state', () => ctrl.monitor?.snapshot() ?? null);
  h('monitor:pickRegion', () => ctrl.pickMonitorRegion());
  h('monitor:clearRegion', () => {
    ctrl.updateSettings({ monitorRegion: null });
    ctrl.monitor?.stop();
    return null;
  });

  h('solve:manual', () => ctrl.solveManual());
  h('solve:region', (r: Region) => ctrl.runSolvePublic(r, false));
  h('solve:retry', () => ctrl.retry(true));
  h('solve:reanswer', () => ctrl.reanswer());
  h('solve:cancel', () => {
    ctrl.cancelActive();
    return null;
  });

  h('pick:open', () => {
    void ctrl.startFreeShot();
    return null;
  });
  h('pick:report', (payload: { region: Region | null }) => {
    ctrl.windows.finishPick(payload?.region ?? null);
    return null;
  });

  h('chat:send', (p: { text: string }) => ctrl.sendChat(p?.text || ''));

  h('window:collapse', (p: { collapsed: boolean }) => ctrl.setCollapsed(!!p?.collapsed));
  h('window:hide', () => {
    ctrl.windows.floatWin?.hide();
    return null;
  });
  h('window:resize', (p: { width: number; height: number }) => ctrl.resizeFloat(p.width, p.height));
  h('window:opacity', (p: { opacity: number }) => {
    ctrl.updateSettings({ opacity: p.opacity });
    return null;
  });

  h('cache:list', () => ctrl.store.listCache());
  h('cache:clear', () => {
    ctrl.store.clearCache();
    return null;
  });

  h('notebook:list', () => ctrl.store.listNotebook());
  h('notebook:remove', (p: { id: string }) => {
    ctrl.store.removeNotebook(p.id);
    return null;
  });
  h('notebook:clear', () => {
    ctrl.store.clearNotebook();
    return null;
  });
  h('notebook:export', () => ctrl.exportNotebook());

  h('ui:openSettings', () => {
    ctrl.windows.openSettings();
    return null;
  });
  h('ui:openNotebook', () => {
    ctrl.windows.openNotebook();
    return null;
  });
  h('ui:openExternal', (p: { url: string }) => {
    const url = String(p?.url || '');
    if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
    else if (url.startsWith('file://')) {
      const p2 = decodeURIComponent(url.replace(/^file:\/\/\/?/, ''));
      void shell.openPath(p2);
    }
    return null;
  });
}
