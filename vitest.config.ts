import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    name: "compiler-web",
    include: ["__tests__/**/*.vitest.test.ts", "__tests__/**/*.test.ts"],
    exclude: ["**/node_modules/**", "**/dist/**", "**/.{idea,git,cache,output,temp}/**"],
  },
});
