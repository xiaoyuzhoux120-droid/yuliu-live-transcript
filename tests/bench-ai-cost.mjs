// 成本基准（离线、mock）：模拟 60 分钟中文会议、译为英文，比较旧实现与两种新模式的请求数与 token 成本。
// 运行：node tests/bench-ai-cost.mjs
// 说明：token 由 estimateTokens 估算；“旧实现”的思考 token 是假设值（DeepSeek 默认开启思考模式，旧代码未关闭）。
import { loadEngine, mockFetch } from "./helpers.mjs";

const AI = await loadEngine();

const ASSUMED_REASONING_PER_TRANSLATION = Number(process.env.REASONING ?? 150); // 思考模式下每句短翻译的推理 token（假设）
const ASSUMED_REASONING_PER_SUMMARY = 1500;
const SUMMARY_OUTPUT = 700;
const MINUTES = 60;
const LINES_PER_MINUTE = 12; // 浏览器识别约每 5 秒产出一句

const phrases = [
  "我们先过一下这周的进度，前端的部分基本完成了",
  "嗯",
  "后端接口的 latency 还是有点高，大概三百毫秒",
  "好的",
  "下周三之前需要把测试环境部署好，张伟负责",
  "预算方面这个季度还剩百分之二十左右",
  "对",
  "客户那边反馈说希望增加导出 PDF 的功能",
  "这个需求我们评估一下工作量再决定",
  "OK",
];
const lines = Array.from({ length: MINUTES * LINES_PER_MINUTE }, (_, index) => ({
  speaker: (index % 3) + 1,
  time: `${String(Math.floor(index / LINES_PER_MINUTE)).padStart(2, "0")}:${String((index % LINES_PER_MINUTE) * 5).padStart(2, "0")}`,
  // 加入序号让大部分句子不同，避免缓存让结果过于乐观
  text: index % 10 === 1 || index % 10 === 3 || index % 10 === 6 || index % 10 === 9 ? phrases[index % 10] : `${phrases[index % 10]}（第${index}条）`,
}));

const config = {
  provider: "deepseek", endpoint: "https://example.invalid/v1/chat/completions", model: "deepseek-flash", defaultModel: "deepseek-flash",
  key: "mock", target: "en", glossary: "语流 = Yuliu\nPDF = PDF",
};

// 模拟服务端：按请求内容返回合理 usage，并按前缀缓存规则统计命中。
function simulatedServer({ reasoningPerTranslation, reasoningPerSummary }) {
  const seenSystem = new Set();
  return mockFetch((url, init) => {
    const body = JSON.parse(init.body);
    const system = body.messages[0].content;
    const user = body.messages[1].content;
    const prompt = AI.estimateTokens(system) + AI.estimateTokens(user) + 8;
    const hit = seenSystem.has(system) ? AI.estimateTokens(system) : 0;
    seenSystem.add(system);
    const thinking = body.thinking?.type !== "disabled";
    const isSummary = /纪要|总结/.test(system) || /总结/.test(user.slice(0, 20));
    let content;
    let completion;
    if (isSummary) {
      content = JSON.stringify({ title: "周会", summary: "进度同步。", key_points: [], decisions: [], action_items: [], open_questions: [] });
      completion = SUMMARY_OUTPUT;
    } else if (body.response_format) {
      const items = JSON.parse(user).items;
      content = JSON.stringify({ t: items.map(() => "Translated sentence.") });
      completion = items.reduce((sum, item) => sum + Math.ceil(AI.estimateTokens(item) * 1.3), 0) + 6;
    } else {
      const source = user.includes("原文：") ? user.split("原文：").pop() : user.split("\n\n").pop();
      content = "Translated sentence.";
      completion = Math.ceil(AI.estimateTokens(source) * 1.3);
    }
    const reasoning = thinking ? (isSummary ? reasoningPerSummary : reasoningPerTranslation) : 0;
    return { body: { choices: [{ message: { content } }], usage: { prompt_tokens: prompt, prompt_cache_hit_tokens: hit, completion_tokens: completion + reasoning, completion_tokens_details: { reasoning_tokens: reasoning } } } };
  });
}

// 旧实现（public/transcript.js 中被替换前的 modelTask）：每句一个请求、未关闭思考、总结一次性发送全文。
async function runLegacy() {
  const fetch = simulatedServer({ reasoningPerTranslation: ASSUMED_REASONING_PER_TRANSLATION, reasoningPerSummary: ASSUMED_REASONING_PER_SUMMARY });
  const meter = new AI.UsageMeter();
  const send = async (task, prompt, text) => {
    const response = await fetch(config.endpoint, { method: "POST", body: JSON.stringify({ model: "deepseek-flash", messages: [
      { role: "system", content: "你是专业的中英文会议记录助手。准确、简洁，不虚构。" },
      { role: "user", content: `${prompt}\n\n${text}` },
    ], temperature: 0.2 }) });
    meter.record(task, "deepseek-flash", (await response.json()).usage);
  };
  for (const line of lines) await send("translate", "将以下内容自然地翻译成English，只输出译文：", line.text);
  await send("summary", "总结以下会议内容。", lines.map((line) => `说话人 ${line.speaker}：${line.text}`).join("\n"));
  return meter.snapshot();
}

async function runMode(mode) {
  const fetch = simulatedServer({ reasoningPerTranslation: ASSUMED_REASONING_PER_TRANSLATION, reasoningPerSummary: ASSUMED_REASONING_PER_SUMMARY });
  const meter = new AI.UsageMeter();
  const modeConfig = { ...config, mode };
  const translator = new AI.Translator({ getConfig: () => modeConfig, fetchImpl: fetch, meter, onTranslated: () => {} });
  // 不真实等待：每 5 秒一句、省钱模式批次窗口 6 秒，因此每批约 2 句；高质量模式逐句发送。
  // 每句之间 await，模拟句子间隔（前一句的结果已写入缓存）。
  for (const [index, line] of lines.entries()) {
    translator.enqueue(line);
    if (mode === "quality" || index % 2 === 1) await translator.flush();
  }
  await translator.flush();
  const summarizer = new AI.Summarizer({ fetchImpl: fetch, meter });
  await summarizer.summarize(modeConfig, lines);
  return meter.snapshot();
}

function row(name, snap) {
  return `| ${name} | ${snap.requests} | ${snap.cacheHits + snap.skipped} | ${snap.promptTokens.toLocaleString()} | ${snap.promptCacheHitTokens.toLocaleString()} | ${snap.completionTokens.toLocaleString()} | ${snap.reasoningTokens.toLocaleString()} | $${snap.costUsd.toFixed(4)} |`;
}

const legacy = await runLegacy();
const economy = await runMode("economy");
const quality = await runMode("quality");
console.log(`模拟：${MINUTES} 分钟会议，${lines.length} 句，中文→英文，DeepSeek 高峰价上限估算\n`);
console.log("| 方案 | 请求数 | 本地缓存/跳过命中 | 输入 token | 其中前缀缓存命中 | 输出 token | 其中思考 token | 估算费用 |");
console.log("|---|---|---|---|---|---|---|---|");
console.log(row("旧实现", legacy));
console.log(row("省钱模式", economy));
console.log(row("高质量模式", quality));
const saving = (1 - economy.costUsd / legacy.costUsd) * 100;
console.log(`\n省钱模式相对旧实现：请求数 -${Math.round((1 - economy.requests / legacy.requests) * 100)}%，估算费用 -${saving.toFixed(0)}%`);
console.log(`高质量模式相对旧实现：请求数 -${Math.round((1 - quality.requests / legacy.requests) * 100)}%，估算费用 ${quality.costUsd > legacy.costUsd ? "+" : "-"}${Math.abs((1 - quality.costUsd / legacy.costUsd) * 100).toFixed(0)}%`);
