import { expect, FAKE_KEY, fakeSpeechRecognition, stopSegmentAfter, test } from "./fixtures";

test.describe("auth gate", () => {
  test("/app redirects anonymous users to sign-in and back", async ({ page }) => {
    const response = await page.goto("/app");
    expect(response?.url()).toMatch(/\/app$/);
    expect(response?.headers()["cache-control"]).toBe("private, no-store");
    await expect(page.locator(".account-pill")).toBeVisible();
  });

  test("/api/transcribe rejects requests without a session", async ({ request }) => {
    const res = await request.post("/api/transcribe", { headers: { cookie: "" } });
    expect(res.status()).toBe(401);
  });
});

test("demo produces bilingual captions and a summary placeholder", async ({ workspace: page }) => {
  await page.clock.install();
  await page.locator("#demoBtn").click();
  await expect(page.locator("#statusText")).toHaveText("正在聆听");
  await page.clock.runFor(1400 * 4);
  await expect(page.locator("#transcript .line")).toHaveCount(3);
  await expect(page.locator("#transcript .translation").first()).toContainText("release plan");
  await expect(page.locator("#statusText")).toHaveText("转写已完成");
  await expect(page.locator("#summaryText")).toContainText("连接 DeepSeek");
  await expect(page.locator("#chips")).toContainText("2 位说话人");
});

test("settings modal opens, validates and closes", async ({ workspace: page }) => {
  await page.locator("#settingsBtn").click();
  await expect(page.locator("#modal")).toHaveClass(/open/);
  await page.locator("#speechMode").selectOption("cloud");
  await page.locator("#saveBtn").click();
  await expect(page.locator("#toast")).toContainText("语音 API Key");
  await page.locator("#speechKey").fill(FAKE_KEY);
  await page.locator("#saveBtn").click();
  await expect(page.locator("#modal")).not.toHaveClass(/open/);
  await expect(page.locator("#providerBadge")).toHaveText("OpenAI");
  // Keys must not end up in storage or cookies.
  const persisted = await page.evaluate(() => JSON.stringify(localStorage) + JSON.stringify(sessionStorage) + document.cookie);
  expect(persisted).not.toContain(FAKE_KEY);
});

test("browser recognition streams interim and final captions", async ({ page, externalRequests }) => {
  void externalRequests;
  await page.addInitScript(fakeSpeechRecognition);
  await page.goto("/app");
  await page.locator("#recordBtn").click();
  await expect(page.locator("#statusText")).toHaveText("正在聆听");
  await page.evaluate(() => (window as any).__recognitions[0].emit("今天我们讨论", false));
  await expect(page.locator("#transcript .interim .words")).toHaveText("今天我们讨论");
  await page.evaluate(() => (window as any).__recognitions[0].emit("今天我们讨论 Q4 roadmap。", true));
  await expect(page.locator("#transcript .line:not(.interim) .words")).toHaveText("今天我们讨论 Q4 roadmap。");
  await page.locator("#recordBtn").click();
  await expect(page.locator("#statusText")).toHaveText("转写已完成");
});

test("cloud recognition uploads segments and renders mocked text", async ({ page, externalRequests }) => {
  await page.addInitScript(() => { delete (window as any).webkitSpeechRecognition; delete (window as any).SpeechRecognition; });
  const uploads: { key: string | null; type: string | null }[] = [];
  await page.route("**/api/transcribe", async (route) => {
    uploads.push({ key: route.request().headers()["x-transcription-api-key"] ?? null, type: route.request().headers()["content-type"] ?? null });
    await route.fulfill({ json: { text: `片段 ${uploads.length}` } });
  });
  let translateCalls = 0;
  await page.route("https://api.deepseek.com/**", async (route) => {
    translateCalls += 1;
    const body = route.request().postDataJSON();
    const isSummary = body.messages[0].content.includes("会议纪要"); // ai-engine.js summary prompt
    await route.fulfill({ json: { choices: [{ message: { content: isSummary ? "摘要（mock）" : `Segment ${translateCalls}` } }] } });
  });
  await page.goto("/app");
  await page.locator("#settingsBtn").click();
  await page.locator("#speechMode").selectOption("cloud");
  await page.locator("#speechKey").fill(FAKE_KEY);
  await page.locator("#apiKey").fill(FAKE_KEY);
  await page.locator("#saveBtn").click();

  await page.locator("#recordBtn").click();
  await expect(page.locator("#statusSub")).toContainText("按说话停顿自动断句");
  // Force a segment boundary instead of waiting for a pause or the max segment length.
  await stopSegmentAfter(page, 1500);
  await expect(page.locator("#transcript .line .words").first()).toHaveText("片段 1");
  await page.locator("#recordBtn").click();
  await expect(page.locator("#summaryText")).toHaveText("摘要（mock）");

  expect(uploads.length).toBeGreaterThanOrEqual(1); // final segment may be <900B and skipped
  expect(uploads[0].key).toBe(FAKE_KEY);
  expect(uploads[0].type).toContain("multipart/form-data");
  expect(externalRequests).toEqual([]);
});

test("mic test reports detected audio from the fake device", async ({ workspace: page }) => {
  await page.locator("#settingsBtn").click().catch(() => {});
  await page.locator("#cancelBtn").click().catch(() => {});
  const button = page.locator("#testMicBtn");
  test.skip(!(await button.isVisible()), "mic bar hidden on this layout");
  await button.click();
  await expect(page.locator("#micResult")).toHaveClass(/ok|warn/, { timeout: 8000 });
});

test("no horizontal overflow at the current viewport", async ({ workspace: page }) => {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  expect(overflow).toBeLessThanOrEqual(0);
});

// Regression: `recording` used to be set only after the getUserMedia() await,
// so a fast double-click started two sessions and leaked the first mic stream.
test("double-clicking record starts a single session", async ({ page, externalRequests }) => {
  void externalRequests;
  await page.addInitScript(fakeSpeechRecognition);
  await page.goto("/app");
  await page.locator("#recordBtn").dblclick();
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__recognitions.length)).toBe(1);
});
