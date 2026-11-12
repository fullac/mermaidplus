// 用途：验证可视化编辑动作只改动相关行，并保持图的其余结构、子图归属、缩进、注释和行尾不变。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseFlowchart, findMermaidBlocks } from '../src/flowchart';
import { addEdge, addNode, changedLines, deleteEdge, deleteNode, setEdgeLabel, setNodeLabel, toRawLabel } from '../src/edit';
import { readAnnotations, setNodeStyles } from '../src/annotations';

const subgraph = findMermaidBlocks(readFileSync(new URL('../examples/subgraph.md', import.meta.url), 'utf8'))[0]!.source;
const parents = (source: string) => Object.fromEntries(parseFlowchart(source).nodes.map(n => [n.id, n.parent ?? null]));
const diffCount = (a: string, b: string) => { const c = changedLines(a, b); return { removed: c.to - c.from, added: c.lines.length }; };

test('改节点文字只替换标签内文字，换行写回 <br/>', () => {
  const next = setNodeLabel(subgraph, 'FA1_SIMPLE', 'FA1\n新的说明').source;
  assert.deepEqual(diffCount(subgraph, next), { removed: 1, added: 1 });
  assert.match(next, /^ {16}FA1_SIMPLE\["FA1<br\/>新的说明"\]$/m);
  assert.equal(parseFlowchart(next).nodes.find(n => n.id === 'FA1_SIMPLE')!.label, 'FA1\n新的说明');
  assert.deepEqual(parents(next), parents(subgraph));
});

test('无显式文字的节点在首次出现处补上标签；不带引号的方括号改为带引号', () => {
  assert.equal(setNodeLabel('flowchart TD\nA --> B\nB --> C', 'B', '乙').source, 'flowchart TD\nA --> B["乙"]\nB --> C');
  assert.equal(setNodeLabel('flowchart TD\nA[旧] --> B', 'A', '新(1)').source, 'flowchart TD\nA["新(1)"] --> B');
  assert.equal(setNodeLabel('flowchart TD\nA("旧") --> B{"判断"}', 'B', '是否').source, 'flowchart TD\nA("旧") --> B{"是否"}');
});

test('节点被多次定义时改的是最终生效的那一处', () => {
  const source = 'flowchart TD\nA["一"]\nA["二"] --> B';
  assert.equal(setNodeLabel(source, 'A', '三').source, 'flowchart TD\nA["一"]\nA["三"] --> B');
});

test('非法字符和空文字被拒绝', () => {
  assert.throws(() => toRawLabel('含"引号', 'node'));
  assert.equal(toRawLabel('<b>粗</b>', 'node'), '<b>粗</b>');
  assert.throws(() => toRawLabel('a|b', 'edge'));
  assert.throws(() => toRawLabel('  \n ', 'node'));
});

test('改字时样式注释跟随：仍存在的片段保留，消失的片段丢弃', () => {
  let source = 'flowchart TD\nA["调用 getUser() 后返回"]';
  source = setNodeStyles(source, 'A', '调用 getUser() 后返回', [{ text: 'getUser()', type: 'code' }, { text: '返回', type: 'bold' }]);
  const next = setNodeLabel(source, 'A', '先调用 getUser()').source;
  const annotation = readAnnotations(next).annotations[0]!;
  assert.equal(annotation.label, '先调用 getUser()');
  assert.deepEqual(annotation.styles, [{ text: 'getUser()', type: 'code' }]);
  const gone = setNodeLabel(source, 'A', '全新文字').source;
  assert.equal(readAnnotations(gone).annotations.length, 0);
  assert.doesNotMatch(gone, /mermaid-plus/);
});

test('改连线文字：新增、修改、清空', () => {
  assert.equal(setEdgeLabel('flowchart TD\nA --> B', 0, '是').source, 'flowchart TD\nA -->|是| B');
  assert.equal(setEdgeLabel('flowchart TD\nA -->|是| B --- C', 1, '否').source, 'flowchart TD\nA -->|是| B ---|否| C');
  assert.equal(setEdgeLabel('flowchart TD\nA -->|是| B', 0, '').source, 'flowchart TD\nA --> B');
  const next = setEdgeLabel(subgraph, 6, '调用\n工具').source;
  assert.equal(parseFlowchart(next).edges[6]!.label, '调用\n工具');
  assert.deepEqual(diffCount(subgraph, next), { removed: 1, added: 1 });
});

test('新增节点：顶层追加在样式注释之前；从子图内节点引出时放进同一子图并沿用缩进', () => {
  const plain = 'flowchart TD\n  A --> B\n%% mermaid-plus: {"version":1,"node":"A","label":"A","styles":[]}';
  const top = addNode(plain, '丙');
  assert.equal(top.source, 'flowchart TD\n  A --> B\n  N1["丙"]\n%% mermaid-plus: {"version":1,"node":"A","label":"A","styles":[]}');
  assert.deepEqual(top.select, { node: 'N1' });

  const inner = addNode(subgraph, '新执行对象', 'FA2_SIMPLE');
  const chart = parseFlowchart(inner.source);
  assert.equal(chart.nodes.find(n => n.id === 'N1')!.parent, 'POOL_SIMPLE');
  assert.match(inner.source, /^ {16}FA2_SIMPLE --> N1\["新执行对象"\]\n {12}end$/m);
  const { N1: _, ...rest } = parents(inner.source);
  assert.deepEqual(rest, parents(subgraph));
});

test('新增连线写在顶层，不改变任何节点的子图归属', () => {
  const next = addEdge(subgraph, 'JAIL1_SIMPLE', 'MA');
  const chart = parseFlowchart(next.source);
  assert.equal(chart.edges.length, 10);
  assert.deepEqual(next.select, { edge: 9 });
  assert.deepEqual(parents(next.source), parents(subgraph));
  assert.deepEqual(diffCount(subgraph, next.source), { removed: 0, added: 1 });
});

test('删除链式连线中间一段，两侧连线原文保留', () => {
  assert.equal(deleteEdge('flowchart TD\nA -->|一| B --> C -->|三| D', 1).source, 'flowchart TD\nA -->|一| B\nC -->|三| D');
});

test('删除连线时，只在这里出现或在这里定义文字的节点单独保留', () => {
  assert.equal(deleteEdge('flowchart TD\nA["甲"] --> B["乙"]', 0).source, 'flowchart TD\nA["甲"]\nB["乙"]');
  assert.equal(deleteEdge('flowchart TD\nA\nA --> B\nB --> C', 1).source, 'flowchart TD\nA\nA --> B\nC');
  assert.equal(deleteEdge('flowchart TD\n  A --> B\n  A --> C', 0).source, 'flowchart TD\n  B\n  A --> C');
});

test('删除节点：去掉相关连线和样式注释，其余节点、子图归属保持不变', () => {
  let source = setNodeStyles(subgraph, 'TG', 'Tool Gateway<br/>工具调用路由', [{ text: 'Tool', type: 'bold' }]);
  const next = deleteNode(source, 'TG').source;
  const chart = parseFlowchart(next);
  assert.equal(chart.nodes.some(n => n.id === 'TG'), false);
  assert.equal(chart.edges.length, 6);
  assert.ok(chart.nodes.some(n => n.id === 'JAVA'));
  assert.doesNotMatch(next, /"node":"TG"/);
  const { TG: _, ...rest } = parents(subgraph);
  assert.deepEqual(parents(next), rest);
});

test('删除链中节点：两侧节点保留', () => {
  assert.equal(deleteNode('flowchart LR\nA --> B --> C', 'B').source, 'flowchart LR\nA\nC');
  assert.equal(deleteNode('flowchart LR\nA --> B --> C\nA --> C', 'B').source, 'flowchart LR\nA --> C');
  assert.throws(() => deleteNode('flowchart LR\nA', 'A'));
});

test('自环连线可以删除', () => {
  assert.equal(deleteEdge('flowchart TD\nA["甲"] --> A', 0).source, 'flowchart TD\nA["甲"]');
});

test('保留 CRLF 行尾', () => {
  const next = setNodeLabel('flowchart TD\r\nA --> B\r\n', 'A', '甲').source;
  assert.equal(next, 'flowchart TD\r\nA["甲"] --> B\r\n');
});

test('changedLines 只给出首尾不同的中间部分', () => {
  assert.deepEqual(changedLines('a\nb\nc\nd', 'a\nB\nX\nd'), { from: 1, to: 3, lines: ['B', 'X'] });
  assert.deepEqual(changedLines('a\nb', 'a\nb\nc'), { from: 2, to: 2, lines: ['c'] });
});

test('改字和改连线文字保留原有形状括号与线型', () => {
  assert.equal(setNodeLabel('flowchart TD\nA((圆)) --> B{判断}', 'A', '新').source, 'flowchart TD\nA(("新")) --> B{判断}');
  assert.equal(setNodeLabel('flowchart TD\nA:::red --> B{判断}', 'B', '是否').source, 'flowchart TD\nA:::red --> B{"是否"}');
  assert.equal(setEdgeLabel('flowchart TD\nA -.-> B', 0, '可选').source, 'flowchart TD\nA -.->|可选| B');
  assert.equal(setEdgeLabel('flowchart TD\nA == 旧 ==> B', 0, '新').source, 'flowchart TD\nA ==>|新| B');
  assert.equal(setEdgeLabel('flowchart TD\nA -. 旧 .-> B', 0, '').source, 'flowchart TD\nA -.-> B');
});

test('样式语句原样保留，删除节点不影响它们', () => {
  const source = 'graph TD;\n  A[甲] --> B[乙];\n  classDef red fill:#f00\n  class A red\n  style B fill:#0f0';
  assert.equal(deleteEdge(source, 0).source, 'graph TD;\n  A[甲]\n  B[乙]\n  classDef red fill:#f00\n  class A red\n  style B fill:#0f0');
});
