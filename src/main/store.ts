/**
 * 本地持久化：设置 / 答案缓存 / 错题本。
 *
 * - 全部落在 app.getPath('userData') 下，纯 JSON，重启不丢。
 * - API Key 用 Electron safeStorage（Windows 走 DPAPI，绑定当前用户账户）加密后落盘，
 *   明文永不写日志、永不出现在任何诊断输出里（需求 §7 MUST）。
 */
import { app, safeStorage } from 'electron';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  Settings,
  DEFAULT_SETTINGS,
  CacheEntry,
  NotebookEntry,
} from '../shared/types';

const ENC_PREFIX = 'enc:v1:';

/** 汉明距离阈值上限（64 位哈希，再高就失去区分能力了） */
export const HAMMING_MAX = 32;

/** 旧版本默认阈值；这一版把它提高，见下面 Store 构造函数里的迁移 */
const LEGACY_HAMMING_DEFAULT = 4;

/** 分类名清洗：去空白、去空串、去重、长度限制 */
export function normalizeCategories(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of list) {
    if (typeof raw !== 'string') continue;
    const name = raw.trim().slice(0, 24);
    if (!name || name === '未分类') continue;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(name);
    if (out.length >= 50) break;
  }
  return out;
}

function userData(): string {
  return app.getPath('userData');
}

function filePath(name: string): string {
  return path.join(userData(), name);
}

/** 原子写：先写临时文件再 rename，避免断电/崩溃留下半截 JSON */
function writeJsonAtomic(file: string, data: unknown): void {
  const tmp = `${file}.${process.pid}.tmp`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string, fallback: T): T {
  try {
    if (!fs.existsSync(file)) return fallback;
    const raw = fs.readFileSync(file, 'utf8');
    if (!raw.trim()) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    // 文件损坏时不要让整个应用挂掉，退回默认值
    return fallback;
  }
}

/* ------------------------------------------------------------------ */
/* 密钥加解密                                                          */
/* ------------------------------------------------------------------ */

function encryptSecret(plain: string): string {
  if (!plain) return '';
  try {
    if (safeStorage.isEncryptionAvailable()) {
      return ENC_PREFIX + safeStorage.encryptString(plain).toString('base64');
    }
  } catch {
    /* 落到下面的明文分支 */
  }
  return plain;
}

function decryptSecret(stored: string): string {
  if (!stored) return '';
  if (!stored.startsWith(ENC_PREFIX)) return stored; // 旧数据/明文兜底
  try {
    const buf = Buffer.from(stored.slice(ENC_PREFIX.length), 'base64');
    return safeStorage.decryptString(buf);
  } catch {
    // 换了电脑 / 换了 Windows 账户后 DPAPI 解不开，视为未配置
    return '';
  }
}

/* ------------------------------------------------------------------ */
/* 设置                                                                */
/* ------------------------------------------------------------------ */

const SETTINGS_FILE = 'settings.json';

/** 落盘形态：apiKey 为密文 */
type StoredSettings = Omit<Settings, 'apiKey'> & { apiKey: string };

export class Store {
  private settings: Settings;
  private cache: CacheEntry[];
  private notebook: NotebookEntry[];

  constructor() {
    const raw = readJson<Partial<StoredSettings>>(filePath(SETTINGS_FILE), {});
    const merged = { ...DEFAULT_SETTINGS, ...raw } as Settings;
    merged.apiKey = decryptSecret((raw.apiKey as string) || '');
    // 订阅号免费额度之外，用户可能填了带空格的 key
    merged.apiKey = merged.apiKey.trim();

    // 兼容更早的配置：那时候阈值默认是 4，偏保守，同一道题稍微变一点就会被
    // 当成新题重新调 API。用户没有手动改过的话，跟着新默认一起抬到 8。
    if (raw.hammingThreshold === LEGACY_HAMMING_DEFAULT) {
      merged.hammingThreshold = DEFAULT_SETTINGS.hammingThreshold;
    }
    merged.hammingThreshold = clamp(merged.hammingThreshold, 0, HAMMING_MAX);
    merged.notebookCategories = normalizeCategories(merged.notebookCategories);
    if (
      merged.lastNotebookCategory &&
      !merged.notebookCategories.includes(merged.lastNotebookCategory)
    ) {
      merged.lastNotebookCategory = '';
    }
    this.settings = merged;

    this.cache = readJson<CacheEntry[]>(filePath('cache.json'), []);
    this.notebook = readJson<NotebookEntry[]>(filePath('notebook.json'), []).map((e) => ({
      ...e,
      // 老数据没有 category 字段
      category: typeof e.category === 'string' ? e.category : '',
    }));
  }

  /* ---------------- settings ---------------- */

  getSettings(): Settings {
    return { ...this.settings };
  }

  /** 只返回脱敏后的 key，供 UI 展示 */
  getRedactedKey(): string {
    const k = this.settings.apiKey;
    if (!k) return '';
    if (k.length <= 10) return `${k.slice(0, 3)}****`;
    return `${k.slice(0, 6)}${'*'.repeat(8)}${k.slice(-4)}`;
  }

  updateSettings(patch: Partial<Settings>): Settings {
    const next: Settings = { ...this.settings, ...patch };
    // 防呆：把几个关键数值夹到合理区间，避免用户手填出 0 或负数把自动模式卡死
    next.staticMs = clamp(next.staticMs, 300, 10000);
    next.pollMs = clamp(next.pollMs, 200, 3000);
    next.hammingThreshold = clamp(next.hammingThreshold, 0, HAMMING_MAX);
    next.cooldownMs = clamp(next.cooldownMs, 5000, 300000);
    next.jpegQuality = clamp(next.jpegQuality, 40, 100);
    next.maxEdge = clamp(next.maxEdge, 0, 4096);
    next.opacity = clamp(next.opacity, 0.4, 1);
    if (patch.notebookCategories !== undefined) {
      next.notebookCategories = normalizeCategories(patch.notebookCategories);
    }
    if (typeof next.lastNotebookCategory !== 'string') next.lastNotebookCategory = '';
    if (
      next.lastNotebookCategory &&
      !next.notebookCategories.includes(next.lastNotebookCategory)
    ) {
      next.lastNotebookCategory = '';
    }
    if (typeof next.apiKey === 'string') next.apiKey = next.apiKey.trim();
    this.settings = next;
    this.persistSettings();
    return this.getSettings();
  }

  private persistSettings(): void {
    const stored: StoredSettings = {
      ...this.settings,
      apiKey: encryptSecret(this.settings.apiKey),
    };
    writeJsonAtomic(filePath(SETTINGS_FILE), stored);
  }

  /* ---------------- 答案缓存 ---------------- */

  getCacheCount(): number {
    return this.cache.length;
  }

  /**
   * 按汉明距离找同题。命中则 hits+1 并返回。
   * 比对的是 64 bit dHash 的十六进制串。
   */
  findCacheByHash(hash: string, threshold: number): CacheEntry | null {
    let best: CacheEntry | null = null;
    let bestDist = Infinity;
    for (const e of this.cache) {
      const d = hammingHex(hash, e.hash);
      if (d <= threshold && d < bestDist) {
        bestDist = d;
        best = e;
      }
    }
    if (best) {
      best.hits += 1;
      this.persistCache();
    }
    return best;
  }

  addCache(hash: string, question: string, answer: string): CacheEntry {
    const entry: CacheEntry = {
      id: crypto.randomUUID(),
      hash,
      question,
      answer,
      createdAt: Date.now(),
      hits: 0,
    };
    this.cache.unshift(entry);
    // 缓存最多留 500 题，避免文件无限膨胀
    if (this.cache.length > 500) this.cache.length = 500;
    this.persistCache();
    return entry;
  }

  listCache(): CacheEntry[] {
    return [...this.cache];
  }

  clearCache(): void {
    this.cache = [];
    this.persistCache();
  }

  private persistCache(): void {
    writeJsonAtomic(filePath('cache.json'), this.cache);
  }

  /* ---------------- 错题本 ---------------- */

  listNotebook(): NotebookEntry[] {
    return [...this.notebook];
  }

  addNotebook(entry: Omit<NotebookEntry, 'id' | 'createdAt'>): NotebookEntry {
    const full: NotebookEntry = {
      ...entry,
      category: typeof entry.category === 'string' ? entry.category : '',
      id: crypto.randomUUID(),
      createdAt: Date.now(),
    };
    this.notebook.unshift(full);
    this.persistNotebook();
    return full;
  }

  /** 同一题（哈希相近）只保留一条，追问时更新旧条目 */
  upsertNotebookByHash(
    hash: string,
    entry: Omit<NotebookEntry, 'id' | 'createdAt'>,
    threshold: number
  ): NotebookEntry {
    const exist = this.notebook.find((e) => hammingHex(e.hash, hash) <= threshold);
    if (exist) {
      exist.answer = entry.answer || exist.answer;
      exist.thumb = entry.thumb || exist.thumb;
      exist.askedFollowUp = exist.askedFollowUp || entry.askedFollowUp;
      // 已经分好类的不要被后来者清掉
      if (!exist.category && entry.category) exist.category = entry.category;
      this.persistNotebook();
      return exist;
    }
    return this.addNotebook(entry);
  }

  /** 已收藏过同一题？返回那一条 */
  findNotebookByHash(hash: string, threshold: number): NotebookEntry | null {
    return this.notebook.find((e) => hammingHex(e.hash, hash) <= threshold) ?? null;
  }

  /** 手动改一条错题的分类 */
  setNotebookCategory(id: string, category: string): NotebookEntry | null {
    const hit = this.notebook.find((e) => e.id === id);
    if (!hit) return null;
    hit.category = typeof category === 'string' ? category.trim() : '';
    this.persistNotebook();
    return hit;
  }

  /* ---------------- 错题本分类 ---------------- */

  listCategories(): string[] {
    return [...this.settings.notebookCategories];
  }

  /** 新建分类；重名或为空返回 null */
  addCategory(name: string): string[] {
    const clean = (name || '').trim().slice(0, 24);
    if (!clean || clean === '未分类') return this.listCategories();
    const next = normalizeCategories([...this.settings.notebookCategories, clean]);
    this.settings.notebookCategories = next;
    this.persistSettings();
    return this.listCategories();
  }

  /** 重命名分类，并同步改掉该分类下所有条目 */
  renameCategory(from: string, to: string): string[] {
    const clean = (to || '').trim().slice(0, 24);
    if (!from || !clean || clean === '未分类') return this.listCategories();
    const list = this.settings.notebookCategories.map((c) => (c === from ? clean : c));
    this.settings.notebookCategories = normalizeCategories(list);
    if (this.settings.lastNotebookCategory === from) {
      this.settings.lastNotebookCategory = clean;
    }
    this.persistSettings();

    let touched = false;
    for (const e of this.notebook) {
      if (e.category === from) {
        e.category = clean;
        touched = true;
      }
    }
    if (touched) this.persistNotebook();
    return this.listCategories();
  }

  /** 删除分类：分类下的题目移回「未分类」，不跟着一起删掉 */
  removeCategory(name: string): string[] {
    if (!name) return this.listCategories();
    this.settings.notebookCategories = this.settings.notebookCategories.filter(
      (c) => c !== name
    );
    if (this.settings.lastNotebookCategory === name) {
      this.settings.lastNotebookCategory = '';
    }
    this.persistSettings();

    let touched = false;
    for (const e of this.notebook) {
      if (e.category === name) {
        e.category = '';
        touched = true;
      }
    }
    if (touched) this.persistNotebook();
    return this.listCategories();
  }

  removeNotebook(id: string): void {
    this.notebook = this.notebook.filter((e) => e.id !== id);
    this.persistNotebook();
  }

  clearNotebook(): void {
    this.notebook = [];
    this.persistNotebook();
  }

  private persistNotebook(): void {
    writeJsonAtomic(filePath('notebook.json'), this.notebook);
  }

  /* ---------------- 窗口几何状态 ---------------- */

  getWindowState(): WindowState {
    return readJson<WindowState>(filePath('window-state.json'), {});
  }

  setWindowState(patch: Partial<WindowState>): void {
    const next = { ...this.getWindowState(), ...patch };
    writeJsonAtomic(filePath('window-state.json'), next);
  }
}

export interface WindowState {
  floatBounds?: { x: number; y: number; width: number; height: number };
  /** 折叠成小胶囊时保存展开前的尺寸 */
  expandedBounds?: { x: number; y: number; width: number; height: number };
  collapsed?: boolean;
}

/* ------------------------------------------------------------------ */
/* 工具                                                                */
/* ------------------------------------------------------------------ */

export function clamp(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

/** 两个 16 位十六进制串之间的汉明距离（popcount of XOR） */
export function hammingHex(a: string, b: string): number {
  if (!a || !b || a.length !== b.length) return Number.MAX_SAFE_INTEGER;
  let dist = 0;
  for (let i = 0; i < a.length; i += 4) {
    const x = (parseInt(a.slice(i, i + 4), 16) ^ parseInt(b.slice(i, i + 4), 16)) & 0xffff;
    dist += popcount16(x);
  }
  return dist;
}

function popcount16(x: number): number {
  x = x - ((x >> 1) & 0x5555);
  x = (x & 0x3333) + ((x >> 2) & 0x3333);
  x = (x + (x >> 4)) & 0x0f0f;
  return (x * 0x0101) >> 8;
}
