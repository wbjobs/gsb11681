/* 通过魔数识别格式，并解析尺寸 / 透明通道 / 动画信息（纯字节解析，无需解码） */
(function (global) {
  'use strict';

  const FORMATS = {
    png:  { mime: 'image/png',  label: 'PNG' },
    jpeg: { mime: 'image/jpeg', label: 'JPEG' },
    gif:  { mime: 'image/gif',  label: 'GIF' },
    webp: { mime: 'image/webp', label: 'WebP' },
    bmp:  { mime: 'image/bmp',  label: 'BMP' },
    svg:  { mime: 'image/svg+xml', label: 'SVG' },
    avif: { mime: 'image/avif', label: 'AVIF' },
    ico:  { mime: 'image/x-icon', label: 'ICO' },
    tiff: { mime: 'image/tiff', label: 'TIFF' },
  };

  function sniff(bytes) {
    const b = bytes;
    if (b.length >= 8 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'png';
    if (b.length >= 3 && b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'jpeg';
    if (b.length >= 6 && str(b, 0, 6) === 'GIF87a' || b.length >= 6 && str(b, 0, 6) === 'GIF89a') return 'gif';
    if (b.length >= 12 && str(b, 0, 4) === 'RIFF' && str(b, 8, 4) === 'WEBP') return 'webp';
    if (b.length >= 2 && b[0] === 0x42 && b[1] === 0x4D) return 'bmp';
    if (b.length >= 12 && str(b, 4, 4) === 'ftyp' && ['avif', 'avis'].includes(str(b, 8, 4))) return 'avif';
    if (b.length >= 4 && b[0] === 0x00 && b[1] === 0x00 && b[2] === 0x01 && b[3] === 0x00) return 'ico';
    if (b.length >= 4 && ((b[0] === 0x49 && b[1] === 0x49 && b[2] === 0x2A) || (b[0] === 0x4D && b[1] === 0x4D && b[2] === 0x00 && b[3] === 0x2A))) return 'tiff';
    if (looksLikeSvg(b)) return 'svg';
    return null;
  }

  function str(b, off, len) {
    let s = '';
    for (let i = off; i < off + len && i < b.length; i++) s += String.fromCharCode(b[i]);
    return s;
  }

  function looksLikeSvg(b) {
    const head = str(b, 0, Math.min(b.length, 512)).trimStart().toLowerCase();
    return head.startsWith('<svg') || (head.startsWith('<?xml') && head.includes('<svg'));
  }

  const u16le = (b, o) => b[o] | (b[o + 1] << 8);
  const u32le = (b, o) => (b[o] | (b[o + 1] << 8) | (b[o + 2] << 16) | (b[o + 3] << 24)) >>> 0;
  const u16be = (b, o) => (b[o] << 8) | b[o + 1];
  const u32be = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;

  const parsers = {
    png(b) {
      const width = u32be(b, 16), height = u32be(b, 20);
      const colorType = b[25];
      let hasAlpha = colorType === 4 || colorType === 6;
      let animated = false;
      let off = 8;
      while (off + 8 <= b.length) {
        const len = u32be(b, off);
        const type = str(b, off + 4, 4);
        if (type === 'tRNS') hasAlpha = true;
        if (type === 'acTL') animated = true; // APNG
        if (type === 'IEND') break;
        off += 12 + len;
      }
      return { width, height, hasAlpha, animated };
    },

    jpeg(b) {
      let off = 2;
      while (off + 4 <= b.length) {
        if (b[off] !== 0xFF) { off++; continue; }
        const marker = b[off + 1];
        if (marker >= 0xC0 && marker <= 0xCF && ![0xC4, 0xC8, 0xCC].includes(marker)) {
          return { width: u16be(b, off + 7), height: u16be(b, off + 5), hasAlpha: false, animated: false };
        }
        off += 2 + u16be(b, off + 2);
      }
      return { width: 0, height: 0, hasAlpha: false, animated: false };
    },

    gif(b) {
      const width = u16le(b, 6), height = u16le(b, 8);
      let frames = 0, hasAlpha = false;
      let off = 13;
      const gctFlag = b[10] & 0x80;
      if (gctFlag) off += 3 * Math.pow(2, (b[10] & 0x07) + 1);
      while (off < b.length && frames < 1000) {
        const tag = b[off];
        if (tag === 0x21 && b[off + 1] === 0xF9) { // 图形控制扩展
          if (b[off + 3] & 0x01) hasAlpha = true;
          off += 8;
        } else if (tag === 0x21) { // 其他扩展
          off += 2;
          while (off < b.length && b[off] !== 0) off += b[off] + 1;
          off++;
        } else if (tag === 0x2C) { // 图像描述符
          frames++;
          const lctFlag = b[off + 9] & 0x80;
          off += 10;
          if (lctFlag) off += 3 * Math.pow(2, (b[off - 1] & 0x07) + 1);
          off++; // LZW 最小码长
          while (off < b.length && b[off] !== 0) off += b[off] + 1;
          off++;
        } else break;
      }
      return { width, height, hasAlpha, animated: frames > 1 };
    },

    webp(b) {
      const fourcc = str(b, 12, 4);
      if (fourcc === 'VP8 ') {
        const off = 20;
        return { width: u16le(b, off + 6) & 0x3FFF, height: u16le(b, off + 8) & 0x3FFF, hasAlpha: false, animated: false };
      }
      if (fourcc === 'VP8L') {
        const bits = u32le(b, 21);
        return { width: (bits & 0x3FFF) + 1, height: ((bits >> 14) & 0x3FFF) + 1, hasAlpha: true, animated: false };
      }
      if (fourcc === 'VP8X') {
        const flags = b[20];
        const width = 1 + (b[24] | (b[25] << 8) | (b[26] << 16));
        const height = 1 + (b[27] | (b[28] << 8) | (b[29] << 16));
        return { width, height, hasAlpha: !!(flags & 0x10), animated: !!(flags & 0x02) };
      }
      return { width: 0, height: 0, hasAlpha: false, animated: false };
    },

    bmp(b) {
      const width = u32le(b, 18), height = Math.abs(u32le(b, 22) | 0);
      const bpp = u16le(b, 28);
      return { width, height, hasAlpha: bpp === 32, animated: false };
    },

    svg(b) {
      const text = new TextDecoder().decode(b);
      const w = /width\s*=\s*"([\d.]+)/.exec(text);
      const h = /height\s*=\s*"([\d.]+)/.exec(text);
      const vb = /viewBox\s*=\s*"[\s\d.-]+[\s,]+([\d.]+)[\s,]+([\d.]+)"/.exec(text);
      const width = w ? +w[1] : (vb ? +vb[1] : 0);
      const height = h ? +h[1] : (vb ? +vb[2] : 0);
      return { width, height, hasAlpha: true, animated: /<animate|<set[\s>]|@keyframes/i.test(text) };
    },
  };

  /** 解析 ArrayBuffer，返回 { format, mime, label, width, height, hasAlpha, animated, supported } */
  function analyze(buffer) {
    const bytes = new Uint8Array(buffer);
    const key = sniff(bytes);
    if (!key) {
      return { format: 'unknown', mime: '', label: '未知格式', width: 0, height: 0, hasAlpha: false, animated: false };
    }
    const meta = parsers[key] ? parsers[key](bytes) : { width: 0, height: 0, hasAlpha: false, animated: false };
    return Object.assign({ format: key, mime: FORMATS[key].mime, label: FORMATS[key].label }, meta);
  }

  global.FormatDetect = { analyze, FORMATS };
})(typeof self !== 'undefined' ? self : window);
