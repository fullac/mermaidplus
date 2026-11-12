// 用途：定位笔记中的 Mermaid 代码块，并计算写回时的最小文本替换；不依赖 Obsidian，便于测试。
import { changedLines } from './edit';
import { findMermaidBlocks } from './flowchart';

/** 在笔记全文中找到要改的代码块：开头行必须一致，内容必须仍是 expected，否则视为冲突。 */
export function locate(text: string, line: number, expected?: string) {
  const block = findMermaidBlocks(text).find(b => b.start === line);
  if (!block || (expected !== undefined && block.source !== expected)) return null;
  return block;
}

/**
 * 计算把代码块内容从 before 改成 after 所需的最小文本替换（字符偏移）。
 * 代码块不在原处或内容已不是 before 时返回 null（冲突）。
 */
export function blockChange(text: string, line: number, before: string, after: string) {
  const block = locate(text, line, before);
  if (!block) return null;
  const diff = changedLines(before, after);
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.split(/\r?\n/);
  // 内容第 k 行位于全文第 start + 1 + k 行；diff.to 最大指向结束围栏，一定存在。
  const offset = (index: number) => { let n = 0; for (let i = 0; i < index; i++) n += lines[i]!.length + eol.length; return n; };
  return { from: offset(block.start + 1 + diff.from), to: offset(block.start + 1 + diff.to), insert: diff.lines.map(l => l + eol).join('') };
}
