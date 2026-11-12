# Mermaid Plus

Obsidian 插件，让 Mermaid 流程图更好看，还能直接在图上改。只支持桌面版。

## 能做什么

画得更清楚：

- 连线只走横线和竖线，交叉的地方画一个小半圆跳过去。不喜欢可以改回曲线。
- 间距比默认的紧凑，同样的图占的地方更小。
- 可以统一改成从上往下排，或者让插件自己挑横排还是竖排，选放进笔记里更好看的那个。
- 主题、字体、字号、背景色都能改。阅读视图、实时预览和编辑时看到的图完全一样。

直接在图上改，改完自动写回笔记：

- 鼠标移到图上，右上角点“编辑”。
- 单击选中节点或连线，双击改文字，双击空白处加节点。
- 从节点边上的圆点拖出去：拖到另一个节点上就连线，拖到空白处就新建一个节点并连过去。
- 拖动节点调整位置，方向键可以微调。
- 选中一段文字可以加粗、斜体。
- Delete 删除，Cmd/Ctrl+Z 撤销，Esc 退出。

写回时只改动到的那几行，笔记里其他内容不会动。如果这个代码块在别处被改过，插件不会覆盖它。

节点位置存在代码块最后一行注释里，加粗、斜体用的是 Mermaid 自己的写法。所以没装插件的地方（手机、发布的网站、别的编辑器）也能正常显示，只是没有插件的这些样式。

只处理流程图（`flowchart` / `graph`），时序图等其他图还是交给 Obsidian 自己画。

## 安装

在 [Releases](https://github.com/fullac/mermaidplus/releases) 下载最新的 `mermaid-plus-<版本>.zip`，解压到库里的 `.obsidian/plugins/` 下面，然后在 Obsidian 的“第三方插件”里启用 Mermaid Plus。

还没在真实的 Obsidian 里完整验收过，建议先装在一个测试库里试。

## 自己构建

```sh
npm ci
npm run package
```

会生成 `dist/mermaid-plus-<版本>.zip`。跑测试用 `npm run check` 和 `npm run test:browser`。

每个版本改了什么见 [CHANGELOG.md](CHANGELOG.md)。
