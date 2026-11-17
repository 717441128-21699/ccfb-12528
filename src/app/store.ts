/** 简易响应式状态仓库（发布订阅，无框架依赖） */
import type {
  AnalysisOptions,
  AnalysisResult,
  Calibration,
  CamAngleTable,
  LoadedSequence,
  TrackPoint,
} from '../types';
import { DEFAULT_ANALYSIS_OPTIONS } from '../types';
import { DEFAULT_TRACKER_OPTIONS, type TrackerOptions } from '../core/tracker';

export type InteractionMode = 'none' | 'marker' | 'calib1' | 'calib2';
export type AxisMode = 'time' | 'cam';

export interface AppState {
  sequence: LoadedSequence | null;
  loading: boolean;
  loadMessage: string;
  imagesReady: boolean;
  width: number;
  height: number;
  currentFrame: number;
  playing: boolean;
  playbackSpeed: number;
  mode: InteractionMode;
  markerClick: { x: number; y: number } | null;
  calibration: Calibration | null;
  calibDraft: { p1: { x: number; y: number } | null; p2: { x: number; y: number } | null };
  calibLengthMm: number;
  tracking: boolean;
  trackProgress: { done: number; total: number };
  tracks: TrackPoint[] | null;
  analysis: AnalysisResult | null;
  camTable: CamAngleTable | null;
  camAngles: (number | null)[] | null;
  axisMode: AxisMode;
  trackerOptions: TrackerOptions;
  analysisOptions: AnalysisOptions;
  log: string[];
}

type Listener = (state: AppState) => void;

class Store {
  state: AppState = {
    sequence: null,
    loading: false,
    loadMessage: '',
    imagesReady: false,
    width: 0,
    height: 0,
    currentFrame: 0,
    playing: false,
    playbackSpeed: 1,
    mode: 'none',
    markerClick: null,
    calibration: null,
    calibDraft: { p1: null, p2: null },
    calibLengthMm: 10,
    tracking: false,
    trackProgress: { done: 0, total: 0 },
    tracks: null,
    analysis: null,
    camTable: null,
    camAngles: null,
    axisMode: 'time',
    trackerOptions: { ...DEFAULT_TRACKER_OPTIONS },
    analysisOptions: { ...DEFAULT_ANALYSIS_OPTIONS },
    log: [],
  };

  private listeners = new Set<Listener>();

  subscribe(fn: Listener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** 局部更新并通知 */
  update(patch: Partial<AppState>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn(this.state);
  }

  logLine(msg: string): void {
    const time = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    this.update({ log: [`[${time}] ${msg}`, ...this.state.log].slice(0, 200) });
  }
}

export const store = new Store();
