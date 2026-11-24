import { beforeEach, describe, expect, it, vi } from "vitest";

const headerStore = new Map<string, string>();
vi.mock("next/headers", () => ({
  headers: async () => ({ get: (name: string) => headerStore.get(name.toLowerCase()) ?? null }),
}));
vi.mock("next/navigation", () => ({
  redirect: (url: string) => {
    throw Object.assign(new Error("NEXT_REDIRECT"), { url });
  },
}));

const auth = await import("../../app/chatgpt-auth");

beforeEach(() => headerStore.clear());

describe("chatGPTSignInPath / chatGPTSignOutPath", () => {
  it.each([
    ["/app", "/app"],
    ["/app?x=1#y", "/app?x=1#y"],
    ["//evil.example/phish", "/"],
    ["https://evil.example", "/"],
    ["javascript:alert(1)", "/"],
    ["/\\evil.example", "/"], // WHATWG URL treats "/\" like "//"
    ["/signin-with-chatgpt", "/"],
    ["/signout-with-chatgpt?return_to=/x", "/"],
    ["/callback", "/"],
  ])("sanitises return_to %s", (input, expected) => {
    const path = auth.chatGPTSignInPath(input);
    expect(path.startsWith("/signin-with-chatgpt?return_to=")).toBe(true);
    expect(decodeURIComponent(path.split("return_to=")[1])).toBe(expected);
  });

  it("never produces an absolute or protocol-relative return target", () => {
    for (const input of ["//a", "///a", "/%2F%2Fa", "http:/a", "\\\\a"]) {
      const target = decodeURIComponent(auth.chatGPTSignOutPath(input).split("return_to=")[1]);
      expect(target.startsWith("/")).toBe(true);
      expect(target.startsWith("//")).toBe(false);
    }
  });
});

describe("getChatGPTUser", () => {
  it("returns null without the authenticated headers", async () => {
    expect(await auth.getChatGPTUser()).toBeNull();
    headerStore.set("oai-authenticated-user-id", "u1");
    expect(await auth.getChatGPTUser()).toBeNull();
  });

  it("decodes a percent-encoded full name", async () => {
    headerStore.set("oai-authenticated-user-id", "u1");
    headerStore.set("oai-authenticated-user-email", "a@example.test");
    headerStore.set("oai-authenticated-user-full-name", encodeURIComponent("张 三"));
    headerStore.set("oai-authenticated-user-full-name-encoding", "percent-encoded-utf-8");
    expect(await auth.getChatGPTUser()).toMatchObject({ displayName: "张 三", fullName: "张 三" });
  });

  it("falls back to email when the name is malformed", async () => {
    headerStore.set("oai-authenticated-user-id", "u1");
    headerStore.set("oai-authenticated-user-email", "a@example.test");
    headerStore.set("oai-authenticated-user-full-name", "%E0%A4%A");
    headerStore.set("oai-authenticated-user-full-name-encoding", "percent-encoded-utf-8");
    expect(await auth.getChatGPTUser()).toMatchObject({ displayName: "a@example.test", fullName: null });
  });

  it("requireChatGPTUser redirects anonymous users to sign-in", async () => {
    await expect(auth.requireChatGPTUser("/app")).rejects.toMatchObject({
      url: "/signin-with-chatgpt?return_to=%2Fapp",
    });
  });
});
