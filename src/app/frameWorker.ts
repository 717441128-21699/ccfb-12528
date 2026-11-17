/**
 * 图像处理 Worker：
 *  - decode：单帧 BMP 解码，回传灰度 buffer（所有权转移）
 *  - track：整序列逐帧解码 + 亚像素追踪，进度回传
 */
/// <reference lib="webworker" />
import { decodeBmp } from '../core/bmp';
import { trackSequence, DEFAULT_TRACKER_OPTIONS, type GrayImage, type TrackerOptions } from '../core/tracker';

declare const self: DedicatedWorkerGlobalScope;

export type WorkerRequest =
  | { type: 'decode'; index: number; file: File }
  | {
      type: 'track';
      files: File[];
      initX: number;
      initY: number;
      options: TrackerOptions;
    };

export type WorkerResponse =
  | { type: 'decoded'; index: number; width: number; height: number; gray: ArrayBuffer }
  | { type: 'decodeError'; index: number; message: string }
  | { type: 'trackProgress'; done: number; total: number }
  | { type: 'trackDone'; points: import('../types').TrackPoint[] }
  | { type: 'trackError'; message: string };

self.onmessage = async (ev: MessageEvent<WorkerRequest>) => {
  const msg = ev.data;
  if (msg.type === 'decode') {
    try {
      const buf = await msg.file.arrayBuffer();
      const img = decodeBmp(buf);
      const gray = new Uint8ClampedArray(img.gray);
      self.postMessage(
        { type: 'decoded', index: msg.index, width: img.width, height: img.height, gray: gray.buffer } satisfies WorkerResponse,
        [gray.buffer],
      );
    } catch (e) {
      self.postMessage({ type: 'decodeError', index: msg.index, message: (e as Error).message } satisfies WorkerResponse);
    }
    return;
  }

  if (msg.type === 'track') {
    try {
      const images: (GrayImage | null)[] = [];
      for (let i = 0; i < msg.files.length; i++) {
        try {
          const buf = await msg.files[i].arrayBuffer();
          const d = decodeBmp(buf);
          images.push({ width: d.width, height: d.height, gray: d.gray });
        } catch {
          images.push(null);
        }
        if ((i & 7) === 0 || i === msg.files.length - 1) {
          self.postMessage({ type: 'trackProgress', done: i + 1, total: msg.files.length } satisfies WorkerResponse);
        }
      }
      const opts: TrackerOptions = { ...DEFAULT_TRACKER_OPTIONS, ...msg.options };
      const points = trackSequence(images, msg.initX, msg.initY, opts, (done, total) => {
        self.postMessage({ type: 'trackProgress', done, total } satisfies WorkerResponse);
      });
      self.postMessage({ type: 'trackDone', points } satisfies WorkerResponse);
    } catch (e) {
      self.postMessage({ type: 'trackError', message: (e as Error).message } satisfies WorkerResponse);
    }
  }
};
