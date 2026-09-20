/**
 * 窗口管理：浮窗 / 框选遮罩 / 设置页 / 错题本页 / 托盘。
 *
 * 浮窗（需求 §F1）：无边框圆角、置顶、skipTaskbar、可拖动可缩放，
 * 用 setAlwaysOnTop(true, 'screen-saver') 保证网课全屏播放时依然可见。
 */
import {
  BrowserWindow,
  screen,
  shell,
  Tray,
  Menu,
  nativeImage,
  app,
  nativeTheme,
} from 'electron';
import path from 'node:path';
import { Region } from '../shared/types';
import { transparentOk } from './gpu';
import { freezeScreens, FrozenScreen } from './capture';

const PRELOAD = path.join(__dirname, '..', 'main', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

function asset(name: string): string {
  return path.join(__dirname, '..', 'assets', name);
}

/**
 * 关掉硬件加速时用的不透明底色。
 * 取值与 common.css 里的 `--bg` 保持一致，这样渲染层把圆角去掉之后
 * 窗口边缘不会出现色差。
 */
function opaqueBackground(): string {
  return nativeTheme.shouldUseDarkColors ? '#1a1d23' : '#ffffff';
}

export class WindowManager {
  floatWin: BrowserWindow | null = null;
  settingsWin: BrowserWindow | null = null;
  notebookWin: BrowserWindow | null = null;
  tray: Tray | null = null;
  private overlayWins: BrowserWindow[] = [];
  private pickerResolve: ((r: Region | null) => void) | null = null;
  private pickerHint = '';
  private quitting = false;
  /** 框选开始前拍下的静止画面，displayId → 帧 */
  private frozen = new Map<number, FrozenScreen>();

  /* ------------------------------------------------------------ */
  /* 浮窗                                                          */
  /* ------------------------------------------------------------ */

  createFloatWindow(bounds: { x: number; y: number; width: number; height: number }, collapsed: boolean): BrowserWindow {
    // 透明窗口依赖 GPU 合成。软件渲染下强行用 transparent 会得到一块纯黑，
    // 而浮窗是无边框 + 置顶 + skipTaskbar，变黑就等于是屏幕上多了个关不掉的黑色方块。
    // 所以关掉硬件加速时改用不透明窗口，并让渲染层去掉圆角。
    const transparent = transparentOk();
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: collapsed ? 64 : bounds.width,
      height: collapsed ? 64 : bounds.height,
      minWidth: 64,
      minHeight: 64,
      frame: false,
      transparent,
      backgroundColor: transparent ? '#00000000' : opaqueBackground(),
      resizable: true,
      maximizable: false,
      minimizable: false,
      fullscreenable: false,
      skipTaskbar: true,
      alwaysOnTop: true,
      hasShadow: false,
      show: false,
      title: '浮窗刷题助手',
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
        backgroundThrottling: false,
      },
    });

    // screen-saver 层级：能压住全屏播放的网课视频
    win.setAlwaysOnTop(true, 'screen-saver');
    win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });

    win.loadFile(path.join(RENDERER, 'float.html'), {
      query: { collapsed: collapsed ? '1' : '0', opaque: transparent ? '0' : '1' },
    });

    win.once('ready-to-show', () => {
      win.show();
      win.setAlwaysOnTop(true, 'screen-saver');
    });

    // 关闭 = 隐藏到托盘，不退出进程（需求 §F1）
    win.on('close', (e) => {
      if (!this.quitting) {
        e.preventDefault();
        win.hide();
      }
    });

    // 卡片外的透明区域不该拦截鼠标
    win.on('blur', () => {
      /* noop，保留钩子 */
    });

    this.floatWin = win;
    return win;
  }

  showFloat(): void {
    if (!this.floatWin) return;
    this.floatWin.show();
    this.floatWin.setAlwaysOnTop(true, 'screen-saver');
  }

  toggleFloat(): void {
    if (!this.floatWin) return;
    if (this.floatWin.isVisible()) this.floatWin.hide();
    else this.showFloat();
  }

  /** 发送到浮窗；窗口没了就静默丢弃 */
  toFloat(channel: string, payload?: unknown): void {
    const w = this.floatWin;
    if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
  }

  broadcast(channel: string, payload?: unknown): void {
    for (const w of [this.floatWin, this.settingsWin, this.notebookWin]) {
      if (w && !w.isDestroyed()) w.webContents.send(channel, payload);
    }
  }

  /* ------------------------------------------------------------ */
  /* 框选遮罩                                                      */
  /* ------------------------------------------------------------ */

  /**
   * 打开全屏框选遮罩（每块屏幕一个），返回用户选中的区域（DIP）。
   * 用户按 ESC 或右键取消则返回 null。
   *
   * ★ 遮罩是「不透明 + 背景是刚拍下的冻结截图」，不是透明窗口。
   *   原因见 capture.ts 里 FrozenScreen 的注释：透明置顶窗口会把播放器的
   *   硬件视频叠加层挤掉，导致框选时视频整块变黑。
   */
  async openRegionPicker(hint: string): Promise<Region | null> {
    // 已经有遮罩开着就先关掉
    this.closeOverlays();
    this.frozen.clear();

    // ★ 顺序很重要：先截图，再开遮罩窗口。
    //   反过来的话窗口会挡住屏幕，截出来就是一片遮罩底色。
    const frames = await freezeScreens();
    if (!frames.length) {
      throw new Error('拿不到屏幕画面，无法框选（可以先用「识别本页」）');
    }
    for (const f of frames) this.frozen.set(f.displayId, f);

    return new Promise<Region | null>((resolve) => {
      this.pickerResolve = resolve;
      this.pickerHint = hint;

      const displays = screen.getAllDisplays().filter((d) => this.frozen.has(d.id));
      for (const d of displays) {
        const win = new BrowserWindow({
          x: d.bounds.x,
          y: d.bounds.y,
          width: d.bounds.width,
          height: d.bounds.height,
          frame: false,
          transparent: false,
          // 截图到位前先铺这个底色，避免闪一下白
          backgroundColor: '#0a0c14',
          resizable: false,
          movable: false,
          minimizable: false,
          maximizable: false,
          fullscreenable: false,
          skipTaskbar: true,
          alwaysOnTop: true,
          hasShadow: false,
          enableLargerThanScreen: true,
          show: false,
          webPreferences: {
            preload: PRELOAD,
            contextIsolation: true,
            nodeIntegration: false,
            sandbox: false,
          },
        });
        win.setAlwaysOnTop(true, 'screen-saver');
        win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
        win.loadFile(path.join(RENDERER, 'overlay.html'), {
          query: {
            hint: encodeURIComponent(hint),
            displayId: String(d.id),
            frozen: '1',
          },
        });
        win.once('ready-to-show', () => {
          win.show();
          win.focus();
        });
        win.on('closed', () => {
          this.overlayWins = this.overlayWins.filter((w) => w !== win);
        });
        this.overlayWins.push(win);
      }

      if (!this.overlayWins.length) resolve(null);
    });
  }

  /** 遮罩页取自己那块屏的冻结截图（当背景） */
  backdropFor(displayId: number): string | null {
    return this.frozen.get(displayId)?.backdrop ?? null;
  }

  /** 拿某块屏的冻结帧，用于从静止画面里裁剪选区 */
  frameFor(displayId: number): FrozenScreen | null {
    return this.frozen.get(displayId) ?? null;
  }

  /** 主进程最后一块屏（拿不到指定屏时的兜底） */
  anyFrame(): FrozenScreen | null {
    for (const f of this.frozen.values()) return f;
    return null;
  }

  /** 用完之后把冻结帧放掉，别一直占着几十 MB 内存 */
  releaseFrozen(): void {
    this.frozen.clear();
  }

  /** 由 IPC 调用：用户选完了 */
  finishPick(region: Region | null): void {
    const resolve = this.pickerResolve;
    this.pickerResolve = null;
    if (!resolve) return;

    // 冻结帧模式下不再需要「先隐藏遮罩再截图」，
    // 选区直接从已经拍好的静止画面里裁。
    this.closeOverlays();
    resolve(region);
  }

  isPickerOpen(): boolean {
    return this.overlayWins.length > 0;
  }

  closeOverlays(): void {
    for (const w of this.overlayWins) {
      if (!w.isDestroyed()) w.destroy();
    }
    this.overlayWins = [];
  }

  /* ------------------------------------------------------------ */
  /* 设置页 / 错题本                                               */
  /* ------------------------------------------------------------ */

  openSettings(): void {
    if (this.settingsWin && !this.settingsWin.isDestroyed()) {
      this.settingsWin.show();
      this.settingsWin.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 760,
      height: 720,
      minWidth: 620,
      minHeight: 520,
      title: '浮窗刷题助手 · 设置',
      icon: asset('icon.png'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f5f6f8',
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(RENDERER, 'settings.html'));
    win.on('closed', () => {
      this.settingsWin = null;
    });
    this.settingsWin = win;
  }

  openNotebook(): void {
    if (this.notebookWin && !this.notebookWin.isDestroyed()) {
      this.notebookWin.show();
      this.notebookWin.focus();
      return;
    }
    const win = new BrowserWindow({
      width: 860,
      height: 700,
      minWidth: 640,
      minHeight: 480,
      title: '浮窗刷题助手 · 错题本',
      icon: asset('icon.png'),
      backgroundColor: nativeTheme.shouldUseDarkColors ? '#14161a' : '#f5f6f8',
      autoHideMenuBar: true,
      webPreferences: {
        preload: PRELOAD,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: false,
      },
    });
    win.setMenuBarVisibility(false);
    win.loadFile(path.join(RENDERER, 'notebook.html'));
    win.on('closed', () => {
      this.notebookWin = null;
    });
    this.notebookWin = win;
  }

  /* ------------------------------------------------------------ */
  /* 托盘                                                          */
  /* ------------------------------------------------------------ */

  createTray(handlers: TrayHandlers): Tray {
    let img = nativeImage.createFromPath(asset('tray.png'));
    if (img.isEmpty()) {
      img = nativeImage.createFromPath(asset('icon.png'));
    }
    const tray = new Tray(img.resize({ width: 16, height: 16 }));
    tray.setToolTip('浮窗刷题助手');

    const rebuild = () => handlers.rebuildMenu();
    tray.on('click', () => handlers.toggleFloat());
    tray.on('double-click', () => handlers.showFloat());
    this.tray = tray;
    rebuild();
    return tray;
  }

  setTrayMenu(items: Electron.MenuItemConstructorOptions[]): void {
    if (!this.tray) return;
    this.tray.setContextMenu(Menu.buildFromTemplate(items));
  }

  markQuitting(): void {
    this.quitting = true;
    // 让浮窗的 close 事件真正关闭
    for (const w of [this.floatWin, this.settingsWin, this.notebookWin]) {
      if (w && !w.isDestroyed()) {
        w.removeAllListeners('close');
      }
    }
  }
}

export interface TrayHandlers {
  rebuildMenu: () => void;
  toggleFloat: () => void;
  showFloat: () => void;
}

/** 用系统默认浏览器打开外部链接 */
export function openExternal(url: string): void {
  if (/^https?:\/\//i.test(url)) void shell.openExternal(url);
}

export { app };
