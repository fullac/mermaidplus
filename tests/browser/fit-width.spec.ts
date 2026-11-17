// 用途：验证“适应窗口宽度”开关：关闭时与 0.10.0 相同（宽流程图保留最小字号、横向滚动），开启时流程图和时序图在阅读视图、
// 实时预览和编辑页里整张等比缩到栏宽、不横向滚动；栏宽变化后跟着缩放，缩放后点选框和拖动节点的位置仍然准确。
// 阅读视图和实时预览走插件真实的 DiagramBlocks 渲染路径，'obsidian' 换成最小替身；编辑页直接挂真实编辑器。
import { test, expect, type Page } from '@playwright/test';
import { build, type PluginBuild } from 'esbuild';
import { readFile } from 'node:fs/promises';

/** DiagramBlocks 只用到 Obsidian 的这两个成员；非插件图不在本测试范围内。 */
const OBSIDIAN_STUB = `
export class MarkdownRenderChild { constructor(el) { this.el = el; } register(fn) { return fn; } }
export const loadMermaid = async () => { throw new Error('本测试只渲染流程图和时序图'); };
`;
const stubObsidian = { name: 'stub-obsidian', setup(b: PluginBuild) {
  b.onResolve({ filter: /^obsidian$/ }, () => ({ path: 'obsidian', namespace: 'stub' }));
  b.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: OBSIDIAN_STUB, loader: 'js' }));
} };

let bundle: string, css: string;
test.beforeAll(async () => {
  const result = await build({
    stdin: { contents: `export * from './src/mermaidRender'; export * from './src/blockEditor'; export * from './src/sequenceEditor'; export { DiagramBlocks } from './src/obsidianRender';`, resolveDir: process.cwd() },
    bundle: true, write: false, format: 'iife', globalName: 'mp', target: 'es2022', logLevel: 'silent', plugins: [stubObsidian],
  });
  bundle = result.outputFiles[0]!.text;
  css = await readFile('styles.css', 'utf8');
});

/** 12 个节点的横向长链，自然宽度约 2500，远宽于测试用的栏宽。 */
const WIDE_FLOW = 'flowchart LR\n' + Array.from({ length: 11 }, (_, i) => `N${i}[处理节点${i}] --> N${i + 1}[处理节点${i + 1}]`).join('\n');
/** 10 个参与者的时序图，自然宽度约 1800。 */
const WIDE_SEQUENCE = 'sequenceDiagram\n' + Array.from({ length: 10 }, (_, i) => `participant P${i} as 参与者编号${i}`).join('\n') + '\nP0->>P9: 跨越全图的消息\nP9-->>P0: 回复';

/** 搭一个阅读视图栏和一个实时预览栏，用插件的 DiagramBlocks 画图；设置对象可在测试里改，再调用 repaint。 */
async function mountPlugin(page: Page, width: number) {
  await page.setContent(`<body>
    <div id="reading" class="markdown-preview-view" style="width:${width}px"><div class="markdown-preview-section"><div id="flow-el"></div><div id="seq-el"></div></div></div>
    <div id="live" class="cm-content" style="width:${width}px">
      <div id="flow-embed" class="cm-embed-block"><div class="block-language-mermaid">原生图</div></div>
      <div id="seq-embed" class="cm-embed-block"><div class="block-language-mermaid">原生图</div></div>
    </div></body>`);
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
  await page.evaluate(async ([flow, sequence]) => {
    const api = (window as any).mp;
    const settings = (window as any).settings = { ...api.DEFAULT_RENDER_SETTINGS };
    let processor: any;
    const plugin = { app: {}, register() {}, registerMarkdownCodeBlockProcessor: (_: string, fn: any) => { processor = fn; }, registerMarkdownPostProcessor() {} };
    const editing: any = { claim: () => false, attach() {}, isEditing: () => false };
    const blocks = (window as any).blocks = new api.DiagramBlocks(plugin, () => settings, editing);
    blocks.register();
    const ctx = { sourcePath: 'note.md', getSectionInfo: () => null, addChild() {} };
    // 阅读视图：Obsidian 调用代码块处理器；实时预览：编辑器扩展找到图块后通知 DiagramBlocks。
    await processor(flow, document.getElementById('flow-el'), ctx);
    await processor(sequence, document.getElementById('seq-el'), ctx);
    editing.onLiveEmbed(document.getElementById('flow-embed'), flow);
    editing.onLiveEmbed(document.getElementById('seq-embed'), sequence);
  }, [WIDE_FLOW, WIDE_SEQUENCE]);
  await expect(page.locator('.mp-diagram-svg > svg')).toHaveCount(4);
}

/** 四张图（两种视图 × 两种图）的显示尺寸。 */
function measure(page: Page) {
  return page.evaluate(() => Object.fromEntries(['flow-el', 'seq-el', 'flow-embed', 'seq-embed'].map(id => {
    const holder = document.querySelector<HTMLElement>(`#${id} > .mp-diagram-svg`)!, svg = holder.querySelector('svg')!;
    const rect = svg.getBoundingClientRect(), view = svg.viewBox.baseVal, box = holder.getBoundingClientRect();
    return [id, {
      column: holder.clientWidth, scroll: holder.scrollWidth, width: rect.width, height: rect.height, viewWidth: view.width,
      ratioError: Math.abs(rect.height / rect.width - view.height / view.width) / (view.height / view.width),
      left: rect.left - box.left, right: box.right - rect.right,
      fitClass: holder.classList.contains('mp-fit-width'), fitData: svg.dataset.mpFit ?? null, minWidth: svg.style.minWidth, minScale: svg.dataset.mpMinScale ?? null,
      nativeHidden: !!holder.parentElement!.querySelector('.block-language-mermaid.mp-native-hidden') || !holder.parentElement!.querySelector('.block-language-mermaid'),
    }];
  }))) as Promise<Record<string, { column: number; scroll: number; width: number; height: number; viewWidth: number; ratioError: number; left: number; right: number; fitClass: boolean; fitData: string | null; minWidth: string; minScale: string | null; nativeHidden: boolean }>>;
}

const repaint = (page: Page, fitWidth: boolean) => page.evaluate(async fit => { (window as any).settings.fitWidth = fit; await (window as any).blocks.repaint(); }, fitWidth);

test('默认关闭：阅读视图和实时预览与 0.10.0 相同，宽流程图保留最小字号并横向滚动', async ({ page }) => {
  await mountPlugin(page, 600);
  expect(await page.evaluate(() => (window as any).mp.DEFAULT_RENDER_SETTINGS.fitWidth)).toBe(false);
  const m = await measure(page);
  for (const id of ['flow-el', 'flow-embed']) {
    const d = m[id]!;
    expect(d.fitClass).toBe(false); expect(d.fitData).toBeNull();
    expect(d.minScale).toBe('0.65'); expect(parseFloat(d.minWidth)).toBeCloseTo(d.viewWidth * 0.65, 0);
    expect(d.scroll).toBeGreaterThan(d.column + 100);
    expect(d.width / d.viewWidth).toBeGreaterThanOrEqual(0.649);
  }
  // 时序图在 0.10.0 就按栏宽缩放，关闭开关时保持不变。
  for (const id of ['seq-el', 'seq-embed']) {
    const d = m[id]!;
    expect(d.fitClass).toBe(false); expect(d.minWidth).toBe(''); expect(d.scroll).toBeLessThanOrEqual(d.column);
  }
  expect(m['flow-embed']!.nativeHidden).toBe(true);
});

test('开启后两种图在两种视图里等比缩到栏宽、无横向滚动；关回去恢复原样', async ({ page }, info) => {
  await mountPlugin(page, 600);
  await repaint(page, true);
  const on = await measure(page);
  for (const [id, d] of Object.entries(on)) {
    expect(d.fitClass, id).toBe(true); expect(d.fitData, id).toBe('width');
    expect(d.minWidth, id).toBe(''); expect(d.minScale, id).toBeNull();
    expect(d.scroll, id).toBeLessThanOrEqual(d.column);
    expect(Math.abs(d.width - d.column), id).toBeLessThan(1);
    expect(d.width / d.viewWidth, id).toBeLessThan(0.4);
    expect(d.ratioError, id).toBeLessThan(0.01);
  }
  await page.screenshot({ path: info.outputPath('fit-on-600.png'), fullPage: true });
  await repaint(page, false);
  const off = await measure(page);
  for (const id of ['flow-el', 'flow-embed']) {
    expect(off[id]!.fitClass).toBe(false); expect(off[id]!.minScale).toBe('0.65'); expect(off[id]!.scroll).toBeGreaterThan(off[id]!.column + 100);
  }
});

test('开启后窗口或分栏变宽变窄时跟着缩放，始终无横向滚动', async ({ page }) => {
  await mountPlugin(page, 600);
  await repaint(page, true);
  let previous = 0;
  for (const width of [900, 360, 1200]) {
    await page.evaluate(w => { for (const id of ['reading', 'live']) document.getElementById(id)!.style.width = `${w}px`; }, width);
    const m = await measure(page);
    for (const [id, d] of Object.entries(m)) {
      expect(d.column, `${id}@${width}`).toBe(width);
      expect(d.scroll, `${id}@${width}`).toBeLessThanOrEqual(d.column);
      expect(Math.abs(d.width - Math.min(width, d.viewWidth)), `${id}@${width}`).toBeLessThan(1);
      expect(d.ratioError, `${id}@${width}`).toBeLessThan(0.01);
    }
    expect(m['flow-el']!.width).not.toBe(previous);
    previous = m['flow-el']!.width;
  }
  // 宽度变化只靠 CSS 重排，不应触发重新渲染（SVG 还是同一个元素、viewBox 未变）。
  expect(await page.evaluate(() => document.querySelectorAll('svg[data-mp-fit="width"]').length)).toBe(4);
});

test('开启后窄图保持原大小居中，不会被放大', async ({ page }) => {
  await page.setContent('<body><div id="host" style="width:900px"></div></body>');
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle });
  const r = await page.evaluate(async () => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    const svg = await api.renderMermaid('flowchart TD\nA[小图] --> B[结果]', host, { ...api.DEFAULT_RENDER_SETTINGS, fitWidth: true });
    const a = host.getBoundingClientRect(), b = svg.getBoundingClientRect();
    return { width: b.width, natural: svg.viewBox.baseVal.width, center: Math.abs(a.left + a.width / 2 - b.left - b.width / 2) };
  });
  expect(Math.abs(r.width - r.natural)).toBeLessThan(1); expect(r.center).toBeLessThan(1);
});

test('开启后带位置注释、节点被拖到很远的图也整张缩进栏内，源码不变', async ({ page }) => {
  await page.setContent('<body><div id="on" style="width:500px"></div><div id="off" style="width:500px"></div></body>');
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle });
  const source = WIDE_FLOW + '\n%% mermaid-plus-layout: {"version":1,"nodes":{"N11":[600,200]}}';
  const r = await page.evaluate(async source => {
    const api = (window as any).mp;
    const draw = async (id: string, fitWidth: boolean) => {
      const host = document.getElementById(id)!;
      const svg = await api.renderMermaid(source, host, { ...api.DEFAULT_RENDER_SETTINGS, fitWidth });
      return { view: svg.getAttribute('viewBox'), minWidth: svg.style.minWidth, scroll: host.scrollWidth, column: host.clientWidth, width: svg.getBoundingClientRect().width };
    };
    return { on: await draw('on', true), off: await draw('off', false) };
  }, source);
  // 两种模式排版结果（viewBox）完全一样，只是显示比例不同。
  expect(r.on.view).toBe(r.off.view);
  expect(r.on.minWidth).toBe(''); expect(r.on.scroll).toBeLessThanOrEqual(r.on.column);
  expect(parseFloat(r.off.minWidth)).toBeGreaterThan(500); expect(r.off.scroll).toBeGreaterThan(r.off.column);
});

/** 挂一个真实的编辑器，宿主写回只记录源码。 */
async function mountEditor(page: Page, kind: 'flowchart' | 'sequence', source: string, width: number) {
  await page.setContent(`<body style="margin:0"><div id="host" style="width:${width}px"></div></body>`);
  await page.addStyleTag({ content: css }); await page.addScriptTag({ content: bundle });
  await page.evaluate(([kind, source]) => {
    const api = (window as any).mp;
    const mount = kind === 'sequence' ? api.mountSequenceEditor : api.mountBlockEditor;
    (window as any).editor = mount(document.getElementById('host'), source, {
      draw: async (s: string, t: HTMLElement) => { await api.renderMermaid(s, t, { ...api.DEFAULT_RENDER_SETTINGS, fitWidth: true }); },
      commit: async () => true, undo: async () => null, redo: async () => null, exit() {},
    });
  }, [kind, source]);
}

/** 编辑页舞台的滚动情况，以及选中框是否刚好围住选中的元素（选中框内边距 4–6 px）。 */
function editorGeometry(page: Page, selector: string) {
  return page.evaluate(selector => {
    const stage = document.querySelector<HTMLElement>('.mp-editor-stage')!, svg = stage.querySelector<SVGSVGElement>('.mp-editor-diagram > svg')!;
    const targets = [...stage.querySelectorAll(selector)].filter(el => !el.classList.contains('mp-edge-hit') && el.getAttribute('data-et') !== 'life-line').map(el => el.getBoundingClientRect());
    const frame = document.querySelector<HTMLElement>('.mp-selection-frame')!.getBoundingClientRect();
    const box = { left: Math.min(...targets.map(t => t.left)), top: Math.min(...targets.map(t => t.top)), right: Math.max(...targets.map(t => t.right)), bottom: Math.max(...targets.map(t => t.bottom)) };
    const gaps = [box.left - frame.left, box.top - frame.top, frame.right - box.right, frame.bottom - box.bottom];
    return { stage: stage.clientWidth, scroll: stage.scrollWidth, svgWidth: svg.getBoundingClientRect().width, scale: svg.viewBox.baseVal.width / svg.getBoundingClientRect().width, gaps };
  }, selector);
}

test('流程图编辑页：开启后无横向滚动，点选框对准缩小后的节点，拖动位移按缩放换算，栏宽变化后仍准确', async ({ page }, info) => {
  await mountEditor(page, 'flowchart', WIDE_FLOW, 520);
  const node = page.locator('.mp-editor-canvas [data-node-id="N6"]');
  await expect(node).toBeVisible();
  await expect(page.locator('.mp-editor-diagram > svg')).toHaveAttribute('data-mp-fit', 'width');
  await node.click();
  let g = await editorGeometry(page, '[data-node-id="N6"]');
  expect(g.scroll).toBeLessThanOrEqual(g.stage);
  expect(g.scale).toBeGreaterThan(3);
  for (const gap of g.gaps) expect(gap).toBeCloseTo(6, 0);

  // 拖动 30×20 屏幕像素：写回的偏移是屏幕位移乘缩放比例，重画后节点相对图停在松手的位置。
  // 用相对图左上角的位置比较：首次写入位置后工具条多出“重置布局”，窄栏里会折行把整张图往下推。
  const nodeInSvg = () => page.evaluate(() => {
    const n = document.querySelector('.mp-editor-diagram [data-node-id="N6"]')!.getBoundingClientRect(), s = document.querySelector('.mp-editor-diagram > svg')!.getBoundingClientRect();
    return { x: n.x - s.x, y: n.y - s.y };
  });
  const drag = async (dx: number, dy: number) => {
    const box = (await node.boundingBox())!, scale = (await editorGeometry(page, '[data-node-id="N6"]')).scale, before = await nodeInSvg();
    const x = box.x + box.width / 2, y = box.y + box.height / 2;
    await page.mouse.move(x, y); await page.mouse.down();
    await page.mouse.move(x + dx / 2, y + dy / 2, { steps: 4 }); await page.mouse.move(x + dx, y + dy, { steps: 4 });
    // 拖动途中节点就跟着鼠标走。
    const during = await nodeInSvg();
    expect(Math.hypot(during.x - before.x - dx, during.y - before.y - dy)).toBeLessThan(1.5);
    await page.mouse.up();
    return { before, scale };
  };
  let { before, scale } = await drag(30, 20);
  await expect.poll(() => page.evaluate(() => (window as any).editor.source())).toContain('mermaid-plus-layout');
  const offset = () => page.evaluate(() => JSON.parse((window as any).editor.source().match(/mermaid-plus-layout: (.*)$/m)[1]).nodes.N6 as [number, number]);
  let [ox, oy] = await offset();
  expect(Math.abs(ox - 30 * scale)).toBeLessThanOrEqual(scale + 1);
  expect(Math.abs(oy - 20 * scale)).toBeLessThanOrEqual(scale + 1);
  await expect.poll(async () => { const b = await nodeInSvg(); return Math.hypot(b.x - before.x - 30, b.y - before.y - 20); }).toBeLessThan(1.5);
  g = await editorGeometry(page, '[data-node-id="N6"]');
  for (const gap of g.gaps) expect(gap).toBeCloseTo(6, 0);
  expect(g.scroll).toBeLessThanOrEqual(g.stage);

  // 栏变宽：图跟着放大，选中框跟着节点走，再拖一次仍按新的缩放换算。
  await page.evaluate(() => { document.getElementById('host')!.style.width = '900px'; });
  await expect.poll(async () => (await editorGeometry(page, '[data-node-id="N6"]')).svgWidth).toBeGreaterThan(800);
  await expect.poll(async () => (await editorGeometry(page, '[data-node-id="N6"]')).gaps.every(gap => Math.abs(gap - 6) < 1)).toBe(true);
  g = await editorGeometry(page, '[data-node-id="N6"]');
  expect(g.scroll).toBeLessThanOrEqual(g.stage);
  const [px, py] = [ox, oy];
  ({ before, scale } = await drag(-20, 10));
  await expect.poll(async () => (await offset())[0]).not.toBe(px);
  [ox, oy] = await offset();
  expect(Math.abs(ox - (px - 20 * scale))).toBeLessThanOrEqual(scale + 1);
  expect(Math.abs(oy - (py + 10 * scale))).toBeLessThanOrEqual(scale + 1);
  await page.screenshot({ path: info.outputPath('flow-editor-900.png') });
});

test('流程图编辑页：开启后从连接点拖到缩小的目标节点上能正确连线', async ({ page }) => {
  await mountEditor(page, 'flowchart', WIDE_FLOW, 520);
  await page.locator('.mp-editor-canvas [data-node-id="N2"]').click();
  const handle = (await page.locator('.mp-handle-bottom').boundingBox())!, target = (await page.locator('.mp-editor-canvas [data-node-id="N8"]').boundingBox())!;
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2); await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await expect(page.locator('.mp-editor-canvas [data-node-id="N8"].mp-drop-target')).toHaveCount(1);
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).editor.source())).toContain('N2 --> N8');
});

test('时序图编辑页：开启后无横向滚动，点选框对准缩小的消息和参与者，双击改字的输入框盖在原处，栏宽变化后仍准确', async ({ page }) => {
  await mountEditor(page, 'sequence', WIDE_SEQUENCE, 520);
  const message = page.locator('.mp-editor-stage text.messageText').filter({ hasText: '跨越全图的消息' });
  await expect(message).toBeVisible();
  await message.click();
  let g = await editorGeometry(page, '[data-edge-index="0"]');
  expect(g.scroll).toBeLessThanOrEqual(g.stage); expect(g.scale).toBeGreaterThan(2);
  for (const gap of g.gaps) expect(gap).toBeCloseTo(4, 0);
  // 先按 Esc 取消选中，免得消息的悬浮工具条挡住参与者。
  await page.getByRole('group', { name: 'Mermaid 时序图编辑' }).press('Escape');
  await page.locator('.mp-editor-stage [data-node-id="P7"]').getByText('参与者编号7').first().click();
  g = await editorGeometry(page, '[data-node-id="P7"]');
  for (const gap of g.gaps) expect(gap).toBeCloseTo(6, 0);

  await page.evaluate(() => { document.getElementById('host')!.style.width = '1000px'; });
  await expect.poll(async () => (await editorGeometry(page, '[data-node-id="P7"]')).svgWidth).toBeGreaterThan(900);
  await expect.poll(async () => (await editorGeometry(page, '[data-node-id="P7"]')).gaps.every(gap => Math.abs(gap - 6) < 1)).toBe(true);
  expect((await editorGeometry(page, '[data-node-id="P7"]')).scroll).toBeLessThanOrEqual(1000);

  await message.dblclick();
  const input = page.getByRole('textbox', { name: '消息文字' });
  await expect(input).toHaveValue('跨越全图的消息');
  const [a, b] = [(await input.boundingBox())!, (await message.boundingBox())!];
  expect(Math.abs(a.x + a.width / 2 - (b.x + b.width / 2))).toBeLessThan(2);
  expect(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2))).toBeLessThan(2);
  await input.fill('改过的消息'); await input.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).editor.source())).toContain('P0->>P9: 改过的消息');
});
