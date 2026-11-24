# 开发文档

## 架构概览

```
浏览器                                      Cloudflare Worker（OpenAI Sites 托管）
┌──────────────────────────────┐          ┌──────────────────────────────────┐
│ /app  → transcript.html      │  GET     │ app/app/route.ts                 │
│        + public/transcript.js│ ───────► │  requireChatGPTUser → 注入账号条  │
│                              │          │                                  │
│ Web Speech API（浏览器识别）  │          │ app/api/transcribe/route.ts      │
│ MediaRecorder 6s 切片 ───────┼─ POST ──►│  校验登录/Key/模型/大小 → 转发    │──► OpenAI / Groq
│                              │          └──────────────────────────────────┘
│ 翻译 / 摘要 fetch ───────────┼──────────────────────────────────────────────► DeepSeek / OpenRouter / Groq / Ollama …
└──────────────────────────────┘
```

| 路径 | 说明 |
|---|---|
| `app/page.tsx` | 登录落地页（React Server Component） |
| `app/app/route.ts` | 已登录用户访问 `/app` 时返回工作台 HTML，并注入转义后的账号信息 |
| `app/app/transcript.html` | 工作台静态 HTML + CSS（通过 `?raw` 内联进 Worker）。底部 `type="application/x-disabled"` 的脚本是旧版本遗留，不会执行 |
| `public/transcript.js` | 工作台全部前端逻辑：识别、切片上传、渲染、翻译、摘要、设置 |
| `app/api/transcribe/route.ts` | 语音转写代理：只允许白名单服务商与模型，片段 900 B–12 MB |
| `app/chatgpt-auth.ts` | 读取 Sites 注入的 `oai-authenticated-*` 请求头；`return_to` 防开放重定向 |
| `build/`、`scripts/` | OpenAI Sites / vinext 的构建与本地运行脚手架，一般不需要修改 |
| `examples/d1`、`db/`、`drizzle/` | 模板自带的 D1 示例，当前功能未使用 |

框架：[vinext](https://www.npmjs.com/package/vinext)（Next.js App Router API，运行在 Vite + Cloudflare Workers 上）。

## 本地环境

- Node.js ≥ 22.13
- `npm ci` 安装依赖
- `npm run dev`：开发服务器 `http://127.0.0.1:5173`，`build/sites-vite-plugin.ts` 提供模拟登录（账号 `seedy@sites.test`）
- `npm run build && npm start`：本地以 Wrangler 运行生产 Worker（`http://127.0.0.1:8787`）。生产构建**没有**模拟登录，`/app` 会 307 到 `/signin-with-chatgpt`，这是预期行为

## 代码约定

- `public/transcript.js` 是无构建步骤的经典脚本（`"use strict"`，顶层 `let` 作为状态）。测试通过把它作为 `<script>` 注入 jsdom 并用 `eval` 读取顶层变量，所以**改名或删除顶层函数/变量时需同步更新测试**。
- 所有插入 `innerHTML` 的用户/模型文本必须经过 `escapeHtml()`，`tests/dom` 中有对应的 XSS 用例。
- API Key 只能放在内存变量中，不要写入 localStorage、Cookie 或 URL；`tests/dom` 与 `tests/e2e` 均会检查。
- 修改 `public/transcript.js` 后记得把 `transcript.html` 中 `transcript.js?v=N` 的版本号 +1，以绕过浏览器缓存。

## 新增文本模型服务商

1. 在 `public/transcript.js` 的 `providers` 中添加条目（endpoint、默认模型、提示文案）
2. 在 `transcript.html` 的 `#providerGrid` 中添加对应按钮（`data-provider`）
3. 在 `tests/dom/transcript.test.ts` 的「translation & summary」分组中加一个 mock 用例

## 新增语音服务商

需要同时修改前端 `speechProviders`、`#speechProvider` 下拉框，以及服务端 `app/api/transcribe/route.ts` 中的白名单（endpoint + 允许的模型），并在 `tests/unit/transcribe-route.test.ts` 中补充用例。服务端白名单是防止被当作任意 URL 代理（SSRF）的关键，不要放开为用户可配置。
