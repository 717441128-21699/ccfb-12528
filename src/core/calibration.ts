/** 像素 - 毫米标定：画面中已知长度的标尺，两点定标 */
import type { Calibration } from '../types';

export function calibrate(
  p1: { x: number; y: number },
  p2: { x: number; y: number },
  physicalMm: number,
): Calibration {
  const pixelDistance = Math.hypot(p2.x - p1.x, p2.y - p1.y);
  if (!(pixelDistance > 0)) {
    throw new Error('标定两点重合，无法计算像素距离');
  }
  if (!(physicalMm > 0)) {
    throw new Error('标尺物理长度必须大于 0');
  }
  return {
    pixelDistance,
    physicalMm,
    mmPerPixel: physicalMm / pixelDistance,
    p1,
    p2,
  };
}
