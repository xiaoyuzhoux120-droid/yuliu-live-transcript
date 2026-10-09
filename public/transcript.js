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

function toast(message) {
  const element = $("#toast");
  element.textContent = message;
  element.classList.add("show");
  window.setTimeout(() => element.classList.remove("show"), 2600);
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
        <div class="utterance-head"><button class="speaker-badge s${line.speaker}" onclick="cycleSpeaker(${index})" title="点按更换说话人">说话人 ${line.speaker}</button></div>
        <div class="words">${escapeHtml(line.text)}</div>
        ${line.translation ? `<div class="translation">${escapeHtml(line.translation)}</div>` : ""}
      </div>
    </div>`).join("") + (interim ? `
    <div class="line interim">
      <span class="stamp">${stamp()}</span>
      <div><div class="utterance-head"><span class="speaker-badge s${activeSpeaker}">说话人 ${activeSpeaker}</span></div><div class="words">${escapeHtml(interim)}</div></div>
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
  toast(`已改为说话人 ${lines[index].speaker}`);
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
    toast(event.error === "not-allowed" ? "麦克风权限被拒绝，请在浏览器设置中允许" : "浏览器语音识别不可用，可切换到云端识别");
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
    toast("当前页面无法使用麦克风，请使用 HTTPS 并允许麦克风权限");
    return;
  }

  speechConfig.mode = $("#speechMode").value;
  const useNative = speechConfig.mode === "browser" || (speechConfig.mode === "auto" && supportsNativeRecognition());
  if (speechConfig.mode === "browser" && !supportsNativeRecognition()) {
    showSpeechSetup("此浏览器不支持浏览器实时识别，请选择云端精准识别");
    return;
  }
  if (!useNative && (!supportsCloudRecording() || !speechConfig.key)) {
    showSpeechSetup(!supportsCloudRecording() ? "当前浏览器无法录音，请改用最新版 Chrome、Edge 或 Safari" : "当前浏览器需要云端识别，请填写 OpenAI 或 Groq API Key");
    return;
  }

  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    if (useNative) {
      stream.getTracks().forEach((track) => track.stop());
      recognition = setupNativeRecognition();
      if (!recognition) {
        showSpeechSetup("浏览器实时识别不可用，请切换到云端精准识别");
        return;
      }
      recognitionMode = "browser";
      startSession("浏览器实时识别中");
      recognition.start();
    } else {
      mediaStream = stream;
      speechConfig.failed = false;
      recognitionMode = "cloud";
      startSession(`${speechProviders[speechConfig.provider].name} 识别中，约每 6 秒更新`);
      startCloudSegment();
    }
  } catch (error) {
    toast(error?.name === "NotAllowedError" ? "请在浏览器设置中允许麦克风权限" : "无法打开麦克风，请检查系统权限");
  }
}

function startSession(statusDetail) {
  recording = true;
  startTime = Date.now();
  $("#timer").textContent = "00:00";
  $("#recorder").classList.add("recording");
  $("#statusText").textContent = "正在聆听";
  $("#statusSub").textContent = statusDetail;
  $("#recordLabel").textContent = "结束录音";
  tick = window.setInterval(() => { $("#timer").textContent = stamp(); }, 500);
}

async function stopRecording() {
  if (!recording) return;
  recording = false;
  window.clearInterval(tick);
  window.clearInterval(demoTimer);
  window.clearTimeout(segmentTimer);
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
  mediaStream = null;
  mediaRecorder = null;
  recognitionMode = "";

  $("#recorder").classList.remove("recording", "transcribing");
  $("#statusText").textContent = lines.length ? "转写已完成" : "没有识别到语音";
  $("#statusSub").textContent = lines.length ? `共记录 ${lines.length} 段内容` : "请靠近麦克风后重试，或检查语音 API 设置";
  $("#recordLabel").textContent = "继续录音";
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
  $("#endpointHint").textContent = provider.hint;
  $("#providerNote").textContent = provider.note;
  $("#apiKey").placeholder = id === "ollama" ? "本地模型无需填写" : "可稍后填写";
  $("#modelSuggestions").innerHTML = provider.models.map((model) => `<option value="${model}">`).join("");
}

function chooseSpeechProvider(id) {
  speechConfig.provider = id;
  const provider = speechProviders[id];
  $("#speechModel").value = provider.model;
  $("#speechKey").placeholder = provider.placeholder;
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
    support.textContent = selectedMode === "cloud" ? "将使用云端语音识别，字幕约每 6 秒更新。" : "当前浏览器支持实时识别；自动模式会优先使用浏览器能力。";
  } else {
    support.textContent = "当前浏览器不支持内置实时识别。请选择云端精准识别并填写 API Key。";
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

  if (!speechConfig.model) return toast("请填写语音模型名称");
  const needsCloud = speechConfig.mode === "cloud" || (speechConfig.mode === "auto" && !supportsNativeRecognition());
  if (needsCloud && !speechConfig.key) return toast("当前识别方式需要语音 API Key");
  if (!config.endpoint || !config.model) return toast("请填写文本模型接口和名称");

  speechConfig.failed = false;
  const speechName = needsCloud ? speechProviders[speechConfig.provider].name : "浏览器语音";
  $("#providerBadge").textContent = config.key ? `${speechName} · ${providers[config.provider].name}` : speechName;
  $("#modal").classList.remove("open");
  $("#statusSub").textContent = needsCloud ? `${speechName} 已就绪，点击开始录音` : "浏览器实时识别已就绪";
  toast("设置已保存，可以开始录音");
}

$("#recordBtn").onclick = toggleRecord;
$("#demoBtn").onclick = runDemo;
document.querySelectorAll("[data-speaker]").forEach((button) => { button.onclick = () => selectSpeaker(Number(button.dataset.speaker)); });
$("#addSpeaker").onclick = () => {
  speakerCount += 1;
  const button = document.createElement("button");
  button.className = "speakerbtn";
  button.dataset.speaker = speakerCount;
  button.textContent = `说话人 ${speakerCount}`;
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
  $("#statusSub").textContent = "当前浏览器需在模型设置中配置云端语音识别";
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
