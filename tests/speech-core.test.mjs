import { test } from "node:test";
import assert from "node:assert/strict";
// speech-core.js 是浏览器经典脚本（UMD），在 Node 中加载后挂载到 globalThis.YuliuSpeech
await import("../public/speech-core.js");
const S = globalThis.YuliuSpeech;

/** 模拟正常说话：音节之间有短暂的低电平 */
function speech(duration, level = 0.08) {
  const out = [];
  for (let t = 0; t < duration; t += 300) out.push([200, level], [100, 0.006]);
  return out;
}

/** 按 50ms 采样，把 [时长ms, rms] 序列喂给断句器，返回切段结果 */
const clocks = new WeakMap();
function feed(segmenter, pattern, step = 50) {
  const cuts = [];
  let now = clocks.get(segmenter);
  if (now === undefined) {
    now = 0;
    segmenter.update(0.001, now);
  }
  for (const [duration, rms] of pattern) {
    for (let elapsed = 0; elapsed < duration; elapsed += step) {
      now += step;
      const decision = segmenter.update(rms, now);
      if (decision) cuts.push({ at: now, ...decision });
    }
  }
  clocks.set(segmenter, now);
  return cuts;
}

test("VAD 在句间停顿处切段，而不是在说话中途", () => {
  const vad = S.createVadSegmenter();
  const cuts = feed(vad, [[400, 0.003], ...speech(2400), [900, 0.003], ...speech(3000), [900, 0.003]]);
  assert.equal(cuts.length, 2);
  assert.ok(cuts.every((cut) => cut.reason === "pause" && cut.hasSpeech));
  // 第一刀应落在第一段语音之后的静音里（2900ms 之后，650ms 静音判定）
  assert.ok(cuts[0].at > 2800 && cuts[0].at <= 2800 + 900);
});

test("VAD 太短的片段不切，避免碎片化", () => {
  const vad = S.createVadSegmenter();
  const cuts = feed(vad, [...speech(600), [800, 0.003], ...speech(600), [1000, 0.003]]);
  assert.equal(cuts.length, 1);
  assert.ok(cuts[0].durationMs >= S.VAD_DEFAULTS.minSegmentMs);
});

test("VAD 连续说话时到达上限强制切段", () => {
  const vad = S.createVadSegmenter({ maxSegmentMs: 5000 });
  const cuts = feed(vad, speech(11100));
  assert.equal(cuts.length, 2);
  assert.ok(cuts.every((cut) => cut.reason === "max"));
});

test("VAD 长时间静音切出的片段标记为无语音（不上传）", () => {
  const vad = S.createVadSegmenter({ maxSegmentMs: 6000 });
  const cuts = feed(vad, [[7000, 0.004]]);
  assert.ok(cuts.length >= 1);
  assert.ok(cuts.every((cut) => !cut.hasSpeech));
});

test("VAD 自适应噪声底：稳定背景噪声不会被当成语音", () => {
  const vad = S.createVadSegmenter();
  feed(vad, [[6000, 0.02]]); // 空调/风扇类稳定噪声
  assert.ok(vad.threshold > 0.02);
  // 之后正常说话仍能被检测到
  const cuts = feed(vad, [...speech(2400, 0.12), [900, 0.004]]);
  assert.ok(cuts.some((cut) => cut.hasSpeech));
});

test("rmsFromTimeDomain", () => {
  assert.equal(S.rmsFromTimeDomain(new Uint8Array([128, 128, 128])), 0);
  assert.ok(Math.abs(S.rmsFromTimeDomain(new Uint8Array([0, 255])) - 1) < 0.01);
});

test("过滤 Whisper 静音幻觉", () => {
  for (const text of ["谢谢观看", "谢谢大家收看！", "字幕由Amara.org社区提供", "Thank you for watching.", "you", "请不吝点赞 订阅 转发 打赏支持明镜与点点栏目", "好的好的好的好的好的好的", "[Music]"]) {
    assert.equal(S.isLikelyHallucination(text), true, text);
  }
  for (const text of ["谢谢大家今天的参与，我们下周再同步进度。", "Thanks, let's move on to the roadmap.", "我们用 Kubernetes 部署 RAG 服务。"]) {
    assert.equal(S.isLikelyHallucination(text), false, text);
  }
});

test("语言判定与是否翻译（中英混合）", () => {
  assert.equal(S.dominantLanguage("我们下周发布 v2 版本"), "zh");
  assert.equal(S.dominantLanguage("Let's ship the v2 release next week"), "en");
  assert.equal(S.dominantLanguage("这个 feature 的 latency 还是太高"), "zh");
  assert.equal(S.shouldTranslate("Let's ship it", "en"), false);
  assert.equal(S.shouldTranslate("我们发布吧", "en"), true);
  assert.equal(S.shouldTranslate("我们发布吧", "off"), false);
  assert.equal(S.shouldTranslate("Let's ship it", "zh"), true);
});

test("本地补全句末标点", () => {
  assert.equal(S.ensureTerminalPunctuation("我们今天确认发布计划"), "我们今天确认发布计划。");
  assert.equal(S.ensureTerminalPunctuation("这个方案可以吗"), "这个方案可以吗？");
  assert.equal(S.ensureTerminalPunctuation("what is the deadline"), "What is the deadline?");
  assert.equal(S.ensureTerminalPunctuation("we ship on friday"), "We ship on friday.");
  assert.equal(S.ensureTerminalPunctuation("已经有标点了！"), "已经有标点了！");
});

test("解析术语表", () => {
  const glossary = S.parseGlossary("Kubernetes\n大模型 = LLM\nRAG => 检索增强生成\nkubernetes\n\nTTS，ASR");
  assert.deepEqual(glossary, [
    { source: "Kubernetes" },
    { source: "大模型", target: "LLM" },
    { source: "RAG", target: "检索增强生成" },
    { source: "TTS" },
    { source: "ASR" },
  ]);
});

test("识别 prompt：术语在前，保留上一段结尾，长度受限", () => {
  const prompt = S.buildTranscriptionPrompt({
    glossary: [{ source: "Kubernetes" }, { source: "大模型", target: "LLM" }],
    previousText: "开头的内容".repeat(200) + "最后一句是关于部署的。",
    maxChars: 120,
  });
  assert.ok(prompt.length <= 120);
  assert.ok(prompt.startsWith("Glossary: Kubernetes, 大模型, LLM."));
  assert.ok(prompt.endsWith("最后一句是关于部署的。"));
  assert.equal(S.buildTranscriptionPrompt({}), "");
});

test("翻译 messages 包含上下文、术语表并隔离转写内容", () => {
  const messages = S.buildTranslationMessages({
    text: "我们用 RAG 改进检索",
    target: "en",
    context: ["上一句"],
    glossary: [{ source: "RAG", target: "RAG" }],
    polish: true,
  });
  assert.equal(messages.length, 2);
  assert.match(messages[0].content, /RAG → RAG/);
  assert.match(messages[1].content, /上一句/);
  assert.match(messages[1].content, /<transcript>\n我们用 RAG 改进检索\n<\/transcript>/);
  assert.match(messages[1].content, /JSON/);
});

test("解析润色+翻译结果，容错代码块与思考内容", () => {
  const original = "我们今天确认发布计划";
  const content = "<think>...</think>\n```json\n{\"text\":\"我们今天确认发布计划。\",\"translation\":\"We confirm the release plan today.\"}\n```";
  assert.deepEqual(S.parseTranslationResult(content, original, true), { text: "我们今天确认发布计划。", translation: "We confirm the release plan today." });
  // 模型擅自改写（长度变化过大）→ 不采用润色，只用译文
  const rewritten = JSON.stringify({ text: "会议确认了发布计划并讨论了很多其他相关事项和后续安排", translation: "x" });
  assert.equal(S.parseTranslationResult(rewritten, original, true).text, "");
  // 非 JSON 回退为纯译文
  assert.deepEqual(S.parseTranslationResult("We confirm the plan.", original, true), { text: "", translation: "We confirm the plan." });
  assert.deepEqual(S.parseTranslationResult(" Hello ", original, false), { text: "", translation: "Hello" });
});

test("云端识别错误分级", () => {
  assert.equal(S.classifyTranscribeFailure(401), "fatal");
  assert.equal(S.classifyTranscribeFailure(400), "fatal");
  assert.equal(S.classifyTranscribeFailure(0), "retry");
  assert.equal(S.classifyTranscribeFailure(429), "retry");
  assert.equal(S.classifyTranscribeFailure(502), "retry");
  assert.ok(S.retryDelayMs(0) < S.retryDelayMs(1));
});
