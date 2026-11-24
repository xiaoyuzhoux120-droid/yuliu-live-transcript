# 发布流程与检查清单

## 部署方式

项目由 **OpenAI Sites** 托管（`.openai/hosting.json`），构建产物是一个 Cloudflare Worker（`dist/server`）加静态资源（`dist/client`）。ChatGPT 登录由托管平台在边缘注入 `oai-authenticated-*` 请求头完成，应用本身不保存会话。

可行性检查（2026-11-24，本地）：

- `npm run build` 成功，Worker 约 615 KiB（Cloudflare 免费版上限 3 MiB，余量充足）
- `npm start` 可在本地以 Wrangler 运行生产构建；`/app` → 307 登录、`/api/transcribe` 未登录 → 401、`/transcript.js` → 200
- `/api/transcribe` 单片段上限 12 MB；6 秒 opus 片段通常 < 100 KB，远低于 Worker 100 MB 请求体限制
- 未配置 D1 / R2 绑定，当前无持久化数据，回滚只需重新部署上一版本

## 分支与版本

1. 功能在独立分支开发，PR 必须通过 CI（lint、typecheck、单元/DOM 测试、构建、E2E）
2. 修改 `public/transcript.js` 时同步提升 `transcript.html` 中的 `?v=N`
3. 合并到 `main` 后由仓库所有者手动触发 Sites 部署（本仓库不包含自动部署）

## 发布前检查清单

- [ ] `npm run check` 全部通过
- [ ] `npm run test:e2e` 全部通过
- [ ] 若改动渲染逻辑：`npm run bench`，对比 `bench/results.md` 无明显退化
- [ ] 手动冒烟（真实浏览器，用自己的测试 Key、非敏感语音）：
  - [ ] Chrome：自动模式录音 → 实时字幕 → 停止 → 摘要
  - [ ] Safari 或 iOS：云端模式录音 → 字幕出现
  - [ ] Firefox：提示切换云端模式
  - [ ] 「体验演示」可用
- [ ] 确认没有提交 `.env*`、真实录音或 API Key（`git diff --stat main` 检查）
- [ ] 更新 README 中的功能说明（如有）

## 回滚

在 Sites 控制台重新部署上一个成功版本；因为没有数据迁移，回滚是无损的。
