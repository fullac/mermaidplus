// 用途：连线避让文字。Mermaid 排完版后，凡是压到节点文字、连线文字或子图标题的连线，按原来的起点、终点和出入方向重新找路：
// 直角走线在网格上找拐弯少的路，曲线在障碍物角点之间找最短路再圆滑。无关节点和子图外框同样作为障碍，允许连线出入自己的端点及所属子图。
// 另外把连线移到节点之上、连线文字移到最上层，保证线不被节点盖住、线也不盖住自己的文字。

export interface Point { x: number; y: number }
export interface Box { x: number; y: number; width: number; height: number }

/** 判断是否压字时，文字框向外扩的距离。 */
const CLEAR = 4;
/** 直角走线贴着障碍物绕行时离文字的距离。 */
const ROUTE_GAP = 8;
/** 曲线绕行时离文字角的距离（圆角会往里收一点，所以比直角大）。 */
const CURVE_GAP = 12;
/** 每拐一个弯相当于多走的长度。 */
const BEND_COST = 30;
/** 路由有硬上限：大图宁可保留原线，也不阻塞界面。时间预算在循环中协作检查。 */
export const ROUTING_LIMITS = { diagramMs: 120, dragMs: 4, edgeMs: 12, obstacles: 64, gridCells: 16_384 } as const;
/** 找路时先只考虑这条线外框向外这么远以内的障碍物。 */
const NEAR = 120;

export const inflate = (b: Box, m: number): Box => ({ x: b.x - m, y: b.y - m, width: b.width + 2 * m, height: b.height + 2 * m });
const inside = (p: Point, b: Box) => p.x > b.x && p.x < b.x + b.width && p.y > b.y && p.y < b.y + b.height;
const dist = (a: Point, b: Point) => Math.hypot(a.x - b.x, a.y - b.y);
const round = (n: number) => Math.round(n * 100) / 100;
const fmt = (p: Point) => `${round(p.x)},${round(p.y)}`;

/** 线段落在框内部的长度（只碰到边不算）。 */
export function overlapLength(a: Point, b: Point, box: Box): number {
  if (Math.max(a.x, b.x) <= box.x || Math.min(a.x, b.x) >= box.x + box.width || Math.max(a.y, b.y) <= box.y || Math.min(a.y, b.y) >= box.y + box.height) return 0;
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y;
  const clip = (p: number, q: number) => {
    if (p === 0) return q > 0;
    const r = q / p;
    if (p < 0) { if (r > t1) return false; if (r > t0) t0 = r; }
    else { if (r < t0) return false; if (r < t1) t1 = r; }
    return true;
  };
  if (!clip(-dx, a.x - box.x) || !clip(dx, box.x + box.width - a.x) || !clip(-dy, a.y - box.y) || !clip(dy, box.y + box.height - a.y)) return 0;
  const len = (t1 - t0) * Math.hypot(dx, dy);
  if (len <= 1e-6) return 0;
  // 与框的边重合的线段不算穿过。
  const mx = a.x + dx * (t0 + t1) / 2, my = a.y + dy * (t0 + t1) / 2;
  return inside({ x: mx, y: my }, box) ? len : 0;
}
export const segmentHits = (a: Point, b: Point, box: Box) => overlapLength(a, b, box) > 0.01;
export const polylineHits = (points: Point[], boxes: Box[]) => points.some((p, i) => i > 0 && boxes.some(b => segmentHits(points[i - 1]!, p, b)));

/** 把 Mermaid 输出的路径（M L H V Q C A Z，绝对坐标）拆成折线；曲线按小段取点，跳线的小弧当作直线。 */
export function flattenPath(d: string): Point[] {
  const tokens = d.match(/[A-Za-z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? [];
  const out: Point[] = [];
  let i = 0, cmd = '', cur: Point = { x: 0, y: 0 }, start = cur;
  const num = () => Number(tokens[i++]);
  const isNum = () => i < tokens.length && !/^[A-Za-z]$/.test(tokens[i]!);
  const push = (p: Point) => { out.push(p); cur = p; };
  while (i < tokens.length) {
    if (/^[A-Za-z]$/.test(tokens[i]!)) cmd = tokens[i++]!;
    const rel = cmd === cmd.toLowerCase();
    const at = (x: number, y: number): Point => rel ? { x: cur.x + x, y: cur.y + y } : { x, y };
    switch (cmd.toUpperCase()) {
      case 'M': { const p = at(num(), num()); push(p); start = p; cmd = rel ? 'l' : 'L'; break; }
      case 'L': push(at(num(), num())); break;
      case 'H': { const x = num(); push({ x: rel ? cur.x + x : x, y: cur.y }); break; }
      case 'V': { const y = num(); push({ x: cur.x, y: rel ? cur.y + y : y }); break; }
      case 'Q': { const p0 = cur, c = at(num(), num()), p = at(num(), num()); for (let k = 1; k <= 8; k++) { const t = k / 8, u = 1 - t; push({ x: u * u * p0.x + 2 * u * t * c.x + t * t * p.x, y: u * u * p0.y + 2 * u * t * c.y + t * t * p.y }); } break; }
      case 'C': { const p0 = cur, c1 = at(num(), num()), c2 = at(num(), num()), p = at(num(), num()); for (let k = 1; k <= 12; k++) { const t = k / 12, u = 1 - t; push({ x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p.x, y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p.y }); } break; }
      case 'A': { num(); num(); num(); num(); num(); push(at(num(), num())); break; }
      case 'Z': push(start); if (isNum()) return []; break;
      default: return []; // 不认识的命令：不处理这条线。
    }
    if (!Number.isFinite(cur.x) || !Number.isFinite(cur.y)) return [];
  }
  return out.filter((p, k, all) => k === 0 || dist(p, all[k - 1]!) > 1e-6);
}

export const polylineLength = (points: Point[]) => points.reduce((sum, p, i) => i ? sum + dist(points[i - 1]!, p) : 0, 0);

/** 起点出发方向 / 终点到达方向（单位向量）。 */
function direction(from: Point, to: Point): Point {
  const l = dist(from, to) || 1;
  return { x: (to.x - from.x) / l, y: (to.y - from.y) / l };
}
const axis = (v: Point): Point => Math.abs(v.x) >= Math.abs(v.y) ? { x: Math.sign(v.x) || 1, y: 0 } : { x: 0, y: Math.sign(v.y) || 1 };

export interface RouteRequest {
  start: Point; end: Point;
  /** 起点离开的方向、终点进入的方向。 */
  startDir: Point; endDir: Point;
  /** 不能压的文字框（原始大小）。 */
  texts: Box[];
  /** 同一条线的各次搜索共享截止时间。 */
  deadline?: number;
  /** 连线自己的文字中心：给了就从这里经过，文字不用挪。 */
  via?: Point;
}

/** 直角走线：在由障碍物边线和端点坐标组成的网格上找路，代价 = 长度 + 拐弯；超出规模或时间预算时放弃。 */
export function routeOrthogonal(req: RouteRequest): Point[] | undefined {
  const legs = req.via
    ? [orthLeg(req.start, axis(req.startDir), req.via, undefined, req), orthLeg(req.via, undefined, req.end, axis(req.endDir), req)]
    : [orthLeg(req.start, axis(req.startDir), req.end, axis(req.endDir), req)];
  if (legs.some(l => !l)) return undefined;
  return simplify(legs.flatMap((l, k) => k ? l!.slice(1) : l!));
}

function orthLeg(s: Point, sDir: Point | undefined, e: Point, eDir: Point | undefined, req: RouteRequest): Point[] | undefined {
  if (req.texts.length > ROUTING_LIMITS.obstacles || performance.now() >= (req.deadline ?? Infinity)) return undefined;
  const blocks = req.texts.map(b => inflate(b, CLEAR)).filter(b => !inside(s, b) && !inside(e, b));
  const xs = new Set<number>([s.x, e.x]), ys = new Set<number>([s.y, e.y]);
  for (const b of req.texts) {
    xs.add(b.x - ROUTE_GAP); xs.add(b.x + b.width + ROUTE_GAP);
    ys.add(b.y - ROUTE_GAP); ys.add(b.y + b.height + ROUTE_GAP);
  }
  const all = [s, e, ...req.texts.flatMap(b => [{ x: b.x, y: b.y }, { x: b.x + b.width, y: b.y + b.height }])];
  const pad = ROUTE_GAP * 3;
  xs.add(Math.min(...all.map(p => p.x)) - pad); xs.add(Math.max(...all.map(p => p.x)) + pad);
  ys.add(Math.min(...all.map(p => p.y)) - pad); ys.add(Math.max(...all.map(p => p.y)) + pad);
  // 相邻坐标之间再加中线，让线能从两段文字的窄缝中间穿过。
  const withMid = (set: Set<number>) => { const v = [...set].sort((a, b) => a - b); const r = new Set(v); for (let k = 1; k < v.length; k++) if (v[k]! - v[k - 1]! > 2 * CLEAR + 2) r.add((v[k]! + v[k - 1]!) / 2); return [...r].sort((a, b) => a - b); };
  const X = withMid(xs), Y = withMid(ys);
  const W = X.length, H = Y.length;
  if (W * H > ROUTING_LIMITS.gridCells) return undefined;
  const at = (k: number): Point => ({ x: X[k % W]!, y: Y[Math.floor(k / W)]! });
  const free = new Uint8Array(W * H);
  for (let k = 0; k < W * H; k++) {
    if (k % 64 === 0 && performance.now() >= (req.deadline ?? Infinity)) return undefined;
    free[k] = blocks.some(b => inside(at(k), b)) ? 0 : 1;
  }
  const si = X.indexOf(s.x) + Y.indexOf(s.y) * W, ei = X.indexOf(e.x) + Y.indexOf(e.y) * W;
  free[si] = 1; free[ei] = 1;
  const DIRS = [{ x: 1, y: 0 }, { x: -1, y: 0 }, { x: 0, y: 1 }, { x: 0, y: -1 }];
  const step = (k: number, d: number) => {
    const cx = k % W, cy = Math.floor(k / W), nx = cx + DIRS[d]!.x, ny = cy + DIRS[d]!.y;
    return nx < 0 || ny < 0 || nx >= W || ny >= H ? -1 : nx + ny * W;
  };
  const dirIndex = (v?: Point) => v ? DIRS.findIndex(d => d.x === v.x && d.y === v.y) : -1;
  const sd = dirIndex(sDir), ed = dirIndex(eDir);
  // 状态 = 网格点 × 进入方向；4 是起点（还没有方向）。
  const N = W * H * 5;
  const cost = new Float64Array(N).fill(Infinity), prev = new Int32Array(N).fill(-1);
  const heap = new MinHeap();
  const start = si * 5 + 4;
  cost[start] = 0; heap.push(start, dist(s, e));
  let found = -1;
  while (heap.size) {
    if (performance.now() >= (req.deadline ?? Infinity)) return undefined;
    const state = heap.pop()!;
    const k = Math.floor(state / 5), din = state % 5;
    if (k === ei && (ed < 0 || din === ed)) { found = state; break; }
    for (let d = 0; d < 4; d++) {
      if (din === 4 && sd >= 0 && d !== sd) continue;
      if (din < 4 && (d ^ 1) === din) continue; // 不掉头
      const n = step(k, d);
      if (n < 0 || !free[n]) continue;
      const a = at(k), b = at(n);
      if (blocks.some(box => segmentHits(a, b, box))) continue;
      const len = dist(a, b);
      const c = cost[state]! + len + (din < 4 && din !== d ? BEND_COST : 0);
      const ns = n * 5 + d;
      if (c < cost[ns]!) { cost[ns] = c; prev[ns] = state; heap.push(ns, c + Math.abs(b.x - e.x) + Math.abs(b.y - e.y)); }
    }
  }
  if (found < 0) return undefined;
  const points: Point[] = [];
  for (let st = found; st >= 0; st = prev[st]!) points.push(at(Math.floor(st / 5)));
  return points.reverse();
}

/** 曲线：起点、终点和文字框外扩后的角点组成可见图，找最短路，最后圆滑。 */
export function routeCurved(req: RouteRequest): Point[] | undefined {
  const legs = req.via
    ? [curveLeg(req.start, req.startDir, req.via, undefined, req), curveLeg(req.via, undefined, req.end, req.endDir, req)]
    : [curveLeg(req.start, req.startDir, req.end, req.endDir, req)];
  if (legs.some(l => !l)) return undefined;
  return simplify(legs.flatMap((l, k) => k ? l!.slice(1) : l!));
}

function curveLeg(s: Point, sDir: Point | undefined, e: Point, eDir: Point | undefined, req: RouteRequest): Point[] | undefined {
  if (req.texts.length > ROUTING_LIMITS.obstacles || performance.now() >= (req.deadline ?? Infinity)) return undefined;
  const blocks = req.texts.map(b => inflate(b, CLEAR)).filter(b => !inside(s, b) && !inside(e, b));
  const clear = (a: Point, b: Point) => !blocks.some(box => segmentHits(a, b, box));
  // 起止各伸出一小段，保证线先沿原方向离开节点、沿原方向进入节点。
  const stubOf = (p: Point, dir: Point | undefined, sign: number) => {
    if (!dir) return undefined;
    const q = { x: p.x + sign * dir.x * 10, y: p.y + sign * dir.y * 10 };
    return clear(p, q) && !blocks.some(b => inside(q, b)) ? q : undefined;
  };
  const s2 = stubOf(s, sDir, 1), e2 = stubOf(e, eDir, -1);
  const from = s2 ?? s, to = e2 ?? e;
  const corners = req.texts.flatMap(b => { const o = inflate(b, CURVE_GAP); return [{ x: o.x, y: o.y }, { x: o.x + o.width, y: o.y }, { x: o.x, y: o.y + o.height }, { x: o.x + o.width, y: o.y + o.height }]; })
    .filter(p => !blocks.some(b => inside(p, b)));
  const pts = [from, to, ...corners];
  const n = pts.length;
  const cost = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1), done = new Uint8Array(n);
  cost[0] = 0;
  const heap = new MinHeap();
  heap.push(0, dist(from, to));
  while (heap.size) {
    if (performance.now() >= (req.deadline ?? Infinity)) return undefined;
    const u = heap.pop()!;
    if (done[u]) continue;
    if (u === 1) break;
    done[u] = 1;
    for (let v = 0; v < n; v++) {
      if (done[v] || v === u) continue;
      const len = dist(pts[u]!, pts[v]!);
      if (cost[u]! + len >= cost[v]!) continue; // 比已知的路还长，不必检查遮挡
      if (!clear(pts[u]!, pts[v]!)) continue;
      const c = cost[u]! + len;
      if (c < cost[v]!) { cost[v] = c; prev[v] = u; heap.push(v, c + dist(pts[v]!, to)); }
    }
  }
  if (cost[1] === Infinity) return undefined;
  const path: Point[] = [];
  for (let k = 1; k >= 0; k = prev[k]!) { path.push(pts[k]!); if (k === 0) break; }
  path.reverse();
  return [...(s2 ? [s] : []), ...path, ...(e2 ? [e] : [])];
}

/** 去掉重复点和同一直线上的中间点。 */
function simplify(points: Point[]): Point[] {
  const out: Point[] = [];
  for (const p of points) {
    if (out.length && dist(out[out.length - 1]!, p) < 0.01) continue;
    if (out.length >= 2) {
      const a = out[out.length - 2]!, b = out[out.length - 1]!;
      if (Math.abs((b.x - a.x) * (p.y - b.y) - (b.y - a.y) * (p.x - b.x)) < 0.01 && (b.x - a.x) * (p.x - b.x) + (b.y - a.y) * (p.y - b.y) >= 0) { out[out.length - 1] = p; continue; }
    }
    out.push(p);
  }
  return out;
}

/** 折线转成路径；拐角处用二次曲线倒圆角（直角走线半径小，和 Mermaid 的直角线一致；曲线半径大）。 */
export function roundedPath(points: Point[], radius: number): string {
  if (points.length < 3) return `M${points.map(fmt).join('L')}`;
  let d = `M${fmt(points[0]!)}`;
  for (let k = 1; k < points.length - 1; k++) {
    const a = points[k - 1]!, b = points[k]!, c = points[k + 1]!;
    const r = Math.min(radius, dist(a, b) / 2, dist(b, c) / 2);
    const p = { x: b.x + (a.x - b.x) * r / (dist(a, b) || 1), y: b.y + (a.y - b.y) * r / (dist(a, b) || 1) };
    const q = { x: b.x + (c.x - b.x) * r / (dist(b, c) || 1), y: b.y + (c.y - b.y) * r / (dist(b, c) || 1) };
    d += `L${fmt(p)}Q${fmt(b)} ${fmt(q)}`;
  }
  return d + `L${fmt(points[points.length - 1]!)}`;
}

/** 给一条线重新找路；不压字或找不到路时返回 undefined。 */
export function rerouteEdge(points: Point[], texts: Box[], cards: Box[], orthogonal: boolean, via?: Point, deadline = performance.now() + ROUTING_LIMITS.edgeMs): { d: string; points: Point[] } | undefined {
  if (points.length < 2 || performance.now() >= deadline) return undefined;
  const s = points[0]!, e = points[points.length - 1]!;
  const relevant = [...texts, ...cards].filter(b => !inside(s, inflate(b, CLEAR + 1)) && !inside(e, inflate(b, CLEAR + 1)));
  // 触发、局部搜索后的验收及圆角后的验收使用同一组 3px 外扩框。
  const clearance = relevant.map(b => inflate(b, CLEAR - 1));
  if (!polylineHits(points, clearance)) return undefined;
  const ends = [s, e, ...(via ? [via] : []), ...points];
  const x = Math.min(...ends.map(p => p.x)), y = Math.min(...ends.map(p => p.y));
  const bounds = { x, y, width: Math.max(...ends.map(p => p.x)) - x, height: Math.max(...ends.map(p => p.y)) - y };
  const find = (r: RouteRequest) => orthogonal ? routeOrthogonal(r) : routeCurved(r);
  // 最多两次有预算的局部搜索。失败只放大邻域并解除旧标签约束，不升级到全图搜索。
  for (const margin of [NEAR, NEAR * 2]) {
    if (performance.now() >= deadline) return undefined;
    const region = inflate(bounds, margin);
    const local = relevant.filter(b => b.x < region.x + region.width && b.x + b.width > region.x && b.y < region.y + region.height && b.y + b.height > region.y);
    if (local.length > ROUTING_LIMITS.obstacles) return undefined;
    const route = find({ start: s, end: e, startDir: direction(s, points[1]!), endDir: direction(points[points.length - 2]!, e), texts: local, via: margin === NEAR ? via : undefined, deadline });
    if (!route || route.length < 2 || performance.now() >= deadline || polylineHits(route, clearance)) continue;
    const d = roundedPath(route, orthogonal ? 5 : 16), result = flattenPath(d);
    // 圆角破坏安全间距时保留已验收的折线。
    return polylineHits(result, clearance) ? { d: `M${route.map(fmt).join('L')}`, points: route } : { d, points: result };
  }
  return undefined;
}

class MinHeap {
  private keys: number[] = []; private vals: number[] = [];
  get size() { return this.keys.length; }
  push(v: number, key: number) {
    const k = this.keys, a = this.vals; let i = k.length; k.push(key); a.push(v);
    while (i > 0) { const p = (i - 1) >> 1; if (k[p]! <= key) break; k[i] = k[p]!; a[i] = a[p]!; i = p; }
    k[i] = key; a[i] = v;
  }
  pop(): number | undefined {
    const k = this.keys, a = this.vals;
    if (!k.length) return undefined;
    const top = a[0]!, lastK = k.pop()!, lastV = a.pop()!;
    if (k.length) {
      let i = 0;
      for (;;) {
        const l = 2 * i + 1, r = l + 1; let m = i, mk = lastK;
        if (l < k.length && k[l]! < mk) { m = l; mk = k[l]!; }
        if (r < k.length && k[r]! < mk) { m = r; }
        if (m === i) break;
        k[i] = k[m]!; a[i] = a[m]!; i = m;
      }
      k[i] = lastK; a[i] = lastV;
    }
    return top;
  }
}

// ———— 在 Mermaid 的 SVG 上执行 ————

function translateOf(el: Element): Point {
  const m = el.getAttribute('transform')?.match(/translate\(\s*(-?[\d.e+-]+)[\s,]+(-?[\d.e+-]+)\s*\)/);
  return m ? { x: Number(m[1]), y: Number(m[2]) } : { x: 0, y: 0 };
}
/** 元素自身坐标原点在 svg 坐标中的位置（Mermaid 的分组只用平移）。 */
function originOf(el: Element, svg: Element): Point {
  let x = 0, y = 0;
  for (let p = el.parentElement; p && p !== svg; p = p.parentElement) { const t = translateOf(p); x += t.x; y += t.y; }
  return { x, y };
}
const attr = (el: Element, name: string) => Number(el.getAttribute(name) ?? 0) || 0;

/** foreignObject 文字框在 svg 坐标中的位置。 */
function foreignBox(fo: Element, svg: Element): Box | undefined {
  const w = attr(fo, 'width'), h = attr(fo, 'height');
  if (!w || !h) return undefined;
  const o = originOf(fo, svg), t = translateOf(fo);
  return { x: o.x + t.x + attr(fo, 'x'), y: o.y + t.y + attr(fo, 'y'), width: w, height: h };
}

/** 节点外形（矩形、多边形、圆）在 svg 坐标中的外框；认不出外形时用文字框估计。 */
function cardBox(node: Element, svg: Element, text?: Box): Box | undefined {
  const shape = node.querySelector(':scope > rect, :scope > polygon, :scope > circle, :scope > ellipse, :scope > g > rect, :scope > g > polygon');
  if (shape) {
    const o = originOf(shape, svg), t = translateOf(shape);
    const ox = o.x + t.x, oy = o.y + t.y;
    const tag = shape.tagName.toLowerCase();
    if (tag === 'rect' && attr(shape, 'width')) return { x: ox + attr(shape, 'x'), y: oy + attr(shape, 'y'), width: attr(shape, 'width'), height: attr(shape, 'height') };
    if (tag === 'polygon') {
      const nums = (shape.getAttribute('points') ?? '').split(/[\s,]+/).filter(Boolean).map(Number);
      const xs = nums.filter((_, k) => k % 2 === 0), ys = nums.filter((_, k) => k % 2 === 1);
      if (xs.length) return { x: ox + Math.min(...xs), y: oy + Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
    }
    if (tag === 'circle' || tag === 'ellipse') {
      const rx = attr(shape, tag === 'circle' ? 'r' : 'rx'), ry = attr(shape, tag === 'circle' ? 'r' : 'ry');
      if (rx) return { x: ox + attr(shape, 'cx') - rx, y: oy + attr(shape, 'cy') - ry, width: rx * 2, height: ry * 2 };
    }
  }
  return text ? inflate(text, 8) : undefined;
}

const edgePaths = (svg: Element) => [...new Set(svg.querySelectorAll<SVGPathElement>('path.flowchart-link, .edgePaths > path'))].filter(p => !p.classList.contains('mp-edge-hit'));

/** 把每个分组里的连线和连线文字移到节点后面画（即显示在节点之上），连线文字在最上层。路径的先后顺序不变。 */
export function edgesOnTop(svg: SVGSVGElement) {
  for (const root of svg.querySelectorAll('g.root')) {
    const kids = [...root.children];
    const lines = kids.filter(el => el.classList.contains('edgePaths'));
    const labels = kids.filter(el => el.classList.contains('edgeLabels'));
    const nodes = kids.filter(el => el.classList.contains('nodes'));
    if (!lines.length || !nodes.length) continue;
    // 子图单独排版时节点组里还嵌着一层 root，挪动会打乱连线顺序（编辑器靠顺序对应连线），这种图不挪。
    if (nodes.some(n => n.querySelector('g.root'))) continue;
    root.append(...lines, ...labels);
  }
}

/** 让压到文字的连线绕开；fit 为 true 时，绕出画布的线会让画布相应扩大。返回改动过的连线数。 */
export function avoidText(svg: SVGSVGElement, fit = true): number {
  const deadline = performance.now() + (fit ? ROUTING_LIMITS.diagramMs : ROUTING_LIMITS.dragMs);
  const orthogonal = svg.dataset.mpEdges !== 'curved';
  const texts: { box: Box; owner?: Element }[] = [];
  const cards: Box[] = [];
  for (const node of svg.querySelectorAll('g.node')) {
    const fo = node.querySelector('foreignObject');
    const box = fo ? foreignBox(fo, svg) : undefined;
    if (box) texts.push({ box });
    const card = cardBox(node, svg, box);
    if (card) cards.push(card);
  }
  for (const group of svg.querySelectorAll('g.cluster')) { const card = cardBox(group, svg); if (card) cards.push(card); }
  for (const label of svg.querySelectorAll('.cluster-label foreignObject')) { const box = foreignBox(label, svg); if (box) texts.push({ box }); }
  const edgeLabels = [...svg.querySelectorAll('.edgeLabels > .edgeLabel')];
  for (const label of edgeLabels) {
    const fo = label.querySelector('foreignObject');
    const box = fo ? foreignBox(fo, svg) : undefined;
    if (box && label.textContent?.trim()) texts.push({ box, owner: label });
  }
  if (!texts.length && !cards.length) return 0;
  let changed = 0;
  const reach: Point[] = [];
  for (const path of edgePaths(svg)) {
    if (performance.now() >= deadline) break;
    const d = path.getAttribute('d');
    if (!d) continue;
    const origin = originOf(path, svg);
    const points = flattenPath(d).map(p => ({ x: p.x + origin.x, y: p.y + origin.y }));
    const dataId = path.getAttribute('data-id');
    const own = dataId ? edgeLabels.find(l => l.querySelector(`[data-id="${CSS.escape(dataId)}"]`)) : undefined;
    const ownBox = own ? texts.find(t => t.owner === own)?.box : undefined;
    const via = ownBox ? { x: ownBox.x + ownBox.width / 2, y: ownBox.y + ownBox.height / 2 } : undefined;
    const others = texts.filter(t => !own || t.owner !== own).map(t => t.box);
    const route = rerouteEdge(points, others, cards, orthogonal, via, Math.min(deadline, performance.now() + ROUTING_LIMITS.edgeMs));
    if (!route) continue;
    if (own && ownBox && via && !route.points.some((p, i) => i && overlapLength(route.points[i - 1]!, p, ownBox) > 0)) {
      const candidates = route.points.slice(1).map((p, i) => ({ x: (p.x + route.points[i]!.x) / 2, y: (p.y + route.points[i]!.y) / 2 }));
      const clear = candidates.filter(p => ![...others, ...cards].some(b => p.x + ownBox.width / 2 > b.x && p.x - ownBox.width / 2 < b.x + b.width && p.y + ownBox.height / 2 > b.y && p.y - ownBox.height / 2 < b.y + b.height));
      clear.sort((a, b) => dist(a, via) - dist(b, via));
      if (clear[0]) {
        const t = translateOf(own), p = clear[0];
        own.setAttribute('transform', `translate(${t.x + p.x - via.x}, ${t.y + p.y - via.y})`);
        ownBox.x += p.x - via.x; ownBox.y += p.y - via.y;
      }
    }
    const local = route.points.map(p => ({ x: p.x - origin.x, y: p.y - origin.y }));
    const nd = shiftPath(route.d, -origin.x, -origin.y);
    path.setAttribute('d', nd);
    path.setAttribute('data-mp-avoided', '');
    const hit = path.nextElementSibling;
    if (hit?.classList.contains('mp-edge-hit')) hit.setAttribute('d', nd);
    // Mermaid 用 “0 0 长度-4 4” 的虚线让线在箭头前停下；改了路径要按新长度重算。
    const style = path.getAttribute('style') ?? '';
    const dash = style.match(/stroke-dasharray:\s*0 0 [\d.]+ (\d+(?:\.\d+)?)/);
    if (dash) {
      let length = polylineLength(local);
      try { if (path.isConnected) length = path.getTotalLength(); } catch { /* 量不到时用折线长度 */ }
      path.setAttribute('style', style.replace(dash[0], `stroke-dasharray: 0 0 ${round(Math.max(0, length - Number(dash[1])))} ${dash[1]}`));
    }
    reach.push(...route.points);
    changed++;
  }
  if (fit && reach.length) growView(svg, reach);
  return changed;
}

/** 画布不够包住绕行的线时向外扩，留 4px 边。 */
function growView(svg: SVGSVGElement, points: Point[]) {
  const [vx, vy, vw, vh] = (svg.getAttribute('viewBox') ?? '').split(/[\s,]+/).map(Number);
  if (![vx, vy, vw, vh].every(n => Number.isFinite(n))) return;
  const m = 4;
  const x0 = Math.min(vx!, ...points.map(p => p.x - m)), y0 = Math.min(vy!, ...points.map(p => p.y - m));
  const x1 = Math.max(vx! + vw!, ...points.map(p => p.x + m)), y1 = Math.max(vy! + vh!, ...points.map(p => p.y + m));
  if (x0 === vx && y0 === vy && x1 === vx! + vw! && y1 === vy! + vh!) return;
  svg.setAttribute('viewBox', `${round(x0)} ${round(y0)} ${round(x1 - x0)} ${round(y1 - y0)}`);
  if (svg.style.maxWidth) svg.style.maxWidth = `${round(x1 - x0)}px`;
  if (svg.dataset.mpMinScale) svg.style.minWidth = `${(x1 - x0) * Number(svg.dataset.mpMinScale)}px`;
}

/** 平移路径的绝对坐标；相对增量不变，首个相对 moveto 的起点单独平移。 */
export function shiftPath(d: string, dx: number, dy: number) {
  if (!dx && !dy) return d;
  return d.replace(/([MLHVQCASTZ])([^MLHVQCASTZ]*)/gi, (whole, cmd: string, args: string, offset: number) => {
    const initialMove = cmd === 'm' && !d.slice(0, offset).trim();
    if (cmd === cmd.toLowerCase() && !initialMove) return whole;
    let index = 0;
    return cmd + args.replace(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi, (value: string) => {
      const i = index++;
      if (initialMove && i >= 2) return value;
      if (cmd === 'H') return String(round(Number(value) + dx));
      if (cmd === 'V') return String(round(Number(value) + dy));
      if (cmd === 'A' && i % 7 < 5) return value;
      const coordinate = cmd === 'A' ? i % 7 - 5 : i;
      return String(round(Number(value) + (coordinate % 2 ? dy : dx)));
    });
  });
}

/** 对整组折线重新计算交叉；只让后画的线跨越，端点相接和共线不算交叉。 */
export function lineHops(routes: Point[][], mode: 'arc' | 'gap' | 'none') {
  return routes.map((points, index) => hopRoute(points, routes.slice(0, index), mode));
}

function hopRoute(points: Point[], previous: Point[][], mode: 'arc' | 'gap' | 'none') {
  if (!points.length) return { d: '', gaps: [] as Point[][] };
  let d = `M${fmt(points[0]!)}`;
  const gaps: Point[][] = [];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!, length = dist(a, b);
    const horizontal = Math.abs(a.y - b.y) < 0.01, vertical = Math.abs(a.x - b.x) < 0.01;
    const crosses: number[] = [];
    if (mode !== 'none' && (horizontal || vertical) && length > 12) {
      for (const other of previous) for (let j = 1; j < other.length; j++) {
        const c = other[j - 1]!, e = other[j]!;
        if (horizontal ? Math.abs(c.x - e.x) > 0.01 : Math.abs(c.y - e.y) > 0.01) continue;
        const t = horizontal ? (c.x - a.x) / (b.x - a.x) : (c.y - a.y) / (b.y - a.y);
        const u = horizontal ? (a.y - c.y) / (e.y - c.y) : (a.x - c.x) / (e.x - c.x);
        if (t * length > 6 && (1 - t) * length > 6 && u > 0.001 && u < 0.999) crosses.push(t * length);
      }
    }
    let last = -Infinity;
    for (const at of crosses.sort((a, b) => a - b)) {
      if (at - last < 12) continue;
      last = at;
      const along = (n: number) => ({ x: a.x + (b.x - a.x) * n / length, y: a.y + (b.y - a.y) * n / length });
      const before = along(at - 5), after = along(at + 5);
      if (mode === 'arc') d += `L${fmt(before)}A5,5,0,0,1,${fmt(after)}`;
      else gaps.push([before, after]);
    }
    d += `L${fmt(b)}`;
  }
  return { d, gaps };
}

/** 保留原始圆角和曲线指令，只在直线段上插入跳线。 */
function pathHops(d: string, others: Point[][], mode: 'arc' | 'gap' | 'none') {
  let current: Point = { x: 0, y: 0 }, output = '', started = false;
  const gaps: Point[][] = [];
  for (const match of d.matchAll(/([MLHVQCAZ])([^MLHVQCAZ]*)/gi)) {
    const cmd = match[1]!, args = match[2]!;
    const values = (args.match(/-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi) ?? []).map(Number);
    const end = cmd === 'H' ? { x: values[0]!, y: current.y } : cmd === 'V' ? { x: current.x, y: values[0]! } : { x: values.at(-2)!, y: values.at(-1)! };
    if (cmd === 'Z') { output += 'Z'; continue; }
    if (cmd === 'M' && !started) { output += `M${fmt(end)}`; started = true; }
    else if (cmd === 'Q' || cmd === 'C') output += cmd + args;
    else {
      // Mermaid 旧跳线的 A / M 还原成直线后，按全图最新交点重算。
      const result = hopRoute([current, end], others, mode);
      output += result.d.replace(/^M[^LQA]+/, '');
      gaps.push(...result.gaps);
    }
    current = end;
  }
  return { d: output, gaps };
}

let hopSerial = 0;
/** 重画后恢复跳线；断线用遮罩保持原有虚线、箭头和连续的点击区域。 */
export function applyLineHops(svg: SVGSVGElement) {
  if (svg.dataset.mpEdges !== 'orthogonal') return;
  const mode = svg.dataset.mpHops === 'gap' ? 'gap' : svg.dataset.mpHops === 'none' ? 'none' : 'arc';
  const paths = edgePaths(svg);
  svg.querySelectorAll('[data-mp-hop-mask]').forEach(el => el.remove());
  const origins = paths.map(path => originOf(path, svg));
  const routes = paths.map((path, i) => {
    let d = path.getAttribute('d') ?? '';
    if (d === path.dataset.mpHoppedD) d = path.dataset.mpHopBase ?? d;
    path.dataset.mpHopBase = d;
    path.removeAttribute('mask');
    return simplify(flattenPath(d)).map(p => ({ x: p.x + origins[i]!.x, y: p.y + origins[i]!.y }));
  });
  const results = paths.map((path, i) => pathHops(shiftPath(path.dataset.mpHopBase!, origins[i]!.x, origins[i]!.y), routes.slice(0, i), mode));
  for (const [i, path] of paths.entries()) {
    const result = results[i]!, o = origins[i]!;
    if (!result.d) continue;
    const d = shiftPath(result.d, -o.x, -o.y);
    path.setAttribute('d', d); path.dataset.mpHoppedD = d;
    const style = path.getAttribute('style') ?? '';
    const dash = style.match(/stroke-dasharray:\s*0 0 [\d.]+ (\d+(?:\.\d+)?)/);
    if (dash) {
      const length = path.getTotalLength();
      path.setAttribute('style', style.replace(dash[0], `stroke-dasharray: 0 0 ${round(Math.max(0, length - Number(dash[1])))} ${dash[1]}`));
    }
    const hit = path.nextElementSibling;
    if (hit?.classList.contains('mp-edge-hit')) hit.setAttribute('d', `M${routes[i]!.map(p => fmt({ x: p.x - o.x, y: p.y - o.y })).join('L')}`);
    if (!result.gaps.length) continue;
    const ns = 'http://www.w3.org/2000/svg', doc = svg.ownerDocument;
    const mask = doc.createElementNS(ns, 'mask'), rect = doc.createElementNS(ns, 'rect');
    mask.id = `mp-hop-${++hopSerial}`; mask.dataset.mpHopMask = '';
    mask.setAttribute('maskUnits', 'userSpaceOnUse');
    const pts = routes[i]!, x = Math.min(...pts.map(p => p.x)) - o.x - 20, y = Math.min(...pts.map(p => p.y)) - o.y - 20;
    const width = Math.max(...pts.map(p => p.x)) - o.x - x + 20, height = Math.max(...pts.map(p => p.y)) - o.y - y + 20;
    for (const el of [mask, rect]) for (const [key, value] of Object.entries({ x, y, width, height })) el.setAttribute(key, String(value));
    rect.setAttribute('fill', 'white'); mask.append(rect);
    for (const gap of result.gaps) {
      const hole = doc.createElementNS(ns, 'path');
      hole.setAttribute('d', shiftPath(`M${gap.map(fmt).join('L')}`, -o.x, -o.y));
      hole.setAttribute('stroke', 'black'); hole.setAttribute('stroke-width', '8'); mask.append(hole);
    }
    svg.append(mask); path.setAttribute('mask', `url(#${mask.id})`);
  }
}
