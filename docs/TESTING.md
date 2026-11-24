# 测试方案

## 原则

- **零付费调用**：所有第三方请求要么被 mock，要么被测试夹具直接拦截（`tests/e2e/fixtures.ts` 中 `externalRequests` 会中止任何非 localhost 请求并记录）。
- **零真实录音**：E2E 使用 Chromium 的 `--use-fake-device-for-media-stream` 合成测试音；DOM 测试使用伪造的 `MediaRecorder` / `SpeechRecognition`。
- **假 Key**：测试中只出现 `sk-test-not-a-real-key`。
- **已知缺陷用 `it.fails` / `test.fail()` 标注**：测试会持续证明缺陷存在；修复后这些用例会“意外通过”而报错，提醒把标注去掉。

## 分层

| 层 | 工具 | 位置 | 覆盖内容 | 耗时 |
|---|---|---|---|---|
| 单元 | Vitest | `tests/unit/` | `/api/transcribe` 的登录、Key、服务商/模型白名单、文件大小、上游错误映射、Key 不泄漏到表单；`/app` 的响应头与账号信息转义；`return_to` 开放重定向防护 | < 1 s |
| DOM | Vitest + jsdom | `tests/dom/` | 加载真实 `transcript.html` + `transcript.js`：XSS 转义、说话人、语言切换、浏览器识别流程（临时/最终结果、自动重启、致命错误释放麦克风）、云端切片上传与收尾、翻译/摘要请求格式、Ollama 无 Key、设置校验、Key 不落存储、复制格式 | ~1.5 s |
| 端到端 | Playwright | `tests/e2e/` | 真实开发服务器 + 模拟登录：鉴权跳转、演示流程（假时钟）、设置弹窗、浏览器识别、云端识别 + 翻译 + 摘要（全部 mock）、麦克风测试、移动端无横向溢出 | ~15 s |
| 兼容性 | Playwright | `tests/e2e/compat.spec.ts` | 在 Chromium 中模拟 Firefox（无 Web Speech）、Safari（仅 `audio/mp4`）、两者都没有的浏览器 | 含在上面 |
| 性能 | Playwright 脚本 | `bench/render-bench.mjs` | 不同字幕行数下 `render()` 与临时字幕刷新耗时、DOM 节点数 | ~3 min |

## 运行

```bash
npm test                 # 单元 + DOM
npm run test:e2e         # 自动启动 npm run dev；已有 dev 服务器时会复用
npm run bench            # 需先在另一个终端 npm run dev；结果写入 bench/results.{md,json}

# 真实 Firefox / WebKit（需要能下载浏览器）
npx playwright install firefox webkit
E2E_ALL_BROWSERS=1 npm run test:e2e

# 针对已部署的环境（只读用例，不会产生费用）
E2E_BASE_URL=https://staging.example npm run test:e2e
```

CI（`.github/workflows/ci.yml`）在每个 PR 上运行 lint、typecheck、单元/DOM 测试、构建和 Chromium E2E，无需任何密钥。

## 脚本式浏览器测试（`npm run test:browser`）

各线程自带的 Playwright 脚本，直接加载 `transcript.html` 与 `public/*.js`，不需要 dev server：

| 脚本 | 覆盖内容 |
|---|---|
| `tests/browser-smoke.mjs` | AI 引擎接线：关闭思考、术语表、总结模型路由、行动项渲染、用量统计、英文界面 |
| `tests/browser/transcript-regression.cjs --fast` | 稳定性回归 15 项：双击、最后一句、超时、重试、401 停止、翻译不阻塞识别、并发上限、拔麦克风、长会议渲染 |
| `tests/ux/workspace-ux.e2e.mjs` | 本地历史、继续录音时间轴、搜索、星标、编辑、改名、场景、导出 Markdown/SRT、字幕模式、滚动、2000 行性能、移动端 |
| `tests/e2e/cloud-transcription.mjs` | 合成语音 + 停顿：VAD 断句、长静音不上传、识别 prompt、503 重试、幻听过滤、翻译带术语表与上文 |
| `tests/e2e/browser-recognition.mjs` | 浏览器识别：中间结果、本地补标点、已是目标语言不翻译、演示模式 |

## 集成分支结果（integration/v-next，2026-11-24）

| 套件 | 结果 |
|---|---|
| `npm run lint` / `npm run typecheck` / `npm run build` | 通过 |
| `npm test` | Vitest 57 / 57 + node:test 39 / 39 |
| `npm run test:e2e` | 24 / 24（原 3 个已知缺陷标注已移除，因为缺陷已修复） |
| `npm run test:browser` | 5 个脚本全部通过 |

集成后 `bench/results.md`：1000 行时临时字幕刷新 85 ms → 1.3 ms；1000 句会话总渲染 164.7 s → 4.6 s。

以下为线程 F 在 main 上的原始结果，保留作对比。

## 当前结果（2026-11-24）

| 套件 | 结果 |
|---|---|
| `npm run lint` | 通过 |
| `npm run typecheck` | 通过（修复了 `vite.config.ts` 中 2 个既有类型错误） |
| `npm test` | 56 / 56 通过（含 2 个已知缺陷的 `it.fails`） |
| `npm run test:e2e` | 24 / 24 通过（桌面 + 移动各 12；含 1 个已知缺陷的 `test.fail`），连续 3 轮无抖动 |
| `npm run build` | 通过，Worker 产物约 615 KiB |
| `npm start` | 生产 Worker 本地可启动，`/app` 正确重定向到登录 |

### 测试确认的缺陷

| # | 缺陷 | 影响 | 测试 |
|---|---|---|---|
| 1 | 「＋ 添加」说话人按钮的点击回调闭包引用了可变的 `speakerCount`：添加说话人 3、4 后，点「说话人 3」实际选中 4 | 3 人以上会议说话人标记错误 | `tests/dom` › speakers |
| 2 | `addLine()` 以 `config.key` 判断是否翻译，Ollama 无需 Key，因此**本地模型永远不翻译**（摘要正常） | 本地/离线模式失去双语字幕 | `tests/dom` › translates with keyless Ollama |
| 3 | `toggleRecord()` 在 `await getUserMedia()` 之后才设置 `recording`，快速双击会打开两路麦克风流，第一路泄漏且无法关闭 | 麦克风指示灯常亮、隐私风险、重复识别 | `tests/e2e` › double-clicking record |

### 性能发现

`render()` 每次（包括每个临时识别结果）都用 `innerHTML` 重建整份记录，耗时随行数线性增长（见 `bench/results.md`）：

| 已提交行数 | 临时字幕刷新中位数 |
|---:|---:|
| 100 | ~10 ms |
| 500 | ~43 ms |
| 1000 | ~85 ms |
| 5000 | ~413 ms |

1 小时会议约 600–1200 句，后半程每次字幕刷新都会超过 16.7 ms 帧预算，表现为字幕卡顿、按钮响应慢。建议：最终行增量追加、临时行单独节点更新、超长列表虚拟化。
