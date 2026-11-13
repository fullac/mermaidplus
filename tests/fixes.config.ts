// 用途：独立执行修复回归，不占用其他开发者的演示服务器端口。
import { defineConfig } from '@playwright/test';
export default defineConfig({ testDir: './browser', testMatch: 'fixes.spec.ts', timeout: 60_000, workers: 1, use: { channel: 'chrome', headless: true, viewport: { width: 1440, height: 1150 } }, outputDir: '../test-results/fixes' });
