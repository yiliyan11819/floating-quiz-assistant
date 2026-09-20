/**
 * IPC 通道清单 —— preload 白名单与主进程注册表的**唯一来源**。
 *
 * 为什么要单独抽一个文件：
 * 这两边一旦不同步，渲染层会拿到 `No handler registered for 'xxx'` 这种
 * 只在运行时才炸、而且只在点到某个按钮时才炸的错误（收藏、新建分类都栽过）。
 * 现在 preload 从这里生成白名单，主进程注册完还会拿它做一致性自检，
 * 漏注册会在启动时直接报出来。
 */

/** 渲染层 → 主进程（请求/响应） */
export const INVOKE_CHANNELS = [
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

/** 主进程 → 渲染层（广播事件） */
export const EVENT_CHANNELS = [
  'evt:stream',
  'evt:status',
  'evt:monitor',
  'evt:mode',
  'evt:settings',
  'evt:notebook',
  'evt:shortcut-hint',
] as const;

export type InvokeChannel = (typeof INVOKE_CHANNELS)[number];
export type EventChannel = (typeof EVENT_CHANNELS)[number];
