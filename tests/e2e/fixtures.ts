import { test as base, expect, type Page } from "@playwright/test";

export const FAKE_KEY = "sk-test-not-a-real-key";

/** Installs a scriptable fake Web Speech API before the page loads. */
export const fakeSpeechRecognition = () => {
  class FakeRecognition {
    lang = ""; continuous = false; interimResults = false;
    onresult: ((e: unknown) => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    onend: (() => void) | null = null;
    constructor() { (window as unknown as { __recognitions: FakeRecognition[] }).__recognitions.push(this); }
    start() {}
    stop() { this.onend?.(); }
    emit(text: string, final: boolean) {
      const result = Object.assign([{ transcript: text }], { isFinal: final });
      this.onresult?.({ resultIndex: 0, results: [result] });
    }
  }
  (window as unknown as { __recognitions: unknown[] }).__recognitions = [];
  (window as unknown as { webkitSpeechRecognition: unknown }).webkitSpeechRecognition = FakeRecognition;
  delete (window as unknown as { SpeechRecognition?: unknown }).SpeechRecognition;
};

/**
 * Ends the current cloud segment early (instead of waiting the 6s window).
 * Segments under 900 bytes are dropped by the app, so record a little first.
 */
export async function stopSegmentAfter(page: Page, ms: number) {
  await page.waitForTimeout(ms);
  await page.evaluate(() => (window as unknown as { eval(code: string): unknown }).eval("mediaRecorder.stop()"));
}

type Fixtures = { workspace: Page; externalRequests: string[] };

export const test = base.extend<Fixtures>({
  // Safety net: any request that leaves localhost and isn't explicitly mocked
  // by a test is aborted and recorded, so a paid API can never be hit.
  externalRequests: async ({ context }, use) => {
    const blocked: string[] = [];
    await context.route(/^https?:\/\/(?!localhost|127\.0\.0\.1)/, (route) => {
      blocked.push(route.request().url());
      return route.abort("blockedbyclient");
    });
    await use(blocked);
  },
  workspace: async ({ page, externalRequests }, use) => {
    void externalRequests;
    const errors: string[] = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await page.goto("/app"); // dev mock sign-in redirects back here
    await expect(page.locator("#recordBtn")).toBeVisible();
    await use(page);
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

export { expect };
