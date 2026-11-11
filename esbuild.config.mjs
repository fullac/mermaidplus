// 用途：构建 Obsidian 插件，并将可安装文件集中到 dist 目录。
import { context } from 'esbuild';
import { mkdir, copyFile, readFile } from 'node:fs/promises';

await mkdir('dist', { recursive: true });
for (const file of ['manifest.json', 'styles.css']) await copyFile(file, `dist/${file}`);
const ctx = await context({
  entryPoints: ['src/main.ts'],
  outfile: 'dist/main.js',
  bundle: true,
  format: 'cjs',
  target: 'es2022',
  external: ['obsidian'],
  sourcemap: false,
  logLevel: 'info',
  banner: { js: '/* Bundled dependency licenses:\n' + (await Promise.all(
    ['@dagrejs/dagre', '@dagrejs/graphlib'].map(async name => `${name}\n${await readFile(`node_modules/${name}/LICENSE`, 'utf8')}`),
  )).join('\n') + '\n*/' },
});
if (process.argv.includes('--watch')) await ctx.watch();
else { await ctx.rebuild(); await ctx.dispose(); }
