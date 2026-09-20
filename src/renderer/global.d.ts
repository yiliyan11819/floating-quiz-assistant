import type {
  Settings,
  StreamEvent,
  MonitorState,
  Mode,
  Status,
  Region,
  CacheEntry,
  NotebookEntry,
} from '../shared/types';

export interface SettingsPayload {
  settings: Omit<Settings, 'apiKey'>;
  hasApiKey: boolean;
  redactedKey: string;
}

export interface AppInfoPayload {
  version: string;
  platform: string;
  electron: string;
  userDataPath: string;
  configured: boolean;
}

export interface TestResult {
  ok: boolean;
  message: string;
  models: string[];
}

export interface StatusPayload {
  status: Status;
  text: string;
  mode: Mode;
}

declare global {
  interface Window {
    api: {
      invoke(
        channel: string,
        payload?: unknown
      ): Promise<{ ok: true; data: any } | { ok: false; error: string }>;
      on(channel: string, cb: (payload: any) => void): () => void;
      once(channel: string, cb: (payload: any) => void): void;
    };
  }
}

export type {
  StreamEvent,
  MonitorState,
  Mode,
  Status,
  Settings,
  Region,
  CacheEntry,
  NotebookEntry,
};
