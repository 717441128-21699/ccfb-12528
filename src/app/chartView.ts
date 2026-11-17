/**
 * 通用 Canvas 曲线图：位移 / 速度 / 加速度
 *  - 横轴：时间（s）或凸轮角（°，折回 0..360 显示）
 *  - 点击/拖动曲线联动视频帧
 *  - 回弹（紫）、卡料（红）区间底纹
 */
import { store, type AxisMode } from './store';
import { wrap360 } from '../core/camTable';

export type CurveKind = 'displacement' | 'velocity' | 'acceleration';

const KIND_META: Record<CurveKind, { label: string; unit: string; color: string; key: 'displacementMm' | 'velocityMmps' | 'accelerationMmps2' }> = {
  displacement: { label: '位移', unit: 'mm', color: '#4aa8ff', key: 'displacementMm' },
  velocity: { label: '速度', unit: 'mm/s', color: '#22d65e', key: 'velocityMmps' },
  acceleration: { label: '加速度', unit: 'mm/s²', color: '#ffb03d', key: 'accelerationMmps2' },
};

export class ChartView {
  private canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private kind: CurveKind;
  private padL = 64;
  private padR = 16;
  private padT = 28;
  private padB = 38;

  constructor(container: HTMLElement, kind: CurveKind) {
    this.kind = kind;
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'chart-canvas';
    container.appendChild(this.canvas);
    const ctx = this.canvas.getContext('2d');
    if (!ctx) throw new Error('Canvas 2D 不可用');
    this.ctx = ctx;

    this.canvas.addEventListener('click', (ev) => this.seek(ev));
    this.canvas.addEventListener('mousedown', (ev) => {
      const move = (e: MouseEvent) => this.seek(e);
      const up = () => {
        window.removeEventListener('mousemove', move);
        window.removeEventListener('mouseup', up);
      };
      window.addEventListener('mousemove', move);
      window.addEventListener('mouseup', up);
    });
  }

  private seek(ev: MouseEvent): void {
    const s = store.state;
    if (!s.analysis) return;
    const rect = this.canvas.getBoundingClientRect();
    const x = ev.clientX - rect.left;
    const frac = (x - this.padL) / (this.canvas.clientWidth - this.padL - this.padR);
    const n = s.analysis.points.length;
    const idx = Math.max(0, Math.min(n - 1, Math.round(frac * (n - 1))));
    store.update({ currentFrame: idx, playing: false });
  }

  private xValue(frameIdx: number, mode: AxisMode, angle: number | null | undefined): number {
    if (mode === 'cam') {
      return angle === null || angle === undefined ? NaN : wrap360(angle);
    }
    return store.state.analysis!.points[frameIdx].timeSec;
  }

  render(): void {
    const s = store.state;
    const dpr = window.devicePixelRatio || 1;
    const cssW = this.canvas.parentElement?.clientWidth ?? 700;
    const cssH = 220;
    if (this.canvas.width !== Math.round(cssW * dpr) || this.canvas.height !== Math.round(cssH * dpr)) {
      this.canvas.width = Math.round(cssW * dpr);
      this.canvas.height = Math.round(cssH * dpr);
      this.canvas.style.width = `${cssW}px`;
      this.canvas.style.height = `${cssH}px`;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const ctx = this.ctx;
    ctx.fillStyle = '#0f1620';
    ctx.fillRect(0, 0, cssW, cssH);
    if (!s.analysis || s.analysis.points.length === 0) {
      ctx.fillStyle = '#6b7686';
      ctx.font = '13px system-ui';
      ctx.fillText('完成追踪与分析后显示曲线', cssW / 2 - 90, cssH / 2);
      return;
    }

    const pts = s.analysis.points;
    const n = pts.length;
    const mode: AxisMode = s.axisMode === 'cam' && s.camAngles ? 'cam' : 'time';
    const meta = KIND_META[this.kind];
    const xs = pts.map((p, i) => this.xValue(i, mode, p.camAngleDeg));
    const ys = pts.map((p) => p[meta.key]);
    const xMin = Math.min(...xs.filter((v) => Number.isFinite(v)));
    const xMax = Math.max(...xs.filter((v) => Number.isFinite(v)));
    let yMin = Math.min(...ys);
    let yMax = Math.max(...ys);
    if (yMin === yMax) {
      yMin -= 1;
      yMax += 1;
    }
    const yPad = (yMax - yMin) * 0.08;
    yMin -= yPad;
    yMax += yPad;

    const plotW = cssW - this.padL - this.padR;
    const plotH = cssH - this.padT - this.padB;
    const sx = (x: number) => this.padL + ((x - xMin) / (xMax - xMin || 1)) * plotW;
    const sy = (y: number) => this.padT + (1 - (y - yMin) / (yMax - yMin)) * plotH;

    // 事件底纹
    const shade = (from: number, to: number, color: string) => {
      ctx.fillStyle = color;
      ctx.fillRect(sx(xs[from]), this.padT, sx(xs[to]) - sx(xs[from]), plotH);
    };
    if (s.analysis.jam) shade(s.analysis.jam.onsetFrame, s.analysis.jam.endFrame, 'rgba(255,93,93,0.12)');
    for (const rb of s.analysis.rebounds) shade(rb.onsetFrame, rb.endFrame, 'rgba(181,107,255,0.14)');

    // 网格与坐标
    ctx.strokeStyle = '#22303f';
    ctx.lineWidth = 1;
    ctx.fillStyle = '#8b95a3';
    ctx.font = '11px ui-monospace, monospace';
    ctx.textAlign = 'right';
    for (let g = 0; g <= 4; g++) {
      const yv = yMin + ((yMax - yMin) * g) / 4;
      const y = sy(yv);
      ctx.beginPath();
      ctx.moveTo(this.padL, y);
      ctx.lineTo(cssW - this.padR, y);
      ctx.stroke();
      ctx.fillText(this.fmt(yv), this.padL - 6, y + 3);
    }
    ctx.textAlign = 'center';
    for (let g = 0; g <= 5; g++) {
      const xv = xMin + ((xMax - xMin) * g) / 5;
      const x = sx(xv);
      ctx.beginPath();
      ctx.moveTo(x, this.padT);
      ctx.lineTo(x, cssH - this.padB);
      ctx.stroke();
      ctx.fillText(mode === 'cam' ? `${xv.toFixed(0)}°` : `${xv.toFixed(3)}s`, x, cssH - this.padB + 16);
    }

    // 曲线（NaN 段自动断开）
    ctx.strokeStyle = meta.color;
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    let pen = false;
    for (let i = 0; i < n; i++) {
      if (!Number.isFinite(xs[i]) || !Number.isFinite(ys[i])) {
        pen = false;
        continue;
      }
      const x = sx(xs[i]);
      const y = sy(ys[i]);
      if (!pen) {
        ctx.moveTo(x, y);
        pen = true;
      } else {
        ctx.lineTo(x, y);
      }
    }
    ctx.stroke();

    // 当前帧光标
    const curX = sx(xs[s.currentFrame]);
    if (Number.isFinite(curX)) {
      ctx.strokeStyle = '#e6edf5';
      ctx.lineWidth = 1;
      ctx.setLineDash([4, 3]);
      ctx.beginPath();
      ctx.moveTo(curX, this.padT);
      ctx.lineTo(curX, cssH - this.padB);
      ctx.stroke();
      ctx.setLineDash([]);
      const cv = ys[s.currentFrame];
      if (Number.isFinite(cv)) {
        ctx.fillStyle = meta.color;
        ctx.beginPath();
        ctx.arc(curX, sy(cv), 3.5, 0, Math.PI * 2);
        ctx.fill();
      }
    }

    // 标题
    ctx.textAlign = 'left';
    ctx.fillStyle = meta.color;
    ctx.font = 'bold 13px system-ui';
    ctx.fillText(`${meta.label}（${meta.unit}）`, this.padL, 18);
    ctx.fillStyle = '#8b95a3';
    ctx.font = '11px system-ui';
    ctx.fillText(mode === 'cam' ? '横轴：凸轮相位角 (°)' : '横轴：时间 (s)', this.padL + 130, 18);
  }

  private fmt(v: number): string {
    const a = Math.abs(v);
    if (a >= 1000) return v.toFixed(0);
    if (a >= 10) return v.toFixed(1);
    return v.toFixed(3);
  }
}
