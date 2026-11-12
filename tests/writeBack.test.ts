// 用途：验证写回笔记时只替换代码块内改动的行，并在代码块被别处修改时拒绝写入。
import test from 'node:test';
import assert from 'node:assert/strict';
import { blockChange } from '../src/writeBack';

const apply = (text: string, change: { from: number; to: number; insert: string }) => text.slice(0, change.from) + change.insert + text.slice(change.to);
const note = (eol: string) => ['# 标题', '', '```mermaid', 'flowchart TD', '  A --> B', '  B --> C', '```', '', '尾巴'].join(eol);

for (const eol of ['\n', '\r\n']) {
  test(`只替换改动的行，其余内容与行尾不变（${JSON.stringify(eol)}）`, () => {
    const text = note(eol);
    const change = blockChange(text, 2, 'flowchart TD\n  A --> B\n  B --> C', 'flowchart TD\n  A --> B["乙"]\n  B --> C')!;
    assert.equal(apply(text, change), text.replace('  A --> B' + eol, '  A --> B["乙"]' + eol));
    assert.equal(change.insert, '  A --> B["乙"]' + eol);
  });
}

test('在代码块末尾追加与删除行', () => {
  const text = note('\n');
  const before = 'flowchart TD\n  A --> B\n  B --> C';
  assert.equal(apply(text, blockChange(text, 2, before, before + '\n  C --> D')!), text.replace('  B --> C\n', '  B --> C\n  C --> D\n'));
  assert.equal(apply(text, blockChange(text, 2, before, 'flowchart TD\n  A --> B')!), text.replace('  B --> C\n', ''));
});

test('代码块已被别处修改或已移动时返回 null', () => {
  const text = note('\n');
  assert.equal(blockChange(text, 2, 'flowchart TD\n  A --> B', 'flowchart TD'), null);
  assert.equal(blockChange(text, 3, 'flowchart TD\n  A --> B\n  B --> C', 'flowchart TD'), null);
});
