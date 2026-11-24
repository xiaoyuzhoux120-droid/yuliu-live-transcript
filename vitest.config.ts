import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// Standalone config: the app's vite.config.ts loads the Cloudflare/vinext
// plugins, which unit tests don't need.
export default defineConfig({
  resolve: {
    alias: { "@": fileURLToPath(new URL("./", import.meta.url)) },
  },
  test: {
    include: ["tests/unit/**/*.test.ts", "tests/dom/**/*.test.ts"],
    environment: "node",
    restoreMocks: true,
  },
});
