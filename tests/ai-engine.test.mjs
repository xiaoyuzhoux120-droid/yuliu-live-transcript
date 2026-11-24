// 运行：node --test tests/
// 全部使用 mock fetch，不会调用任何真实或付费 API。
import { test } from "node:test";
import assert from "node:assert/strict";
import { mockFetch, loadEngine } from "./helpers.mjs";

const AI = await loadEngine();

const baseConfig = {
  provider: "deepseek",
  endpoint: "https://example.invalid/chat/completions",
  model: "deepseek-flash",
  defaultModel: "deepseek-flash",
  key: "test-key-not-real",
  mode: "economy",
  target: "en",
  glossary: "",
};

test("DeepSeek 翻译请求关闭思考模式，总结在高质量模式开启", () => {
  const translate = JSON.parse(AI.buildRequest(baseConfig, { model: "deepseek-flash", messages: [] }).init.body);
  assert.deepEqual(translate.thinking, { type: "disabled" });
  assert.equal(translate.temperature, 0.2);
  const summary = JSON.parse(AI.buildRequest(baseConfig, { model: "deepseek-v4-pro", messages: [], thinking: true, json: true }).init.body);
  assert.deepEqual(summary.thinking, { type: "enabled" });
  assert.equal(summary.temperature, undefined, "思考模式下 temperature 无效，不发送");
  assert.deepEqual(summary.response_format, { type: "json_object" });
});

test("各服务只发送自己支持的推理参数", () => {
  assert.deepEqual(AI.reasoningParams("groq", "openai/gpt-oss-20b", false), { reasoning_effort: "low" });
  assert.deepEqual(AI.reasoningParams("groq", "llama-3.3-70b-versatile", false), {});
  assert.deepEqual(AI.reasoningParams("siliconflow", "Qwen/Qwen3-32B", false), { enable_thinking: false });
  assert.deepEqual(AI.reasoningParams("ollama", "qwen3:8b", false), {});
  assert.deepEqual(AI.reasoningParams("custom", "x", false), {});
  const custom = JSON.parse(AI.buildRequest({ ...baseConfig, provider: "custom" }, { model: "x", messages: [], json: true, maxTokens: 50 }).init.body);
  assert.equal(custom.response_format, undefined);
  assert.equal(custom.max_tokens, undefined, "自定义/本地模型不限制 max_tokens，避免思考型模型被截断");
});

test("没有 Key 时不发送 Authorization 头", () => {
  const request = AI.buildRequest({ ...baseConfig, provider: "ollama", key: "" }, { model: "qwen3:8b", messages: [] });
  assert.equal(request.init.headers.Authorization, undefined);
});

test("Ollama 与自定义接口无需 Key 也可用（修复原先 Ollama 不翻译的问题）", () => {
  assert.equal(AI.canUseTextModel({ ...baseConfig, provider: "ollama", key: "" }), true);
  assert.equal(AI.canUseTextModel({ ...baseConfig, provider: "custom", key: "" }), true);
  assert.equal(AI.canUseTextModel({ ...baseConfig, key: "" }), false);
});

test("模型路由：按模式选择模型，用户手动改模型时尊重用户", () => {
  assert.deepEqual(AI.resolveModels(baseConfig), { mode: "economy", translate: "deepseek-flash", summary: "deepseek-flash" });
  assert.deepEqual(AI.resolveModels({ ...baseConfig, mode: "quality" }), { mode: "quality", translate: "deepseek-flash", summary: "deepseek-v4-pro" });
  assert.deepEqual(AI.resolveModels({ ...baseConfig, model: "my-model" }), { mode: "economy", translate: "my-model", summary: "my-model" });
  assert.equal(AI.resolveModels({ ...baseConfig, summaryModel: "big" }).summary, "big");
  assert.equal(AI.resolveModels({ ...baseConfig, provider: "ollama", model: "qwen3:8b", defaultModel: "qwen3:8b" }).translate, "qwen3:8b");
});

test("清洗思考标签与代码块，宽松解析 JSON", () => {
  assert.equal(AI.cleanOutput("<think>推理…</think>\nHello"), "Hello");
  assert.equal(AI.cleanOutput("残留推理</think>Hi"), "Hi");
  assert.deepEqual(AI.parseJsonLoose('```json\n{"t":["a"]}\n```'), { t: ["a"] });
  assert.deepEqual(AI.parseJsonLoose('好的：{"t":["a","b"]} 完成'), { t: ["a", "b"] });
  assert.equal(AI.parseJsonLoose("   "), null);
});

test("语气词、过短或已是目标语言的句子跳过翻译", () => {
  assert.equal(AI.needsTranslation("嗯嗯", "en"), false);
  assert.equal(AI.needsTranslation("OK.", "zh"), false);
  assert.equal(AI.needsTranslation("我们今天确认发布计划。", "zh"), false);
  assert.equal(AI.needsTranslation("We will ship on Friday.", "en"), false);
  assert.equal(AI.needsTranslation("我们今天确认发布计划。", "en"), true);
  assert.equal(AI.needsTranslation("这个 API 的 latency 太高了", "zh"), true, "中英混说需要整理为目标语言");
});

test("Token 估算按中英文分别计算", () => {
  assert.equal(AI.estimateTokens("你好世界"), 3); // 4 × 0.6 = 2.4 → 3
  assert.equal(AI.estimateTokens("hello"), 2); // 5 × 0.3 = 1.5 → 2
});

test("用量统计：按 DeepSeek 价格估算，区分缓存命中", () => {
  const meter = new AI.UsageMeter();
  meter.record("translate", "deepseek-flash", { prompt_tokens: 1_000_000, prompt_cache_hit_tokens: 800_000, completion_tokens: 100_000 });
  const snap = meter.snapshot();
  assert.equal(snap.requests, 1);
  assert.ok(Math.abs(snap.costUsd - (0.8 * 0.006 + 0.2 * 0.3 + 0.1 * 1.2)) < 1e-9);
  meter.record("summary", "unknown-model", { prompt_tokens: 10, completion_tokens: 5 });
  assert.equal(meter.snapshot().costUsd, null, "未知模型不给出误导性费用");
  const openrouter = new AI.UsageMeter();
  openrouter.record("summary", "any", { prompt_tokens: 10, completion_tokens: 5, cost: 0.0012 });
  assert.equal(openrouter.snapshot().costUsd, 0.0012);
});

test("LRU 缓存淘汰最久未使用的条目", () => {
  const cache = new AI.LruCache(2);
  cache.set("a", 1); cache.set("b", 2); cache.get("a"); cache.set("c", 3);
  assert.equal(cache.get("b"), undefined);
  assert.equal(cache.get("a"), 1);
  assert.equal(cache.size, 2);
});

test("chatCompletion：429 按 Retry-After 重试后成功", async () => {
  const fetch = mockFetch([
    { status: 429, headers: { "retry-after": "0" } },
    { body: { choices: [{ message: { content: "ok" } }], usage: { prompt_tokens: 3, completion_tokens: 1 } } },
  ]);
  const meter = new AI.UsageMeter();
  const result = await AI.chatCompletion(baseConfig, { model: "deepseek-flash", messages: [] }, { fetchImpl: fetch, meter, backoffMs: 1 });
  assert.equal(result, "ok");
  assert.equal(fetch.calls.length, 2);
  assert.equal(meter.snapshot().requests, 1);
});

test("chatCompletion：401 不重试，直接报错", async () => {
  const fetch = mockFetch([{ status: 401 }, { status: 401 }]);
  await assert.rejects(AI.chatCompletion(baseConfig, { model: "m", messages: [] }, { fetchImpl: fetch, backoffMs: 1 }), (error) => error.status === 401);
  assert.equal(fetch.calls.length, 1);
});

test("chatCompletion：空白内容（DeepSeek JSON 失败）会重试", async () => {
  const fetch = mockFetch([
    { body: { choices: [{ message: { content: "   " } }] } },
    { body: { choices: [{ message: { content: "{\"t\":[\"x\"]}" } }] } },
  ]);
  const result = await AI.chatCompletion(baseConfig, { model: "m", messages: [], json: true }, { fetchImpl: fetch, backoffMs: 1 });
  assert.equal(result, '{"t":["x"]}');
});

test("chatCompletion：超时会中止请求", async () => {
  const hanging = (url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  });
  await assert.rejects(AI.chatCompletion(baseConfig, { model: "m", messages: [] }, { fetchImpl: hanging, timeoutMs: 20, retries: 0 }), /timeout/);
});

function makeTranslator(config, fetch) {
  const results = new Map();
  const errors = [];
  const translator = new AI.Translator({
    getConfig: () => config,
    fetchImpl: fetch,
    onTranslated: (item, translation) => results.set(item.text, translation),
    onError: (error) => errors.push(error),
  });
  return { translator, results, errors };
}

test("省钱模式：多句合并为一次请求，并带上文与术语表", async () => {
  const fetch = mockFetch([{ body: { choices: [{ message: { content: '{"t":["First.","Second.","Third."]}' } }] } }]);
  const config = { ...baseConfig, glossary: "语流 = Yuliu" };
  const { translator, results } = makeTranslator(config, fetch);
  ["第一句话内容", "第二句话内容", "第三句话内容"].forEach((text) => translator.enqueue({ text }));
  await translator.flush();
  assert.equal(fetch.calls.length, 1);
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.match(body.messages[0].content, /语流 = Yuliu/);
  assert.deepEqual(JSON.parse(body.messages[1].content).items, ["第一句话内容", "第二句话内容", "第三句话内容"]);
  assert.deepEqual(body.response_format, { type: "json_object" });
  assert.equal(results.get("第二句话内容"), "Second.");
});

test("system 提示在同一会话内保持不变，便于命中前缀缓存", async () => {
  const fetch = mockFetch([
    { body: { choices: [{ message: { content: '{"t":["A","B"]}' } }] } },
    { body: { choices: [{ message: { content: '{"t":["C","D"]}' } }] } },
  ]);
  const { translator } = makeTranslator(baseConfig, fetch);
  translator.enqueue({ text: "甲句子内容" }); translator.enqueue({ text: "乙句子内容" });
  await translator.flush();
  translator.enqueue({ text: "丙句子内容" }); translator.enqueue({ text: "丁句子内容" });
  await translator.flush();
  const [first, second] = fetch.calls.map((call) => JSON.parse(call.init.body).messages[0].content);
  assert.equal(first, second);
  assert.deepEqual(JSON.parse(JSON.parse(fetch.calls[1].init.body).messages[1].content).context, ["甲句子内容", "乙句子内容"]);
});

test("批量结果数量不一致时退回逐句翻译，不丢句", async () => {
  const fetch = mockFetch([
    { body: { choices: [{ message: { content: '{"t":["only one"]}' } }] } },
    { body: { choices: [{ message: { content: "One" } }] } },
    { body: { choices: [{ message: { content: "Two" } }] } },
  ]);
  const { translator, results } = makeTranslator(baseConfig, fetch);
  translator.enqueue({ text: "第一句内容" }); translator.enqueue({ text: "第二句内容" });
  await translator.flush();
  assert.equal(fetch.calls.length, 3);
  assert.equal(results.get("第一句内容"), "One");
  assert.equal(results.get("第二句内容"), "Two");
});

test("重复句子命中本地缓存，不再请求", async () => {
  const fetch = mockFetch([{ body: { choices: [{ message: { content: "Hello there" } }] } }]);
  const { translator, results } = makeTranslator({ ...baseConfig, mode: "quality" }, fetch);
  translator.enqueue({ text: "大家好呀" });
  await translator.flush();
  translator.enqueue({ text: "大家好呀" });
  await translator.flush();
  assert.equal(fetch.calls.length, 1);
  assert.equal(translator.meter.snapshot().cacheHits, 1);
  assert.equal(results.get("大家好呀"), "Hello there");
});

test("高质量模式：每句立即发送并附带上文", async () => {
  const fetch = mockFetch([
    { body: { choices: [{ message: { content: "A" } }] } },
    { body: { choices: [{ message: { content: "B" } }] } },
  ]);
  const { translator } = makeTranslator({ ...baseConfig, mode: "quality" }, fetch);
  translator.enqueue({ text: "我们先看预算" });
  translator.enqueue({ text: "它超出了百分之十" });
  await translator.flush();
  assert.equal(fetch.calls.length, 2);
  assert.match(JSON.parse(fetch.calls[1].init.body).messages[1].content, /context：我们先看预算/);
});

test("翻译关闭或未配置模型时不发请求", async () => {
  const fetch = mockFetch([]);
  makeTranslator({ ...baseConfig, target: "off" }, fetch).translator.enqueue({ text: "你好世界呀" });
  makeTranslator({ ...baseConfig, key: "" }, fetch).translator.enqueue({ text: "你好世界呀" });
  assert.equal(fetch.calls.length, 0);
});

test("401 错误只回调一次 onError，不逐句重试", async () => {
  const fetch = mockFetch([{ status: 401 }]);
  const { translator, errors } = makeTranslator(baseConfig, fetch);
  translator.enqueue({ text: "第一句内容" }); translator.enqueue({ text: "第二句内容" });
  await translator.flush();
  assert.equal(fetch.calls.length, 1);
  assert.equal(errors.length, 1);
});

test("时间线合并同一说话人的连续句子", () => {
  const timeline = AI.formatTimeline([
    { speaker: 1, time: "00:01", text: "大家好" },
    { speaker: 1, time: "00:03", text: "开始吧" },
    { speaker: 2, time: "00:05", text: "好的" },
  ]);
  assert.deepEqual(timeline, ["[00:01] S1: 大家好 开始吧", "[00:05] S2: 好的"]);
});

const summaryJson = (overrides = {}) => JSON.stringify({
  title: "发布计划", summary: "确认发布。", key_points: ["S1 提出周五发布"], decisions: ["周五发布"],
  action_items: [{ task: "整理测试反馈", owner: "S2", due: "周五" }], open_questions: [], ...overrides,
});

test("短会议：一次请求得到结构化总结", async () => {
  const fetch = mockFetch([{ body: { choices: [{ message: { content: summaryJson() } }] } }]);
  const summarizer = new AI.Summarizer({ fetchImpl: fetch });
  const summary = await summarizer.summarize({ ...baseConfig, mode: "quality" }, [{ speaker: 1, time: "00:01", text: "我们周五发布" }]);
  assert.equal(fetch.calls.length, 1);
  const body = JSON.parse(fetch.calls[0].init.body);
  assert.equal(body.model, "deepseek-v4-pro");
  assert.match(body.messages[0].content, /不推测、不编造/);
  assert.deepEqual(summary.action_items, [{ task: "整理测试反馈", owner: "S2", due: "周五" }]);
  assert.match(AI.summaryToText(summary), /负责人：S2/);
});

test("长会议：分段提取 + 合并；继续录音后只总结新增分段", async () => {
  const lines = Array.from({ length: 400 }, (_, index) => ({ speaker: (index % 2) + 1, time: "00:00", text: `第${index}句，讨论了预算、进度、风险和下一步安排，内容比较长一些。` }));
  const config = { ...baseConfig, provider: "ollama", key: "" }; // Ollama 预算 2500 token，强制分段
  const responder = (url, init) => {
    const user = JSON.parse(init.body).messages[1].content;
    return { body: { choices: [{ message: { content: summaryJson({ summary: user.startsWith("以下是同一场会议") ? "合并" : "分段" }) } }] } };
  };
  const fetch = mockFetch(responder);
  const summarizer = new AI.Summarizer({ fetchImpl: fetch });
  const summary = await summarizer.summarize(config, lines);
  const firstCalls = fetch.calls.length;
  const chunks = AI.chunkTimeline(AI.formatTimeline(lines), AI.SUMMARY_CHUNK_BUDGET.ollama).length;
  assert.ok(chunks > 1);
  assert.equal(firstCalls, chunks + 1);
  assert.equal(summary.summary, "合并");

  const more = lines.concat([{ speaker: 1, time: "10:00", text: "补充一句新的结论。" }]);
  await summarizer.summarize(config, more);
  assert.ok(fetch.calls.length - firstCalls <= 3, "旧分段命中缓存，只重算新增分段与合并");
});

test("模型未按 JSON 输出时保留原文作为摘要", () => {
  assert.equal(AI.normalizeSummary(AI.parseJsonLoose("纯文本摘要")), null);
  const merged = AI.mergePartials([AI.normalizeSummary({ summary: "a", key_points: ["x"] }), AI.normalizeSummary({ summary: "b", key_points: ["x", "y"] })]);
  assert.deepEqual(merged.key_points, ["x", "y"]);
});
