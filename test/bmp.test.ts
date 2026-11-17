import { describe, it, expect } from 'vitest';
import { decodeBmp, encodeGrayBmp, readBmpSize } from '../src/core/bmp';

describe('BMP 编解码', () => {
  it('8 位灰度编码后解码可往返，尺寸与像素一致', () => {
    const w = 13;
    const h = 7;
    const gray = new Uint8ClampedArray(w * h);
    for (let i = 0; i < gray.length; i++) gray[i] = (i * 37) % 256;

    const buf = encodeGrayBmp(gray, w, h);
    const dec = decodeBmp(buf);
    expect(dec.width).toBe(w);
    expect(dec.height).toBe(h);
    expect(dec.gray.length).toBe(w * h);
    // 8 位灰度往返应完全一致
    for (let i = 0; i < gray.length; i++) {
      expect(dec.gray[i]).toBe(gray[i]);
    }
  });

  it('行宽非 4 倍数时正确补齐（13px 宽）', () => {
    const w = 13;
    const h = 3;
    const gray = new Uint8ClampedArray(w * h).fill(100);
    const buf = encodeGrayBmp(gray, w, h);
    expect(buf.byteLength).toBe(14 + 40 + 1024 + Math.floor((8 * 13 + 31) / 32) * 4 * h);
    const dec = decodeBmp(buf);
    expect(dec.gray[0]).toBe(100);
  });

  it('readBmpSize 只读头即可拿到尺寸', () => {
    const buf = encodeGrayBmp(new Uint8ClampedArray(20 * 10).fill(0), 20, 10);
    expect(readBmpSize(buf)).toEqual({ width: 20, height: 10 });
  });

  it('非 BMP 数据抛出明确错误', () => {
    const bad = new ArrayBuffer(64);
    new Uint8Array(bad).fill(0x41);
    expect(() => decodeBmp(bad)).toThrow(/BMP/);
  });
});
