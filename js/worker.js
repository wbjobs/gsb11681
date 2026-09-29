/* Web Worker：解码 + 缩放 + 编码，避免大图转换卡死主线程 */
'use strict';

self.onmessage = async (e) => {
  const { id, blob, targetMime, quality, maxDim, bgColor } = e.data;
  try {
    const bitmap = await createImageBitmap(blob); // 动画图自动取第一帧 → 静态降级
    let { width, height } = bitmap;

    if (maxDim > 0 && Math.max(width, height) > maxDim) {
      const scale = maxDim / Math.max(width, height);
      width = Math.max(1, Math.round(width * scale));
      height = Math.max(1, Math.round(height * scale));
    }

    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext('2d');

    if (targetMime === 'image/jpeg') {
      ctx.fillStyle = bgColor || '#ffffff'; // JPEG 无透明通道，先铺底
      ctx.fillRect(0, 0, width, height);
    }
    ctx.drawImage(bitmap, 0, 0, width, height);
    bitmap.close();

    const outBlob = await canvas.convertToBlob({ type: targetMime, quality });
    if (!outBlob || outBlob.type !== targetMime) {
      throw new Error('当前浏览器不支持编码为 ' + targetMime);
    }
    self.postMessage({ id, ok: true, blob: outBlob, width, height });
  } catch (err) {
    self.postMessage({ id, ok: false, error: String(err && err.message || err) });
  }
};
