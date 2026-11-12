// 用途：用插件自带的 Mermaid 渲染器与增强渲染器对照同一份注释样式样例，并用内存中的“笔记”试用可视化编辑。
import example from '../examples/annotation-styles.md';
import layoutExample from '../examples/auto-layout.md';
import subgraphExample from '../examples/subgraph.md';
import { findMermaidBlocks } from '../src/flowchart';
import { createPlayground } from '../src/playground';
import { mountBlockEditor, type BlockEditor } from '../src/blockEditor';
import { DEFAULT_RENDER_SETTINGS, renderMermaid } from '../src/mermaidRender';

// 与插件相同的渲染器和默认样式（Mermaid 默认主题、紧凑间距）。
// 测试可通过 window.__mpEdges / __mpDensity 切换连线方式和紧凑程度。
const renderNative = async (source: string, target: HTMLElement) => {
  await renderMermaid(source, target, { ...DEFAULT_RENDER_SETTINGS, edges: (window as any).__mpEdges ?? DEFAULT_RENDER_SETTINGS.edges, density: (window as any).__mpDensity ?? DEFAULT_RENDER_SETTINGS.density });
};
const app = document.getElementById('app')!;
let current: { dispose(): void } = createPlayground(app, findMermaidBlocks(example)[0]!.source, renderNative);
for (const [id, source] of [['style-example', example], ['layout-example', layoutExample]]) {
  document.getElementById(id!)!.addEventListener('click', () => {
    current.dispose();
    current = createPlayground(app, findMermaidBlocks(source!)[0]!.source, renderNative);
  });
}

/** 模拟一篇笔记：源码存在内存里，撤销栈与冲突检查和 Obsidian 阅读视图的做法一致。 */
function openEditorDemo() {
  current.dispose();
  app.replaceChildren();
  let note = findMermaidBlocks(subgraphExample)[0]!.source;
  const undo: [string, string][] = [], redo: [string, string][] = [];
  const shown = document.createElement('pre'); shown.className = 'mp-demo-source'; shown.setAttribute('aria-label', '当前源码');
  const external = document.createElement('button'); external.type = 'button'; external.textContent = '模拟别处修改';
  const holder = document.createElement('div');
  app.append(holder, external, shown);
  const show = () => { shown.textContent = note; };
  let editor: BlockEditor | undefined;
  const mount = () => {
    editor?.dispose();
    editor = mountBlockEditor(holder, note, {
      draw: renderNative,
      async commit(before, after) {
        if (note !== before) return false;
        undo.push([before, after]); redo.length = 0; note = after; show(); return true;
      },
      async undo() {
        const step = undo.pop(); if (!step || note !== step[1]) return null;
        redo.push(step); note = step[0]; show(); return note;
      },
      async redo() {
        const step = redo.pop(); if (!step || note !== step[0]) return null;
        undo.push(step); note = step[1]; show(); return note;
      },
      exit() { editor?.dispose(); editor = undefined; holder.textContent = '已退出编辑。'; },
    });
  };
  external.addEventListener('click', () => { note = note.replace('TG --> JAVA', 'TG --> JAVA\n    JAVA --> MA'); show(); });
  show(); mount();
  current = { dispose() { editor?.dispose(); app.replaceChildren(); } };
}
document.getElementById('editor-example')!.addEventListener('click', openEditorDemo);
if (location.hash === '#editor') openEditorDemo();
