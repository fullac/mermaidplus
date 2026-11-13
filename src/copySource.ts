// 用途：把一张图的 Mermaid 源码复制到剪贴板。用宿主所在窗口的剪贴板，弹出窗口也能复制。
export async function copyDiagramSource(host: HTMLElement, source: string): Promise<boolean> {
  const nav = host.ownerDocument.defaultView?.navigator ?? navigator;
  try {
    await nav.clipboard.writeText(source);
    return true;
  } catch {
    return false;
  }
}
