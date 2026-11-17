/** 视频视图：Canvas 渲染当前帧 + 追踪点/标定线/事件叠加层，支持点击取点 */
import { store } from './store';
import { frameStore } from './frameStore';
import { wrap360 } from '../core/camTable';

export class VideoView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private offscreen: HTMLCanvasElement;
  private offCtx: CanvasRenderingContext2D;
  private displayedFrame = -1;
  /** 图像坐标 -> CSS 坐标的缩放与偏移 */
  private scale = 1;
  private offsetX = 0;
  private offsetY = 0;
  private frameReadyUnsub: (() => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'video-canvas';
    container.appendChild(this.canvas);
    this.ctx = this.canvas.getContext('2d')!;
    this.offscreen = document.createElement('canvas');
    this.offCtx = this.offscreen.getContext('2d', { willReadFrequently: true })!;

    this.canvas.addEventListener('click', (ev) => this.onClick(ev));
    this.frameReadyUnsub = frameStore.onDecoded((index) => {
      if (index === store.state.currentFrame) this.render();
    });
  }

  private onClick(ev: MouseEvent): void {
    const s = store.state;
    if (s.mode === 'none') return;
    const rect = this.canvas.getBoundingClientRect();
    const cssX = ev.clientX - rect.left;
    const cssY = ev.clientY - rect.top;
    const imgX = (cssX - this.offsetX) / this.scale;
    const imgY = (cssY - this.offsetY) / this.scale;
    if (imgX < 0 || imgY < 0 || imgX >= s.width || imgY >= s.height) return;

    if (s.mode === 'marker') {
      store.update({ markerClick: { x: imgX, y: imgY }, mode: 'none' });
      store.logLine(`标记点初始位置：(${imgX.toFixed(2)}, ${imgY.toFixed(2)}) px`);
    } else if (s.mode === 'calib1') {
      store.update({ calibDraft: { ...s.calibDraft, p1: { x: imgX, y: imgY } }, mode: 'calib2' });
    } else if (s.mode === 'calib2') {
      store.update({ calibDraft: { ...s.calibDraft, p2: { x: imgX, y: imgY } }, mode: 'none' });
    }
    this.render();
  }

  /** 按当前 store 状态重绘 */
  render(): void {
    const s = store.state;
    if (!s.sequence || s.width === 0) return;
    const frame = s.currentFrame;
    const img = frameStore.get(frame);

    const parentW = this.canvas.parentElement?.clientWidth ?? 800;
    const cssW = parentW;
    const cssH = Math.round((cssW * s.height) / s.width);
    if (this.canvas.width !== cssW || this.canvas.height !== cssH) {
      this.canvas.width = cssW;
      this.canvas.height = cssH;
    }
    this.scale = cssW / s.width;
    this.offsetX = 0;
    this.offsetY = 0;

    this.ctx.fillStyle = '#0b0f14';
    this.ctx.fillRect(0, 0, cssW, cssH);

    if (img) {
      this.displayedFrame = frame;
      this.offscreen.width = img.width;
      this.offscreen.height = img.height;
      const imgData = this.offCtx.createImageData(img.width, img.height);
      for (let i = 0, j = 0; i < img.gray.length; i++, j += 4) {
        const g = img.gray[i];
        imgData.data[j] = g;
        imgData.data[j + 1] = g;
        imgData.data[j + 2] = g;
        imgData.data[j + 3] = 255;
      }
      this.offCtx.putImageData(imgData, 0, 0);
      this.ctx.imageSmoothingEnabled = false;
      this.ctx.drawImage(this.offscreen, 0, 0, cssW, cssH);
    } else {
      this.ctx.fillStyle = '#8b95a3';
      this.ctx.font = '14px system-ui, sans-serif';
      this.ctx.fillText('解码中…', cssW / 2 - 30, cssH / 2);
    }

    this.drawOverlays();
  }

  private drawOverlays(): void {
    const s = store.state;
    const k = this.scale;
    const ctx = this.ctx;

    // 追踪点（绿色十字 + 质心圆点）
    const tp = s.tracks?.[s.currentFrame];
    if (tp) {
      const cx = tp.x * k;
      const cy = tp.y * k;
      ctx.strokeStyle = tp.ok ? '#22d65e' : '#ff5d5d';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(cx - 9, cy);
      ctx.lineTo(cx + 9, cy);
      ctx.moveTo(cx, cy - 9);
      ctx.lineTo(cx, cy + 9);
      ctx.stroke();
      ctx.beginPath();
      ctx.arc(cx, cy, 4, 0, Math.PI * 2);
      ctx.stroke();
      if (!tp.ok) {
        ctx.fillStyle = '#ff5d5d';
        ctx.font = '12px system-ui';
        ctx.fillText('丢点', cx + 10, cy - 8);
      }
    }

    // 用户点击的初始标记位置（黄色）
    if (s.markerClick) {
      const cx = s.markerClick.x * k;
      const cy = s.markerClick.y * k;
      ctx.strokeStyle = '#ffd23d';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(cx, cy, 12, 0, Math.PI * 2);
      ctx.stroke();
    }

    // 标尺标定（青色）
    const { p1, p2 } = s.calibDraft;
    if (p1) this.drawHandle(p1.x * k, p1.y * k, '#39d8ff');
    if (p2) this.drawHandle(p2.x * k, p2.y * k, '#39d8ff');
    if (p1 && p2) {
      ctx.strokeStyle = '#39d8ff';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(p1.x * k, p1.y * k);
      ctx.lineTo(p2.x * k, p2.y * k);
      ctx.stroke();
      const dist = Math.hypot(p2.x - p1.x, p2.y - p1.y);
      ctx.fillStyle = '#39d8ff';
      ctx.font = '12px system-ui';
      ctx.fillText(`${dist.toFixed(1)} px → ${s.calibLengthMm} mm`, (p1.x + p2.x) / 2 * k + 6, (p1.y + p2.y) / 2 * k - 6);
    }

    // 事件叠加：回弹（紫色区间）、卡料（红色区间）
    const ap = s.analysis?.points[s.currentFrame];
    if (ap && !ap.tracked) {
      ctx.fillStyle = 'rgba(255,93,93,0.18)';
      ctx.fillRect(0, 0, this.canvas.width, this.canvas.height);
    }
    if (s.analysis?.preJamRebound) {
      const rb = s.analysis.preJamRebound;
      if (s.currentFrame >= rb.onsetFrame && s.currentFrame <= rb.endFrame) {
        ctx.strokeStyle = '#b56bff';
        ctx.lineWidth = 2;
        ctx.strokeRect(2, 2, this.canvas.width - 4, this.canvas.height - 4);
        ctx.fillStyle = '#b56bff';
        ctx.font = 'bold 13px system-ui';
        ctx.fillText('异常回弹区间', 10, 18);
      }
    }
    if (s.analysis?.jam) {
      const jam = s.analysis.jam;
      if (s.currentFrame >= jam.onsetFrame && s.currentFrame <= jam.endFrame) {
        ctx.strokeStyle = '#ff5d5d';
        ctx.lineWidth = 2;
        ctx.strokeRect(4, 4, this.canvas.width - 8, this.canvas.height - 8);
        ctx.fillStyle = '#ff5d5d';
        ctx.font = 'bold 13px system-ui';
        ctx.fillText('卡料停滞区间', 10, 36);
      }
    }

    // 角标信息
    const frame = s.currentFrame;
    const sequence = s.sequence!;
    const fr = sequence.frames[frame];
    const angle = ap?.camAngleDeg;
    const lines = [
      `帧 ${frame + 1}/${sequence.frames.length}（段 ${fr.segmentId + 1} #${fr.indexInSegment}）`,
      `t = ${fr.timeSec.toFixed(4)} s`,
      angle !== null && angle !== undefined ? `凸轮角 = ${wrap360(angle).toFixed(2)}°` : '凸轮角 = —',
    ];
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(6, this.canvas.height - 64, 210, 58);
    ctx.fillStyle = '#dfe6ee';
    ctx.font = '12px ui-monospace, monospace';
    lines.forEach((line, i) => ctx.fillText(line, 14, this.canvas.height - 44 + i * 18));
  }

  private drawHandle(x: number, y: number, color: string): void {
    const ctx = this.ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, 6, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(x - 10, y);
    ctx.lineTo(x + 10, y);
    ctx.moveTo(x, y - 10);
    ctx.lineTo(x, y + 10);
    ctx.stroke();
  }

  dispose(): void {
    this.frameReadyUnsub?.();
    this.canvas.remove();
  }
}
