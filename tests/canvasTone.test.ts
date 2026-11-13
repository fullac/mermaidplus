// 用途：画布明暗按自定义底色的亮度判断；透明背景跟随主题。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { canvasTone, relativeLuminance } from '../src/canvasTone';

const doc = (dark: boolean) => ({ body: { classList: { contains: (name: string) => dark && name === 'theme-dark' } } }) as unknown as Document;

test('近白和浅色自定义底色标成浅色画布', () => {
  assert.equal(canvasTone({ theme: 'dark', background: '#fafafa' }, doc(true)), 'light');
  assert.equal(canvasTone({ theme: 'auto', background: '#dbeafe' }, doc(true)), 'light');
  assert.ok((relativeLuminance('#fafafa') ?? 0) > 0.4);
});

test('深色自定义底色标成深色画布', () => {
  assert.equal(canvasTone({ theme: 'default', background: '#202124' }, doc(false)), 'dark');
});

test('透明背景跟随已解析的主题，不把暗色宿主误标成浅色', () => {
  assert.equal(canvasTone({ theme: 'auto', background: '' }, doc(true)), 'dark');
  assert.equal(canvasTone({ theme: 'auto', background: '' }, doc(false)), 'light');
  assert.equal(canvasTone({ theme: 'default', background: '' }, doc(true)), 'light');
  assert.equal(canvasTone({ theme: 'dark', background: 'transparent' }, doc(false)), 'dark');
});
