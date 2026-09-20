/**
 * Preload：渲染层唯一的主进程入口。
 * contextIsolation 打开、nodeIntegration 关闭，只暴露白名单方法。
 */
import { contextBridge, ipcRenderer } from 'electron';

const INVOKE_CHANNELS = [
  'settings:get',
  'settings:set',
  'settings:test',
  'settings:reset',
  'app:info',
  'mode:get',
  'mode:set',
  'monitor:toggle',
  'monitor:state',
  'monitor:pickRegion',
  'monitor:clearRegion',
  'solve:manual',
  'solve:region',
  'solve:retry',
  'solve:reanswer',
  'solve:cancel',
  'pick:open',
  'pick:report',
  'pick:backdrop',
  'chat:send',
  'window:collapse',
  'window:hide',
  'window:resize',
  'window:moveBy',
  'window:opacity',
  'cache:list',
  'cache:clear',
  'notebook:list',
  'notebook:add',
  'notebook:remove',
  'notebook:setCategory',
  'notebook:clear',
  'notebook:export',
  'categories:list',
  'categories:add',
  'categories:rename',
  'categories:remove',
  'ui:openSettings',
  'ui:openNotebook',
  'ui:openExternal',
  'clipboard:write',
] as const;

const EVENT_CHANNELS = [
  'evt:stream',
  'evt:status',
  'evt:monitor',
  'evt:mode',
  'evt:settings',
  'evt:notebook',
  'evt:shortcut-hint',
] as const;

type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
type EventChannel = (typeof EVENT_CHANNELS)[number];

const api = {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T> {
    if (!INVOKE_CHANNELS.includes(channel)) {
      return Promise.reject(new Error(`未授权的通道: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload) as Promise<T>;
  },
  on(channel: EventChannel, cb: (payload: any) => void): () => void {
    if (!EVENT_CHANNELS.includes(channel)) return () => {};
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /** 一次性：用于遮罩页等待主进程的初始化参数 */
  once(channel: EventChannel, cb: (payload: any) => void): void {
    if (!EVENT_CHANNELS.includes(channel)) return;
    ipcRenderer.once(channel, (_e, payload) => cb(payload));
  },
};

contextBridge.exposeInMainWorld('api', api);

export type PreloadApi = typeof api;
