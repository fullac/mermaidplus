// 用途：用插件自带的 Mermaid 渲染器与增强渲染器对照同一份注释样式样例，并用内存中的“笔记”试用可视化编辑。
import example from '../examples/annotation-styles.md';
import layoutExample from '../examples/auto-layout.md';
import subgraphExample from '../examples/subgraph.md';
import { findMermaidBlocks } from '../src/flowchart';
import { createPlayground } from '../src/playground';
import { mountBlockEditor, type BlockEditor, type EditHost } from '../src/blockEditor';
import { mountSequenceEditor } from '../src/sequenceEditor';
import { DEFAULT_RENDER_SETTINGS, renderMermaid } from '../src/mermaidRender';

// 与插件相同的渲染器和默认样式（Mermaid 默认主题、紧凑间距）。
// 测试可通过 window.__mpEdges / __mpDensity / __mpHops 切换连线方式、紧凑程度和交叉画法。
const renderNative = async (source: string, target: HTMLElement) => {
  await renderMermaid(source, target, { ...DEFAULT_RENDER_SETTINGS, edges: (window as any).__mpEdges ?? DEFAULT_RENDER_SETTINGS.edges, density: (window as any).__mpDensity ?? DEFAULT_RENDER_SETTINGS.density, hops: (window as any).__mpHops ?? DEFAULT_RENDER_SETTINGS.hops });
};
const app = document.getElementById('app')!;
let current: { dispose(): void } = createPlayground(app, findMermaidBlocks(example)[0]!.source, renderNative);
for (const [id, source] of [['style-example', example], ['layout-example', layoutExample]]) {
  document.getElementById(id!)!.addEventListener('click', () => {
    current.dispose();
    current = createPlayground(app, findMermaidBlocks(source!)[0]!.source, renderNative);
  });
}

const sequenceExample = `sequenceDiagram
    participant 用户 as 访客
    participant API
    用户->>API: 查询
    API-->>用户: 返回结果
    Note over 用户,API: 同步完成
`;

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

/** 时序图编辑：源码存在内存里。编辑器自己的「源码」退出，「编辑」重新进入。 */
function openSequenceDemo(initial = sequenceExample) {
  current.dispose();
  app.replaceChildren();
  let note = initial;
  const undo: [string, string][] = [], redo: [string, string][] = [];
  const shown = document.createElement('pre'); shown.className = 'mp-demo-source'; shown.setAttribute('aria-label', '当前源码');
  const bar = document.createElement('div'); bar.className = 'mp-entry-bar'; bar.setAttribute('role', 'toolbar'); bar.setAttribute('aria-label', '时序图操作');
  const sourceButton = document.createElement('button'); sourceButton.type = 'button'; sourceButton.className = 'mp-entry-button'; sourceButton.textContent = '源码';
  const editButton = document.createElement('button'); editButton.type = 'button'; editButton.className = 'mp-entry-button'; editButton.textContent = '编辑'; editButton.setAttribute('aria-label', '在图上编辑这张时序图');
  bar.append(sourceButton, editButton);
  const holder = document.createElement('div');
  app.append(bar, holder, shown);
  const show = () => { shown.textContent = note; };
  let editor: BlockEditor | undefined;
  const host: EditHost = {
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
    exit() { editor?.dispose(); editor = undefined; holder.replaceChildren(); },
  };
  sourceButton.addEventListener('click', () => host.exit());
  editButton.addEventListener('click', () => { editor?.dispose(); editor = mountSequenceEditor(holder, note, host); });
  show();
  editor = mountSequenceEditor(holder, note, host);
  Object.assign(app, { __editor: editor });
  current = { dispose() { editor?.dispose(); app.replaceChildren(); } };
}
document.getElementById('editor-example')!.addEventListener('click', openEditorDemo);
if (location.hash === '#editor') openEditorDemo();
if (location.hash.startsWith('#sequence')) openSequenceDemo(location.hash.includes('alt') ? `sequenceDiagram
    participant A
    participant B
    A->>B: 请求
    alt 成功
        B-->>A: 好
    else 失败
        B-->>A: 不好
    end
` : undefined);
