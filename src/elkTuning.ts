// 用途：调整 Mermaid 自带 ELK 排版的参数——让“紧凑程度”真正生效、可统一竖排、可自动在横排和竖排之间选择。
// Mermaid 的 ELK 排版把间距写死在内部，也没有开放根节点参数的配置项。它和插件用的是同一个 elkjs 模块，
// 所以这里在插件渲染期间接管 elkjs 的 layout 调用，改写传入的排版参数后再交给 ELK。只影响本插件打包的 elkjs。
import ELK from 'elkjs/lib/elk.bundled.js';
import type { ElkNode } from 'elkjs/lib/elk-api';
import type { Density } from './mermaidRender';

export interface ElkTuning {
  density: Density;
  /** 竖排：整张图一律自上而下。 */
  vertical: boolean;
  /** 自动选横竖：两个方向各排一次，选放进笔记栏后更合适的那个。vertical 为 true 时不起作用。 */
  autoDirection: boolean;
  /** 图能占用的宽度（px），用于自动选方向。 */
  availableWidth: number;
}

/** 根上的间距。宽松档沿用 Mermaid 原值，不改。 */
const ROOT_SPACING: Record<Exclude<Density, 'loose'>, Record<string, string>> = {
  compact: { 'spacing.baseValue': '20', 'elk.spacing.nodeNode': '20', 'elk.layered.spacing.nodeNodeBetweenLayers': '28', 'elk.layered.spacing.edgeNodeBetweenLayers': '12', 'elk.layered.spacing.edgeEdgeBetweenLayers': '10', 'elk.spacing.edgeEdge': '10' },
  normal: { 'spacing.baseValue': '30', 'elk.spacing.nodeNode': '30', 'elk.layered.spacing.nodeNodeBetweenLayers': '38', 'elk.layered.spacing.edgeNodeBetweenLayers': '16', 'elk.layered.spacing.edgeEdgeBetweenLayers': '12', 'elk.spacing.edgeEdge': '12' },
};
/** 子图里的间距（Mermaid 写死为节点间距 50、层与边间距 30）。 */
const GROUP_SPACING: Record<Exclude<Density, 'loose'>, Record<string, string>> = {
  compact: { 'spacing.baseValue': '16', 'spacing.nodeNode': '20', 'elk.layered.spacing.edgeNodeBetweenLayers': '14', 'elk.spacing.edgeEdge': '10' },
  normal: { 'spacing.baseValue': '20', 'spacing.nodeNode': '32', 'elk.layered.spacing.edgeNodeBetweenLayers': '20', 'elk.spacing.edgeEdge': '14' },
};
/** 低于这个缩放比例，字缩得太小，看不清。 */
export const MIN_READABLE_SCALE = 0.65;
/** 两个方向的分数相差不到这个比例时，沿用源码写的方向，避免图来回跳。 */
const KEEP_SOURCE_MARGIN = 0.08;

type Layout = (graph: ElkNode, options?: unknown) => Promise<ElkNode>;
const proto = (ELK as unknown as { prototype: { layout: Layout } }).prototype;
let current: ElkTuning | undefined;
let installed = false;

/** 在 tuning 生效期间执行 run（渲染本来就逐个排队，不会互相覆盖）。 */
export async function withElkTuning<T>(tuning: ElkTuning, run: () => Promise<T>): Promise<T> {
  install();
  current = tuning;
  try { return await run(); } finally { current = undefined; }
}

function install() {
  if (installed) return;
  installed = true;
  const original = proto.layout;
  proto.layout = async function (this: unknown, graph: ElkNode, options?: unknown) {
    const tuning = current;
    if (!tuning) return original.call(this, graph, options);
    tuneSpacing(graph, tuning.density);
    const root = (graph.layoutOptions ??= {});
    if (tuning.vertical) root['elk.direction'] = 'DOWN';
    else if (tuning.autoDirection && (graph.children?.length ?? 0) > 1) {
      root['elk.direction'] = await chooseDirection(graph, tuning.availableWidth, g => original.call(this, g, options));
    }
    return original.call(this, graph, options);
  };
}

/** 改写根和各子图的间距，并打开事后压紧（把放置后留下的空档收掉）。 */
export function tuneSpacing(graph: ElkNode, density: Density) {
  if (density === 'loose') return;
  Object.assign((graph.layoutOptions ??= {}), ROOT_SPACING[density], { 'elk.layered.compaction.postCompaction.strategy': 'EDGE_LENGTH' });
  const visit = (node: ElkNode) => {
    for (const child of node.children ?? []) {
      // 有子节点的是子图；用 rectpacking 等其他算法的容器保持 Mermaid 的设置。
      const options = child.layoutOptions;
      if (child.children?.length && options && (!options['elk.algorithm'] || options['elk.algorithm'] === 'elk.layered' || options['elk.algorithm'] === 'layered')) {
        Object.assign(options, GROUP_SPACING[density]);
      }
      visit(child);
    }
  };
  visit(graph);
}

const OPPOSITE: Record<string, string> = { DOWN: 'RIGHT', UP: 'LEFT', RIGHT: 'DOWN', LEFT: 'UP' };

/** 源码方向和与之垂直的方向各排一次（在副本上），按 directionScore 选更合适的。 */
async function chooseDirection(graph: ElkNode, availableWidth: number, layout: (g: ElkNode) => Promise<ElkNode>) {
  const source = String(graph.layoutOptions?.['elk.direction'] ?? 'DOWN');
  const other = OPPOSITE[source] ?? 'RIGHT';
  const trial = async (direction: string) => {
    const copy = JSON.parse(JSON.stringify(graph)) as ElkNode;
    copy.layoutOptions = { ...copy.layoutOptions, 'elk.direction': direction };
    const result = await layout(copy);
    return directionScore(result.width ?? 0, result.height ?? 0, availableWidth);
  };
  const [keep, swap] = await Promise.all([trial(source), trial(other)]);
  return pickDirection(source, keep, other, swap);
}

/** 分数越小越好：图按比例缩到栏宽后的高度；字会小到看不清的方向记为 Infinity。 */
export function directionScore(width: number, height: number, availableWidth: number) {
  if (width <= 0 || height <= 0) return Infinity;
  const scale = Math.min(1, availableWidth / width);
  return scale < MIN_READABLE_SCALE ? Infinity : height * scale;
}

/** 另一个方向明显更好（分数小 8% 以上）才换；两个方向都看不清时沿用源码方向。 */
export function pickDirection(source: string, sourceScore: number, other: string, otherScore: number) {
  if (!Number.isFinite(otherScore)) return source;
  if (!Number.isFinite(sourceScore)) return other;
  return otherScore < sourceScore * (1 - KEEP_SOURCE_MARGIN) ? other : source;
}
