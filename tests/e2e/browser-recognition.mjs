// 端到端测试：浏览器原生识别路径（用模拟的 SpeechRecognition 驱动，不依赖 Google 语音服务）
// 验证：中间结果只更新一个节点、最终结果补全句末标点、文本模型润色+翻译、同语言不翻译、演示模式仍正常。
import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import assert from "node:assert/strict";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const html = await readFile(join(root, "app/app/transcript.html"), "utf8");
const server = createServer(async (request, response) => {
  const url = new URL(request.url, "http://localhost");
  if (url.pathname === "/app") return response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(html);
  if (/^\/[\w-]+\.js$/.test(url.pathname)) return response.writeHead(200, { "content-type": "text/javascript" }).end(await readFile(join(root, "public", url.pathname)));
  response.writeHead(404).end();
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const origin = `http://127.0.0.1:${server.address().port}`;

const browser = await chromium.launch({ args: ["--use-fake-ui-for-media-stream", "--use-fake-device-for-media-stream"] });
const context = await browser.newContext();
await context.grantPermissions(["microphone"], { origin });
const page = await context.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error));

await page.addInitScript(() => {
  class FakeRecognition {
    start() {
      window.__recognition = this;
    }
    stop() {
      this.onend?.();
    }
  }
  window.SpeechRecognition = FakeRecognition;
  window.webkitSpeechRecognition = FakeRecognition;
  window.__emit = (items) => {
    const results = items.map(([text, isFinal]) => Object.assign([{ transcript: text }], { isFinal }));
    window.__recognition.onresult({ resultIndex: 0, results });
  };
});

const chatCalls = [];
await page.route("https://mock-llm.test/**", async (route) => {
  const payload = JSON.parse(route.request().postData());
  const match = payload.messages[1].content.match(/<transcript>\n([\s\S]*?)\n<\/transcript>/);
  if (!match) return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content: "摘要" } }] }) });
  chatCalls.push(payload);
  const source = match[1];
  const content = JSON.stringify({ text: source.replace("cooper netes", "Kubernetes"), translation: `[EN] ${source}` });
  return route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content } }] }) });
});

await page.goto(`${origin}/app`);
await page.click("#settingsBtn");
await page.selectOption("#speechMode", "browser");
await page.fill("#glossary", "Kubernetes");
await page.click('.provider-card[data-provider="custom"]');
await page.fill("#endpoint", "https://mock-llm.test/v1/chat/completions");
await page.fill("#model", "mock-model");
await page.fill("#apiKey", "test-not-a-real-key");
await page.click("#saveBtn");
await page.click("#recordBtn");
await page.waitForFunction(() => window.__recognition);

// 中间结果：只更新 #interimLine，不重建已确认段落
await page.evaluate(() => window.__emit([["我们今天", false]]));
await page.evaluate(() => window.__emit([["我们今天确认发布", false]]));
assert.equal(await page.textContent("#interimLine .words"), "我们今天确认发布");
await page.evaluate(() => window.__emit([["我们今天确认 cooper netes 发布计划", true]]));
await page.evaluate(() => window.__emit([["Let's ship it on Friday", true]]));
await page.waitForTimeout(600);
assert.equal(await page.isHidden("#interimLine"), true, "最终结果后中间行应隐藏");

const lines = await page.$$eval("#transcript .line:not(.interim)", (nodes) => nodes.map((node) => ({
  words: node.querySelector(".words")?.textContent,
  translation: node.querySelector(".translation")?.textContent || "",
})));
console.table(lines);
assert.equal(lines[0].words, "我们今天确认 Kubernetes 发布计划。", "应补全标点并按术语表修正识别错字");
assert.equal(lines[0].translation, "[EN] 我们今天确认 cooper netes 发布计划。");
assert.equal(lines[1].words, "Let's ship it on Friday.");
assert.equal(lines[1].translation, "", "已经是英文的句子不应再翻译成英文");
assert.match(chatCalls[0].messages[1].content, /JSON/);

await page.click("#recordBtn");
await page.waitForTimeout(300);

// 演示模式保持可用
await page.click("#demoBtn");
await page.waitForTimeout(5500);
const demoLines = await page.$$eval("#transcript .line:not(.interim) .words", (nodes) => nodes.length);
assert.equal(demoLines, 3);
assert.deepEqual(errors, []);
await browser.close();
server.close();
console.log("\n✅ 浏览器识别路径测试通过");
