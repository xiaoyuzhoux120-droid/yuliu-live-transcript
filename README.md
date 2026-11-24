# 语流 · 实时转写

一个面向中英文会议和访谈的浏览器端录音转写工具，使用 ChatGPT 登录保护工作台。

线上地址：[live-transcript.ccwu.cc](https://live-transcript.ccwu.cc)

## 功能

- 使用 ChatGPT 登录后访问转写工作台
- 中英文实时语音转写：优先使用浏览器识别，也可切换 OpenAI `gpt-transcribe` 或 Groq Whisper
- 原文与译文同步显示
- 多说话人标签与手动校正
- 会后摘要、关键结论和行动项
- 支持 DeepSeek、硅基流动、OpenRouter、Groq、Ollama
- 支持自定义 OpenAI Chat Completions 兼容接口
- API Key 仅保留在当前浏览器页面中，不写入仓库

## 本地运行

需要 Node.js 22.13 或更高版本：

```bash
npm ci
npm run dev
```

然后访问终端显示的本地地址。开发环境提供模拟 ChatGPT 登录；生产环境的登录由 OpenAI Sites 托管。

## 构建

```bash
npm run lint
npm run build
```

## AI 模型与运行模式

在“模型设置”中可以选择两种运行模式：

- **省钱模式**（默认）：合并多句翻译请求，关闭 DeepSeek 等模型的思考模式，跳过语气词和已是目标语言的句子。
- **高质量模式**：逐句翻译并附带上文，总结使用更强的模型（例如 `deepseek-v4-pro`）。

两种模式都支持术语表、结构化纪要（结论、决定、行动项含负责人和期限）、长会议分段总结和用量统计。详见 [docs/ai-models.md](docs/ai-models.md)。

## 测试

```bash
npm test             # 单元测试（mock，不调用任何付费 API）
npm run bench:ai     # 文本模型成本基准
```

## 说明

浏览器不支持原生实时识别时，可以在“模型设置”中使用 OpenAI 或 Groq 的语音转写 API；云端模式约每 6 秒更新字幕。DeepSeek 等文字模型用于翻译、润色和总结。Ollama 在浏览器中使用时，可能需要允许站点来源访问本地服务。
