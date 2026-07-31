import { defineConfig } from "vite";

export default defineConfig({
  base: "./",
  build: {
    target: "es2022",
  },
  test: {
    exclude: ["tests/e2e/**", "node_modules/**"],
  },
});
