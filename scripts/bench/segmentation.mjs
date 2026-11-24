// 断句策略基准：固定 6 秒切段（旧） vs VAD 停顿断句（新）
// 用固定随机种子合成“会议”音量序列：语句 1–8 秒、句间停顿 0.2–1.6 秒、偶尔 5–20 秒长静音。
// 运行：node scripts/bench/segmentation.mjs
await import("../../public/speech-core.js");
const S = globalThis.YuliuSpeech;

const STEP = 50;
let seed = 20261124;
const rand = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32);

function synthMeeting(totalMs) {
  const frames = []; // { speech: bool, rms }
  const utterances = [];
  let t = 0;
  while (t < totalMs) {
    const pause = rand() < 0.08 ? 5000 + rand() * 15000 : 200 + rand() * 1400;
    for (let i = 0; i < pause; i += STEP) frames.push({ speech: false, rms: 0.003 + rand() * 0.004 });
    t = frames.length * STEP;
    const length = 1000 + rand() * 7000;
    const start = t;
    for (let i = 0; i < length; i += STEP) {
      const syllableGap = i % 300 >= 220; // 音节间隙
      frames.push({ speech: true, rms: syllableGap ? 0.008 : 0.04 + rand() * 0.08 });
    }
    t = frames.length * STEP;
    utterances.push({ start, end: t, pauseBefore: pause });
  }
  return { frames, utterances };
}

function evaluate(name, cutsAt, frames, utterances, uploadedMs) {
  const inSpeech = cutsAt.filter((ms) => frames[Math.floor(ms / STEP)]?.speech).length;
  // 延迟：句子结束 → 包含该句结尾的片段被切出（可以发送识别）的时间
  // 只统计后面跟着 ≥500ms 停顿的句末（真正的句子边界；更短的是句内换气）
  const boundaries = utterances.filter((u, i) => (utterances[i + 1]?.pauseBefore ?? 1000) >= 500);
  const latencies = boundaries.map((u) => {
    const cut = cutsAt.find((ms) => ms >= u.end);
    return cut === undefined ? 0 : cut - u.end;
  });
  latencies.sort((a, b) => a - b);
  const avg = latencies.reduce((a, b) => a + b, 0) / latencies.length;
  const p90 = latencies[Math.floor(latencies.length * 0.9)];
  const total = frames.length * STEP;
  return {
    策略: name,
    片段数: cutsAt.length,
    切在说话中途: `${inSpeech} (${((inSpeech / cutsAt.length) * 100).toFixed(1)}%)`,
    句末到出字幕P50ms: Math.round(latencies[Math.floor(latencies.length * 0.5)]),
    句末到出字幕平均ms: Math.round(avg),
    句末到出字幕P90ms: Math.round(p90),
    上传音频占比: `${((uploadedMs / total) * 100).toFixed(1)}%`,
  };
}

const { frames, utterances } = synthMeeting(60 * 60 * 1000); // 1 小时

// 旧：每 6 秒硬切，全部上传
const fixedCuts = [];
for (let ms = 6000; ms <= frames.length * STEP; ms += 6000) fixedCuts.push(ms);
const fixed = evaluate("固定 6 秒", fixedCuts, frames, utterances, frames.length * STEP);

// 新：VAD
const vad = S.createVadSegmenter();
const vadCuts = [];
let uploaded = 0;
let segStart = 0;
vad.update(0, 0);
frames.forEach((frame, index) => {
  const now = (index + 1) * STEP;
  const decision = vad.update(frame.rms, now);
  if (decision) {
    vadCuts.push(now);
    if (decision.hasSpeech) uploaded += now - segStart;
    segStart = now;
  }
});
const vadResult = evaluate("VAD 停顿断句", vadCuts, frames, utterances, uploaded);

console.log(`合成会议：60 分钟，${utterances.length} 句话\n`);
console.table([fixed, vadResult]);
