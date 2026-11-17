/**
 * PLC 凸轮角度表导入与时间对齐
 *
 * 支持 CSV / TXT：两列（时间, 角度），逗号/空白/分号分隔，自动跳过表头行。
 * 时间单位自动识别：数值中位数 >= 1e8 视为 ns，>= 1e3 视为 ms，否则 s。
 * 角度自动解卷绕（360° 周期跳变还原为单调递增），再线性插值到每帧时间。
 */
import type { CamAngleTable } from '../types';

function parseLines(text: string): { times: number[]; angles: number[]; unit: CamAngleTable['sourceUnit'] } {
  const rows: [number, number][] = [];
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const parts = line.split(/[,;\s]+/).filter(Boolean);
    if (parts.length < 2) continue;
    const t = Number(parts[0]);
    const a = Number(parts[1]);
    if (!Number.isFinite(t) || !Number.isFinite(a)) continue; // 表头/注释行
    rows.push([t, a]);
  }
  if (rows.length < 2) {
    throw new Error('角度表至少需要两行有效数据（时间, 角度）');
  }
  const tAbs = rows.map((r) => Math.abs(r[0])).sort((a, b) => a - b);
  const tMedian = tAbs[Math.floor(tAbs.length / 2)];
  // PLC 表常见起点为 0，不能用首值判断：中位数 >=1e5 视为 ns，>=10 视为 ms，否则 s
  const unit: CamAngleTable['sourceUnit'] = tMedian >= 1e5 ? 'ns' : tMedian >= 10 ? 'ms' : 's';
  const scale = unit === 'ns' ? 1e-9 : unit === 'ms' ? 1e-3 : 1;
  return {
    times: rows.map((r) => r[0] * scale),
    angles: rows.map((r) => r[1]),
    unit,
  };
}

/** 解卷绕：相邻角度差超出 ±180° 时补整圈 */
export function unwrapAngles(angles: number[]): number[] {
  const out = [angles[0]];
  for (let i = 1; i < angles.length; i++) {
    let d = angles[i] - angles[i - 1];
    while (d > 180) d -= 360;
    while (d < -180) d += 360;
    out.push(out[i - 1] + d);
  }
  return out;
}

export function importCamTable(text: string, offsetSec = 0): CamAngleTable {
  const { times, angles, unit } = parseLines(text);
  return {
    timeSec: times,
    angleDeg: unwrapAngles(angles),
    sourceUnit: unit,
    offsetSec,
  };
}

/** 按（表时间 + offset）线性插值得到帧时间对应的角度；超出表范围返回 null */
export function anglesAtFrames(table: CamAngleTable, frameTimesSec: number[]): (number | null)[] {
  const tt = table.timeSec;
  const aa = table.angleDeg;
  const off = table.offsetSec;
  return frameTimesSec.map((tf) => {
    const t = tf - off;
    if (t < tt[0] || t > tt[tt.length - 1]) return null;
    let lo = 0;
    let hi = tt.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (tt[mid] <= t) lo = mid;
      else hi = mid;
    }
    const span = tt[hi] - tt[lo];
    const f = span === 0 ? 0 : (t - tt[lo]) / span;
    return aa[lo] + f * (aa[hi] - aa[lo]);
  });
}

/** 角度折回 0..360（显示用） */
export function wrap360(angleDeg: number): number {
  return ((angleDeg % 360) + 360) % 360;
}
