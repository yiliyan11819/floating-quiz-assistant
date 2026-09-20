/**
 * 答案渲染：Markdown + LaTeX 公式。
 *
 * 流程：先把代码与公式抠出来换成占位符 → marked 转 HTML → 占位符换回
 * （代码原样、公式走 KaTeX）→ 整段过 DOMPurify。
 * 这样公式里的下划线、星号、反斜杠就不会被 markdown 语法误伤。
 */
import { marked } from 'marked';
import katex from 'katex';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

type SlotKind = 'code' | 'math';

interface Slot {
  kind: SlotKind;
  token: string;
  tex: string;
  display: boolean;
}

const PREFIX = 'xMATHPLACEHOLDERx';
const SUFFIX = 'xENDPLACEHOLDERx';
const TOKEN_RE = new RegExp(`${PREFIX}(\\d+)${SUFFIX}`, 'g');

function pushSlot(slots: Slot[], s: Omit<Slot, 'token'>): string {
  const i = slots.length;
  slots.push({ ...s, token: `${PREFIX}${i}${SUFFIX}` });
  return slots[i].token;
}

/**
 * 判断一段 $...$ 里的内容是不是「像公式」。
 * 目的是别把「售价 $5 和 $10」这种人民币美元混写当成行内公式。
 */
function looksLikeMath(tex: string): boolean {
  if (!tex) return false;
  if (tex.length > 800) return false;
  // 含中文/全角标点的一律不当公式
  if (/[\u3000-\u303f\u4e00-\u9fff\uff00-\uffef]/.test(tex)) return false;
  // 至少要有一个 LaTeX 常见的「形状」
  return /[a-zA-Z\\^_{}=+\-*/<>()[\]|!]/.test(tex);
}

/** 先把代码保护起来，避免代码里的 $ 被当成公式 */
function protectCode(src: string, slots: Slot[]): string {
  let out = src.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, (m) =>
    pushSlot(slots, { kind: 'code', tex: m, display: false })
  );
  out = out.replace(/`[^`\n]+`/g, (m) => pushSlot(slots, { kind: 'code', tex: m, display: false }));
  return out;
}

function extractMath(src: string, slots: Slot[]): string {
  let out = src;

  // 块级 $$...$$
  out = out.replace(/\$\$([\s\S]+?)\$\$/g, (m, tex: string) => {
    const t = tex.trim();
    if (!t) return m;
    return `\n\n${pushSlot(slots, { kind: 'math', tex: t, display: true })}\n\n`;
  });

  // 块级 \[...\]
  out = out.replace(/\\\[([\s\S]+?)\\\]/g, (m, tex: string) => {
    const t = tex.trim();
    if (!t) return m;
    return `\n\n${pushSlot(slots, { kind: 'math', tex: t, display: true })}\n\n`;
  });

  // 行内 $...$
  out = out.replace(/\$([^\s$][^$\n]*?)\$/g, (m, tex: string) => {
    const t = tex.trim();
    if (!looksLikeMath(t)) return m;
    return pushSlot(slots, { kind: 'math', tex: t, display: false });
  });

  // 行内 \(...\)
  out = out.replace(/\\\(([\s\S]+?)\\\)/g, (m, tex: string) => {
    const t = tex.trim();
    if (!t) return m;
    return pushSlot(slots, { kind: 'math', tex: t, display: false });
  });

  return out;
}

// 公式渲染结果缓存：同一段 TeX 在流式过程中会被反复重算几十次，
// 缓存下来能省掉绝大部分 KaTeX 开销（这是长答案卡顿的主因之一）。
const TEX_CACHE_LIMIT = 800;
const texCache = new Map<string, string>();

function renderTex(slot: Slot): string {
  const key = `${slot.display ? 'D' : 'I'}\u0000${slot.tex}`;
  const hit = texCache.get(key);
  if (hit !== undefined) return hit;

  let out: string;
  try {
    out = katex.renderToString(slot.tex, {
      displayMode: slot.display,
      throwOnError: false,
      errorColor: '#dc2626',
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch {
    out = `<code>${escapeHtml(slot.tex)}</code>`;
  }
  if (texCache.size >= TEX_CACHE_LIMIT) texCache.clear();
  texCache.set(key, out);
  return out;
}

function restore(html: string, slots: Slot[]): string {
  return html.replace(TOKEN_RE, (_m, idx: string) => {
    const slot = slots[Number(idx)];
    if (!slot) return '';
    return slot.kind === 'code' ? slot.tex : renderTex(slot);
  });
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Markdown 文本 → 安全 HTML */
export function renderMarkdown(src: string): string {
  const text = src ?? '';
  if (!text) return '';

  const slots: Slot[] = [];
  const pre = extractMath(protectCode(text, slots), slots);

  let html: string;
  try {
    html = marked.parse(pre, { async: false }) as string;
  } catch {
    html = `<p>${escapeHtml(pre)}</p>`;
  }

  html = restore(html, slots);

  // 块级公式被 marked 包进 <p> 时拆掉外层，避免多余间距
  html = html.replace(/<p>\s*(<span class="katex-display">[\s\S]*?<\/span>)\s*<\/p>/g, '$1');

  return DOMPurify.sanitize(html, {
    ALLOWED_ATTR: [
      'class', 'style', 'href', 'src', 'alt', 'title', 'aria-hidden',
      'colspan', 'rowspan', 'align', 'target', 'rel',
    ],
    FORBID_TAGS: ['script', 'iframe', 'object', 'embed', 'form', 'input'],
  });
}

/**
 * 按「空行」把正文切成块（围栏代码块内部的空行不算）。
 *
 * 用途：流式渲染时**只重算最后一块**，前面已经定型的块直接复用上次的 HTML。
 * 长答案（一屏几十个公式）以前每来一个 chunk 就要把整篇重新做一遍
 * markdown → KaTeX → DOMPurify，能把渲染线程占满，表现就是「界面卡住不动、
 * 按钮点不动」。改成增量之后，每帧的开销基本只和「最后一段」有关。
 */
function splitBlocks(text: string): string[] {
  const blocks: string[] = [];
  let buf: string[] = [];
  let fence: string | null = null;

  const flush = () => {
    if (buf.length) {
      blocks.push(buf.join('\n'));
      buf = [];
    }
  };

  for (const line of text.split('\n')) {
    const t = line.trim();
    if (t.startsWith('```') || t.startsWith('~~~')) {
      const marker = t.slice(0, 3);
      if (fence === marker) fence = null;
      else if (!fence) fence = marker;
    }
    if (!fence && t === '') {
      flush();
      continue;
    }
    buf.push(line);
  }
  flush();
  return blocks;
}

export interface ThrottledRendererOptions {
  /** 基础节流间隔（毫秒），实际间隔会按单次渲染耗时自适应放大 */
  delayMs?: number;
  /** 真正写进 DOM 之后回调，用来做滚动之类的事 */
  onPaint?: () => void;
}

/**
 * 流式渲染器：按块增量 + 自适应节流。
 *
 * 关键点是**渲染耗时反过来决定下一次的间隔**：某次渲染花了 300ms，
 * 下一次就等 450ms 再画，宁可少刷新几次，也不能把界面占死。
 */
export function createThrottledRenderer(
  el: HTMLElement,
  opts: ThrottledRendererOptions = {}
): {
  update: (text: string, streaming?: boolean) => void;
  flush: () => void;
  /** 丢弃缓存的块（切换题目时调用） */
  reset: () => void;
} {
  const MIN_DELAY = 60;
  const MAX_DELAY = 900;

  const blockCache = new Map<string, string>();
  let pending: string | null = null;
  let timer: number | null = null;
  let streaming = false;
  let delay = Math.max(MIN_DELAY, opts.delayMs ?? 70);
  let lastText: string | null = null;

  const paintStreaming = (text: string): void => {
    const blocks = splitBlocks(text);
    const parts: string[] = [];
    for (let i = 0; i < blocks.length; i++) {
      const isLast = i === blocks.length - 1;
      if (isLast) {
        // 还在长的那一块每次都重算，通常很短
        parts.push(renderMarkdown(blocks[i]));
      } else {
        let html = blockCache.get(blocks[i]);
        if (html === undefined) {
          html = renderMarkdown(blocks[i]);
          if (blockCache.size > 400) blockCache.clear();
          blockCache.set(blocks[i], html);
        }
        parts.push(html);
      }
    }
    el.innerHTML = `${parts.join('')}<span class="caret"></span>`;
  };

  const paintFinal = (text: string): void => {
    el.innerHTML = renderMarkdown(text);
  };

  const paint = (text: string, live: boolean): void => {
    const t0 = performance.now();
    try {
      if (live) paintStreaming(text);
      else paintFinal(text);
    } catch {
      // 渲染崩了也不能白屏，至少把原文放出来
      el.textContent = text;
    }
    const cost = performance.now() - t0;
    // 自适应：这次画得慢，下次就少画几次
    delay = Math.min(MAX_DELAY, Math.max(MIN_DELAY, Math.round(cost * 1.5)));
    opts.onPaint?.();
  };

  const schedule = (): void => {
    if (timer !== null || pending === null) return;
    timer = window.setTimeout(() => {
      timer = null;
      const text = pending;
      if (text === null) return;
      const live = streaming;
      pending = null;
      if (text === lastText && !live) return;
      lastText = text;
      paint(text, live);
      // 渲染这段时间里可能又攒了新 chunk
      schedule();
    }, delay);
  };

  return {
    update(text: string, isStreaming = false) {
      pending = text;
      streaming = isStreaming;
      if (!isStreaming) lastText = null; // 收尾时强制重画一次完整的
      schedule();
    },
    flush() {
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
      const text = pending;
      pending = null;
      if (text === null) return;
      lastText = text;
      paint(text, false);
    },
    reset() {
      blockCache.clear();
      pending = null;
      lastText = null;
      if (timer !== null) {
        window.clearTimeout(timer);
        timer = null;
      }
    },
  };
}
