import { describe, it, expect } from 'vitest';
import {
  designSavitzkyGolay,
  analyzeTrack,
  principalAxis,
  interpolateMissing,
} from '../src/core/signal';
import { importCamTable, anglesAtFrames, unwrapAngles, wrap360 } from '../src/core/camTable';
import { synthSequence } from '../src/core/synth';
import { decodeBmp } from '../src/core/bmp';
import { trackSequence, DEFAULT_TRACKER_OPTIONS, type GrayImage } from '../src/core/tracker';
import { calibrate } from '../src/core/calibration';
import { DEFAULT_ANALYSIS_OPTIONS, type TrackPoint } from '../src/types';

describe('Savitzky-Golay 滤波器', () => {
  it('SG 卷积核性质：平滑核和为 1，一阶导核和为 0，二次抛物线零偏', () => {
    const k = designSavitzkyGolay(11, 3);
    const sumSmooth = k.smooth.reduce((a, b) => a + b, 0);
    expect(sumSmooth).toBeCloseTo(1, 10);
    expect(k.d1.reduce((a, b) => a + b, 0)).toBeCloseTo(0, 10);
    // y = 3k²+2k+1（k 为帧偏移）：卷积后在中心点应精确还原 y、一阶导 2、二阶导 6
    const y: number[] = [];
    for (let i = -5; i <= 5; i++) y.push(3 * i * i + 2 * i + 1);
    let s0 = 0;
    let d1_0 = 0;
    let d2_0 = 0;
    for (let i = 0; i < 11; i++) {
      s0 += k.smooth[i] * y[i];
      d1_0 += k.d1[i] * y[i];
      d2_0 += k.d2[i] * y[i];
    }
    expect(s0).toBeCloseTo(1, 8);
    expect(d1_0).toBeCloseTo(2, 8);
    expect(d2_0).toBeCloseTo(6, 8);
  });

  it('主运动方向对水平轨迹返回 ±(1,0)', () => {
    const x = Array.from({ length: 20 }, (_, i) => i * 1.0);
    const y = new Array(20).fill(5);
    const axis = principalAxis(x, y);
    expect(Math.abs(axis.dx)).toBeCloseTo(1, 10);
    expect(Math.abs(axis.dy)).toBeCloseTo(0, 10);
  });

  it('丢点线性插值', () => {
    const pts: TrackPoint[] = [
      { frameIndex: 0, x: 0, y: 0, area: 10, peak: 200, ok: true },
      { frameIndex: 1, x: 0, y: 0, area: 0, peak: 0, ok: false },
      { frameIndex: 2, x: 0, y: 0, area: 0, peak: 0, ok: false },
      { frameIndex: 3, x: 3, y: 0, area: 10, peak: 200, ok: true },
    ];
    const r = interpolateMissing(pts);
    expect(r.x[1]).toBeCloseTo(1, 10);
    expect(r.x[2]).toBeCloseTo(2, 10);
    expect(r.tracked[1]).toBe(false);
  });
});

describe('凸轮角度表', () => {
  it('单位自动识别（ms）并解卷绕 360° 跳变', () => {
    const csv = ['time_ms,angle', '0,350', '10,358', '20,6', '30,14'].join('\n');
    const table = importCamTable(csv);
    expect(table.sourceUnit).toBe('ms');
    expect(table.timeSec[1]).toBeCloseTo(0.01, 10);
    const uw = table.angleDeg;
    expect(uw[2]).toBeCloseTo(366, 6);
    expect(uw[3]).toBeCloseTo(374, 6);
  });

  it('帧时间线性插值角度，超界返回 null', () => {
    const table = importCamTable(['0,0', '1,90', '2,180'].join('\n'));
    const got = anglesAtFrames(table, [0, 0.5, 1.5, 2, 3]);
    expect(got[0]).toBeCloseTo(0, 6);
    expect(got[1]).toBeCloseTo(45, 6);
    expect(got[2]).toBeCloseTo(135, 6);
    expect(got[3]).toBeCloseTo(180, 6);
    expect(got[4]).toBeNull();
  });

  it('offset 参与对齐', () => {
    const table = importCamTable(['0,0', '1,90'].join('\n'));
    table.offsetSec = 0.5;
    const got = anglesAtFrames(table, [0.5, 1.5]);
    expect(got[0]).toBeCloseTo(0, 6);
    expect(got[1]).toBeCloseTo(90, 6);
  });

  it('wrap360 折回显示', () => {
    expect(wrap360(370)).toBeCloseTo(10, 6);
    expect(wrap360(-10)).toBeCloseTo(350, 6);
  });

  it('unwrapAngles 处理负向跳变', () => {
    expect(unwrapAngles([10, 5, 355, 350])).toEqual([10, 5, -5, -10]);
  });
});

describe('端到端：合成序列 -> 追踪 -> 曲线 -> 回弹/卡料 -> 凸轮角', () => {
  function buildPipeline() {
    const synth = synthSequence({ wrap: false, gapAfterFrame: null });
    const images: GrayImage[] = synth.frames.map((f) => {
      const d = decodeBmp(f.bytes);
      return { width: d.width, height: d.height, gray: d.gray };
    });
    const points = trackSequence(images, synth.truth.x[0], synth.truth.y[0], DEFAULT_TRACKER_OPTIONS);
    const times = synth.frames.map((_, i) => i * synth.truth.dtSec);
    const cal = calibrate(synth.truth.ruler.p1, synth.truth.ruler.p2, synth.truth.ruler.physicalMm);
    expect(cal.mmPerPixel).toBeCloseTo(0.5, 10);

    const table = importCamTable(synth.camTableCsv);
    const angles = anglesAtFrames(table, times);

    const result = analyzeTrack(points, times, cal, angles, {
      ...DEFAULT_ANALYSIS_OPTIONS,
      sgWindow: 9,
      reboundMinAmplitudeMm: 0.3,
      jamVelocityThreshold: 2,
      jamMinFrames: 20,
    });
    return { synth, result, angles };
  }

  it('位移量级正确（0.2 px/帧 × 0.5 mm/px = 0.1 mm/帧）', () => {
    const { result } = buildPipeline();
    const p = result.points;
    // 第 100 帧附近（回弹前）位移应接近 100*0.1 = 10 mm，给平滑留余量
    expect(p[100].displacementMm).toBeGreaterThan(8.5);
    expect(p[100].displacementMm).toBeLessThan(11.5);
  });

  it('检测到卡料停滞，起始帧接近真值 160', () => {
    const { result } = buildPipeline();
    expect(result.jam).not.toBeNull();
    expect(Math.abs(result.jam!.onsetFrame - 160)).toBeLessThanOrEqual(3);
  });

  it('检测到卡料前异常回弹，并报出凸轮相位角', () => {
    const { result } = buildPipeline();
    expect(result.preJamRebound).not.toBeNull();
    const rb = result.preJamRebound!;
    expect(Math.abs(rb.onsetFrame - 120)).toBeLessThanOrEqual(3);
    // 真值回弹 1.2px = 0.6mm
    expect(rb.amplitudeMm).toBeGreaterThan(0.35);
    expect(rb.amplitudeMm).toBeLessThan(0.9);
    expect(rb.onsetCamAngleDeg).not.toBeNull();
    // 凸轮 720°/s，第 120ms 对应 86.4°
    expect(wrap360(rb.onsetCamAngleDeg!)).toBeGreaterThan(75);
    expect(wrap360(rb.onsetCamAngleDeg!)).toBeLessThan(98);
  });

  it('速度/加速度曲线有限且无 NaN', () => {
    const { result } = buildPipeline();
    for (const p of result.points) {
      expect(Number.isFinite(p.velocityMmps)).toBe(true);
      expect(Number.isFinite(p.accelerationMmps2)).toBe(true);
      expect(Number.isFinite(p.displacementMm)).toBe(true);
    }
  });

  it('每帧都带凸轮角（表覆盖整个序列）', () => {
    const { result } = buildPipeline();
    const withAngle = result.points.filter((p) => p.camAngleDeg !== null).length;
    expect(withAngle).toBe(result.points.length);
  });
});
