/**
 * 帧解码缓存：单 Worker 串行解码，LRU 限制驻留帧数，
 * 播放时按需预取。缓存未命中返回 undefined 并触发后台解码，
 * 解码完成后通过订阅回调通知界面重绘。
 */
import type { GrayImage } from '../core/tracker';
import type { WorkerRequest, WorkerResponse } from './frameWorker';

class LRU<V> {
  private map = new Map<number, V>();
  constructor(private capacity: number) {}

  get(key: number): V | undefined {
    const v = this.map.get(key);
    if (v !== undefined) {
      this.map.delete(key);
      this.map.set(key, v);
    }
    return v;
  }

  set(key: number, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    this.map.set(key, value);
    while (this.map.size > this.capacity) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
  }

  clear(): void {
    this.map.clear();
  }
}

type DecodeListener = (index: number, img: GrayImage | null, error?: string) => void;

export class FrameStore {
  private worker: Worker;
  private cache = new LRU<GrayImage>(160);
  private queued = new Set<number>();
  private inFlight: number | null = null;
  private listeners = new Set<DecodeListener>();
  private files: File[] = [];

  constructor() {
    this.worker = new Worker(new URL('./frameWorker.ts', import.meta.url), { type: 'module' });
    this.worker.onmessage = (ev: MessageEvent<WorkerResponse>) => this.onMessage(ev.data);
  }

  setFiles(files: File[]): void {
    this.files = files;
    this.cache.clear();
    this.queued.clear();
    this.inFlight = null;
  }

  onDecoded(fn: DecodeListener): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private onMessage(msg: WorkerResponse): void {
    if (msg.type === 'decoded') {
      const img: GrayImage = { width: msg.width, height: msg.height, gray: new Uint8ClampedArray(msg.gray) };
      this.cache.set(msg.index, img);
      this.inFlight = null;
      this.listeners.forEach((fn) => fn(msg.index, img));
    } else if (msg.type === 'decodeError') {
      this.inFlight = null;
      this.listeners.forEach((fn) => fn(msg.index, null, msg.message));
    }
    this.pump();
  }

  private pump(): void {
    if (this.inFlight !== null) return;
    const next = this.queued.values().next().value;
    if (next === undefined) return;
    this.queued.delete(next);
    this.inFlight = next;
    const req: WorkerRequest = { type: 'decode', index: next, file: this.files[next] };
    this.worker.postMessage(req);
  }

  /** 同步取帧；未缓存时触发解码并返回 undefined */
  get(index: number): GrayImage | undefined {
    const hit = this.cache.get(index);
    if (hit !== undefined) return hit;
    this.request(index);
    return undefined;
  }

  request(index: number): void {
    if (index < 0 || index >= this.files.length) return;
    if (this.cache.get(index) !== undefined || this.queued.has(index) || this.inFlight === index) return;
    this.queued.add(index);
    this.pump();
  }

  /** 预取一段范围（滑动窗口，已在队列中的不重复入队） */
  prefetch(from: number, to: number): void {
    for (let i = Math.max(0, from); i <= Math.min(this.files.length - 1, to); i++) this.request(i);
  }

  dispose(): void {
    this.worker.terminate();
  }
}

export const frameStore = new FrameStore();
