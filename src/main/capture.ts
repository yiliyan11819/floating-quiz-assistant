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

/**
 * 冻结帧：框选模式下先把屏幕「拍下来」，再拿这张静态图当遮罩背景。
 *
 * 为什么不让遮罩直接透明地盖在桌面上？
 *   bilibili / 腾讯课堂这类播放器走的是硬件视频叠加层（hardware overlay）。
 *   一个全屏 + 置顶 + 透明的窗口盖上去，会把叠加层挤掉，
 *   画面就变成纯黑 —— 但 desktopCapturer 抓到的原始帧其实是好的，
 *   所以表现为「截图时视频变黑，识别结果却正常」。
 *   把遮罩换成「不透明 + 背景是刚拍下的截图」，用户看到的画面一模一样，
 *   却不再有任何透明窗口去和播放器抢图层。
 *   顺带的好处：框选期间画面完全静止，选区域更准。
 */
export interface FrozenScreen {
  displayId: number;
  /** DIP 逻辑尺寸 */
  dipWidth: number;
  dipHeight: number;
  /** 物理像素原图，裁剪时用 */
  image: NativeImage;
  scaleX: number;
  scaleY: number;
  /** 给遮罩窗口当背景用的 dataURL */
  backdrop: string;
}

/** 一次性把所有（指定）显示器拍下来 */
export async function freezeScreens(displayIds?: number[]): Promise<FrozenScreen[]> {
  const all = screen.getAllDisplays();
  const displays = displayIds?.length
    ? all.filter((d) => displayIds.includes(d.id))
    : all;
  if (!displays.length) return [];

  // 一次 getSources 抓全部屏幕，按最大屏的物理尺寸请求，避免逐屏重复抓取
  const wantW = Math.max(...displays.map((d) => Math.round(d.size.width * d.scaleFactor)));
  const wantH = Math.max(...displays.map((d) => Math.round(d.size.height * d.scaleFactor)));

  const sources = await desktopCapturer.getSources({
    types: ['screen'],
    thumbnailSize: { width: wantW, height: wantH },
    fetchWindowIcons: false,
  });

  const out: FrozenScreen[] = [];
  for (const d of displays) {
    let source = sources.find((s) => String(s.display_id) === String(d.id));
    if (!source) {
      const idx = all.findIndex((x) => x.id === d.id);
      source = sources[idx] ?? sources[0];
    }
    if (!source || source.thumbnail.isEmpty()) continue;

    const image = source.thumbnail;
    const got = image.getSize();
    out.push({
      displayId: d.id,
      dipWidth: d.bounds.width,
      dipHeight: d.bounds.height,
      image,
      scaleX: got.width / d.bounds.width,
      scaleY: got.height / d.bounds.height,
      // 只作展示用，JPEG 足够，且体积远小于 PNG
      backdrop: `data:image/jpeg;base64,${image.toJPEG(82).toString('base64')}`,
    });
  }
  return out;
}

/** 从冻结帧里裁出用户选中的区域 */
export function cropFrozen(frozen: FrozenScreen, region: Region): CapturedFrame {
  const r: Region = {
    x: region.x,
    y: region.y,
    width: region.width,
    height: region.height,
    displayId: frozen.displayId,
  };
  return cropNative(frozen.image, frozen.scaleX, frozen.scaleY, r);
}

/** 把物理像素图按 DIP 区域裁下来 */
function cropNative(
  image: NativeImage,
  scaleX: number,
  scaleY: number,
  region: Region
): CapturedFrame {
  const size = image.getSize();
  const x = clampNum(Math.round(region.x * scaleX), 0, size.width - 1);
  const y = clampNum(Math.round(region.y * scaleY), 0, size.height - 1);
  const w = clampNum(Math.round(region.width * scaleX), 1, size.width - x);
  const h = clampNum(Math.round(region.height * scaleY), 1, size.height - y);

  const cropped = image.crop({ x, y, width: Math.max(1, w), height: Math.max(1, h) });
  const got = cropped.getSize();
  return {
    image: cropped,
    region,
    physicalWidth: got.width,
    physicalHeight: got.height,
  };
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

  return cropNative(image, scaleX, scaleY, r);
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
