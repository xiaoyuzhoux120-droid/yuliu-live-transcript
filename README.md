# 语流 · 实时转写

一个面向中英文会议和访谈的浏览器端录音转写工具。

## 功能

- 中英文实时语音转写
- 原文与译文同步显示
- 多说话人标签与手动校正
- 会后摘要、关键结论和行动项
- 支持 DeepSeek、硅基流动、OpenRouter、Groq、Ollama
- 支持自定义 OpenAI Chat Completions 兼容接口
- API Key 仅保留在当前浏览器会话中

## 本地运行

项目是静态站点，可使用任意静态文件服务器运行：

```bash
python3 -m http.server 4173 --directory dist
```

然后访问 `http://localhost:4173`。

## 说明

实时语音识别由浏览器提供，推荐使用最新版 Chrome 或 Edge。DeepSeek 等文字模型用于翻译、润色和总结。Ollama 在浏览器中使用时，可能需要允许站点来源访问本地服务。

