/** 播放器：rAF 驱动，按中位帧间隔 × 倍速推进，自动预取解码 */
import { store } from './store';
import { frameStore } from './frameStore';

export class Player {
  private rafId: number | null = null;
  private lastTs: number | null = null;
  private acc = 0;

  start(): void {
    if (this.rafId !== null) return;
    this.lastTs = null;
    const tick = (ts: number) => {
      const s = store.state;
      if (!s.playing || !s.sequence) {
        this.rafId = null;
        return;
      }
      if (this.lastTs === null) this.lastTs = ts;
      const delta = (ts - this.lastTs) / 1000;
      this.lastTs = ts;
      this.acc += delta;

      const frameDur = s.sequence.medianDtSec / s.playbackSpeed;
      let advanced = false;
      // 防止后台标签页回来后一次跳太多帧
      let guard = 0;
      while (this.acc >= frameDur && guard < 32) {
        this.acc -= frameDur;
        guard++;
        advanced = true;
        const next = s.currentFrame + 1;
        if (next >= s.sequence.frames.length) {
          store.update({ playing: false, currentFrame: s.sequence.frames.length - 1 });
          this.rafId = null;
          return;
        }
        store.update({ currentFrame: next });
      }
      if (advanced) {
        const cur = store.state.currentFrame;
        frameStore.prefetch(cur + 1, cur + 24);
      }
      this.rafId = requestAnimationFrame(tick);
    };
    this.rafId = requestAnimationFrame(tick);
  }

  stop(): void {
    if (this.rafId !== null) cancelAnimationFrame(this.rafId);
    this.rafId = null;
    this.lastTs = null;
    this.acc = 0;
  }

  toggle(): void {
    const s = store.state;
    if (!s.sequence) return;
    if (s.playing) {
      this.stop();
      store.update({ playing: false });
    } else {
      if (s.currentFrame >= s.sequence.frames.length - 1) store.update({ currentFrame: 0 });
      store.update({ playing: true });
      frameStore.prefetch(store.state.currentFrame, store.state.currentFrame + 24);
      this.start();
    }
  }
}
