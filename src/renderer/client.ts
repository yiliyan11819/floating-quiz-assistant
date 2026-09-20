/**
 * 渲染层与主进程的薄封装。
 * 主进程的 handler 统一返回 { ok, data | error }，这里负责解包与抛错。
 */
export async function call<T = unknown>(channel: string, payload?: unknown): Promise<T> {
  const res = (await window.api.invoke(channel, payload)) as
    | { ok: true; data: T }
    | { ok: false; error: string };
  if (!res || !res.ok) {
    throw new Error((res as any)?.error || '操作失败');
  }
  return (res as { ok: true; data: T }).data;
}

export function on(channel: string, cb: (payload: any) => void): () => void {
  return window.api.on(channel, cb);
}

/** 毫秒 → 人性化时长 */
export function fmtDuration(ms: number): string {
  if (ms < 1000) return `${Math.max(0, Math.round(ms))}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  return `${Math.floor(s / 60)}m${Math.round(s % 60)}s`;
}

export function fmtTime(ts: number): string {
  const d = new Date(ts);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(
    d.getMinutes()
  )}`;
}

/** 简易 toast（各页面共用） */
export function toast(message: string, kind: 'info' | 'error' = 'info', ms = 2600): void {
  let el = document.getElementById('__toast');
  if (!el) {
    el = document.createElement('div');
    el.id = '__toast';
    el.className = '__toast';
    document.body.appendChild(el);
    const style = document.createElement('style');
    style.textContent = `
      .__toast{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);
        background:var(--fg);color:var(--bg);padding:8px 16px;border-radius:999px;
        font-size:12.5px;box-shadow:var(--shadow);z-index:9999;opacity:0;
        transition:opacity .18s ease, transform .18s ease;max-width:80vw;text-align:center;}
      .__toast.show{opacity:.96;transform:translateX(-50%) translateY(-4px);}
      .__toast.error{background:var(--danger);color:#fff;}
    `;
    document.head.appendChild(style);
  }
  el.textContent = message;
  el.className = `__toast${kind === 'error' ? ' error' : ''}`;
  requestAnimationFrame(() => el!.classList.add('show'));
  window.clearTimeout((el as any).__t);
  (el as any).__t = window.setTimeout(() => el!.classList.remove('show'), ms);
}
