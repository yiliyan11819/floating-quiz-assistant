/**
 * 错题本：列表 / 搜索 / 展开 / 删除 / 导出 Markdown。
 */
import { call, toast, fmtTime } from './client';
import { renderMarkdown } from './markdown';
import type { NotebookEntry } from './global';

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;

const el = {
  search: $<HTMLInputElement>('search'),
  btnExport: $<HTMLButtonElement>('btnExport'),
  btnRefresh: $<HTMLButtonElement>('btnRefresh'),
  btnClear: $<HTMLButtonElement>('btnClear'),
  list: $('list'),
  emptyState: $('emptyState'),
  countHint: $('countHint'),
};

let all: NotebookEntry[] = [];
let keyword = '';

function match(e: NotebookEntry): boolean {
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  return (
    (e.answer || '').toLowerCase().includes(k) ||
    fmtTime(e.createdAt).includes(k)
  );
}

function render(): void {
  const items = all.filter(match);
  el.list.innerHTML = '';

  el.countHint.textContent = keyword
    ? `共 ${all.length} 条，匹配 ${items.length} 条`
    : `共 ${all.length} 条`;

  if (!all.length) {
    el.emptyState.style.display = '';
    return;
  }
  el.emptyState.style.display = 'none';

  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.textContent = `没有匹配「${keyword}」的题目`;
    el.list.appendChild(d);
    return;
  }

  for (const item of items) {
    el.list.appendChild(renderItem(item));
  }
}

function renderItem(item: NotebookEntry): HTMLElement {
  const wrap = document.createElement('article');
  wrap.className = 'note';

  /* 缩略图 */
  if (item.thumb) {
    const img = document.createElement('img');
    img.className = 'note-thumb';
    img.src = item.thumb;
    img.alt = '题目截图';
    img.loading = 'lazy';
    wrap.appendChild(img);
  } else {
    const ph = document.createElement('div');
    ph.className = 'note-thumb empty';
    ph.textContent = '无截图';
    wrap.appendChild(ph);
  }

  /* 右侧 */
  const main = document.createElement('div');
  main.className = 'note-main';

  const meta = document.createElement('div');
  meta.className = 'note-meta';
  const t = document.createElement('span');
  t.className = 'mono';
  t.textContent = fmtTime(item.createdAt);
  meta.appendChild(t);
  if (item.askedFollowUp) {
    const b = document.createElement('span');
    b.className = 'badge accent';
    b.textContent = '追问过';
    meta.appendChild(b);
  }
  const hb = document.createElement('span');
  hb.className = 'badge';
  hb.textContent = `哈希 ${item.hash.slice(0, 8)}`;
  meta.appendChild(hb);
  main.appendChild(meta);

  const body = document.createElement('div');
  body.className = 'note-body md';
  body.style.maxHeight = '150px';
  body.innerHTML = renderMarkdown(item.answer || '（无答案）');
  main.appendChild(body);

  const actions = document.createElement('div');
  actions.className = 'note-actions';

  const btnToggle = document.createElement('button');
  btnToggle.className = 'ghost';
  btnToggle.textContent = '展开';
  btnToggle.onclick = () => {
    const expanded = body.style.maxHeight === 'none';
    body.style.maxHeight = expanded ? '150px' : 'none';
    btnToggle.textContent = expanded ? '展开' : '收起';
  };
  actions.appendChild(btnToggle);

  const btnCopy = document.createElement('button');
  btnCopy.className = 'ghost';
  btnCopy.textContent = '复制答案';
  btnCopy.onclick = async () => {
    try {
      await navigator.clipboard.writeText(item.answer || '');
      toast('答案已复制到剪贴板');
    } catch {
      toast('复制失败', 'error');
    }
  };
  actions.appendChild(btnCopy);

  const btnDel = document.createElement('button');
  btnDel.className = 'ghost danger';
  btnDel.textContent = '删除';
  btnDel.onclick = async () => {
    if (!confirm('删除这一条？')) return;
    await call('notebook:remove', { id: item.id });
    all = all.filter((x) => x.id !== item.id);
    render();
    toast('已删除');
  };
  actions.appendChild(btnDel);

  main.appendChild(actions);
  wrap.appendChild(main);
  return wrap;
}

async function reload(): Promise<void> {
  all = await call<NotebookEntry[]>('notebook:list');
  render();
}

function bind(): void {
  el.search.oninput = () => {
    keyword = el.search.value.trim();
    render();
  };
  el.btnRefresh.onclick = () => void reload();
  el.btnExport.onclick = async () => {
    try {
      const p = await call<string | null>('notebook:export');
      if (p) toast('已导出');
    } catch (e: any) {
      toast(e?.message || '导出失败', 'error');
    }
  };
  el.btnClear.onclick = async () => {
    if (!all.length) return;
    if (!confirm(`确定清空全部 ${all.length} 条错题？此操作不可撤销。`)) return;
    await call('notebook:clear');
    await reload();
    toast('错题本已清空');
  };
}

async function main(): Promise<void> {
  bind();
  await reload();
}

void main();
