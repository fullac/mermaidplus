// 用途：用独立 Mermaid 渲染器与增强渲染器对照同一份注释样式样例。
import mermaid from 'mermaid';
import example from '../examples/annotation-styles.md';
import layoutExample from '../examples/auto-layout.md';
import { findMermaidBlocks } from '../src/flowchart';
import { createPlayground } from '../src/playground';

mermaid.initialize({ startOnLoad: false, securityLevel: 'strict', theme: 'neutral', fontFamily: 'system-ui' });
let serial = 0;
const renderNative = async (source: string, target: HTMLElement) => {
  const id = `native-${++serial}`;
  try {
    const result = await mermaid.render(id, source, target);
    // 这里只插入 Mermaid 在 strict 模式下生成的 SVG，不插入用户标签 HTML。
    target.innerHTML = result.svg;
  } finally { document.getElementById(`d${id}`)?.remove(); }
};
const app = document.getElementById('app')!;
let playground = createPlayground(app, findMermaidBlocks(example)[0]!.source, renderNative);
for (const [id, source] of [['style-example', example], ['layout-example', layoutExample]]) {
  document.getElementById(id!)!.addEventListener('click', () => {
    playground.dispose();
    playground = createPlayground(app, findMermaidBlocks(source!)[0]!.source, renderNative);
  });
}
