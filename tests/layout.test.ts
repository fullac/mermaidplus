// 用途：验证自动排版的节点避让、直角走线、文字留位、方向和回路处理。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ELK from 'elkjs/lib/elk.bundled.js';
import { findMermaidBlocks, parseFlowchart } from '../src/flowchart';
import { layoutFlowchart, edgePath, defaultLayoutSettings, type PositionedNode } from '../src/layout';

const source = findMermaidBlocks(readFileSync('examples/auto-layout.md', 'utf8'))[0]!.source;
const chart = parseFlowchart(source);
const sizes = new Map(chart.nodes.map(node => [node.id, { width: node.shape === 'diamond' ? 240 : 210, height: node.shape === 'diamond' ? 130 : 75 }]));
const labels = chart.edges.map(edge => ({ width: edge.label.length * 14 + 12, height: 25 }));
const engine = new ELK({ algorithms: ['layered'] });
const overlaps = (a: PositionedNode, b: PositionedNode) => a.x < b.x + b.width - .1 && a.x + a.width > b.x + .1 && a.y < b.y + b.height - .1 && a.y + a.height > b.y + .1;

for (const direction of ['TB', 'BT', 'LR', 'RL']) test(`${direction}：节点不重叠，连线直角且不穿过其他节点`, async () => {
  const layout = await layoutFlowchart({ ...chart, direction }, sizes, labels, { ...defaultLayoutSettings, direction: 'source' }, { width: 600, height: 700 }, graph => engine.layout(graph));
  assert.equal(layout.nodes.length, chart.nodes.length);
  assert.equal(layout.edges.length, chart.edges.length);
  for (let i = 0; i < layout.nodes.length; i++) for (let j = i+1; j < layout.nodes.length; j++) assert.equal(overlaps(layout.nodes[i]!, layout.nodes[j]!), false);
  for (const route of layout.edges) {
    const edge = chart.edges[route.index]!;
    assert.ok(route.points.length >= 2);
    for (let i = 1; i < route.points.length; i++) {
      const a = route.points[i-1]!, b = route.points[i]!;
      assert.ok(Math.abs(a.x-b.x) < .01 || Math.abs(a.y-b.y) < .01, '仅允许水平或垂直段');
      for (const node of layout.nodes.filter(n => n.id !== edge.from && n.id !== edge.to)) {
        const crosses = Math.abs(a.x-b.x) < .01
          ? a.x > node.x + .1 && a.x < node.x + node.width - .1 && Math.max(a.y,b.y) > node.y + .1 && Math.min(a.y,b.y) < node.y + node.height - .1
          : a.y > node.y + .1 && a.y < node.y + node.height - .1 && Math.max(a.x,b.x) > node.x + .1 && Math.min(a.x,b.x) < node.x + node.width - .1;
        assert.equal(crosses, false, `${edge.from} → ${edge.to} 不能穿过 ${node.id}`);
      }
    }
    if (edge.label) {
      assert.ok(route.label);
      for (const node of layout.nodes) assert.equal(overlaps({ id: 'label', ...route.label! }, node), false, '连线文字不能盖住节点');
    }
  }
});

test('自环和重复连线全部保留；自动方向不改输入结构', async () => {
  const graph = parseFlowchart('flowchart TD\nA --> A\nA -->|first| B\nA -->|second| B');
  const original = JSON.stringify(graph);
  const layout = await layoutFlowchart(graph, new Map(graph.nodes.map(n => [n.id, { width: 140, height: 60 }])), graph.edges.map(() => ({ width: 70, height: 24 })), defaultLayoutSettings, { width: 500, height: 650 }, graph => engine.layout(graph));
  assert.equal(layout.edges.length, 3);
  assert.ok(layout.edges[0]!.points.length >= 4);
  assert.equal(JSON.stringify(graph), original);
});

test('圆角路径保持首尾端点；重复折点不产生无效坐标', () => {
  const points = [{ x: 0, y: 0 }, { x: 0, y: 30 }, { x: 0, y: 30 }, { x: 40, y: 30 }];
  assert.equal(edgePath(points, 8), 'M 0 0 L 0 22 Q 0 30 8 30 L 40 30');
  assert.equal(edgePath(points, 0), 'M 0 0 L 0 30 L 40 30');
});

test('分支与汇合使用独立接点，菱形接点落在实际斜边上', async () => {
  const graph = parseFlowchart('flowchart TD\nA{"选择"} --> B\nA --> C\nB --> D\nC --> D');
  const nodeSizes = new Map(graph.nodes.map(n => [n.id, { width: 200, height: 100 }]));
  const layout = await layoutFlowchart(graph, nodeSizes, graph.edges.map(() => ({ width: 0, height: 0 })), { ...defaultLayoutSettings, direction: 'TB' }, { width: 600, height: 700 }, input => engine.layout(input));
  assert.notDeepEqual(layout.edges[0]!.points[0], layout.edges[1]!.points[0]);
  assert.notDeepEqual(layout.edges[2]!.points.at(-1), layout.edges[3]!.points.at(-1));
  const box = layout.nodes.find(n => n.id === 'A')!;
  for (const route of layout.edges.slice(0,2)) {
    const p = route.points[0]!;
    const distance = Math.abs((p.x-box.x-box.width/2)/(box.width/2)) + Math.abs((p.y-box.y-box.height/2)/(box.height/2));
    assert.ok(Math.abs(distance-1) < .01);
  }
});
