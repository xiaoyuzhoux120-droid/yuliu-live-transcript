# 语流 · 实时转写（Yuliu Live Transcript）

面向中英文会议、课堂和访谈的浏览器端实时转写工具：实时字幕、双语对照、说话人标记、会后 AI 摘要。工作台由 ChatGPT 登录保护。

线上地址：[live-transcript.ccwu.cc](https://live-transcript.ccwu.cc)

## 功能

- **实时转写**：优先使用浏览器内置识别（Web Speech API）；不支持时可切换到云端识别（OpenAI `gpt-transcribe` / Groq Whisper）。云端模式按说话停顿自动断句（VAD），静音段不上传，过滤“谢谢观看”类幻听；临时网络错误自动重试
- **中英混合与术语表**：识别语言可选“中英混合”；术语表同时用于识别 prompt 和翻译
- **双语字幕**：原文与译文同步显示，可选中文 ⇄ English 或关闭翻译；可只看原文 / 只看译文、调字号，或进入全屏大字幕（投屏）模式
- **说话人标记**：录音时点按或按数字键切换当前说话人，事后可点标签校正、双击改名；会议 / 课堂 / 访谈场景预设
- **校对与重点**：逐句编辑（改后自动重译）、星标重点、全文搜索
- **会后总结**：结构化纪要（核心结论、关键决定、行动项含负责人与期限、待定问题），长会议分段总结，用量统计
- **本地历史与导出**：转写记录自动保存在本浏览器（可关闭），导出 Markdown / TXT / SRT
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
   - *云端精准识别*：填写 OpenAI 或 Groq 的 API Key，录音在说话停顿处切片（最长约 14 秒）经本站 `/api/transcribe` 转发给所选服务
   - （可选）*专业术语表*：每行一个术语，可写译法，如 `大模型 = LLM`
2. **（可选）连接文本模型**：选择服务商、运行模式（省钱 / 高质量）并填写 Key，用于翻译和会后摘要。Ollama 在本机运行，无需 Key，但需把 `OLLAMA_ORIGINS` 设为本站地址（不要设为 `*`）。
3. **测试麦克风**：「测试 3 秒」会录一段并可回放，确认设备有声音。
4. **开始录音**：录音中点「说话人 N」或按 1–9 切换当前发言人，按 M 标记重点，按 C 打开大字幕；结束后自动生成摘要。
5. **导出与历史**：「导出」菜单可复制全文或下载 Markdown / TXT / SRT；「最近记录」可重新打开、导出或删除本地保存的会话。

## AI 模型与运行模式

在“模型设置”中可以选择两种运行模式：

- **省钱模式**（默认）：合并多句翻译请求，关闭 DeepSeek 等模型的思考模式，跳过语气词和已是目标语言的句子。
- **高质量模式**：逐句翻译并附带上文，总结使用更强的模型（例如 `deepseek-v4-pro`）。

两种模式都支持术语表、结构化纪要（结论、决定、行动项含负责人和期限）、长会议分段总结和用量统计。详见 [docs/ai-models.md](docs/ai-models.md)。

更多浏览器差异见 [docs/BROWSER-COMPAT.md](docs/BROWSER-COMPAT.md)。

## 开发

| 命令 | 作用 |
|---|---|
| `npm run dev` | 本地开发服务器（Vite + vinext，模拟登录） |
| `npm run lint` | ESLint |
| `npm run typecheck` | TypeScript 类型检查 |
| `npm test` | 单元 + DOM 测试（Vitest + jsdom）以及 `speech-core` / `ai-engine` 纯逻辑测试（node:test） |
| `npm run test:e2e` | 端到端测试（Playwright，Chromium 桌面 + 移动，需 dev server，会自动启动） |
| `npm run test:browser` | 脚本式浏览器测试：稳定性回归、工作台 UX、云端断句、浏览器识别、AI 引擎冒烟（不需 dev server） |
| `npm run bench` | 长会议字幕渲染性能基准（需先 `npm run dev`） |
| `npm run bench:segmentation` | VAD 停顿断句 vs 固定 6 秒切片（合成 60 分钟会议） |
| `npm run bench:ai` | 文本模型请求数 / token / 费用估算（mock） |
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
| 转写记录 | 自动保存在本浏览器 localStorage（`yuliu:sessions:v1`，最多 60 条），不上传本站；可在「最近记录」关闭自动保存或一键清空。音频与 Key 从不保存 |

## 代码结构

| 文件 | 作用 |
|---|---|
| `app/app/transcript.html` | 工作台页面（由 `app/app/route.ts` 输出并加 CSP） |
| `public/transcript.js` | 工作台主逻辑：录音、识别、渲染、历史、导出 |
| `public/speech-core.js` | 纯函数：VAD 断句、幻听过滤、术语表、识别 prompt |
| `public/ai-engine.js` | 纯逻辑：模型路由、批量 / 上下文翻译、缓存、结构化总结、用量统计 |
| `app/api/transcribe/route.ts` | 云端识别代理（校验、超时、错误分级） |

详细说明：[docs/asr-translation.md](docs/asr-translation.md)、[docs/ai-models.md](docs/ai-models.md)、[docs/ux-review.md](docs/ux-review.md)。
