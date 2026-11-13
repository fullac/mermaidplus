// 用途：验证时序图也由插件的渲染器画出：背景、字号和紧凑程度设置生效，流程图专用的处理不影响时序图。
import { test, expect, type Page } from '@playwright/test';

const SOURCE = `sequenceDiagram
  participant U as 用户
  participant S as 服务端
  U->>S: 登录请求
  S-->>U: 返回令牌
  Note over U,S: 令牌有效期 2 小时
  S->>S: 记录日志`;

async function draw(page: Page, density?: string, edges?: string) {
  await page.addInitScript(([d, e]) => { if (d) (window as any).__mpDensity = d; if (e) (window as any).__mpEdges = e; }, [density, edges]);
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Mermaid 源码草稿' }).fill(SOURCE);
  await page.getByRole('button', { name: '刷新预览' }).click();
  const svg = page.locator('.mp-standard svg');
  await expect(svg).toContainText('登录请求');
  await expect(svg).toContainText('令牌有效期 2 小时');
  return svg;
}

test('时序图按插件设置渲染：近白色背景、14px 字号', async ({ page }) => {
  const svg = await draw(page);
  expect(await svg.evaluate(el => (el as SVGSVGElement).style.backgroundColor)).toBe('rgb(250, 250, 250)');
  const size = await svg.locator('text.messageText').first().evaluate(el => getComputedStyle(el).fontSize);
  expect(size).toBe('14px');
  expect(await svg.evaluate(el => (el as SVGSVGElement).dataset.mpEdges)).toBe('curved');
});

test('时序图：紧凑比宽松占地小', async ({ browser }) => {
  const size = async (density: string) => {
    const page = await browser.newPage();
    const svg = await draw(page, density);
    const box = await svg.evaluate(el => { const v = (el as SVGSVGElement).viewBox.baseVal; return { w: v.width, h: v.height }; });
    await page.close();
    return box;
  };
  const compact = await size('compact'), loose = await size('loose');
  expect(compact.w).toBeLessThan(loose.w);
  expect(compact.h).toBeLessThan(loose.h);
});
