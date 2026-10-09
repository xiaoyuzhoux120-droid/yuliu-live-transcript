import { getChatGPTUser } from "../../chatgpt-auth";

export const dynamic = "force-dynamic";

const providers: Record<"openai" | "groq", { endpoint: string; models: Set<string> }> = {
  openai: {
    endpoint: "https://api.openai.com/v1/audio/transcriptions",
    models: new Set([
      "gpt-transcribe",
      "gpt-4o-transcribe",
      "gpt-4o-mini-transcribe",
      "whisper-1",
    ]),
  },
  groq: {
    endpoint: "https://api.groq.com/openai/v1/audio/transcriptions",
    models: new Set(["whisper-large-v3-turbo", "whisper-large-v3"]),
  },
};

export async function POST(request: Request) {
  const user = await getChatGPTUser();
  if (!user) return json({ error: "请先使用 ChatGPT 登录" }, 401);

  const apiKey = request.headers.get("x-transcription-api-key")?.trim();
  if (!apiKey || apiKey.length > 512) return json({ error: "请填写有效的语音 API Key" }, 400);

  let input: FormData;
  try {
    input = await request.formData();
  } catch {
    return json({ error: "无法读取录音数据" }, 400);
  }

  const providerName = input.get("provider");
  const model = input.get("model");
  const language = input.get("language");
  const file = input.get("file");
  if (providerName !== "openai" && providerName !== "groq") return json({ error: "不支持的语音服务" }, 400);
  if (typeof model !== "string" || !providers[providerName].models.has(model)) return json({ error: "不支持的语音模型" }, 400);
  if (!(file instanceof File) || file.size < 900 || file.size > 12 * 1024 * 1024) return json({ error: "录音片段无效或过大" }, 400);

  const outbound = new FormData();
  outbound.append("file", file, safeFilename(file));
  outbound.append("model", model);
  outbound.append("response_format", "json");
  if (language === "zh" || language === "en") outbound.append("language", language);

  let response: Response;
  try {
    response = await fetch(providers[providerName].endpoint, {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}` },
      body: outbound,
    });
  } catch {
    return json({ error: "暂时无法连接语音服务" }, 502);
  }

  const result = await response.json().catch(() => null) as { text?: unknown; error?: { message?: unknown } } | null;
  if (!response.ok) {
    const providerMessage = typeof result?.error?.message === "string" ? result.error.message : "语音服务拒绝了请求";
    return json({ error: providerMessage.slice(0, 240) }, response.status === 401 ? 401 : 502);
  }
  if (typeof result?.text !== "string") return json({ error: "语音服务没有返回文字" }, 502);

  return json({ text: result.text.trim() }, 200);
}

function safeFilename(file: File) {
  if (file.type.includes("mp4")) return "segment.m4a";
  if (file.type.includes("ogg")) return "segment.ogg";
  return "segment.webm";
}

function json(body: { error: string } | { text: string }, status: number) {
  return Response.json(body, {
    status,
    headers: {
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
    },
  });
}
