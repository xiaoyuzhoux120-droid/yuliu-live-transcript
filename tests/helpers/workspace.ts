import { readFileSync } from "node:fs";
import { JSDOM, VirtualConsole } from "jsdom";
import { vi } from "vitest";

const html = readFileSync(new URL("../../app/app/transcript.html", import.meta.url), "utf8");
// Same order as the <script> tags in transcript.html: helpers first, then the workspace.
const scripts = ["speech-core.js", "ai-engine.js", "transcript.js"].map((name) => readFileSync(new URL(`../../public/${name}`, import.meta.url), "utf8"));

export type FakeRecognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  started: number;
  onresult?: (event: unknown) => void;
  onerror?: (event: unknown) => void;
  onend?: () => void;
  emit(results: Array<{ text: string; final: boolean }>, resultIndex?: number): void;
};

export type WorkspaceOptions = {
  nativeSpeech?: boolean;
  mediaRecorder?: boolean;
  secure?: boolean;
  fetch?: typeof fetch;
};

/**
 * Boots the real workspace HTML + public/transcript.js inside jsdom with
 * fake browser media APIs. Nothing here touches a microphone or network.
 */
export function loadWorkspace(options: WorkspaceOptions = {}) {
  const { nativeSpeech = true, mediaRecorder = true, secure = true } = options;
  const errors: unknown[] = [];
  const virtualConsole = new VirtualConsole();
  virtualConsole.on("jsdomError", (error: Error) => errors.push(error));
  const dom = new JSDOM(html, { url: "https://localhost/app", runScripts: "dangerously", pretendToBeVisual: true, virtualConsole });
  const window = dom.window as unknown as Window & typeof globalThis & Record<string, unknown>;
  const recognitions: FakeRecognition[] = [];
  const tracksStopped = { count: 0 };
  const getUserMedia = vi.fn(async () => {
    const track = { kind: "audio", readyState: "live", stop: () => { tracksStopped.count += 1; }, addEventListener: () => {}, removeEventListener: () => {} };
    return { getTracks: () => [track], getAudioTracks: () => [track] };
  });

  Object.defineProperty(window, "isSecureContext", { value: secure, configurable: true });
  Object.defineProperty(window.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia, enumerateDevices: async () => [{ kind: "audioinput", deviceId: "mic-1", label: "Test Mic" }] },
  });
  Object.defineProperty(window.navigator, "clipboard", { configurable: true, value: { writeText: vi.fn(async () => {}) } });

  if (nativeSpeech) {
    window.webkitSpeechRecognition = class implements Partial<FakeRecognition> {
      lang = ""; continuous = false; interimResults = false; started = 0;
      onresult?: (event: unknown) => void; onerror?: (event: unknown) => void; onend?: () => void;
      constructor() { recognitions.push(this as unknown as FakeRecognition); }
      start() { this.started += 1; }
      stop() { this.onend?.(); }
      emit(results: Array<{ text: string; final: boolean }>, resultIndex = 0) {
        const list = results.map((r) => Object.assign([{ transcript: r.text }], { isFinal: r.final }));
        this.onresult?.({ resultIndex, results: list });
      }
    };
  }

  const recorders: Array<{ state: string; stop(): void; mimeType: string; ondataavailable?: (e: unknown) => void; onstop?: () => void }> = [];
  if (mediaRecorder) {
    (window as Record<string, unknown>).MediaRecorder = Object.assign(class {
      state = "inactive"; mimeType: string; ondataavailable?: (e: unknown) => void; onstop?: () => void; onerror?: () => void;
      constructor(_stream: unknown, opts?: { mimeType?: string }) { this.mimeType = opts?.mimeType || "audio/webm"; recorders.push(this); }
      start() { this.state = "recording"; }
      stop() {
        this.state = "inactive";
        this.ondataavailable?.({ data: new window.Blob([new Uint8Array(4096)], { type: this.mimeType }) });
        this.onstop?.();
      }
    }, { isTypeSupported: (type: string) => type.startsWith("audio/webm") });
  }

  const fetchMock = vi.fn(options.fetch ?? (async () => new window.Response(JSON.stringify({ choices: [{ message: { content: "mock" } }] }), { status: 200 })));
  window.fetch = fetchMock as unknown as typeof fetch;

  // Run as a classic <script> (like the browser does) so its top-level
  // `let`s live in the shared global lexical scope and stay reachable.
  for (const source of scripts) {
    const element = window.document.createElement("script");
    element.textContent = source;
    window.document.body.appendChild(element);
  }

  const $ = <T extends Element = HTMLElement>(selector: string) => window.document.querySelector(selector) as T | null;
  return {
    dom,
    window,
    /** Uncaught page errors (script exceptions, unhandled rejections reported by jsdom). */
    errors,
    $,
    fetchMock,
    getUserMedia,
    recognitions,
    recorders,
    tracksStopped,
    /** Evaluate an expression inside the page's script scope (reaches `let` globals). */
    run: <T = unknown>(expression: string) => window.eval(expression) as T,
    lines: () => window.eval("lines") as Array<{ time: string; text: string; translation: string; speaker: number }>,
    flush: () => new Promise((resolve) => setTimeout(resolve, 0)),
    click: (selector: string) => ($(selector) as HTMLElement).click(),
    setValue: (selector: string, value: string) => { ($(selector) as HTMLInputElement).value = value; },
  };
}
