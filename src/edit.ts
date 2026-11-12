// 用途：把可视化编辑动作转换为对 Mermaid 源码的最小改动——只改涉及的行，其余缩进、注释、顺序和行尾原样保留。
import { readAnnotations, setNodeStyles } from './annotations';
import { parseFlowchart, type Flowchart, type Statement } from './flowchart';
import { clearLayout } from './manualLayout';
import { hasMarkdownMarks, isMarkdownRaw } from './markdownLabel';

export type EditResult = { source: string; select?: { node?: string; edge?: number } };

function split(source: string) {
  return { lines: source.split(/\r?\n/), eol: source.includes('\r\n') ? '\r\n' : '\n' };
}

/**
 * 编辑框里的文字转成源码标签：换行写成 <br/>，拒绝会破坏语法的字符。
 * 有 **粗体** / *斜体* 标记或原来就是 Markdown 标签时，写成 Mermaid 原生 Markdown 标签：
 * 节点为 `文字`（放在双引号内），连线为 "`文字`"。
 */
export function toRawLabel(text: string, kind: 'node' | 'edge', wasMarkdown = false): string {
  const value = text.replace(/\r\n?/g, '\n').split('\n').map(line => line.trim()).join('\n').trim();
  if (!value) throw new Error('文字不能为空。');
  const banned = kind === 'node' ? /"/ : /["|]/;
  if (banned.test(value)) throw new Error(kind === 'node' ? '文字不能包含英文双引号 "，可以改用中文引号。' : '连线文字不能包含英文双引号 " 或竖线 |。');
  const raw = value.replace(/\n/g, '<br/>');
  if (!wasMarkdown && !hasMarkdownMarks(value)) return raw;
  if (raw.includes('`')) throw new Error('带粗体或斜体的文字不能包含反引号 `。');
  return kind === 'node' ? `\`${raw}\`` : `"\`${raw}\`"`;
}

/** 修改节点文字：有显式标签就只替换标签内文字，没有就在首次出现处补上 ["文字"]。 */
export function setNodeLabel(source: string, id: string, text: string): EditResult {
  const chart = parseFlowchart(source);
  const node = chart.nodes.find(n => n.id === id);
  if (!node) throw new Error(`找不到节点 ${id}。`);
  const raw = toRawLabel(text, 'node', isMarkdownRaw(node.raw));
  const { lines, eol } = split(source);
  if (node.def) {
    const token = node.def, label = token.label!;
    const line = lines[token.line]!;
    // 不带引号的文字改为带引号，避免新文字中的括号等字符破坏语法；形状括号保持不变。
    lines[token.line] = line.slice(0, label.start) + (token.quoted ? raw : `"${raw}"`) + line.slice(label.end);
  } else {
    const token = chart.statements.flatMap(s => s.nodes).find(t => t.id === id)!;
    const line = lines[token.line]!;
    lines[token.line] = line.slice(0, token.end) + `["${raw}"]` + line.slice(token.end);
  }
  let next = lines.join(eol);
  next = carryStyles(next, id, node.raw, raw);
  return { source: next, select: { node: id } };
}

/** 改字后保留仍能找到的样式片段，并把注释锚点更新为新文字；找不到的样式丢弃。 */
function carryStyles(source: string, id: string, oldRaw: string, newRaw: string): string {
  const annotation = readAnnotations(source).annotations.find(a => a.node === id);
  if (!annotation) return source;
  if (annotation.label !== oldRaw) return source; // 原本就失效的注释不动，交给用户处理。
  const label = newRaw.replace(/<br\s*\/?>/gi, '\n');
  const styles = annotation.styles.filter(style => label.includes(style.text));
  return styles.length ? setNodeStyles(source, id, newRaw, styles) : removeAnnotation(source, id);
}

function removeAnnotation(source: string, id: string): string {
  const { lines, eol } = split(source);
  return lines.filter(line => {
    const match = line.match(/^\s*%% mermaid-plus:\s*(.*)$/);
    if (!match) return true;
    try { return JSON.parse(match[1]!).node !== id; } catch { return true; }
  }).join(eol);
}

/** 修改连线文字；空文字表示去掉连线上的文字。 */
export function setEdgeLabel(source: string, index: number, text: string): EditResult {
  const chart = parseFlowchart(source);
  const edge = chart.edges[index];
  if (!edge) throw new Error('找不到这条连线。');
  const raw = text.trim() ? toRawLabel(text, 'edge', isMarkdownRaw(edge.raw)) : '';
  const { lines, eol } = split(source);
  const token = edge.token, line = lines[token.line]!;
  const original = line.slice(token.start, token.end);
  const trailing = /\s$/.test(original) ? original.match(/\s*$/)![0] : '';
  lines[token.line] = line.slice(0, token.start) + edge.link + (raw ? `|${raw}|` : '') + trailing + line.slice(token.end);
  return { source: lines.join(eol), select: { edge: index } };
}

function nextId(chart: Flowchart): string {
  const used = new Set([...chart.nodes.map(n => n.id), ...chart.groups.map(g => g.id)]);
  for (let i = 1; ; i++) if (!used.has(`N${i}`)) return `N${i}`;
}

function indentOf(line: string) { return line.match(/^\s*/)![0]; }

/** 子图内部新语句的缩进：沿用块内最后一条语句，否则比 end 多一级。 */
function insertionPoint(chart: Flowchart, lines: string[], parent?: string): { at: number; indent: string } {
  if (parent) {
    const group = chart.groups.find(g => g.id === parent)!;
    for (let i = group.endLine - 1; i > group.line; i--) {
      if (lines[i]!.trim() && !lines[i]!.trim().startsWith('%%')) return { at: group.endLine, indent: indentOf(lines[i]!).length > indentOf(lines[group.endLine]!).length ? indentOf(lines[i]!) : indentOf(lines[group.endLine]!) + '    ' };
    }
    return { at: group.endLine, indent: indentOf(lines[group.endLine]!) + '    ' };
  }
  // 顶层：追加到最后一条非注释语句之后（样式注释通常在末尾，保持其在末尾）。
  let last = -1;
  for (let i = lines.length - 1; i >= 0; i--) if (lines[i]!.trim() && !/^\s*%%/.test(lines[i]!)) { last = i; break; }
  const first = chart.statements[0] ?? null;
  const indent = first ? indentOf(lines[first.line]!) : '    ';
  return { at: last + 1, indent };
}

/** 新增节点；给出 from 时同时连一条线，新节点放进 from 所在的子图。 */
export function addNode(source: string, text: string, from?: string): EditResult {
  const chart = parseFlowchart(source);
  if (from && !chart.nodes.some(n => n.id === from)) throw new Error(`找不到节点 ${from}。`);
  const raw = toRawLabel(text, 'node');
  const id = nextId(chart);
  const { lines, eol } = split(source);
  const parent = from ? chart.nodes.find(n => n.id === from)!.parent : undefined;
  const { at, indent } = insertionPoint(chart, lines, parent);
  lines.splice(at, 0, `${indent}${from ? `${from} --> ` : ''}${id}["${raw}"]`);
  return { source: lines.join(eol), select: { node: id } };
}

/** 新增连线：写在顶层，避免改变已有节点的子图归属。 */
export function addEdge(source: string, from: string, to: string): EditResult {
  const chart = parseFlowchart(source);
  for (const id of [from, to]) if (!chart.nodes.some(n => n.id === id)) throw new Error(`找不到节点 ${id}。`);
  const { lines, eol } = split(source);
  const { at, indent } = insertionPoint(chart, lines);
  lines.splice(at, 0, `${indent}${from} --> ${to}`);
  return { source: lines.join(eol), select: { edge: chart.edges.length } };
}

/**
 * 去掉一组连线（以及可选的一个节点）后重写受影响的语句行：
 * 保留下来的相邻连线原文照抄；其他节点若在这里定义了文字或已无别处提及，就单独保留成一行，避免被连带删掉。
 */
function rewrite(source: string, chart: Flowchart, removed: Set<number>, deleted?: string): string {
  const { lines, eol } = split(source);
  const touched = chart.statements.filter(s => (deleted && s.nodes.some(t => t.id === deleted)) || s.edges.some(e => removed.has(e.edge)));
  // 统计每个节点在不受影响的位置还被提到几次。
  const keptMentions = new Map<string, number>();
  const plans = new Map<Statement, { runs: [number, number][] }>();
  for (const statement of touched) {
    const runs: [number, number][] = [];
    let start = -1;
    statement.edges.forEach((edge, i) => {
      const keep = !removed.has(edge.edge);
      if (keep && start === -1) start = i;
      if (!keep && start !== -1) { runs.push([start, i - 1]); start = -1; }
    });
    if (start !== -1) runs.push([start, statement.edges.length - 1]);
    plans.set(statement, { runs });
  }
  const covered = (statement: Statement, i: number) => plans.get(statement)!.runs.some(([a, b]) => i >= a && i <= b + 1);
  for (const statement of chart.statements) statement.nodes.forEach((token, i) => {
    if (!plans.has(statement) || covered(statement, i)) keptMentions.set(token.id, (keptMentions.get(token.id) ?? 0) + 1);
  });
  // 从后往前改，行号不受前面改动影响。
  for (const statement of [...touched].sort((a, b) => b.line - a.line)) {
    const line = lines[statement.line]!, indent = indentOf(line);
    const pieces: string[] = plans.get(statement)!.runs.map(([a, b]) => line.slice(statement.nodes[a]!.start, statement.nodes[b + 1]!.end));
    const seen = new Set<string>();
    statement.nodes.forEach((token, i) => {
      if (token.id === deleted || covered(statement, i) || seen.has(token.id)) return;
      const definesHere = chart.nodes.find(n => n.id === token.id)!.def === token;
      if (definesHere || !keptMentions.get(token.id)) {
        pieces.push(line.slice(token.start, token.end)); seen.add(token.id);
        keptMentions.set(token.id, (keptMentions.get(token.id) ?? 0) + 1);
      }
    });
    lines.splice(statement.line, 1, ...pieces.map(piece => indent + piece));
  }
  return lines.join(eol);
}

export function deleteEdge(source: string, index: number): EditResult {
  const chart = parseFlowchart(source);
  if (!chart.edges[index]) throw new Error('找不到这条连线。');
  return { source: rewrite(source, chart, new Set([index])) };
}

export function deleteNode(source: string, id: string): EditResult {
  const chart = parseFlowchart(source);
  if (!chart.nodes.some(n => n.id === id)) throw new Error(`找不到节点 ${id}。`);
  if (chart.nodes.length === 1) throw new Error('流程图至少要保留一个节点。');
  const removed = new Set(chart.edges.flatMap((edge, i) => edge.from === id || edge.to === id ? [i] : []));
  return { source: clearLayout(removeAnnotation(rewrite(source, chart, removed, id), id), id) };
}

/** 只替换首尾不同的那几行，返回替换范围，便于编辑器只改动必要的行。 */
export function changedLines(before: string, after: string) {
  const a = before.split(/\r?\n/), b = after.split(/\r?\n/);
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++;
  return { from: head, to: a.length - tail, lines: b.slice(head, b.length - tail) };
}

