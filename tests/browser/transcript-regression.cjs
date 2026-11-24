// Browser regression tests for public/transcript.js (no network, no real audio, no paid APIs).
//
//   npm i --no-save playwright && npx playwright install chromium   # once
//   FAST=1 node tests/browser/transcript-regression.cjs              # all tests, shortened timings
//   node tests/browser/transcript-regression.cjs [testName...]       # default timings
//
// Mocks /api/transcribe, the chat-completions endpoint and SpeechRecognition;
// uses Chromium's fake microphone with the real MediaRecorder.
/* eslint-disable @typescript-eslint/no-require-imports -- plain Node CommonJS script */
const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const root = path.resolve(__dirname, "../..");
const args = process.argv.slice(2);
const custom = args.length >= 2 && args[0].endsWith(".html");
const htmlPath = custom ? args[0] : path.join(root, "app/app/transcript.html");
const jsPath = custom ? args[1] : path.join(root, "public/transcript.js");
const only = custom ? args.slice(2) : args;
const ORIGIN = "http://localhost:4173";
const html = fs.readFileSync(htmlPath, "utf8");
const js = fs.readFileSync(jsPath, "utf8");
const FAST = process.env.FAST === "1";

const fakeSR = `
(() => {
  class FakeSR {
    constructor() { this.continuous = false; this.interimResults = false; this.lang = ""; window.__srInstances = (window.__srInstances || 0) + 1; window.__sr = this; this.running = false; this.pendingFinal = null; }
    start() { if (this.running) throw new Error("InvalidStateError"); this.running = true; window.__srStarts = (window.__srStarts || 0) + 1; }
    stop() {
      if (!this.running) return;
      this.running = false;
      const pending = this.pendingFinal; this.pendingFinal = null;
      setTimeout(() => { if (pending) this._emit(pending, true); this.onend && this.onend(); }, 300);
    }
    abort() { this.running = false; setTimeout(() => this.onend && this.onend(), 0); }
    _emit(text, isFinal) {
      const result = [{ transcript: text }]; result.isFinal = isFinal;
      const results = [result];
      this.onresult && this.onresult({ resultIndex: 0, results });
    }
    emit(text, isFinal) { if (!isFinal) this.pendingFinal = text; else this.pendingFinal = null; this._emit(text, isFinal); }
  }
  window.SpeechRecognition = FakeSR; window.webkitSpeechRecognition = FakeSR;
})();`;

async function setup(browser, opts = {}) {
  const context = await browser.newContext({ permissions: ["microphone", "clipboard-read", "clipboard-write"] });
  const page = await context.newPage();
  const state = { transcribeCalls: 0, llmCalls: [], transcribeResponder: null, llmResponder: null, errors: [] };
  page.on("pageerror", (e) => state.errors.push(String(e)));
  await page.addInitScript(() => { const md = navigator.mediaDevices; const orig = md.getUserMedia.bind(md); md.getUserMedia = async (c) => { const s = await orig(c); window.__lastStream = s; return s; }; });
  if (opts.native !== false) await page.addInitScript(fakeSR);
  else await page.addInitScript(() => { delete window.SpeechRecognition; delete window.webkitSpeechRecognition; });
  if (FAST) await page.addInitScript(() => { window.__YULIU_TUNING__ = { segmentMs: 2500, translateTimeoutMs: 2000, summaryTimeoutMs: 3000, transcribeTimeoutMs: 3000, retryDelayMs: 200, vad: { maxSegmentMs: 2500, softMaxMs: 2000 } }; });
  await page.route(`${ORIGIN}/**`, async (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/app") return route.fulfill({ contentType: "text/html", body: html });
    if (url.pathname === "/transcript.js") return route.fulfill({ contentType: "text/javascript", body: js });
    // Helper modules that transcript.js depends on (speech-core.js, ai-engine.js).
    if (/^\/[\w-]+\.js$/.test(url.pathname) && fs.existsSync(path.join(root, "public", url.pathname))) {
      return route.fulfill({ contentType: "text/javascript", body: fs.readFileSync(path.join(root, "public", url.pathname), "utf8") });
    }
    if (url.pathname === "/api/transcribe") {
      state.transcribeCalls += 1;
      const n = state.transcribeCalls;
      const r = state.transcribeResponder ? await state.transcribeResponder(n, route) : { status: 200, body: { text: `片段${n}` } };
      if (r === "hang") return; // never respond
      return route.fulfill({ status: r.status, contentType: "application/json", body: JSON.stringify(r.body) });
    }
    if (url.pathname === "/llm") {
      const body = JSON.parse(route.request().postData() || "{}");
      state.llmCalls.push(body);
      const r = state.llmResponder ? await state.llmResponder(body, route) : { content: isSummaryRequest(body) ? "摘要OK" : "TR:" + body.messages[1].content.split("\n\n").pop() };
      if (r === "hang") return;
      return route.fulfill({ status: r.status || 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: r.content } }] }) });
    }
    return route.fulfill({ status: 404, body: "" });
  });
  await page.goto(`${ORIGIN}/app`);
  return { context, page, state };
}

async function configure(page, { mode = "auto", speechKey = "", llmKey = "", provider = "deepseek" } = {}) {
  await page.click("#settingsBtn");
  await page.selectOption("#speechMode", mode);
  if (speechKey) await page.fill("#speechKey", speechKey);
  await page.click(`.provider-card[data-provider="${provider}"]`);
  await page.fill("#endpoint", `${ORIGIN}/llm`);
  if (llmKey) await page.fill("#apiKey", llmKey);
  await page.click("#saveBtn");
}

// Summary requests come from ai-engine.js: its system prompt is the meeting-minutes one.
const isSummaryRequest = (body) => body.messages.some((m) => m.role === "system" && /会议纪要|总结/.test(m.content));
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const lineTexts = (page) => page.$$eval("#transcript .line:not(.interim) .words", (els) => els.map((e) => e.textContent));
const stamps = (page) => page.$$eval("#transcript .line:not(.interim) .stamp", (els) => els.map((e) => e.textContent));

const tests = {
  async added_speaker_buttons_select_themselves({ page }) {
    await page.click("#addSpeaker");
    await page.click("#addSpeaker");
    await page.click('[data-speaker="3"]');
    const active = await page.$eval(".speakerbtn.active, [data-speaker].active", (e) => e.dataset.speaker);
    if (active !== "3") throw new Error(`clicked Speaker 3 but Speaker ${active} is active`);
    return "Speaker 3 selected";
  },

  async double_click_start_single_session({ page }) {
    await page.evaluate(() => { document.querySelector("#recordBtn").click(); document.querySelector("#recordBtn").click(); });
    await wait(800);
    const starts = await page.evaluate(() => window.__srInstances || 0);
    const rec = await page.$eval("#recorder", (e) => e.classList.contains("recording"));
    if (rec) await page.click("#recordBtn");
    if (starts !== 1) throw new Error(`double click created ${starts} recognizers (recording=${rec})`);
    return `1 recognizer, recording=${rec}`;
  },

  async ui_language_switch_keeps_lines({ page }) {
    await page.click("#demoBtn");
    await page.waitForFunction(() => document.querySelector("#recordLabel").textContent.includes("继续"), null, { timeout: 15000 });
    await page.click("#uiLangBtn");
    const badge = await page.$eval("#transcript .speaker-badge", (e) => e.textContent);
    const n = (await lineTexts(page)).length;
    if (!badge.startsWith("Speaker") || n !== 3) throw new Error(`badge=${badge} lines=${n}`);
    return `badge "${badge}", ${n} lines`;
  },

  async bench_long_session_interim({ page }) {
    await page.click("#recordBtn");
    await wait(200);
    const ms = await page.evaluate(async () => {
      for (let i = 0; i < 1500; i++) window.__sr.emit(`第${i}句：这是一段比较长的会议发言内容，用来模拟两小时会议。`, true);
      const t0 = performance.now();
      for (let i = 0; i < 200; i++) { window.__sr.emit("正在说的中间结果" + i, false); void document.querySelector("#transcript").offsetHeight; }
      return performance.now() - t0;
    });
    await page.click("#recordBtn");
    return `1500 lines, 200 interim updates: ${ms.toFixed(0)} ms total, ${(ms / 200).toFixed(2)} ms/update`;
  },

  async demo_still_works({ page }) {
    await page.click("#demoBtn");
    await page.waitForFunction(() => document.querySelector("#recordLabel").textContent.includes("继续"), null, { timeout: 15000 });
    const texts = await lineTexts(page);
    const tr = await page.$$eval("#transcript .translation", (els) => els.length);
    if (texts.length !== 3 || tr !== 3) throw new Error(`demo lines=${texts.length} translations=${tr}`);
    await page.click("#transcript .line .speaker-badge");
    const sp = await page.$eval("#transcript .line .speaker-badge", (e) => e.textContent);
    if (!sp.includes("2")) throw new Error("cycleSpeaker failed: " + sp);
    return `3 lines + 3 translations; speaker cycle -> ${sp}`;
  },

  async native_final_after_stop_included_in_summary({ page, state }) {
    await configure(page, { llmKey: "k" });
    await page.selectOption("#targetLang", "off");
    await page.click("#recordBtn");
    await wait(300);
    await page.evaluate(() => window.__sr.emit("第一句", true));
    await page.evaluate(() => window.__sr.emit("最后一句话", false));
    await page.click("#recordBtn"); // stop; FakeSR delivers final 300ms later
    await page.waitForFunction(() => document.querySelector("#summaryTitle").textContent !== "正在整理…" && document.querySelector("#summaryTitle").textContent !== "录音结束后生成", null, { timeout: 10000 });
    await wait(800);
    const summaryReq = state.llmCalls.find((c) => isSummaryRequest(c));
    const included = summaryReq?.messages[1].content.includes("最后一句话");
    if (!included) throw new Error("summary request missed final result delivered after stop()");
    return "summary request includes the last sentence";
  },

  async render_preserves_scroll_when_user_scrolled_up({ page }) {
    await page.click("#recordBtn");
    await wait(200);
    for (let i = 0; i < 40; i++) await page.evaluate((i) => window.__sr.emit(`第${i}句内容比较长一点，用来撑开滚动区域`, true), i);
    await page.$eval("#transcript", (el) => { el.scrollTop = 0; });
    await page.evaluate(() => window.__sr.emit("中间结果", false));
    const top = await page.$eval("#transcript", (el) => el.scrollTop);
    const nodeStable = await page.evaluate(() => { const first = document.querySelector("#transcript .line"); window.__sr.emit("中间结果2", false); return first === document.querySelector("#transcript .line"); });
    await page.click("#recordBtn");
    if (top !== 0) throw new Error(`scroll jumped to ${top} while user was reading earlier lines`);
    return `scrollTop stays 0; committed DOM nodes reused on interim update: ${nodeStable}`;
  },

  async timestamps_continue_on_record_again({ page }) {
    await page.click("#recordBtn");
    await wait(2300);
    await page.evaluate(() => window.__sr.emit("A", true));
    await page.click("#recordBtn");
    await wait(1200);
    await page.click("#recordBtn");
    await wait(300);
    await page.evaluate(() => window.__sr.emit("B", true));
    await page.click("#recordBtn");
    const s = await stamps(page);
    if (!(s[1] >= s[0])) throw new Error(`timestamps went backwards: ${s.join(",")}`);
    return `stamps ${s.join(" -> ")}`;
  },

  async ollama_translates_without_key({ page, state }) {
    await configure(page, { provider: "ollama" });
    await page.click("#recordBtn");
    await wait(200);
    await page.evaluate(() => window.__sr.emit("你好世界", true));
    await wait(800);
    await page.click("#recordBtn");
    await wait(500);
    const tr = await page.$$eval("#transcript .translation", (els) => els.map((e) => e.textContent));
    if (!tr.length) throw new Error(`no translation with Ollama (llm calls=${state.llmCalls.length})`);
    return `translation: ${tr[0]}`;
  },

  async cloud_survives_transient_error({ page, state }) {
    state.transcribeResponder = (n) => (n === 1 ? { status: 502, body: { error: "upstream busy" } } : { status: 200, body: { text: `片段${n}` } });
    await configure(page, { mode: "cloud", speechKey: "sk-test" });
    await page.selectOption("#targetLang", "off");
    await page.click("#recordBtn");
    const seg = FAST ? 2500 : 6000;
    await wait(seg * 3 + 1500);
    await page.click("#recordBtn");
    await page.waitForFunction(() => !document.querySelector("#recorder").classList.contains("recording"), null, { timeout: 20000 });
    const texts = await lineTexts(page);
    if (texts.length < 2) throw new Error(`after one 502, only ${texts.length} lines (calls=${state.transcribeCalls})`);
    return `calls=${state.transcribeCalls}, lines=${texts.join("|")}`;
  },

  async cloud_auth_error_stops_cleanly({ page, state }) {
    state.transcribeResponder = () => ({ status: 401, body: { error: "Incorrect API key" } });
    await configure(page, { mode: "cloud", speechKey: "sk-bad" });
    await page.click("#recordBtn");
    const seg = FAST ? 2500 : 6000;
    await wait(seg * 2 + 1500);
    const calls = state.transcribeCalls;
    const status = await page.$eval("#statusSub", (e) => e.textContent);
    const stillRecording = await page.$eval("#recorder", (e) => e.classList.contains("recording"));
    const micLive = await page.evaluate(() => window.__lastStream.getAudioTracks().some((t) => t.readyState === "live"));
    if (stillRecording) await page.click("#recordBtn").catch(() => {});
    if (calls > 1) throw new Error(`kept uploading after 401: ${calls} calls`);
    if (stillRecording || micLive) throw new Error(`after 401 the UI still shows recording=${stillRecording}, mic live=${micLive}; status="${status}"`);
    return `calls=${calls}; stopped, mic released; status="${status}"`;
  },

  async cloud_queue_not_blocked_by_translation({ page, state }) {
    state.llmResponder = async (body) => { if (isSummaryRequest(body)) return { content: "摘要" }; await wait(FAST ? 6000 : 14000); return { content: "TR" }; };
    await configure(page, { mode: "cloud", speechKey: "sk-test", llmKey: "k" });
    await page.click("#recordBtn");
    const seg = FAST ? 2500 : 6000;
    await wait(seg * 2 + 1500);
    const texts = await lineTexts(page);
    await page.click("#recordBtn");
    if (texts.length < 2) throw new Error(`slow translation blocked transcription: ${texts.length} lines after 2 segments`);
    return `${texts.length} lines visible while translations pending`;
  },

  async hung_summary_times_out({ page, state }) {
    if (!FAST) return "skipped (needs tuning hook)";
    state.llmResponder = (body) => (isSummaryRequest(body) ? "hang" : { content: "TR" });
    await configure(page, { llmKey: "k" });
    await page.click("#recordBtn");
    await wait(200);
    await page.evaluate(() => window.__sr.emit("一句话", true));
    await page.click("#recordBtn");
    await page.waitForFunction(() => document.querySelector("#summaryTitle").textContent === "摘要生成失败", null, { timeout: 8000 });
    return "summary shows failure after timeout instead of hanging";
  },

  async mic_unplugged_stops_recording({ page }) {
    await page.click("#recordBtn");
    await wait(500);
    // Simulate device removal: stop() does not fire 'ended', so dispatch it explicitly on live tracks.
    const ok = await page.evaluate(() => { const s = window.__lastStream; if (!s) return false; s.getAudioTracks().forEach((t) => { t.stop(); t.dispatchEvent(new Event("ended")); }); return true; });
    if (!ok) throw new Error("no debug hook to reach media stream (baseline has none)");
    await page.waitForFunction(() => !document.querySelector("#recorder").classList.contains("recording"), null, { timeout: 5000 });
    return "recording stopped after mic track ended";
  },

  async translation_concurrency_bounded({ page, state }) {
    let inflight = 0, peak = 0;
    state.llmResponder = async () => { inflight++; peak = Math.max(peak, inflight); await wait(400); inflight--; return { content: "TR" }; };
    await configure(page, { llmKey: "k" });
    await page.click("#recordBtn");
    await wait(200);
    for (let i = 0; i < 12; i++) await page.evaluate((i) => window.__sr.emit(`句子${i}`, true), i);
    await wait(4000);
    await page.click("#recordBtn");
    await wait(600);
    const tr = await page.$$eval("#transcript .translation", (els) => els.length);
    if (peak > 3) throw new Error(`peak concurrent translation requests ${peak} (translated ${tr}/12)`);
    return `peak concurrency ${peak}, translated ${tr}/12`;
  },
};

(async () => {
  const browser = await chromium.launch({ args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", "--autoplay-policy=no-user-gesture-required"] });
  const names = only.length ? only : Object.keys(tests);
  let failed = 0;
  for (const name of names) {
    const native = !name.startsWith("cloud_");
    const env = await setup(browser, { native });
    const t0 = Date.now();
    try {
      const msg = await tests[name](env);
      console.log(`PASS ${name} (${Date.now() - t0}ms): ${msg}`);
    } catch (e) {
      failed++;
      console.log(`FAIL ${name} (${Date.now() - t0}ms): ${e.message.split("\n")[0]}`);
    }
    if (env.state.errors.length) console.log(`   pageerrors: ${env.state.errors.slice(0, 3).join(" | ")}`);
    await env.context.close();
  }
  await browser.close();
  console.log(`${names.length - failed}/${names.length} passed`);
  process.exit(failed ? 1 : 0);
})();
