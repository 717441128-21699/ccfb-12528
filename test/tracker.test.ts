import { describe, it, expect } from 'vitest';
import { synthSequence, groundTruthTrajectory } from '../src/core/synth';
import { decodeBmp } from '../src/core/bmp';
import { trackSequence, trackFrame, DEFAULT_TRACKER_OPTIONS, type GrayImage } from '../src/core/tracker';

function decodeAll(synth: ReturnType<typeof synthSequence>): GrayImage[] {
  return synth.frames.map((f) => {
    const d = decodeBmp(f.bytes);
    return { width: d.width, height: d.height, gray: d.gray };
  });
}

describe('亚像素质心追踪', () => {
  it('单帧静态高斯斑：质心误差远小于 1 像素（亚像素）', () => {
    const synth = synthSequence({ wrap: false, gapAfterFrame: null });
    const img = decodeBmp(synth.frames[0].bytes);
    const truth = synth.truth;
    // 故意把初始猜测点偏离真值 3px，验证 ROI + 连通域仍能锁到斑
    const { point } = trackFrame(
      img,
      0,
      truth.x[0] + 3,
      truth.y[0] - 2,
      DEFAULT_TRACKER_OPTIONS.initRoiRadius,
      DEFAULT_TRACKER_OPTIONS,
    );
    expect(point.ok).toBe(true);
    expect(Math.hypot(point.x - truth.x[0], point.y - truth.y[0])).toBeLessThan(0.35);
  });

  it('整序列追踪：逐帧 RMSE 小于 1 像素', () => {
    const synth = synthSequence({ wrap: false, gapAfterFrame: null });
    const images = decodeAll(synth);
    const truth = synth.truth;
    const points = trackSequence(images, truth.x[0], truth.y[0], DEFAULT_TRACKER_OPTIONS);

    expect(points).toHaveLength(truth.x.length);
    const trackedCount = points.filter((p) => p.ok).length;
    expect(trackedCount).toBe(truth.x.length); // 全程不丢点

    let sqe = 0;
    let maxErr = 0;
    for (let i = 0; i < points.length; i++) {
      const e = Math.hypot(points[i].x - truth.x[i], points[i].y - truth.y[i]);
      sqe += e * e;
      maxErr = Math.max(maxErr, e);
    }
    const rmse = Math.sqrt(sqe / points.length);
    // 核心验收指标
    expect(rmse).toBeLessThan(1);
    expect(maxErr).toBeLessThan(1.5);
  });

  it('回绕+跳变序列仍可对每帧正确追踪（顺序由载入层负责，这里验证逐帧独立可用）', () => {
    const synth = synthSequence({ wrap: true });
    const images = decodeAll(synth);
    const truth = synth.truth;
    const points = trackSequence(images, truth.x[0], truth.y[0], DEFAULT_TRACKER_OPTIONS);
    let sqe = 0;
    for (let i = 0; i < points.length; i++) {
      sqe += (points[i].x - truth.x[i]) ** 2 + (points[i].y - truth.y[i]) ** 2;
    }
    expect(Math.sqrt(sqe / points.length)).toBeLessThan(1);
  });

  it('纯黑帧（标记消失）正确标记丢点且不崩溃', () => {
    const w = 60;
    const h = 60;
    const blank: GrayImage = { width: w, height: h, gray: new Uint8ClampedArray(w * h).fill(10) };
    const { point } = trackFrame(blank, 0, 30, 30, 15, DEFAULT_TRACKER_OPTIONS);
    expect(point.ok).toBe(false);
    expect(point.area).toBe(0);
  });

  it('真值轨迹脚本包含回弹与停滞区段', () => {
    const t = groundTruthTrajectory();
    // 120..127 反向
    expect(t.x[121] - t.x[120]).toBeCloseTo(-0.15, 6);
    // 160..199 停滞
    expect(t.x[180] - t.x[160]).toBe(0);
    // 正常段推进
    expect(t.x[10] - t.x[9]).toBeCloseTo(0.2, 6);
  });
});
