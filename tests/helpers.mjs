// 测试辅助：加载浏览器脚本到 Node，并提供可脚本化的 mock fetch。
import { readFile } from "node:fs/promises";
import vm from "node:vm";

export async function loadEngine() {
  const source = await readFile(new URL("../public/ai-engine.js", import.meta.url), "utf8");
  // 在当前上下文执行（与浏览器中作为普通 <script> 加载一致），脚本会挂载 globalThis.YuliuAI。
  vm.runInThisContext(source, { filename: "public/ai-engine.js" });
  return globalThis.YuliuAI;
}

/**
 * @param {Array|Function} script 依次返回的响应，或根据请求计算响应的函数。
 *   响应形如 { status?: number, headers?: object, body?: object }
 */
export function mockFetch(script) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    const spec = typeof script === "function" ? script(url, init) : script[calls.length - 1];
    if (!spec) throw new Error(`unexpected request #${calls.length}`);
    const status = spec.status ?? 200;
    const headers = new Map(Object.entries(spec.headers || {}));
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (name) => headers.get(name.toLowerCase()) ?? null },
      json: async () => spec.body ?? {},
    };
  };
  fetch.calls = calls;
  return fetch;
}
