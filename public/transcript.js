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
  setText(".speaker-state", "手动标记", "Manual labels");
  document.querySelectorAll("[data-speaker]").forEach((button) => { button.textContent = `${t("说话人", "Speaker")} ${button.dataset.speaker}`; });
  setText("#addSpeaker", "＋ 添加", "+ Add");
  setText(".speakerhelp", "录音时点按切换", "Tap to switch while recording");
  if (!recording) setText("#recordLabel", lines.length ? "继续录音" : "开始录音", lines.length ? "Record again" : "Start recording");
  setText("#demoBtn", "体验演示", "Try demo");
  setText(".summary .eyebrow", "AI 摘要", "AI summary");
  if (!lines.length) {
    setText("#summaryTitle", "录音结束后生成", "Generated after recording");
    setText("#summaryText", "将自动提炼核心结论、关键决定和下一步行动。", "Extract key conclusions, decisions, and next steps automatically.");
  }
  setText(".detail .eyebrow", "会话洞察", "Session insights");
  const insights = document.querySelectorAll(".detail .insight");
  if (insights[0]) { insights[0].querySelector("strong").textContent = t("说话人区分", "Speaker labels"); insights[0].querySelector("p").textContent = t("区分不同发言人，并可点按标签快速校正。", "Label speakers and tap any label to correct it quickly."); }
  if (insights[1]) { insights[1].querySelector("strong").textContent = t("实时翻译", "Live translation"); insights[1].querySelector("p").textContent = t("原文与译文同步对照，适合访谈与跨国会议。", "View source and translation together for interviews and global meetings."); }
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

function render(interim = "") {
  const box = $("#transcript");
  $("#empty")?.remove();
  box.innerHTML = lines.map((line, index) => `
    <div class="line">
      <span class="stamp">${line.time}</span>
      <div>
        <div class="utterance-head"><button class="speaker-badge s${line.speaker}" onclick="cycleSpeaker(${index})" title="${t("点按更换说话人", "Tap to change speaker")}">${t("说话人", "Speaker")} ${line.speaker}</button></div>
        <div class="words">${escapeHtml(line.text)}</div>
        ${line.translation ? `<div class="translation">${escapeHtml(line.translation)}</div>` : ""}
      </div>
    </div>`).join("") + (interim ? `
    <div class="line interim">
      <span class="stamp">${stamp()}</span>
      <div><div class="utterance-head"><span class="speaker-badge s${activeSpeaker}">${t("说话人", "Speaker")} ${activeSpeaker}</span></div><div class="words">${escapeHtml(interim)}</div></div>
    </div>` : "");
  box.scrollTop = box.scrollHeight;
}

function selectSpeaker(number) {
  activeSpeaker = number;
  document.querySelectorAll("[data-speaker]").forEach((button) => {
    button.classList.toggle("active", Number(button.dataset.speaker) === number);
  });
}

function cycleSpeaker(index) {
  lines[index].speaker = lines[index].speaker % speakerCount + 1;
  render();
  toast(t(`已改为说话人 ${lines[index].speaker}`, `Changed to Speaker ${lines[index].speaker}`));
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
    summary: "总结以下会议内容。用与内容相同的主要语言输出：1段简短摘要、3个关键点、如有则列出行动项，并保留说话人归属。",
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
  const item = { time, text: cleaned, translation, speaker };
  lines.push(item);
  render();
  if (!translation && config.key && $("#targetLang").value !== "off") {
    const result = await modelTask("translate", item.text);
    item.translation = result;
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
  startTime = Date.now();
  $("#timer").textContent = "00:00";
  $("#recorder").classList.add("recording");
  $("#statusText").textContent = t("正在聆听", "Listening");
  $("#statusSub").textContent = statusDetail;
  $("#recordLabel").textContent = t("结束录音", "Stop recording");
  tick = window.setInterval(() => { $("#timer").textContent = stamp(); }, 500);
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
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
  if (lines.length) await summarize();
}

async function summarize() {
  const all = lines.map((line) => `说话人 ${line.speaker}：${line.text}`).join("\n");
  if (!config.key && config.provider !== "ollama") {
    $("#summaryTitle").textContent = "转写已完成";
    $("#summaryText").className = "placeholder";
    $("#summaryText").textContent = "如需自动生成摘要，请在模型设置中连接 DeepSeek、Groq 或其他文本模型。";
  } else {
    $("#summaryTitle").textContent = "正在整理…";
    $("#summaryText").className = "placeholder";
    $("#summaryText").textContent = "正在按发言人提炼本次会话的重点与行动项。";
    const summary = await modelTask("summary", all);
    $("#summaryTitle").textContent = summary ? "本次会话摘要" : "摘要生成失败";
    $("#summaryText").className = summary ? "" : "placeholder";
    $("#summaryText").textContent = summary || "原始转写已保留，请检查文本模型设置后重试。";
  }
  const speakers = new Set(lines.map((line) => line.speaker)).size;
  $("#chips").innerHTML = `<span class="chip">已完成</span><span class="chip">${speakers} 位说话人</span><span class="chip">${lines.length} 段内容</span>`;
}

function runDemo() {
  if (recording) return;
  lines = [];
  render();
  recognitionMode = "demo";
  startSession("演示字幕生成中");
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
  button.textContent = `${t("说话人", "Speaker")} ${speakerCount}`;
  button.onclick = () => selectSpeaker(speakerCount);
  $("#addSpeaker").before(button);
  selectSpeaker(speakerCount);
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
$("#copyBtn").onclick = async () => {
  if (!lines.length) return toast("还没有可复制的内容");
  await navigator.clipboard.writeText(lines.map((line) => `说话人 ${line.speaker}：${line.text}${line.translation ? `\n${line.translation}` : ""}`).join("\n\n"));
  toast("转写内容已复制");
};
$("#historyBtn").onclick = () => toast("第一版暂不保存历史记录，保护本地隐私");

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
