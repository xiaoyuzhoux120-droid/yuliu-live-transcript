# 语流 · 实时转写

一个面向中英文会议和访谈的浏览器端录音转写工具，使用 ChatGPT 登录保护工作台。

线上地址：[live-transcript.ccwu.cc](https://live-transcript.ccwu.cc)

## 功能

- 使用 ChatGPT 登录后访问转写工作台
- 中英文实时语音转写
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

## 说明

实时语音识别由浏览器提供，推荐使用最新版 Chrome 或 Edge。DeepSeek 等文字模型用于翻译、润色和总结。Ollama 在浏览器中使用时，可能需要允许站点来源访问本地服务。
