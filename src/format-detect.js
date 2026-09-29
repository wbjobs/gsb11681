// 通过文件头魔数嗅探真实格式（浏览器给出的 clipboard.type / Blob.type 在
// Safari 等浏览器上经常不可靠），并从头部解析尺寸、动画、透明通道线索。

const dec = new TextDecoder('ascii');

function ascii(buf, offset, length) {
  return dec.decode(new Uint8Array(buf, offset, length));
}

function isPng(buf) {
  const b = new Uint8Array(buf, 0, Math.min(8, buf.byteLength));
  return b.length >= 8 &&
    b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e &&
    b[3] === 0x47 && b[4] === 0x0d && b[5] === 0x0a && b[6] === 0x1a && b[7] === 0x0a;
}

function isJpeg(buf) {
  const b = new Uint8Array(buf);
  return b.length >= 3 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff;
}

function isGif(buf) {
  return buf.byteLength >= 6 &&
    (ascii(buf, 0, 6) === 'GIF87a' || ascii(buf, 0, 6) === 'GIF89a');
}

function isBmp(buf) {
  return buf.byteLength >= 2 && ascii(buf, 0, 2) === 'BM';
}

function isWebp(buf) {
  return buf.byteLength >= 12 && ascii(buf, 0, 4) === 'RIFF' && ascii(buf, 8, 4) === 'WEBP';
}

function isSvg(buf) {
  // 嗅探前 512 字节中的 <svg 标记（兼容 BOM 与前置空白）
  const head = new TextDecoder('utf-8').decode(
    new Uint8Array(buf, 0, Math.min(512, buf.byteLength)),
  );
  return /<svg[\s>]/i.test(head);
}

function readUint16(view, offset, littleEndian) {
  return view.getUint16(offset, littleEndian);
}

// 解析 PNG IHDR
function pngInfo(buf) {
  const view = new DataView(buf);
  const info = { width: 0, height: 0, animated: false, alphaHint: false };
  if (buf.byteLength >= 24) {
    info.width = view.getUint32(16, false);
    info.height = view.getUint32(20, false);
    const colorType = view.getUint8(25);
    // 4 = grayscale+alpha, 6 = RGBA：容器支持透明
    info.alphaHint = colorType === 4 || colorType === 6;
  }
  // APNG：存在 acTL chunk 即动画
  const bytes = new Uint8Array(buf);
  if (findAscii(bytes, 'acTL') >= 0) info.animated = true;
  return info;
}

function findAscii(bytes, token) {
  const target = token.split('').map((c) => c.charCodeAt(0));
  outer: for (let i = 0; i <= bytes.length - target.length; i += 1) {
    for (let j = 0; j < target.length; j += 1) {
      if (bytes[i + j] !== target[j]) continue outer;
    }
    return i;
  }
  return -1;
}

// 解析 JPEG SOFn 段
function jpegInfo(buf) {
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  const info = { width: 0, height: 0, animated: false, alphaHint: false };
  let offset = 2;
  while (offset + 4 < bytes.length) {
    if (bytes[offset] !== 0xff) { offset += 1; continue; }
    const marker = bytes[offset + 1];
    // SOF0..SOF15，排除 DHT(C4)、DAC(CC)
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xcc &&
        marker !== 0xc8 && marker !== 0xdc) {
      info.height = view.getUint16(offset + 5, false);
      info.width = view.getUint16(offset + 7, false);
      break;
    }
    const segLen = view.getUint16(offset + 2, false);
    if (segLen < 2) break;
    offset += 2 + segLen;
  }
  return info;
}

function gifInfo(buf) {
  const view = new DataView(buf);
  const info = {
    width: readUint16(view, 6, true),
    height: readUint16(view, 8, true),
    animated: false,
    alphaHint: false,
  };
  const packed = view.getUint8(10);
  const gctFlag = (packed & 0x80) !== 0;
  const gctSize = gctFlag ? 3 * (2 ** ((packed & 0x07) + 1)) : 0;
  let offset = 13 + gctSize;
  const bytes = new Uint8Array(buf);
  let imageBlocks = 0;
  while (offset < bytes.length) {
    const label = bytes[offset];
    if (label === 0x3b) break; // trailer
    if (label === 0x21) { // extension
      // Graphic Control Extension: 0x21 0xf9 <len> packed(含透明索引标志)
      if (bytes[offset + 1] === 0xf9) {
        const gcePacked = bytes[offset + 3];
        if ((gcePacked & 0x01) !== 0) info.alphaHint = true;
      }
      offset += 2;
      let blockSize = bytes[offset];
      offset += 1;
      while (blockSize !== 0 && offset < bytes.length) {
        offset += blockSize;
        blockSize = bytes[offset];
      }
      offset += 1;
    } else if (label === 0x2c) { // image descriptor
      imageBlocks += 1;
      if (imageBlocks > 1) info.animated = true;
      const localPacked = bytes[offset + 9];
      const lctFlag = (localPacked & 0x80) !== 0;
      offset += 10;
      if (lctFlag) offset += 3 * (2 ** ((localPacked & 0x07) + 1));
      offset += 1; // LZW minimum code size
      let blockSize = bytes[offset];
      offset += 1;
      while (blockSize !== 0 && offset < bytes.length) {
        offset += blockSize;
        blockSize = bytes[offset];
      }
      offset += 1;
    } else {
      break;
    }
  }
  return info;
}

function bmpInfo(buf) {
  const view = new DataView(buf);
  const info = { width: 0, height: 0, animated: false, alphaHint: false };
  if (buf.byteLength < 30) return info;
  info.width = view.getInt32(18, true);
  const rawHeight = view.getInt32(22, true);
  info.height = Math.abs(rawHeight);
  const bpp = view.getUint16(28, true);
  const compression = view.getUint32(30, true);
  const headerSize = view.getUint32(14, true);
  // 32bpp：BI_BITFIELDS(3) 且有 alpha 掩码，或 BI_ALPHA(6)，或 V4/V5 头声明 alpha
  if (bpp === 32) {
    let alphaMask = 0;
    if (headerSize >= 108 && buf.byteLength >= 72) {
      // BITMAPV4/V5HEADER：bV4AlphaMask 在 DIB 头内偏移 54 处
      alphaMask = view.getUint32(14 + 54, true);
    } else if (compression === 3 && buf.byteLength >= 70) {
      // 非标准写法：三个标准掩码后追加第 4 个 alpha 掩码（绝对偏移 66）
      alphaMask = view.getUint32(66, true);
    }
    info.alphaHint = alphaMask !== 0 || compression === 6;
  }
  return info;
}

function webpInfo(buf) {
  const view = new DataView(buf);
  const info = { width: 0, height: 0, animated: false, alphaHint: false };
  const fourcc = ascii(buf, 12, 4);
  if (fourcc === 'VP8X' && buf.byteLength >= 30) {
    // 画布尺寸 = 24 位字段 + 1
    info.width = (view.getUint8(24) | (view.getUint8(25) << 8) | (view.getUint8(26) << 16)) + 1;
    info.height = (view.getUint8(27) | (view.getUint8(28) << 8) | (view.getUint8(29) << 16)) + 1;
    const flags = view.getUint8(20);
    // VP8X 标志位（自高位）：I=0x20 ICC, L=0x10 Alpha, E=0x08 Exif,
    // X=0x04 动画(ANMF), A=0x02 XMP
    info.animated = (flags & 0x04) !== 0;
    info.alphaHint = (flags & 0x10) !== 0;
  } else if (fourcc === 'VP8 ' && buf.byteLength >= 30) {
    // 有损比特流：start code 9d 01 2a 位于 chunk 负载偏移 23 附近
    info.width = view.getUint16(26, true) & 0x3fff;
    info.height = view.getUint16(28, true) & 0x3fff;
  } else if (fourcc === 'VP8L' && buf.byteLength >= 29) {
    const b0 = view.getUint8(21);
    const b1 = view.getUint8(22);
    const b2 = view.getUint8(23);
    const b3 = view.getUint8(24);
    info.width = 1 + (((b1 & 0x3f) << 8) | b0);
    info.height = 1 + (((b3 & 0x0f) << 10) | (b2 << 2) | ((b1 & 0xc0) >> 6));
    info.alphaHint = (b3 & 0x10) !== 0; // 无损流 always-alpha 标志
  }
  return info;
}

/**
 * @returns {{mime:string|null,width:number,height:number,
 *           animated:boolean,alphaHint:boolean}}
 */
export function detectFormat(buffer) {
  const unknown = {
    mime: null, width: 0, height: 0, animated: false, alphaHint: false,
  };
  if (!buffer || buffer.byteLength < 12) {
    // SVG 可能很小
    if (buffer && isSvg(buffer)) return { ...unknown, mime: 'image/svg+xml' };
    return unknown;
  }
  if (isPng(buffer)) return { mime: 'image/png', ...pngInfo(buffer) };
  if (isJpeg(buffer)) return { mime: 'image/jpeg', ...jpegInfo(buffer) };
  if (isGif(buffer)) return { mime: 'image/gif', ...gifInfo(buffer) };
  if (isWebp(buffer)) return { mime: 'image/webp', ...webpInfo(buffer) };
  if (isBmp(buffer)) return { mime: 'image/bmp', ...bmpInfo(buffer) };
  if (isSvg(buffer)) return { ...unknown, mime: 'image/svg+xml' };
  return unknown;
}

// 采样解码后的位图，判断 alpha 通道是否真实使用（容器声明不代表像素真的半透明）
// 为控制大图开销，采用跨步采样；最多检查约 maxSamples 个像素。
export function inspectAlpha(imageBitmapLike, maxSamples = 1_000_000) {
  const width = imageBitmapLike.width || imageBitmapLike.videoWidth || 0;
  const height = imageBitmapLike.height || imageBitmapLike.videoHeight || 0;
  if (!width || !height) return { hasAlpha: false, checked: 0 };

  const sampleW = Math.min(width, 512);
  const sampleH = Math.min(height, 512);
  const canvas = new OffscreenCanvas(sampleW, sampleH);
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  // 大图按比例缩采样，仍能发现分布在各处的透明像素
  ctx.drawImage(imageBitmapLike, 0, 0, sampleW, sampleH);
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;

  const total = sampleW * sampleH;
  const step = Math.max(1, Math.floor(total / maxSamples));
  let transparent = 0;
  let translucent = 0;
  let checked = 0;
  for (let i = 3; i < data.length; i += 4 * step) {
    checked += 1;
    const a = data[i];
    if (a === 0) transparent += 1;
    else if (a < 255) translucent += 1;
  }
  return {
    hasAlpha: transparent > 0 || translucent > 0,
    fullyTransparent: transparent === checked,
    translucentPixels: translucent,
    transparentPixels: transparent,
    checked,
  }
}
