// 用途：读取和更新 Mermaid 样式注释，并将文字锚点解析为可安全渲染的片段。
export type StyleType = 'code' | 'bold' | 'italic' | 'highlight';
export interface StyleSpec { text: string; type: StyleType; occurrence?: number }
export interface NodeAnnotation { version: 1; node: string; label: string; styles: StyleSpec[] }
const types: StyleType[] = ['code', 'bold', 'italic', 'highlight'];
const prefix = /^\s*%% mermaid-plus:\s*(.*)$/;

function valid(value: unknown): value is NodeAnnotation {
  if (!value || typeof value !== 'object') return false;
  const a = value as NodeAnnotation;
  return a.version === 1 && typeof a.node === 'string' && /^[A-Za-z][\w]*$/.test(a.node)
    && typeof a.label === 'string' && !/[\r\n]/.test(a.label) && Array.isArray(a.styles)
    && a.styles.length <= 100 && a.styles.every(s => s && typeof s.text === 'string'
      && s.text.length > 0 && !/[\r\n]/.test(s.text) && types.includes(s.type)
      && (s.occurrence === undefined || (Number.isInteger(s.occurrence) && s.occurrence >= 0)));
}

export function readAnnotations(source: string): { annotations: NodeAnnotation[]; warnings: string[] } {
  const annotations: NodeAnnotation[] = [], warnings: string[] = [];
  for (const [index, line] of source.split(/\r?\n/).entries()) {
    const match = line.match(prefix);
    if (!match) continue;
    try {
      const value: unknown = JSON.parse(match[1]!);
      if (!valid(value)) throw new Error('invalid');
      annotations.push(value);
    } catch { warnings.push(`第 ${index + 1} 行样式注释无效，已跳过。`); }
  }
  const counts = new Map<string, number>();
  for (const a of annotations) counts.set(a.node, (counts.get(a.node) ?? 0) + 1);
  for (const [node, count] of counts) if (count > 1) warnings.push(`节点 ${node} 有重复样式注释，已跳过。`);
  return { annotations: annotations.filter(a => counts.get(a.node) === 1), warnings };
}

export function resolveStyles(label: string, styles: StyleSpec[]) {
  const warnings: string[] = [];
  const ranges: { start: number; end: number; type: StyleType }[] = [];
  for (const style of styles) {
    if (!style.text || !types.includes(style.type)) { warnings.push('无效样式，已跳过。'); continue; }
    const matches: number[] = [];
    let from = 0, at: number;
    while ((at = label.indexOf(style.text, from)) !== -1) { matches.push(at); from = at + style.text.length; }
    if (style.occurrence === undefined && matches.length > 1) {
      warnings.push(`“${style.text}”重复出现，请指定 occurrence（从 0 开始的出现序号）。`); continue;
    }
    const start = matches[style.occurrence ?? 0];
    if (start === undefined) { warnings.push(`找不到“${style.text}”，样式已跳过。`); continue; }
    ranges.push({ start, end: start + style.text.length, type: style.type });
  }
  const boundaries = [...new Set([0, label.length, ...ranges.flatMap(r => [r.start, r.end])])].sort((a,b) => a-b);
  const segments: { text: string; types: StyleType[] }[] = [];
  for (let i = 1; i < boundaries.length; i++) {
    const start = boundaries[i-1]!, end = boundaries[i]!;
    const active = types.filter(type => ranges.some(r => r.type === type && r.start <= start && r.end >= end));
    segments.push({ text: label.slice(start, end), types: active });
  }
  return { segments, warnings };
}

export function setNodeStyles(source: string, node: string, label: string, styles: StyleSpec[]): string {
  const annotation: NodeAnnotation = { version: 1, node, label, styles };
  if (!valid(annotation)) throw new Error('样式注释数据无效。');
  const replacement = `%% mermaid-plus: ${JSON.stringify(annotation)}`;
  // 保留行尾与所有不相关源码，遇到同节点重复注释时拒绝更新。
  const matches = [...source.matchAll(/^\s*%% mermaid-plus:[^\r\n]*/gm)].filter(m => {
    try { return JSON.parse(m[0].replace(prefix, '$1')).node === node; } catch { return false; }
  });
  if (matches.length > 1) throw new Error(`节点 ${node} 存在重复注释，请先修复。`);
  const match = matches[0];
  if (match) {
    const existing: unknown = JSON.parse(match[0].replace(prefix, '$1'));
    if (!valid(existing)) throw new Error(`节点 ${node} 的原注释无效或版本不受支持，请先修复。`);
    // \s 可包含空行；这里只替换注释本身，保留前导空白。
    const offset = match[0].indexOf('%%');
    const start = match.index! + offset;
    return source.slice(0, start) + replacement + source.slice(match.index! + match[0].length);
  }
  const eol = source.includes('\r\n') ? '\r\n' : '\n';
  return source + (source && !source.endsWith('\n') ? eol : '') + replacement + eol;
}
