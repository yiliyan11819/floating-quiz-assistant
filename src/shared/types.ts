/**
 * 主进程 / 渲染进程共享的类型定义。
 */

/** 识别模式：自动读屏 / 手动一键 / 自由截图 */
export type Mode = 'auto' | 'manual' | 'shot';

/** 浮窗状态 */
export type Status = 'idle' | 'reading' | 'answering' | 'error' | 'paused';

/** 答案风格 */
export type AnswerStyle = 'full' | 'hint' | 'step' | 'custom';

/** 屏幕区域（DIP 逻辑像素，左上角为显示器原点） */
export interface Region {
  x: number;
  y: number;
  width: number;
  height: number;
  /** 所属显示器的 id（screen.getAllDisplays()），用于多屏场景 */
  displayId: number;
}

export interface Settings {
  /** API Key —— 落盘前用 Electron safeStorage 加密 */
  apiKey: string;
  baseUrl: string;
  model: string;
  answerStyle: AnswerStyle;
  /** 自定义风格时附加的额外要求 */
  customStylePrompt: string;
  /** 自动模式：画面静止多少毫秒后才触发识别 */
  staticMs: number;
  /** 自动模式：截图轮询间隔 */
  pollMs: number;
  /** 汉明距离阈值（≤ 该值视为同一题） */
  hammingThreshold: number;
  /** 失败后同一画面的冷却时间 */
  cooldownMs: number;
  /** 框选热键 */
  hotkey: string;
  /** 自动模式监控区域 */
  monitorRegion: Region | null;
  /** 开机自启 */
  autoStart: boolean;
  /** 送模型前把长边压到多少像素（0 = 不压缩） */
  maxEdge: number;
  /** JPEG 压缩质量 */
  jpegQuality: number;
  /** 图片 detail 档位：high 最准，low 会先缩到 512×512 更省 token */
  imageDetail: 'high' | 'low' | 'auto';
  /** 追加到请求体的额外 JSON 参数（高级用户） */
  extraBody: string;
  /** 浮窗不透明度 */
  opacity: number;
  /** 是否把发生过追问的题目自动收进错题本 */
  autoCollectAsked: boolean;
}

export const DEFAULT_SETTINGS: Settings = {
  apiKey: '',
  baseUrl: 'https://api.deepseek.com',
  model: 'deepseek-flash',
  answerStyle: 'full',
  customStylePrompt: '',
  staticMs: 1000,
  pollMs: 500,
  hammingThreshold: 4,
  cooldownMs: 30000,
  hotkey: 'Control+Shift+A',
  monitorRegion: null,
  autoStart: false,
  maxEdge: 1600,
  jpegQuality: 85,
  imageDetail: 'high',
  extraBody: '',
  opacity: 1,
  autoCollectAsked: true,
};

/** 缓存的已回答题目 */
export interface CacheEntry {
  id: string;
  /** dHash 的 16 位十六进制字符串（64 bit） */
  hash: string;
  question: string;
  answer: string;
  createdAt: number;
  /** 命中共用次数 */
  hits: number;
}

/** 错题本条目 */
export interface NotebookEntry {
  id: string;
  hash: string;
  question: string;
  answer: string;
  createdAt: number;
  /** 缩略图 dataURL（长边 320） */
  thumb: string;
  askedFollowUp: boolean;
}

/** 一轮对话消息（用于多轮追问） */
export interface ChatTurn {
  role: 'user' | 'assistant';
  text: string;
}

export interface ChatRequest {
  /** 追问文本 */
  text: string;
  /** 当前题目图片 dataURL（首轮用；后续轮次模型可从历史里看到） */
  imageDataUrl?: string;
  /** 当前题目已有答案 */
  currentAnswer?: string;
  /** 已发生的追问历史 */
  history: ChatTurn[];
  /** 题目哈希，用于把追问关联到错题本 */
  questionHash?: string;
  /** 题目缩略图，用于收进错题本 */
  thumb?: string;
}

export type StreamScope = 'solve' | 'chat';

export type StreamEvent =
  | {
      kind: 'start';
      requestId: string;
      scope: StreamScope;
      fromCache?: boolean;
      answer?: string;
      question?: string;
    }
  | { kind: 'chunk'; requestId: string; scope: StreamScope; delta: string }
  | {
      kind: 'reasoning';
      requestId: string;
      scope: StreamScope;
      delta: string;
    }
  | { kind: 'done'; requestId: string; scope: StreamScope; answer: string; cached?: boolean }
  | {
      kind: 'error';
      requestId: string;
      scope: StreamScope;
      message: string;
      retryable: boolean;
    }
  | { kind: 'cancelled'; requestId: string; scope: StreamScope };

export interface MonitorState {
  running: boolean;
  /** 上一帧的感知哈希（用于画面变化检测） */
  lastHash: string | null;
  recognizing: boolean;
  /** 累计触发识别的次数 */
  triggers: number;
  /** 当前静止已持续多久（ms），UI 用来画进度 */
  stillMs: number;
  /** 最近一次失败原因 */
  lastError: string | null;
}

export interface AppInfo {
  version: string;
  platform: string;
  electron: string;
  userDataPath: string;
  /** 是否已配置 API Key */
  configured: boolean;
}
