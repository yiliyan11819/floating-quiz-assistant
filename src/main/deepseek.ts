/**
 * DeepSeek 多模态 API 客户端（OpenAI 兼容 Chat Completions + SSE 流式）。
 *
 * 关键约定（需求 §6）：
 *   - POST {baseUrl}/chat/completions
 *   - 图片以 base64 dataURL 放进 content[].image_url
 *   - 解析 SSE 的 `data:` 行，增量回调
 *   - 401 → 提示检查 Key；429 / 5xx → 指数退避重试 ≤ 3 次
 *   - 超时可中断（AbortController）
 *
 * 工程说明：这里用「空闲超时」而不是「整体超时」——
 * 首字节 30s 内必须到，之后每收到一段就重置 60s 计时器。
 * 这样长解答不会被 60s 硬切，而卡死仍能及时断开。
 */

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content:
    | string
    | Array<
        | { type: 'text'; text: string }
        | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } }
      >;
}

export interface StreamCallbacks {
  onChunk: (delta: string) => void;
  /** 思考过程增量（部分模型/reasoning_effort 下才有） */
  onReasoning?: (delta: string) => void;
}

export interface StreamOptions {
  apiKey: string;
  baseUrl: string;
  model: string;
  messages: ChatMessage[];
  signal?: AbortSignal;
  /** 额外并入请求体的参数（高级设置） */
  extraBody?: Record<string, unknown>;
  /** 首字节超时 */
  firstByteTimeoutMs?: number;
  /** 相邻两段之间的空闲超时 */
  idleTimeoutMs?: number;
  maxRetries?: number;
}

export class ApiError extends Error {
  status?: number;
  retryable: boolean;
  constructor(message: string, status?: number, retryable = false) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.retryable = retryable;
  }
}

const RETRY_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 522, 524]);

function buildUrl(baseUrl: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  // 允许用户直接填 .../v1 或 .../chat/completions
  if (/\/chat\/completions$/.test(base)) return base;
  return `${base}/chat/completions`;
}

function joinUrl(baseUrl: string, path: string): string {
  const base = baseUrl.replace(/\/+$/, '');
  if (base.endsWith(path)) return base;
  return `${base}${path}`;
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    if (signal) {
      const onAbort = () => {
        clearTimeout(t);
        reject(new DOMException('Aborted', 'AbortError'));
      };
      if (signal.aborted) onAbort();
      else signal.addEventListener('abort', onAbort, { once: true });
    }
  });
}

/** 把人话错误信息抽出来 */
async function extractErrorMessage(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const j = JSON.parse(text) as { error?: { message?: string }; message?: string };
      detail = j.error?.message || j.message || text;
    } catch {
      detail = text;
    }
  } catch {
    /* ignore */
  }
  detail = (detail || '').slice(0, 300);

  if (res.status === 401) return `API Key 无效或已过期（401）。请在设置里检查 Key。${detail ? ' 详情：' + detail : ''}`;
  if (res.status === 402) return `账户余额不足（402）。请到 DeepSeek 控制台充值。${detail ? ' 详情：' + detail : ''}`;
  if (res.status === 403) return `无权访问该模型（403），请在设置里确认模型名。${detail ? ' 详情：' + detail : ''}`;
  if (res.status === 404) return `接口地址不存在（404）。请检查 Base URL 与模型名。${detail ? ' 详情：' + detail : ''}`;
  if (res.status === 429) return `请求过于频繁或超出配额（429），正在重试…${detail ? ' 详情：' + detail : ''}`;
  if (res.status >= 500) return `服务端错误（${res.status}），正在重试…${detail ? ' 详情：' + detail : ''}`;
  return `请求失败（${res.status}）${detail ? '：' + detail : ''}`;
}

/**
 * 流式调用。会持续回调 onChunk，返回完整答案。
 * 失败会抛出 ApiError。
 */
export async function streamChat(opts: StreamOptions, cb: StreamCallbacks): Promise<string> {
  const {
    apiKey,
    baseUrl,
    model,
    messages,
    signal,
    extraBody,
    firstByteTimeoutMs = 30000,
    idleTimeoutMs = 60000,
    maxRetries = 3,
  } = opts;
  if (!apiKey) {
    throw new ApiError('还没有配置 API Key。点右上角 ⚙ 进入设置填写。', undefined, false);
  }

  const body: Record<string, unknown> = {
    model,
    stream: true,
    messages,
    ...(extraBody || {}),
  };

  let attempt = 0;
  let emitted = false;

  for (;;) {
    attempt++;
    const ctl = new AbortController();
    let timedOut = false;
    let idleTimer: NodeJS.Timeout | null = null;
    let hardTimer: NodeJS.Timeout | null = null;

    const onOuterAbort = () => ctl.abort();
    if (signal) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      signal.addEventListener('abort', onOuterAbort, { once: true });
    }

    const armIdle = (ms: number) => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, ms);
    };

    try {
      hardTimer = setTimeout(() => {
        timedOut = true;
        ctl.abort();
      }, firstByteTimeoutMs);

      const res = await fetch(buildUrl(baseUrl), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
          Accept: 'text/event-stream',
        },
        body: JSON.stringify(body),
        signal: ctl.signal,
      });

      if (!res.ok) {
        const msg = await extractErrorMessage(res);
        const retryable = RETRY_STATUS.has(res.status);
        if (retryable && attempt <= maxRetries) {
          await sleep(backoffMs(attempt), signal);
          continue;
        }
        throw new ApiError(msg, res.status, retryable);
      }

      if (!res.body) throw new ApiError('服务端返回了空响应体', undefined, true);

      if (hardTimer) {
        clearTimeout(hardTimer);
        hardTimer = null;
      }
      armIdle(idleTimeoutMs);

      const reader = res.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let full = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        armIdle(idleTimeoutMs);
        buffer += decoder.decode(value, { stream: true });

        // SSE 以空行分隔事件
        let nl: number;
        while ((nl = buffer.indexOf('\n')) !== -1) {
          const rawLine = buffer.slice(0, nl).replace(/\r$/, '');
          buffer = buffer.slice(nl + 1);
          if (!rawLine || rawLine.startsWith(':')) continue;
          if (!rawLine.startsWith('data:')) continue;

          const payload = rawLine.slice(5).trim();
          if (payload === '[DONE]') continue;

          let json: any;
          try {
            json = JSON.parse(payload);
          } catch {
            continue; // 半截 JSON（跨 chunk 拆分）不该发生，但防御一下
          }

          // 有些兼容实现把错误塞在流里
          if (json.error) {
            throw new ApiError(json.error.message || '服务端在流中返回错误', undefined, false);
          }

          const delta = json.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.reasoning_content === 'string' && delta.reasoning_content) {
            cb.onReasoning?.(delta.reasoning_content);
          }
          const piece = typeof delta.content === 'string' ? delta.content : '';
          if (piece) {
            emitted = true;
            full += piece;
            cb.onChunk(piece);
          }
        }
      }

      return full;
    } catch (err: any) {
      const isAbort = err?.name === 'AbortError' || ctl.signal.aborted;
      if (isAbort) {
        if (timedOut) {
          if (!emitted && attempt <= maxRetries) {
            await sleep(backoffMs(attempt), signal).catch(() => {});
            continue;
          }
          throw new ApiError(
            emitted ? '回答超时中断了，可以点重试继续。' : '连接超时，请检查网络或稍后重试。',
            undefined,
            true
          );
        }
        // 用户主动取消
        throw new DOMException('Aborted', 'AbortError');
      }

      if (err instanceof ApiError) throw err;

      // 网络层错误（DNS/断网/证书）
      const retryable = attempt <= maxRetries;
      if (retryable) {
        await sleep(backoffMs(attempt), signal).catch(() => {});
        continue;
      }
      throw new ApiError(
        `网络请求失败：${err?.message || '未知错误'}。请检查网络连接后重试。`,
        undefined,
        true
      );
    } finally {
      if (idleTimer) clearTimeout(idleTimer);
      if (hardTimer) clearTimeout(hardTimer);
      signal?.removeEventListener('abort', onOuterAbort);
    }
  }
}

function backoffMs(attempt: number): number {
  const base = Math.min(8000, 800 * Math.pow(2, attempt - 1));
  return base + Math.floor(Math.random() * 300);
}

/** 设置页的「测试连接」：GET /models 校验 Key，几乎不花钱 */
export async function testConnection(
  apiKey: string,
  baseUrl: string
): Promise<{ ok: boolean; message: string; models: string[] }> {
  if (!apiKey) return { ok: false, message: '请先填写 API Key', models: [] };
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), 15000);
  try {
    const res = await fetch(joinUrl(baseUrl, '/models'), {
      headers: { Authorization: `Bearer ${apiKey}` },
      signal: ctl.signal,
    });
    if (!res.ok) {
      return { ok: false, message: await extractErrorMessage(res), models: [] };
    }
    const json: any = await res.json();
    const models: string[] = Array.isArray(json?.data)
      ? json.data.map((m: any) => m?.id).filter((x: any) => typeof x === 'string')
      : [];
    return {
      ok: true,
      message: models.length ? `连接成功，可用模型：${models.slice(0, 8).join('、')}` : '连接成功',
      models,
    };
  } catch (e: any) {
    return {
      ok: false,
      message: e?.name === 'AbortError' ? '连接超时（15s）' : `连接失败：${e?.message || e}`,
      models: [],
    };
  } finally {
    clearTimeout(t);
  }
}
