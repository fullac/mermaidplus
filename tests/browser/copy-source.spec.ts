// 用途：点「源码」时复制这张图的 Mermaid 源码。阅读视图展开才复制，实时预览每次都复制；失败只提示。
import { test, expect } from '@playwright/test';
import { build, type PluginBuild } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const OBSIDIAN_STUB = `
export class App {}
export class TFile {}
export const editorInfoField = { name: 'editorInfo' };
export class Notice { constructor(message) { globalThis.__notices.push(String(message)); } }
export class MarkdownRenderChild { constructor(el) { this.el = el; } register() {} }
export class Plugin { constructor(app) { this.app = app; } register() {} registerEditorExtension() {} }
export const loadMermaid = async () => ({ render: async () => ({ svg: '' }) });
`;

const entry = `
import { InlineEditing } from ${JSON.stringify(resolve('src/obsidianEdit.ts'))};
import { findMermaidBlocks } from ${JSON.stringify(resolve('src/flowchart.ts'))};
import { TFile } from 'obsidian';
globalThis.__notices = [];
const settings = () => ({ theme: 'auto', density: 'compact', fontFamily: '', fontSize: 14, edges: 'curved', hops: 'arc', vertical: false, autoDirection: false, background: '' });
let failCopy = false;
const copied = [];

function installClipboard(target) {
  Object.defineProperty(target.navigator, 'clipboard', { configurable: true, value: { writeText: async (value) => { if (failCopy) throw new Error('denied'); copied.push(value); } } });
}

function editingFor(text) {
  const file = new TFile();
  file.path = 'a.md';
  const plugin = {
    app: { vault: { getAbstractFileByPath: () => file, read: async () => text, process: async () => {} }, workspace: { getLeavesOfType: () => [] } },
    register() {}, registerEditorExtension() {},
  };
  return new InlineEditing(plugin, settings);
}

export async function expand(text, fail) {
  failCopy = fail;
  copied.length = 0;
  installClipboard(window);
  const host = document.createElement('div');
  document.body.append(host);
  const editing = editingFor(text);
  editing.attach(host, { sourcePath: 'a.md', addChild: () => {}, getSectionInfo: () => ({ text, lineStart: 0, lineEnd: text.split('\\n').length - 1 }) });
  await new Promise(done => setTimeout(done, 0));
  const button = host.querySelector('.mp-entry-button');
  button.click();
  await new Promise(done => setTimeout(done, 20));
  const shown = host.querySelector('.mp-source-view code')?.textContent ?? '';
  const afterExpand = copied.slice();
  button.click();
  await new Promise(done => setTimeout(done, 20));
  return { copied: copied.slice(), afterExpand, notices: globalThis.__notices.splice(0), shown, collapsed: !host.querySelector('.mp-source-view'), label: button?.getAttribute('aria-label') ?? '', title: button?.title ?? '' };
}

export async function reveal(text, fail) {
  failCopy = fail;
  copied.length = 0;
  const frame = document.createElement('iframe');
  document.body.append(frame);
  const popup = frame.contentWindow;
  installClipboard(popup);
  const block = findMermaidBlocks(text)[0];
  let anchor = -1;
  const content = popup.document.createElement('div');
  popup.document.body.append(content);
  const embed = popup.document.createElement('div');
  embed.className = 'cm-embed-block';
  content.append(embed);
  const view = {
    dom: content,
    contentDOM: content,
    state: {
      doc: { toString: () => text, line: (n) => ({ from: n * 10, number: n }), lineAt: () => ({ number: block.start + 1 }) },
      field: () => ({ file: { path: 'a.md' } }),
    },
    posAtDOM: () => 0,
    dispatch(change) { anchor = change.selection.anchor; },
    focus() {},
  };
  const editing = editingFor(text);
  editing.live(view);
  await new Promise(done => setTimeout(done, 0));
  content.querySelector('.mp-entry-button').click();
  await new Promise(done => setTimeout(done, 20));
  return { copied: copied.slice(), notices: globalThis.__notices.splice(0), anchor };
}
`;

const stub = {
  name: 'stub',
  setup(build: PluginBuild) {
    build.onResolve({ filter: /^(obsidian|@codemirror\/view)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({
      contents: args.path === 'obsidian' ? OBSIDIAN_STUB : 'export const ViewPlugin = { fromClass: () => ({}) }; export const editorInfoField = {};',
      loader: 'js',
    }));
  },
};

async function mount(page: import('@playwright/test').Page) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-copy-'));
  const file = join(dir, 'entry.ts');
  writeFileSync(file, entry);
  const result = await build({ entryPoints: [file], bundle: true, write: false, format: 'iife', globalName: 'mpCopy', target: 'es2022', platform: 'browser', logLevel: 'silent', plugins: [stub] });
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ content: result.outputFiles[0]!.text });
}

const sequence = '```mermaid\nsequenceDiagram\n    participant A\n    A->>A: 时序\n```';
const flowchart = '```mermaid\nflowchart TD\n    A[流程] --> B[结果]\n```';

test('阅读视图展开时复制时序图和流程图，收起时不复制', async ({ page }) => {
  await mount(page);
  const sequenceResult = await page.evaluate(async (text) => (window as any).mpCopy.expand(text, false), sequence);
  expect(sequenceResult.afterExpand).toEqual(['sequenceDiagram\n    participant A\n    A->>A: 时序']);
  expect(sequenceResult.copied).toEqual(sequenceResult.afterExpand);
  expect(sequenceResult.notices).toEqual(['已复制源码']);
  expect(sequenceResult.shown).toContain('时序');
  expect(sequenceResult.collapsed).toBe(true);
  expect(sequenceResult.label).toContain('复制');
  expect(sequenceResult.title).toContain('复制');

  const flowResult = await page.evaluate(async (text) => (window as any).mpCopy.expand(text, false), flowchart);
  expect(flowResult.afterExpand[0]).toContain('flowchart TD');
  expect(flowResult.notices).toEqual(['已复制源码']);
});

test('复制失败时仍显示源码，并提示失败', async ({ page }) => {
  await mount(page);
  const result = await page.evaluate(async (text) => (window as any).mpCopy.expand(text, true), flowchart);
  expect(result.copied).toEqual([]);
  expect(result.notices).toEqual(['复制源码失败']);
  expect(result.shown).toContain('流程');
});

test('实时预览用弹出窗口的剪贴板复制，失败不影响定位源码', async ({ page }) => {
  await mount(page);
  const ok = await page.evaluate(async (text) => (window as any).mpCopy.reveal(text, false), sequence);
  expect(ok.copied[0]).toContain('sequenceDiagram');
  expect(ok.notices).toEqual(['已复制源码']);
  expect(ok.anchor).toBeGreaterThanOrEqual(0);

  const failed = await page.evaluate(async (text) => (window as any).mpCopy.reveal(text, true), flowchart);
  expect(failed.copied).toEqual([]);
  expect(failed.notices).toEqual(['复制源码失败']);
  expect(failed.anchor).toBeGreaterThanOrEqual(0);
});
