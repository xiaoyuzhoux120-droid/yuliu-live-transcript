// 端到端测试：真实 Chromium + 合成麦克风音频 + 模拟语音/翻译接口（不调用任何付费服务）
// 验证：按停顿断句、长静音不上传、识别 prompt 带术语表与上下文、临时错误自动重试、
//       静音幻觉被过滤、翻译请求（ai-engine.js）带术语表与上文且结果显示在字幕中。
// 运行：node tests/e2e/cloud-transcription.mjs   （需要 playwright 与 Chromium）
import { createServer } from "node:http";
import { readFile, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

// ---------- 合成麦克风音频：类语音（调幅噪声）+ 停顿 + 长静音 ----------
const RATE = 16000;
function synthWav() {
  const plan = [
    [1.0, 0], [2.6, 1], [1.2, 0], [2.6, 1], [9.0, 0], [2.4, 1], [1.5, 0],
  ];
  const samples = [];
  let seed = 7;
  const noise = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 31 - 1);
  for (const [seconds, speech] of plan) {
    for (let i = 0; i < seconds * RATE; i += 1) {
      const t = i / RATE;
      const envelope = speech ? 0.25 + 0.2 * Math.sin(2 * Math.PI * 4 * t) : 0;
      samples.push(speech ? envelope * (0.6 * Math.sin(2 * Math.PI * 180 * t) + 0.4 * noise()) : 0.002 * noise());
    }
  }
  const buffer = Buffer.alloc(44 + samples.length * 2);
  buffer.write("RIFF", 0); buffer.writeUInt32LE(36 + samples.length * 2, 4); buffer.write("WAVE", 8);
  buffer.write("fmt ", 12); buffer.writeUInt32LE(16, 16); buffer.writeUInt16LE(1, 20); buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(RATE, 24); buffer.writeUInt32LE(RATE * 2, 28); buffer.writeUInt16LE(2, 32); buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36); buffer.writeUInt32LE(samples.length * 2, 40);
  samples.forEach((value, index) => buffer.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(value * 32767))), 44 + index * 2));
  return { buffer, seconds: plan.reduce((sum, [s]) => sum + s, 0) };
}

// ---------- 静态服务：只提供工作台页面与 public 脚本 ----------
const html = await readFile(join(root, "app/app/transcript.html"), "utf8");
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/app") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    return response.end(html);
  }
  if (/^\/[\w-]+\.js$/.test(url.pathname)) {
    response.writeHead(200, { "content-type": "text/javascript" });
    return response.end(await readFile(join(root, "public", url.pathname)));
  }
  response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const { buffer, seconds } = synthWav();
const dir = await mkdtemp(join(tmpdir(), "yuliu-e2e-"));
const wavPath = join(dir, "mic.wav");
await writeFile(wavPath, buffer);

const browser = await chromium.launch({
  args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream", `--use-file-for-fake-audio-capture=${wavPath}%noloop`, "--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext();
await context.grantPermissions(["microphone"], { origin });
const page = await context.newPage();
page.on("pageerror", (error) => { throw error; });

// ---------- 模拟语音识别接口 ----------
const transcribeCalls = [];
const replies = ["我们今天确认 Kubernetes 的发布计划", "谢谢观看", "下一步由产品团队整理反馈"];
let failedOnce = false;
await page.route("**/api/transcribe", async (route) => {
  const body = route.request().postDataBuffer()?.toString("latin1") || "";
  const field = (name) => (body.match(new RegExp(`name="${name}"\\r\\n\\r\\n([\\s\\S]*?)\\r\\n--`)) || [])[1];
  const call = { at: Date.now(), prompt: Buffer.from(field("prompt") || "", "latin1").toString("utf8"), language: field("language"), bytes: body.length, key: route.request().headers()["x-transcription-api-key"] };
  transcribeCalls.push(call);
  if (!failedOnce) { // 第一次返回 503，验证自动重试
    failedOnce = true;
    call.status = 503;
    return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "busy" }) });
  }
  const text = replies.shift() ?? "";
  call.text = text;
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ text }) });
});

// ---------- 模拟翻译模型 ----------
const chatCalls = [];
await page.route("https://mock-llm.test/**", async (route) => {
  const payload = JSON.parse(route.request().postData());
  // 翻译请求来自 ai-engine.js：system 提示为“同声传译”；批量时 user 为 {context, items} JSON，逐句时为“原文：…”
  const isTranslation = /同声传译/.test(payload.messages[0].content);
  let content = "摘要";
  if (isTranslation) {
    chatCalls.push(payload);
    const user = payload.messages[1].content;
    if (user.trim().startsWith("{")) content = JSON.stringify({ t: JSON.parse(user).items.map((item) => `[EN] ${item}`) });
    else content = `[EN] ${user.split("原文：").pop()}`;
  }
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content } }] }) });
});

await page.goto(`${origin}/app`);
await page.click("#settingsBtn");
await page.selectOption("#speechMode", "cloud");
await page.fill("#speechKey", "test-not-a-real-key");
await page.fill("#glossary", "Kubernetes\n大模型 = LLM");
await page.click('.provider-card[data-provider="custom"]');
await page.fill("#endpoint", "https://mock-llm.test/v1/chat/completions");
await page.fill("#model", "mock-model");
await page.fill("#apiKey", "test-not-a-real-key");
await page.click("#saveBtn");

const started = Date.now();
await page.click("#recordBtn");
await page.waitForTimeout((seconds + 1) * 1000);
await page.click("#recordBtn"); // 结束录音
await page.waitForFunction(() => !document.querySelector("#recorder").classList.contains("recording"), null, { timeout: 15000 });
await page.waitForTimeout(500);

const lines = await page.$$eval("#transcript .line:not(.interim)", (nodes) => nodes.map((node) => ({
  words: node.querySelector(".words")?.textContent,
  translation: node.querySelector(".translation")?.textContent || "",
})));
await browser.close();
server.close();

const relative = transcribeCalls.map((call) => ({ ...call, t: ((call.at - started) / 1000).toFixed(1) }));
console.log("识别请求：");
console.table(relative.map(({ t, status = 200, language, prompt, text = "" }) => ({ t, status, language, prompt: prompt.slice(0, 60), text })));
console.log("字幕：");
console.table(lines);

// 断言
const successful = transcribeCalls.filter((call) => call.status !== 503);
assert.equal(successful.length, 3, "三段语音各上传一次，9 秒长静音不应单独上传");
assert.equal(transcribeCalls.length, 4, "第一次 503 后应自动重试");
assert.ok(transcribeCalls.every((call) => call.key === "test-not-a-real-key"));
assert.ok(transcribeCalls.every((call) => call.prompt.startsWith("Glossary: Kubernetes, 大模型, LLM.")), "识别 prompt 应包含术语表");
assert.match(successful[1].prompt, /Kubernetes 的发布计划/, "后续片段的 prompt 应带上一段文字作为上下文");
assert.equal(lines.length, 2, "“谢谢观看”幻觉应被过滤");
assert.deepEqual(lines.map((line) => line.words), ["我们今天确认 Kubernetes 的发布计划", "下一步由产品团队整理反馈"]);
assert.ok(lines.every((line) => line.translation.startsWith("[EN] ")), "每行都应显示译文");
assert.ok(chatCalls.length >= 2);
assert.match(chatCalls[0].messages[0].content, /术语表[\s\S]*Kubernetes/, "翻译应带术语表");
assert.match(chatCalls.at(-1).messages[1].content, /"context":\["我们今天确认|context：我们今天确认/, "翻译应带上文");
console.log("\n✅ 端到端测试通过");
