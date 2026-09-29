// 主线程降级转换器：Worker 不可用或用户显式要求时使用。
// SVG 需要经 <img> + Canvas 解码，因此这里使用 HTMLImageElement 路径。
import { ConversionError, computeTargetSize, MAX_DIMENSION } from './converter.js';

function loadImageElement(blob, sourceMime) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => resolve({ img, url });
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new ConversionError(
        'DECODE_FAILED',
        `图片解码失败（${sourceMime || '未知格式'}）`,
      ));
    };
    img.src = url;
  });
}

function sampleAlphaFromImage(img, maxEdge = 256) {
  const edge = Math.min(maxEdge, img.naturalWidth, img.naturalHeight);
  const canvas = document.createElement('canvas');
  canvas.width = edge;
  canvas.height = edge;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(img, 0, 0, edge, edge);
  const data = ctx.getImageData(0, 0, edge, edge).data;
  for (let i = 3; i < data.length; i += 16) {
    if (data[i] < 255) return true;
  }
  return false;
}

function canvasToBlob(canvas, targetMime, quality) {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new ConversionError('ENCODE_FAILED', `编码为 ${targetMime} 失败`));
    }, targetMime, quality);
  });
}

export async function convertImageMainThread({ buffer, sourceMime, targetMime, quality = 0.92 }) {
  const blob = new Blob([buffer], { type: sourceMime || undefined });
  const { img, url } = await loadImageElement(blob, sourceMime);
  try {
    if (!img.naturalWidth || !img.naturalHeight) {
      throw new ConversionError('DECODE_FAILED', '解码后图片尺寸为 0');
    }
    let sourceHadAlpha = false;
    try {
      sourceHadAlpha = sampleAlphaFromImage(img);
    } catch {
      sourceHadAlpha = true;
    }

    const target = computeTargetSize(img.naturalWidth, img.naturalHeight);
    const canvas = document.createElement('canvas');
    canvas.width = target.width;
    canvas.height = target.height;
    const ctx = canvas.getContext('2d', { alpha: true });

    const alphaFlattened = targetMime === 'image/jpeg';
    if (alphaFlattened) {
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, target.width, target.height);
    }
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, 0, 0, target.width, target.height);

    let outBlob;
    let outputMime = targetMime;
    let downgraded = false;
    try {
      outBlob = await canvasToBlob(canvas, targetMime, quality);
    } catch {
      if (targetMime === 'image/png') throw new ConversionError('ENCODE_FAILED', 'PNG 编码失败');
      outBlob = await canvasToBlob(canvas, 'image/png', quality);
      outputMime = 'image/png';
      downgraded = true;
    }
    if (outBlob.type && outBlob.type !== targetMime) {
      outputMime = outBlob.type;
      downgraded = true;
    }
    return {
      blob: outBlob,
      width: target.width,
      height: target.height,
      outputMime,
      downgraded,
      scaledDown: target.scaledDown,
      alphaFlattened,
      sourceHadAlpha,
    };
  } finally {
    URL.revokeObjectURL(url);
  }
}

export { ConversionError, MAX_DIMENSION };
