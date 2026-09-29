// 剪贴板读取：优先 navigator.clipboard.read（异步 Clipboard API），
// 失败时由全局 paste 事件兜底（两者都会汇总到 App）。

export class ClipboardError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'ClipboardError';
    this.code = code; // EMPTY | PERMISSION_DENIED | UNSUPPORTED
  }
}

export function isAsyncClipboardSupported() {
  return Boolean(navigator.clipboard && typeof navigator.clipboard.read === 'function');
}

function pickImageItem(items) {
  // 优先图片 MIME，其次把 SVG 等文本载体也纳入
  return items.find((item) =>
    [...item.types].some((type) => type.startsWith('image/')),
  ) || null;
}

function findImageType(types) {
  const list = [...types];
  return list.find((t) => t.startsWith('image/')) || null;
}

/**
 * 从异步剪贴板读取一张图片。
 * @returns {Promise<{blob:Blob, mime:string, origin:'clipboard'}>}
 */
export async function readClipboardImage() {
  if (!isAsyncClipboardSupported()) {
    throw new ClipboardError('UNSUPPORTED', '当前浏览器不支持异步剪贴板读取，请直接 Ctrl/⌘+V 或选择文件');
  }
  let items;
  try {
    items = await navigator.clipboard.read();
  } catch (err) {
    const name = (err && err.name) || '';
    if (name === 'NotAllowedError' || name === 'SecurityError') {
      throw new ClipboardError('PERMISSION_DENIED', '剪贴板权限被拒绝，请在浏览器地址栏授权后重试');
    }
    throw new ClipboardError('UNSUPPORTED', `剪贴板读取失败：${err && err.message ? err.message : name}`);
  }

  const item = pickImageItem(items);
  if (!item) {
    throw new ClipboardError('EMPTY', '剪贴板中没有图片（可复制一张图片后再试）');
  }
  const type = findImageType(item.types);
  const blob = await item.getType(type);
  return { blob, mime: type, origin: 'clipboard' };
}

// paste 事件中提取图片；若无图片返回 null
export function imageFromPasteEvent(event) {
  const items = event.clipboardData && event.clipboardData.items;
  if (!items) return null;
  for (const item of items) {
    if (item.kind === 'file' && item.type.startsWith('image/')) {
      const blob = item.getAsFile();
      if (blob) return { blob, mime: blob.type || item.type, origin: 'paste-event' };
    }
  }
  return null;
}
