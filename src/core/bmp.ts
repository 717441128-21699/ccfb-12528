/**
 * BMP 编解码（纯 TypeScript，无外部依赖）
 *
 * 解码支持：
 *  - 8 位索引色（BI_RGB，灰度/彩色调色板）
 *  - 24 位 BGR（BI_RGB）
 *  - 32 位 BGRA（BI_RGB / BI_BITFIELDS，标准 8-8-8 掩码，通用位域提取兜底）
 *  - 自上而下（负高度）与自下而上两种行序
 *
 * 不支持 RLE / JPEG / PNG 压缩，遇到时抛出明确错误。
 */

export interface DecodedImage {
  width: number;
  height: number;
  /** 灰度，长度 width*height，行优先、自上而下 */
  gray: Uint8ClampedArray;
  /** RGBA，长度 width*height*4 */
  rgba: Uint8ClampedArray;
}

const BI_RGB = 0;
const BI_BITFIELDS = 3;

interface ParsedHeader {
  pixelOffset: number;
  width: number;
  height: number; // 正=自下而上，负=自上而下
  topDown: boolean;
  bpp: number;
  compression: number;
  redMask: number;
  greenMask: number;
  blueMask: number;
  palette: Uint8Array | null; // BGRA 调色板
}

function parseHeader(dv: DataView): ParsedHeader {
  if (dv.byteLength < 54 || dv.getUint8(0) !== 0x42 /* B */ || dv.getUint8(1) !== 0x4d /* M */) {
    throw new Error('不是合法的 BMP 文件（缺少 BM 文件头）');
  }
  const pixelOffset = dv.getUint32(10, true);
  const dibSize = dv.getUint32(14, true);
  const width = dv.getInt32(18, true);
  const rawHeight = dv.getInt32(22, true);
  const bpp = dv.getUint16(28, true);
  const compression = dv.getUint32(30, true);

  if (dibSize < 40) {
    throw new Error(`不支持的 DIB 头类型（大小 ${dibSize}），仅支持 BITMAPINFOHEADER 及更新版本`);
  }
  if (width <= 0 || rawHeight === 0) {
    throw new Error('BMP 图像尺寸非法');
  }
  const topDown = rawHeight < 0;
  const height = Math.abs(rawHeight);

  let redMask = 0x00ff0000;
  let greenMask = 0x0000ff00;
  let blueMask = 0x000000ff;
  if (compression === BI_BITFIELDS && dibSize >= 52) {
    redMask = dv.getUint32(54, true);
    greenMask = dv.getUint32(58, true);
    blueMask = dv.getUint32(62, true);
  }

  let palette: Uint8Array | null = null;
  if (bpp === 8) {
    if (compression !== BI_RGB) {
      throw new Error(`8 位 BMP 仅支持 BI_RGB（未压缩），收到 compression=${compression}`);
    }
    const colorsUsed = dv.getUint32(46, true);
    const count = colorsUsed === 0 ? 256 : Math.min(colorsUsed, 256);
    const paletteStart = 14 + dibSize;
    palette = new Uint8Array(count * 4);
    palette.set(new Uint8Array(dv.buffer, dv.byteOffset + paletteStart, count * 4));
  } else if (bpp === 24) {
    if (compression !== BI_RGB) {
      throw new Error('24 位 BMP 仅支持 BI_RGB 未压缩格式');
    }
  } else if (bpp === 32) {
    if (compression !== BI_RGB && compression !== BI_BITFIELDS) {
      throw new Error(`32 位 BMP 不支持 compression=${compression}`);
    }
  } else {
    throw new Error(`不支持的位深 ${bpp}（支持 8/24/32 位）`);
  }

  return { pixelOffset, width, height, topDown, bpp, compression, redMask, greenMask, blueMask, palette };
}

/** 通用位域提取：mask 必须是连续的 1 */
function extractField(value: number, mask: number): number {
  if (mask === 0) return 0;
  const shift = Math.log2(mask & -mask);
  const bits = Math.round(Math.log2(mask + 1)) - shift;
  const raw = (value & mask) >>> shift;
  const maxValue = (1 << bits) - 1;
  return bits === 8 ? raw : Math.round((raw * 255) / maxValue);
}

function rowStride(width: number, bpp: number): number {
  return Math.floor((bpp * width + 31) / 32) * 4;
}

export function decodeBmp(buffer: ArrayBuffer): DecodedImage {
  const dv = new DataView(buffer);
  const h = parseHeader(dv);
  const bytes = new Uint8Array(buffer);
  const { width, height } = h;
  const stride = rowStride(width, h.bpp);
  const gray = new Uint8ClampedArray(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);

  for (let row = 0; row < height; row++) {
    const srcRow = h.topDown ? row : height - 1 - row;
    const srcStart = h.pixelOffset + srcRow * stride;
    const dstStart = row * width;

    if (h.bpp === 8) {
      const pal = h.palette!;
      for (let x = 0; x < width; x++) {
        const idx = bytes[srcStart + x];
        const p = Math.min(idx, pal.length / 4 - 1) * 4;
        const b = pal[p];
        const g = pal[p + 1];
        const r = pal[p + 2];
        const di = dstStart + x;
        rgba[di * 4] = r;
        rgba[di * 4 + 1] = g;
        rgba[di * 4 + 2] = b;
        rgba[di * 4 + 3] = 255;
        gray[di] = luma(r, g, b);
      }
    } else if (h.bpp === 24) {
      for (let x = 0; x < width; x++) {
        const s = srcStart + x * 3;
        const b = bytes[s];
        const g = bytes[s + 1];
        const r = bytes[s + 2];
        const di = dstStart + x;
        rgba[di * 4] = r;
        rgba[di * 4 + 1] = g;
        rgba[di * 4 + 2] = b;
        rgba[di * 4 + 3] = 255;
        gray[di] = luma(r, g, b);
      }
    } else {
      // 32 位
      for (let x = 0; x < width; x++) {
        const s = srcStart + x * 4;
        const px = dv.getUint32(s, true);
        const r = extractField(px, h.redMask);
        const g = extractField(px, h.greenMask);
        const b = extractField(px, h.blueMask);
        const di = dstStart + x;
        rgba[di * 4] = r;
        rgba[di * 4 + 1] = g;
        rgba[di * 4 + 2] = b;
        rgba[di * 4 + 3] = 255;
        gray[di] = luma(r, g, b);
      }
    }
  }

  return { width, height, gray, rgba };
}

/** 仅读取尺寸，不解码像素（用于载入时快速建立序列信息） */
export function readBmpSize(buffer: ArrayBuffer): { width: number; height: number } {
  const dv = new DataView(buffer);
  if (dv.byteLength < 26 || dv.getUint8(0) !== 0x42 || dv.getUint8(1) !== 0x4d) {
    throw new Error('不是合法的 BMP 文件');
  }
  return { width: dv.getInt32(18, true), height: Math.abs(dv.getInt32(22, true)) };
}

function luma(r: number, g: number, b: number): number {
  // 四舍五入，保证 8 位灰度编码-解码往返一致
  return Math.round((r * 299 + g * 587 + b * 114) / 1000);
}

/**
 * 将灰度图编码为 8 位灰度 BMP（BI_RGB，256 色调色板，自下而上）。
 * 用于合成已知轨迹的测试序列。
 */
export function encodeGrayBmp(gray: Uint8Array | Uint8ClampedArray, width: number, height: number): ArrayBuffer {
  if (gray.length !== width * height) {
    throw new Error('灰度数据长度与宽高不匹配');
  }
  const stride = rowStride(width, 8);
  const paletteSize = 256 * 4;
  const pixelOffset = 14 + 40 + paletteSize;
  const imageSize = stride * height;
  const fileSize = pixelOffset + imageSize;
  const buf = new ArrayBuffer(fileSize);
  const dv = new DataView(buf);
  const bytes = new Uint8Array(buf);

  // BITMAPFILEHEADER
  dv.setUint8(0, 0x42);
  dv.setUint8(1, 0x4d);
  dv.setUint32(2, fileSize, true);
  dv.setUint16(6, 0, true);
  dv.setUint16(8, 0, true);
  dv.setUint32(10, pixelOffset, true);

  // BITMAPINFOHEADER
  dv.setUint32(14, 40, true);
  dv.setInt32(18, width, true);
  dv.setInt32(22, height, true); // 正数 = 自下而上
  dv.setUint16(26, 1, true);
  dv.setUint16(28, 8, true);
  dv.setUint32(30, BI_RGB, true);
  dv.setUint32(34, imageSize, true);
  dv.setInt32(38, 2835, true); // 72 DPI
  dv.setInt32(42, 2835, true);
  dv.setUint32(46, 256, true);
  dv.setUint32(50, 0, true);

  // 灰度调色板 B,G,R,0
  for (let i = 0; i < 256; i++) {
    const p = 54 + i * 4;
    bytes[p] = i;
    bytes[p + 1] = i;
    bytes[p + 2] = i;
    bytes[p + 3] = 0;
  }

  // 像素，自下而上写入，行内 4 字节对齐补零
  for (let row = 0; row < height; row++) {
    const srcRow = height - 1 - row;
    const dst = pixelOffset + row * stride;
    bytes.set(gray.subarray(srcRow * width, srcRow * width + width), dst);
  }
  return buf;
}
