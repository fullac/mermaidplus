// 用途：Mermaid 原生 Markdown 标签（"`**粗** *斜*`"）的识别，以及编辑框里给选中文字加 / 去粗体、斜体。
// Mermaid 的 Markdown 标签只支持粗体和斜体；行内代码、高亮仍用插件的样式注释。

export type Mark = 'bold' | 'italic';

/** 源码标签是否为 Markdown 字符串（整段被反引号包住）。 */
export function isMarkdownRaw(raw: string) {
  return /^`[\s\S]*`$/.test(raw);
}

/** 文字里是否有成对的 **粗体** 或 *斜体* 标记。只认星号，避免把 user_id 之类的下划线当成格式。 */
export function hasMarkdownMarks(text: string) {
  return /\*\*[^*\n](?:[^\n]*?[^*\n])?\*\*/.test(text) || /(^|[^*])\*[^*\s](?:[^*\n]*?[^*\s])?\*(?!\*)/.test(text);
}

const STARS: Record<Mark, number> = { bold: 2, italic: 1 };
/** 连续星号数量 n 中是否含有这种格式：1 斜、2 粗、3 粗+斜。 */
const holds = (n: number, mark: Mark) => mark === 'bold' ? n >= 2 : n === 1 || n === 3;

/**
 * 给 [start, end) 的文字切换粗体或斜体，返回新文字和新的选区。
 * 选区两端的空白不放进标记里（Markdown 不认 “** 文字**”）；选区内或紧贴选区外已有同种标记时去掉，否则加上。
 */
export function toggleMark(value: string, start: number, end: number, mark: Mark) {
  while (start < end && /\s/.test(value[start]!)) start++;
  while (end > start && /\s/.test(value[end - 1]!)) end--;
  if (start === end) return { value, start, end };
  const n = STARS[mark], stars = '*'.repeat(n);
  const run = (from: number, step: 1 | -1, limit: number) => { let count = 0; for (let i = from; step > 0 ? i < limit : i >= limit; i += step) { if (value[i] !== '*') break; count++; } return count; };
  // 标记在选区外侧：**[文字]**
  const before = run(start - 1, -1, 0), after = run(end, 1, value.length);
  if (holds(Math.min(before, after), mark)) {
    return { value: value.slice(0, start - n) + value.slice(start, end) + value.slice(end + n), start: start - n, end: end - n };
  }
  // 标记在选区内侧：[**文字**]
  const inner = value.slice(start, end);
  const lead = run(start, 1, end), trail = run(end - 1, -1, start);
  if (lead < inner.length && holds(Math.min(lead, trail), mark)) {
    return { value: value.slice(0, start) + inner.slice(n, inner.length - n) + value.slice(end), start, end: end - 2 * n };
  }
  return { value: value.slice(0, start) + stars + inner + stars + value.slice(end), start: start + n, end: end + n };
}
