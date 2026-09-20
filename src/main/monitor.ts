/**
 * 自动模式状态机（需求 §5，MUST 按此逻辑实现）。
 *
 *   loop every pollInterval:
 *     img = capture(region);  h = dHash(img)
 *     if hamming(h, lastH) > 4:                 # 画面变化
 *         lastH = h; changedAt = now
 *         if recognizing: abortCurrentRequest()
 *     elif now - changedAt >= staticMs          # 静止满 1 秒
 *          and not answered(h) and not recognizing:
 *         recognizing = true
 *         answer = await askDeepSeek(img, stream)
 *         recognizing = false
 *
 * ★ 相对伪代码补了一处必要的防呆：
 *   伪代码用 answered(h) 防止重复触发，但"图里没有题目"按 §8 是不入缓存的，
 *   那样同一张静态画面会被无限重复识别、无限烧钱。
 *   所以这里额外记 lastHandledHash —— 只要这一帧被处理过（无论结果如何），
 *   在画面再次发生变化之前都不再触发。
 */
import { Region } from '../shared/types';
import { captureRegion, CapturedFrame } from './capture';
import { computeDHash } from './dhash';
import { hammingHex } from './store';

export interface MonitorOptions {
  region: Region;
  pollMs: number;
  staticMs: number;
  hammingThreshold: number;
  cooldownMs: number;
}

export interface MonitorHooks {
  /** 判定为「画面已静止的新题」时调用；抛错表示失败，会进入冷却 */
  onTrigger: (frame: CapturedFrame, hash: string) => Promise<void>;
  /** 画面变化、需要中断正在进行的请求 */
  onInterrupt: () => void;
  onState: () => void;
}

export interface MonitorSnapshot {
  running: boolean;
  lastHash: string | null;
  recognizing: boolean;
  triggers: number;
  /** 当前静止持续了多久（ms），UI 可用来画进度 */
  stillMs: number;
  /** 最近一次失败原因 */
  lastError: string | null;
}

export class AutoMonitor {
  private timer: NodeJS.Timeout | null = null;
  private opts: MonitorOptions;
  private hooks: MonitorHooks;

  private lastFrameHash: string | null = null;
  private lastHandledHash: string | null = null;
  private changedAt = Date.now();
  private recognizing = false;
  private cooldownUntil = 0;
  private cooldownHash: string | null = null;
  private ticking = false;
  private triggers = 0;
  private lastError: string | null = null;

  constructor(opts: MonitorOptions, hooks: MonitorHooks) {
    this.opts = opts;
    this.hooks = hooks;
  }

  isRunning(): boolean {
    return this.timer !== null;
  }

  updateOptions(patch: Partial<MonitorOptions>): void {
    this.opts = { ...this.opts, ...patch };
  }

  start(): void {
    if (this.timer) return;
    this.reset();
    this.timer = setInterval(() => void this.tick(), this.opts.pollMs);
    this.hooks.onState();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.recognizing = false;
    this.hooks.onState();
  }

  /** 画面已经变了（比如用户切了页面），重置静止计时 */
  reset(): void {
    this.lastFrameHash = null;
    this.lastHandledHash = null;
    this.changedAt = Date.now();
    this.cooldownUntil = 0;
    this.cooldownHash = null;
    this.lastError = null;
  }

  /** 由 controller 在识别结束时告知结果 */
  markRecognized(hash: string): void {
    this.lastHandledHash = hash;
    this.recognizing = false;
    this.hooks.onState();
  }

  markFailed(hash: string, message: string): void {
    this.lastError = message;
    this.cooldownHash = hash;
    this.cooldownUntil = Date.now() + this.opts.cooldownMs;
    this.recognizing = false;
    this.hooks.onState();
  }

  snapshot(): MonitorSnapshot {
    return {
      running: this.isRunning(),
      lastHash: this.lastFrameHash,
      recognizing: this.recognizing,
      triggers: this.triggers,
      stillMs: Date.now() - this.changedAt,
      lastError: this.lastError,
    };
  }

  /* ------------------------------------------------------------ */

  private async tick(): Promise<void> {
    if (this.ticking || !this.timer) return;
    this.ticking = true;
    try {
      const frame = await captureRegion(this.opts.region);
      if (!this.timer) return; // 采样期间被停掉了
      const { hash, blank } = computeDHash(frame.image);
      if (!hash) return;

      // §8：全屏独占应用会导致截屏全黑 —— 直接跳过该帧，也不参与静止判定
      if (blank) {
        this.changedAt = Date.now();
        return;
      }

      const now = Date.now();
      const dist = this.lastFrameHash ? hammingHex(hash, this.lastFrameHash) : Infinity;

      if (dist > this.opts.hammingThreshold) {
        // 画面变了
        this.lastFrameHash = hash;
        this.changedAt = now;
        if (this.recognizing) {
          // §5：识别过程中画面发生变化 → abort 当前请求，重新进入静止计时
          this.recognizing = false;
          this.hooks.onInterrupt();
        }
        return;
      }

      // 画面静止，但还没静止够久
      if (now - this.changedAt < this.opts.staticMs) return;

      // 已经在识别了
      if (this.recognizing) return;

      // 这一帧之前已经处理过（有答案的进缓存，没题目的也记着），不重复烧钱
      if (this.lastHandledHash && hammingHex(hash, this.lastHandledHash) <= this.opts.hammingThreshold) {
        return;
      }

      // 失败冷却期内
      if (
        this.cooldownHash &&
        now < this.cooldownUntil &&
        hammingHex(hash, this.cooldownHash) <= this.opts.hammingThreshold
      ) {
        return;
      }

      this.recognizing = true;
      this.triggers++;
      this.hooks.onState();

      // 注意：这里不 await 到底 —— onTrigger 内部自己管理 recognizing 的结束，
      // 因为请求可能被 abort，需要由 controller 决定最终状态。
      void this.hooks.onTrigger(frame, hash).catch(() => {
        /* 细节由 controller 处理 */
      });
    } catch (e: any) {
      // 截图失败（比如切屏、显示器热插拔）不该让整个循环崩掉
      this.changedAt = Date.now();
    } finally {
      this.ticking = false;
    }
  }
}
