// 用途：用 issue #8 的时序图验证暗色透明画布、浅色 box 保留、文字对比度，以及浅色画布上的按钮配色。
import { test, expect } from '@playwright/test';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';

const ISSUE = `%%{init: {"themeVariables": {"actorBkg": "#dbeafe", "actorBorder": "#60a5fa", "actorTextColor": "#0f172a"}, "sequence": {"mirrorActors": false}}}%%
sequenceDiagram
    autonumber
    participant ORC as Orchestrator
    participant LEFT as 左侧同事
    box rgb(219,234,254) PoolHost A 主进程
        participant FA as 本轮 FA
        participant TOOL as shell 工具
    end
    participant NEXT as 后续请求
    ORC->>LEFT: 框外消息
    FA->>TOOL: 框内消息
    Note over FA,TOOL: 此处登记执行任务
    TOOL-->>FA: 返回结果`;

let bundle: string, css: string;
test.beforeAll(async () => {
  const result = await build({ stdin: { contents: `export * from './src/mermaidRender'; export * from './src/blockEditor';`, resolveDir: process.cwd() }, bundle: true, write: false, format: 'iife', globalName: 'mp', target: 'es2022', logLevel: 'silent' });
  bundle = result.outputFiles[0]!.text;
  css = await readFile('styles.css', 'utf8');
});
test.beforeEach(async ({ page }) => {
  await page.setContent('<body class="theme-dark" style="background:#202124"><div id="host" class="mp-edit-host" style="width:900px"></div></body>');
  await page.addStyleTag({ content: css });
  await page.addScriptTag({ content: bundle });
});

function luminance(color: string) {
  const parts = color.match(/[\d.]+/g)?.slice(0, 3).map(Number) ?? [0, 0, 0];
  const lin = (channel: number) => { const n = channel / 255; return n <= 0.04045 ? n / 12.92 : ((n + 0.055) / 1.055) ** 2.4; };
  return lin(parts[0]!) * 0.2126 + lin(parts[1]!) * 0.7152 + lin(parts[2]!) * 0.0722;
}

test('浅色主题和近白底色时，源码按钮与编辑工具条用浅色配色', async ({ page }) => {
  const result = await page.evaluate(async (source) => {
    const api = (window as any).mp, host = document.getElementById('host')!;
    const bar = document.createElement('div'); bar.className = 'mp-entry-bar';
    const button = document.createElement('button'); button.className = 'mp-entry-button'; button.textContent = '源码';
    bar.append(button); host.append(bar);
    const surface = document.createElement('div'); surface.className = 'mp-diagram-svg'; host.prepend(surface);
    await api.renderMermaid(source, surface, { ...api.DEFAULT_RENDER_SETTINGS, theme: 'default', background: '#fafafa' });
    const tone = surface.getAttribute('data-mp-canvas');
    if (tone) host.setAttribute('data-mp-canvas', tone);
    const editorHost = document.createElement('div');
    document.body.append(editorHost);
    api.mountBlockEditor(editorHost, 'flowchart TD\nA[节点]', {
      draw: async (text: string, target: HTMLElement) => { await api.renderMermaid(text, target, { ...api.DEFAULT_RENDER_SETTINGS, theme: 'default', background: '#fafafa' }); },
      commit: async () => true, undo: async () => null, redo: async () => null, exit() {},
    });
    const root = editorHost.querySelector('.mp-block-editor')!;
    for (let i = 0; i < 40 && !root.getAttribute('data-mp-canvas'); i++) await new Promise(resolve => setTimeout(resolve, 50));
    const toolbar = root.querySelector('.mp-editor-toolbar button')!;
    return {
      canvas: host.getAttribute('data-mp-canvas'),
      hostBackground: getComputedStyle(surface).backgroundColor,
      button: getComputedStyle(button).backgroundColor,
      ink: getComputedStyle(button).color,
      editorCanvas: root.getAttribute('data-mp-canvas'),
      toolbar: getComputedStyle(toolbar).backgroundColor,
    };
  }, ISSUE);
  expect(result.canvas).toBe('light');
  expect(result.hostBackground).toBe('rgb(250, 250, 250)');
  expect(result.button).toBe('rgb(244, 246, 245)');
  expect(luminance(result.ink)).toBeLessThan(0.2);
  expect(result.editorCanvas).toBe('light');
  expect(result.toolbar).toBe('rgb(244, 246, 245)');
});
