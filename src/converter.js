// 图片转换核心逻辑：解码 -> 大图限幅 -> 透明通道处理 -> 编码。
// 仅依赖 createImageBitmap / OffscreenCanvas，可在 Worker 中运行。

export const MAX_DIMENSION = 8192;
// 2400 万像素上限：兼顾 4K 以上图片与移动端/低端机的 canvas 内存安全
export const MAX_PIXELS = 24_000_000;

export class ConversionError extends Error {
  constructor(code, message, cause) {
    super(message);
    this.name = 'ConversionError';
    this.code = code;
    if (cause) this.cause = cause;
  }
}

// 动画图（GIF / APNG / 动态 WebP）经 createImageBitmap 只会解码第一帧，
// 这正是「动画降级为静态」的期望行为。
export async function decodeBitmap(blob, sourceMime) {
  try {
    return await createImageBitmap(blob);
  } catch (err) {
    if (sourceMime === 'image/svg+xml') {
      throw new ConversionError(
        'SVG_DECODE_FAILED',
        'SVG 在当前环境无法用 createImageBitmap 解码，可切换主线程模式重试',
        err,
      );
    }
    throw new ConversionError(
      'DECODE_FAILED',
      `图片解码失败（${sourceMime || '未知格式'}），文件可能已损坏或尺寸过大`,
      err,
    );
  }
}

export function computeTargetSize(width, height) {
  let scale = 1;
  if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
    scale = Math.min(MAX_DIMENSION / width, MAX_DIMENSION / height);
  }
  const pixels = width * height;
  if (pixels > MAX_PIXELS) {
    scale = Math.min(scale, Math.sqrt(MAX_PIXELS / pixels));
  }
  if (scale === 1) return { width, height, scaledDown: false };
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    scaledDown: true,
  };
}

// 采样检测真实透明像素（容器声明 alpha 不代表像素真的透明）
export function sampleAlpha(bitmap, maxEdge = 256) {
  const edge = Math.min(maxEdge, bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(edge, edge);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bitmap, 0, 0, edge, edge);
  const data = ctx.getImageData(0, 0, edge, edge).data;
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] < 255) return true;
  }
  return false;
}

async function encodeCanvas(canvas, targetMime, quality) {
  let blob;
  try {
    blob = await canvas.convertToBlob({
      type: targetMime,
      quality: targetMime === 'image/png' ? undefined : quality,
    });
  } catch (err) {
    throw new ConversionError('ENCODE_FAILED', `编码为 ${targetMime} 失败`, err);
  }
  if (!blob || blob.size === 0) {
    throw new ConversionError('ENCODE_FAILED', '编码结果为空');
  }
  // 部分浏览器（旧版 Safari 等）不支持 WebP 编码时会静默回退成 PNG
  const downgraded = blob.type && blob.type !== targetMime;
  return { blob, outputMime: blob.type || targetMime, downgraded: Boolean(downgraded) };
}

/**
 * @param {object} params
 * @param {ArrayBuffer} params.buffer
 * @param {string} params.sourceMime
 * @param {string} params.targetMime
 * @param {number} [params.quality]
 * @returns {Promise<{blob:Blob,width:number,height:number,outputMime:string,
 *           downgraded:boolean,scaledDown:boolean,alphaFlattened:boolean,
 *           sourceHadAlpha:boolean}>}
 */
export async function convertImage({ buffer, sourceMime, targetMime, quality = 0.92 }) {
  const blob = new Blob([buffer], { type: sourceMime || undefined });
  const bitmap = await decodeBitmap(blob, sourceMime);

  let sourceHadAlpha = false;
  try {
    sourceHadAlpha = sampleAlpha(bitmap);
  } catch {
    // 采样失败不阻塞主流程：JPEG 输出时仍然铺白底兜底
    sourceHadAlpha = true;
  }

  const target = computeTargetSize(bitmap.width, bitmap.height);
  const canvas = new OffscreenCanvas(target.width, target.height);
  const ctx = canvas.getContext('2d', { alpha: true });

  // JPEG 没有 alpha：统一铺白底，保证透明区域不会变黑
  const alphaFlattened = targetMime === 'image/jpeg';
  if (alphaFlattened) {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, target.width, target.height);
  }
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bitmap, 0, 0, target.width, target.height);
  bitmap.close?.();

  try {
    const encoded = await encodeCanvas(canvas, targetMime, quality);
    return {
      blob: encoded.blob,
      width: target.width,
      height: target.height,
      outputMime: encoded.outputMime,
      downgraded: encoded.downgraded,
      scaledDown: target.scaledDown,
      alphaFlattened,
      sourceHadAlpha,
    };
  } catch (err) {
    // 目标编码器完全不可用（如 WebP 抛错）：自动降级到最广泛支持的 PNG
    if (targetMime !== 'image/png' && err.code === 'ENCODE_FAILED') {
      const fallback = await encodeCanvas(canvas, 'image/png', quality);
      return {
        blob: fallback.blob,
        width: target.width,
        height: target.height,
        outputMime: fallback.outputMime,
        downgraded: true,
        scaledDown: target.scaledDown,
        alphaFlattened,
        sourceHadAlpha,
      };
    }
    throw err;
  }
}
