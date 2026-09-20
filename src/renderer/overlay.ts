/**
 * 框选遮罩：拖拽画矩形，松手即把区域（DIP，原点为当前显示器左上角）回传主进程。
 */
import { call } from './client';

const params = new URLSearchParams(location.search);
const hintText = decodeURIComponent(params.get('hint') || '拖拽框选要识别的区域');
const displayId = Number(params.get('displayId') || '0');

const dim = document.getElementById('dim') as HTMLElement;
const sel = document.getElementById('sel') as HTMLElement;
const sizeLabel = document.getElementById('sizeLabel') as HTMLElement;
const hintEl = document.getElementById('hint') as HTMLElement;
const cx = document.getElementById('crosshairX') as HTMLElement;
const cy = document.getElementById('crosshairY') as HTMLElement;

(document.getElementById('hintText') as HTMLElement).textContent = hintText;

let dragging = false;
let startX = 0;
let startY = 0;
let moved = false;
let done = false;

const MIN = 8; // 小于这个尺寸认为是不小心点了一下，不算选区

function clampToScreen(v: number, max: number): number {
  return Math.max(0, Math.min(v, max));
}

function updateCrosshair(x: number, y: number): void {
  cx.style.top = `${y}px`;
  cy.style.left = `${x}px`;
}

function drawSelection(x0: number, y0: number, x1: number, y1: number): {
  x: number;
  y: number;
  width: number;
  height: number;
} {
  const x = Math.min(x0, x1);
  const y = Math.min(y0, y1);
  const width = Math.abs(x1 - x0);
  const height = Math.abs(y1 - y0);

  sel.style.left = `${x}px`;
  sel.style.top = `${y}px`;
  sel.style.width = `${width}px`;
  sel.style.height = `${height}px`;

  sizeLabel.textContent = `${Math.round(width)} × ${Math.round(height)}`;
  // 选区太靠下时把尺寸标签翻到上面，避免被屏幕边缘截掉
  sizeLabel.classList.toggle('flip', y + height + 30 > window.innerHeight);

  return { x, y, width, height };
}

function resetState(): void {
  dragging = false;
  moved = false;
  document.body.classList.remove('dragging');
  dim.classList.remove('hidden');
  sel.classList.add('hidden');
  cx.classList.add('hidden');
  cy.classList.add('hidden');
  hintEl.classList.remove('hidden');
}

function finish(region: { x: number; y: number; width: number; height: number } | null): void {
  if (done) return;
  done = true;
  void call('pick:report', {
    region: region
      ? {
          x: Math.round(region.x),
          y: Math.round(region.y),
          width: Math.round(region.width),
          height: Math.round(region.height),
          displayId,
        }
      : null,
  });
}

/* ------------------------------ 交互 ------------------------------ */

window.addEventListener('mousedown', (e) => {
  if (e.button === 2) {
    finish(null);
    return;
  }
  if (e.button !== 0) return;
  dragging = true;
  moved = false;
  startX = e.clientX;
  startY = e.clientY;
  document.body.classList.add('dragging');
  dim.classList.add('hidden');
  hintEl.classList.add('hidden');
  sel.classList.remove('hidden');
  cx.classList.remove('hidden');
  cy.classList.remove('hidden');
  updateCrosshair(e.clientX, e.clientY);
  drawSelection(startX, startY, startX, startY);
});

window.addEventListener('mousemove', (e) => {
  const x = clampToScreen(e.clientX, window.innerWidth);
  const y = clampToScreen(e.clientY, window.innerHeight);

  if (!dragging) {
    if (!moved) updateCrosshair(x, y);
    return;
  }

  if (Math.abs(x - startX) > 2 || Math.abs(y - startY) > 2) moved = true;
  updateCrosshair(x, y);
  drawSelection(startX, startY, x, y);
});

window.addEventListener('mouseup', (e) => {
  if (!dragging) return;
  dragging = false;

  if (!moved) {
    // 只是点了一下，回到待框选状态
    resetState();
    return;
  }

  const rect = drawSelection(startX, startY, e.clientX, e.clientY);
  if (rect.width < MIN || rect.height < MIN) {
    resetState();
    return;
  }
  finish(rect);
});

window.addEventListener('contextmenu', (e) => {
  e.preventDefault();
  finish(null);
});

window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    e.preventDefault();
    finish(null);
  }
});

// 遮罩打开时把键盘焦点抢过来，否则 ESC 收不到
window.focus();
document.addEventListener('DOMContentLoaded', () => window.focus());
