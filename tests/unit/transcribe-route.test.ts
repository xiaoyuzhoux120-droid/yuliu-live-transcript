import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The route only talks to the network through global fetch, so every test
// replaces it with a mock: no real OpenAI/Groq request is ever sent.
let signedIn = true;
vi.mock("../../app/chatgpt-auth", () => ({
  getChatGPTUser: async () => (signedIn ? { userId: "u1", email: "t@example.test", displayName: "t", fullName: null } : null),
}));

const { POST } = await import("../../app/api/transcribe/route");

const FAKE_KEY = "sk-test-not-a-real-key";
const audio = (size = 2048, type = "audio/webm") => new File([new Uint8Array(size)], "x.webm", { type });

function request({ key = FAKE_KEY as string | null, provider = "openai", model = "gpt-transcribe", language = "zh", file = audio() as File | string | null } = {}) {
  const form = new FormData();
  if (provider !== null) form.append("provider", provider);
  if (model !== null) form.append("model", model);
  if (language !== null) form.append("language", language);
  if (file !== null) form.append("file", file as Blob);
  const headers: Record<string, string> = {};
  if (key !== null) headers["x-transcription-api-key"] = key;
  return new Request("http://localhost/api/transcribe", { method: "POST", headers, body: form });
}

const fetchMock = vi.fn<typeof fetch>();
beforeEach(() => {
  signedIn = true;
  fetchMock.mockReset();
  fetchMock.mockResolvedValue(Response.json({ text: "  你好 world  " }));
  vi.stubGlobal("fetch", fetchMock);
});
afterEach(() => vi.unstubAllGlobals());

describe("POST /api/transcribe — validation", () => {
  it("rejects anonymous users before touching the upstream", async () => {
    signedIn = false;
    const res = await POST(request());
    expect(res.status).toBe(401);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["missing", null],
    ["blank", "   "],
    ["oversized", "k".repeat(513)],
  ])("rejects a %s API key", async (_label, key) => {
    const res = await POST(request({ key }));
    expect(res.status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects unknown providers and models (prevents SSRF via provider)", async () => {
    expect((await POST(request({ provider: "evil" }))).status).toBe(400);
    expect((await POST(request({ provider: "groq", model: "gpt-transcribe" }))).status).toBe(400);
    expect((await POST(request({ model: "../../v1/files" }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    ["too small", audio(899)],
    ["too large", audio(12 * 1024 * 1024 + 1)],
    ["not a file", "plain text"],
  ])("rejects a %s audio segment", async (_label, file) => {
    expect((await POST(request({ file }))).status).toBe(400);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects a non-multipart body", async () => {
    const res = await POST(new Request("http://localhost/api/transcribe", {
      method: "POST", headers: { "x-transcription-api-key": FAKE_KEY, "content-type": "application/json" }, body: "{}",
    }));
    expect(res.status).toBe(400);
  });
});

describe("POST /api/transcribe — upstream proxying", () => {
  it("forwards to OpenAI with the key only in the Authorization header", async () => {
    const res = await POST(request());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ text: "你好 world" });
    expect(res.headers.get("cache-control")).toBe("private, no-store");

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/audio/transcriptions");
    expect((init!.headers as Record<string, string>).Authorization).toBe(`Bearer ${FAKE_KEY}`);
    const body = init!.body as FormData;
    expect(body.get("model")).toBe("gpt-transcribe");
    expect(body.get("language")).toBe("zh");
    expect(body.get("response_format")).toBe("json");
    expect((body.get("file") as File).name).toBe("segment.webm");
    for (const value of body.values()) expect(String(value)).not.toContain(FAKE_KEY);
  });

  it("routes Groq Whisper and normalises Safari mp4 filenames", async () => {
    await POST(request({ provider: "groq", model: "whisper-large-v3-turbo", file: audio(2048, "audio/mp4") }));
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.groq.com/openai/v1/audio/transcriptions");
    expect(((init!.body as FormData).get("file") as File).name).toBe("segment.m4a");
  });

  it("drops unsupported language hints instead of forwarding them", async () => {
    await POST(request({ language: "fr" }));
    expect((fetchMock.mock.calls[0][1]!.body as FormData).has("language")).toBe(false);
  });

  it("maps upstream 401 to 401 and other errors to 502, truncating messages", async () => {
    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "Incorrect API key" } }, { status: 401 }));
    let res = await POST(request());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "Incorrect API key" });

    fetchMock.mockResolvedValueOnce(Response.json({ error: { message: "x".repeat(1000) } }, { status: 429 }));
    res = await POST(request());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: string }).error).toHaveLength(240);
  });

  it("handles network failures, non-JSON bodies and missing text", async () => {
    fetchMock.mockRejectedValueOnce(new TypeError("fetch failed"));
    expect((await POST(request())).status).toBe(502);

    fetchMock.mockResolvedValueOnce(new Response("<html>bad gateway</html>", { status: 200 }));
    expect((await POST(request())).status).toBe(502);

    fetchMock.mockResolvedValueOnce(Response.json({ text: 42 }));
    expect((await POST(request())).status).toBe(502);
  });
});
