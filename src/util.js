// 通用工具函数

export function formatBytes(bytes) {
  if (bytes == null || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i += 1;
  }
  return `${value.toFixed(value >= 10 ? 1 : 2)} ${units[i]}`;
}

export function formatDuration(ms) {
  if (ms == null) return '—';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(2)} s`;
}

export function extForMime(mime) {
  switch (mime) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/webp': return 'webp';
    case 'image/gif': return 'gif';
    case 'image/bmp': return 'bmp';
    case 'image/svg+xml': return 'svg';
    default: return 'bin';
  }
}

export function labelForMime(mime) {
  const map = {
    'image/png': 'PNG',
    'image/jpeg': 'JPEG',
    'image/webp': 'WebP',
    'image/gif': 'GIF',
    'image/bmp': 'BMP',
    'image/svg+xml': 'SVG',
  };
  return map[mime] || (mime ? mime.toUpperCase() : '未知');
}

export async function measure(fn) {
  const start = performance.now();
  const result = await fn();
  return { result, elapsed: performance.now() - start };
}

export function makeDownloadName(baseName, mime, suffix = '') {
  const ext = extForMime(mime);
  const safeBase = (baseName || 'image').replace(/\.[a-z0-9]+$/i, '');
  return `${safeBase}${suffix}.${ext}`;
}
