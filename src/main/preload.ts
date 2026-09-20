/**
 * Preload：渲染层唯一的主进程入口。
 * contextIsolation 打开、nodeIntegration 关闭，只暴露白名单方法。
 */
import { contextBridge, ipcRenderer } from 'electron';
import {
  INVOKE_CHANNELS,
  EVENT_CHANNELS,
  type InvokeChannel,
  type EventChannel,
} from '../shared/ipc';

// 清单是 readonly 元组，includes 需要放宽成 string[]
const INVOKE_SET = new Set<string>(INVOKE_CHANNELS);
const EVENT_SET = new Set<string>(EVENT_CHANNELS);

const api = {
  invoke<T = unknown>(channel: InvokeChannel, payload?: unknown): Promise<T> {
    if (!INVOKE_SET.has(channel)) {
      return Promise.reject(new Error(`未授权的通道: ${channel}`));
    }
    return ipcRenderer.invoke(channel, payload) as Promise<T>;
  },
  on(channel: EventChannel, cb: (payload: any) => void): () => void {
    if (!EVENT_SET.has(channel)) return () => {};
    const handler = (_e: unknown, payload: any) => cb(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
  /** 一次性：用于遮罩页等待主进程的初始化参数 */
  once(channel: EventChannel, cb: (payload: any) => void): void {
    if (!EVENT_SET.has(channel)) return;
    ipcRenderer.once(channel, (_e, payload) => cb(payload));
  },
};

contextBridge.exposeInMainWorld('api', api);

export type PreloadApi = typeof api;
