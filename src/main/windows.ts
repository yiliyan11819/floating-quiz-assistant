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

const PRELOAD = path.join(__dirname, '..', 'main', 'preload.js');
const RENDERER = path.join(__dirname, '..', 'renderer');

function asset(name: string): string {
  return path.join(__dirname, '..', 'assets', name);
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

  /* ------------------------------------------------------------ */
  /* 浮窗                                                          */
  /* ------------------------------------------------------------ */

  createFloatWindow(bounds: { x: number; y: number; width: number; height: number }, collapsed: boolean): BrowserWindow {
    const win = new BrowserWindow({
      x: bounds.x,
      y: bounds.y,
      width: collapsed ? 64 : bounds.width,
      height: collapsed ? 64 : bounds.height,
      minWidth: 64,
      minHeight: 64,
      frame: false,
      transparent: true,
      backgroundColor: '#00000000',
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
      query: { collapsed: collapsed ? '1' : '0' },
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
   * 打开全屏半透明框选遮罩（每块屏幕一个），返回用户选中的区域（DIP）。
   * 用户按 ESC 或右键取消则返回 null。
   */
  openRegionPicker(hint: string): Promise<Region | null> {
    // 已经有遮罩开着就先关掉
    this.closeOverlays();

    return new Promise<Region | null>((resolve) => {
      this.pickerResolve = resolve;
      this.pickerHint = hint;

      const displays = screen.getAllDisplays();
      for (const d of displays) {
        const win = new BrowserWindow({
          x: d.bounds.x,
          y: d.bounds.y,
          width: d.bounds.width,
          height: d.bounds.height,
          frame: false,
          transparent: true,
          backgroundColor: '#00000000',
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
          query: { hint: encodeURIComponent(hint), displayId: String(d.id) },
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

  /** 由 IPC 调用：用户选完了 */
  finishPick(region: Region | null): void {
    const resolve = this.pickerResolve;
    this.pickerResolve = null;
    if (!resolve) return;

    if (!region) {
      this.closeOverlays();
      resolve(null);
      return;
    }

    // ★ 关键：先隐藏遮罩再截图，否则半透明遮罩会被拍进画面里
    for (const w of this.overlayWins) {
      if (!w.isDestroyed()) w.hide();
    }
    setTimeout(() => {
      this.closeOverlays();
      resolve(region);
    }, 180);
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
