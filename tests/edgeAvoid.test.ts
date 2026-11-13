// 用途：验证连线避让文字的几何部分：路径拆分、压字判断、直角和曲线两种找路都绕开文字并保持起止方向。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { flattenPath, overlapLength, polylineHits, rerouteEdge, type Box, type Point } from '../src/edgeAvoid';

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
