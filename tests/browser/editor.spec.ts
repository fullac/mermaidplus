// 用途：在演示页的内存“笔记”上验证可视化编辑：点选改字、增删节点与连线、撤销重做、冲突保护和退出。
import { test, expect, type Page } from '@playwright/test';
import { parseFlowchart } from '../../src/flowchart';

const editor = (page: Page) => page.getByRole('group', { name: 'Mermaid 可视化编辑' });
const sourceText = (page: Page) => page.getByLabel('当前源码').textContent().then(text => text ?? '');
const chart = async (page: Page) => parseFlowchart(await sourceText(page));
const nodeCount = (page: Page) => editor(page).locator('[data-node-id]');
const status = (page: Page) => editor(page).getByRole('status');
const ready = (page: Page) => expect(status(page)).toContainText('单击选中');
const edges = (page: Page) => editor(page).locator('path[data-edge-index]:not(.mp-edge-hit)');
const center = async (page: Page, selector: string) => {
  const b = (await editor(page).locator(selector).first().boundingBox())!;
  return { x: b.x + b.width / 2, y: b.y + b.height / 2 };
};
/** 从选中节点的连接点拖到某个位置松开。 */
async function dragHandle(page: Page, side: string, to: { x: number; y: number }) {
  const from = await center(page, `.mp-handle-${side}`);
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move((from.x + to.x) / 2, (from.y + to.y) / 2, { steps: 4 });
  await page.mouse.move(to.x, to.y, { steps: 4 });
  await page.mouse.up();
}

test.beforeEach(async ({ page }) => {
  await page.goto('/#editor');
  await expect(nodeCount(page)).toHaveCount(9);
  await ready(page);
});

test('双击节点改文字，Enter 保存并写回 <br/>，只改一行', async ({ page }) => {
  const before = await sourceText(page);
  await editor(page).locator('[data-node-id="OG"]').dblclick();
  const box = page.getByRole('textbox', { name: '节点文字' });
  await expect(box).toHaveValue('Orchestrator Gateway\nFA 请求入口与路由');
  await box.fill('网关');
  await box.press('Shift+Enter');
  await box.pressSequentially('第二行');
  await box.press('Enter');
  await expect(editor(page).locator('[data-node-id="OG"]')).toContainText('网关');
  await expect(editor(page).locator('[data-node-id="OG"]')).toContainText('第二行');
  const after = await sourceText(page);
  expect(after).toContain('OG["网关<br/>第二行"]');
  const changed = after.split('\n').filter((line, i) => line !== before.split('\n')[i]);
  expect(changed).toHaveLength(1);
});

test('Esc 取消改字，不写入', async ({ page }) => {
  const before = await sourceText(page);
  await editor(page).locator('[data-node-id="MA"]').dblclick();
  await page.getByRole('textbox', { name: '节点文字' }).fill('不要保存');
  await page.getByRole('textbox', { name: '节点文字' }).press('Escape');
  await expect(page.getByRole('textbox', { name: '节点文字' })).toHaveCount(0);
  expect(await sourceText(page)).toBe(before);
});

test('选中节点后新增节点：自动连线、进入改字，放在同一子图', async ({ page }) => {
  await editor(page).locator('[data-node-id="FA2_SIMPLE"]').click();
  await editor(page).getByRole('button', { name: '新增节点' }).click();
  const box = page.getByRole('textbox', { name: '节点文字' });
  await expect(box).toHaveValue('新节点');
  await box.fill('FA3 执行对象');
  await box.press('Enter');
  await expect(nodeCount(page)).toHaveCount(10);
  const graph = await chart(page);
  expect(graph.nodes.find(n => n.id === 'N1')).toMatchObject({ label: 'FA3 执行对象', parent: 'POOL_SIMPLE' });
  expect(graph.edges.some(e => e.from === 'FA2_SIMPLE' && e.to === 'N1')).toBe(true);
});

test('编辑页就是 Mermaid 原生渲染的图', async ({ page }) => {
  await expect(editor(page).locator('svg .flowchart-link')).toHaveCount(9);
  await expect(editor(page).locator('g.node')).toHaveCount(9);
  await expect(editor(page).locator('.mp-node-shape')).toHaveCount(0);
});

test('默认直角走线：连线只有水平和垂直段，没有曲线', async ({ page }) => {
  const paths = await editor(page).locator('path.flowchart-link').evaluateAll(els => els.map(e => e.getAttribute('d') ?? ''));
  expect(paths.length).toBeGreaterThan(3);
  for (const d of paths) {
    expect(d).not.toMatch(/C/);
    // 依次取直线段的端点（M/L），相邻两点必须同 x 或同 y。拐角处的小圆角（Q）和跳线（A）在此之外。
    const tokens = [...d.matchAll(/([MLQA])\s*([^MLQA]*)/g)];
    let last: number[] | undefined;
    for (const [, cmd, args] of tokens) {
      const nums = args!.trim().split(/[\s,]+/).map(Number);
      const end = nums.slice(-2);
      if (cmd === 'L' && last) expect(Math.min(Math.abs(end[0]! - last[0]!), Math.abs(end[1]! - last[1]!))).toBeLessThan(0.5);
      last = end;
    }
  }
});

test('紧凑程度设置生效：默认紧凑的图比 Mermaid 默认间距更小', async ({ page }) => {
  // ELK 的间距由 Mermaid 固定，紧凑程度主要体现在平滑曲线（dagre）下。
  await page.addInitScript(() => { (window as any).__mpEdges = 'curved'; });
  await page.reload();
  await ready(page);
  const size = async () => {
    const [, , w, h] = (await editor(page).locator('svg').first().getAttribute('viewBox'))!.split(' ').map(Number);
    return w! * h!;
  };
  const compact = await size();
  await page.addInitScript(() => { (window as any).__mpDensity = 'loose'; });
  await page.reload();
  await ready(page);
  expect(await size()).toBeGreaterThan(compact * 1.1);
});

test('选中节点显示选中框、四个连接点和悬浮工具条', async ({ page }) => {
  await editor(page).locator('[data-node-id="MA"]').click();
  await expect(editor(page).locator('.mp-selection-frame')).toBeVisible();
  await expect(editor(page).locator('.mp-handle:visible')).toHaveCount(4);
  const menu = editor(page).getByRole('toolbar', { name: '选中项操作' });
  await expect(menu.getByRole('button', { name: '改文字' })).toBeVisible();
  await expect(menu.getByRole('button', { name: '接一个节点' })).toBeVisible();
  await expect(menu.getByRole('button', { name: '删除' })).toBeVisible();
});

test('从连接点拖到另一个节点上连线', async ({ page }) => {
  await editor(page).locator('[data-node-id="JAVA"]').click();
  await dragHandle(page, 'top', await center(page, '[data-node-id="JAIL2_SIMPLE"]'));
  await expect(edges(page)).toHaveCount(10);
  expect((await chart(page)).edges.at(-1)).toMatchObject({ from: 'JAVA', to: 'JAIL2_SIMPLE' });
});

test('从连接点拖到空白处新建节点并连线', async ({ page }) => {
  await editor(page).locator('[data-node-id="JAVA"]').click();
  const java = await center(page, '[data-node-id="JAVA"]');
  const stage = (await editor(page).locator('.mp-editor-stage').boundingBox())!;
  await dragHandle(page, 'right', { x: stage.x + stage.width - 20, y: java.y });
  const box = page.getByRole('textbox', { name: '节点文字' });
  await expect(box).toHaveValue('新节点');
  await box.fill('结果');
  await box.press('Enter');
  await expect(nodeCount(page)).toHaveCount(10);
  const graph = await chart(page);
  expect(graph.nodes.find(n => n.id === 'N1')?.label).toBe('结果');
  expect(graph.edges.at(-1)).toMatchObject({ from: 'JAVA', to: 'N1' });
});

test('双击空白处新建独立节点', async ({ page }) => {
  const stage = (await editor(page).locator('.mp-editor-stage').boundingBox())!;
  await page.mouse.dblclick(stage.x + 12, stage.y + 12);
  const box = page.getByRole('textbox', { name: '节点文字' });
  await box.fill('备注');
  await box.press('Enter');
  await expect(nodeCount(page)).toHaveCount(10);
  const graph = await chart(page);
  expect(graph.nodes.find(n => n.id === 'N1')).toMatchObject({ label: '备注', parent: undefined });
  expect(graph.edges.some(e => e.to === 'N1' || e.from === 'N1')).toBe(false);
});

test('点选连线改文字、删除连线；Delete 删除节点', async ({ page }) => {
  await editor(page).locator('.edgeLabel[data-edge-index="4"]').dblclick();
  const box = page.getByRole('textbox', { name: '连线文字' });
  await expect(box).toHaveValue('调用 FA');
  await box.fill('委派');
  await box.press('Enter');
  await expect.poll(async () => (await chart(page)).edges[4]!.label).toBe('委派');

  await editor(page).locator('.edgeLabel[data-edge-index]', { hasText: '委派' }).click();
  await editor(page).getByRole('button', { name: '删除' }).click();
  await expect(edges(page)).toHaveCount(8);

  await editor(page).locator('[data-node-id="JAVA"]').click();
  await page.keyboard.press('Delete');
  await expect(nodeCount(page)).toHaveCount(8);
  expect((await chart(page)).nodes.some(n => n.id === 'JAVA')).toBe(false);
});

test('撤销与重做回到每一步的源码', async ({ page }) => {
  const original = await sourceText(page);
  await editor(page).locator('[data-node-id="TG"]').click();
  await page.keyboard.press('Delete');
  await expect(nodeCount(page)).toHaveCount(8);
  const deleted = await sourceText(page);
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
  await expect(nodeCount(page)).toHaveCount(9);
  expect(await sourceText(page)).toBe(original);
  await editor(page).getByRole('button', { name: '重做' }).click();
  await expect(nodeCount(page)).toHaveCount(8);
  expect(await sourceText(page)).toBe(deleted);
});

test('源码在别处被改过时拒绝写入并提示', async ({ page }) => {
  await page.getByRole('button', { name: '模拟别处修改' }).click();
  const changed = await sourceText(page);
  await editor(page).locator('[data-node-id="MA"]').click();
  await page.keyboard.press('Delete');
  await expect(status(page)).toContainText('在别处被改过了');
  expect(await sourceText(page)).toBe(changed);
});

test('Esc 先取消选择，再退出编辑', async ({ page }) => {
  await editor(page).locator('[data-node-id="MA"]').click();
  await expect(editor(page).locator('[data-node-id="MA"]')).toHaveClass(/mp-selected/);
  await page.keyboard.press('Escape');
  await expect(editor(page).locator('.mp-selected')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(editor(page)).toHaveCount(0);
  await expect(page.getByText('已退出编辑。')).toBeVisible();
});

test('拖动节点调整位置：写入位置注释，连线跟着重画，可复位', async ({ page }) => {
  const node = editor(page).locator('[data-node-id="OG"]');
  const before = (await node.boundingBox())!;
  const pathsBefore = await edges(page).evaluateAll(els => els.map(el => el.getAttribute('d')));
  await page.mouse.move(before.x + before.width / 2, before.y + before.height / 2);
  await page.mouse.down();
  await page.mouse.move(before.x + before.width / 2 + 40, before.y + before.height / 2 + 10, { steps: 3 });
  await page.mouse.move(before.x + before.width / 2 + 90, before.y + before.height / 2 + 20, { steps: 3 });
  await page.mouse.up();
  await expect.poll(() => sourceText(page)).toContain('%% mermaid-plus-layout:');
  const source = await sourceText(page);
  const [dx, dy] = JSON.parse(source.match(/mermaid-plus-layout: (.*)/)![1]!).nodes.OG as [number, number];
  expect(dx).toBeGreaterThan(30);
  expect(dy).toBeGreaterThan(0);
  // 重画后节点仍在新位置，选中不丢，相连的连线变了。
  await ready(page);
  await expect(node).toHaveClass(/mp-selected/);
  const after = (await node.boundingBox())!;
  expect(after.x - before.x).toBeGreaterThan(20);
  const pathsAfter = await edges(page).evaluateAll(els => els.map(el => el.getAttribute('d')));
  expect(pathsAfter.some((d, i) => d !== pathsBefore[i])).toBe(true);
  // 方向键微调。
  await page.keyboard.press('ArrowDown');
  await expect.poll(async () => JSON.parse((await sourceText(page)).match(/mermaid-plus-layout: (.*)/)![1]!).nodes.OG[1]).toBe(dy + 10);
  // 复位后注释消失，源码与拖动前一致。
  await ready(page);
  await editor(page).getByRole('button', { name: '复位' }).click();
  await expect.poll(() => sourceText(page)).not.toContain('mermaid-plus-layout');
  await expect(editor(page).getByRole('button', { name: '重置布局' })).toBeHidden();
});

test('单击节点不会写入位置', async ({ page }) => {
  const before = await sourceText(page);
  await editor(page).locator('[data-node-id="OG"]').click();
  await expect(editor(page).locator('[data-node-id="OG"]')).toHaveClass(/mp-selected/);
  expect(await sourceText(page)).toBe(before);
});

test('改字时选中文字出现格式栏：加粗写成 Mermaid 原生 Markdown 标签', async ({ page }) => {
  await editor(page).locator('[data-node-id="OG"]').dblclick();
  const box = page.getByRole('textbox', { name: '节点文字' });
  const bar = editor(page).getByRole('toolbar', { name: '文字格式' });
  // 打开时全选，格式栏随之出现；取消选区后隐藏。
  await expect(bar).toBeVisible();
  await box.press('ArrowRight');
  await expect(bar).toBeHidden();
  // 选中 “Gateway”
  await box.evaluate((el: HTMLTextAreaElement) => { const at = el.value.indexOf('Gateway'); el.setSelectionRange(at, at + 7); el.dispatchEvent(new Event('select')); });
  await expect(bar).toBeVisible();
  await bar.getByRole('button', { name: '加粗' }).click();
  await expect(box).toBeFocused();
  await expect(box).toHaveValue('Orchestrator **Gateway**\nFA 请求入口与路由');
  // 快捷键给另一段加斜体
  await box.evaluate((el: HTMLTextAreaElement) => { const at = el.value.indexOf('路由'); el.setSelectionRange(at, at + 2); });
  await box.press(process.platform === 'darwin' ? 'Meta+i' : 'Control+i');
  await box.press('Enter');
  await expect.poll(() => sourceText(page)).toContain('OG["`Orchestrator **Gateway**<br/>FA 请求入口与*路由*`"]');
  const label = editor(page).locator('[data-node-id="OG"]');
  await expect(label.locator('strong')).toHaveText('Gateway');
  await expect(label.locator('em')).toHaveText('路由');
  // 再次编辑时编辑框里没有反引号。
  await label.dblclick();
  await expect(page.getByRole('textbox', { name: '节点文字' })).toHaveValue('Orchestrator **Gateway**\nFA 请求入口与*路由*');
});
