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

test('紧凑程度设置生效：默认紧凑的图比 Mermaid 默认间距更小', async ({ page }) => {
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
  await expect(status(page)).toContainText('已在别处被修改');
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
