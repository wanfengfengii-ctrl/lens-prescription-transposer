import { defineConfig } from "@playwright/test";

// Docker 验收时通过 WEB_URL 指向 nginx 服务；本地默认起 vite preview
const baseURL = process.env.WEB_URL || "http://localhost:4173";

export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? "line" : "list",
  use: {
    baseURL,
    // 容器内以 root 运行 Chromium 需要关闭沙箱
    launchOptions: process.env.CI ? { args: ["--no-sandbox"] } : {},
  },
  webServer: process.env.WEB_URL
    ? undefined
    : {
        command: "npm run build && npm run preview",
        url: "http://localhost:4173",
        reuseExistingServer: !process.env.CI,
        timeout: 180_000,
      },
});
