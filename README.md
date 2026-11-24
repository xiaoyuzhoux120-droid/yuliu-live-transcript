# 语流 · 实时转写（Yuliu Live Transcript）

面向中英文会议、课堂和访谈的浏览器端实时转写工具：实时字幕、双语对照、说话人标记、会后 AI 摘要。工作台由 ChatGPT 登录保护。

线上地址：[live-transcript.ccwu.cc](https://live-transcript.ccwu.cc)

## 功能

- **实时转写**：优先使用浏览器内置识别（Web Speech API）；不支持时可切换到云端识别（OpenAI `gpt-transcribe` / Groq Whisper），云端模式约每 6 秒更新一次字幕
- **双语字幕**：原文与译文同步显示，可选中文 ⇄ English 或关闭翻译
- **说话人标记**：录音时点按切换当前说话人，事后可点标签校正
- **会后总结**：摘要、关键结论、行动项
- **文本模型**：DeepSeek、硅基流动、OpenRouter、Groq、Ollama（本地），以及任意 OpenAI Chat Completions 兼容接口
- **隐私**：API Key 只保存在当前页面内存中，不写入 localStorage / Cookie / 服务器，刷新即清除

## 快速开始

需要 Node.js 22.13+。

```bash
npm ci
npm run dev          # http://127.0.0.1:5173 ，开发环境自带模拟 ChatGPT 登录
```

打开 `/app` 进入工作台，点「体验演示」无需麦克风和 API Key 即可看到完整流程。

## 使用指南

1. **选择识别方式**（右上角「模型设置」）
   - *自动选择*：浏览器支持实时识别就用浏览器，否则要求填写云端语音 Key
   - *浏览器实时识别*：Chrome / Edge / Safari 可用，延迟最低，免费；Chrome 会把音频发送到 Google 的识别服务
   - *云端精准识别*：填写 OpenAI 或 Groq 的 API Key，录音按 6 秒切片经本站 `/api/transcribe` 转发给所选服务
2. **（可选）连接文本模型**：选择服务商并填写 Key，用于逐句翻译和会后摘要。Ollama 在本机运行，无需 Key，但需设置 `OLLAMA_ORIGINS` 允许本站来源。
3. **测试麦克风**：「测试 3 秒」会录一段并可回放，确认设备有声音。
4. **开始录音**：录音中点「说话人 N」切换当前发言人；结束后自动生成摘要。
5. **导出**：「复制」按钮会以「说话人 N：原文 / 译文」格式复制全文。

更多浏览器差异见 [docs/BROWSER-COMPAT.md](docs/BROWSER-COMPAT.md)。

## 开发

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发服务器（Vite + vinext，模拟登录） |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 单元测试 + DOM 测试（Vitest + jsdom，约 2 秒） |
| `npm run test:e2e` | 端到端测试（Playwright，Chromium 桌面 + 移动） |
| `npm run bench` | 长会议字幕渲染性能基准（需先 `npm run dev`） |
| `npm run build` | 构建 Cloudflare Worker 产物到 `dist/` |
| `npm start` | 用 Wrangler 在本地运行生产构建（`127.0.0.1:8787`） |
| `npm run check` | lint + typecheck + test + build，一次跑完 |

所有测试都**不会**调用付费 API、不会使用真实录音：外部请求被拦截或 mock，麦克风使用 Chromium 的合成测试音。

- 开发文档：[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- 测试方案：[docs/TESTING.md](docs/TESTING.md)
- 发布检查清单：[docs/RELEASE.md](docs/RELEASE.md)

## 数据边界

| 数据 | 去向 |
|---|---|
| 浏览器识别的音频 | 由浏览器厂商的识别服务处理（Chrome → Google；Safari → Apple / 本机） |
| 云端识别的音频切片 | 浏览器 → 本站 `/api/transcribe`（只转发、不存储）→ OpenAI 或 Groq |
| 语音 API Key | 每个请求通过 `x-transcription-api-key` 请求头发给本站代理，再作为 `Authorization` 转发；不落盘 |
| 文本模型 Key 与转写文字 | 浏览器直接发送到你选择的文本模型接口，不经过本站 |
| 转写记录 | 只在当前页面内存中，刷新即丢失（暂无历史记录） |
