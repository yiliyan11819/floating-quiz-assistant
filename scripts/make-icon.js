/**
 * 生成应用图标（不依赖任何图形库，纯手写 PNG 编码）。
 *
 * 造型：圆角紫蓝渐变底 + 白色「答案卡片」 + 琥珀色闪电。
 * 输出：
 *   build/icon.png   512×512（electron-builder 会自动转成 .ico）
 *   build/tray.png    32×32 托盘图标
 *   build/icon.ico        多尺寸 ICO（直接给 electron-builder 用，避免它自己转）
 */
const fs = require('node:fs');
const path = require('node:path');
const zlib = require('node:zlib');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');

/* ----------------------------- 基础绘制 ----------------------------- */

function hex(c) {
  return [
    parseInt(c.slice(1, 3), 16),
    parseInt(c.slice(3, 5), 16),
    parseInt(c.slice(5, 7), 16),
  ];
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

/** 圆角矩形的带符号距离（<0 在内部） */
function sdRoundRect(px, py, cx, cy, hw, hh, r) {
  const qx = Math.abs(px - cx) - (hw - r);
  const qy = Math.abs(py - cy) - (hh - r);
  const ax = Math.max(qx, 0);
  const ay = Math.max(qy, 0);
  return Math.hypot(ax, ay) + Math.min(Math.max(qx, qy), 0) - r;
}

function inPolygon(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i];
    const [xj, yj] = pts[j];
    if (yi > py !== yj > py && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/**
 * 渲染一张图。
 * @param {number} size 输出边长
 * @param {boolean} simple 简化版（托盘小图标：去掉细节线条）
 */
function render(size, simple) {
  const SS = 4; // 4× 超采样做抗锯齿
  const N = size * SS;
  const buf = new Float32Array(N * N * 4); // RGBA 0-255，线性

  const bgA = hex('#5B4BE8');
  const bgB = hex('#8B5CF6');
  const card = hex('#FFFFFF');
  const boltA = hex('#FBBF24');
  const boltB = hex('#F59E0B');
  const lineCol = hex('#8B93A8');

  // 中心与尺寸（按 512 设计稿等比缩放）
  const k = N / 512;
  const cx = 256 * k;
  const cy = 256 * k;
  const outerHW = 236 * k;
  const outerHH = 236 * k;
  const outerR = 92 * k;

  const cardHW = 132 * k;
  const cardHH = 156 * k;
  const cardCX = 226 * k;
  const cardCY = 248 * k;
  const cardR = 26 * k;

  // 闪电多边形（相对 512 设计稿）
  const bolt = [
    [352, 132],
    [258, 268],
    [318, 268],
    [272, 396],
    [372, 244],
    [310, 244],
  ].map(([x, y]) => [x * k, y * k]);

  // 卡片上的三条「文字线」
  const lineW = [72, 58, 46].map((w) => w * k);
  const lineY = [206, 244, 282].map((y) => y * k);
  const lineH = 12 * k;
  const lineX0 = 132 * k;

  for (let y = 0; y < N; y++) {
    for (let x = 0; x < N; x++) {
      const px = x + 0.5;
      const py = y + 0.5;
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;

      // --- 外层圆角方块 + 对角渐变 ---
      const dOuter = sdRoundRect(px, py, cx, cy, outerHW, outerHH, outerR);
      const covOuter = Math.min(1, Math.max(0, 0.5 - dOuter));
      if (covOuter > 0) {
        const t = Math.min(1, Math.max(0, (px / N) * 0.55 + (py / N) * 0.45));
        const c = mix(bgA, bgB, t);
        r = c[0];
        g = c[1];
        b = c[2];
        a = covOuter * 255;
      }

      // --- 白色卡片（带投影感：先画一层半透明深色偏移） ---
      if (covOuter > 0) {
        const dShadow = sdRoundRect(px, py - 6 * k, cardCX, cardCY, cardHW, cardHH, cardR);
        const covShadow = Math.min(1, Math.max(0, 0.5 - dShadow)) * 0.22;
        if (covShadow > 0) {
          const m = mix([r, g, b], [30, 24, 80], covShadow);
          r = m[0];
          g = m[1];
          b = m[2];
        }

        const dCard = sdRoundRect(px, py, cardCX, cardCY, cardHW, cardHH, cardR);
        const covCard = Math.min(1, Math.max(0, 0.5 - dCard));
        if (covCard > 0) {
          r = r + (card[0] - r) * covCard;
          g = g + (card[1] - g) * covCard;
          b = b + (card[2] - b) * covCard;
        }

        // 卡片上的文字线
        if (!simple && covCard > 0.5) {
          for (let i = 0; i < lineY.length; i++) {
            const dLine = sdRoundRect(
              px,
              py,
              lineX0 + lineW[i] / 2,
              lineY[i],
              lineW[i] / 2,
              lineH / 2,
              lineH / 2
            );
            const covLine = Math.min(1, Math.max(0, 0.5 - dLine));
            if (covLine > 0) {
              r = r + (lineCol[0] - r) * covLine * 0.85;
              g = g + (lineCol[1] - g) * covLine * 0.85;
              b = b + (lineCol[2] - b) * covLine * 0.85;
            }
          }
        }
      }

      // --- 闪电 ---
      if (covOuter > 0 && inPolygon(px, py, bolt)) {
        const t = Math.min(1, Math.max(0, (py - 132 * k) / (396 * k - 132 * k)));
        const c = mix(boltA, boltB, t);
        r = c[0];
        g = c[1];
        b = c[2];
      }

      const o = (y * N + x) * 4;
      buf[o] = r;
      buf[o + 1] = g;
      buf[o + 2] = b;
      buf[o + 3] = a;
    }
  }

  // 降采样
  const out = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let r = 0;
      let g = 0;
      let b = 0;
      let a = 0;
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const o = ((y * SS + sy) * N + (x * SS + sx)) * 4;
          r += buf[o];
          g += buf[o + 1];
          b += buf[o + 2];
          a += buf[o + 3];
        }
      }
      const n = SS * SS;
      const o = (y * size + x) * 4;
      // 按 alpha 加权，避免边缘出现黑边
      const aa = a / n;
      const w = aa > 0 ? 255 / aa : 0;
      out[o] = Math.round(Math.min(255, (r / n) * w));
      out[o + 1] = Math.round(Math.min(255, (g / n) * w));
      out[o + 2] = Math.round(Math.min(255, (b / n) * w));
      out[o + 3] = Math.round(aa);
    }
  }
  return out;
}

/* ----------------------------- PNG 编码 ----------------------------- */

function crc32(buf) {
  let c;
  const table = crc32.table || (crc32.table = (() => {
    const t = new Int32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      t[n] = c;
    }
    return t;
  })());
  let crc = -1;
  for (let i = 0; i < buf.length; i++) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xff];
  return (crc ^ -1) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const t = Buffer.from(type, 'ascii');
  const body = Buffer.concat([t, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

function encodePng(rgba, size) {
  const raw = Buffer.alloc((size * 4 + 1) * size);
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0; // filter: none
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/* ----------------------------- ICO 打包 ----------------------------- */

function encodeIco(entries) {
  // entries: [{ size, png }]
  const count = entries.length;
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // type: icon
  header.writeUInt16LE(count, 4);

  const dir = Buffer.alloc(16 * count);
  let offset = 6 + 16 * count;

  entries.forEach((e, i) => {
    const o = i * 16;
    dir[o] = e.size >= 256 ? 0 : e.size; // 256 用 0 表示
    dir[o + 1] = e.size >= 256 ? 0 : e.size;
    dir[o + 2] = 0; // 调色板数
    dir[o + 3] = 0;
    dir.writeUInt16LE(1, o + 4); // color planes
    dir.writeUInt16LE(32, o + 6); // bpp
    dir.writeUInt32LE(e.png.length, o + 8);
    dir.writeUInt32LE(offset, o + 12);
    offset += e.png.length;
  });

  return Buffer.concat([header, dir, ...entries.map((e) => e.png)]);
}

/* ----------------------------- 主流程 ----------------------------- */

function main() {
  fs.mkdirSync(BUILD, { recursive: true });

  const icoSizes = [16, 24, 32, 48, 64, 128, 256];
  const entries = icoSizes.map((size) => ({
    size,
    png: encodePng(render(size, size <= 24), size),
  }));

  fs.writeFileSync(path.join(BUILD, 'icon.ico'), encodeIco(entries));
  fs.writeFileSync(path.join(BUILD, 'icon.png'), encodePng(render(512, false), 512));
  fs.writeFileSync(path.join(BUILD, 'tray.png'), encodePng(render(32, true), 32));

  console.log('[icon] build/icon.ico, build/icon.png, build/tray.png');
}

main();
