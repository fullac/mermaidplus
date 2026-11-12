// 用途：验证竖排改写首行、自动选方向的打分规则，以及紧凑间距写入 ELK 图的位置。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import { directionScore, pickDirection, tuneSpacing, withElkTuning, MIN_READABLE_SCALE } from '../src/elkTuning';
import { withVerticalHeader } from '../src/mermaidRender';

test('竖排：只改首行方向，没写方向时补 TD，不碰其他行', () => {
  assert.equal(withVerticalHeader('flowchart LR\n  A --> B'), 'flowchart TD\n  A --> B');
  assert.equal(withVerticalHeader('graph RL;\nA-->B'), 'graph TD;\nA-->B');
  assert.equal(withVerticalHeader('flowchart\nA-->B'), 'flowchart TD\nA-->B');
  assert.equal(withVerticalHeader('---\ntitle: x\n---\n%% note\n  flowchart BT\nsubgraph S\ndirection LR\nend'), '---\ntitle: x\n---\n%% note\n  flowchart TD\nsubgraph S\ndirection LR\nend');
  assert.equal(withVerticalHeader('flowchart-elk LR\nA-->B'), 'flowchart-elk LR\nA-->B');
});

test('打分：缩到栏宽后的高度；字太小记为 Infinity', () => {
  assert.equal(directionScore(400, 300, 800), 300);
  assert.equal(directionScore(1000, 300, 800), 240);
  assert.equal(directionScore(800 / (MIN_READABLE_SCALE - 0.01), 100, 800), Infinity);
  assert.equal(directionScore(0, 100, 800), Infinity);
});

test('选方向：明显更好才换，差不多或都看不清时沿用源码', () => {
  assert.equal(pickDirection('RIGHT', 1000, 'DOWN', 500), 'DOWN');
  assert.equal(pickDirection('RIGHT', 1000, 'DOWN', 950), 'RIGHT');
  assert.equal(pickDirection('RIGHT', Infinity, 'DOWN', 900), 'DOWN');
  assert.equal(pickDirection('RIGHT', Infinity, 'DOWN', Infinity), 'RIGHT');
});

const sample = (): ElkNode => ({
  id: 'root', layoutOptions: { 'spacing.baseValue': '40', 'elk.direction': 'RIGHT' },
  children: [
    { id: 'g', layoutOptions: { 'spacing.nodeNode': '50' }, children: [{ id: 'a', width: 80, height: 30 }, { id: 'b', width: 80, height: 30 }] },
    { id: 'pack', layoutOptions: { 'elk.algorithm': 'elk.rectpacking', 'spacing.nodeNode': '15' }, children: [{ id: 'c', width: 80, height: 30 }] },
    { id: 'd', width: 80, height: 30 },
  ],
  edges: [{ id: 'e1', sources: ['a'], targets: ['d'] }, { id: 'e2', sources: ['b'], targets: ['c'] }],
});

test('紧凑：改写根和普通子图的间距，保留 rectpacking 容器；宽松不改', () => {
  const g = sample();
  tuneSpacing(g, 'compact');
  assert.equal(g.layoutOptions!['spacing.baseValue'], '20');
  assert.equal(g.layoutOptions!['elk.layered.compaction.postCompaction.strategy'], 'EDGE_LENGTH');
  assert.equal(g.children![0]!.layoutOptions!['spacing.nodeNode'], '20');
  assert.equal(g.children![1]!.layoutOptions!['spacing.nodeNode'], '15');
  const loose = sample();
  tuneSpacing(loose, 'loose');
  assert.deepEqual(loose, sample());
});

test('接管 elkjs：竖排强制 DOWN，渲染结束后恢复原样', async () => {
  const elk = new ELK();
  const tuned = await withElkTuning({ density: 'compact', vertical: true, autoDirection: false, availableWidth: 800 }, () => elk.layout(sample()));
  assert.equal(tuned.layoutOptions!['elk.direction'], 'DOWN');
  const plain = await elk.layout(sample());
  assert.equal(plain.layoutOptions!['elk.direction'], 'RIGHT');
  assert.equal(plain.layoutOptions!['spacing.baseValue'], '40');
});

test('自动选方向：一条长链在窄栏里改成竖排', async () => {
  const children = Array.from({ length: 12 }, (_, i) => ({ id: `n${i}`, width: 100, height: 40 }));
  const edges = children.slice(1).map((n, i) => ({ id: `e${i}`, sources: [`n${i}`], targets: [n.id] }));
  const chain = (): ElkNode => ({ id: 'root', layoutOptions: { 'elk.direction': 'RIGHT' }, children: structuredClone(children), edges: structuredClone(edges) });
  const result = await withElkTuning({ density: 'compact', vertical: false, autoDirection: true, availableWidth: 700 }, () => new ELK().layout(chain()));
  assert.equal(result.layoutOptions!['elk.direction'], 'DOWN');
  const wide = await withElkTuning({ density: 'compact', vertical: false, autoDirection: true, availableWidth: 4000 }, () => new ELK().layout(chain()));
  assert.equal(wide.layoutOptions!['elk.direction'], 'RIGHT');
});
