/** 全局数据类型定义 */

/** 单帧 BMP 文件解析后的元信息（不含像素数据） */
export interface FrameFile {
  /** 全局排序后的连续帧序号（0 起） */
  frameIndex: number;
  /** 文件名中解析出的相机写文件序号（回绕前），缺失为 null */
  fileSeq: number | null;
  /** 文件名中的纳秒时间戳，解析失败为 null */
  timestampNs: number | null;
  /** 文件名（仅文件名，不含目录） */
  name: string;
  /** 浏览器 File 句柄 */
  file: File;
  /** 所属分段 id（0 起） */
  segmentId: number;
  /** 在本分段内的序号（0 起） */
  indexInSegment: number;
  /** 重建后的连续时间轴上的时间（秒），由 buildTimeAxis 填充 */
  timeSec: number;
}

/** 时间戳跳变 / 回绕形成的分段 */
export interface Segment {
  id: number;
  startFrame: number;
  endFrame: number; // 含
  startTimestampNs: number | null;
  endTimestampNs: number | null;
  /** 段内中位帧间隔（ns） */
  medianStepNs: number | null;
}

/** 完整载入的序列 */
export interface LoadedSequence {
  frames: FrameFile[];
  segments: Segment[];
  /** 全局中位帧间隔（秒），作为均匀时间轴 dt */
  medianDtSec: number;
  /** 解析异常的文件名 */
  parseWarnings: string[];
  /** 相机循环写文件序号的模（若检测到回绕） */
  detectedWrapModulo: number | null;
}

/** 单帧追踪结果 */
export interface TrackPoint {
  frameIndex: number;
  /** 亚像素质心（像素，图像坐标系，y 向下） */
  x: number;
  y: number;
  /** 有效标记区域像素数，0 表示丢点 */
  area: number;
  /** 峰值灰度，用于可信度判断 */
  peak: number;
  /** 是否成功追踪 */
  ok: boolean;
}

/** 标尺标定结果 */
export interface Calibration {
  /** 两点像素距离 */
  pixelDistance: number;
  /** 对应的物理长度（毫米） */
  physicalMm: number;
  /** 每像素毫米数 */
  mmPerPixel: number;
  p1: { x: number; y: number };
  p2: { x: number; y: number };
}

/** 一次异常回弹事件 */
export interface ReboundEvent {
  /** 回弹起始帧（运动方向开始反转处） */
  onsetFrame: number;
  /** 回弹极值帧 */
  peakFrame: number;
  /** 恢复/结束帧 */
  endFrame: number;
  onsetTimeSec: number;
  peakTimeSec: number;
  /** 回弹幅值（毫米，主运动方向为正） */
  amplitudeMm: number;
  /** 回弹持续时长（秒） */
  durationSec: number;
  /** 该帧对应的凸轮相位角（度，未对齐时为 null） */
  camAngleDeg: number | null;
  onsetCamAngleDeg: number | null;
}

/** 卡料（停滞后）事件 */
export interface JamEvent {
  /** 停滞开始帧 */
  onsetFrame: number;
  /** 停滞结束帧（或序列末尾） */
  endFrame: number;
  onsetTimeSec: number;
  durationSec: number;
  camAngleDeg: number | null;
}

/** 完整分析结果 */
export interface AnalysisResult {
  /** 逐帧分析，长度与帧数一致 */
  points: AnalysisPoint[];
  rebounds: ReboundEvent[];
  jam: JamEvent | null;
  /** 卡料前最后一次回弹（结论用） */
  preJamRebound: ReboundEvent | null;
  medianDtSec: number;
  mmPerPixel: number;
}

export interface AnalysisPoint {
  frameIndex: number;
  timeSec: number;
  /** 沿主运动方向的有符号位移（毫米，首点为 0） */
  displacementMm: number;
  /** 平滑后的速度（mm/s） */
  velocityMmps: number;
  /** 平滑后的加速度（mm/s²） */
  accelerationMmps2: number;
  /** 凸轮相位角（度，未对齐为 null） */
  camAngleDeg: number | null;
  /** 原始追踪位置（像素） */
  xPx: number;
  yPx: number;
  tracked: boolean;
}

/** PLC 凸轮角度表（按时间对齐） */
export interface CamAngleTable {
  /** 表内时间（秒） */
  timeSec: number[];
  /** 角度（度），已解卷绕 */
  angleDeg: number[];
  /** 原始首行时间（ns 或 s，由单位自动判断） */
  sourceUnit: 'ns' | 's' | 'ms';
  /** 用户/自动施加的时间偏移（秒），使表时间与影像时间对齐 */
  offsetSec: number;
}

/** 分析参数（UI 可调） */
export interface AnalysisOptions {
  sgWindow: number;
  sgPolyorder: number;
  /** 判停滞的速度阈值（mm/s） */
  jamVelocityThreshold: number;
  /** 停滞最短持续帧数 */
  jamMinFrames: number;
  /** 回弹最小幅值（mm） */
  reboundMinAmplitudeMm: number;
  /** 回弹最短持续（帧） */
  reboundMinFrames: number;
}

export const DEFAULT_ANALYSIS_OPTIONS: AnalysisOptions = {
  sgWindow: 11,
  sgPolyorder: 3,
  jamVelocityThreshold: 5,
  jamMinFrames: 8,
  reboundMinAmplitudeMm: 0.05,
  reboundMinFrames: 2,
};
