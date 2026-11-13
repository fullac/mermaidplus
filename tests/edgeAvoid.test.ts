// 用途：验证连线避让文字的几何部分：路径拆分、压字判断、直角和曲线两种找路都绕开文字并保持起止方向。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { shiftPath, lineHops, flattenPath, overlapLength, polylineHits, rerouteEdge, type Box, type Point } from '../src/edgeAvoid';

test('拆分 Mermaid 路径：直线、圆角、跳线和曲线', () => {
  assert.deepEqual(flattenPath('M0,0L10,0L10,20'), [{ x: 0, y: 0 }, { x: 10, y: 0 }, { x: 10, y: 20 }]);
  const elk = flattenPath('M245.43,449L245.43,456Q245.43,463 238.43,463L178.03,463A5,5,0,0,1,170,463L100,463');
  assert.deepEqual(elk.at(-1), { x: 100, y: 463 });
  assert.ok(elk.length > 8);
  const curve = flattenPath('M0,0C0,50,100,50,100,100');
  assert.deepEqual(curve.at(-1), { x: 100, y: 100 });
  assert.deepEqual(flattenPath('M0,0X5'), []);
});

test('线段穿过框才算压到，只贴着边不算', () => {
  const box: Box = { x: 10, y: 10, width: 10, height: 10 };
  assert.equal(overlapLength({ x: 0, y: 15 }, { x: 30, y: 15 }, box), 10);
  assert.equal(overlapLength({ x: 0, y: 10 }, { x: 30, y: 10 }, box), 0);
  assert.equal(overlapLength({ x: 0, y: 0 }, { x: 5, y: 30 }, box), 0);
});

function distToSegment(p: Point, a: Point, b: Point) {
  const dx = b.x - a.x, dy = b.y - a.y, l = dx * dx + dy * dy;
  const t = l ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l)) : 0;
  return Math.hypot(p.x - a.x - t * dx, p.y - a.y - t * dy);
}

const text: Box = { x: 80, y: 90, width: 40, height: 20 };
const straight: Point[] = [{ x: 100, y: 0 }, { x: 100, y: 200 }];

for (const orthogonal of [true, false]) {
  test(`${orthogonal ? '直角' : '曲线'}：压字的线绕开文字，起止点和方向不变`, () => {
    const route = rerouteEdge(straight, [text], [], orthogonal)!;
    assert.ok(route, '应当重新找路');
    assert.ok(!polylineHits(route.points, [text]));
    assert.deepEqual(route.points[0], straight[0]);
    assert.deepEqual(route.points.at(-1), straight[1]);
    // 先沿原方向（向下）离开，最后也向下进入。
    assert.ok(route.points[1]!.y > 0 && Math.abs(route.points[1]!.x - 100) < 1e-6);
    const last = route.points.at(-2)!;
    assert.ok(last.y < 200 && Math.abs(last.x - 100) < 1e-6);
    if (orthogonal) {
      const segs = route.d.match(/L[^LQ]+/g)!;
      assert.ok(segs.length >= 3);
    }
  });
}

test('不压字的线不改；经过自己的文字中心', () => {
  assert.equal(rerouteEdge([{ x: 0, y: 0 }, { x: 0, y: 200 }], [text], [], true), undefined);
  const via = { x: 40, y: 100 };
  const route = rerouteEdge(straight, [text], [], true, via)!;
  const near = route.points.some((p, i) => i > 0 && distToSegment(via, route.points[i - 1]!, p) < 0.5);
  assert.ok(near, '应当经过自己的文字中心');
  assert.ok(!polylineHits(route.points, [text]));
});

test('两段文字之间有缝时从缝里穿过，不绕大圈', () => {
  const left: Box = { x: 40, y: 90, width: 50, height: 20 }, right: Box = { x: 120, y: 90, width: 50, height: 20 };
  const middle: Box = { x: 92, y: 60, width: 16, height: 10 };
  const route = rerouteEdge([{ x: 100, y: 0 }, { x: 100, y: 200 }], [left, right, middle], [], true)!;
  assert.ok(!polylineHits(route.points, [left, right, middle]));
  assert.ok(Math.max(...route.points.map(p => p.x)) < 120 && Math.min(...route.points.map(p => p.x)) > 90);
});

for (const orthogonal of [true, false]) {
  test(`${orthogonal ? '直角' : '曲线'}：只碰到节点空白边缘也绕开整个外框`, () => {
    const card = { x: 80, y: 70, width: 80, height: 70 };
    const label = { x: 120, y: 90, width: 30, height: 20 };
    const route = rerouteEdge(straight, [label], [card], orthogonal)!;
    assert.ok(route);
    assert.equal(polylineHits(route.points, [card]), false);
  });
  test(`${orthogonal ? '直角' : '曲线'}：允许离开自己的节点和子图，但不穿过无关子图`, () => {
    const own = { x: 60, y: -20, width: 80, height: 60 };
    const other = { x: 80, y: 70, width: 80, height: 70 };
    const route = rerouteEdge(straight, [], [own, other], orthogonal)!;
    assert.ok(route);
    assert.equal(polylineHits(route.points, [other]), false);
    assert.deepEqual(route.points[0], straight[0]);
  });
}
test('旧连线标签被节点覆盖时放弃旧标签位置，仍能找到避让路线', () => {
  const card = { x: 80, y: 70, width: 80, height: 70 };
  const route = rerouteEdge(straight, [], [card], true, { x: 100, y: 100 })!;
  assert.ok(route);
  assert.equal(polylineHits(route.points, [card]), false);
});

for (const mode of ['arc', 'gap', 'none'] as const) {
  test(`全图重算交叉：${mode} 只处理一个方向，离开交点后恢复`, () => {
    const routes = [[{ x: 50, y: 0 }, { x: 50, y: 100 }], [{ x: 0, y: 50 }, { x: 100, y: 50 }]];
    const result = lineHops(routes, mode);
    assert.equal(result[0]!.d.includes('A'), false);
    assert.equal(result[1]!.d.includes('A'), mode === 'arc');
    assert.equal(result[1]!.gaps.length, mode === 'gap' ? 1 : 0);
    routes[0] = [{ x: 150, y: 0 }, { x: 150, y: 100 }];
    const moved = lineHops(routes, mode)[1]!;
    assert.equal(moved.d.includes('A'), false);
    assert.equal(moved.gaps.length, 0);
  });
}
test('共享端点、平行线和共线不生成跳线', () => {
  const paths = [[{ x: 0, y: 0 }, { x: 100, y: 0 }], [{ x: 100, y: 0 }, { x: 100, y: 100 }], [{ x: 20, y: 0 }, { x: 80, y: 0 }]];
  assert.ok(lineHops(paths, 'arc').every(p => !p.d.includes('A')));
});

test('带子图平移的跳线仅移动端点，不改弧半径和标志位', () => {
  assert.equal(shiftPath('M10,20L20,20A5,5,0,0,1,30,20H40V50', -10, 7), 'M0,27L10,27A5,5,0,0,1,20,27H30V57');
});

test('相对路径仅平移首个 moveto，不改变其余增量和弧参数', () => {
  assert.equal(shiftPath('M10,20l5,5', 100, 100), 'M110,120l5,5');
  assert.equal(shiftPath('m10,20 5,5h7v8q1,2,3,4c1,2,3,4,5,6a5,6,45,0,1,7,8z', 100, -10), 'm110,10 5,5h7v8q1,2,3,4c1,2,3,4,5,6a5,6,45,0,1,7,8z');
  assert.equal(shiftPath('M0,0A5,5,0,0,1,10,20 5,5,0,0,1,30,40S10,20,30,40T50,60', 10, 20), 'M10,20A5,5,0,0,1,20,40 5,5,0,0,1,40,60S20,40,40,60T60,80');
});

for (const orthogonal of [true, false]) test(`触发和验收都要求 3px 间距（${orthogonal}）`, () => {
  const box = { x: 80, y: 90, width: 40, height: 20 };
  const route = rerouteEdge([{ x: 78, y: 0 }, { x: 78, y: 200 }], [box], [], orthogonal)!;
  assert.ok(route);
  assert.equal(polylineHits(route.points, [{ x: 77, y: 87, width: 46, height: 26 }]), false);
});

test('超预算或局部障碍超过阈值时保留原线，不升级全图搜索', () => {
  const points = [{ x: 100, y: 0 }, { x: 100, y: 200 }];
  assert.equal(rerouteEdge(points, [text], [], true, undefined, 0), undefined);
  const crowded = Array.from({ length: 65 }, (_, i) => ({ x: 80 + i / 10, y: 90, width: 40, height: 20 }));
  assert.equal(rerouteEdge(points, [], crowded, true), undefined);
});
