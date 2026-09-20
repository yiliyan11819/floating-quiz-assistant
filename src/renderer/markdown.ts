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

function renderTex(slot: Slot): string {
  try {
    return katex.renderToString(slot.tex, {
      displayMode: slot.display,
      throwOnError: false,
      errorColor: '#dc2626',
      strict: false,
      trust: false,
      output: 'html',
    });
  } catch {
    return `<code>${escapeHtml(slot.tex)}</code>`;
  }
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

/** 流式渲染节流器：高频 chunk 不重复触发重排 */
export function createThrottledRenderer(
  el: HTMLElement,
  delayMs = 60
): { update: (text: string, streaming?: boolean) => void; flush: () => void } {
  let pending: string | null = null;
  let timer: number | null = null;
  let streaming = false;

  const paint = () => {
    if (pending === null) return;
    const text = pending;
    const isStreaming = streaming;
    pending = null;
    el.innerHTML = renderMarkdown(text) + (isStreaming ? '<span class="caret"></span>' : '');
  };

  return {
    update(text: string, isStreaming = false) {
      pending = text;
      streaming = isStreaming;
      if (timer !== null) return;
      timer = window.setTimeout(() => {
        timer = null;
        paint();
      }, delayMs);
    },
    flush() {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      paint();
    },
  };
}
