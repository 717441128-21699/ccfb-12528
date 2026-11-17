/**
 * BMP 序列载入：
 *  1. 文件名解析（纳秒时间戳 + 文件序号）
 *  2. 相机内存循环写满后的序号回绕重建（按回绕轮次重新排序）
 *  3. 时间戳跳变自动分段
 *  4. 重建连续时间轴
 *
 * 文件名约定（宽松匹配，数字段自动识别）：
 *   cap_000123_1699999999999999999.bmp
 *   frame_123_t1699999999999999999.bmp
 * 若文件名中存在 >= 16 位的数字段，视为纳秒时间戳；其余数字段中
 * 最后一个短数字段视为文件序号。也兼容只有序号、或只有时间戳的情况。
 */
import type { FrameFile, LoadedSequence, Segment } from '../types';

interface ParsedName {
  fileSeq: number | null;
  timestampNs: number | null;
}

export function parseFileName(name: string): ParsedName {
  // 去掉扩展名，按非数字字符切出数字段
  const stem = name.replace(/\.[^.]+$/, '');
  const tokens = stem.match(/\d+/g) ?? [];
  let timestampNs: number | null = null;
  const shortNums: number[] = [];
  for (const t of tokens) {
    if (t.length >= 16) {
      // 纳秒时间戳：2001-09 至 2286-11 之间的 Unix ns 为 19 位；16~19 位都按 ns 处理
      timestampNs = Number(t);
      if (!Number.isSafeInteger(timestampNs)) {
        // 超过安全整数时退化为 BigInt 再转 Number（ns 精度损失可接受，时间轴只用差值）
        timestampNs = Number(BigInt(t));
      }
    } else {
      shortNums.push(Number(t));
    }
  }
  const fileSeq = shortNums.length > 0 ? shortNums[shortNums.length - 1] : null;
  return { fileSeq, timestampNs };
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * 检测文件序号回绕并恢复时间先后。
 *
 * 典型现场：相机循环缓存 N 个槽位，文件名序号 0..M-1 写满后从 0 重新开始。
 * 磁盘上的文件按名字排序会得到 0,1,...,M-1, 0,1,... 之类的序列。
 *
 * 两条恢复路径：
 *  A. 文件名带纳秒时间戳（主路径）：序号下降只代表"新一轮文件"，
 *     按扫描序切轮次后，用时间戳对全部帧做稳定排序即可完整恢复先后，
 *     不会丢帧——时间戳能区分同一槽位的新旧文件。
 *  B. 无时间戳（兜底）：无法区分同名槽位的多个版本，按覆盖语义处理：
 *     某轮中的序号若在后续任一轮重新出现，视为已被覆盖丢弃，
 *     仅保留从未被重写的幸存文件。
 */
export function reconstructWrapOrder(
  items: { name: string; file: File; parsed: ParsedName }[],
): { ordered: typeof items; modulo: number | null; wrapCount: number } {
  const withSeq = items.filter((it) => it.parsed.fileSeq !== null);
  if (withSeq.length < 2) {
    return { ordered: items, modulo: null, wrapCount: 0 };
  }
  let maxSeq = -1;
  let wraps = 0;
  for (let i = 0; i < withSeq.length; i++) {
    const seq = withSeq[i].parsed.fileSeq!;
    if (seq > maxSeq) maxSeq = seq;
    if (i > 0 && seq <= withSeq[i - 1].parsed.fileSeq!) wraps++;
  }
  if (wraps === 0) {
    return { ordered: items, modulo: null, wrapCount: 0 };
  }

  const modulo = maxSeq + 1;

  // 按扫描序切轮次：序号下降即进入新一轮
  const rounds: { items: typeof items }[] = [{ items: [] }];
  for (let i = 0; i < items.length; i++) {
    if (i > 0) {
      const prev = items[i - 1].parsed.fileSeq;
      const cur = items[i].parsed.fileSeq;
      if (prev !== null && cur !== null && cur <= prev) rounds.push({ items: [] });
    }
    rounds[rounds.length - 1].items.push(items[i]);
  }

  const tsCoverage = items.filter((it) => it.parsed.timestampNs !== null).length / items.length;
  if (tsCoverage >= 0.95) {
    // 路径 A：时间戳齐全，轮次内按写入序、跨轮按时间戳稳定排序，全部帧保留
    const keyed = items.map((it, idx) => ({
      it,
      idx,
      ts: it.parsed.timestampNs as number,
      round: rounds.findIndex((r) => r.items.includes(it)),
    }));
    keyed.sort((a, b) => (a.ts !== b.ts ? a.ts - b.ts : a.idx - b.idx));
    return { ordered: keyed.map((k) => k.it), modulo, wrapCount: wraps };
  }

  // 路径 B：无时间戳，覆盖语义——仅保留后续轮未重写过的槽位
  const laterSeqs: Set<number>[] = new Array(rounds.length);
  const accumulated = new Set<number>();
  for (let r = rounds.length - 1; r >= 0; r--) {
    laterSeqs[r] = new Set(accumulated);
    for (const it of rounds[r].items) {
      if (it.parsed.fileSeq !== null) accumulated.add(it.parsed.fileSeq);
    }
  }
  const ordered = rounds
    .map((round, r) => round.items.filter((it) => it.parsed.fileSeq === null || !laterSeqs[r].has(it.parsed.fileSeq)))
    .flat();
  return { ordered, modulo, wrapCount: wraps };
}

interface BareFrame {
  name: string;
  file: File;
  fileSeq: number | null;
  timestampNs: number | null;
}

/**
 * 时间戳跳变分段。
 * 跳变判据：相邻帧时间差 > 10 × 中位帧间隔（或时间倒流），视为新段。
 * 无时间戳的序列整体作为一段。
 */
export function segmentByTimestamp(frames: BareFrame[]): {
  segments: Segment[];
  assignment: number[];
} {
  const n = frames.length;
  const assignment = new Array<number>(n).fill(0);
  if (n === 0) return { segments: [], assignment };

  const steps: number[] = [];
  for (let i = 1; i < n; i++) {
    const a = frames[i - 1].timestampNs;
    const b = frames[i].timestampNs;
    if (a !== null && b !== null && b > a) steps.push(b - a);
  }
  const medStep = median(steps);

  let segId = 0;
  for (let i = 1; i < n; i++) {
    const a = frames[i - 1].timestampNs;
    const b = frames[i].timestampNs;
    let jump = false;
    if (a === null || b === null) {
      jump = false;
    } else if (b <= a) {
      jump = true; // 时间倒流也视为分段（理论上回绕重建后不应出现）
    } else if (medStep !== null && b - a > medStep * 10) {
      jump = true;
    }
    if (jump) segId++;
    assignment[i] = segId;
  }

  const segments: Segment[] = [];
  for (let id = 0; id <= segId; id++) {
    const members = frames.map((f, i) => ({ f, i })).filter((x) => assignment[x.i] === id);
    const segSteps: number[] = [];
    for (let k = 1; k < members.length; k++) {
      const a = members[k - 1].f.timestampNs;
      const b = members[k].f.timestampNs;
      if (a !== null && b !== null && b > a) segSteps.push(b - a);
    }
    segments.push({
      id,
      startFrame: members[0].i,
      endFrame: members[members.length - 1].i,
      startTimestampNs: members[0].f.timestampNs,
      endTimestampNs: members[members.length - 1].f.timestampNs,
      medianStepNs: median(segSteps),
    });
  }
  return { segments, assignment };
}

/**
 * 构建连续时间轴（秒）：
 *  - 段内：用该段首帧时间戳归零后的真实时间戳差；
 *  - 跨段：用全局中位帧间隔衔接，保证时间单调且间隔合理；
 *  - 完全没有时间戳时：使用全局中位间隔（若也没有则 1/1000 秒，即 1000fps 名义值）。
 */
export function buildTimeAxis(frames: FrameFile[], segments: Segment[]): { times: number[]; medianDtSec: number } {
  const n = frames.length;
  if (n === 0) return { times: [], medianDtSec: 1 / 1000 };

  const allSteps: number[] = [];
  for (const s of segments) {
    if (s.medianStepNs !== null) allSteps.push(s.medianStepNs);
  }
  const globalMedianNs = median(allSteps);
  const fallbackDt = globalMedianNs !== null ? globalMedianNs / 1e9 : 1 / 1000;

  const times = new Array<number>(n).fill(0);
  let t = 0;
  for (let i = 0; i < n; i++) {
    if (i === 0) {
      t = 0;
    } else {
      const sameSeg = frames[i].segmentId === frames[i - 1].segmentId;
      const a = frames[i - 1].timestampNs;
      const b = frames[i].timestampNs;
      if (sameSeg && a !== null && b !== null && b > a) {
        t += (b - a) / 1e9;
      } else {
        t += fallbackDt;
      }
    }
    times[i] = t;
  }
  return { times, medianDtSec: fallbackDt };
}

/** 载入入口：File 列表 -> LoadedSequence（不读取像素，仅读 BMP 头校验） */
export async function loadSequence(files: File[]): Promise<LoadedSequence> {
  const parseWarnings: string[] = [];
  const bmpFiles = files
    .filter((f) => /\.bmp$/i.test(f.name))
    // 初始按文件名字典序，给回绕检测一个稳定输入（同目录选择通常已近似有序）
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));

  const parsed = bmpFiles.map((file) => {
    const p = parseFileName(file.name);
    if (p.timestampNs === null && p.fileSeq === null) {
      parseWarnings.push(`文件名中未找到任何数字段，无法定位：${file.name}`);
    }
    return { name: file.name, file, parsed: p };
  });

  const { ordered, modulo, wrapCount } = reconstructWrapOrder(parsed);
  if (wrapCount > 0) {
    parseWarnings.push(`检测到 ${wrapCount} 次文件序号回绕，按模 ${modulo} 重建了先后顺序`);
  }

  const bare = ordered.map((o) => ({
    name: o.name,
    file: o.file,
    fileSeq: o.parsed.fileSeq,
    timestampNs: o.parsed.timestampNs,
  }));

  const { segments, assignment } = segmentByTimestamp(bare);

  const segCounters = new Map<number, number>();
  const frames: FrameFile[] = bare.map((b, i) => {
    const segId = assignment[i];
    const idxInSeg = segCounters.get(segId) ?? 0;
    segCounters.set(segId, idxInSeg + 1);
    return {
      frameIndex: i,
      fileSeq: b.fileSeq,
      timestampNs: b.timestampNs,
      name: b.name,
      file: b.file,
      segmentId: segId,
      indexInSegment: idxInSeg,
      timeSec: 0,
    };
  });

  const { times, medianDtSec } = buildTimeAxis(frames, segments);
  frames.forEach((f, i) => (f.timeSec = times[i]));

  return { frames, segments, medianDtSec, parseWarnings, detectedWrapModulo: modulo };
}

export function reconstructWrapFromSeqs(seqs: (number | null)[]): { order: number[]; modulo: number | null } {
  const items: { name: string; file: File; parsed: ParsedName }[] = seqs.map((s, i) => ({
    name: `f_${i}.bmp`,
    file: null as unknown as File,
    parsed: { fileSeq: s, timestampNs: null },
  }));
  const { ordered, modulo } = reconstructWrapOrder(items);
  return { order: ordered.map((o) => items.indexOf(o)), modulo };
}
