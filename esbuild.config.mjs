// 用途：构建 Obsidian 插件，并将可安装文件集中到 dist 目录。
import { context } from 'esbuild';
import { mkdir, copyFile } from 'node:fs/promises';
import { onlyUsedMermaid } from './scripts/onlyUsedMermaid.mjs';

await mkdir('dist', { recursive: true });
for (const file of ['manifest.json', 'styles.css']) await copyFile(file, `dist/${file}`);
const ctx = await context({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian', '@codemirror/state', '@codemirror/view'],
  sourcemap: false,
  minify: !process.argv.includes('--watch'),
  metafile: true,
  plugins: [onlyUsedMermaid],
  legalComments: 'none',
  // 插件里的中文提示按 UTF-8 原样写入，比默认的 \uXXXX 转义小一些。
  charset: 'utf8',
  logLevel: 'info',
  banner: { js: '/* Bundled mermaid (MIT License, https://github.com/mermaid-js/mermaid) and its dependencies; see their package licenses. */' },
});
if (process.argv.includes('--watch')) await ctx.watch();
else {
  const result = await ctx.rebuild(); await ctx.dispose();
  if (process.argv.includes('--analyze')) {
    const sizes = {};
    for (const [file, info] of Object.entries(result.metafile.outputs['dist/main.js'].inputs)) {
      const pkg = file.match(/node_modules\/((?:@[^/]+\/)?[^/]+)/)?.[1] ?? 'src';
      sizes[pkg] = (sizes[pkg] ?? 0) + info.bytesInOutput;
    }
    for (const [pkg, size] of Object.entries(sizes).sort((a, b) => b[1] - a[1]).slice(0, 20)) console.log(`${(size / 1024).toFixed(0).padStart(6)} KB  ${pkg}`);
  }
}
