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
  for (const unsupported of ['A & B --> C', 'A@{shape: rect}', 'A -->', 'A ~~~ B']) {
    assert.throws(() => parseFlowchart(`flowchart TD\n${unsupported}`), /：/);
  }
  assert.throws(() => parseFlowchart('sequenceDiagram\nA->>B: hi'));
});
test('读取常见的形状、线型、样式语句、分号和前置配置', () => {
  const graph = parseFlowchart([
    '---', 'title: 示例', '---', '%%{init: {"theme": "dark"}}%%', 'graph LR;',
    '  A((圆形)) -.-> B([体育场]) ==> C[[子程序]]', '  C --o D[(数据库)] --x E{{六边形}}',
    '  E -- 是 --> F>旗帜] -. 可选 .-> G[/平行四边形/]', '  G == 重要 ==> H{判断?} <--> I(圆角)',
    '  H -->|"带引号"| J["#quot;实体#quot;"]:::red', '  1 --> 开始', '  classDef red fill:#f00;', '  style A fill:#0f0',
    '  linkStyle 0 stroke:red', '  click A callback', '  K{无引号菱形}',
  ].join('\n'));
  const node = (id: string) => graph.nodes.find(n => n.id === id)!;
  assert.equal(graph.direction, 'LR');
  assert.deepEqual(graph.nodes.map(n => n.id), ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I', 'J', '1', '开始', 'K']);
  assert.equal(node('A').shape, 'round'); assert.equal(node('A').label, '圆形');
  assert.equal(node('H').shape, 'diamond'); assert.equal(node('K').shape, 'diamond'); assert.equal(node('K').label, '无引号菱形');
  assert.equal(node('J').label, '"实体"');
  assert.deepEqual(graph.edges.map(e => [e.link, e.style, e.arrow, e.label]), [
    ['-.->', 'dotted', true, ''], ['==>', 'thick', true, ''], ['--o', 'solid', false, ''], ['--x', 'solid', false, ''],
    ['-->', 'solid', true, '是'], ['-.->', 'dotted', true, '可选'], ['==>', 'thick', true, '重要'], ['<-->', 'solid', true, ''],
    ['-->', 'solid', true, '带引号'], ['-->', 'solid', true, ''],
  ]);
});
test('不带方向的 flowchart 默认自上而下；子图可以只写标题', () => {
  const graph = parseFlowchart('flowchart\nsubgraph 一个 带空格的标题\nA\nend\nsubgraph "引号标题"\nB\nend');
  assert.equal(graph.direction, 'TB');
  assert.deepEqual(graph.groups.map(g => g.title), ['一个 带空格的标题', '引号标题']);
  assert.equal(graph.nodes[0]!.parent, '一个 带空格的标题');
});
test('无法识别时说明是哪一行', () => {
  assert.throws(() => parseFlowchart('flowchart TD\nA --> B\nA & B --> C'), /A & B --> C/);
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
