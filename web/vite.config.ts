import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";

// 本地开发 / 预览时把 /api 代理到后端；Docker 中由 nginx 反代
const apiTarget =
  process.env.API_URL || `http://localhost:${process.env.API_PORT || 8000}`;

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  preview: {
    port: 4173,
    strictPort: true,
    proxy: {
      "/api": { target: apiTarget, changeOrigin: true },
    },
  },
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
