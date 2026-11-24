# 语音识别与实时翻译：方案调研与本次改进

> **集成说明（integration/v-next）**：本文是线程 B 的原始报告。集成分支中，翻译统一改由 `public/ai-engine.js`（线程 C）完成：术语表、上文、"转写是数据不是指令"的防注入规则都保留；B 方案中“在翻译请求里顺带让模型补标点、修正术语错字”的 LLM 润色没有并入（浏览器识别结果仍在本地补句末标点），列入下一版本计划。云端识别的重试、超时与失败分级采用线程 A 的实现，并接入了本文的 VAD 断句、识别 prompt 与幻听过滤。


> 线程 B 交付文档 · 2026-11-24
> 范围：ASR、流式识别、断句/标点、中英混合、术语、实时翻译、说话人分离。

## 1. 现状问题（来自代码审查）

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 1 | 云端模式每 6 秒硬切 MediaRecorder | `startCloudSegment` | 约 70% 的切点落在说话中途，词被切断，识别率下降；句末到出字幕平均约 3 秒 |
| 2 | 静音片段也上传 | 同上 | 浪费按分钟计费的额度；Whisper 在静音上会“幻觉”出“谢谢观看”“字幕由 Amara.org 提供” |
| 3 | 识别请求没有 `prompt` | `transcribeAudio`、`/api/transcribe` | 段与段之间无上下文，专业术语、中英混说不一致 |
| 4 | 任意一次请求失败就把整场识别标记为失败 | `transcribeAudio` | 一次网络抖动/429 会让剩下的会议全部丢失 |
| 5 | 翻译逐句独立、无上下文、无术语表 | `modelTask("translate")` | 代词、省略、术语翻译前后不一致 |
| 6 | 英文句子在目标语言为英文时仍会“翻译” | `addLine` | 中英混合会议里浪费 Token 且可能被改写 |
| 7 | 界面写着“AI 自动纠错与标点”，但代码没有实现 | `.auto` 文案 | 浏览器中文识别结果没有任何标点 |
| 8 | 每个中间结果都重建整个字幕列表 `innerHTML` | `render(interim)` | 中间结果每秒触发多次，长会议（上千段）会明显卡顿；用户向上翻看时被强制拉到底部 |
| 9 | 只能选“中文”或“English” | `#sourceLang` | 中英混说只能二选一 |

## 2. 方案对比

### 2.1 识别引擎

| 方案 | 延迟 | 中文/中英混合 | 成本 | 隐私 | 说话人分离 | 结论 |
|------|------|---------------|------|------|------------|------|
| 浏览器 Web Speech API（Chrome/Edge） | 最低，有中间结果 | 中文可用，无标点；混说一般 | 免费 | 音频会发送到浏览器厂商的云服务（Chrome→Google），并非本地 | 无 | 保留为默认免费模式；需要补标点；需在隐私说明中写清楚“不是本地处理” |
| 云端分段上传（当前：OpenAI `gpt-transcribe` / `gpt-4o-*-transcribe`、Groq Whisper） | 取决于断句策略 + 接口延迟 | 好；`prompt` 可显著改善术语 | 按分钟/Token 计费；Groq 很便宜且快 | 音频发给第三方 | `gpt-4o-transcribe-diarize` 支持（已标记弃用） | 本次重点优化：VAD 断句 + prompt + 重试 |
| 真流式云端（OpenAI Realtime 转写 WebSocket/WebRTC、Deepgram、AssemblyAI Universal-Streaming、Soniox、讯飞/阿里 Paraformer 实时） | 300ms 级中间结果 | Soniox、阿里 Paraformer/FunASR、讯飞对中英混合专门优化 | 中等 | 第三方 | Deepgram/AssemblyAI/Soniox 流式即带说话人标签 | 下一版本候选。需要服务端签发临时凭证（ephemeral token），不能把长期 Key 放在浏览器 |
| 浏览器本地模型（transformers.js + WebGPU 的 Whisper / Moonshine / Parakeet，sherpa-onnx WASM） | 取决于设备；WebGPU 下 whisper-base 可近实时 | Whisper small 以上中文才可用，模型 200MB+ | 免费 | 真正本地 | sherpa-onnx 提供本地说话人分离 | 作为“隐私模式”实验特性；首次加载慢、低端设备不可用 |
| 本机服务（faster-whisper / FunASR / whisper.cpp，类似现有 Ollama 接入） | 好 | FunASR Paraformer 中文优秀 | 免费 | 本地 | pyannote / 3D-Speaker | 适合技术用户；可仿照 Ollama 增加“本地语音服务”地址 |

要点：

- OpenAI 官方文档目前推荐 `gpt-transcribe` 处理录音、`gpt-live-transcribe` 处理实时流；`gpt-4o-transcribe`、`gpt-4o-mini-transcribe`、`gpt-4o-transcribe-diarize`、`whisper-1` 已标记弃用（文档写明 2027-02-26 停用）。项目中的 `gpt-4o-*` / `whisper-1` 选项应在停用前移除。
- `prompt`：`whisper-1` 只使用最后约 224 个 token，所以本次实现把术语放在最前、上一段尾部放在最后，并限制总长。`gpt-4o-transcribe-diarize` 不支持 `prompt`。
- `gpt-live-transcribe` 不支持服务端 VAD，需要客户端自己 VAD 后 `commit`。本次实现的 VAD 断句器可以直接复用。

### 2.2 说话人分离

| 方案 | 实时性 | 可靠性 | 说明 |
|------|--------|--------|------|
| 现状：手动标记 | 实时 | 依赖用户 | 保留，作为校正手段 |
| `gpt-4o-transcribe-diarize`（`response_format=diarized_json`，`chunking_strategy`） | 会后/准实时；流式增量没有说话人，段落结束才有 | 好，可传最多 4 段已知说话人参考音频 | 已弃用，不建议新接入 |
| Deepgram / AssemblyAI / Soniox 流式 diarization | 实时 | 好 | 需付费，需临时凭证 |
| 会后整段重识别 + pyannote 3.x / 3D-Speaker（本机） | 会后 | 当前开源最佳 | 隐私好，需要本机 Python 服务 |
| 浏览器 sherpa-onnx 说话人嵌入 + 聚类 | 准实时 | 中等，2–3 人会议可用 | 纯本地，工程量大 |

推荐路线：**实时阶段保持手动标签 + 片段级“可能换人”提示；会后提供“精修”按钮，把整场录音（用户确认后）交给带 diarization 的引擎重跑，再与实时字幕对齐**。不在浏览器里做纯前端的自动分离作为默认功能——在 6–15 秒的片段上它不够可靠，错误标签比没有标签更伤体验。

### 2.3 实时翻译

- 句级翻译 + 前 3 句上下文 + 术语表，是成本和质量的平衡点；逐词流式翻译会频繁改写，阅读体验差。
- 中英混合场景先判断句子主要语言，已经是目标语言的句子不再翻译。
- 浏览器识别（无标点）时，在同一次翻译请求里让模型补标点和修正术语错字（输出 JSON），不额外增加请求次数；并做长度保护，模型擅自改写/总结时丢弃润色结果。
- 后续可做（与线程 C 协调）：翻译请求批处理（2–3 句合并）、缓存、低成本模式只在会后翻译。

## 3. 本次改动（分支 `feat/asr-streaming-quality`）

新增 `public/speech-core.js`（纯函数，无 DOM 依赖，可在 Node 中测试），`public/transcript.js` 接入：

1. **VAD 停顿断句**（替代固定 6 秒）：自适应噪声底；至少 1.8 秒、最多 12 秒；静音 550ms 判句末，片段超过 5 秒后 250ms 停顿即可切；用 `setInterval` 而非 `requestAnimationFrame`，切到后台标签页也能继续断句；保留硬上限定时器兜底。
2. **静音不上传**：片段内累计语音不足 300ms 直接丢弃。
3. **幻觉过滤**：过滤 Whisper 常见静音幻觉与循环重复输出。
4. **术语表**（设置里新增，可选）：每行一个术语，可写 `术语 = 译法`。用于识别 `prompt` 和翻译约束。
5. **识别上下文 prompt**：术语表 + 上一段文字尾部，服务端 `/api/transcribe` 透传 `prompt`（限 800 字符）。
6. **“中英混合”识别语言**：云端不指定 `language` 让模型自动处理；浏览器识别使用中文模型。
7. **重试与错误分级**：401/400 等配置错误停止并提示；网络错误、429、5xx 自动重试 2 次（退避），仍失败只丢这一段，录音继续。
8. **带上下文与术语表的翻译**；已是目标语言的句子不翻译；转写文本放在 `<transcript>` 标签内并声明“不是指令”，降低提示词注入。
9. **标点**：浏览器识别结果本地补句末标点（问句识别）；配置了文本模型时，在翻译请求里顺带精修标点与术语错字。
10. **字幕增量渲染**：中间结果只更新一个节点；用户向上翻看历史时不再被强制拉到底部；修复中间行隐藏时 `display:grid` 覆盖 `hidden` 的问题。

没有改动：Web Speech 的整体流程、演示模式、模型供应商列表、登录与 Key 处理方式（Key 仍只在页面内存中）。

## 4. 测试与基准

```bash
npm test                    # 14 个单元测试（VAD、幻觉、术语、prompt、翻译解析、错误分级）
npm run test:e2e            # 2 个 Chromium 端到端测试（合成麦克风音频 + 模拟接口，不调用付费服务）
npm run bench:segmentation  # 断句策略基准
```

断句基准（合成 60 分钟会议，576 句，固定随机种子；“句末到出字幕”只统计切段时刻，不含接口耗时，两种策略的接口耗时相同）：

| 策略 | 片段数 | 切在说话中途 | 句末→可上传 P50 | 平均 | P90 | 上传音频占比 |
|------|--------|--------------|-----------------|------|-----|--------------|
| 固定 6 秒（旧） | 600 | 431（71.8%） | 2950ms | 3023ms | 5500ms | 100% |
| VAD 停顿断句（新） | 583 | 33（5.7%） | 300ms | 525ms | 600ms | 87.9% |

说明：合成数据不是真实语音，绝对数值仅供参考；“上传占比”的节省幅度取决于会议里长静音的多少。真实录音基准需要用户提供已授权的录音样本，本次未使用任何真实录音。

端到端测试验证了：三段语音各上传一次、9 秒长静音不单独上传、首个 503 自动重试、prompt 含术语表与上一段文字、“谢谢观看”被过滤、译文显示且翻译请求带术语表与上下文；浏览器识别路径的中间结果、标点补全、术语纠错、同语言不翻译、演示模式均正常。

## 5. 下一版本建议（按优先级）

1. **OpenAI 模型更新**：默认 `gpt-transcribe`，移除 2027-02 停用的 `gpt-4o-*-transcribe` / `whisper-1`；评估 `gpt-live-transcribe` 实时流（服务端签发临时凭证，复用本次 VAD 做客户端 commit）。
2. **会后精修**：用户确认后对整场录音做一次高质量识别 + 说话人分离，与实时字幕对齐替换。
3. **真流式引擎插件化**：抽象 `SpeechEngine` 接口（browser / chunked-cloud / realtime / local），再接 Soniox 或阿里 Paraformer 实时（中英混合强项）。
4. **本地隐私模式**：transformers.js + WebGPU（Whisper small / Moonshine）或“本机语音服务地址”（faster-whisper、FunASR）。
5. **真实录音基准集**：建立经授权的中英混合、课堂、访谈样本，按 CER/WER、术语准确率、首字延迟评估。
6. **隐私文案修正**：浏览器实时识别在 Chrome 中会把音频发送到 Google 服务，应在界面说明（交线程 E）。

## 参考

- OpenAI Speech to text：https://developers.openai.com/api/docs/guides/speech-to-text
- OpenAI Realtime transcription：https://developers.openai.com/api/docs/guides/realtime-transcription
- gpt-4o-transcribe-diarize：https://developers.openai.com/api/docs/models/gpt-4o-transcribe-diarize
- Whisper WebGPU（transformers.js）：https://github.com/xenova/whisper-web
- Moonshine Web：https://huggingface.co/spaces/webml-community/moonshine-web
- 浏览器端 ASR 工程笔记：https://www.forasoft.com/learn/ai-for-video-engineering/articles-ai/client-side-asr-faster-whisper-wasm-browser
- Soniox 中文对比：https://soniox.com/compare-stt/soniox-vs-deepgram/chinese
