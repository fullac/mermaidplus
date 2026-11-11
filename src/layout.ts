// 用途：自动排列已测量的流程图节点，并生成避开节点的直角连线路径。
import type { ElkNode, ElkPoint } from 'elkjs/lib/elk-api';
import type { Flowchart } from './flowchart';

export interface Size { width: number; height: number }
export interface LayoutSettings {
  direction: 'source' | 'auto' | 'TB' | 'LR';
  spacing: 'compact' | 'normal' | 'roomy';
  lines: 'rounded' | 'orthogonal';
}
export const defaultLayoutSettings: LayoutSettings = { direction: 'auto', spacing: 'normal', lines: 'rounded' };
export interface PositionedNode extends Size { id: string; x: number; y: number }
export interface PositionedEdge { index: number; points: ElkPoint[]; label?: Size & ElkPoint }
export interface DiagramLayout extends Size { direction: string; nodes: PositionedNode[]; edges: PositionedEdge[] }
export type LayoutExecutor = (graph: ElkNode) => Promise<ElkNode>;

async function arrange(chart: Flowchart, nodes: Map<string, Size>, labels: Size[], direction: string, spacing: LayoutSettings['spacing'], execute: LayoutExecutor): Promise<DiagramLayout> {
  const gap = { compact: 28, normal: 44, roomy: 68 }[spacing];
  const directions: Record<string, string> = { TB: 'DOWN', BT: 'UP', LR: 'RIGHT', RL: 'LEFT' };
  const sides: Record<string, [string, string]> = { TB: ['NORTH','SOUTH'], BT: ['SOUTH','NORTH'], LR: ['WEST','EAST'], RL: ['EAST','WEST'] };
  const [input, output] = sides[direction]!;
  const graph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered', 'elk.direction': directions[direction]!,
      'elk.edgeRouting': 'ORTHOGONAL', 'elk.padding': '[top=28,left=28,bottom=28,right=28]',
      'elk.spacing.nodeNode': String(gap), 'elk.layered.spacing.nodeNodeBetweenLayers': String(gap + 32),
      'elk.spacing.edgeNode': '20', 'elk.spacing.edgeEdge': '16',
      'elk.layered.spacing.edgeNodeBetweenLayers': '20', 'elk.layered.spacing.edgeEdgeBetweenLayers': '16',
      'elk.spacing.labelNode': '12', 'elk.spacing.edgeLabel': '8',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.separateConnectedComponents': 'true', 'elk.spacing.componentComponent': String(gap + 20),
      'elk.randomSeed': '1',
    },
    children: chart.nodes.map(node => {
      const size = nodes.get(node.id)!;
      const ports = (role: 'in' | 'out', side: string) => {
        const edges = chart.edges.map((edge, index) => ({ edge, index })).filter(({ edge }) => (role === 'in' ? edge.to : edge.from) === node.id);
        return edges.map(({ index }, order) => {
          const vertical = side === 'NORTH' || side === 'SOUTH';
          const length = vertical ? size.width : size.height;
          const inset = node.shape === 'round' ? Math.min(22, length/3) : 0;
          const along = inset + (length - 2*inset) * (order+1)/(edges.length+1);
          const x = vertical ? along : side === 'WEST' ? 0 : size.width;
          const y = vertical ? side === 'NORTH' ? 0 : size.height : along;
          return { id: `${node.id}:${role}:${index}`, width: 0, height: 0, x, y, layoutOptions: { 'elk.port.side': side } };
        });
      };
      return {
        id: node.id, ...size, ports: [...ports('in', input), ...ports('out', output)],
        layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
      };
    }),
    edges: chart.edges.map((edge, index) => ({
      id: `edge-${index}`, sources: [`${edge.from}:out:${index}`], targets: [`${edge.to}:in:${index}`],
      labels: edge.label ? [{ id: `label-${index}`, text: edge.label, ...labels[index]!, layoutOptions: { 'elk.edgeLabels.placement': 'CENTER' } }] : [],
    })),
  };
  const result = await execute(graph);
  return {
    width: result.width!, height: result.height!, direction,
    nodes: result.children!.map(node => ({ id: node.id, x: node.x!, y: node.y!, width: node.width!, height: node.height! })),
    edges: result.edges!.map(edge => {
      const section = edge.sections?.[0];
      if (!section || edge.sections!.length !== 1) throw new Error('布局器未返回完整连线路径。');
      const label = edge.labels?.[0];
      const index = Number(edge.id.slice(5));
      const points = [section.startPoint, ...section.bendPoints ?? [], section.endPoint];
      // ELK 将端口固定在包围矩形边上；补一段同方向延长线，贴到菱形实际斜边。
      for (const [id, side, isStart] of [[chart.edges[index]!.from, output, true], [chart.edges[index]!.to, input, false]] as const) {
        if (chart.nodes.find(n => n.id === id)?.shape !== 'diamond') continue;
        const box = result.children!.find(n => n.id === id)!;
        const p = { ...(isStart ? points[0]! : points.at(-1)!) };
        if (side === 'NORTH' || side === 'SOUTH') {
          const offset = Math.abs(p.x-box.x!-box.width!/2)*box.height!/box.width!;
          p.y = box.y! + (side === 'NORTH' ? offset : box.height!-offset);
        } else {
          const offset = Math.abs(p.y-box.y!-box.height!/2)*box.width!/box.height!;
          p.x = box.x! + (side === 'WEST' ? offset : box.width!-offset);
        }
        if (isStart) points.unshift(p); else points.push(p);
      }
      return {
        index, points,
        label: label ? { x: label.x!, y: label.y!, width: label.width!, height: label.height! } : undefined,
      };
    }),
  };
}

export async function layoutFlowchart(chart: Flowchart, nodes: Map<string, Size>, labels: Size[], settings: LayoutSettings, available: Size, execute: LayoutExecutor): Promise<DiagramLayout> {
  if (settings.direction !== 'auto') return arrange(chart, nodes, labels, settings.direction === 'source' ? chart.direction : settings.direction, settings.spacing, execute);
  // 同时比较横排与竖排的可读尺寸；相同时优先源码方向。
  const preferred = chart.direction === 'LR' || chart.direction === 'RL' ? chart.direction : chart.direction === 'BT' ? 'BT' : 'TB';
  const alternative = preferred === 'LR' || preferred === 'RL' ? 'TB' : 'LR';
  const candidates = await Promise.all([preferred, alternative].map(direction => arrange(chart, nodes, labels, direction, settings.spacing, execute)));
  const fit = (layout: DiagramLayout) => Math.min(available.width / layout.width, available.height / layout.height, 1);
  return candidates[1] && fit(candidates[1]) > fit(candidates[0]!) + .02 ? candidates[1] : candidates[0]!;
}

export function edgePath(points: ElkPoint[], radius: number): string {
  const clean = points.filter((p, i) => i === 0 || p.x !== points[i-1]!.x || p.y !== points[i-1]!.y);
  if (!clean.length) return '';
  let path = `M ${clean[0]!.x} ${clean[0]!.y}`;
  for (let i = 1; i < clean.length; i++) {
    const before = clean[i-1]!, corner = clean[i]!, after = clean[i+1];
    if (!after || radius === 0) { path += ` L ${corner.x} ${corner.y}`; continue; }
    const incoming = Math.hypot(corner.x-before.x, corner.y-before.y), outgoing = Math.hypot(after.x-corner.x, after.y-corner.y);
    const r = Math.min(radius, incoming/2, outgoing/2);
    const start = { x: corner.x + (before.x-corner.x)*r/incoming, y: corner.y + (before.y-corner.y)*r/incoming };
    const end = { x: corner.x + (after.x-corner.x)*r/outgoing, y: corner.y + (after.y-corner.y)*r/outgoing };
    path += ` L ${start.x} ${start.y} Q ${corner.x} ${corner.y} ${end.x} ${end.y}`;
  }
  return path;
}
