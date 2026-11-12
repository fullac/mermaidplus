// 用途：把 dist 中的三个插件文件打包成 dist/mermaid-plus-<版本>.zip，解压即得 mermaid-plus 目录。
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, copyFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const { version } = JSON.parse(readFileSync('manifest.json', 'utf8'));
const out = resolve(`dist/mermaid-plus-${version}.zip`);
const work = mkdtempSync(join(tmpdir(), 'mp-pkg-'));
mkdirSync(join(work, 'mermaid-plus'));
for (const file of ['main.js', 'manifest.json', 'styles.css']) copyFileSync(`dist/${file}`, join(work, 'mermaid-plus', file));
rmSync(out, { force: true });
execFileSync('zip', ['-qr', out, 'mermaid-plus'], { cwd: work });
rmSync(work, { recursive: true, force: true });
console.log(`已生成 ${out}`);
