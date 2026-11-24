import { describe, expect, it, vi } from "vitest";
import { loadWorkspace } from "../helpers/workspace";

const FAKE_KEY = "sk-test-not-a-real-key";

describe("workspace boot", () => {
  it("loads without errors and shows the ready state", () => {
    const ws = loadWorkspace();
    expect(ws.$("#statusText")?.textContent).toBe("准备就绪");
    expect(ws.$("#recordLabel")?.textContent).toBe("开始录音");
    expect(ws.$("#providerBadge")?.textContent).toBe("模型设置");
    expect(ws.errors).toEqual([]);
  });

  it("asks for cloud setup when the browser has no Web Speech API (Firefox)", () => {
    const ws = loadWorkspace({ nativeSpeech: false });
    expect(ws.$("#statusSub")?.textContent).toContain("云端语音识别");
  });

  it("refuses to record on an insecure origin", async () => {
    const ws = loadWorkspace({ secure: false });
    ws.click("#recordBtn");
    await ws.flush();
    expect(ws.getUserMedia).not.toHaveBeenCalled();
    expect(ws.$("#toast")?.textContent).toContain("HTTPS");
  });
});

describe("rendering and XSS safety", () => {
  it("escapes recognised text and translations", async () => {
    const ws = loadWorkspace();
    await ws.run(`addLine('<img src=x onerror=alert(1)>', '<b>t</b>', 1, '00:01')`);
    const html = ws.$("#transcript")!.innerHTML;
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(ws.$("#transcript .translation")?.textContent).toBe("<b>t</b>");
  });

  it("ignores blank results", async () => {
    const ws = loadWorkspace();
    await ws.run(`addLine('   ')`);
    expect(ws.lines()).toHaveLength(0);
  });

  it("cycles a line's speaker through the configured speakers", async () => {
    const ws = loadWorkspace();
    await ws.run(`addLine('hello', 'x', 2, '00:00')`);
    // Click the badge like a user (works with inline onclick or delegation).
    const badge = () => ws.$("#transcript .line .speaker-badge") as HTMLElement;
    badge().click();
    expect(ws.lines()[0].speaker).toBe(1);
    badge().click();
    expect(ws.lines()[0].speaker).toBe(2);
  });

  it("toggles UI language without losing transcript content", async () => {
    const ws = loadWorkspace();
    await ws.run(`addLine('你好', 'Hello', 1, '00:00')`);
    ws.click("#uiLangBtn");
    expect(ws.window.document.documentElement.lang).toBe("en");
    expect(ws.$(".speaker-badge")?.textContent).toBe("Speaker 1");
    expect(ws.$(".words")?.textContent).toBe("你好");
  });
});

describe("speakers", () => {
  it("adds speakers and selects the new one", () => {
    const ws = loadWorkspace();
    ws.click("#addSpeaker");
    expect(ws.run("activeSpeaker")).toBe(3);
    expect(ws.window.document.querySelectorAll("[data-speaker]")).toHaveLength(3);
  });

  // KNOWN BUG (reported to thread A): the handler closes over the mutable
  // `speakerCount`, so after adding speakers 3 and 4, clicking "说话人 3"
  // selects speaker 4. Flip to `it` once fixed.
  it.fails("selects the right speaker after adding several", () => {
    const ws = loadWorkspace();
    ws.click("#addSpeaker");
    ws.click("#addSpeaker");
    (ws.window.document.querySelector('[data-speaker="3"]') as HTMLElement).click();
    expect(ws.run("activeSpeaker")).toBe(3);
  });
});

describe("browser (Web Speech) recognition", () => {
  it("streams interim text and commits final results", async () => {
    const ws = loadWorkspace();
    await ws.startRecording();
    expect(ws.run("recognitionMode")).toBe("browser");
    const rec = ws.recognitions[0];
    expect(rec.lang).toBe("zh-CN");
    expect(rec.started).toBe(1);

    rec.emit([{ text: "我们今天", final: false }]);
    expect(ws.$("#transcript .interim .words")?.textContent).toBe("我们今天");
    rec.emit([{ text: "我们今天开会。", final: true }]);
    expect(ws.lines().map((l) => l.text)).toEqual(["我们今天开会。"]);
    expect(ws.$("#transcript .interim")).toBeNull();
  });

  it("restarts recognition when the browser ends the session mid-recording", async () => {
    const ws = loadWorkspace();
    await ws.startRecording();
    ws.recognitions[0].onend?.();
    // Restart may be deferred briefly to avoid a hot loop.
    await vi.waitFor(() => expect(ws.recognitions[0].started).toBe(2));
  });

  it("stops recording and releases the microphone on a fatal error", async () => {
    const ws = loadWorkspace();
    await ws.startRecording();
    ws.recognitions[0].onerror?.({ error: "not-allowed" });
    await vi.waitFor(() => expect(ws.run("recording")).toBe(false));
    await vi.waitFor(() => expect(ws.tracksStopped.count).toBe(1));
  });

  it("ignores benign no-speech errors", async () => {
    const ws = loadWorkspace();
    await ws.startRecording();
    ws.recognitions[0].onerror?.({ error: "no-speech" });
    expect(ws.run("recording")).toBe(true);
  });
});

describe("cloud recognition (mocked /api/transcribe)", () => {
  function cloudWorkspace(fetchImpl?: typeof fetch) {
    const ws = loadWorkspace({
      nativeSpeech: false,
      fetch: fetchImpl ?? (async (url) => new Response(JSON.stringify(String(url).includes("/api/transcribe") ? { text: "segment text" } : {}), { status: 200 })),
    });
    ws.setValue("#speechMode", "cloud");
    ws.setValue("#speechKey", FAKE_KEY);
    ws.click("#saveBtn");
    return ws;
  }

  it("requires a speech key before recording", async () => {
    const ws = loadWorkspace({ nativeSpeech: false });
    ws.click("#recordBtn");
    await ws.flush();
    expect(ws.getUserMedia).not.toHaveBeenCalled();
    expect(ws.$("#modal")?.classList.contains("open")).toBe(true);
  });

  it("uploads each segment to the same-origin proxy with the key in a header", async () => {
    const ws = cloudWorkspace();
    await ws.startRecording();
    expect(ws.run("recognitionMode")).toBe("cloud");
    ws.recorders[0].stop(); // simulate the 6s segment boundary
    await vi.waitFor(() => expect(ws.lines()).toHaveLength(1));
    const [url, init] = ws.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("/api/transcribe");
    expect((init.headers as Record<string, string>)["x-transcription-api-key"]).toBe(FAKE_KEY);
    const form = init.body as FormData;
    expect(form.get("provider")).toBe("openai");
    expect(form.get("language")).toBe("zh");
    expect([...form.values()].some((v) => String(v).includes(FAKE_KEY))).toBe(false);
    expect(ws.recorders).toHaveLength(2); // next segment started immediately
  });

  it("drains the final segment on stop and then releases the mic", async () => {
    const ws = cloudWorkspace();
    await ws.startRecording();
    await ws.run("stopRecording()");
    expect(ws.lines()).toHaveLength(1);
    expect(ws.tracksStopped.count).toBe(1);
    expect(ws.$("#statusText")?.textContent).toBe("转写已完成");
  });

  it("surfaces upstream errors and stops uploading further segments", async () => {
    const ws = cloudWorkspace(async () => new Response(JSON.stringify({ error: "Incorrect API key" }), { status: 401 }));
    await ws.startRecording();
    ws.recorders[0].stop();
    await vi.waitFor(() => expect(ws.$("#statusSub")?.textContent).toBe("Incorrect API key"));
    ws.recorders[1].stop();
    await ws.flush();
    expect(ws.fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("translation & summary model calls (mocked)", () => {
  function withTextModel(provider: string, key = FAKE_KEY) {
    const ws = loadWorkspace({
      fetch: async (_url, init) => {
        const body = JSON.parse(String(init?.body));
        const isSummary = body.messages[1].content.startsWith("总结");
        return new Response(JSON.stringify({ choices: [{ message: { content: isSummary ? "摘要：发布计划确认" : " Hello " } }] }), { status: 200 });
      },
    });
    (ws.window.document.querySelector(`[data-provider="${provider}"]`) as HTMLElement).click();
    ws.setValue("#apiKey", key);
    ws.click("#saveBtn");
    return ws;
  }

  it("translates each committed line via the configured endpoint", async () => {
    const ws = withTextModel("deepseek");
    await ws.run(`addLine('你好', '', 1, '00:00')`);
    expect(ws.lines()[0].translation).toBe("Hello");
    const [url, init] = ws.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.deepseek.com/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    expect(JSON.parse(String(init.body))).toMatchObject({ model: "deepseek-flash", temperature: 0.2 });
  });

  it("skips translation when target language is off", async () => {
    const ws = withTextModel("deepseek");
    ws.setValue("#targetLang", "off");
    await ws.run(`addLine('你好', '', 1, '00:00')`);
    expect(ws.fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the original transcript when the model call fails", async () => {
    const ws = loadWorkspace({ fetch: async () => new Response("nope", { status: 500 }) });
    ws.setValue("#apiKey", FAKE_KEY);
    ws.click("#saveBtn");
    await ws.run(`addLine('你好', '', 1, '00:00')`);
    expect(ws.lines()[0]).toMatchObject({ text: "你好", translation: "" });
    expect(ws.$("#toast")?.textContent).toContain("已保留原始转写");
  });

  it("generates a summary after recording stops", async () => {
    const ws = withTextModel("deepseek");
    ws.run(`recording = true; recognitionMode = 'demo'`);
    await ws.run(`addLine('我们确认发布计划', 'x', 1, '00:00')`);
    await ws.run("stopRecording()");
    expect(ws.$("#summaryTitle")?.textContent).toBe("本次会话摘要");
    expect(ws.$("#summaryText")?.textContent).toBe("摘要：发布计划确认");
    expect(ws.$("#chips")?.textContent).toContain("1 位说话人");
  });

  it("does not send an Authorization header to keyless Ollama", async () => {
    const ws = withTextModel("ollama", "");
    ws.run(`recording = true; recognitionMode = 'demo'`);
    await ws.run(`addLine('hi', 'x', 1, '00:00')`);
    await ws.run("stopRecording()");
    const [url, init] = ws.fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("http://localhost:11434/v1/chat/completions");
    expect((init.headers as Record<string, string>).Authorization).toBeUndefined();
  });

  // KNOWN BUG (reported to thread A/C): addLine() gates translation on
  // `config.key`, so keyless Ollama summarises but never translates.
  it.fails("translates with keyless Ollama", async () => {
    const ws = withTextModel("ollama", "");
    await ws.run(`addLine('你好', '', 1, '00:00')`);
    expect(ws.lines()[0].translation).toBe("Hello");
  });
});

describe("settings validation", () => {
  it("requires a speech key when cloud mode is chosen", () => {
    const ws = loadWorkspace();
    ws.setValue("#speechMode", "cloud");
    ws.click("#saveBtn");
    expect(ws.$("#modal")?.classList.contains("open")).toBe(false); // modal was never opened
    expect(ws.$("#toast")?.textContent).toContain("语音 API Key");
  });

  it("never persists keys to web storage", () => {
    const ws = loadWorkspace();
    ws.setValue("#speechKey", FAKE_KEY);
    ws.setValue("#apiKey", FAKE_KEY);
    ws.click("#saveBtn");
    const storage = JSON.stringify({ ...ws.window.localStorage }) + JSON.stringify({ ...ws.window.sessionStorage }) + ws.window.document.cookie;
    expect(storage).not.toContain(FAKE_KEY);
  });

  it("copies transcript with speaker labels and translations", async () => {
    const ws = loadWorkspace();
    await ws.run(`addLine('你好', 'Hello', 2, '00:00')`);
    ws.click("#copyBtn");
    await ws.flush();
    expect((ws.window.navigator.clipboard.writeText as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("说话人 2：你好\nHello");
  });
});
