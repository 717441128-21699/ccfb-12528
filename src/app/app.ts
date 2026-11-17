/** 主控制器：构建三栏界面并接线全部分析流程 */
import '../styles.css';
import { store } from './store';
import { frameStore } from './frameStore';
import { VideoView } from './videoView';
import { ChartView } from './chartView';
import { Player } from './player';
import { loadSequence } from '../core/sequence';
import { calibrate } from '../core/calibration';
import { analyzeTrack } from '../core/signal';
import { importCamTable, anglesAtFrames } from '../core/camTable';
import { synthSequence, synthToFiles } from '../core/synth';
import { readBmpSize } from '../core/bmp';
import type { TrackPoint } from '../types';

export class App {
  private video!: VideoView;
  private charts: ChartView[] = [];
  private player = new Player();
  private trackWorker: Worker | null = null;
  private unsub: (() => void) | null = null;

  constructor(root: HTMLElement) {
    root.innerHTML = `
      <header class="app-header">
        <h1>高速影像分析工具</h1>
        <span class="sub">包装机卡料分析 · BMP 序列 / 亚像素追踪 / 回弹检测 / 凸轮相位对齐（纯本地处理，数据不上传）</span>
      </header>
      <div class="layout">
        <div class="panel" id="left-panel"></div>
        <div class="center-col">
          <div class="video-wrap" id="video-container"></div>
          <div class="charts-wrap" id="charts-container"></div>
        </div>
        <div class="panel" id="right-panel"></div>
      </div>`;

    this.video = new VideoView(document.getElementById('video-container')!);
    const chartRoot = document.getElementById('charts-container')!;
    this.charts = [new ChartView(chartRoot, 'displacement'), new ChartView(chartRoot, 'velocity'), new ChartView(chartRoot, 'acceleration')];

    this.buildLeftPanel(document.getElementById('left-panel')!);
    this.buildRightPanel(document.getElementById('right-panel')!);

    this.unsub = store.subscribe(() => this.render());
    this.render();
  }

  /* ---------------- 左栏：载入 / 播放 / 标定 / 追踪 ---------------- */

  private buildLeftPanel(el: HTMLElement): void {
    el.innerHTML = `
      <h2>① 序列载入</h2>
      <input type="file" id="bmp-input" class="file-hidden" multiple accept=".bmp">
      <button class="primary" id="btn-load">选择 BMP 序列（可多选）</button>
      <button id="btn-synth">载入合成测试序列（已知轨迹）</button>
      <div id="load-info" class="hint"></div>
      <div class="seg-list" id="seg-list" hidden></div>

      <h2>② 播放</h2>
      <div class="transport">
        <button id="btn-play" style="width:64px" disabled>▶ 播放</button>
        <input type="range" id="frame-slider" min="0" max="0" value="0" disabled>
      </div>
      <div class="row" style="margin-top:6px">
        <button data-speed="0.25">0.25×</button>
        <button data-speed="1">1×</button>
        <button data-speed="4">4×</button>
        <button data-speed="10">10×</button>
      </div>

      <h2>③ 标记点追踪</h2>
      <p class="hint">在画面中推杆端部的反光片上点一下，再开始逐帧亚像素质心追踪。</p>
      <button id="btn-pick-marker" disabled>点选标记点</button>
      <div class="kv" id="marker-info"><span class="k">初始位置</span><span class="v">未选择</span></div>
      <label class="field">搜索窗半径 (px)</label>
      <input type="number" id="search-radius" min="4" max="60" value="${store.state.trackerOptions.searchRadius}">
      <label class="field">重捕获窗半径 (px)</label>
      <input type="number" id="reacquire-radius" min="8" max="120" value="${store.state.trackerOptions.reacquireRadius}">
      <button class="primary" id="btn-track" disabled>开始追踪全部帧</button>
      <div class="progress-bar" id="track-progress" hidden><div style="width:0%"></div></div>

      <h2>④ 标尺标定（像素→毫米）</h2>
      <p class="hint">在画面标尺两端各点一下，输入已知长度。不标定则位移以像素计。</p>
      <button id="btn-calib" disabled>点选标尺两端</button>
      <label class="field">标尺物理长度 (mm)</label>
      <input type="number" id="calib-length" min="0.001" step="0.1" value="${store.state.calibLengthMm}">
      <button id="btn-apply-calib" disabled>生成标定</button>
      <div class="kv" id="calib-info"></div>
    `;

    el.querySelector<HTMLButtonElement>('#btn-load')!.onclick = () => el.querySelector<HTMLInputElement>('#bmp-input')!.click();
    el.querySelector<HTMLInputElement>('#bmp-input')!.onchange = (ev) => this.onLoadFiles((ev.target as HTMLInputElement).files);
    el.querySelector<HTMLButtonElement>('#btn-synth')!.onclick = () => this.loadSynth();

    el.querySelector<HTMLButtonElement>('#btn-play')!.onclick = () => this.player.toggle();
    el.querySelector<HTMLInputElement>('#frame-slider')!.oninput = (ev) => {
      const idx = Number((ev.target as HTMLInputElement).value);
      store.update({ currentFrame: idx, playing: false });
      this.player.stop();
    };
    el.querySelectorAll<HTMLButtonElement>('[data-speed]').forEach((b) => {
      b.onclick = () => store.update({ playbackSpeed: Number(b.dataset.speed) });
    });

    el.querySelector<HTMLButtonElement>('#btn-pick-marker')!.onclick = () =>
      store.update({ mode: store.state.mode === 'marker' ? 'none' : 'marker' });
    el.querySelector<HTMLInputElement>('#search-radius')!.onchange = (ev) =>
      store.update({ trackerOptions: { ...store.state.trackerOptions, searchRadius: Number((ev.target as HTMLInputElement).value) } });
    el.querySelector<HTMLInputElement>('#reacquire-radius')!.onchange = (ev) =>
      store.update({ trackerOptions: { ...store.state.trackerOptions, reacquireRadius: Number((ev.target as HTMLInputElement).value) } });
    el.querySelector<HTMLButtonElement>('#btn-track')!.onclick = () => this.startTracking();

    el.querySelector<HTMLButtonElement>('#btn-calib')!.onclick = () =>
      store.update({ mode: store.state.mode === 'calib1' ? 'none' : 'calib1', calibDraft: { p1: null, p2: null } });
    el.querySelector<HTMLInputElement>('#calib-length')!.onchange = (ev) =>
      store.update({ calibLengthMm: Number((ev.target as HTMLInputElement).value) });
    el.querySelector<HTMLButtonElement>('#btn-apply-calib')!.onclick = () => this.applyCalibration();
  }

  /* ---------------- 右栏：凸轮表 / 参数 / 结论 / 日志 ---------------- */

  private buildRightPanel(el: HTMLElement): void {
    el.innerHTML = `
      <h2>⑤ PLC 凸轮角度表</h2>
      <input type="file" id="cam-input" class="file-hidden" accept=".csv,.txt">
      <button id="btn-cam">导入角度表 CSV（时间, 角度）</button>
      <div class="hint" id="cam-info">未导入。支持 ns/ms/s 自动识别，360° 自动解卷绕。</div>
      <label class="field">时间对齐偏移 (s)：影像 t=0 对应表内时刻</label>
      <input type="number" id="cam-offset" step="0.001" value="0">
      <div class="row">
        <button id="axis-time" class="active">横轴：时间</button>
        <button id="axis-cam">横轴：凸轮角</button>
      </div>

      <h2>⑥ 曲线分析参数</h2>
      <label class="field">SG 平滑窗口（帧，奇数）</label>
      <input type="number" id="sg-window" min="5" max="51" step="2" value="${store.state.analysisOptions.sgWindow}">
      <label class="field">SG 多项式阶数</label>
      <input type="number" id="sg-order" min="1" max="5" value="${store.state.analysisOptions.sgPolyorder}">
      <label class="field">卡料速度阈值 (mm/s)</label>
      <input type="number" id="jam-vel" step="0.5" value="${store.state.analysisOptions.jamVelocityThreshold}">
      <label class="field">卡料最短帧数</label>
      <input type="number" id="jam-frames" min="2" value="${store.state.analysisOptions.jamMinFrames}">
      <label class="field">回弹最小幅值 (mm)</label>
      <input type="number" id="rb-amp" step="0.01" value="${store.state.analysisOptions.reboundMinAmplitudeMm}">
      <button class="primary" id="btn-analyze" disabled>运行分析</button>
      <button id="btn-export" disabled>导出分析结果 CSV</button>

      <h2>⑦ 结论</h2>
      <div class="conclusion" id="conclusion"><span class="hint">完成分析后在此给出卡料结论与凸轮相位角。</span></div>

      <h2>运行日志</h2>
      <div class="log-box" id="log-box"></div>
    `;

    el.querySelector<HTMLButtonElement>('#btn-cam')!.onclick = () => el.querySelector<HTMLInputElement>('#cam-input')!.click();
    el.querySelector<HTMLInputElement>('#cam-input')!.onchange = (ev) => this.onLoadCam((ev.target as HTMLInputElement).files);
    el.querySelector<HTMLInputElement>('#cam-offset')!.onchange = (ev) => this.applyCamOffset(Number((ev.target as HTMLInputElement).value));
    el.querySelector<HTMLButtonElement>('#axis-time')!.onclick = () => store.update({ axisMode: 'time' });
    el.querySelector<HTMLButtonElement>('#axis-cam')!.onclick = () => {
      if (store.state.camAngles) store.update({ axisMode: 'cam' });
      else alert('请先导入凸轮角度表');
    };

    const bind = (id: string, key: keyof typeof store.state.analysisOptions) => {
      el.querySelector<HTMLInputElement>(`#${id}`)!.onchange = (ev) =>
        store.update({ analysisOptions: { ...store.state.analysisOptions, [key]: Number((ev.target as HTMLInputElement).value) } });
    };
    bind('sg-window', 'sgWindow');
    bind('sg-order', 'sgPolyorder');
    bind('jam-vel', 'jamVelocityThreshold');
    bind('jam-frames', 'jamMinFrames');
    bind('rb-amp', 'reboundMinAmplitudeMm');

    el.querySelector<HTMLButtonElement>('#btn-analyze')!.onclick = () => this.runAnalysis();
    el.querySelector<HTMLButtonElement>('#btn-export')!.onclick = () => this.exportCsv();
  }

  /* ---------------- 载入 ---------------- */

  private async onLoadFiles(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    await this.load(Array.from(fileList));
  }

  private async load(files: File[]): Promise<void> {
    store.update({ loading: true, loadMessage: `解析 ${files.length} 个文件…` });
    try {
      const seq = await loadSequence(files);
      if (seq.frames.length === 0) throw new Error('没有找到 BMP 文件');
      // 读第一帧头拿尺寸
      const headBuf = await seq.frames[0].file.arrayBuffer();
      const size = readBmpSize(headBuf);
      frameStore.setFiles(seq.frames.map((f) => f.file));
      frameStore.prefetch(0, 24);
      store.update({
        sequence: seq,
        width: size.width,
        height: size.height,
        currentFrame: 0,
        playing: false,
        imagesReady: true,
        tracks: null,
        analysis: null,
        markerClick: null,
        calibration: null,
        calibDraft: { p1: null, p2: null },
        loading: false,
        loadMessage: '',
      });
      store.logLine(`载入 ${seq.frames.length} 帧，${seq.segments.length} 段，中位帧间隔 ${(seq.medianDtSec * 1000).toFixed(4)} ms`);
      seq.parseWarnings.forEach((w) => store.logLine(w));
    } catch (e) {
      store.update({ loading: false, loadMessage: '' });
      alert(`载入失败：${(e as Error).message}`);
      store.logLine(`载入失败：${(e as Error).message}`);
    }
  }

  private async loadSynth(): Promise<void> {
    store.update({ loading: true, loadMessage: '合成测试序列…' });
    const synth = synthSequence({ wrap: true });
    const files = synthToFiles(synth);
    // 同时把合成的凸轮表挂到内存，供一键导入
    this.synthCamCsv = synth.camTableCsv;
    await this.load(files);
    // 合成序列自动带入标定与凸轮表，方便直接跑通全流程
    const ruler = synth.truth.ruler;
    const cal = calibrate(ruler.p1, ruler.p2, ruler.physicalMm);
    store.update({ calibration: cal, calibLengthMm: ruler.physicalMm, calibDraft: { p1: ruler.p1, p2: ruler.p2 } });
    this.importCamText(synth.camTableCsv, '合成凸轮角度表（ms，360° 循环）');
    store.logLine('合成序列已自动带入标尺标定与凸轮表，可直接点选标记点→追踪→分析');
  }

  private synthCamCsv: string | null = null;

  /* ---------------- 标定 ---------------- */

  private applyCalibration(): void {
    const s = store.state;
    const { p1, p2 } = s.calibDraft;
    if (!p1 || !p2) {
      alert('请先在画面中点选标尺两端');
      return;
    }
    const cal = calibrate(p1, p2, s.calibLengthMm);
    store.update({ calibration: cal });
    store.logLine(`标定：${cal.pixelDistance.toFixed(2)} px = ${cal.physicalMm} mm → ${cal.mmPerPixel.toFixed(5)} mm/px`);
  }

  /* ---------------- 凸轮表 ---------------- */

  private async onLoadCam(fileList: FileList | null): Promise<void> {
    if (!fileList || fileList.length === 0) return;
    const text = await fileList[0].text();
    this.importCamText(text, fileList[0].name);
  }

  private importCamText(text: string, source: string): void {
    try {
      const offset = Number((document.querySelector('#cam-offset') as HTMLInputElement)?.value ?? 0) || 0;
      const table = importCamTable(text, offset);
      store.update({ camTable: table });
      this.recomputeCamAngles();
      store.logLine(`导入凸轮表 ${source}：${table.timeSec.length} 行，单位 ${table.sourceUnit}，偏移 ${table.offsetSec}s`);
    } catch (e) {
      alert(`角度表导入失败：${(e as Error).message}`);
    }
  }

  private applyCamOffset(offset: number): void {
    if (!store.state.camTable) return;
    store.update({ camTable: { ...store.state.camTable, offsetSec: offset } });
    this.recomputeCamAngles();
    store.logLine(`凸轮表时间偏移设为 ${offset} s`);
  }

  private recomputeCamAngles(): void {
    const s = store.state;
    if (!s.camTable || !s.sequence) return;
    const angles = anglesAtFrames(s.camTable, s.sequence.frames.map((f) => f.timeSec));
    const covered = angles.filter((a) => a !== null).length;
    store.update({ camAngles: angles });
    store.logLine(`凸轮角对齐完成：${covered}/${angles.length} 帧落在表范围内`);
    // 已做过分析则自动重算，让结论中的凸轮角同步更新
    if (store.state.tracks) this.runAnalysis();
  }

  /* ---------------- 追踪 ---------------- */

  private startTracking(): void {
    const s = store.state;
    if (!s.sequence || !s.markerClick) {
      alert('请先在画面中点选标记点');
      return;
    }
    this.trackWorker?.terminate();
    this.trackWorker = new Worker(new URL('./frameWorker.ts', import.meta.url), { type: 'module' });
    store.update({ tracking: true, trackProgress: { done: 0, total: s.sequence.frames.length }, tracks: null, analysis: null });
    store.logLine('开始逐帧亚像素质心追踪…');

    this.trackWorker.onmessage = (ev: MessageEvent<import('./frameWorker').WorkerResponse>) => {
      const msg = ev.data;
      if (msg.type === 'trackProgress') {
        store.update({ trackProgress: { done: msg.done, total: msg.total } });
      } else if (msg.type === 'trackDone') {
        const points: TrackPoint[] = msg.points;
        const lost = points.filter((p) => !p.ok).length;
        store.update({ tracking: false, tracks: points });
        store.logLine(`追踪完成：${points.length} 帧，丢点 ${lost} 帧`);
        this.video.render();
      } else if (msg.type === 'trackError') {
        store.update({ tracking: false });
        alert(`追踪失败：${msg.message}`);
      }
    };

    this.trackWorker.postMessage({
      type: 'track',
      files: s.sequence.frames.map((f) => f.file),
      initX: s.markerClick.x,
      initY: s.markerClick.y,
      options: s.trackerOptions,
    });
  }

  /* ---------------- 分析 ---------------- */

  private runAnalysis(): void {
    const s = store.state;
    if (!s.sequence || !s.tracks) {
      alert('请先完成标记点追踪');
      return;
    }
    const result = analyzeTrack(
      s.tracks,
      s.sequence.frames.map((f) => f.timeSec),
      s.calibration,
      s.camAngles ?? s.sequence.frames.map(() => null),
      s.analysisOptions,
    );
    store.update({ analysis: result });
    store.logLine(
      `分析完成：检出回弹 ${result.rebounds.length} 次，卡料 ${result.jam ? `第 ${result.jam.onsetFrame + 1} 帧起停滞 ${result.jam.durationSec.toFixed(3)}s` : '未检出'}`,
    );
  }

  private exportCsv(): void {
    const s = store.state;
    if (!s.analysis) return;
    const header = 'frame,time_sec,cam_angle_deg,displacement_mm,velocity_mmps,acceleration_mmps2,tracked,x_px,y_px';
    const rows = s.analysis.points.map((p) =>
      [
        p.frameIndex,
        p.timeSec.toFixed(6),
        p.camAngleDeg === null ? '' : p.camAngleDeg.toFixed(4),
        p.displacementMm.toFixed(6),
        p.velocityMmps.toFixed(6),
        p.accelerationMmps2.toFixed(6),
        p.tracked ? 1 : 0,
        p.xPx.toFixed(4),
        p.yPx.toFixed(4),
      ].join(','),
    );
    const blob = new Blob([[header, ...rows].join('\n')], { type: 'text/csv;charset=utf-8' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'analysis_result.csv';
    a.click();
    URL.revokeObjectURL(a.href);
    store.logLine('已导出 analysis_result.csv');
  }

  /* ---------------- 状态 -> 视图 ---------------- */

  private render(): void {
    const s = store.state;
    const left = document.getElementById('left-panel')!;
    const right = document.getElementById('right-panel')!;

    // 载入信息
    const loadInfo = left.querySelector('#load-info') as HTMLElement;
    const segList = left.querySelector('#seg-list') as HTMLElement;
    if (s.sequence) {
      loadInfo.innerHTML = `共 <b>${s.sequence.frames.length}</b> 帧 · <b>${s.sequence.segments.length}</b> 段 · 中位间隔 <b>${(s.sequence.medianDtSec * 1000).toFixed(4)}</b> ms<br>
        回绕：${s.sequence.detectedWrapModulo ? `检测到（模 ${s.sequence.detectedWrapModulo}，已重建）` : '未检测到'}`;
      segList.hidden = false;
      segList.innerHTML = s.sequence.segments
        .map(
          (g) =>
            `<div>段${g.id + 1}: 帧 ${g.startFrame + 1}-${g.endFrame + 1}（${g.endFrame - g.startFrame + 1} 帧，间隔 ${
              g.medianStepNs ? (g.medianStepNs / 1e6).toFixed(3) + 'ms' : '—'
            }）</div>`,
        )
        .join('');
    } else {
      loadInfo.textContent = s.loading ? s.loadMessage : '支持一次多选整个目录的 BMP 文件。';
      segList.hidden = true;
    }

    // 播放控件
    const playBtn = left.querySelector('#btn-play') as HTMLButtonElement;
    const slider = left.querySelector('#frame-slider') as HTMLInputElement;
    playBtn.disabled = !s.sequence;
    playBtn.textContent = s.playing ? '⏸ 暂停' : '▶ 播放';
    if (s.sequence) {
      slider.disabled = false;
      slider.max = String(s.sequence.frames.length - 1);
      slider.value = String(s.currentFrame);
    } else {
      slider.disabled = true;
    }

    // 标记点 / 标定 / 追踪按钮状态
    const pickBtn = left.querySelector('#btn-pick-marker') as HTMLButtonElement;
    pickBtn.disabled = !s.sequence;
    pickBtn.classList.toggle('active', s.mode === 'marker');
    (left.querySelector('#marker-info') as HTMLElement).innerHTML = s.markerClick
      ? `<span class="k">初始位置</span><span class="v">(${s.markerClick.x.toFixed(2)}, ${s.markerClick.y.toFixed(2)}) px</span>`
      : '<span class="k">初始位置</span><span class="v">未选择</span>';
    const trackBtn = left.querySelector('#btn-track') as HTMLButtonElement;
    trackBtn.disabled = !s.sequence || !s.markerClick || s.tracking;
    trackBtn.textContent = s.tracking ? `追踪中 ${s.trackProgress.done}/${s.trackProgress.total}` : '开始追踪全部帧';
    const prog = left.querySelector('#track-progress') as HTMLElement;
    if (s.tracking) {
      prog.hidden = false;
      (prog.firstElementChild as HTMLElement).style.width = `${(s.trackProgress.done / Math.max(1, s.trackProgress.total)) * 100}%`;
    } else {
      prog.hidden = true;
    }

    const calibBtn = left.querySelector('#btn-calib') as HTMLButtonElement;
    calibBtn.disabled = !s.sequence;
    calibBtn.classList.toggle('active', s.mode === 'calib1' || s.mode === 'calib2');
    calibBtn.textContent = s.mode === 'calib1' ? '点选标尺第 1 端…' : s.mode === 'calib2' ? '点选标尺第 2 端…' : '点选标尺两端';
    const applyCalib = left.querySelector('#btn-apply-calib') as HTMLButtonElement;
    applyCalib.disabled = !(s.calibDraft.p1 && s.calibDraft.p2);
    (left.querySelector('#calib-info') as HTMLElement).innerHTML = s.calibration
      ? `<span class="k">像素距离</span><span class="v">${s.calibration.pixelDistance.toFixed(2)} px</span>
         <span class="k">物理长度</span><span class="v">${s.calibration.physicalMm} mm</span>
         <span class="k">换算系数</span><span class="v">${s.calibration.mmPerPixel.toFixed(5)} mm/px</span>`
      : '';

    // 凸轮表
    const camInfo = right.querySelector('#cam-info') as HTMLElement;
    if (s.camTable) {
      const covered = s.camAngles ? s.camAngles.filter((a) => a !== null).length : 0;
      camInfo.innerHTML = `已导入 ${s.camTable.timeSec.length} 行（单位 ${s.camTable.sourceUnit}，偏移 ${s.camTable.offsetSec}s）<br>对齐覆盖 <b>${covered}</b> 帧`;
    }
    right.querySelector('#axis-time')!.classList.toggle('active', s.axisMode === 'time');
    right.querySelector('#axis-cam')!.classList.toggle('active', s.axisMode === 'cam');

    // 分析 / 导出按钮
    (right.querySelector('#btn-analyze') as HTMLButtonElement).disabled = !s.tracks || s.tracking;
    (right.querySelector('#btn-export') as HTMLButtonElement).disabled = !s.analysis;

    this.renderConclusion();
    (right.querySelector('#log-box') as HTMLElement).textContent = s.log.join('\n');

    this.video.render();
    for (const c of this.charts) c.render();
  }

  private renderConclusion(): void {
    const el = document.getElementById('conclusion')!;
    const s = store.state;
    if (!s.analysis) {
      el.innerHTML = '<span class="hint">完成分析后在此给出卡料结论与凸轮相位角。</span>';
      return;
    }
    const a = s.analysis;
    const angleText = (v: number | null) => {
      if (v === null) return '角度表未覆盖';
      return `${(((v % 360) + 360) % 360).toFixed(2)}°`;
    };

    let html = '';
    if (a.preJamRebound) {
      const rb = a.preJamRebound;
      html += `
        <div>卡料前异常回弹 <span class="tag bad">关键事件</span></div>
        <div class="big">${angleText(rb.onsetCamAngleDeg)}</div>
        <div class="hint">回弹起始凸轮相位角（第 ${rb.onsetFrame + 1} 帧，t=${rb.onsetTimeSec.toFixed(4)}s）</div>
        <div class="kv" style="margin-top:8px">
          <span class="k">回弹幅值</span><span class="v">${rb.amplitudeMm.toFixed(3)} mm</span>
          <span class="k">持续时长</span><span class="v">${(rb.durationSec * 1000).toFixed(2)} ms</span>
          <span class="k">极值帧</span><span class="v">第 ${rb.peakFrame + 1} 帧 / ${angleText(rb.camAngleDeg)}</span>
        </div>`;
    } else {
      html += `<div>未检出满足阈值的异常回弹 <span class="tag ok">无回弹</span></div>`;
    }

    if (a.jam) {
      html += `
        <hr style="border-color:#243242;margin:10px 0">
        <div>卡料停滞 <span class="tag bad">已确认</span></div>
        <div class="kv">
          <span class="k">起始帧</span><span class="v jam-onset-frame">第 ${a.jam.onsetFrame + 1} 帧</span>
          <span class="k">停滞时长</span><span class="v">${(a.jam.durationSec * 1000).toFixed(2)} ms</span>
          <span class="k">起始凸轮角</span><span class="v">${angleText(a.jam.camAngleDeg)}</span>
        </div>`;
    } else {
      html += `<div style="margin-top:10px">未检出卡料停滞 <span class="tag ok">未卡料</span></div>`;
    }

    html += `
      <hr style="border-color:#243242;margin:10px 0">
      <div class="kv">
        <span class="k">全部回弹</span><span class="v">${a.rebounds.length} 次</span>
        <span class="k">标定系数</span><span class="v">${a.mmPerPixel.toFixed(5)} mm/px</span>
        <span class="k">帧间隔</span><span class="v">${(a.medianDtSec * 1000).toFixed(4)} ms</span>
      </div>
      <div class="hint">判据：速度阈值 ${s.analysisOptions.jamVelocityThreshold} mm/s 且持续 ≥ ${s.analysisOptions.jamMinFrames} 帧；回弹 ≥ ${s.analysisOptions.reboundMinAmplitudeMm} mm。参数可调后重新分析。</div>`;
    el.innerHTML = html;
  }
}
