import { describe, expect, it, vi } from "vitest";

let user = { userId: "u1", email: "a@example.test", displayName: "Alice", fullName: "Alice" };
vi.mock("../../app/chatgpt-auth", () => ({
  requireChatGPTUser: async () => user,
  chatGPTSignOutPath: () => "/signout-with-chatgpt?return_to=%2F",
}));
vi.mock("../../app/app/transcript.html?raw", async () => {
  const { readFileSync } = await import("node:fs");
  return { default: readFileSync(new URL("../../app/app/transcript.html", import.meta.url), "utf8") };
});

const { GET } = await import("../../app/app/route");

describe("GET /app", () => {
  it("serves the workspace with private, non-cacheable headers", async () => {
    const res = await GET();
    expect(res.headers.get("content-type")).toContain("text/html");
    expect(res.headers.get("cache-control")).toBe("private, no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain('<script src="/transcript.js');
    expect(html).toContain("account-pill");
    expect(html.indexOf("account-pill")).toBeLessThan(html.lastIndexOf("</body>"));
  });

  it("HTML-escapes the signed-in user's name and email", async () => {
    user = { ...user, displayName: '<img src=x onerror="alert(1)">', email: "\"'><script>@x.test" };
    const html = await (await GET()).text();
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>@x.test");
    expect(html).toContain("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });
});
