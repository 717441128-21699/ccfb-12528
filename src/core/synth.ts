/**
 * 已知运动轨迹的合成测试序列
 *
 * 生成 8 位灰度 BMP（1000 fps），画面含：
 *  - 暗背景 + 轻微传感器噪声
 *  - 高斯反光标记点（亚像素位置渲染，质心无原理性偏差，用于验证 <1px 追踪精度）
 *  - 已知物理长度的标尺（两个亮刻线，供像素/毫米标定）
 *
 * 运动脚本（像素坐标，dt = 1 ms）：
 *  0..119    匀速推进 0.20 px/帧
 *  120..127  异常回弹 -0.15 px/帧（8 帧，幅值 1.2 px）
 *  128..159  恢复推进 0.20 px/帧
 *  160..199  卡料停滞（40 帧）
 *  200..239  恢复推进 0.20 px/帧
 *
 * wrap 模式下文件序号按模 64 回绕，并在帧 80 处制造一次时间戳跳变（分段测试）。
 */
import { encodeGrayBmp } from './bmp';

export interface SynthOptions {
  width?: number;
  height?: number;
  fps?: number;
  /** 回绕模式（模拟相机循环缓存覆盖） */
  wrap?: boolean;
  wrapModulo?: number;
  /** 时间戳跳变（丢帧覆盖）发生在该帧之后，null 表示不跳变 */
  gapAfterFrame?: number | null;
  /** 随机噪声种子（确定性 LCG） */
  seed?: number;
}

export interface SynthFrame {
  name: string;
  bytes: ArrayBuffer;
  seq: number;
  timestampNs: number;
}

export interface GroundTruth {
  x: number[];
  y: number[];
  dtSec: number;
  ruler: { p1: { x: number; y: number }; p2: { x: number; y: number }; physicalMm: number };
  reboundOnsetFrame: number;
  jamOnsetFrame: number;
}

const TOTAL_FRAMES = 240;
const MARKER_Y = 90;
const MARKER_X0 = 70;
const SIGMA = 1.7;
const PEAK = 235;
const BG = 28;
const NOISE = 3;

/** 真值轨迹（像素） */
export function groundTruthTrajectory(fps = 1000): { x: number[]; y: number[] } {
  const dt = 1 / fps;
  const x: number[] = [];
  const y: number[] = [];
  let pos = MARKER_X0;
  for (let i = 0; i < TOTAL_FRAMES; i++) {
    if (i >= 1 && i <= 119) pos += 0.2;
    else if (i >= 120 && i <= 127) pos -= 0.15;
    else if (i >= 128 && i <= 159) pos += 0.2;
    else if (i >= 160 && i <= 199) {
      // 卡料停滞
    } else if (i >= 200) pos += 0.2;
    x.push(pos);
    y.push(MARKER_Y);
  }
  void dt;
  return { x, y };
}

/** 确定性 LCG，保证测试可复现 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function renderFrame(
  width: number,
  height: number,
  cx: number,
  cy: number,
  rng: () => number,
  ruler: GroundTruth['ruler'],
): Uint8ClampedArray {
  const gray = new Uint8ClampedArray(width * height);
  for (let py = 0; py < height; py++) {
    for (let px = 0; px < width; px++) {
      const dx = px - cx;
      const dy = py - cy;
      const gaussian = PEAK * Math.exp(-(dx * dx + dy * dy) / (2 * SIGMA * SIGMA));
      const noise = (rng() - 0.5) * 2 * NOISE;
      let v = BG + gaussian + noise;
      gray[py * width + px] = v < 0 ? 0 : v > 255 ? 255 : v;
    }
  }
  // 标尺：两条竖直亮刻线 + 连接横线（位于画面底部，不干扰标记点）
  const ry = ruler.p1.y;
  for (let py = ry - 8; py <= ry + 8; py++) {
    if (py < 0 || py >= height) continue;
    gray[py * width + ruler.p1.x] = 220;
    gray[py * width + ruler.p2.x] = 220;
  }
  for (let px = ruler.p1.x; px <= ruler.p2.x; px++) {
    gray[ry * width + px] = 180;
  }
  return gray;
}

export function synthSequence(opts: SynthOptions = {}): { frames: SynthFrame[]; truth: GroundTruth; camTableCsv: string } {
  const width = opts.width ?? 320;
  const height = opts.height ?? 200;
  const fps = opts.fps ?? 1000;
  const modulo = opts.wrapModulo ?? 64;
  const wrap = opts.wrap ?? false;
  const gapAfterFrame = opts.gapAfterFrame ?? (wrap ? 80 : null);
  const rng = makeRng(opts.seed ?? 20261117);

  const truthXY = groundTruthTrajectory(fps);
  const ruler = {
    p1: { x: 40, y: height - 24 },
    p2: { x: 140, y: height - 24 },
    physicalMm: 50, // 100 px = 50 mm → 0.5 mm/px
  };

  // 取在 Number.MAX_SAFE_INTEGER 范围内，保证毫秒级步进不被浮点精度吞掉
  const baseTs = 1_000_000_000_000_000; // ns（约 2001-09 的 Unix 纳秒值量级）
  const stepNs = Math.round(1e9 / fps);
  let ts = baseTs;
  const frames: SynthFrame[] = [];

  for (let i = 0; i < TOTAL_FRAMES; i++) {
    if (i > 0) {
      ts += stepNs;
      if (gapAfterFrame !== null && i === gapAfterFrame + 1) {
        ts += stepNs * 25; // 25 帧间隔的跳变 → 触发自动分段
      }
    }
    const seq = wrap ? i % modulo : i;
    const name = `cap_${String(seq).padStart(6, '0')}_${ts}.bmp`;
    const gray = renderFrame(width, height, truthXY.x[i], truthXY.y[i], rng, ruler);
    const bytes = encodeGrayBmp(gray, width, height);
    frames.push({ name, bytes, seq, timestampNs: ts });
  }

  const truth: GroundTruth = {
    x: truthXY.x,
    y: truthXY.y,
    dtSec: 1 / fps,
    ruler,
    reboundOnsetFrame: 120,
    jamOnsetFrame: 160,
  };

  // 同步生成 PLC 凸轮角度表：120 rpm → 720 °/s，时间单位 ms 混入以测试单位识别
  const camRows: string[] = ['time_ms,cam_angle_deg'];
  const camSpeed = 720;
  for (let i = 0; i <= TOTAL_FRAMES; i++) {
    const tMs = (i / fps) * 1000;
    // 角度故意在 0..360 内循环，测试解卷绕；多延 1 帧保证末帧不越界
    const ang = ((camSpeed * (i / fps)) % 360).toFixed(3);
    camRows.push(`${tMs.toFixed(3)},${ang}`);
  }

  return { frames, truth, camTableCsv: camRows.join('\n') };
}

/** 浏览器环境辅助：包装成 File 列表，直接走标准载入流程 */
export function synthToFiles(synth: { frames: SynthFrame[] }): File[] {
  return synth.frames.map((f) => new File([f.bytes], f.name, { type: 'image/bmp' }));
}
