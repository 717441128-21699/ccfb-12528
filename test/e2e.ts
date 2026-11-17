/**
 * 浏览器端到端验证：
 *  载入合成序列 → 检查分段/回绕信息 → 点选标记点 → 追踪 → 分析 →
 *  校验结论中的回弹凸轮角与卡料事件 → 切凸轮角横轴 → 导出 CSV
 */
import { chromium, type Page } from 'playwright';

const URL = 'http://localhost:5173/';

async function expect(page: Page, cond: Promise<boolean> | boolean, label: string) {
  const ok = await cond;
  if (!ok) throw new Error(`断言失败：${label}`);
  console.log('  ✓', label);
}

async function waitForButton(page: Page, selector: string, timeoutMs = 30000) {
  await page.waitForFunction(
    (sel) => {
      const b = document.querySelector(sel) as HTMLButtonElement | null;
      return !!b && !b.disabled;
    },
    selector,
    { timeout: timeoutMs },
  );
}

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1680, height: 1000 } });
const errors: string[] = [];
page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
page.on('console', (msg) => {
  if (msg.type() === 'error') errors.push(`console.error: ${msg.text()}`);
});

await page.goto(URL);
console.log('① 载入合成测试序列');
await page.click('#btn-synth');
await page.waitForFunction(() => {
  const info = document.querySelector('#load-info')?.textContent ?? '';
  return info.includes('240 帧');
}, { timeout: 15000 });
const loadText = await page.textContent('#load-info');
console.log('  载入信息:', loadText?.replace(/\s+/g, ' ').trim());
await expect(page, loadText!.includes('回绕：检测到（模 64'), '检测到模 64 回绕并重建');
const segText = await page.textContent('#seg-list');
await expect(page, (segText?.match(/段\d/g) ?? []).length >= 2, `时间戳跳变自动分段（${(segText?.match(/段\d/g) ?? []).length} 段）`);

console.log('② 播放与逐帧浏览');
await page.click('#btn-play');
await page.waitForTimeout(300);
await page.click('#btn-play');
const frameDuring = await page.inputValue('#frame-slider');
await expect(page, Number(frameDuring) > 0, `播放推进到第 ${Number(frameDuring) + 1} 帧`);
await page.fill('#frame-slider', '0');
await page.dispatchEvent('#frame-slider', 'input');

console.log('③ 在画面中点选标记点（真值首帧位置 70,90，按画布缩放换算）');
await page.click('#btn-pick-marker');
const box = await page.locator('.video-canvas').boundingBox();
if (!box) throw new Error('找不到视频画布');
// 合成图 320×200，标记点 (70,90)；画布宽度=容器宽，按比例映射
await page.mouse.click(box.x + (70 / 320) * box.width, box.y + (90 / 200) * box.height);
await page.waitForFunction(() => (document.querySelector('#marker-info')?.textContent ?? '').includes('初始位置('));
const markerInfo = await page.textContent('#marker-info');
console.log('  ', markerInfo?.trim());

console.log('④ 开始逐帧追踪（Worker）');
await page.click('#btn-track');
await page.waitForFunction(
  () => {
    const b = document.querySelector('#btn-track') as HTMLButtonElement;
    return !!b && !b.disabled && b.textContent?.includes('开始追踪');
  },
  { timeout: 60000 },
);
const logAfterTrack = await page.textContent('#log-box');
await expect(page, logAfterTrack!.includes('追踪完成'), '追踪完成');
await expect(page, logAfterTrack!.includes('丢点 0 帧'), '全程无丢点');

console.log('⑤ 运行分析（标定与凸轮表已随合成序列自动带入）');
await page.click('#btn-analyze');
await page.waitForFunction(() => (document.querySelector('#conclusion')?.textContent ?? '').includes('关键事件'));
const conclusion = await page.textContent('#conclusion');
console.log('  结论文本:', conclusion?.replace(/\s+/g, ' ').trim().slice(0, 260));
await expect(page, conclusion!.includes('卡料前异常回弹'), '报出卡料前异常回弹');
// 真值：第 121 帧（index 120），凸轮 720°/s × 0.120s = 86.4°
const angleMatch = conclusion!.match(/(\d+\.\d{2})°/);
await expect(page, !!angleMatch, '结论包含凸轮相位角数值');
const angle = Number(angleMatch![1]);
await expect(page, angle > 75 && angle < 98, `回弹起始凸轮角 ${angle}° 接近真值 86.4°`);
await expect(page, conclusion!.includes('卡料停滞'), '确认卡料停滞事件');
const jamFrameText = await page.textContent('.jam-onset-frame');
const jamFrame = Number(jamFrameText?.match(/\d+/)?.[0]);
// SG 平滑过渡使速度穿越阈值滞后真值若干帧，容差 5 帧
await expect(page, Math.abs(jamFrame - 161) <= 5, `卡料起始帧 ${jamFrame} 接近真值 161`);

console.log('⑥ 切换横轴为凸轮角并检查曲线渲染');
await page.click('#axis-cam');
await page.waitForFunction(() => document.querySelector('#axis-cam')?.classList.contains('active'));
const camActive = await page.evaluate(() => document.querySelector('#axis-cam')?.classList.contains('active'));
await expect(page, !!camActive, '横轴切换为凸轮角');

console.log('⑦ 曲线联动：点击位移曲线跳转帧');
const chartBox = await page.locator('.chart-canvas').first().boundingBox();
await page.mouse.click(chartBox!.x + chartBox!.width * 0.5, chartBox!.y + chartBox!.height * 0.5);
const jumpedFrame = Number(await page.inputValue('#frame-slider'));
await expect(page, jumpedFrame > 10, `点击曲线跳转到第 ${jumpedFrame + 1} 帧`);

console.log('⑧ 导出 CSV');
const downloadPromise = page.waitForEvent('download', { timeout: 10000 });
await page.click('#btn-export');
const download = await downloadPromise;
await expect(page, download.suggestedFilename() === 'analysis_result.csv', '触发 analysis_result.csv 下载');

console.log('⑨ 页面运行期无 JS 错误');
await expect(page, errors.length === 0, `无控制台/页面错误（实际：${errors.length} 条）`);
if (errors.length) console.log(errors);

await browser.close();
console.log('\n全部浏览器端到端检查通过 ✔');
