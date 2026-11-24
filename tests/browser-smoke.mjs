// 浏览器冒烟测试（Playwright + 拦截网络，不访问真实模型服务）
// 运行：node tests/browser-smoke.mjs   （需要已安装 playwright 与 Chromium）
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";

// 兼容全局安装的 playwright（ESM 不读取 NODE_PATH）
const require = createRequire(import.meta.url);
let playwright;
try { playwright = require("playwright"); } catch { playwright = require(`${process.env.PLAYWRIGHT_PATH || "playwright"}`); }
const { chromium } = playwright;

const root = new URL("../", import.meta.url);
const html = await readFile(new URL("app/app/transcript.html", root), "utf8");
const scripts = {
  "/transcript.js": await readFile(new URL("public/transcript.js", root), "utf8"),
  "/ai-engine.js": await readFile(new URL("public/ai-engine.js", root), "utf8"),
  "/speech-core.js": await readFile(new URL("public/speech-core.js", root), "utf8"),
};

const requests = [];
const browser = await chromium.launch();
const page = await browser.newPage();
const errors = [];
page.on("pageerror", (error) => errors.push(error.message));

await page.route("**/*", async (route) => {
  const url = new URL(route.request().url());
  if (url.hostname === "app.test") {
    if (url.pathname === "/app") return route.fulfill({ contentType: "text/html", body: html });
    if (scripts[url.pathname]) return route.fulfill({ contentType: "text/javascript", body: scripts[url.pathname] });
    return route.fulfill({ status: 404, body: "" });
  }
  if (url.hostname === "api.deepseek.com") {
    const body = JSON.parse(route.request().postData());
    requests.push(body);
    const system = body.messages[0].content;
    const content = system.includes("纪要")
      ? JSON.stringify({ title: "发布计划同步", summary: "确认周五前整理测试反馈。", key_points: ["实时字幕运行正常"], decisions: ["周五前完成反馈整理"], action_items: [{ task: "整理测试反馈", owner: "S1", due: "周五" }], open_questions: [] })
      : body.response_format ? JSON.stringify({ t: JSON.parse(body.messages[1].content).items.map((_, i) => `EN ${i}`) }) : "EN single";
    return route.fulfill({ contentType: "application/json", body: JSON.stringify({ choices: [{ message: { content } }], usage: { prompt_tokens: 120, prompt_cache_hit_tokens: 80, completion_tokens: 40 } }) });
  }
  return route.abort();
});

await page.goto("https://app.test/app");
await page.click("#settingsBtn");
await page.fill("#apiKey", "fake-key-for-test");
await page.selectOption("#aiMode", "quality");
await page.fill("#glossary", "语流 = Yuliu");
await page.click("#saveBtn");

// 1) 实时翻译路径：直接调用页面的 addLine（与识别结果进入的入口相同）
await page.evaluate(() => { document.querySelector("#targetLang").value = "en"; addLine("语流今天发布新版本"); });
await page.waitForFunction(() => document.querySelector(".translation")?.textContent === "EN single");
const translateBody = requests[0];

// 2) 演示 + 结束后自动总结
await page.click("#demoBtn");
await page.waitForFunction(() => document.querySelector("#summaryTitle").textContent === "发布计划同步", null, { timeout: 15000 });
const summaryHtml = await page.innerHTML("#summaryText");
const chips = await page.textContent("#chips");
const badge = await page.textContent("#providerBadge");

await page.click("#uiLangBtn");
const modeLabel = await page.textContent("label[for=aiMode]");
await browser.close();

const checks = [
  ["无页面脚本错误", errors.length === 0, errors.join("; ")],
  ["翻译请求关闭 DeepSeek 思考", translateBody?.thinking?.type === "disabled", JSON.stringify(translateBody?.thinking)],
  ["翻译提示包含术语表", translateBody?.messages[0].content.includes("语流 = Yuliu"), ""],
  ["总结使用高质量模型", requests.at(-1)?.model === "deepseek-v4-pro", requests.at(-1)?.model],
  ["总结渲染行动项", summaryHtml.includes("整理测试反馈") && summaryHtml.includes("负责人"), summaryHtml.slice(0, 120)],
  ["显示用量统计", /tokens/.test(chips), chips],
  ["徽标显示运行模式", badge.includes("高质量"), badge],
  ["英文界面翻译新标签", modeLabel === "Run mode", modeLabel],
];
let failed = 0;
for (const [name, ok, detail] of checks) {
  if (!ok) failed += 1;
  console.log(`${ok ? "✓" : "✗"} ${name}${ok ? "" : ` — ${detail}`}`);
}
console.log(`\n${checks.length - failed}/${checks.length} 通过，共拦截 ${requests.length} 个模型请求`);
process.exit(failed ? 1 : 0);
