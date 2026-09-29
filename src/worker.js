// Web Worker：转换在后台线程执行，大图处理时不阻塞界面
import { convertImage, ConversionError } from './converter.js';

function serializeError(err) {
  return {
    name: err?.name || 'Error',
    code: err?.code || 'WORKER_ERROR',
    message: err?.message || String(err),
  };
}

self.addEventListener('message', async (event) => {
  const { id, payload } = event.data || {};
  if (!id) return;
  try {
    const result = await convertImage(payload);
    // Blob 可直接经结构化克隆回传
    self.postMessage({ id, ok: true, result });
  } catch (err) {
    if (err instanceof ConversionError || err?.code) {
      self.postMessage({ id, ok: false, error: serializeError(err) });
    } else {
      self.postMessage({
        id,
        ok: false,
        error: serializeError(new ConversionError('WORKER_ERROR', String(err?.message || err))),
      });
    }
  }
});
