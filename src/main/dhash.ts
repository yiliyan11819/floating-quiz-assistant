/**
 * 感知哈希（dHash 64 bit）+ 空白帧检测。
 *
 * dHash：把图缩到 9×8 灰度，逐行比较相邻像素，得到 8×8 = 64 bit。
 * 抗缩放、抗轻微压缩噪声，非常适合"同一道题是否又出现了"这种判定。
 */
import { NativeImage } from 'electron';

export interface HashResult {
  /** 16 位十六进制（64 bit），空串表示该帧不可用 */
  hash: string;
  /** 是否是全黑/纯色帧（全屏独占应用会导致截屏全黑） */
  blank: boolean;
  /** 平均亮度 0-255 */
  meanLuma: number;
}

/**
 * 计算 dHash。
 * @param img 任意尺寸的 NativeImage
 */
export function computeDHash(img: NativeImage): HashResult {
  // 9×8 = 横向 8 组相邻比较，正好 64 bit
  const small = img.resize({ width: 9, height: 8, quality: 'good' });
  const size = small.getSize();
  if (size.width < 2 || size.height < 1) {
    return { hash: '', blank: true, meanLuma: 0 };
  }
  const buf = small.toBitmap(); // BGRA
  const w = size.width;
  const h = size.height;

  // 灰度图
  const gray: number[] = new Array(w * h);
  let sum = 0;
  let min = 255;
  let max = 0;
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    const b = buf[o];
    const g = buf[o + 1];
    const r = buf[o + 2];
    const y = 0.114 * b + 0.587 * g + 0.299 * r;
    gray[i] = y;
    sum += y;
    if (y < min) min = y;
    if (y > max) max = y;
  }
  const meanLuma = sum / (w * h);

  // 全黑（或被全屏独占应用挡住的）帧：整体极暗
  // 纯色帧（方差极低）同样没有信息量
  const blank = meanLuma < 8 || max - min < 4;

  // 逐位比较
  let bits = '';
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w - 1; x++) {
      bits += gray[y * w + x] > gray[y * w + x + 1] ? '1' : '0';
    }
  }
  // 补到 64 bit 再转 hex（w=9 时天然就是 64 bit）
  while (bits.length < 64) bits += '0';
  bits = bits.slice(0, 64);

  let hex = '';
  for (let i = 0; i < 64; i += 4) {
    hex += parseInt(bits.slice(i, i + 4), 2).toString(16);
  }

  return { hash: hex, blank, meanLuma };
}
