/**
 * 默认 Prompt 模板（对应需求文档 §11）。
 * 答案风格切换时选取对应的指令段。
 */

export const BASE_PROMPT = `你是解题助手。用户会发来一张题目截图。
- 先完整读题；若图中没有明确题目，只回复"未检测到题目"，不要编造。
- 输出使用 Markdown，公式用 LaTeX（行内 $...$，独立 $$...$$）。
- 用户后续追问时，基于本题上下文回答，不要重新解题（除非用户要求）。`;

export const STYLE_PROMPTS: Record<string, string> = {
  full: '- 【完整解答】给出答案 + 分步骤解析，关键步骤说明理由。',
  hint: '- 【只要提示】只给 2-3 条思路提示，不给最终答案。',
  step: '- 【分步引导】只给第 1 步，用户追问后再继续下一步。',
};

export function buildSystemPrompt(style: string, custom: string): string {
  const parts = [BASE_PROMPT];
  if (style === 'custom') {
    if (custom.trim()) parts.push(`- 【自定义要求】${custom.trim()}`);
  } else {
    const s = STYLE_PROMPTS[style];
    if (s) parts.push(s);
  }
  parts.push('- 除非用户明确要求，否则直接给答案正文，不要加"好的""以下是我的解答"这类客套话。');
  return parts.join('\n');
}

/** 追问轮次里附带的说明，保证模型知道这不是新题 */
export const FOLLOWUP_PREFIX =
  '（这是对上面同一道题的追问，请基于原题上下文回答，不要重新解题。用户问：';
