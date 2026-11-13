// 用途：验证禁用插件（onunload）后，页面上不留下插件注入的节点、class，观察器停了，
// 并且会让 Obsidian 重新画出原生 Mermaid 图（阅读视图重画整段，实时预览让编辑器重画一次）。
// 插件代码依赖 Obsidian 运行时，这里用 esbuild 把插件打到浏览器里，'obsidian' 换成最小替身，
// 然后在真实的 Chrome DOM 里跑一遍。
import { test, expect } from '@playwright/test';
import { build, type PluginBuild } from 'esbuild';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

/** Obsidian 的最小替身：只实现插件在 register / onload / onunload 路径上用到的成员。 */
const OBSIDIAN_STUB = `
export class App {}
export class TFile {}
export const editorInfoField = { name: 'editorInfo' };
export const loadMermaid = async () => ({ render: async () => ({ svg: '' }) });
export class Notice { constructor() {} }
export class MarkdownRenderChild { constructor(el) { this.el = el; } register(fn) { return fn; } }
export class Plugin {
  constructor(app) { this.app = app; this.cleanups = []; }
  register(fn) { this.cleanups.push(fn); return fn; }
  registerEvent() {} registerEditorExtension() {} registerCommand() {}
  registerMarkdownCodeBlockProcessor() {} registerMarkdownPostProcessor() {}
  addCommand() {} addSettingTab() {} addRibbonIcon() {}
  async loadData() { return {}; }
  async saveData() {}
  /** Obsidian 卸载插件时会调用 plugin.register 登记的回调。 */
  unloadChildren() { for (const fn of this.cleanups.splice(0)) fn(); }
}
export class PluginSettingTab { constructor(app) { this.app = app; } }
export class Setting {
  setName() { return this; } setHeading() { return this; } setDesc() { return this; }
  addToggle() { return this; } addDropdown() { return this; } addText() { return this; }
  addSlider() { return this; } addColorPicker() { return this; } addExtraButton() { return this; }
}
export class MarkdownView {
  constructor() {
    this.containerEl = document.body;
    this.previewMode = { rerender() {} };
    this.editor = { cm: { dispatch() {} } };
  }
  getMode() { return 'preview'; }
}
`;

const STUBS: Record<string, string> = {
  obsidian: OBSIDIAN_STUB,
  '@codemirror/view': 'export const ViewPlugin = { fromClass: () => ({}) };',
  mermaid: 'export default {};',
  'elkjs/lib/elk.bundled.js': 'export default class ELK {};',
};

/** 一段已经被插件接管的笔记：注入的节点和加上的 class 都在。 */
const FIXTURE = `
function fixture() {
  document.body.innerHTML = \`
    <div class="markdown-preview-view"><div class="markdown-preview-section">
      <div class="mp-diagram markdown-rendered"><div class="mp-diagram-svg"><svg></svg></div></div>
      <div class="cm-embed-block mp-edit-host">
        <div class="mp-native-hidden"><span class="mermaid">native</span></div>
        <div class="mp-entry-bar"><button>编辑</button></div>
        <div class="mp-source-view"><code>graph TD</code></div>
        <div class="mp-block-editor"><div class="mp-editor-stage"></div></div>
      </div>
      <div class="cm-embed-block mp-edit-host mp-editing">
        <div class="mp-native-hidden"><span class="mermaid">native2</span></div>
        <div class="mp-block-editor"></div>
      </div>
    </div></div>\`;
}
/** 页面上的残留统计。 */
function count() {
  return {
    injected: document.querySelectorAll('.mp-block-editor, .mp-diagram-svg, .mp-entry-bar, .mp-source-view').length,
    marks: document.querySelectorAll('.mp-diagram, .mp-edit-host, .mp-editing, .mp-native-hidden').length,
    native: document.querySelectorAll('.mermaid').length,
  };
}
`;

const classesEntry = `
import { DiagramBlocks } from ${JSON.stringify(resolve('src/obsidianRender.ts'))};
import { InlineEditing } from ${JSON.stringify(resolve('src/obsidianEdit.ts'))};
${FIXTURE}
const settings = () => ({ vertical: true, edges: 'curved', hops: 'arc', density: 'normal', theme: 'default', fontFamily: '', fontSize: 14, background: '', autoDirection: true });

function fakePlugin() {
  const cleanups = [];
  return {
    plugin: {
      app: { workspace: { getLeavesOfType: () => [] } },
      register: fn => { cleanups.push(fn); return fn; },
      registerMarkdownCodeBlockProcessor: () => {},
      registerMarkdownPostProcessor: () => {},
      registerEditorExtension: () => {},
    },
    cleanups,
  };
}

export async function run() {
  fixture();
  const a = fakePlugin(), b = fakePlugin();
  const editing = new InlineEditing(a.plugin, settings);
  editing.register();
  const blocks = new DiagramBlocks(b.plugin, settings, editing);
  blocks.register();

  // 阅读视图兜底会给段落挂一个 MutationObserver，插件禁用后它必须停。
  const section = document.createElement('div');
  section.innerHTML = '<div class="mermaid">graph TD</div>';
  document.body.append(section);
  const ctx = { sourcePath: 'a.md', addChild: () => {}, getSectionInfo: () => ({ text: '\\u0060\\u0060\\u0060mermaid\\ngraph TD\\n  A-->B\\n\\u0060\\u0060\\u0060', lineStart: 0, lineEnd: 3 }) };
  blocks.claimSection(section, ctx);
  const claimed = section.querySelectorAll('.mp-diagram').length;

  for (const fn of [...a.cleanups, ...b.cleanups]) fn();
  editing.dispose();
  blocks.dispose();

  // 观察器若还活着，这次改动会让它继续往段落里插新的图。
  section.append(document.createElement('span'));
  await new Promise(done => setTimeout(done, 60));

  return { claimed, watched: document.querySelectorAll('.mp-diagram').length, ...count() };
}
`;

const pluginEntry = `
import MermaidPlus from ${JSON.stringify(resolve('src/main.ts'))};
import { MarkdownView } from 'obsidian';
${FIXTURE}
export async function run() {
  fixture();
  const rerenders = [], dispatches = [];
  const preview = new MarkdownView();
  preview.previewMode.rerender = () => rerenders.push('preview');
  const live = new MarkdownView();
  live.getMode = () => 'source';
  live.editor.cm.dispatch = () => dispatches.push('source');
  const app = {
    // 这里是 leaf，不是 view：插件从 leaf.view 上取。
    workspace: { getLeavesOfType: () => [{ view: preview }, { view: live }], on: () => ({}) },
    vault: {},
  };
  const plugin = new MermaidPlus(app);
  await plugin.onload();
  plugin.onunload();
  // Obsidian 卸载插件时会接着调用 plugin.register 登记的回调。
  plugin.unloadChildren();
  await new Promise(done => setTimeout(done, 100));
  return { rerenders, dispatches, ...count() };
}
`;

const stubPlugin = {
  name: 'stub',
  setup(build: PluginBuild) {
    build.onResolve({ filter: /^(obsidian|@codemirror\/view|mermaid|elkjs\/.*)$/ }, args => ({ path: args.path, namespace: 'stub' }));
    build.onLoad({ filter: /.*/, namespace: 'stub' }, args => ({ contents: STUBS[args.path], loader: 'js' }));
  },
};

/** 把一段入口代码打成单个 IIFE，暴露成 window.mpTest。 */
async function bundle(entryCode: string) {
  const dir = mkdtempSync(join(tmpdir(), 'mp-unload-'));
  const entry = join(dir, 'entry.ts');
  writeFileSync(entry, entryCode);
  const result = await build({
    entryPoints: [entry], bundle: true, write: false, format: 'iife', globalName: 'mpTest',
    target: 'es2022', platform: 'browser', logLevel: 'silent', plugins: [stubPlugin],
  });
  return result.outputFiles[0]!.text;
}

async function mount(page: import('@playwright/test').Page, code: string) {
  await page.setContent('<!doctype html><body></body>');
  await page.addScriptTag({ content: code });
  return page.evaluate(() => (window as unknown as { mpTest: { run(): Promise<Record<string, unknown>> } }).mpTest.run());
}

test('两个类的 dispose 把注入的节点、class 和观察器都清干净', async ({ page }) => {
  const result = await mount(page, await bundle(classesEntry));
  // 插件确实接管过这一段，否则下面的检查没意义。
  expect(result.claimed).toBe(1);
  expect(result.injected).toBe(0);
  expect(result.marks).toBe(0);
  // Obsidian 画的原图还在页面里（阅读视图靠重画恢复，实时预览靠它自己重新显示）。
  expect(result.native).toBe(2);
  // 观察器已断开：段落里新增节点后没有又冒出一张插件的图。
  expect(result.watched).toBe(0);
});

test('插件 onunload 清理干净，并让 Obsidian 重画原生图', async ({ page }) => {
  const result = await mount(page, await bundle(pluginEntry));
  expect(result.injected).toBe(0);
  expect(result.marks).toBe(0);
  expect(result.native).toBe(2);
  // 阅读视图整段重画（被插件删掉的原生图只能这样回来），实时预览让编辑器重画一次。
  expect(result.rerenders).toEqual(['preview']);
  expect(result.dispatches).toEqual(['source']);
});