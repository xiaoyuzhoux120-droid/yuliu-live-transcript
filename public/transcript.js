"use strict";

const $ = (selector) => document.querySelector(selector);
const Speech = window.YuliuSpeech;
let recognition = null;
let recording = false;
let recognitionMode = "";
let startTime = 0;
let tick = null;
let lines = [];
let demoTimer = null;
let activeSpeaker = 1;
let speakerCount = 2;
let mediaStream = null;
let mediaRecorder = null;
let segmentTimer = null;
let transcriptionQueue = Promise.resolve();
let uiLanguage = "zh";
let audioContext = null;
let analyser = null;
let meterFrame = null;
let detectedSound = false;
let soundWatchdog = null;
let recognitionWatchdog = null;
let micTestUrl = "";
// Elapsed time from earlier recordings in this session, so "Record again" keeps timestamps monotonic.
let elapsedOffset = 0;
// Bumped whenever the transcript is reset or a new summary starts; late async results compare against it.
let summaryGeneration = 0;
let cloudFailureStreak = 0;
let pendingSegmentStop = null;
let nextLineId = 1;
let toastTimer = null;

// Timing knobs. Tests may override them before this script loads via window.__YULIU_TUNING__.
const TUNING = Object.assign({
  segmentMs: 6000,
  transcribeTimeoutMs: 45000,
  translateTimeoutMs: 20000,
  summaryTimeoutMs: 90000,
  maxCloudFailures: 3,
  retryDelayMs: 1500,
  transcribeRetries: 2,
  recognitionEndGraceMs: 1500,
  vad: {}, // overrides for Speech.VAD_DEFAULTS (pause-based segmentation)
}, window.__YULIU_TUNING__ || {});
let meterSamples = null;
let vadSegmenter = null;
let vadTimer = null;
let glossary = [];
const VAD_OPTIONS = { ...Speech.VAD_DEFAULTS, ...TUNING.vad };
const MAX_SEGMENT_MS = VAD_OPTIONS.maxSegmentMs;
let lastSummary = null; // structured summary from ai-engine.js (title, key_points, action_items…)
let summaryState = "idle"; // idle | nomodel | working | done | failed | none
// Workspace state (session, view, history)
let sessionId = newSessionId();
let sessionCreatedAt = Date.now();
let isDemoSession = false;
let speakerNames = {};
let scene = "meeting";
let viewMode = "both";
let fontSize = 18;
let searchQuery = "";
let searchCursor = -1;
let autosaveTimer = null;
let sideTimer = null;
let autosaveEnabled = readPref("yuliu:autosave", "1") === "1";
const armedActions = new Map();
const HISTORY_KEY = "yuliu:sessions:v1";
const HISTORY_LIMIT = 60;
const scenePresets = {
  meeting: {},
  class: { 1: ["老师", "Teacher"], 2: ["学生", "Student"] },
  interview: { 1: ["主持人", "Host"], 2: ["嘉宾", "Guest"] },
};

const config = {
  key: "",
  endpoint: "https://api.deepseek.com/chat/completions",
  model: "deepseek-flash",
  defaultModel: "deepseek-flash",
  provider: "deepseek",
  mode: "economy",
  summaryModel: "",
  glossary: "",
};

const AI = window.YuliuAI;
const usageMeter = new AI.UsageMeter();
let lastModelErrorToast = 0;

function textModelConfig() {
  return { ...config, target: $("#targetLang").value, summaryLanguage: "auto" };
}

function reportModelError(error) {
  // 同一类失败 20 秒内只提示一次，避免每句翻译都弹出错误。
  if (Date.now() - lastModelErrorToast < 20000) return;
  lastModelErrorToast = Date.now();
  const auth = error?.status === 401 || error?.status === 403;
  toast(auth ? t("文本模型 API Key 无效，已保留原始转写", "Text model API key rejected; original transcript kept") : t("翻译或总结模型连接失败，已保留原始转写", "Translation or summary model failed; original transcript kept"));
}

const translator = new AI.Translator({
  getConfig: textModelConfig,
  meter: usageMeter,
  timeoutMs: TUNING.translateTimeoutMs,
  onTranslated: (item, translation) => {
    // Re-translations after an edit are queued as { text, line }; drop them if the text changed again.
    const line = item.line || item;
    if (!lines.includes(line) || (item.line && line.text !== item.text)) return; // reset or edited meanwhile
    line.translation = translation;
    updateLineElement(line);
  },
  onError: reportModelError,
});
const summarizer = new AI.Summarizer({ meter: usageMeter, timeoutMs: TUNING.summaryTimeoutMs });

const speechConfig = {
  mode: "auto",
  provider: "openai",
  model: "gpt-transcribe",
  key: "",
  glossary: "",
  failed: false,
};

const providers = {
  deepseek: {
    name: "DeepSeek",
    endpoint: "https://api.deepseek.com/chat/completions",
    model: "deepseek-flash",
    models: ["deepseek-flash", "deepseek-v4-pro"],
    hint: "DeepSeek 官方 OpenAI 兼容接口",
    note: "DeepSeek 用于文字润色、翻译和总结；语音转文字由上方单独配置。",
  },
  siliconflow: {
    name: "硅基流动",
    endpoint: "https://api.siliconflow.cn/v1/chat/completions",
    model: "Pro/deepseek-ai/DeepSeek-R1",
    models: ["Pro/deepseek-ai/DeepSeek-R1", "Qwen/Qwen3-32B"],
    hint: "硅基流动 OpenAI 兼容接口",
    note: "可使用 DeepSeek、Qwen、GLM 等开源模型；请填写平台显示的完整模型 ID。",
  },
  openrouter: {
    name: "OpenRouter",
    endpoint: "https://openrouter.ai/api/v1/chat/completions",
    model: "deepseek/deepseek-chat",
    models: ["deepseek/deepseek-chat", "qwen/qwen3-32b"],
    hint: "OpenRouter 多模型聚合接口",
    note: "通过一个接口切换多个开源模型；模型 ID 可在 OpenRouter 模型页复制。",
  },
  groq: {
    name: "Groq",
    endpoint: "https://api.groq.com/openai/v1/chat/completions",
    model: "openai/gpt-oss-20b",
    models: ["openai/gpt-oss-20b", "llama-3.3-70b-versatile"],
    hint: "Groq OpenAI 兼容高速推理接口",
    note: "适合低延迟翻译和快速总结；可手动替换为账号可用的模型 ID。",
  },
  ollama: {
    name: "Ollama",
    endpoint: "http://localhost:11434/v1/chat/completions",
    model: "qwen3:8b",
    models: ["qwen3:8b", "deepseek-r1:8b", "llama3.1:8b"],
    hint: "本机 Ollama OpenAI 兼容地址",
    note: "模型在你的设备内运行，不需要 API Key。浏览器访问本地服务时需要把 OLLAMA_ORIGINS 设为本站地址，不要设为 *，否则任何网页都能调用你的本地模型。",
  },
  custom: {
    name: "自定义",
    endpoint: "",
    model: "",
    models: [],
    hint: "填写完整的 /chat/completions 地址",
    note: "支持任何实现 OpenAI Chat Completions 返回格式的服务。",
  },
};

const speechProviders = {
  openai: {
    name: "OpenAI",
    model: "gpt-transcribe",
    placeholder: "输入 OpenAI API Key",
  },
  groq: {
    name: "Groq Whisper",
    model: "whisper-large-v3-turbo",
    placeholder: "输入 Groq API Key",
  },
};

function supportsNativeRecognition() {
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition);
}

function supportsCloudRecording() {
  return Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);
}

function t(chinese, english) {
  return uiLanguage === "zh" ? chinese : english;
}

function setText(selector, chinese, english) {
  const element = $(selector);
  if (element) element.textContent = t(chinese, english);
}

function setDirectText(selector, chinese, english) {
  const element = $(selector);
  if (!element) return;
  const textNode = Array.from(element.childNodes).find((node) => node.nodeType === Node.TEXT_NODE && node.textContent.trim());
  if (textNode) textNode.textContent = t(chinese, english);
}

function applyUiLanguage() {
  document.documentElement.lang = uiLanguage === "zh" ? "zh-CN" : "en";
  $("#uiLangBtn").textContent = uiLanguage === "zh" ? "English" : "中文";
  setDirectText(".nav button.active", "实时转写", "Live transcript");
  setDirectText("#historyBtn", "最近记录", "Recent sessions");
  setText(".privacy", "隐私设置", "Privacy");
  setText(".title h1", "实时转写", "Live transcript");
  setText(".title p", "让每一句话都清楚、准确、有上下文。", "Clear, accurate, contextual notes from every conversation.");
  updateProviderBadge();
  if (!recording) {
    setText("#statusText", lines.length ? "转写已完成" : "准备就绪", lines.length ? "Transcription complete" : "Ready");
    setText("#statusSub", lines.length ? `共记录 ${lines.length} 段内容` : (supportsNativeRecognition() ? "点击开始，允许麦克风访问" : "当前浏览器需配置云端语音识别"), lines.length ? `${lines.length} segments captured` : (supportsNativeRecognition() ? "Press start and allow microphone access" : "Cloud speech recognition is required in this browser"));
  }
  $("#sourceLang").options[0].text = t("中文", "Chinese");
  $("#sourceLang").options[1].text = "English";
  if ($("#sourceLang").options[2]) $("#sourceLang").options[2].text = t("中英混合", "Mixed zh/en");
  setText("label[for=glossary]", "专业术语表（可选）", "Glossary (optional)");
  $("#targetLang").options[0].text = "English";
  $("#targetLang").options[1].text = t("中文", "Chinese");
  $("#targetLang").options[2].text = t("不翻译", "Off");
  setText(".auto", "AI 自动纠错与标点", "AI punctuation and cleanup");
  setText(".micbar label", "麦克风", "Microphone");
  setText("#testMicBtn", "测试 3 秒", "Test 3 sec");
  if (!$("#micResult").classList.contains("ok") && !$("#micResult").classList.contains("warn")) setText("#micResult", "等待测试", "Not tested");
  setText(".speakerbar-label", "说话人区分", "Speakers");
  document.querySelectorAll("[data-zh]").forEach((element) => { element.textContent = t(element.dataset.zh, element.dataset.en); });
  document.querySelectorAll("[data-zh-ph]").forEach((element) => { element.placeholder = t(element.dataset.zhPh, element.dataset.enPh); });
  const sceneOptions = $("#sceneSelect")?.options;
  if (sceneOptions) [["会议", "Meeting"], ["课堂", "Lecture"], ["访谈", "Interview"]].forEach((pair, index) => { sceneOptions[index].text = t(...pair); });
  refreshSpeakerButtons();
  setText("#addSpeaker", "＋ 添加", "+ Add");
  setText(".speakerhelp", "录音时点按或按数字键切换 · 双击改名", "Tap or press 1–9 to switch · double-click to rename");
  if (!recording) setText("#recordLabel", lines.length ? "继续录音" : "开始录音", lines.length ? "Record again" : "Start recording");
  setText("#demoBtn", "体验演示", "Try demo");
  setText(".summary .eyebrow", "AI 摘要", "AI summary");
  if (summaryState !== "idle") restoreSummary(summaryState);
  else if (!lines.length) {
    setText("#summaryTitle", "录音结束后生成", "Generated after recording");
    setText("#summaryText", "将自动提炼核心结论、关键决定和下一步行动。", "Extract key conclusions, decisions, and next steps automatically.");
  }
  setText(".detail .eyebrow", "会话洞察", "Session insights");
  const insights = document.querySelectorAll(".detail .insight");
  if (insights[0]) { insights[0].querySelector("strong").textContent = t("说话人区分", "Speaker labels"); insights[0].querySelector("p").textContent = t("区分不同发言人，并可点按标签快速校正。", "Label speakers and tap any label to correct it quickly."); }
  if (insights[1]) { insights[1].querySelector("strong").textContent = t("实时翻译", "Live translation"); insights[1].querySelector("p").textContent = t("原文与译文同步对照，适合访谈与跨国会议。", "View source and translation together for interviews and global meetings."); }
  updateSideSoon();
  if (insights[2]) { insights[2].querySelector("strong").textContent = t("结构化总结", "Structured summary"); insights[2].querySelector("p").textContent = t("按发言人提取摘要、决定与待办事项。", "Extract summaries, decisions, and action items by speaker."); }
  setText("#modalTitle", "语音与模型设置", "Speech and model settings");
  setText(".dialog > p", "先选择语音转文字方式，再按需连接翻译与总结模型。密钥只保存在当前页面内存中，刷新即清除；语音 Key 会经本站转发给语音服务但不会被记录，文本模型 Key 由浏览器直接发送到你填写的接口。", "Choose speech-to-text first, then optionally connect a translation and summary model. Keys live only in this page's memory and are cleared on reload. The speech key is relayed through this site to the speech service without being logged; the text model key goes straight from your browser to the endpoint you enter.");
  const sectionTitles = document.querySelectorAll(".settings-section-title");
  if (sectionTitles[0]) sectionTitles[0].textContent = t("语音转文字", "Speech to text");
  if (sectionTitles[1]) sectionTitles[1].textContent = t("翻译与会后总结", "Translation and summary");
  const speechLabels = document.querySelectorAll(".speech-grid label");
  const labelPairs = [["识别方式", "Recognition mode"], ["云端服务", "Cloud service"], ["语音模型", "Speech model"], ["语音 API Key", "Speech API key"]];
  speechLabels.forEach((label, index) => { if (labelPairs[index]) label.textContent = t(...labelPairs[index]); });
  $("#speechMode").options[0].text = t("自动选择", "Auto");
  $("#speechMode").options[1].text = t("浏览器实时识别", "Browser live recognition");
  $("#speechMode").options[2].text = t("云端精准识别", "Cloud transcription");
  const notes = document.querySelectorAll(".provider-note");
  if (notes[0]) notes[0].textContent = t("ChatGPT 登录只用于账号验证，不包含 OpenAI API 额度。云端识别会在说话停顿处自动断句后更新字幕。", "ChatGPT sign-in verifies your account; it does not include OpenAI API credits. Cloud captions update at natural pauses.");
  // Label by the input they belong to: index-based lookup broke whenever a field was added above.
  const textLabelPairs = { endpoint: ["Chat Completions 地址", "Chat Completions endpoint"], model: ["模型名称", "Model name"], apiKey: ["API Key", "API key"], aiMode: ["运行模式", "Run mode"], summaryModel: ["总结模型（可选）", "Summary model (optional)"] };
  Object.entries(textLabelPairs).forEach(([id, pair]) => setText(`label[for=${id}]`, ...pair));
  if ($("#aiMode")) {
    $("#aiMode").options[0].text = t("省钱模式：合并翻译请求、关闭思考", "Economy: batched translation, no reasoning");
    $("#aiMode").options[1].text = t("高质量模式：逐句带上文翻译、强模型总结", "Quality: per-line contextual translation, stronger summary model");
    $("#summaryModel").placeholder = t("留空则按模式自动选择", "Leave empty to pick by mode");
    $("#glossary").placeholder = t("每行一条，例如：语流 = Yuliu；OKR = OKR", "One per line, e.g. 语流 = Yuliu");
  }
  if (notes[1]) notes[1].textContent = uiLanguage === "zh" ? providers[config.provider].note : "Connect any OpenAI-compatible text model for translation and meeting summaries.";
  $("#endpointHint").textContent = uiLanguage === "zh" ? providers[config.provider].hint : "OpenAI-compatible text model endpoint";
  $("#speechKey").placeholder = uiLanguage === "zh" ? speechProviders[speechConfig.provider].placeholder : `Enter ${speechProviders[speechConfig.provider].name} API key`;
  setText("#cancelBtn", "取消", "Cancel");
  setText("#saveBtn", "保存设置", "Save settings");
  updateSpeechSupport();
  refreshMicrophones();
}

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  // Reset the timer so an earlier toast's timeout cannot hide a newer message early.
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => element.classList.remove("show"), 2600);
}

function sleep(ms) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

// fetch() with a hard timeout so a stalled provider cannot freeze the queue or the summary forever.
async function fetchWithTimeout(url, options, timeoutMs) {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    window.clearTimeout(timer);
  }
}


function microphoneConstraints() {
  const selected = $("#micDevice")?.value;
  return {
    echoCancellation: true,
    noiseSuppression: true,
    autoGainControl: true,
    ...(selected ? { deviceId: { exact: selected } } : {}),
  };
}

async function refreshMicrophones() {
  if (!navigator.mediaDevices?.enumerateDevices || !$("#micDevice")) return;
  try {
    const previous = $("#micDevice").value;
    const devices = (await navigator.mediaDevices.enumerateDevices()).filter((device) => device.kind === "audioinput");
    $("#micDevice").innerHTML = `<option value="">${t("系统默认麦克风", "System default microphone")}</option>` + devices.map((device, index) => `<option value="${escapeHtml(device.deviceId)}">${escapeHtml(device.label || `${t("麦克风", "Microphone")} ${index + 1}`)}</option>`).join("");
    if (devices.some((device) => device.deviceId === previous)) $("#micDevice").value = previous;
  } catch { /* device labels may require permission */ }
}

function startAudioMeter(stream) {
  stopAudioMeter();
  detectedSound = false;
  const AudioContextClass = window.AudioContext || window.webkitAudioContext;
  if (!AudioContextClass) return;
  audioContext = new AudioContextClass();
  analyser = audioContext.createAnalyser();
  analyser.fftSize = 256;
  analyser.smoothingTimeConstant = 0.72;
  const source = audioContext.createMediaStreamSource(stream);
  source.connect(analyser);
  meterSamples = new Uint8Array(analyser.fftSize);
  const bars = Array.from(document.querySelectorAll(".meter i"));
  $(".meter")?.classList.add("mic-live");
  const update = () => {
    const rms = currentRms();
    const level = Math.min(1, rms * 9);
    bars.forEach((bar, index) => {
      const shape = [0.55, 0.82, 1, 0.76, 0.48][index] || 0.6;
      bar.style.height = `${Math.max(6, Math.round(6 + level * 23 * shape))}px`;
    });
    meterFrame = window.requestAnimationFrame(update);
  };
  update();
}

function currentRms() {
  if (!analyser || !meterSamples) return 0;
  analyser.getByteTimeDomainData(meterSamples);
  const rms = Speech.rmsFromTimeDomain(meterSamples);
  if (rms > 0.018) detectedSound = true;
  return rms;
}

function stopAudioMeter() {
  if (meterFrame) window.cancelAnimationFrame(meterFrame);
  meterFrame = null;
  analyser = null;
  meterSamples = null;
  if (audioContext) audioContext.close().catch(() => {});
  audioContext = null;
  const meter = $(".meter");
  meter?.classList.remove("mic-live", "mic-silent");
  document.querySelectorAll(".meter i").forEach((bar) => { bar.style.height = "8px"; });
}

function scheduleSoundCheck() {
  window.clearTimeout(soundWatchdog);
  window.clearTimeout(recognitionWatchdog);
  soundWatchdog = window.setTimeout(() => {
    if (!recording || detectedSound) return;
    $(".meter")?.classList.add("mic-silent");
    $("#statusSub").textContent = t("没有检测到麦克风声音，请选择其他麦克风或运行测试", "No microphone input detected. Choose another device or run the mic test.");
  }, 3500);
  recognitionWatchdog = window.setTimeout(() => {
    if (!recording || recognitionMode !== "browser" || !detectedSound || lines.length) return;
    $("#statusSub").textContent = t("已检测到声音，但浏览器没有返回文字；请切换到云端精准识别", "Audio is present, but the browser returned no text. Switch to cloud transcription.");
  }, 9000);
}

async function testMicrophone() {
  if (recording) return toast(t("请先结束当前录音", "Stop the current recording first"));
  if (!navigator.mediaDevices?.getUserMedia) return toast(t("当前浏览器无法访问麦克风", "This browser cannot access the microphone"));
  $("#testMicBtn").disabled = true;
  $("#testMicBtn").textContent = t("测试中…", "Testing…");
  $("#micResult").className = "mic-result";
  $("#micResult").textContent = t("请正常说话", "Speak normally");
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
    await refreshMicrophones();
    startAudioMeter(stream);
    const chunks = [];
    const mimeType = preferredAudioType();
    const recorder = window.MediaRecorder ? new MediaRecorder(stream, mimeType ? { mimeType } : undefined) : null;
    if (recorder) {
      recorder.ondataavailable = (event) => { if (event.data?.size) chunks.push(event.data); };
      recorder.start();
    }
    await new Promise((resolve) => window.setTimeout(resolve, 3000));
    if (recorder?.state === "recording") {
      await new Promise((resolve) => { recorder.onstop = resolve; recorder.stop(); });
    }
    if (chunks.length) {
      if (micTestUrl) URL.revokeObjectURL(micTestUrl);
      micTestUrl = URL.createObjectURL(new Blob(chunks, { type: recorder?.mimeType || mimeType || "audio/webm" }));
      $("#micPlayback").src = micTestUrl;
      $("#micPlayback").hidden = false;
    }
    $("#micResult").className = `mic-result ${detectedSound ? "ok" : "warn"}`;
    $("#micResult").textContent = detectedSound ? t("检测到声音，可点击回放", "Audio detected — play it back") : t("未检测到声音，请更换麦克风", "No audio detected — choose another microphone");
  } catch (error) {
    $("#micResult").className = "mic-result warn";
    $("#micResult").textContent = error?.name === "NotAllowedError" ? t("麦克风权限被拒绝", "Microphone permission denied") : t("无法打开麦克风", "Could not open microphone");
  } finally {
    stream?.getTracks().forEach((track) => track.stop());
    stopAudioMeter();
    $("#testMicBtn").disabled = false;
    $("#testMicBtn").textContent = t("测试 3 秒", "Test 3 sec");
  }
}

function elapsedMs() {
  return elapsedOffset + (recording ? Math.max(0, Date.now() - startTime) : 0);
}

function stamp() {
  const total = Math.floor(elapsedMs() / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  const mmss = `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
  return hours ? `${hours}:${mmss}` : mmss;
}

// --- Transcript rendering -------------------------------------------------
// Committed lines are rendered once and patched in place; only the interim row
// changes on every recognition event. Rebuilding the whole list on each interim
// result was O(n) per event and made hour-long sessions janky. A full rebuild
// (render) only happens on user actions: reset, language, search, names, scene.

function speakerLabel(number) {
  if (speakerNames[number]) return speakerNames[number];
  const preset = scenePresets[scene]?.[number];
  return preset ? t(...preset) : `${t("说话人", "Speaker")} ${number}`;
}

function speakerClass(number) {
  return `s${((Number(number) - 1) % 6) + 1}`;
}

function highlight(text) {
  const safe = escapeHtml(text);
  if (!searchQuery) return safe;
  const needle = escapeHtml(searchQuery).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return safe.replace(new RegExp(needle, "gi"), (match) => `<mark>${match}</mark>`);
}

function lineMarkup(line) {
  return `<span class="stamp">${escapeHtml(line.time)}</span>
      <div>
        <div class="utterance-head"><button type="button" class="speaker-badge ${speakerClass(line.speaker)}" data-action="speaker" title="${t("点按更换说话人", "Tap to change speaker")}">${escapeHtml(speakerLabel(line.speaker))}</button>${line.edited ? `<span class="edited-tag">${t("已校对", "edited")}</span>` : ""}<span class="line-actions"><button type="button" class="act-star" data-action="star" aria-label="${t("标记重点", "Mark as key moment")}" title="${t("标记重点", "Mark as key moment")}">${line.starred ? "★" : "☆"}</button><button type="button" data-action="edit" aria-label="${t("修改文字", "Edit text")}" title="${t("修改文字", "Edit text")}">✎</button><button type="button" data-action="copy" aria-label="${t("复制这一句", "Copy line")}" title="${t("复制这一句", "Copy line")}">⧉</button></span></div>
        <div class="words">${highlight(line.text)}</div>
        ${line.translation ? `<div class="translation">${highlight(line.translation)}</div>` : ""}
      </div>`;
}

function fillLineElement(element, line) {
  element.className = `line${line.starred ? " starred" : ""}`;
  element.dataset.lineId = String(line.id);
  element.innerHTML = lineMarkup(line);
}

function createLineElement(line) {
  const element = document.createElement("div");
  fillLineElement(element, line);
  return element;
}

function lineElementFor(line) {
  return $("#transcript").querySelector(`.line[data-line-id="${CSS.escape(String(line.id))}"]`);
}

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 80;
}

// Follow new content only if the reader is already at the bottom; otherwise offer a "jump to latest" pill.
function withAutoScroll(mutate, { grows = false } = {}) {
  const box = $("#transcript");
  const follow = isNearBottom(box);
  mutate(box);
  if (follow) {
    box.scrollTop = box.scrollHeight;
    $("#jumpLatest").hidden = true;
  } else if (grows && recording) {
    $("#jumpLatest").hidden = false;
  }
}

let interimText = "";

function setInterim(text = "") {
  interimText = text;
  withAutoScroll((box) => {
    let row = box.querySelector(".line.interim");
    if (!text) { row?.remove(); return; }
    if (!row) {
      row = document.createElement("div");
      row.className = "line interim";
      row.innerHTML = `<span class="stamp"></span><div><div class="utterance-head"><span class="speaker-badge"></span></div><div class="words"></div></div>`;
    }
    row.querySelector(".stamp").textContent = stamp();
    const badge = row.querySelector(".speaker-badge");
    badge.className = `speaker-badge ${speakerClass(activeSpeaker)}`;
    badge.textContent = speakerLabel(activeSpeaker);
    row.querySelector(".words").textContent = text;
    box.appendChild(row); // keep interim last
  }, { grows: Boolean(text) });
  if (!$("#captionView").hidden) renderCaptions(text);
}

// Bookkeeping after any committed-line change: captions, search count, stats, autosave.
function afterLinesChanged() {
  if (!$("#captionView").hidden) renderCaptions(interimText);
  if (searchQuery) updateSearchCount();
  updateSideSoon();
  scheduleAutosave();
}

function appendLineElement(line) {
  $("#empty")?.remove();
  withAutoScroll((box) => {
    box.insertBefore(createLineElement(line), box.querySelector(".line.interim"));
  }, { grows: true });
  afterLinesChanged();
}

function updateLineElement(line) {
  if (!lines.includes(line)) return; // transcript was reset while a request was in flight
  const element = lineElementFor(line);
  // Never clobber a line the user is editing; it is re-rendered when editing ends.
  if (!element || element.querySelector("[contenteditable=true]")) return;
  withAutoScroll(() => fillLineElement(element, line));
  afterLinesChanged();
}

// Full rebuild: used after a reset or a language, search, scene or speaker-name change.
function render(interim = interimText) {
  const box = $("#transcript");
  $("#empty")?.remove();
  const follow = isNearBottom(box) || !box.querySelector(".line");
  const scrollTop = box.scrollTop;
  const fragment = document.createDocumentFragment();
  lines.forEach((line) => fragment.appendChild(createLineElement(line)));
  box.replaceChildren(fragment);
  setInterim(interim);
  box.scrollTop = follow ? box.scrollHeight : scrollTop;
  if (searchQuery) updateSearchCount();
  updateSideSoon();
}

function selectSpeaker(number) {
  activeSpeaker = number;
  document.querySelectorAll("[data-speaker]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.speaker) === number);
  });
}

function cycleSpeaker(index) {
  const line = lines[index];
  if (!line) return;
  line.speaker = line.speaker % speakerCount + 1;
  updateLineElement(line);
  toast(t(`已改为${speakerLabel(line.speaker)}`, `Changed to ${speakerLabel(line.speaker)}`));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

// Adds a committed line immediately. Translation is queued on the AI engine
// (batched in economy mode, per line with context in quality mode) and patches
// the line when it returns; callers on hot paths should not await it.
function addLine(text, translation = "", speaker = activeSpeaker, time = stamp(), source = "demo") {
  let cleaned = String(text || "").trim();
  if (!cleaned) return Promise.resolve();
  // 浏览器识别（尤其中文）没有句末标点：本地补全
  if (source === "browser") cleaned = Speech.ensureTerminalPunctuation(cleaned);
  const item = { id: `l${Date.now().toString(36)}${nextLineId++}`, time, at: secondsFromStamp(time), text: cleaned, translation, speaker, source, starred: false, edited: false };
  lines.push(item);
  appendLineElement(item);
  if (!translation) translator.enqueue(item);
  return Promise.resolve();
}

function setupNativeRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const instance = new SpeechRecognition();
  instance.continuous = true;
  instance.interimResults = true;
  // Web Speech API 只能指定一种语言；“中英混合”时使用中文模型，它能识别常见英文词
  instance.lang = $("#sourceLang").value === "auto" ? "zh-CN" : $("#sourceLang").value;
  instance.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) addLine(text, "", activeSpeaker, stamp(), "browser");
      else interim += text;
    }
    // Finals can arrive after stop(); never resurrect the interim row then.
    setInterim(recording ? interim : "");
  };
  instance.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    const fatal = ["not-allowed", "service-not-allowed", "network"].includes(event.error);
    toast(event.error === "not-allowed" ? t("麦克风权限被拒绝，请在浏览器设置中允许", "Microphone permission denied. Allow it in browser settings.") : t("浏览器语音识别不可用，可切换到云端识别", "Browser speech recognition is unavailable. Switch to cloud transcription."));
    if (fatal && recording) stopRecording();
  };
  instance.onend = () => {
    if (recording && recognitionMode === "browser" && recognition === instance) {
      // Chrome ends sessions after silence or ~60 s; restart, with a short delay to avoid a hot loop.
      window.setTimeout(() => {
        if (!recording || recognitionMode !== "browser" || recognition !== instance) return;
        try { instance.start(); } catch { /* already starting */ }
      }, 150);
      return;
    }
    instance.onend = null;
    instance.__ended = true;
    instance.__resolveEnded?.();
  };
  return instance;
}

// After stop(), engines still deliver the last final result before "end".
// Wait for it (bounded) so the summary includes the last sentence.
function waitForRecognitionEnd(instance) {
  if (!instance || instance.__ended) return Promise.resolve();
  return Promise.race([
    new Promise((resolve) => { instance.__resolveEnded = resolve; }),
    sleep(TUNING.recognitionEndGraceMs),
  ]);
}

function preferredAudioType() {
  const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4"];
  return candidates.find((type) => MediaRecorder.isTypeSupported?.(type)) || "";
}

function audioFilename(type) {
  if (type.includes("mp4")) return "segment.m4a";
  if (type.includes("ogg")) return "segment.ogg";
  return "segment.webm";
}

class TranscriptionError extends Error {
  constructor(message, { fatal = false, retriable = false } = {}) {
    super(message);
    this.fatal = fatal;
    this.retriable = retriable;
  }
}

function cloudLanguage() {
  const value = $("#sourceLang").value;
  if (value === "auto") return "auto"; // 不指定语言，让模型自动处理中英混说
  return value.startsWith("zh") ? "zh" : "en";
}

function recentTranscriptText() {
  return lines.slice(-3).map((line) => line.text).join(" ");
}

async function requestTranscription(blob, prompt) {
  const form = new FormData();
  form.append("file", blob, audioFilename(blob.type));
  form.append("provider", speechConfig.provider);
  form.append("model", speechConfig.model);
  form.append("language", cloudLanguage());
  if (prompt) form.append("prompt", prompt);
  let response;
  try {
    response = await fetchWithTimeout("/api/transcribe", {
      method: "POST",
      headers: { "x-transcription-api-key": speechConfig.key },
      body: form,
    }, TUNING.transcribeTimeoutMs);
  } catch (error) {
    throw new TranscriptionError(error?.name === "AbortError" ? t("语音服务响应超时", "Speech service timed out") : t("网络连接中断", "Network connection lost"), { retriable: true });
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    // The route marks config errors (bad key/model) with fatal:true; 400/413 for one bad segment just skip it.
    const fatal = response.status === 401 || response.status === 403 || data.fatal === true;
    const retriable = !fatal && (response.status === 429 || response.status >= 500);
    throw new TranscriptionError(data.error || t("语音服务返回错误", "Speech service error"), { fatal, retriable });
  }
  return typeof data.text === "string" ? data.text : "";
}

// Runs serially on transcriptionQueue. A transient failure (timeout, 429, 5xx)
// is retried with backoff, then that segment is skipped and recording goes on;
// only auth/config errors or repeated failures stop cloud transcription.
async function transcribeAudio(blob, capturedAt, speaker = activeSpeaker) {
  if (speechConfig.failed || blob.size < 900) return;
  $("#recorder").classList.add("transcribing");
  // 术语表 + 上一段尾部作为识别 prompt，提升专有名词与中英混说的一致性
  const prompt = Speech.buildTranscriptionPrompt({ glossary, previousText: recentTranscriptText() });
  try {
    let text = "";
    for (let attempt = 0; ; attempt += 1) {
      try {
        text = await requestTranscription(blob, prompt);
        break;
      } catch (error) {
        if (error.retriable && attempt < TUNING.transcribeRetries && !speechConfig.failed) {
          $("#statusSub").textContent = t(`识别请求失败，正在重试（${attempt + 1}/${TUNING.transcribeRetries}）…`, `Request failed, retrying (${attempt + 1}/${TUNING.transcribeRetries})…`);
          await sleep(TUNING.retryDelayMs * 2 ** attempt);
          continue;
        }
        throw error;
      }
    }
    cloudFailureStreak = 0;
    text = String(text || "").trim();
    // 静音段常被 Whisper 类模型“幻听”成“谢谢观看”等套话，丢弃
    if (text && !Speech.isLikelyHallucination(text)) addLine(text, "", speaker, capturedAt, "cloud"); // translation continues in the background
  } catch (error) {
    cloudFailureStreak += 1;
    const fatal = !(error instanceof TranscriptionError) || error.fatal || cloudFailureStreak >= TUNING.maxCloudFailures;
    if (fatal) {
      failCloudTranscription(error?.message);
    } else {
      $("#statusSub").textContent = t(`有一段（${capturedAt}）识别失败，录音仍在继续`, `One segment (${capturedAt}) failed; recording continues`);
      toast(t("一段语音识别失败，已跳过并继续录音", "One segment failed to transcribe; recording continues."));
    }
  } finally {
    $("#recorder").classList.remove("transcribing");
  }
}

function failCloudTranscription(message) {
  if (speechConfig.failed) return;
  speechConfig.failed = true;
  toast(t("云端识别失败，请检查 API Key 与模型", "Cloud transcription failed. Check the API key and model."));
  // Stop outside the queue task (stopRecording waits for the queue), then show the reason.
  window.setTimeout(async () => {
    await stopRecording();
    $("#statusText").textContent = t("语音识别连接失败", "Speech recognition failed");
    $("#statusSub").textContent = message || t("请检查语音 API Key 和模型设置", "Check the speech API key and model settings");
  }, 0);
}

// 停顿断句：按音量判断说话停顿，在自然停顿处切片，而不是固定每 6 秒硬切
function startVad() {
  stopVad();
  vadSegmenter = Speech.createVadSegmenter(VAD_OPTIONS);
  // 用定时器而不是 requestAnimationFrame：页面切到后台时 rAF 会暂停
  vadTimer = window.setInterval(() => {
    const recorder = mediaRecorder;
    if (!recorder || recorder.state !== "recording") return;
    const decision = vadSegmenter.update(currentRms(), performance.now());
    if (decision) {
      recorder.segmentHasSpeech = decision.hasSpeech;
      pendingSegmentStop = recorder.__stopped;
      recorder.stop();
    }
  }, 50);
}

function stopVad() {
  window.clearInterval(vadTimer);
  vadTimer = null;
  vadSegmenter = null;
}

function startCloudSegment() {
  if (!recording || recognitionMode !== "cloud" || !mediaStream || speechConfig.failed) return;
  const chunks = [];
  const capturedAt = stamp();
  const speaker = activeSpeaker;
  const mimeType = preferredAudioType();
  let recorder;
  try {
    recorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  } catch {
    speechConfig.failed = true;
    $("#statusText").textContent = "无法创建录音";
    $("#statusSub").textContent = "当前浏览器不支持可用的录音格式";
    toast("当前浏览器无法创建录音文件");
    return;
  }
  mediaRecorder = recorder;
  let resolveStopped;
  const stopped = new Promise((resolve) => { resolveStopped = resolve; });
  recorder.__stopped = stopped;
  recorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  recorder.onerror = () => {
    toast(t("录音出现错误，请重新开始", "Recording error. Please start again."));
    if (recording) stopRecording();
  };
  recorder.onstop = () => {
    window.clearTimeout(segmentTimer);
    // Use this recorder's own type; the global may already point at the next segment.
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    chunks.length = 0;
    // 没有 VAD（AudioContext 不可用）时视为有语音，保持旧行为
    const hasSpeech = recorder.segmentHasSpeech ?? (vadSegmenter ? vadSegmenter.speechMs >= VAD_OPTIONS.minSpeechMs : true);
    if (mediaRecorder === recorder) mediaRecorder = null;
    if (pendingSegmentStop === stopped) pendingSegmentStop = null;
    if (recording && recognitionMode === "cloud") startCloudSegment();
    if (hasSpeech) transcriptionQueue = transcriptionQueue.then(() => transcribeAudio(blob, capturedAt, speaker));
    resolveStopped();
  };
  recorder.start();
  vadSegmenter?.reset(performance.now());
  // 兜底：VAD 不可用或后台定时器被节流时，仍保证最长片段时长
  segmentTimer = window.setTimeout(() => {
    if (recorder.state === "recording") {
      pendingSegmentStop = stopped;
      recorder.stop();
    }
  }, analyser ? MAX_SEGMENT_MS + 2000 : TUNING.segmentMs);
}

// Guards the async start/stop transitions: a second click while getUserMedia is
// pending, or while the previous session is still flushing, used to start a
// second session whose stream the old stop() then killed.
let transitioning = false;

async function toggleRecord() {
  if (transitioning) return;
  if (recording) {
    await stopRecording();
    return;
  }
  transitioning = true;
  try {
    await startRecording();
  } finally {
    transitioning = false;
  }
}

function handleTrackEnded() {
  if (!recording) return;
  toast(t("麦克风已断开，录音已停止", "Microphone disconnected; recording stopped."));
  stopRecording();
}

async function startRecording() {
  if (isDemoSession && lines.length) startNewSession({ force: true });
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast(t("当前页面无法使用麦克风，请使用 HTTPS 并允许麦克风权限", "Microphone access is unavailable. Use HTTPS and allow microphone permission."));
    return;
  }

  speechConfig.mode = $("#speechMode").value;
  const useNative = speechConfig.mode === "browser" || (speechConfig.mode === "auto" && supportsNativeRecognition());
  if (speechConfig.mode === "browser" && !supportsNativeRecognition()) {
    showSpeechSetup(t("此浏览器不支持浏览器实时识别，请选择云端精准识别", "This browser does not support live recognition. Choose cloud transcription."));
    return;
  }
  if (!useNative && (!supportsCloudRecording() || !speechConfig.key)) {
    showSpeechSetup(!supportsCloudRecording() ? t("当前浏览器无法录音，请改用最新版 Chrome、Edge 或 Safari", "This browser cannot record audio. Use the latest Chrome, Edge, or Safari.") : t("当前浏览器需要云端识别，请填写 OpenAI 或 Groq API Key", "Cloud transcription is required here. Enter an OpenAI or Groq API key."));
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: microphoneConstraints() });
    mediaStream = stream;
    stream.getAudioTracks().forEach((track) => track.addEventListener("ended", handleTrackEnded));
    await refreshMicrophones();
    startAudioMeter(stream);
    if (useNative) {
      recognition = setupNativeRecognition();
      if (!recognition) {
        stream.getTracks().forEach((track) => track.stop());
        stopAudioMeter();
        mediaStream = null;
        showSpeechSetup(t("浏览器实时识别不可用，请切换到云端精准识别", "Browser recognition is unavailable. Switch to cloud transcription."));
        return;
      }
      recognitionMode = "browser";
      startSession(t("浏览器实时识别中", "Browser live recognition"));
      recognition.start();
    } else {
      speechConfig.failed = false;
      recognitionMode = "cloud";
      startSession(`${speechProviders[speechConfig.provider].name} ${t("识别中，按说话停顿自动断句", "transcribing, segments at natural pauses")}`);
      if (analyser) startVad();
      startCloudSegment();
    }
    scheduleSoundCheck();
  } catch (error) {
    stopAudioMeter();
    mediaStream?.getTracks().forEach((track) => track.stop());
    mediaStream = null;
    toast(error?.name === "NotAllowedError" ? t("请在浏览器设置中允许麦克风权限", "Allow microphone access in browser settings") : t("无法打开麦克风，请检查系统权限", "Could not open the microphone. Check system permission."));
  }
}

function startSession(statusDetail) {
  recording = true;
  startTime = Date.now();
  $("#timer").textContent = stamp();
  $("#recorder").classList.add("recording");
  $("#statusText").textContent = t("正在聆听", "Listening");
  $("#statusSub").textContent = statusDetail;
  $("#recordLabel").textContent = t("结束录音", "Stop recording");
  $("#jumpLatest").hidden = true;
  updateSideSoon();
  tick = window.setInterval(() => {
    $("#timer").textContent = stamp();
    const duration = $("#statDuration");
    if (duration) duration.textContent = formatClock(currentElapsedSeconds());
  }, 500);
}

async function stopRecording() {
  if (!recording || transitioning) return;
  transitioning = true;
  try {
    await finishRecording();
  } finally {
    transitioning = false;
  }
  saveCurrentSession();
  updateSideSoon();
  await translator.flush();
  if (lines.length) await summarize();
}

async function finishRecording() {
  recording = false;
  elapsedOffset += Math.max(0, Date.now() - startTime);
  window.clearInterval(tick);
  window.clearInterval(demoTimer);
  window.clearTimeout(segmentTimer);
  if (mediaRecorder && vadSegmenter) mediaRecorder.segmentHasSpeech = vadSegmenter.speechMs >= VAD_OPTIONS.minSpeechMs;
  stopVad();
  window.clearTimeout(soundWatchdog);
  window.clearTimeout(recognitionWatchdog);
  const endingRecognition = recognition;
  try { endingRecognition?.stop(); } catch { /* already stopped */ }
  setInterim("");

  if (recognitionMode === "cloud") {
    // A segment may be between stop() and its onstop event; let it enqueue first.
    if (pendingSegmentStop) await pendingSegmentStop;
    const current = mediaRecorder;
    if (current?.state === "recording") {
      current.stop();
      await current.__stopped;
    }
  } else if (recognitionMode === "browser") {
    await waitForRecognitionEnd(endingRecognition);
  }
  await transcriptionQueue;
  if (recognition === endingRecognition) recognition = null;
  mediaStream?.getTracks().forEach((track) => {
    track.removeEventListener("ended", handleTrackEnded);
    track.stop();
  });
  stopAudioMeter();
  mediaStream = null;
  mediaRecorder = null;
  pendingSegmentStop = null;
  recognitionMode = "";
  setInterim("");

  $("#timer").textContent = stamp();
  $("#recorder").classList.remove("recording", "transcribing");
  $("#statusText").textContent = lines.length ? t("转写已完成", "Transcription complete") : t("没有识别到语音", "No speech recognized");
  $("#statusSub").textContent = lines.length ? t(`共记录 ${lines.length} 段内容`, `${lines.length} segments captured`) : t("请运行麦克风测试，或检查云端语音 API 设置", "Run the microphone test or check the cloud speech API settings");
  $("#recordLabel").textContent = t("继续录音", "Record again");
}

function usageLabel() {
  const usage = usageMeter.snapshot();
  if (!usage.requests) return "";
  const tokens = usage.totalTokens >= 1000 ? `${(usage.totalTokens / 1000).toFixed(1)}k` : String(usage.totalTokens);
  const cost = usage.costUsd === null ? "" : ` · ≈$${usage.costUsd < 0.01 ? usage.costUsd.toFixed(4) : usage.costUsd.toFixed(3)}`;
  return `${usage.requests} ${t("次请求", "requests")} · ${tokens} tokens${cost}`;
}

function renderSummary(summary) {
  const list = (title, items) => (items.length ? `<div class="summary-block"><strong>${escapeHtml(title)}</strong><ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul></div>` : "");
  const actions = summary.action_items.map((item) => `${item.task}（${t("负责人", "Owner")}：${item.owner}；${t("期限", "Due")}：${item.due}）`);
  return `${summary.summary ? `<p>${escapeHtml(summary.summary)}</p>` : ""}${list(t("核心结论", "Key points"), summary.key_points)}${list(t("关键决定", "Decisions"), summary.decisions)}${list(t("行动项", "Action items"), actions)}${list(t("待定问题", "Open questions"), summary.open_questions)}`;
}

function summaryInstruction() {
  const hints = [];
  if (scene === "class") hints.push("这是一堂课程：请额外整理知识点、老师强调的重点和课后任务。");
  if (scene === "interview") hints.push("这是一次访谈：请按“问题—回答要点”整理，并列出值得引用的原话。");
  // Transcript lines use S1/S2…; tell the model the names people gave them.
  const named = Array.from(new Set(lines.map((line) => line.speaker)))
    .map((speaker) => [speaker, speakerLabel(speaker)])
    .filter(([speaker, label]) => label !== `${t("说话人", "Speaker")} ${speaker}`);
  if (named.length) hints.push(`说话人对应：${named.map(([speaker, label]) => `S${speaker}=${label}`).join("，")}；输出中请使用这些名字。`);
  return hints.join("\n");
}

async function summarize() {
  // Only the newest summary may write to the panel (an older, slower one used to overwrite it).
  const generation = ++summaryGeneration;
  const textConfig = { ...textModelConfig(), summaryInstruction: summaryInstruction() };
  if (!AI.canUseTextModel(textConfig)) {
    restoreSummary("nomodel");
  } else {
    restoreSummary("working");
    let summary = null;
    try {
      summary = await summarizer.summarize(textConfig, lines);
    } catch (error) {
      if (generation === summaryGeneration) reportModelError(error);
    }
    if (generation !== summaryGeneration) return;
    lastSummary = summary;
    restoreSummary(summary ? "done" : "failed");
  }
  scheduleAutosave();
}

function restoreSummary(state) {
  summaryState = state;
  const copy = {
    nomodel: [t("转写已完成", "Transcript ready"), t("如需自动生成摘要，请在模型设置中连接 DeepSeek、Groq 或其他文本模型。", "Connect DeepSeek, Groq, or another text model in Model settings to generate a summary.")],
    working: [t("正在整理…", "Summarizing…"), t("正在按发言人提炼本次会话的重点与行动项。", "Extracting key points and action items by speaker.")],
    failed: [t("摘要生成失败", "Summary failed"), t("原始转写已保留，请检查文本模型设置后重试。", "The transcript is kept. Check the text model settings and try again.")],
    none: [t("尚未生成摘要", "No summary yet"), t("可点击“生成摘要”，基于当前（含已校对）的转写重新整理。", "Press Summarize to build one from the current, edited transcript.")],
  }[state];
  if (state === "done" && lastSummary) {
    $("#summaryTitle").textContent = lastSummary.title || t("本次会话摘要", "Session summary");
    $("#summaryText").className = "summary-rich";
    $("#summaryText").innerHTML = renderSummary(lastSummary);
  } else {
    const [title, text] = copy || [t("录音结束后生成", "Generated after recording"), ""];
    $("#summaryTitle").textContent = title;
    $("#summaryText").className = "placeholder";
    $("#summaryText").textContent = text;
  }
  updateSideSoon();
  if (!lines.length) return;
  const speakers = new Set(lines.map((line) => line.speaker)).size;
  const usage = usageLabel();
  $("#chips").innerHTML = `<span class="chip">${t("已完成", "Done")}</span><span class="chip">${t(`${speakers} 位说话人`, `${speakers} speakers`)}</span><span class="chip">${t(`${lines.length} 段内容`, `${lines.length} segments`)}</span>${usage ? `<span class="chip" title="${t("本页累计文本模型用量（估算）", "Estimated text-model usage on this page")}">${escapeHtml(usage)}</span>` : ""}`;
}

function resetTranscript() {
  summaryGeneration += 1; // a summary still in flight must not land on the new session
  elapsedOffset = 0;
  lines = [];
  interimText = "";
  translator.reset();
  lastSummary = null;
  summaryState = "idle";
}

function runDemo() {
  if (recording || transitioning) return;
  if (!startNewSession()) return;
  isDemoSession = true;
  recognitionMode = "demo";
  startSession(t("演示字幕生成中", "Generating demo captions"));
  const samples = $("#sourceLang").value.startsWith("zh") ? [
    ["我们今天主要确认一下新版本的发布计划。", "Today, we mainly need to confirm the release plan for the new version.", 1],
    ["实时字幕已经可以正常工作，中英文切换也比较流畅。", "Live captions are working, and switching between Chinese and English feels smooth.", 2],
    ["下一步由产品团队整理测试反馈，周五之前完成。", "Next, the product team will consolidate testing feedback by Friday.", 1],
  ] : [
    ["Thanks everyone. Today we need to align on the product launch plan.", "谢谢大家。今天我们需要统一产品发布计划。", 1],
    ["The live captions are working well in both English and Chinese.", "中英文实时字幕目前运行良好。", 2],
    ["The product team will consolidate user feedback before Friday.", "产品团队将在周五前整理用户反馈。", 1],
  ];
  let index = 0;
  demoTimer = window.setInterval(() => {
    if (index < samples.length) {
      const sample = samples[index];
      index += 1;
      selectSpeaker(sample[2]);
      addLine(sample[0], sample[1], sample[2]);
    } else {
      stopRecording();
    }
  }, 1350);
}

function chooseProvider(id) {
  config.provider = id;
  const provider = providers[id];
  document.querySelectorAll(".provider-card").forEach((button) => button.classList.toggle("active", button.dataset.provider === id));
  $("#endpoint").value = provider.endpoint;
  $("#model").value = provider.model;
  config.defaultModel = provider.model;
  $("#endpointHint").textContent = uiLanguage === "zh" ? provider.hint : "OpenAI-compatible text model endpoint";
  $("#providerNote").textContent = uiLanguage === "zh" ? provider.note : "Use this model for translation, cleanup, and post-meeting summaries.";
  $("#apiKey").placeholder = id === "ollama" ? t("本地模型无需填写", "No key needed for local model") : t("可稍后填写", "Optional for now");
  $("#modelSuggestions").innerHTML = provider.models.map((model) => `<option value="${model}">`).join("");
}

function chooseSpeechProvider(id) {
  speechConfig.provider = id;
  const provider = speechProviders[id];
  $("#speechModel").value = provider.model;
  $("#speechKey").placeholder = uiLanguage === "zh" ? provider.placeholder : `Enter ${provider.name} API key`;
  updateSpeechSupport();
}

function updateSpeechSupport(message = "") {
  const nativeSupported = supportsNativeRecognition();
  const selectedMode = $("#speechMode").value;
  const support = $("#speechSupport");
  const cloudFieldsDisabled = selectedMode === "browser";
  $("#speechProvider").disabled = cloudFieldsDisabled;
  $("#speechModel").disabled = cloudFieldsDisabled;
  $("#speechKey").disabled = cloudFieldsDisabled;

  support.className = "speech-support";
  if (message) {
    support.textContent = message;
    support.classList.add("warn");
  } else if (nativeSupported) {
    support.textContent = selectedMode === "cloud" ? t("将使用云端语音识别，在说话停顿处断句（通常 1–3 秒出字幕），静音片段不会上传。", "Cloud transcription segments at pauses (captions usually in 1–3 s); silent audio is not uploaded.") : t("当前浏览器支持实时识别；自动模式会优先使用浏览器能力。", "This browser supports live recognition; Auto will prefer it.");
  } else {
    support.textContent = t("当前浏览器不支持内置实时识别。请选择云端精准识别并填写 API Key。", "Built-in live recognition is unavailable. Choose cloud transcription and enter an API key.");
    support.classList.add("warn");
  }
}

function showSpeechSetup(message) {
  $("#modal").classList.add("open");
  if (!supportsNativeRecognition()) $("#speechMode").value = "cloud";
  updateSpeechSupport(message);
  window.setTimeout(() => $("#speechKey").focus(), 50);
  toast(message);
}

function isLoopbackHost(hostname) {
  return hostname === "localhost" || hostname === "127.0.0.1";
}

// The text-model key and transcript are sent from the browser straight to this
// endpoint, so refuse anything that would expose them in transit.
function checkTextEndpoint(value) {
  let url;
  try {
    url = new URL(value);
  } catch {
    return t("文本模型接口地址无效，请填写完整的 https:// 地址", "The text model endpoint is not a valid URL. Enter a full https:// address.");
  }
  if (url.username || url.password) return t("接口地址中不能包含用户名或密码，请把密钥填在 API Key 中", "Do not put credentials in the endpoint URL. Use the API key field.");
  if (url.protocol === "https:") return "";
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return "";
  if (url.protocol === "http:") return t("非本机接口必须使用 https://，否则密钥和会议内容会以明文传输（浏览器也会拦截）", "Non-local endpoints must use https://; otherwise your key and meeting text travel in plain text (and the browser blocks it).");
  return t("文本模型接口只支持 https:// 或本机 http:// 地址", "Only https:// or local http:// endpoints are supported.");
}

let settingsSaved = false;

function speechServiceName() {
  const needsCloud = speechConfig.mode === "cloud" || (speechConfig.mode === "auto" && !supportsNativeRecognition());
  return needsCloud ? speechProviders[speechConfig.provider].name : t("浏览器语音", "Browser speech");
}

// One source of truth for the header badge; applyUiLanguage() used to reset it to "Model settings".
function updateProviderBadge() {
  if (!settingsSaved) { $("#providerBadge").textContent = t("模型设置", "Model settings"); return; }
  const modeName = config.mode === "quality" ? t("高质量", "Quality") : t("省钱", "Economy");
  const speechName = speechServiceName();
  $("#providerBadge").textContent = AI.canUseTextModel(config) ? `${speechName} · ${providers[config.provider].name} · ${modeName}` : speechName;
}

function saveSettings() {
  const nextSpeech = {
    mode: $("#speechMode").value,
    provider: $("#speechProvider").value,
    model: $("#speechModel").value.trim(),
    key: $("#speechKey").value.trim(),
  };
  const nextText = {
    key: $("#apiKey").value.trim(),
    endpoint: $("#endpoint").value.trim(),
    model: $("#model").value.trim(),
    mode: $("#aiMode")?.value === "quality" ? "quality" : "economy",
    summaryModel: $("#summaryModel")?.value.trim() || "",
    // 同一份术语表既用于识别 prompt，也用于翻译
    glossary: $("#glossary")?.value.trim() || "",
  };

  // Validate everything before applying, so a rejected endpoint never receives the key.
  if (!nextSpeech.model) return toast(t("请填写语音模型名称", "Enter a speech model name"));
  const needsCloud = nextSpeech.mode === "cloud" || (nextSpeech.mode === "auto" && !supportsNativeRecognition());
  if (needsCloud && !nextSpeech.key) return toast(t("当前识别方式需要语音 API Key", "This recognition mode requires a speech API key"));
  if (!nextText.endpoint || !nextText.model) return toast(t("请填写文本模型接口和名称", "Enter the text model endpoint and name"));
  const endpointProblem = checkTextEndpoint(nextText.endpoint);
  if (endpointProblem) return toast(endpointProblem);
  Object.assign(speechConfig, nextSpeech);
  Object.assign(config, nextText);
  speechConfig.glossary = $("#glossary")?.value || "";
  glossary = Speech.parseGlossary(speechConfig.glossary);

  speechConfig.failed = false;
  settingsSaved = true;
  const speechName = speechServiceName();
  updateProviderBadge();
  $("#modal").classList.remove("open");
  $("#statusSub").textContent = needsCloud ? t(`${speechName} 已就绪，点击开始录音`, `${speechName} is ready. Start recording.`) : t("浏览器实时识别已就绪", "Browser live recognition is ready");
  toast(t("设置已保存，可以开始录音", "Settings saved. You can start recording."));
}

// ---------------------------------------------------------------------------
// Workspace UX: sessions & local history, export, search, editing, captions.
// Transcripts stay in this browser only; audio and API keys are never stored.
// ---------------------------------------------------------------------------

const emptyStateHtml = $("#transcript").innerHTML;
const initialChipsHtml = $("#chips").innerHTML;

function newSessionId() {
  return `s${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;
}

function readPref(key, fallback) {
  try { return window.localStorage.getItem(key) ?? fallback; } catch { return fallback; }
}

function writePref(key, value) {
  try { window.localStorage.setItem(key, value); } catch { /* storage unavailable */ }
}

function secondsFromStamp(value) {
  return String(value || "0").split(":").reduce((total, part) => total * 60 + (Number(part) || 0), 0);
}

function formatClock(totalSeconds, withHours = false) {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const rest = seconds % 60;
  const pad = (number) => String(number).padStart(2, "0");
  return hours || withHours ? `${pad(hours)}:${pad(minutes)}:${pad(rest)}` : `${pad(minutes)}:${pad(rest)}`;
}

function currentElapsedSeconds() {
  return Math.floor(elapsedMs() / 1000);
}

function lineIndexOf(element) {
  const id = element?.dataset.lineId;
  return lines.findIndex((line) => String(line.id) === id);
}

/** Double-click arming for destructive actions, instead of blocking confirm() dialogs. */
function confirmByRepeat(action, message) {
  const now = Date.now();
  if ((armedActions.get(action) || 0) > now) {
    armedActions.delete(action);
    return true;
  }
  armedActions.set(action, now + 4000);
  toast(message);
  return false;
}

// --- Speakers --------------------------------------------------------------

function refreshSpeakerButtons() {
  document.querySelectorAll("[data-speaker]").forEach((button) => {
    if (!button.querySelector("input")) button.textContent = speakerLabel(Number(button.dataset.speaker));
  });
}

function rebuildSpeakerButtons(count) {
  document.querySelectorAll("[data-speaker]").forEach((button) => { if (Number(button.dataset.speaker) > 2) button.remove(); });
  speakerCount = 2;
  while (speakerCount < count) {
    speakerCount += 1;
    const number = speakerCount;
    const button = document.createElement("button");
    button.className = "speakerbtn";
    button.dataset.speaker = number;
    button.onclick = () => selectSpeaker(number);
    $("#addSpeaker").before(button);
  }
  refreshSpeakerButtons();
  selectSpeaker(Math.min(activeSpeaker, speakerCount));
}

function renameSpeaker(button) {
  const number = Number(button.dataset.speaker);
  const input = document.createElement("input");
  input.value = speakerLabel(number);
  input.maxLength = 24;
  input.setAttribute("aria-label", t("说话人名称", "Speaker name"));
  button.textContent = "";
  button.append(input);
  input.focus();
  input.select();
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = input.value.trim();
    if (save) {
      if (value && value !== speakerLabel(number)) speakerNames[number] = value;
      else if (!value) delete speakerNames[number];
      scheduleAutosave();
    }
    input.remove();
    refreshSpeakerButtons();
    render();
  };
  input.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter") finish(true);
    if (event.key === "Escape") finish(false);
  };
  input.onblur = () => finish(true);
  input.onclick = (event) => event.stopPropagation();
}

// --- Line actions (star / edit / copy / speaker) ---------------------------

function markLatest() {
  const line = lines[lines.length - 1];
  if (!line) return toast(t("还没有可标记的内容", "Nothing to mark yet"));
  line.starred = !line.starred;
  updateLineElement(line);
  toast(line.starred ? t(`已标记 ${line.time} 为重点`, `Marked ${line.time} as key moment`) : t("已取消标记", "Mark removed"));
}

function editLine(element, index) {
  const line = lines[index];
  const words = element.querySelector(".words");
  if (!line || !words || words.isContentEditable) return;
  words.textContent = line.text;
  words.contentEditable = "true";
  words.spellcheck = false;
  words.focus();
  const range = document.createRange();
  range.selectNodeContents(words);
  window.getSelection()?.removeAllRanges();
  window.getSelection()?.addRange(range);
  let done = false;
  const finish = (save) => {
    if (done) return;
    done = true;
    const value = words.textContent.replace(/\s+/g, " ").trim();
    words.contentEditable = "false";
    const changed = save && value && value !== line.text;
    if (changed) {
      line.text = value;
      line.edited = true;
    }
    updateLineElement(line);
    // A corrected line gets a fresh translation (the old one described the wrong words).
    if (changed && line.translation && $("#targetLang").value !== "off") {
      translator.enqueue({ text: line.text, line });
      translator.flush();
    }
  };
  words.onkeydown = (event) => {
    event.stopPropagation();
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); finish(true); }
    if (event.key === "Escape") finish(false);
  };
  words.onblur = () => finish(true);
}

$("#transcript").addEventListener("click", (event) => {
  const button = event.target.closest("[data-action]");
  const element = event.target.closest(".line:not(.interim)");
  if (!button || !element) return;
  const index = lineIndexOf(element);
  const line = lines[index];
  if (!line) return;
  const action = button.dataset.action;
  if (action === "speaker") cycleSpeaker(index);
  if (action === "star") { line.starred = !line.starred; updateLineElement(line); }
  if (action === "edit") editLine(element, index);
  if (action === "copy") {
    navigator.clipboard?.writeText(`${line.text}${line.translation ? `\n${line.translation}` : ""}`)
      .then(() => toast(t("已复制这一句", "Line copied")), () => toast(t("复制失败", "Copy failed")));
  }
});
$("#transcript").addEventListener("dblclick", (event) => {
  const element = event.target.closest(".line:not(.interim)");
  if (element && event.target.closest(".words")) editLine(element, lineIndexOf(element));
});
$("#transcript").addEventListener("scroll", () => {
  if (isNearBottom($("#transcript"))) $("#jumpLatest").hidden = true;
}, { passive: true });
$("#jumpLatest").onclick = () => {
  const box = $("#transcript");
  box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  $("#jumpLatest").hidden = true;
};

// --- Search & view ---------------------------------------------------------

function searchMarks() {
  return Array.from($("#transcript").querySelectorAll(".line:not(.interim) mark"));
}

function updateSearchCount() {
  const count = searchQuery ? searchMarks().length : 0;
  $("#searchCount").textContent = searchQuery ? (count ? t(`${count} 处`, `${count} found`) : t("无结果", "No match")) : "";
}

function jumpToMatch(step) {
  const marks = searchMarks();
  if (!marks.length) return;
  searchCursor = (searchCursor + step + marks.length) % marks.length;
  marks.forEach((mark, index) => mark.classList.toggle("current", index === searchCursor));
  marks[searchCursor].scrollIntoView({ block: "center", behavior: "smooth" });
  $("#searchCount").textContent = `${searchCursor + 1}/${marks.length}`;
}

$("#searchInput").addEventListener("input", (event) => {
  searchQuery = event.target.value.trim();
  searchCursor = -1;
  if (lines.length) render();
  updateSearchCount();
});
$("#searchInput").addEventListener("keydown", (event) => {
  if (event.key === "Enter") { event.preventDefault(); jumpToMatch(event.shiftKey ? -1 : 1); }
  if (event.key === "Escape") { event.target.value = ""; event.target.dispatchEvent(new Event("input")); event.target.blur(); }
});

function applyView() {
  const box = $("#transcript");
  box.classList.toggle("view-source", viewMode === "source");
  box.classList.toggle("view-translation", viewMode === "translation");
  box.style.setProperty("--fs", `${fontSize}px`);
  document.querySelectorAll("#viewMode [data-view]").forEach((button) => {
    button.classList.toggle("active", button.dataset.view === viewMode);
    button.setAttribute("aria-pressed", String(button.dataset.view === viewMode));
  });
  writePref("yuliu:view", JSON.stringify({ viewMode, fontSize }));
}

try {
  const saved = JSON.parse(readPref("yuliu:view", "{}"));
  if (["both", "source", "translation"].includes(saved.viewMode)) viewMode = saved.viewMode;
  if (Number(saved.fontSize) >= 14 && Number(saved.fontSize) <= 30) fontSize = Number(saved.fontSize);
} catch { /* ignore malformed prefs */ }
document.querySelectorAll("#viewMode [data-view]").forEach((button) => { button.onclick = () => { viewMode = button.dataset.view; applyView(); }; });
$("#fontDown").onclick = () => { fontSize = Math.max(14, fontSize - 2); applyView(); };
$("#fontUp").onclick = () => { fontSize = Math.min(30, fontSize + 2); applyView(); };
$("#sceneSelect").onchange = (event) => {
  scene = event.target.value;
  refreshSpeakerButtons();
  render();
  scheduleAutosave();
};

// --- Live session stats ----------------------------------------------------

function countWords(text) {
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿]/g, " ").match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) || []).length;
  return cjk + latin;
}

function updateSideSoon() {
  window.clearTimeout(sideTimer);
  sideTimer = window.setTimeout(updateSide, 250);
}

function updateSide() {
  const has = lines.length > 0;
  $("#newSessionBtn").hidden = !has || recording;
  $("#resummarizeBtn").hidden = !has || recording || summaryState === "working";
  $(".detail")?.classList.toggle("has-stats", has);
  const box = $("#statsBox");
  box.hidden = !has;
  if (!has) return;
  const perSpeaker = new Map();
  let words = 0;
  lines.forEach((line) => {
    const count = countWords(line.text);
    words += count;
    perSpeaker.set(line.speaker, (perSpeaker.get(line.speaker) || 0) + count);
  });
  const starred = lines.filter((line) => line.starred);
  const shares = Array.from(perSpeaker.entries()).sort((a, b) => b[1] - a[1]).map(([speaker, count]) => {
    const percent = words ? Math.round((count / words) * 100) : 0;
    return `<div class="share-row"><span>${escapeHtml(speakerLabel(speaker))}</span><span class="share-bar"><i style="width:${percent}%"></i></span><em>${percent}%</em></div>`;
  }).join("");
  box.innerHTML = `
    <div class="stat-grid">
      <div class="stat"><b id="statDuration">${formatClock(currentElapsedSeconds())}</b><span>${t("时长", "Duration")}</span></div>
      <div class="stat"><b>${words.toLocaleString()}</b><span>${t("字 / 词", "Words")}</span></div>
      <div class="stat"><b>${lines.length}</b><span>${t("段落", "Segments")}</span></div>
      <div class="stat"><b>${starred.length}</b><span>${t("重点标记", "Key moments")}</span></div>
    </div>
    <h4>${t("发言占比", "Talk time share")}</h4><div class="share">${shares}</div>
    ${starred.length ? `<h4>${t("重点标记", "Key moments")}</h4><div class="marks">${starred.slice(-6).map((line) => `<button type="button" data-goto="${escapeHtml(String(line.id))}"><span>${escapeHtml(line.time)}</span>${escapeHtml(line.text.slice(0, 42))}</button>`).join("")}</div>` : ""}`;
}

$("#statsBox").addEventListener("click", (event) => {
  const target = event.target.closest("[data-goto]");
  if (!target) return;
  const line = lines.find((item) => String(item.id) === target.dataset.goto);
  if (line) lineElementFor(line)?.scrollIntoView({ block: "center", behavior: "smooth" });
});

// --- Sessions & local history ----------------------------------------------

function readHistory() {
  try {
    const list = JSON.parse(window.localStorage.getItem(HISTORY_KEY) || "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}

function writeHistory(list) {
  let next = list.slice(0, HISTORY_LIMIT);
  while (next.length) {
    try {
      window.localStorage.setItem(HISTORY_KEY, JSON.stringify(next));
      return true;
    } catch {
      next = next.slice(0, -1); // quota exceeded: drop the oldest session and retry
    }
  }
  try { window.localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  return false;
}

function sceneName(value) {
  return { meeting: t("会议", "Meeting"), class: t("课堂", "Lecture"), interview: t("访谈", "Interview") }[value] || t("会议", "Meeting");
}

function sessionTitle(createdAt = sessionCreatedAt, sceneValue = scene) {
  const date = new Date(createdAt);
  const when = date.toLocaleString(uiLanguage === "zh" ? "zh-CN" : "en-US", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
  return `${when} · ${sceneName(sceneValue)}`;
}

// Sessions saved before the structured summary existed stored { state, text }.
function normalizeStoredSummary(summary) {
  if (!summary) return null;
  if (Array.isArray(summary.key_points)) return summary;
  if (summary.text) return { title: "", summary: summary.text, key_points: [], decisions: [], action_items: [], open_questions: [] };
  return null;
}

function summaryPlainText(summary) {
  return AI.summaryToText(normalizeStoredSummary(summary));
}

function snapshotSession() {
  return {
    id: sessionId,
    createdAt: sessionCreatedAt,
    updatedAt: Date.now(),
    scene,
    sourceLang: $("#sourceLang").value,
    targetLang: $("#targetLang").value,
    speakerNames,
    speakerCount,
    duration: currentElapsedSeconds(),
    summary: summaryState === "done" ? lastSummary : null,
    lines: lines.map(({ id, time, at, text, translation, speaker, starred, edited }) => ({ id, time, at, text, translation, speaker, starred, edited })),
  };
}

function saveCurrentSession() {
  window.clearTimeout(autosaveTimer);
  if (!autosaveEnabled || isDemoSession || !lines.length) return;
  const list = readHistory().filter((item) => item.id !== sessionId);
  list.unshift(snapshotSession());
  if (!writeHistory(list)) toast(t("浏览器存储空间不足，记录未能保存，请先导出", "Browser storage is full. Export this transcript to keep it."));
}

function scheduleAutosave() {
  window.clearTimeout(autosaveTimer);
  autosaveTimer = window.setTimeout(saveCurrentSession, 1500);
}

function resetTranscriptView() {
  $("#transcript").innerHTML = emptyStateHtml;
  $("#chips").innerHTML = initialChipsHtml;
  applyUiLanguage();
}

/** Starts a blank session. Returns false if the user still has to confirm discarding unsaved text. */
function startNewSession({ force = false } = {}) {
  if (recording) { toast(t("请先结束当前录音", "Stop the current recording first")); return false; }
  if (lines.length && !isDemoSession) {
    if (autosaveEnabled) saveCurrentSession();
    else if (!force && !confirmByRepeat("new", t("当前记录未保存（自动保存已关闭），再次点击将清空", "This session is not saved (auto-save is off). Click again to discard it."))) return false;
  }
  resetTranscript();
  sessionId = newSessionId();
  sessionCreatedAt = Date.now();
  isDemoSession = false;
  speakerNames = {};
  $("#timer").textContent = "00:00";
  rebuildSpeakerButtons(2);
  resetTranscriptView();
  updateSide();
  return true;
}

function loadSession(id) {
  if (recording) return toast(t("请先结束当前录音", "Stop the current recording first"));
  const session = readHistory().find((item) => item.id === id);
  if (!session) return toast(t("找不到这条记录", "Session not found"));
  if (session.id !== sessionId && !startNewSession()) return;
  resetTranscript();
  sessionId = session.id;
  sessionCreatedAt = session.createdAt;
  isDemoSession = false;
  scene = session.scene || "meeting";
  $("#sceneSelect").value = scene;
  if (session.sourceLang) $("#sourceLang").value = session.sourceLang;
  if (session.targetLang) $("#targetLang").value = session.targetLang;
  speakerNames = session.speakerNames || {};
  lines = (session.lines || []).map((line, index) => ({ ...line, id: String(line.id || `h${index}`), at: line.at ?? secondsFromStamp(line.time) }));
  elapsedOffset = (session.duration || 0) * 1000;
  rebuildSpeakerButtons(Math.max(2, session.speakerCount || 2, ...lines.map((line) => line.speaker)));
  render();
  $("#transcript").scrollTop = 0;
  $("#timer").textContent = formatClock(session.duration || 0);
  $("#statusText").textContent = t("已打开历史记录", "Session opened");
  $("#statusSub").textContent = t(`共 ${lines.length} 段 · 点击“继续录音”可接着记录`, `${lines.length} segments · press Record again to continue`);
  $("#recordLabel").textContent = t("继续录音", "Record again");
  lastSummary = normalizeStoredSummary(session.summary);
  restoreSummary(lastSummary ? "done" : "none");
  closeHistory();
}

function renderHistory() {
  const list = readHistory();
  $("#autosaveToggle").checked = autosaveEnabled;
  if (!list.length) {
    $("#historyList").innerHTML = `<div class="history-empty">${autosaveEnabled ? t("还没有记录。开始录音后会自动保存在这里。", "No sessions yet. Recordings are saved here automatically.") : t("自动保存已关闭。", "Auto-save is off.")}</div>`;
    return;
  }
  $("#historyList").innerHTML = list.map((item) => {
    const first = item.lines?.[0]?.text || "";
    const starred = (item.lines || []).filter((line) => line.starred).length;
    return `<div class="history-item${item.id === sessionId ? " current" : ""}" data-id="${escapeHtml(item.id)}">
      <strong>${escapeHtml(sessionTitle(item.createdAt, item.scene))}</strong>
      <div class="meta">${formatClock(item.duration || 0)} · ${t(`${item.lines?.length || 0} 段`, `${item.lines?.length || 0} segments`)}${starred ? ` · ★ ${starred}` : ""}${item.summary ? ` · ${t("含摘要", "summary")}` : ""}${item.id === sessionId ? ` · ${t("当前", "current")}` : ""}</div>
      <div class="preview">${escapeHtml(first)}</div>
      <div class="history-actions"><button type="button" data-history="open">${t("打开", "Open")}</button><button type="button" data-history="export">${t("导出 Markdown", "Export Markdown")}</button><button type="button" class="danger" data-history="delete">${t("删除", "Delete")}</button></div>
    </div>`;
  }).join("");
}

function openHistory() {
  saveCurrentSession();
  renderHistory();
  $("#historyDrawer").hidden = false;
  $("#historyClose").focus();
}

function closeHistory() {
  $("#historyDrawer").hidden = true;
}

$("#historyClose").onclick = closeHistory;
$("#historyDrawer").onclick = (event) => { if (event.target.id === "historyDrawer") closeHistory(); };
$("#historyNew").onclick = () => { if (startNewSession()) { closeHistory(); toast(t("已新建记录", "New session started")); } };
$("#newSessionBtn").onclick = () => { if (startNewSession()) toast(t("已新建记录，之前的内容在“最近记录”中", "New session started. The previous one is in Recent sessions.")); };
$("#historyList").onclick = (event) => {
  const button = event.target.closest("[data-history]");
  const item = event.target.closest(".history-item");
  if (!button || !item) return;
  const id = item.dataset.id;
  if (button.dataset.history === "open") loadSession(id);
  if (button.dataset.history === "export") {
    const session = readHistory().find((entry) => entry.id === id);
    if (session) download(buildMarkdown(session), fileName(session, "md"), "text/markdown");
  }
  if (button.dataset.history === "delete" && confirmByRepeat(`delete:${id}`, t("再次点击“删除”确认", "Click Delete again to confirm"))) {
    writeHistory(readHistory().filter((entry) => entry.id !== id));
    renderHistory();
    toast(t("已删除", "Deleted"));
  }
};
$("#autosaveToggle").onchange = (event) => {
  autosaveEnabled = event.target.checked;
  writePref("yuliu:autosave", autosaveEnabled ? "1" : "0");
  if (autosaveEnabled) saveCurrentSession();
  renderHistory();
  toast(autosaveEnabled ? t("已开启自动保存", "Auto-save on") : t("已关闭自动保存，已有记录不会删除", "Auto-save off. Existing sessions are kept."));
};
$("#historyClear").onclick = () => {
  if (!readHistory().length) return;
  if (!confirmByRepeat("clear", t("再次点击将永久删除全部本地记录", "Click again to permanently delete all local sessions"))) return;
  try { window.localStorage.removeItem(HISTORY_KEY); } catch { /* ignore */ }
  renderHistory();
  toast(t("已清空本地记录", "All local sessions deleted"));
};

// --- Export ----------------------------------------------------------------

function sessionLabelFor(session, speaker) {
  if (session.speakerNames?.[speaker]) return session.speakerNames[speaker];
  const preset = scenePresets[session.scene]?.[speaker];
  return preset ? t(...preset) : `${t("说话人", "Speaker")} ${speaker}`;
}

function buildPlainText(session) {
  const transcript = session.lines.map((line) => `[${line.time}] ${line.starred ? "★ " : ""}${sessionLabelFor(session, line.speaker)}：${line.text}${line.translation ? `\n    ${line.translation}` : ""}`).join("\n\n");
  const summary = summaryPlainText(session.summary);
  return summary ? `${summary}\n\n———\n\n${transcript}` : transcript;
}

function buildMarkdown(session) {
  const starred = session.lines.filter((line) => line.starred);
  const speakers = Array.from(new Set(session.lines.map((line) => line.speaker))).map((speaker) => sessionLabelFor(session, speaker));
  const parts = [
    `# ${sessionTitle(session.createdAt, session.scene)}`,
    "",
    `- ${t("时长", "Duration")}：${formatClock(session.duration || 0)}`,
    `- ${t("发言人", "Speakers")}：${speakers.join("、")}`,
    `- ${t("导出时间", "Exported")}：${new Date().toLocaleString(uiLanguage === "zh" ? "zh-CN" : "en-US")}`,
  ];
  const summary = summaryPlainText(session.summary);
  if (summary) parts.push("", `## ${t("摘要", "Summary")}`, "", summary);
  if (starred.length) parts.push("", `## ${t("重点标记", "Key moments")}`, "", ...starred.map((line) => `- **${line.time}** ${sessionLabelFor(session, line.speaker)}：${line.text}`));
  parts.push("", `## ${t("完整转写", "Full transcript")}`, "");
  session.lines.forEach((line) => {
    parts.push(`**${line.time} · ${sessionLabelFor(session, line.speaker)}**${line.starred ? " ★" : ""}  `, line.text);
    if (line.translation) parts.push(`> ${line.translation}`);
    parts.push("");
  });
  return parts.join("\n");
}

function buildSrt(session) {
  const stampSrt = (seconds) => `${formatClock(seconds, true)},${String(Math.round((seconds % 1) * 1000)).padStart(3, "0")}`;
  return session.lines.map((line, index) => {
    const start = line.at ?? secondsFromStamp(line.time);
    const next = session.lines[index + 1];
    const nextStart = next ? (next.at ?? secondsFromStamp(next.time)) : start + 4;
    const end = Math.max(start + 1, Math.min(nextStart, start + 8));
    return `${index + 1}\n${stampSrt(start)} --> ${stampSrt(end)}\n${line.text}${line.translation ? `\n${line.translation}` : ""}\n`;
  }).join("\n");
}

function fileName(session, extension) {
  const date = new Date(session.createdAt);
  const pad = (number) => String(number).padStart(2, "0");
  return `yuliu-${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}-${pad(date.getHours())}${pad(date.getMinutes())}.${extension}`;
}

function download(content, name, type) {
  const url = URL.createObjectURL(new Blob([content], { type: `${type};charset=utf-8` }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  document.body.append(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function exportTranscript(format) {
  closeExportMenu();
  if (!lines.length) return toast(t("还没有可导出的内容", "Nothing to export yet"));
  const session = snapshotSession();
  if (format === "copy") {
    try {
      await navigator.clipboard.writeText(buildPlainText(session));
      toast(t("转写内容已复制", "Transcript copied"));
    } catch {
      toast(t("复制失败，请改用导出", "Copy failed. Use export instead."));
    }
    return;
  }
  if (format === "md") download(buildMarkdown(session), fileName(session, "md"), "text/markdown");
  if (format === "txt") download(buildPlainText(session), fileName(session, "txt"), "text/plain");
  if (format === "srt") download(buildSrt(session), fileName(session, "srt"), "application/x-subrip");
  toast(t("已导出", "Exported"));
}

function closeExportMenu() {
  $("#exportMenu").hidden = true;
  $("#exportBtn").setAttribute("aria-expanded", "false");
}

$("#exportBtn").onclick = (event) => {
  event.stopPropagation();
  const open = $("#exportMenu").hidden;
  $("#exportMenu").hidden = !open;
  $("#exportBtn").setAttribute("aria-expanded", String(open));
  if (open) $("#exportMenu button")?.focus();
};
$("#exportMenu").onclick = (event) => {
  const button = event.target.closest("[data-export]");
  if (button) exportTranscript(button.dataset.export);
};
document.addEventListener("click", (event) => { if (!event.target.closest(".menu-wrap")) closeExportMenu(); });

// --- Caption (projection) mode ---------------------------------------------

function renderCaptions(interim = "") {
  const recent = lines.slice(interim ? -1 : -2);
  const items = recent.map((line, index) => `<div class="cap${!interim && index === recent.length - 1 ? " latest" : ""}"><div class="who">${escapeHtml(speakerLabel(line.speaker))}</div>${viewMode !== "translation" ? `<div class="src">${escapeHtml(line.text)}</div>` : ""}${line.translation && viewMode !== "source" ? `<div class="tr">${escapeHtml(line.translation)}</div>` : ""}</div>`);
  if (interim) items.push(`<div class="cap live"><div class="who">${escapeHtml(speakerLabel(activeSpeaker))}</div><div class="src">${escapeHtml(interim)}</div></div>`);
  $("#captionStage").innerHTML = items.join("") || `<div class="cap-empty">${t("开始录音后，字幕会以大字显示在这里", "Captions will appear here in large type once recording starts")}</div>`;
}

function openCaptions() {
  $("#captionView").hidden = false;
  renderCaptions(interimText);
  $("#captionView").requestFullscreen?.().catch(() => {});
}

function closeCaptions() {
  $("#captionView").hidden = true;
  if (document.fullscreenElement) document.exitFullscreen?.().catch(() => {});
}

$("#captionBtn").onclick = openCaptions;
$("#captionExit").onclick = closeCaptions;
document.addEventListener("fullscreenchange", () => {
  if (!document.fullscreenElement && !$("#captionView").hidden) $("#captionView").hidden = true;
});

// --- Keyboard shortcuts ----------------------------------------------------

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") {
    if (!$("#captionView").hidden) return closeCaptions();
    if (!$("#historyDrawer").hidden) return closeHistory();
    if (!$("#exportMenu").hidden) return closeExportMenu();
    if ($("#modal").classList.contains("open")) return $("#modal").classList.remove("open");
  }
  const target = event.target;
  if (event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return;
  if (target.closest?.("input, textarea, select, [contenteditable=true]")) return;
  if ($("#modal").classList.contains("open") || !$("#historyDrawer").hidden) return;
  if (/^[1-9]$/.test(event.key) && Number(event.key) <= speakerCount) { selectSpeaker(Number(event.key)); return; }
  const key = event.key.toLowerCase();
  if (key === "m") markLatest();
  if (key === "c") { if ($("#captionView").hidden) openCaptions(); else closeCaptions(); }
  if (key === "/") { event.preventDefault(); $("#searchInput").focus(); }
});

$(".speakerbar").addEventListener("dblclick", (event) => {
  const button = event.target.closest("[data-speaker]");
  if (button && !button.querySelector("input")) renameSpeaker(button);
});
$("#markBtn").onclick = markLatest;

// Keep work safe across reloads and accidental tab closes.
window.addEventListener("pagehide", saveCurrentSession);
document.addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") saveCurrentSession(); });
window.addEventListener("beforeunload", (event) => {
  if (recording || (lines.length && !isDemoSession && !autosaveEnabled)) {
    event.preventDefault();
    event.returnValue = "";
  }
});

$("#resummarizeBtn").onclick = () => { if (!recording && lines.length) summarize(); };
applyView();

$("#recordBtn").onclick = toggleRecord;
$("#demoBtn").onclick = runDemo;
$("#testMicBtn").onclick = testMicrophone;
$("#uiLangBtn").onclick = () => { uiLanguage = uiLanguage === "zh" ? "en" : "zh"; applyUiLanguage(); render(); };
document.querySelectorAll("[data-speaker]").forEach((button) => { button.onclick = () => selectSpeaker(Number(button.dataset.speaker)); });
$("#addSpeaker").onclick = () => {
  speakerCount += 1;
  const number = speakerCount; // capture: speakerCount keeps changing as more speakers are added
  const button = document.createElement("button");
  button.className = "speakerbtn";
  button.dataset.speaker = number;
  button.textContent = speakerLabel(number);
  button.onclick = () => selectSpeaker(number);
  $("#addSpeaker").before(button);
  selectSpeaker(number);
};
document.querySelectorAll(".provider-card").forEach((button) => { button.onclick = () => chooseProvider(button.dataset.provider); });
$("#speechProvider").onchange = (event) => chooseSpeechProvider(event.target.value);
$("#speechMode").onchange = () => updateSpeechSupport();
chooseProvider("deepseek");
chooseSpeechProvider("openai");
updateSpeechSupport();
applyUiLanguage();
refreshMicrophones();
if (navigator.mediaDevices) navigator.mediaDevices.ondevicechange = refreshMicrophones;
$("#settingsBtn").onclick = () => { updateSpeechSupport(); $("#modal").classList.add("open"); };
$("#cancelBtn").onclick = () => $("#modal").classList.remove("open");
$("#modal").onclick = (event) => { if (event.target.id === "modal") event.currentTarget.classList.remove("open"); };
$("#saveBtn").onclick = saveSettings;
$("#copyBtn").onclick = () => exportTranscript("copy");
$("#historyBtn").onclick = openHistory;

if (!supportsNativeRecognition()) {
  $("#statusSub").textContent = t("当前浏览器需在模型设置中配置云端语音识别", "Configure cloud speech recognition in Model settings");
}

if (document.modelContext?.registerTool) {
  document.modelContext.registerTool({
    name: "start_demo_transcription",
    title: "开始演示转写",
    description: "在页面中开始一段中英文实时转写演示。",
    inputSchema: { type: "object", properties: {}, additionalProperties: false },
    annotations: { readOnlyHint: false, untrustedContentHint: false },
    execute: () => { runDemo(); return { status: "started" }; },
  }).catch(() => {});
}
