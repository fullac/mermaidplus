// 用途：验证实验语法边界和 Markdown 代码块定位，防止误读或静默丢弃原文。
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseFlowchart, findMermaidBlocks } from '../src/flowchart';

test('读取中文标签、节点形状、连接文字和链式连线', () => {
  const graph = parseFlowchart('flowchart LR\nA["开始"] --> B{"成功？"}\nB -->|是| C("结束") --> A');
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.nodes[1]?.shape, 'diamond');
  assert.equal(graph.nodes[2]?.shape, 'round');
  assert.equal(graph.edges[1]?.label, '是');
  assert.equal(graph.edges[2]?.to, 'A');
});
test('未知语法不能静默变成不完整的图', () => {
  for (const unsupported of ['subgraph group\nA\nend', 'A -.-> B', 'A---oB', 'A---xB', 'classDef red fill:red', 'A["x"]:::red', 'A@{shape: rect}']) {
    assert.throws(() => parseFlowchart(`flowchart TD\n${unsupported}`));
  }
});
test('样式注释不参与图的结构解析', () => {
  const graph = parseFlowchart('graph TD\nA --> B\n%% mermaid-plus: {broken json}');
  assert.equal(graph.nodes.length, 2);
  assert.equal(graph.edges.length, 1);
});
test('代码示例中的内层 mermaid 不视为实际代码块', () => {
  const md = '````text\n```mermaid\nflowchart LR\nA-->B\n```\n````\n~~~mermaid\nflowchart TD\nC\n~~~';
  assert.deepEqual(findMermaidBlocks(md), [{ source: 'flowchart TD\nC', start: 6, end: 9 }]);
});
test('未闭合围栏不作为可操作的代码块', () => {
  assert.deepEqual(findMermaidBlocks('```mermaid\nA'), []);
});
