// 用途：验证样式注释的错绑保护、重叠片段和源码更新保真。
import test from 'node:test';
import assert from 'node:assert/strict';
import { readAnnotations, resolveStyles, setNodeStyles } from '../src/annotations';

const annotation = { version: 1, node: 'A', label: '调用 getUser()，检查权限', styles: [{ text: 'getUser()', type: 'code' }] };
const comment = (value: unknown) => `%% mermaid-plus: ${JSON.stringify(value)}`;

test('只读取合法协议；无关注释不受影响', () => {
  const result = readAnnotations(`flowchart TD\n%% 普通说明\nA["测试"]\n${comment(annotation)}`);
  assert.deepEqual(result.annotations, [annotation]);
  assert.deepEqual(result.warnings, []);
});

test('损坏数据、未来版本、未知样式及重复节点全部跳过', () => {
  const invalid = [null, { ...annotation, version: 2 }, { ...annotation, styles: [{ text: '调用', type: 'script' }] },
    { ...annotation, styles: [{ text: '调用', type: 'code', occurrence: -1 }] }];
  const result = readAnnotations([...invalid.map(comment), '%% mermaid-plus: {broken', comment(annotation), comment(annotation)].join('\n'));
  assert.deepEqual(result.annotations, []);
  assert.equal(result.warnings.length, 6);
});

test('中文与 emoji 不丢字符；交叉样式仅叠加在交集', () => {
  const label = '调用😀getUser()';
  const { segments, warnings } = resolveStyles(label, [{ text: '😀getUser()', type: 'code' }, { text: '调用😀', type: 'highlight' }]);
  assert.equal(segments.map(s => s.text).join(''), label);
  assert.deepEqual(segments, [
    { text: '调用', types: ['highlight'] },
    { text: '😀', types: ['code', 'highlight'] },
    { text: 'getUser()', types: ['code'] },
  ]);
  assert.deepEqual(warnings, []);
});

test('重复文字必须指定序号；指定第二次不会误改第一次', () => {
  assert.equal(resolveStyles('重试，重试', [{ text: '重试', type: 'bold' }]).warnings.length, 1);
  const result = resolveStyles('重试，重试', [{ text: '重试', type: 'bold', occurrence: 1 }]);
  assert.deepEqual(result.segments, [{ text: '重试，', types: [] }, { text: '重试', types: ['bold'] }]);
  assert.equal(resolveStyles('重试', [{ text: '重试', type: 'bold', occurrence: 8 }]).warnings.length, 1);
});

test('失效锚点跳过，原标签仍完整保留', () => {
  const result = resolveStyles('调用 getAccount()', [{ text: 'getUser()', type: 'code' }]);
  assert.equal(result.warnings.length, 1);
  assert.deepEqual(result.segments, [{ text: '调用 getAccount()', types: [] }]);
});

test('更新注释保留 CRLF、缩进、其他节点注释和任意后续源码', () => {
  const other = comment({ ...annotation, node: 'B' });
  const before = `flowchart TD\r\nA["${annotation.label}"]\r\n\r\n  ${comment(annotation)}\r\n${other}\r\n%% 原始说明\r\n`;
  const next = setNodeStyles(before, 'A', annotation.label, [{ text: '检查权限', type: 'bold' }]);
  assert.equal(next, before.replace(comment(annotation), comment({ ...annotation, styles: [{ text: '检查权限', type: 'bold' }] })));
  assert.equal(readAnnotations(next).annotations.length, 2);
});

test('新增注释保留无尾换行文档的原文，且只添加一条样式注释', () => {
  const source = 'flowchart TD\nA["hello"]';
  const next = setNodeStyles(source, 'A', 'hello', [{ text: 'hello', type: 'italic' }]);
  assert.ok(next.startsWith(source + '\n'));
  assert.equal(readAnnotations(next).annotations.length, 1);
  assert.equal(setNodeStyles(next, 'A', 'hello', []).split('%% mermaid-plus:').length, 2);
});

test('拒绝覆盖未来协议与重复注释，拒绝无效输入', () => {
  assert.throws(() => setNodeStyles(comment({ ...annotation, version: 2 }), 'A', annotation.label, []));
  assert.throws(() => setNodeStyles(`${comment(annotation)}\n${comment(annotation)}`, 'A', annotation.label, []));
  assert.throws(() => setNodeStyles('flowchart TD', 'A', 'x', [{ text: '', type: 'code' }]));
});
