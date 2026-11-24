import { expect, FAKE_KEY, stopSegmentAfter, test } from "./fixtures";

// Chromium-only container: emulate the API surface of other engines.

test("Firefox-like: no Web Speech API → guides the user to cloud mode", async ({ page, externalRequests }) => {
  void externalRequests;
  await page.addInitScript(() => { delete (window as any).webkitSpeechRecognition; delete (window as any).SpeechRecognition; });
  await page.goto("/app");
  await expect(page.locator("#statusSub")).toContainText("云端语音识别");
  await page.locator("#recordBtn").click();
  await expect(page.locator("#modal")).toHaveClass(/open/);
  await expect(page.locator("#speechMode")).toHaveValue("cloud");
});

test("Safari-like: only audio/mp4 is recordable → uploads .m4a", async ({ page, externalRequests }) => {
  void externalRequests;
  await page.addInitScript(() => {
    delete (window as any).webkitSpeechRecognition; delete (window as any).SpeechRecognition;
    const Original = window.MediaRecorder;
    class Mp4Recorder extends Original {
      constructor(stream: MediaStream) { super(stream); }
      get mimeType() { return "audio/mp4"; }
    }
    (Mp4Recorder as any).isTypeSupported = (type: string) => type === "audio/mp4";
    (window as any).MediaRecorder = Mp4Recorder;
  });
  const names: string[] = [];
  await page.route("**/api/transcribe", async (route) => {
    const match = /filename="([^"]+)"/.exec(route.request().postDataBuffer()?.toString("latin1") ?? "");
    names.push(match?.[1] ?? "");
    await route.fulfill({ json: { text: "ok" } });
  });
  await page.goto("/app");
  await page.locator("#settingsBtn").click();
  await page.locator("#speechKey").fill(FAKE_KEY);
  await page.locator("#saveBtn").click();
  await page.locator("#recordBtn").click();
  await expect(page.locator("#statusSub")).toContainText("约每 6 秒更新");
  await stopSegmentAfter(page, 1500);
  await expect(page.locator("#transcript .line .words").first()).toHaveText("ok");
  expect(names[0]).toBe("segment.m4a");
});

test("no MediaRecorder and no Web Speech → explains the browser is unsupported", async ({ page, externalRequests }) => {
  void externalRequests;
  await page.addInitScript(() => {
    delete (window as any).webkitSpeechRecognition; delete (window as any).SpeechRecognition; delete (window as any).MediaRecorder;
  });
  await page.goto("/app");
  await page.locator("#recordBtn").click();
  await expect(page.locator("#toast")).toContainText("无法录音");
});
