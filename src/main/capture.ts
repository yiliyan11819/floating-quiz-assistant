/**
 * 截屏与区域裁剪。
 *
 * ★ DPI 正确性（需求 §7 MUST）：
 *   - 渲染层给出的 rect 是 DIP（逻辑像素），原点为该显示器的左上角
 *   - desktopCapturer 返回的是物理像素
 *   - 这里用「实测比例」而不是直接信任 display.scaleFactor：
 *     实际拿到的图宽 ÷ 显示器 DIP 宽 = 该屏真实物理像素/DIP 比，
 *     这样在 125% / 150% / 混合 DPI 多屏下都不会偏移。
 */
import { desktopCapturer, screen, NativeImage, Display } from 'electron';
import { Region } from '../shared/types';

export interface CapturedFrame {
  image: NativeImage;
  region: Region;
  /** 该帧的物理尺寸 */
  physicalWidth: number;
  physicalHeight: number;
}

function findDisplay(displayId?: number): Display {
  const all = screen.getAllDisplays();
  if (displayId != null) {
    const hit = all.find((d) => d.id === displayId);
    if (hit) return hit;
  }
  return screen.getPrimaryDisplay();
}

/** 取某个显示器的整屏原始截图（物理像素） */
async function captureDisplayNative(display: Display): Promise<{
  image: NativeImage;
  scaleX: number;
  scaleY: number;
}> {
  const wantW = Math.round(display.size.width * display.scaleFactor);
  const wantH = Math.round(display.size.height * display.scaleFactor);

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: wantW, height: wantH },
    fetchWindowIcons: false,
  });

  let source = sources.find((s) => String(s.display_id) === String(display.id));
  if (!source) {
    // 有些驱动不上报 display_id，退化为按顺序匹配
    const idx = screen.getAllDisplays().findIndex((d) => d.id === display.id);
    source = sources[idx] ?? sources[0];
  }
  if (!source || source.thumbnail.isEmpty()) {
    throw new Error('无法获取屏幕画面（截屏返回空图）');
  }

  const image = source.thumbnail;
  const got = image.getSize();
  return {
    image,
    scaleX: got.width / display.bounds.width,
    scaleY: got.height / display.bounds.height,
  };
}

/**
 * 抓取指定区域。
 * @param region DIP 坐标，原点为该显示器左上角；width/height 为空则抓整屏
 */
export async function captureRegion(region?: Region | null, fallbackDisplayId?: number): Promise<CapturedFrame> {
  const display = findDisplay(region?.displayId ?? fallbackDisplayId);
  const { image, scaleX, scaleY } = await captureDisplayNative(display);

  const dipW = display.bounds.width;
  const dipH = display.bounds.height;

  const r: Region = {
    x: region ? region.x : 0,
    y: region ? region.y : 0,
    width: region ? region.width : dipW,
    height: region ? region.height : dipH,
    displayId: display.id,
  };

  // 夹到屏幕范围内，避免用户拖出去导致 crop 抛错
  const x = clampNum(Math.round(r.x * scaleX), 0, image.getSize().width - 1);
  const y = clampNum(Math.round(r.y * scaleY), 0, image.getSize().height - 1);
  const w = clampNum(Math.round(r.width * scaleX), 1, image.getSize().width - x);
  const h = clampNum(Math.round(r.height * scaleY), 1, image.getSize().height - y);

  const cropped = image.crop({ x, y, width: Math.max(1, w), height: Math.max(1, h) });
  const size = cropped.getSize();
  return {
    image: cropped,
    region: r,
    physicalWidth: size.width,
    physicalHeight: size.height,
  };
}

/** 按长边限制缩放，并压成 JPEG 的 dataURL（需求 §6 SHOULD：降延迟与 token） */
export function encodeForModel(
  image: NativeImage,
  maxEdge: number,
  jpegQuality: number
): { dataUrl: string; width: number; height: number; bytes: number } {
  let img = image;
  const size = img.getSize();
  const longEdge = Math.max(size.width, size.height);
  if (maxEdge > 0 && longEdge > maxEdge) {
    const k = maxEdge / longEdge;
    img = img.resize({
      width: Math.max(1, Math.round(size.width * k)),
      height: Math.max(1, Math.round(size.height * k)),
      quality: 'good',
    });
  }
  const jpeg = img.toJPEG(Math.round(jpegQuality));
  const out = img.getSize();
  return {
    dataUrl: `data:image/jpeg;base64,${jpeg.toString('base64')}`,
    width: out.width,
    height: out.height,
    bytes: jpeg.length,
  };
}

/** 错题本缩略图：长边 320 的 JPEG dataURL */
export function makeThumb(image: NativeImage): string {
  const size = image.getSize();
  const longEdge = Math.max(size.width, size.height);
  const k = longEdge > 320 ? 320 / longEdge : 1;
  const img =
    k < 1
      ? image.resize({
          width: Math.max(1, Math.round(size.width * k)),
          height: Math.max(1, Math.round(size.height * k)),
          quality: 'good',
        })
      : image;
  return `data:image/jpeg;base64,${img.toJPEG(70).toString('base64')}`;
}

function clampNum(n: number, min: number, max: number): number {
  if (!Number.isFinite(n)) return min;
  return Math.min(Math.max(n, min), Math.max(min, max));
}
