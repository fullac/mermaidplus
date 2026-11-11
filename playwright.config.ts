// 用途：用独立 Chrome 验证样式预览交互，不连接用户浏览器或 Obsidian。
import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/browser',
  timeout: 30_000,
  workers: 1,
  use: { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1150 }, baseURL: 'http://127.0.0.1:4173' },
  webServer: { command: 'npm run demo', url: 'http://127.0.0.1:4173', reuseExistingServer: false, timeout: 60_000 },
});
