"use strict";

const $ = (selector) => document.querySelector(selector);
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
let finishCloudRecording = null;
let uiLanguage = "zh";
let audioContext = null;
let analyser = null;
let meterFrame = null;
let detectedSound = false;
let soundWatchdog = null;
let recognitionWatchdog = null;
let micTestUrl = "";
// Workspace state (session, view, history)
let elapsedBefore = 0;
let sessionId = newSessionId();
let sessionCreatedAt = Date.now();
let isDemoSession = false;
let speakerNames = {};
let namesVersion = 0;
let scene = "meeting";
let viewMode = "both";
let fontSize = 18;
let searchQuery = "";
let searchCursor = -1;
let lastSummary = null;
let lineSeq = 0;
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
  provider: "deepseek",
};

const speechConfig = {
  mode: "auto",
  provider: "openai",
  model: "gpt-transcribe",
  key: "",
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
    note: "模型在你的设备内运行，不需要 API Key。浏览器访问本地服务时可能需要配置 OLLAMA_ORIGINS。",
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
  $("#providerBadge").textContent = speechConfig.key ? `${speechProviders[speechConfig.provider].name}${config.key ? ` · ${providers[config.provider].name}` : ""}` : t("模型设置", "Model settings");
  if (!recording) {
    setText("#statusText", lines.length ? "转写已完成" : "准备就绪", lines.length ? "Transcription complete" : "Ready");
    setText("#statusSub", lines.length ? `共记录 ${lines.length} 段内容` : (supportsNativeRecognition() ? "点击开始，允许麦克风访问" : "当前浏览器需配置云端语音识别"), lines.length ? `${lines.length} segments captured` : (supportsNativeRecognition() ? "Press start and allow microphone access" : "Cloud speech recognition is required in this browser"));
  }
  $("#sourceLang").options[0].text = t("中文", "Chinese");
  $("#sourceLang").options[1].text = "English";
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
  if (lastSummary) restoreSummary(lastSummary);
  setText(".summary .eyebrow", "AI 摘要", "AI summary");
  if (!lines.length) {
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
  setText(".dialog > p", "先选择语音转文字方式，再按需连接翻译与总结模型。密钥只在当前页面使用，不会保存到网站。", "Choose speech-to-text first, then optionally connect a translation and summary model. Keys are used only on this page and are not saved.");
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
  if (notes[0]) notes[0].textContent = t("ChatGPT 登录只用于账号验证，不包含 OpenAI API 额度。云端识别约每 6 秒更新一次字幕。", "ChatGPT sign-in verifies your account; it does not include OpenAI API credits. Cloud captions update about every 6 seconds.");
  const textLabels = document.querySelectorAll(".dialog > .field label, .model-row label");
  const textLabelPairs = [["Chat Completions 地址", "Chat Completions endpoint"], ["模型名称", "Model name"], ["API Key", "API key"]];
  textLabels.forEach((label, index) => { if (textLabelPairs[index]) label.textContent = t(...textLabelPairs[index]); });
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
  window.setTimeout(() => element.classList.remove("show"), 2600);
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
  const samples = new Uint8Array(analyser.fftSize);
  const bars = Array.from(document.querySelectorAll(".meter i"));
  $(".meter")?.classList.add("mic-live");
  const update = () => {
    analyser.getByteTimeDomainData(samples);
    let sum = 0;
    for (const sample of samples) {
      const normalized = (sample - 128) / 128;
      sum += normalized * normalized;
    }
    const rms = Math.sqrt(sum / samples.length);
    if (rms > 0.018) detectedSound = true;
    const level = Math.min(1, rms * 9);
    bars.forEach((bar, index) => {
      const shape = [0.55, 0.82, 1, 0.76, 0.48][index] || 0.6;
      bar.style.height = `${Math.max(6, Math.round(6 + level * 23 * shape))}px`;
    });
    meterFrame = window.requestAnimationFrame(update);
  };
  update();
}

function stopAudioMeter() {
  if (meterFrame) window.cancelAnimationFrame(meterFrame);
  meterFrame = null;
  analyser = null;
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

function stamp() {
  const seconds = Math.max(0, Math.floor((Date.now() - startTime) / 1000));
  return `${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(seconds % 60).padStart(2, "0")}`;
}

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
  return `
      <span class="stamp">${line.time}</span>
      <div>
        <div class="utterance-head"><button type="button" class="speaker-badge ${speakerClass(line.speaker)}" data-action="speaker" title="${t("点按更换说话人", "Tap to change speaker")}">${escapeHtml(speakerLabel(line.speaker))}</button>${line.edited ? `<span class="edited-tag">${t("已校对", "edited")}</span>` : ""}<span class="line-actions"><button type="button" class="act-star" data-action="star" aria-label="${t("标记重点", "Mark as key moment")}" title="${t("标记重点", "Mark as key moment")}">${line.starred ? "★" : "☆"}</button><button type="button" data-action="edit" aria-label="${t("修改文字", "Edit text")}" title="${t("修改文字", "Edit text")}">✎</button><button type="button" data-action="copy" aria-label="${t("复制这一句", "Copy line")}" title="${t("复制这一句", "Copy line")}">⧉</button></span></div>
        <div class="words">${highlight(line.text)}</div>
        ${line.translation ? `<div class="translation">${highlight(line.translation)}</div>` : ""}
      </div>`;
}

function render(interim = "") {
  const box = $("#transcript");
  $("#empty")?.remove();
  const nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 80;
  let list = box.querySelector(".lines");
  if (!list) {
    box.innerHTML = "";
    list = document.createElement("div");
    list.className = "lines";
    box.append(list);
  }
  const previousCount = list.children.length;
  const key = `${uiLanguage}|${searchQuery}|${namesVersion}|${scene}`;
  // Only touch lines that changed, so long sessions stay smooth and text selection survives live updates.
  lines.forEach((line, index) => {
    const signature = `${line.id}:${line.rev || 0}:${key}`;
    const existing = list.children[index];
    if (existing?.dataset.sig === signature) {
      existing.dataset.index = index;
      return;
    }
    if (existing?.querySelector("[contenteditable=true]")) return;
    const element = document.createElement("div");
    element.className = `line${line.starred ? " starred" : ""}`;
    element.dataset.index = index;
    element.dataset.sig = signature;
    element.innerHTML = lineMarkup(line);
    if (existing) existing.replaceWith(element);
    else list.append(element);
  });
  while (list.children.length > lines.length) list.lastElementChild.remove();

  let live = box.querySelector(".interim");
  if (interim) {
    if (!live) {
      live = document.createElement("div");
      live.className = "line interim";
      box.append(live);
    }
    live.innerHTML = `<span class="stamp">${stamp()}</span><div><div class="utterance-head"><span class="speaker-badge ${speakerClass(activeSpeaker)}">${escapeHtml(speakerLabel(activeSpeaker))}</span></div><div class="words">${escapeHtml(interim)}</div></div>`;
  } else {
    live?.remove();
  }

  const grew = lines.length > previousCount || Boolean(interim);
  if (nearBottom || previousCount === 0) {
    box.scrollTop = box.scrollHeight;
    $("#jumpLatest").hidden = true;
  } else if (grew && recording) {
    $("#jumpLatest").hidden = false;
  }
  if (searchQuery) updateSearchCount();
  if (!$("#captionView").hidden) renderCaptions(interim);
  updateSideSoon();
}

function selectSpeaker(number) {
  activeSpeaker = number;
  document.querySelectorAll("[data-speaker]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.speaker) === number);
  });
}

function cycleSpeaker(index) {
  lines[index].speaker = lines[index].speaker % speakerCount + 1;
  touch(lines[index]);
  render();
  toast(t(`已改为${speakerLabel(lines[index].speaker)}`, `Changed to ${speakerLabel(lines[index].speaker)}`));
}

window.cycleSpeaker = cycleSpeaker;

function escapeHtml(value) {
  return String(value).replace(/[&<>'"]/g, (character) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "'": "&#39;",
    '"': "&quot;",
  })[character]);
}

async function modelTask(type, text) {
  if (!config.key && config.provider !== "ollama") return "";
  const target = $("#targetLang").value === "zh" ? "中文" : "English";
  const prompts = {
    translate: `将以下内容自然地翻译成${target}，只输出译文：`,
    summary: `总结以下会议内容。用与内容相同的主要语言输出：1段简短摘要、3个关键点、如有则列出行动项，并保留说话人归属。${sceneSummaryHint()}`,
  };
  try {
    const headers = { "Content-Type": "application/json" };
    if (config.key) headers.Authorization = `Bearer ${config.key}`;
    const response = await fetch(config.endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify({
        model: config.model,
        messages: [
          { role: "system", content: "你是专业的中英文会议记录助手。准确、简洁，不虚构。" },
          { role: "user", content: `${prompts[type]}\n\n${text}` },
        ],
        temperature: 0.2,
      }),
    });
    if (!response.ok) throw new Error();
    const data = await response.json();
    return data.choices?.[0]?.message?.content?.trim() || "";
  } catch {
    toast("翻译或总结模型连接失败，已保留原始转写");
    return "";
  }
}

async function addLine(text, translation = "", speaker = activeSpeaker, time = stamp()) {
  const cleaned = String(text || "").trim();
  if (!cleaned) return;
  const item = { id: `l${Date.now().toString(36)}${(lineSeq += 1)}`, time, at: secondsFromStamp(time), text: cleaned, translation, speaker, starred: false, edited: false, rev: 0 };
  lines.push(item);
  render();
  scheduleAutosave();
  if (!translation && config.key && $("#targetLang").value !== "off") {
    const result = await modelTask("translate", item.text);
    item.translation = result;
    touch(item);
    render();
  }
}

function setupNativeRecognition() {
  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) return null;
  const instance = new SpeechRecognition();
  instance.continuous = true;
  instance.interimResults = true;
  instance.lang = $("#sourceLang").value;
  instance.onresult = (event) => {
    let interim = "";
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const text = event.results[index][0].transcript;
      if (event.results[index].isFinal) addLine(text);
      else interim += text;
    }
    render(interim);
  };
  instance.onerror = (event) => {
    if (event.error === "aborted" || event.error === "no-speech") return;
    const fatal = ["not-allowed", "service-not-allowed", "network"].includes(event.error);
    toast(event.error === "not-allowed" ? t("麦克风权限被拒绝，请在浏览器设置中允许", "Microphone permission denied. Allow it in browser settings.") : t("浏览器语音识别不可用，可切换到云端识别", "Browser speech recognition is unavailable. Switch to cloud transcription."));
    if (fatal && recording) stopRecording();
  };
  instance.onend = () => {
    if (recording && recognitionMode === "browser") {
      try { instance.start(); } catch { /* already starting */ }
    }
  };
  return instance;
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

async function transcribeAudio(blob, capturedAt) {
  if (speechConfig.failed || blob.size < 900) return;
  $("#recorder").classList.add("transcribing");
  try {
    const form = new FormData();
    form.append("file", blob, audioFilename(blob.type));
    form.append("provider", speechConfig.provider);
    form.append("model", speechConfig.model);
    form.append("language", $("#sourceLang").value.startsWith("zh") ? "zh" : "en");
    const response = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "x-transcription-api-key": speechConfig.key },
      body: form,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(data.error || "语音服务返回错误");
    await addLine(data.text, "", activeSpeaker, capturedAt);
  } catch (error) {
    speechConfig.failed = true;
    $("#statusText").textContent = "语音识别连接失败";
    $("#statusSub").textContent = error.message || "请检查语音 API Key 和模型设置";
    toast("云端识别失败，请检查 API Key 与模型");
  } finally {
    $("#recorder").classList.remove("transcribing");
  }
}

function startCloudSegment() {
  if (!recording || recognitionMode !== "cloud" || !mediaStream) return;
  const chunks = [];
  const capturedAt = stamp();
  const mimeType = preferredAudioType();
  try {
    mediaRecorder = new MediaRecorder(mediaStream, mimeType ? { mimeType } : undefined);
  } catch {
    speechConfig.failed = true;
    $("#statusText").textContent = "无法创建录音";
    $("#statusSub").textContent = "当前浏览器不支持可用的录音格式";
    toast("当前浏览器无法创建录音文件");
    return;
  }
  mediaRecorder.ondataavailable = (event) => {
    if (event.data?.size) chunks.push(event.data);
  };
  mediaRecorder.onerror = () => {
    speechConfig.failed = true;
    toast("录音出现错误，请重新开始");
  };
  mediaRecorder.onstop = () => {
    window.clearTimeout(segmentTimer);
    const blob = new Blob(chunks, { type: mediaRecorder?.mimeType || mimeType || "audio/webm" });
    if (recording && recognitionMode === "cloud") startCloudSegment();
    transcriptionQueue = transcriptionQueue.then(() => transcribeAudio(blob, capturedAt));
    if (!recording && finishCloudRecording) {
      const resolve = finishCloudRecording;
      finishCloudRecording = null;
      transcriptionQueue.finally(resolve);
    }
  };
  mediaRecorder.start();
  segmentTimer = window.setTimeout(() => {
    if (mediaRecorder?.state === "recording") mediaRecorder.stop();
  }, 6000);
}

async function toggleRecord() {
  if (recording) {
    await stopRecording();
    return;
  }
  if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) {
    toast(t("当前页面无法使用麦克风，请使用 HTTPS 并允许麦克风权限", "Microphone access is unavailable. Use HTTPS and allow microphone permission."));
    return;
  }

  if (isDemoSession && lines.length) startNewSession({ force: true });
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
      startSession(`${speechProviders[speechConfig.provider].name} ${t("识别中，约每 6 秒更新", "transcribing, updates about every 6 seconds")}`);
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
  startTime = Date.now() - elapsedBefore;
  $("#timer").textContent = stamp();
  $("#jumpLatest").hidden = true;
  updateSideSoon();
  $("#recorder").classList.add("recording");
  $("#statusText").textContent = t("正在聆听", "Listening");
  $("#statusSub").textContent = statusDetail;
  $("#recordLabel").textContent = t("结束录音", "Stop recording");
  tick = window.setInterval(() => {
    $("#timer").textContent = stamp();
    const duration = $("#statDuration");
    if (duration) duration.textContent = formatClock(currentElapsedSeconds());
  }, 500);
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  elapsedBefore = Math.max(0, Date.now() - startTime);
  window.clearInterval(tick);
  window.clearInterval(demoTimer);
  window.clearTimeout(segmentTimer);
  window.clearTimeout(soundWatchdog);
  window.clearTimeout(recognitionWatchdog);
  try { recognition?.stop(); } catch { /* already stopped */ }

  if (recognitionMode === "cloud" && mediaRecorder?.state === "recording") {
    await new Promise((resolve) => {
      finishCloudRecording = resolve;
      mediaRecorder.stop();
    });
  } else {
    await transcriptionQueue;
  }
  mediaStream?.getTracks().forEach((track) => track.stop());
  stopAudioMeter();
  mediaStream = null;
  mediaRecorder = null;
  recognitionMode = "";

  $("#recorder").classList.remove("recording", "transcribing");
  $("#statusText").textContent = lines.length ? t("转写已完成", "Transcription complete") : t("没有识别到语音", "No speech recognized");
  $("#statusSub").textContent = lines.length ? t(`共记录 ${lines.length} 段内容`, `${lines.length} segments captured`) : t("请运行麦克风测试，或检查云端语音 API 设置", "Run the microphone test or check the cloud speech API settings");
  $("#recordLabel").textContent = t("继续录音", "Record again");
  saveCurrentSession();
  updateSideSoon();
  if (lines.length) await summarize();
}

async function summarize() {
  const all = lines.map((line) => `${speakerLabel(line.speaker)}：${line.text}`).join("\n");
  if (!config.key && config.provider !== "ollama") {
    restoreSummary({ state: "nomodel" });
  } else {
    restoreSummary({ state: "working" });
    const summary = await modelTask("summary", all);
    restoreSummary(summary ? { state: "done", text: summary } : { state: "failed" });
  }
  scheduleAutosave();
}

function restoreSummary(summary) {
  lastSummary = summary;
  const copy = {
    nomodel: [t("转写已完成", "Transcript ready"), t("如需自动生成摘要，请在模型设置中连接 DeepSeek、Groq 或其他文本模型。", "Connect DeepSeek, Groq, or another text model in Model settings to generate a summary.")],
    working: [t("正在整理…", "Summarizing…"), t("正在按发言人提炼本次会话的重点与行动项。", "Extracting key points and action items by speaker.")],
    failed: [t("摘要生成失败", "Summary failed"), t("原始转写已保留，请检查文本模型设置后重试。", "The transcript is kept. Check the text model settings and try again.")],
    done: [t("本次会话摘要", "Session summary"), summary.text || ""],
    none: [t("尚未生成摘要", "No summary yet"), t("可点击“生成摘要”，基于当前（含已校对）的转写重新整理。", "Press Summarize to build one from the current, edited transcript.")],
  }[summary.state] || [t("录音结束后生成", "Generated after recording"), ""];
  $("#summaryTitle").textContent = copy[0];
  $("#summaryText").className = summary.state === "done" ? "" : "placeholder";
  $("#summaryText").textContent = copy[1];
  const speakers = new Set(lines.map((line) => line.speaker)).size;
  updateSideSoon();
  if (!lines.length) return;
  $("#chips").innerHTML = `<span class="chip">${t("已完成", "Done")}</span><span class="chip">${t(`${speakers} 位说话人`, `${speakers} speakers`)}</span><span class="chip">${t(`${lines.length} 段内容`, `${lines.length} segments`)}</span>`;
}

function runDemo() {
  if (recording) return;
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
    support.textContent = selectedMode === "cloud" ? t("将使用云端语音识别，字幕约每 6 秒更新。", "Cloud transcription will update captions about every 6 seconds.") : t("当前浏览器支持实时识别；自动模式会优先使用浏览器能力。", "This browser supports live recognition; Auto will prefer it.");
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

function saveSettings() {
  speechConfig.mode = $("#speechMode").value;
  speechConfig.provider = $("#speechProvider").value;
  speechConfig.model = $("#speechModel").value.trim();
  speechConfig.key = $("#speechKey").value.trim();
  config.key = $("#apiKey").value.trim();
  config.endpoint = $("#endpoint").value.trim();
  config.model = $("#model").value.trim();

  if (!speechConfig.model) return toast(t("请填写语音模型名称", "Enter a speech model name"));
  const needsCloud = speechConfig.mode === "cloud" || (speechConfig.mode === "auto" && !supportsNativeRecognition());
  if (needsCloud && !speechConfig.key) return toast(t("当前识别方式需要语音 API Key", "This recognition mode requires a speech API key"));
  if (!config.endpoint || !config.model) return toast(t("请填写文本模型接口和名称", "Enter the text model endpoint and name"));

  speechConfig.failed = false;
  const speechName = needsCloud ? speechProviders[speechConfig.provider].name : t("浏览器语音", "Browser speech");
  $("#providerBadge").textContent = config.key ? `${speechName} · ${providers[config.provider].name}` : speechName;
  $("#modal").classList.remove("open");
  $("#statusSub").textContent = needsCloud ? t(`${speechName} 已就绪，点击开始录音`, `${speechName} is ready. Start recording.`) : t("浏览器实时识别已就绪", "Browser live recognition is ready");
  toast(t("设置已保存，可以开始录音", "Settings saved. You can start recording."));
}

// ---------------------------------------------------------------------------
// Workspace UX: sessions & local history, export, search, editing, captions.
// Transcripts stay in this browser only; audio and API keys are never stored.
// ---------------------------------------------------------------------------

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
  return Math.floor((recording ? Date.now() - startTime : elapsedBefore) / 1000);
}

function touch(line) {
  line.rev = (line.rev || 0) + 1;
  scheduleAutosave();
}

function sceneSummaryHint() {
  if (scene === "class") return "这是一堂课程：请额外整理知识点、老师强调的重点和课后任务。";
  if (scene === "interview") return "这是一次访谈：请按“问题—回答要点”整理，并列出值得引用的原话。";
  return "";
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
      namesVersion += 1;
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
  touch(line);
  render();
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
  const finish = async (save) => {
    if (done) return;
    done = true;
    const value = words.textContent.replace(/\s+/g, " ").trim();
    words.contentEditable = "false";
    const changed = save && value && value !== line.text;
    if (changed) {
      line.text = value;
      line.edited = true;
    }
    touch(line);
    render();
    if (changed && line.translation && config.key && $("#targetLang").value !== "off") {
      const result = await modelTask("translate", line.text);
      if (result) { line.translation = result; touch(line); render(); }
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
  const index = Number(element.dataset.index);
  const line = lines[index];
  if (!line) return;
  const action = button.dataset.action;
  if (action === "speaker") cycleSpeaker(index);
  if (action === "star") { line.starred = !line.starred; touch(line); render(); }
  if (action === "edit") editLine(element, index);
  if (action === "copy") {
    navigator.clipboard?.writeText(`${line.text}${line.translation ? `\n${line.translation}` : ""}`)
      .then(() => toast(t("已复制这一句", "Line copied")), () => toast(t("复制失败", "Copy failed")));
  }
});
$("#transcript").addEventListener("dblclick", (event) => {
  const element = event.target.closest(".line:not(.interim)");
  if (element && event.target.closest(".words")) editLine(element, Number(element.dataset.index));
});
$("#transcript").addEventListener("scroll", () => {
  const box = $("#transcript");
  if (box.scrollHeight - box.scrollTop - box.clientHeight < 80) $("#jumpLatest").hidden = true;
}, { passive: true });
$("#jumpLatest").onclick = () => {
  const box = $("#transcript");
  box.scrollTo({ top: box.scrollHeight, behavior: "smooth" });
  $("#jumpLatest").hidden = true;
};

// --- Search & view ---------------------------------------------------------

function updateSearchCount() {
  const count = searchQuery ? $("#transcript").querySelectorAll(".lines mark").length : 0;
  $("#searchCount").textContent = searchQuery ? (count ? t(`${count} 处`, `${count} found`) : t("无结果", "No match")) : "";
}

function jumpToMatch(step) {
  const marks = Array.from($("#transcript").querySelectorAll(".lines mark"));
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
  const cjk = (text.match(/[㐀-鿿豈-﫿]/g) || []).length;
  const latin = (text.replace(/[㐀-鿿豈-﫿]/g, " ").match(/[A-Za-z0-9]+(?:['’][A-Za-z]+)?/g) || []).length;
  return cjk + latin;
}

function updateSideSoon() {
  window.clearTimeout(sideTimer);
  sideTimer = window.setTimeout(updateSide, 250);
}

function updateSide() {
  const has = lines.length > 0;
  $("#newSessionBtn").hidden = !has || recording;
  $("#resummarizeBtn").hidden = !has || recording || lastSummary?.state === "working";
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
  const starred = lines.map((line, index) => ({ line, index })).filter((item) => item.line.starred);
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
    ${starred.length ? `<h4>${t("重点标记", "Key moments")}</h4><div class="marks">${starred.slice(-6).map((item) => `<button type="button" data-goto="${item.index}"><span>${item.line.time}</span>${escapeHtml(item.line.text.slice(0, 42))}</button>`).join("")}</div>` : ""}`;
}

$("#statsBox").addEventListener("click", (event) => {
  const target = event.target.closest("[data-goto]");
  if (!target) return;
  const element = $("#transcript").querySelector(`.lines > .line[data-index="${target.dataset.goto}"]`);
  element?.scrollIntoView({ block: "center", behavior: "smooth" });
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
    summary: lastSummary?.state === "done" ? lastSummary : null,
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
  lines = [];
  elapsedBefore = 0;
  sessionId = newSessionId();
  sessionCreatedAt = Date.now();
  isDemoSession = false;
  speakerNames = {};
  namesVersion += 1;
  lastSummary = null;
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
  sessionId = session.id;
  sessionCreatedAt = session.createdAt;
  isDemoSession = false;
  scene = session.scene || "meeting";
  $("#sceneSelect").value = scene;
  if (session.sourceLang) $("#sourceLang").value = session.sourceLang;
  if (session.targetLang) $("#targetLang").value = session.targetLang;
  speakerNames = session.speakerNames || {};
  namesVersion += 1;
  lines = (session.lines || []).map((line, index) => ({ ...line, id: line.id || `h${index}`, at: line.at ?? secondsFromStamp(line.time), rev: 0 }));
  elapsedBefore = (session.duration || 0) * 1000;
  rebuildSpeakerButtons(Math.max(2, session.speakerCount || 2, ...lines.map((line) => line.speaker)));
  $("#transcript").innerHTML = "";
  render();
  $("#transcript").scrollTop = 0;
  $("#timer").textContent = formatClock(session.duration || 0);
  $("#statusText").textContent = t("已打开历史记录", "Session opened");
  $("#statusSub").textContent = t(`共 ${lines.length} 段 · 点击“继续录音”可接着记录`, `${lines.length} segments · press Record again to continue`);
  $("#recordLabel").textContent = t("继续录音", "Record again");
  restoreSummary(session.summary || { state: "none" });
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
  return session.lines.map((line) => `[${line.time}] ${line.starred ? "★ " : ""}${sessionLabelFor(session, line.speaker)}：${line.text}${line.translation ? `\n    ${line.translation}` : ""}`).join("\n\n");
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
  if (session.summary?.text) parts.push("", `## ${t("摘要", "Summary")}`, "", session.summary.text);
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
  renderCaptions();
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

const emptyStateHtml = $("#transcript").innerHTML;
const initialChipsHtml = $("#chips").innerHTML;
$("#resummarizeBtn").onclick = () => { if (!recording && lines.length) summarize(); };
applyView();

$("#recordBtn").onclick = toggleRecord;
$("#demoBtn").onclick = runDemo;
$("#testMicBtn").onclick = testMicrophone;
$("#uiLangBtn").onclick = () => { uiLanguage = uiLanguage === "zh" ? "en" : "zh"; applyUiLanguage(); render(); };
document.querySelectorAll("[data-speaker]").forEach((button) => { button.onclick = () => selectSpeaker(Number(button.dataset.speaker)); });
$("#addSpeaker").onclick = () => {
  speakerCount += 1;
  const button = document.createElement("button");
  button.className = "speakerbtn";
  button.dataset.speaker = speakerCount;
  const number = speakerCount;
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
