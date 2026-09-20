/**
 * 错题本：分类筛选与管理 / 列表 / 搜索 / 展开 / 改分类 / 删除 / 导出 Markdown。
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
  catBar: $('catBar'),
};

let all: NotebookEntry[] = [];
let cats: string[] = [];
let keyword = '';
/** null = 全部；'' = 未分类；其它 = 具体分类名 */
let filter: string | null = null;

/* ------------------------------ 分类栏 ------------------------------ */

function chip(label: string, count: number, active: boolean, onclick: () => void): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = `cat-chip${active ? ' active' : ''}`;
  const t = document.createElement('span');
  t.textContent = label;
  const n = document.createElement('em');
  n.textContent = String(count);
  b.appendChild(t);
  b.appendChild(n);
  b.onclick = onclick;
  return b;
}

function catChip(name: string): HTMLElement {
  const wrap = document.createElement('span');
  wrap.className = `cat-chip cat-custom${filter === name ? ' active' : ''}`;
  wrap.dataset.cat = name;

  const label = document.createElement('button');
  label.type = 'button';
  label.className = 'cat-name';
  label.title = `只看「${name}」`;
  label.textContent = name;
  label.onclick = () => {
    filter = name;
    render();
  };
  wrap.appendChild(label);

  const n = document.createElement('em');
  n.textContent = String(all.filter((e) => e.category === name).length);
  wrap.appendChild(n);

  const edit = document.createElement('button');
  edit.type = 'button';
  edit.className = 'cat-op';
  edit.title = '重命名这个分类';
  edit.textContent = '✎';
  edit.onclick = (e) => {
    e.stopPropagation();
    void renameCategory(name);
  };
  wrap.appendChild(edit);

  const del = document.createElement('button');
  del.type = 'button';
  del.className = 'cat-op danger';
  del.title = '删除这个分类（里面的题会移到「未分类」）';
  del.textContent = '×';
  del.onclick = (e) => {
    e.stopPropagation();
    void removeCategory(name);
  };
  wrap.appendChild(del);

  return wrap;
}

/** 就地弹出一个输入框新建分类 */
function createCategory(): void {
  if (el.catBar.querySelector('.cat-edit-input')) return;
  const input = document.createElement('input');
  input.className = 'cat-edit-input';
  input.placeholder = '分类名，回车创建';
  input.maxLength = 24;
  el.catBar.appendChild(input);
  el.catBar.scrollLeft = el.catBar.scrollWidth;
  input.focus();

  let settled = false;
  input.onkeydown = async (e) => {
    if (e.isComposing) return;
    if (e.key === 'Escape') {
      e.preventDefault();
      settled = true;
      input.remove();
      return;
    }
    if (e.key !== 'Enter') return;
    e.preventDefault();
    const name = input.value.trim();
    settled = true;
    input.remove();
    if (!name) return;
    try {
      cats = await call<string[]>('categories:add', { name });
      filter = name;
      render();
      toast(`已新建分类「${name}」`);
    } catch (err: any) {
      toast(err?.message || '创建失败', 'error');
    }
  };
  input.onblur = () => {
    // Enter 那一瞬间也会触发 blur，等一拍再收，别抢在提交前面
    window.setTimeout(() => {
      if (!settled) input.remove();
    }, 150);
  };
}

/** 把某个分类标签就地换成输入框，改名 */
async function renameCategory(name: string): Promise<void> {
  const target = el.catBar.querySelector(`.cat-custom[data-cat="${cssEscape(name)}"]`);
  if (!target) return;
  const input = document.createElement('input');
  input.className = 'cat-edit-input';
  input.value = name;
  input.maxLength = 24;
  target.replaceWith(input);
  input.focus();
  input.select();

  let done = false;
  const finish = async (commit: boolean): Promise<void> => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    if (!commit || !v || v === name) {
      render();
      return;
    }
    try {
      cats = await call<string[]>('categories:rename', { from: name, to: v });
      if (filter === name) filter = v;
      await reload();
      toast(`已重命名为「${v}」`);
    } catch (e: any) {
      toast(e?.message || '重命名失败', 'error');
      render();
    }
  };

  input.onkeydown = (e) => {
    if (e.isComposing) return;
    if (e.key === 'Enter') {
      e.preventDefault();
      void finish(true);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      void finish(false);
    }
  };
  input.onblur = () => void finish(false);
}

async function removeCategory(name: string): Promise<void> {
  const n = all.filter((e) => e.category === name).length;
  const msg = n
    ? `删除分类「${name}」？里面的 ${n} 道题会移到「未分类」，不会被删掉。`
    : `删除空分类「${name}」？`;
  if (!confirm(msg)) return;
  try {
    cats = await call<string[]>('categories:remove', { name });
    if (filter === name) filter = null;
    await reload();
    toast('分类已删除');
  } catch (e: any) {
    toast(e?.message || '删除失败', 'error');
  }
}

function renderCatBar(): void {
  el.catBar.innerHTML = '';
  el.catBar.appendChild(
    chip('全部', all.length, filter === null, () => {
      filter = null;
      render();
    })
  );
  el.catBar.appendChild(
    chip('未分类', all.filter((e) => !e.category).length, filter === '', () => {
      filter = '';
      render();
    })
  );
  for (const c of cats) el.catBar.appendChild(catChip(c));

  const add = document.createElement('button');
  add.type = 'button';
  add.className = 'cat-chip add';
  add.textContent = '＋ 新建分类';
  add.title = '新建一个分类，比如：英语、数学、专业课';
  add.onclick = () => createCategory();
  el.catBar.appendChild(add);
}

/* ------------------------------ 列表 ------------------------------ */

function match(e: NotebookEntry): boolean {
  if (filter === null) {
    /* 全部 */
  } else if (!e.category) {
    if (filter !== '') return false;
  } else if (e.category !== filter) {
    return false;
  }
  if (!keyword) return true;
  const k = keyword.toLowerCase();
  return (
    (e.answer || '').toLowerCase().includes(k) ||
    (e.category || '').toLowerCase().includes(k) ||
    fmtTime(e.createdAt).includes(k)
  );
}

function render(): void {
  const items = all.filter(match);
  el.list.innerHTML = '';
  renderCatBar();

  const scope = filter === null ? '' : `「${filter || '未分类'}」`;
  el.countHint.textContent = keyword
    ? `共 ${all.length} 条，${scope}匹配 ${items.length} 条`
    : scope
      ? `${scope} 共 ${items.length} 条（全部 ${all.length} 条）`
      : `共 ${all.length} 条`;

  if (!all.length) {
    el.emptyState.style.display = '';
    return;
  }
  el.emptyState.style.display = 'none';

  if (!items.length) {
    const d = document.createElement('div');
    d.className = 'empty-state';
    d.textContent = keyword
      ? `没有匹配「${keyword}」的题目`
      : `这个分类下还没有题`;
    el.list.appendChild(d);
    return;
  }

  for (const item of items) el.list.appendChild(renderItem(item));
}

function categorySelect(item: NotebookEntry): HTMLSelectElement {
  const sel = document.createElement('select');
  sel.className = 'cat-select';
  sel.title = '修改这一条的分类';
  const opts: { value: string; label: string }[] = [
    { value: '', label: '未分类' },
    ...cats.map((c) => ({ value: c, label: c })),
  ];
  // 分类被删但条目还留着旧名字时的兜底
  if (item.category && !cats.includes(item.category)) {
    opts.push({ value: item.category, label: item.category });
  }
  for (const o of opts) {
    const el2 = document.createElement('option');
    el2.value = o.value;
    el2.textContent = o.label;
    sel.appendChild(el2);
  }
  sel.value = item.category || '';
  sel.onchange = async () => {
    try {
      await call('notebook:setCategory', { id: item.id, category: sel.value });
      item.category = sel.value;
      render();
      toast(sel.value ? `已归到「${sel.value}」` : '已移到「未分类」');
    } catch (e: any) {
      toast(e?.message || '更新失败', 'error');
    }
  };
  return sel;
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

  const catBadge = document.createElement('span');
  catBadge.className = `badge${item.category ? ' accent' : ''}`;
  catBadge.textContent = item.category || '未分类';
  meta.appendChild(catBadge);

  if (item.askedFollowUp) {
    const b = document.createElement('span');
    b.className = 'badge';
    b.textContent = '追问过';
    meta.appendChild(b);
  }
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
    const text = item.answer || '';
    try {
      await call('clipboard:write', { text });
      toast('答案已复制到剪贴板');
      return;
    } catch {
      /* 落到浏览器 API */
    }
    try {
      await navigator.clipboard.writeText(text);
      toast('答案已复制到剪贴板');
    } catch {
      toast('复制失败', 'error');
    }
  };
  actions.appendChild(btnCopy);

  actions.appendChild(categorySelect(item));

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

/* ------------------------------ 数据 ------------------------------ */

async function reload(): Promise<void> {
  [all, cats] = await Promise.all([
    call<NotebookEntry[]>('notebook:list'),
    call<string[]>('categories:list'),
  ]);
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

/** CSS.escape 的兜底（老 Chromium 没有时用） */
function cssEscape(s: string): string {
  return s.replace(/["\\]/g, '\\$&');
}

async function main(): Promise<void> {
  bind();
  await reload();
}

void main();
