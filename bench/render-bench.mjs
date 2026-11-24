#!/usr/bin/env node
// Caption-rendering benchmark for long sessions.
//
// Every interim result from the recogniser calls render(), which rebuilds the
// whole transcript with innerHTML. This measures how that cost grows with the
// number of committed lines (a 1h meeting ≈ 600–1200 lines).
//
// Usage: npm run dev (in another shell)   then   npm run bench
//        BASE_URL=http://127.0.0.1:8787 npm run bench   (against `npm start`)
// No network calls leave localhost; no audio is used.
import { writeFileSync, mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE_URL = process.env.BASE_URL ?? "http://127.0.0.1:5173";
const SIZES = (process.env.SIZES ?? "100,500,1000,2000,5000").split(",").map(Number);
const RUNS = Number(process.env.RUNS ?? 15);

const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => route.abort());
const page = await context.newPage();
const cdp = await context.newCDPSession(page);

const navStart = Date.now();
await page.goto(`${BASE_URL}/app`, { waitUntil: "load" });
const loadMs = Date.now() - navStart;
const nav = await page.evaluate(() => {
  const entry = performance.getEntriesByType("navigation")[0];
  const script = performance.getEntriesByType("resource").find((r) => r.name.includes("transcript.js"));
  return {
    domContentLoaded: Math.round(entry.domContentLoadedEventEnd - entry.startTime),
    htmlBytes: entry.transferSize || entry.decodedBodySize,
    scriptBytes: script ? script.decodedBodySize : null,
  };
});

const rows = [];
for (const size of SIZES) {
  const result = await page.evaluate(({ size, runs }) => {
    const sample = ["我们今天主要确认一下新版本的发布计划。", "The live captions are working well in both English and Chinese.", "下一步由产品团队整理 testing feedback，周五之前完成。"];
    const scope = (code) => (0, eval)(code);
    scope("lines = []");
    const lines = scope("lines");
    for (let i = 0; i < size; i += 1) lines.push({ id: `b${i}`, time: "12:34", text: sample[i % 3], translation: sample[(i + 1) % 3], speaker: (i % 3) + 1 });
    const render = scope("render");
    const setInterim = scope("setInterim"); // interim results only touch the interim row
    render(); // warm up
    const time = (fn) => { const t0 = performance.now(); fn(); void document.body.offsetHeight; return performance.now() - t0; };
    const full = []; const interim = [];
    for (let i = 0; i < runs; i += 1) full.push(time(() => render()));
    for (let i = 0; i < runs; i += 1) interim.push(time(() => setInterim(`正在说话的内容 partial result … ${i}`)));
    const median = (a) => a.sort((x, y) => x - y)[Math.floor(a.length / 2)];
    const p95 = (a) => a.sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * 0.95))];
    return {
      size,
      renderMedian: median(full), renderP95: p95(full),
      interimMedian: median(interim), interimP95: p95(interim),
      domNodes: document.getElementsByTagName("*").length,
    };
  }, { size, runs: RUNS });
  await cdp.send("HeapProfiler.collectGarbage");
  const { usedSize } = await cdp.send("Runtime.getHeapUsage");
  rows.push({ ...result, heapMB: usedSize / 1024 / 1024 });
  console.log(`${size} lines: interim render median ${result.interimMedian.toFixed(1)} ms, p95 ${result.interimP95.toFixed(1)} ms`);
}

// Cumulative cost of a whole session: N commits, each with ~4 interim updates.
const session = await page.evaluate(async (n) => {
  const scope = (code) => (0, eval)(code);
  scope("lines = []");
  scope("render()");
  const setInterim = scope("setInterim"); const addLine = scope("addLine");
  const t0 = performance.now();
  for (let i = 0; i < n; i += 1) {
    for (let k = 0; k < 4; k += 1) setInterim(`partial … ${k}`);
    addLine("一句完整的话 with some English.", "A complete sentence.", 1, "00:00"); // appends one row
  }
  void document.body.offsetHeight;
  return performance.now() - t0;
}, 1000);

await browser.close();

const env = `Chromium (Playwright ${(await import("playwright/package.json", { with: { type: "json" } })).default.version}), ${process.platform}/${process.arch}, Node ${process.version}`;
const table = [
  "| 已提交行数 | 完整重建 render() 中位数 (ms) | p95 | 临时字幕 setInterim() 中位数 (ms) | p95 | DOM 节点 | JS 堆 (MB) |",
  "|---:|---:|---:|---:|---:|---:|---:|",
  ...rows.map((r) => `| ${r.size} | ${r.renderMedian.toFixed(1)} | ${r.renderP95.toFixed(1)} | ${r.interimMedian.toFixed(1)} | ${r.interimP95.toFixed(1)} | ${r.domNodes} | ${r.heapMB.toFixed(1)} |`),
].join("\n");
const report = `# 渲染性能基准结果

- 生成时间：${new Date().toISOString()}
- 环境：${env}
- 目标：${BASE_URL}
- 页面加载：${loadMs} ms（DOMContentLoaded ${nav.domContentLoaded} ms），HTML ${nav.htmlBytes} B，transcript.js ${nav.scriptBytes} B

${table}

模拟 1000 句会话（每句 4 次临时字幕刷新 + 1 次提交）的总渲染耗时：**${session.toFixed(0)} ms**。

> 一帧预算约 16.7 ms。临时字幕刷新超过该值时，长会议后期会出现掉帧 / 输入卡顿。
`;
mkdirSync(new URL("./", import.meta.url), { recursive: true });
writeFileSync(new URL("./results.md", import.meta.url), report);
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ env, baseUrl: BASE_URL, loadMs, nav, rows, sessionMs: session }, null, 2));
console.log("\n" + report);
