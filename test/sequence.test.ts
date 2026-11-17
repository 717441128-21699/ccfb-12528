import { describe, it, expect } from 'vitest';
import {
  parseFileName,
  reconstructWrapFromSeqs,
  segmentByTimestamp,
  buildTimeAxis,
} from '../src/core/sequence';
import type { FrameFile } from '../src/types';

describe('文件名解析', () => {
  it('识别纳秒时间戳与文件序号', () => {
    const r = parseFileName('cap_000123_1699999999999999999.bmp');
    expect(r.fileSeq).toBe(123);
    expect(r.timestampNs).toBe(1699999999999999999);
  });

  it('兼容 frame_ 前缀 t 紧贴时间戳', () => {
    const r = parseFileName('frame_456_t1700000000000000000.bmp');
    expect(r.fileSeq).toBe(456);
    expect(r.timestampNs).toBe(1700000000000000000);
  });

  it('只有序号时时间戳为 null', () => {
    const r = parseFileName('img_000007.bmp');
    expect(r.fileSeq).toBe(7);
    expect(r.timestampNs).toBeNull();
  });
});

describe('回绕重建', () => {
  it('检测一次回绕并按轮次恢复先后', () => {
    // 槽位 0..7，两轮：先写 0..7，第二轮写 0..3 覆盖最旧的 0..3
    const seqs = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3];
    const { order, modulo } = reconstructWrapFromSeqs(seqs);
    expect(modulo).toBe(8);
    // 重建后应为 4,5,6,7（第一轮幸存者）,0,1,2,3（第二轮）
    expect(order).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('多次回绕也能恢复（覆盖语义：仅未被后续轮重写的槽位幸存）', () => {
    // 三轮，每轮都重写 0,1,2 → 前两轮全部被覆盖；第三轮写入 0,1 后停在 2，
    // 磁盘上最终幸存：第三轮的 [5,6,7]（即原始第 6,7,8 个文件）
    const seqs = [0, 1, 2, 0, 1, 2, 0, 1];
    const { order, modulo } = reconstructWrapFromSeqs(seqs);
    expect(modulo).toBe(3);
    expect(order).toEqual([5, 6, 7]);
  });

  it('两轮回绕：首轮幸存尾部 + 次轮全部保留', () => {
    const seqs = [0, 1, 2, 3, 4, 5, 6, 7, 0, 1, 2, 3];
    const { order } = reconstructWrapFromSeqs(seqs);
    expect(order).toEqual([4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it('带纳秒时间戳时：多轮回绕也完整保留全部帧并按时间恢复先后', async () => {
    const { loadSequence } = await import('../src/core/sequence');
    // 3 轮、模 4，每轮文件序号 0..3；时间戳单调，跨轮槽位重复
    // 基数取在 Number 安全整数范围内，保证 1ms 增量不被浮点精度吞掉
    const base = 1_000_000_000_000_000;
    const files = Array.from({ length: 10 }, (_, i) => {
      const seq = i % 4;
      const ts = base + i * 1_000_000;
      return new File([new Uint8Array(10)], `cap_${String(seq).padStart(4, '0')}_${ts}.bmp`);
    });
    const seq = await loadSequence(files);
    expect(seq.frames).toHaveLength(10);
    expect(seq.detectedWrapModulo).toBe(4);
    // 时间戳单调恢复 → frameIndex 与生成序一致
    expect(seq.frames.map((f) => f.timestampNs! - seq.frames[0].timestampNs!)).toEqual(
      Array.from({ length: 10 }, (_, i) => i * 1_000_000),
    );
  });

  it('无回绕时原样返回', () => {
    const seqs = [0, 1, 2, 3];
    const { order, modulo } = reconstructWrapFromSeqs(seqs);
    expect(modulo).toBeNull();
    expect(order).toEqual([0, 1, 2, 3]);
  });
});

describe('时间戳分段与时间轴', () => {
  function mkFrames(timestamps: (number | null)[]): FrameFile[] {
    return timestamps.map((ts, i) => ({
      frameIndex: i,
      fileSeq: i,
      timestampNs: ts,
      name: `f_${i}.bmp`,
      file: null as unknown as File,
      segmentId: 0,
      indexInSegment: 0,
      timeSec: 0,
    }));
  }

  it('跳变 >10× 中位间隔处分段', () => {
    const step = 1_000_000; // 1ms
    const ts = [0, step, 2 * step, 3 * step + step * 50, 4 * step + step * 50];
    const bare = mkFrames(ts).map((f) => ({ ...f }));
    const { segments, assignment } = segmentByTimestamp(bare);
    expect(segments.length).toBe(2);
    expect(assignment).toEqual([0, 0, 0, 1, 1]);
  });

  it('buildTimeAxis 单调递增，跨段用中位间隔衔接', () => {
    const frames = mkFrames([0, 1_000_000, 50_000_000, 51_000_000]);
    const { segments, assignment } = segmentByTimestamp(frames);
    frames.forEach((f, i) => (f.segmentId = assignment[i]));
    const { times, medianDtSec } = buildTimeAxis(frames, segments);
    expect(medianDtSec).toBeCloseTo(0.001, 6);
    for (let i = 1; i < times.length; i++) expect(times[i]).toBeGreaterThan(times[i - 1]);
    // 跨段衔接使用 1ms，而不是 49ms 的真实跳变
    expect(times[2] - times[1]).toBeCloseTo(0.001, 6);
    expect(times[3] - times[2]).toBeCloseTo(0.001, 6);
  });
});
