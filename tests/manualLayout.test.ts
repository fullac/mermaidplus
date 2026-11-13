// 用途：验证位置注释的读写（只改一行、零偏移删除、损坏时忽略）、删节点时一并清除位置，以及连线重画的走法。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearLayout, readLayout, routeEdge, setNodeOffset, writeLayout } from '../src/manualLayout';
import { deleteNode } from '../src/edit';

const src = 'flowchart TD\n  A[开始] --> B[结束]\n';

test('写入位置：追加在末尾空行之前，沿用缩进，取整', () => {
  const next = setNodeOffset(src, 'A', 12.4, -30.6);
  assert.equal(next, 'flowchart TD\n  A[开始] --> B[结束]\n  %% mermaid-plus-layout: {"version":1,"nodes":{"A":[12,-31]}}\n');
  assert.deepEqual(readLayout(next).nodes, { A: [12, -31] });
});

test('再次写入只改注释那一行，保留 CRLF', () => {
  const crlf = setNodeOffset(src.replace(/\n/g, '\r\n'), 'A', 10, 0);
  const next = setNodeOffset(crlf, 'B', 0, 20);
  assert.equal(next.split('\r\n').length, crlf.split('\r\n').length);
  assert.deepEqual(readLayout(next).nodes, { A: [10, 0], B: [0, 20] });
});

test('偏移归零或清除后删掉注释行，源码复原', () => {
  const moved = setNodeOffset(src, 'A', 10, 10);
  assert.equal(setNodeOffset(moved, 'A', 0, 0), src);
  assert.equal(clearLayout(moved, 'A'), src);
  assert.equal(clearLayout(setNodeOffset(moved, 'B', 5, 5)), src);
  assert.equal(clearLayout(src, 'A'), src);
});

test('损坏或版本不对的注释被忽略，下次写入时替换', () => {
  const broken = src + '%% mermaid-plus-layout: {oops\n';
  assert.deepEqual(readLayout(broken).nodes, {});
  assert.deepEqual(readLayout(src + '%% mermaid-plus-layout: {"version":2,"nodes":{"A":[1,1]}}').nodes, {});
  assert.deepEqual(readLayout(src + '%% mermaid-plus-layout: {"version":1,"nodes":{"A":[1,"x"],"B":[2,3]}}').nodes, { B: [2, 3] });
  const fixed = setNodeOffset(broken, 'A', 3, 4);
  assert.equal(fixed.match(/mermaid-plus-layout/g)!.length, 1);
  assert.deepEqual(readLayout(fixed).nodes, { A: [3, 4] });
  assert.equal(writeLayout(fixed, {}), src);
});

test('删除节点时去掉它的位置，保留其他节点的', () => {
  const moved = setNodeOffset(setNodeOffset('flowchart TD\n  A --> B\n  B --> C\n', 'B', 5, 5), 'C', 7, 7);
  const after = deleteNode(moved, 'B').source;
  assert.deepEqual(readLayout(after).nodes, { C: [7, 7] });
});

test('连线：上下对齐时直连，箭头端留 4px', () => {
  const r = routeEdge({ x: 0, y: 0, width: 100, height: 40 }, { x: 0, y: 100, width: 100, height: 40 }, true);
  assert.equal(r.d, 'M50,40L50,96');
});

test('连线：错开时直角走 Z 字形，曲线模式用三次贝塞尔', () => {
  const a = { x: 0, y: 0, width: 100, height: 40 }, b = { x: 300, y: 300, width: 100, height: 40 };
  const ortho = routeEdge(a, b, true);
  assert.equal(ortho.d, 'M50,40L50,168L350,168L350,296');
  assert.deepEqual(ortho.label, { x: 200, y: 168 });
  assert.match(routeEdge(a, b, false).d, /^M50,40C/);
  // 左右间隔更大时横向出发。
  const side = routeEdge(a, { x: 400, y: 20, width: 100, height: 40 }, true, { start: 0, end: 0 });
  assert.equal(side.d, 'M100,30L400,30');
});

test('图类型：流程图和时序图由插件渲染，其他类型不接管', async () => {
  const { diagramKind, isPluginSource, isFlowchartSource } = await import('../src/mermaidRender');
  assert.equal(diagramKind('flowchart LR\n A-->B'), 'flowchart');
  assert.equal(diagramKind('%% 注释\n\ngraph TD\n A-->B'), 'flowchart');
  assert.equal(diagramKind('---\ntitle: 登录\n---\nsequenceDiagram\n A->>B: 你好'), 'sequence');
  assert.equal(diagramKind('classDiagram\n A <|-- B'), undefined);
  assert.ok(isPluginSource('sequenceDiagram\n A->>B: hi'));
  assert.ok(!isFlowchartSource('sequenceDiagram\n A->>B: hi'));
});
