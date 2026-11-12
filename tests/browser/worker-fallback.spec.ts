// 用途：模拟 Obsidian 等不允许启动后台线程的环境，验证自动整理改在当前页面计算，照常出图。
import { test, expect } from '@playwright/test';

for (const [name, script] of [
  ['线程创建直接报错', () => { (window as any).Worker = class { constructor() { throw new Error('blocked by policy'); } }; }],
  ['线程创建后异步报错', () => {
    (window as any).Worker = class extends EventTarget {
      onmessage = null;
      constructor() { super(); setTimeout(() => this.dispatchEvent(new ErrorEvent('error', { message: 'blocked by CSP' })), 10); }
      postMessage() {}
      terminate() {}
    };
  }],
] as const) {
  test(`${name}时改在当前页面布局，自动整理照常出图`, async ({ page }) => {
    const warnings: string[] = [];
    page.on('console', message => { if (message.type() === 'warning') warnings.push(message.text()); });
    await page.addInitScript(script);
    await page.goto('/');
    await expect(page.getByRole('status')).toContainText('渲染完成');
    await page.getByRole('button', { name: '自动整理' }).click();
    await expect(page.locator('.mp-enhanced [data-node-id]').first()).toBeVisible();
    await expect(page.getByRole('status')).toContainText('渲染完成');
    expect(warnings.filter(w => w.includes('布局线程无法启动'))).toHaveLength(1);
  });
}
