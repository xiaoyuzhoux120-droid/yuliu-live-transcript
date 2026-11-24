# 浏览器兼容性

基于 `public/transcript.js` 使用的 API 静态分析，并在 Chromium 中模拟其他引擎的 API 缺失进行了自动化验证（`tests/e2e/compat.spec.ts`）。Firefox / WebKit 真机用例可用 `E2E_ALL_BROWSERS=1` 开启。

| 能力 | Chrome / Edge 桌面 | Android Chrome | Safari 桌面 | iOS Safari / iOS 上所有浏览器 | Firefox |
|---|---|---|---|---|---|
| 浏览器实时识别（`webkitSpeechRecognition`） | ✅（音频发送至 Google） | ✅ | ✅ 14.1+ | ⚠️ 支持但常自动中断，`continuous` 不可靠 | ❌ |
| 云端识别（`MediaRecorder`） | ✅ `audio/webm;codecs=opus` | ✅ | ✅ `audio/mp4` → 上传为 `.m4a` | ✅ `audio/mp4` | ✅ `audio/webm`（`ogg` 也被服务端接受） |
| 音量表（`AudioContext`） | ✅ | ✅ | ✅（含 `webkitAudioContext` 兜底） | ✅ 需用户手势后才开始 | ✅ |
| 麦克风选择（`enumerateDevices`） | ✅ | ✅ | ✅ | ⚠️ 通常只有一个设备 | ✅ |
| 复制（`navigator.clipboard`） | ✅ | ✅ | ✅ | ✅ | ✅ |
| **推荐模式** | 自动 | 自动 | 自动 | 云端精准识别 | 云端精准识别 |

## 前提条件

- **必须 HTTPS**（或 `localhost`）：否则 `getUserMedia` 不可用，页面会提示。
- 页面使用了可选链、`??` 等 ES2020 语法，不支持 IE / 旧版 Edge（EdgeHTML）及 Safari < 14。

## 已知差异与风险

1. **Firefox 无内置识别**：自动模式会弹出设置并切换到云端模式，需要 OpenAI / Groq Key（已有测试）。
2. **Safari 录音格式**：只支持 `audio/mp4`，前端会用 `.m4a` 文件名上传，服务端也按 `mp4 → segment.m4a` 规范化（已有测试）。
3. **Chrome 浏览器识别需联网**：Web Speech 在 Chrome 中走 Google 服务器，离线或企业网络可能触发 `network` 错误，页面会停止录音并提示切换到云端。
4. **iOS 后台/锁屏**：页面进入后台后 `MediaRecorder` 与识别都会暂停，长时间课堂录音需保持屏幕常亮（可考虑 Wake Lock API）。
5. **6 秒切片边界**：云端模式按固定 6 秒切片，可能把一个词切成两半，影响断句（属线程 B 的优化范围）。
