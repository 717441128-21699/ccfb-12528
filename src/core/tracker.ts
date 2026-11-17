/**
 * 反光标记点追踪
 *
 * 流程：
 *  1. 首帧在点击位置附近的 ROI 内做阈值分割（亮目标暗背景），
 *     连通域筛选出距点击位置最近的标记区域；
 *  2. 灰度加权质心得到亚像素位置，权重 w = max(0, I - bg)；
 *  3. 后续帧在上一帧位置（加匀速预测）周围的搜索窗内重复分割+质心；
 *  4. 丢点（无有效连通域/面积过小）时标记 ok=false 并原地等待，
 *     下一帧扩大搜索窗尝试重捕获。
 */
import type { TrackPoint } from '../types';

export interface TrackerOptions {
  /** 首帧 ROI 半径（像素） */
  initRoiRadius: number;
  /** 常规搜索窗半径（像素） */
  searchRadius: number;
  /** 丢点后重捕获搜索窗半径（像素） */
  reacquireRadius: number;
  /** 阈值分割的相对系数：threshold = bg + ratio * (peak - bg) */
  thresholdRatio: number;
  /** 阈值相对背景的最小绝对间隔（灰度级） */
  thresholdFloor: number;
  /** 最小有效标记面积（像素） */
  minArea: number;
}

export const DEFAULT_TRACKER_OPTIONS: TrackerOptions = {
  initRoiRadius: 18,
  searchRadius: 12,
  reacquireRadius: 28,
  thresholdRatio: 0.35,
  thresholdFloor: 18,
  minArea: 3,
};

export interface GrayImage {
  width: number;
  height: number;
  gray: Uint8ClampedArray;
}

interface Roi {
  x0: number;
  y0: number;
  w: number;
  h: number;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function makeRoi(cx: number, cy: number, radius: number, imgW: number, imgH: number): Roi {
  const x0 = Math.max(0, Math.round(cx - radius));
  const y0 = Math.max(0, Math.round(cy - radius));
  const x1 = Math.min(imgW - 1, Math.round(cx + radius));
  const y1 = Math.min(imgH - 1, Math.round(cy + radius));
  return { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
}

/** 估计 ROI 内背景灰度（取 30 百分位，抗亮目标干扰） */
function estimateBackground(roi: Roi, img: GrayImage): number {
  const values: number[] = [];
  for (let y = roi.y0; y < roi.y0 + roi.h; y++) {
    for (let x = roi.x0; x < roi.x0 + roi.w; x++) {
      values.push(img.gray[y * img.width + x]);
    }
  }
  values.sort((a, b) => a - b);
  return values[Math.floor(values.length * 0.3)] ?? 0;
}

interface Component {
  pixels: number[]; // 展开的 x,y 对
  peak: number;
}

/** 在 ROI 内做 4 邻域连通域（迭代洪水填充，避免递归爆栈） */
function findComponents(roi: Roi, img: GrayImage, threshold: number): Component[] {
  const labels = new Int32Array(roi.w * roi.h).fill(-1);
  const comps: Component[] = [];

  for (let sy = 0; sy < roi.h; sy++) {
    for (let sx = 0; sx < roi.w; sx++) {
      const startIdx = sy * roi.w + sx;
      if (labels[startIdx] !== -1) continue;
      const gx = roi.x0 + sx;
      const gy = roi.y0 + sy;
      if (img.gray[gy * img.width + gx] < threshold) continue;

      const id = comps.length;
      const pixels: number[] = [];
      let peak = 0;
      const stack: number[] = [startIdx];
      labels[startIdx] = id;
      while (stack.length > 0) {
        const idx = stack.pop()!;
        const lx = idx % roi.w;
        const ly = (idx - lx) / roi.w;
        const ax = roi.x0 + lx;
        const ay = roi.y0 + ly;
        const g = img.gray[ay * img.width + ax];
        if (g > peak) peak = g;
        pixels.push(ax, ay);

        const neighbors = [
          lx > 0 ? idx - 1 : -1,
          lx < roi.w - 1 ? idx + 1 : -1,
          ly > 0 ? idx - roi.w : -1,
          ly < roi.h - 1 ? idx + roi.w : -1,
        ];
        for (const ni of neighbors) {
          if (ni < 0 || labels[ni] !== -1) continue;
          const nx = ni % roi.w;
          const ny = (ni - nx) / roi.w;
          const ng = img.gray[(roi.y0 + ny) * img.width + (roi.x0 + nx)];
          if (ng >= threshold) {
            labels[ni] = id;
            stack.push(ni);
          } else {
            labels[ni] = -2; // 确认过的背景，避免重复判断
          }
        }
      }
      comps.push({ pixels, peak });
    }
  }
  return comps;
}

/** 灰度加权亚像素质心，权重 max(0, I - bg) */
function weightedCentroid(comp: Component, img: GrayImage, bg: number): { x: number; y: number; area: number; peak: number } {
  let sumW = 0;
  let sumX = 0;
  let sumY = 0;
  let peak = 0;
  for (let k = 0; k < comp.pixels.length; k += 2) {
    const x = comp.pixels[k];
    const y = comp.pixels[k + 1];
    const g = img.gray[y * img.width + x];
    const w = g - bg;
    if (w <= 0) continue;
    sumW += w;
    sumX += w * x;
    sumY += w * y;
    if (g > peak) peak = g;
  }
  if (sumW <= 0) {
    // 兜底：几何质心
    let sx = 0;
    let sy = 0;
    for (let k = 0; k < comp.pixels.length; k += 2) {
      sx += comp.pixels[k];
      sy += comp.pixels[k + 1];
    }
    const n = comp.pixels.length / 2;
    return { x: sx / n, y: sy / n, area: n, peak: comp.peak };
  }
  return { x: sumX / sumW, y: sumY / sumW, area: comp.pixels.length / 2, peak };
}

function pickComponent(
  comps: Component[],
  targetX: number,
  targetY: number,
  minArea: number,
): Component | null {
  let best: Component | null = null;
  let bestDist = Infinity;
  for (const c of comps) {
    if (c.pixels.length / 2 < minArea) continue;
    let cx = 0;
    let cy = 0;
    for (let k = 0; k < c.pixels.length; k += 2) {
      cx += c.pixels[k];
      cy += c.pixels[k + 1];
    }
    const n = c.pixels.length / 2;
    cx /= n;
    cy /= n;
    const d = (cx - targetX) ** 2 + (cy - targetY) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

export interface SingleTrackResult {
  point: TrackPoint;
  bg: number;
  threshold: number;
}

/** 单帧追踪（可独立调用，便于测试） */
export function trackFrame(
  img: GrayImage,
  frameIndex: number,
  predictedX: number,
  predictedY: number,
  radius: number,
  opts: TrackerOptions,
): SingleTrackResult {
  const roi = makeRoi(predictedX, predictedY, radius, img.width, img.height);
  const bg = estimateBackground(roi, img);

  let peak = 0;
  for (let y = roi.y0; y < roi.y0 + roi.h; y++) {
    for (let x = roi.x0; x < roi.x0 + roi.w; x++) {
      const g = img.gray[y * img.width + x];
      if (g > peak) peak = g;
    }
  }
  const threshold = Math.min(255, bg + Math.max(opts.thresholdFloor, opts.thresholdRatio * (peak - bg)));

  const comps = findComponents(roi, img, threshold);
  const comp = pickComponent(comps, predictedX, predictedY, opts.minArea);
  if (!comp) {
    return {
      point: { frameIndex, x: predictedX, y: predictedY, area: 0, peak, ok: false },
      bg,
      threshold,
    };
  }
  const c = weightedCentroid(comp, img, bg);
  return {
    point: { frameIndex, x: c.x, y: c.y, area: c.area, peak: c.peak, ok: true },
    bg,
    threshold,
  };
}

/**
 * 整序列追踪。
 * @param images 已解码灰度图（null 表示该帧解码失败，直接记丢点）
 * @param initX / initY 用户点击的首帧标记位置
 */
export function trackSequence(
  images: (GrayImage | null)[],
  initX: number,
  initY: number,
  opts: TrackerOptions = DEFAULT_TRACKER_OPTIONS,
  onProgress?: (done: number, total: number) => void,
): TrackPoint[] {
  const results: TrackPoint[] = [];
  let prevX = initX;
  let prevY = initY;
  let velX = 0;
  let velY = 0;
  let missStreak = 0;

  for (let i = 0; i < images.length; i++) {
    const img = images[i];
    if (!img) {
      results.push({ frameIndex: i, x: prevX, y: prevY, area: 0, peak: 0, ok: false });
      missStreak++;
      onProgress?.(i + 1, images.length);
      continue;
    }

    const predX = prevX + velX;
    const predY = prevY + velY;
    const radius = missStreak > 0 ? opts.reacquireRadius : i === 0 ? opts.initRoiRadius : opts.searchRadius;
    const { point } = trackFrame(img, i, predX, predY, radius, opts);

    if (point.ok) {
      if (i > 0 && missStreak === 0) {
        // 一阶低通更新速度估计，抑制质心抖动
        velX = 0.5 * velX + 0.5 * (point.x - prevX);
        velY = 0.5 * velY + 0.5 * (point.y - prevY);
      } else {
        velX = 0;
        velY = 0;
      }
      prevX = point.x;
      prevY = point.y;
      missStreak = 0;
    } else {
      missStreak++;
      velX = 0;
      velY = 0;
    }
    results.push(point);
    onProgress?.(i + 1, images.length);
  }
  return results;
}
