/**
 * 轨迹信号处理
 *  - 丢点线性插值
 *  - 主运动方向（PCA）与有符号位移（像素 -> 毫米）
 *  - Savitzky-Golay 平滑，同时输出位置/速度/加速度
 *  - 卡料（停滞）检测与异常回弹检测
 */
import type {
  AnalysisOptions,
  AnalysisPoint,
  AnalysisResult,
  Calibration,
  JamEvent,
  ReboundEvent,
  TrackPoint,
} from '../types';

/* ---------------- Savitzky-Golay ---------------- */

/** 矩阵求解（高斯消元，带部分主元），解 A x = b，A 为 n×n 行优先 */
function solveLinear(A: number[][], b: number[]): number[] {
  const n = b.length;
  const M = A.map((row, i) => [...row, b[i]]);
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
    }
    if (Math.abs(M[piv][col]) < 1e-12) {
      throw new Error('SG 滤波器设计矩阵奇异，请增大窗口或降低多项式阶数');
    }
    [M[col], M[piv]] = [M[piv], M[col]];
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const factor = M[r][col] / M[col][col];
      for (let c = col; c <= n; c++) M[r][c] -= factor * M[col][c];
    }
  }
  const x = new Array<number>(n);
  for (let i = 0; i < n; i++) x[i] = M[i][n] / M[i][i];
  return x;
}

/**
 * 预计算 SG 系数（自变量 = 帧偏移，与 dt 无关）：
 * 返回 { smooth, d1, d2 }，每个为窗口长度的卷积核（中心对齐）。
 * 物理导数使用时再除以 dt、dt²。
 */
export function designSavitzkyGolay(window: number, polyorder: number): {
  smooth: number[];
  d1: number[];
  d2: number[];
} {
  const win = window % 2 === 0 ? window + 1 : window;
  const order = Math.min(polyorder, win - 1);
  const half = (win - 1) / 2;
  // A: 行=窗口内帧偏移 t，列=幂次；最小二乘 a = (A^T A)^-1 A^T y
  const ATA: number[][] = Array.from({ length: order + 1 }, () => new Array(order + 1).fill(0));
  for (let t = -half; t <= half; t++) {
    const powers: number[] = [];
    let p = 1;
    for (let k = 0; k <= order; k++) {
      powers.push(p);
      p *= t;
    }
    for (let i = 0; i <= order; i++) {
      for (let j = 0; j <= order; j++) ATA[i][j] += powers[i] * powers[j];
    }
  }
  // 中心点 t=0 处 d 阶导的选择向量：仅第 d 项为 d!（d(t^d)/dt 在 0 点 = d!）
  const rhs = [0, 1, 2].map((d) => {
    const e = new Array(order + 1).fill(0);
    e[d] = factorial(d);
    return e;
  });
  const coeffs = rhs.map((e) => solveLinear(ATA, e));
  const kernels = [0, 1, 2].map((d) => {
    const k = new Array<number>(win).fill(0);
    for (let idx = 0; idx < win; idx++) {
      const t = idx - half;
      let p = 1;
      for (let j = 0; j <= order; j++) {
        k[idx] += coeffs[d][j] * p;
        p *= t;
      }
    }
    return k;
  });
  return { smooth: kernels[0], d1: kernels[1], d2: kernels[2] };
}

function factorial(n: number): number {
  let f = 1;
  for (let i = 2; i <= n; i++) f *= i;
  return f;
}

/** SG 滤波，边界用局部多项式（截短窗口、帧索引坐标）拟合，避免边缘塌陷 */
function sgFilter(y: number[], kernels: { smooth: number[]; d1: number[]; d2: number[] }, dt: number) {
  const n = y.length;
  const half = (kernels.smooth.length - 1) / 2;
  const s = new Array<number>(n);
  const v = new Array<number>(n);
  const a = new Array<number>(n);

  for (let i = 0; i < n; i++) {
    const lo = Math.max(0, i - half);
    const hi = Math.min(n - 1, i + half);
    const central = i - half >= 0 && i + half <= n - 1;
    if (central) {
      // 中部标准卷积（核以帧偏移为坐标，导数再除以 dt）
      let ss = 0;
      let vv = 0;
      let aa = 0;
      for (let k = -half; k <= half; k++) {
        ss += kernels.smooth[k + half] * y[i + k];
        vv += kernels.d1[k + half] * y[i + k];
        aa += kernels.d2[k + half] * y[i + k];
      }
      s[i] = ss;
      v[i] = vv / dt;
      a[i] = aa / (dt * dt);
    } else {
      // 边界：以 i 为原点、帧偏移 k 为自变量的局部最小二乘多项式
      // y(k) = Σ c_k k^j；物理量 v = c1/dt，a = 2 c2/dt²
      const m = hi - lo + 1;
      const order = Math.min(3, m - 1);
      const ATA: number[][] = Array.from({ length: order + 1 }, () => new Array(order + 1).fill(0));
      const ATy = new Array(order + 1).fill(0);
      for (let idx = lo; idx <= hi; idx++) {
        const k = idx - i;
        const powers: number[] = [];
        let p = 1;
        for (let j = 0; j <= order; j++) {
          powers.push(p);
          p *= k;
        }
        for (let r = 0; r <= order; r++) {
          ATy[r] += powers[r] * y[idx];
          for (let c = 0; c <= order; c++) ATA[r][c] += powers[r] * powers[c];
        }
      }
      const poly = solveLinear(ATA, ATy);
      s[i] = poly[0];
      v[i] = (poly[1] ?? 0) / dt;
      a[i] = (2 * (poly[2] ?? 0)) / (dt * dt);
    }
  }
  return { s, v, a };
}

/* ---------------- 丢点插值 ---------------- */

export function interpolateMissing(points: TrackPoint[]): { x: number[]; y: number[]; tracked: boolean[] } {
  const n = points.length;
  const x = points.map((p) => p.x);
  const y = points.map((p) => p.y);
  const tracked = points.map((p) => p.ok);

  for (const arr of [x, y]) {
    let i = 0;
    while (i < n) {
      if (!tracked[i]) {
        const start = i;
        while (i < n && !tracked[i]) i++;
        const end = i; // 首个有效点
        const left = start - 1;
        const right = end < n ? end : -1;
        if (left >= 0 && right >= 0) {
          for (let k = start; k < end; k++) {
            arr[k] = arr[left] + ((arr[right] - arr[left]) * (k - left)) / (right - left);
          }
        } else if (left >= 0) {
          for (let k = start; k < end; k++) arr[k] = arr[left];
        } else if (right >= 0) {
          for (let k = start; k < end; k++) arr[k] = arr[right];
        }
      } else {
        i++;
      }
    }
  }
  return { x, y, tracked };
}

/* ---------------- 主运动方向 ---------------- */

export function principalAxis(x: number[], y: number[]): { dx: number; dy: number } {
  const n = x.length;
  if (n === 0) return { dx: 1, dy: 0 };
  const mx = x.reduce((s, v) => s + v, 0) / n;
  const my = y.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let syy = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    const ax = x[i] - mx;
    const ay = y[i] - my;
    sxx += ax * ax;
    syy += ay * ay;
    sxy += ax * ay;
  }
  // 2x2 对称矩阵最大特征值对应的特征向量
  const trace = sxx + syy;
  const disc = Math.sqrt(Math.max(0, (trace / 2) ** 2 - (sxx * syy - sxy * sxy)));
  const lambda1 = trace / 2 + disc;
  let dx: number;
  let dy: number;
  if (Math.abs(sxy) > 1e-12) {
    dx = lambda1 - syy;
    dy = sxy;
  } else {
    dx = sxx >= syy ? 1 : 0;
    dy = sxx >= syy ? 0 : 1;
  }
  const norm = Math.hypot(dx, dy) || 1;
  return { dx: dx / norm, dy: dy / norm };
}

/* ---------------- 回弹 / 卡料检测 ---------------- */

function detectRebounds(
  dispMm: number[],
  vel: number[],
  times: number[],
  angles: (number | null)[],
  opts: AnalysisOptions,
): ReboundEvent[] {
  const n = dispMm.length;
  const events: ReboundEvent[] = [];
  let i = 1;
  while (i < n - 1) {
    // 回弹：速度由正转负的零点（主运动方向为正位移）
    if (vel[i - 1] > 0 && vel[i] <= 0) {
      const onset = i;
      let j = i;
      while (j < n - 1 && vel[j] <= 0) j++;
      const peak = j; // 速度恢复为正，位移在该处达到回弹极小值
      let end = j;
      while (end < n - 1 && vel[end] >= 0 && dispMm[end] < dispMm[onset]) end++;
      const amplitude = dispMm[onset] - Math.min(...dispMm.slice(onset, Math.max(peak + 1, onset + 1)));
      const durationFrames = end - onset;
      if (amplitude >= opts.reboundMinAmplitudeMm && durationFrames >= opts.reboundMinFrames) {
        events.push({
          onsetFrame: onset,
          peakFrame: peak,
          endFrame: end,
          onsetTimeSec: times[onset],
          peakTimeSec: times[peak],
          amplitudeMm: amplitude,
          durationSec: times[Math.min(end, n - 1)] - times[onset],
          camAngleDeg: angles[peak],
          onsetCamAngleDeg: angles[onset],
        });
      }
      i = Math.max(i + 1, end);
    } else {
      i++;
    }
  }
  return events;
}

function detectJam(
  vel: number[],
  times: number[],
  angles: (number | null)[],
  opts: AnalysisOptions,
): JamEvent | null {
  const n = vel.length;
  let runStart = -1;
  for (let i = 0; i <= n; i++) {
    const stalled = i < n && Math.abs(vel[i]) < opts.jamVelocityThreshold;
    if (stalled && runStart < 0) runStart = i;
    if ((!stalled || i === n) && runStart >= 0) {
      const end = i - 1;
      if (end - runStart + 1 >= opts.jamMinFrames) {
        return {
          onsetFrame: runStart,
          endFrame: end,
          onsetTimeSec: times[runStart],
          durationSec: times[end] - times[runStart],
          camAngleDeg: angles[runStart],
        };
      }
      runStart = -1;
    }
  }
  return null;
}

/* ---------------- 分析入口 ---------------- */

export function analyzeTrack(
  points: TrackPoint[],
  timesSec: number[],
  calibration: Calibration | null,
  camAngles: (number | null)[],
  opts: AnalysisOptions,
): AnalysisResult {
  const n = points.length;
  if (n === 0) {
    return {
      points: [],
      rebounds: [],
      jam: null,
      preJamRebound: null,
      medianDtSec: 0,
      mmPerPixel: calibration?.mmPerPixel ?? 1,
    };
  }

  const dts: number[] = [];
  for (let i = 1; i < n; i++) {
    const d = timesSec[i] - timesSec[i - 1];
    if (d > 0) dts.push(d);
  }
  dts.sort((a, b) => a - b);
  const medianDtSec = dts.length ? dts[Math.floor(dts.length / 2)] : 1 / 1000;
  if (!(medianDtSec > 0)) {
    throw new Error('时间轴间隔非正，无法计算速度/加速度');
  }
  const mmPerPixel = calibration?.mmPerPixel ?? 1;

  const { x, y, tracked } = interpolateMissing(points);
  const axis = principalAxis(x, y);
  const proj = x.map((_, i) => x[i] * axis.dx + y[i] * axis.dy);
  const ref = proj[0];
  const dispPx = proj.map((p) => p - ref);

  // 若整体主运动为负方向，翻转坐标轴，使位移沿运动方向为正
  const net = dispPx[n - 1] - dispPx[0];
  const sign = net < 0 ? -1 : 1;
  const dispMm = dispPx.map((d) => sign * d * mmPerPixel);

  const win = Math.min(opts.sgWindow % 2 === 0 ? opts.sgWindow + 1 : opts.sgWindow, n % 2 ? n : n - 1);
  const kernels = designSavitzkyGolay(Math.max(5, win), Math.min(opts.sgPolyorder, 3));
  const { s, v, a } = sgFilter(dispMm, kernels, medianDtSec);

  const out: AnalysisPoint[] = s.map((sv, i) => ({
    frameIndex: i,
    timeSec: timesSec[i],
    displacementMm: sv,
    velocityMmps: v[i],
    accelerationMmps2: a[i],
    camAngleDeg: camAngles[i] ?? null,
    xPx: x[i],
    yPx: y[i],
    tracked: tracked[i],
  }));

  const rebounds = detectRebounds(s, v, timesSec, camAngles, opts);
  const jam = detectJam(v, timesSec, camAngles, opts);
  const preJamRebound = jam
    ? [...rebounds].reverse().find((r) => r.onsetFrame < jam.onsetFrame) ?? null
    : rebounds.length > 0
      ? rebounds[rebounds.length - 1]
      : null;

  return { points: out, rebounds, jam, preJamRebound, medianDtSec, mmPerPixel };
}
