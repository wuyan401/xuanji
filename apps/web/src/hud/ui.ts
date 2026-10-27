// XUANJI · 璇玑 — HUD 内部小工具（焦点陷阱 / 关闭钮 / rAF 节流 / 滚动）
// 只服务于 hud/**，不对外导出。图标一律内联 SVG，不引图标库。
import { el, svgEl } from '../lib/dom';

export interface Throttled<A extends unknown[]> {
  (...args: A): void;
  cancel(): void;
}

/** rAF 节流：调参台滑杆高频输入时合并到一帧，避免连续回写场景 */
export function rafThrottle<A extends unknown[]>(fn: (...args: A) => void): Throttled<A> {
  let pending: A | null = null;
  let raf = 0;
  const run = ((...args: A): void => {
    pending = args;
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      const a = pending;
      pending = null;
      if (a) fn(...a);
    });
  }) as Throttled<A>;
  run.cancel = (): void => {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    pending = null;
  };
  return run;
}

/** 关闭按钮（内联 SVG 交叉线；点击区域 40px 由 CSS 保证） */
export function makeCloseButton(label: string, onClose: () => void): HTMLButtonElement {
  const btn = el('button', {
    class: 'xj-close',
    title: label,
    attrs: { type: 'button', 'aria-label': label },
  });
  const svg = svgEl('svg', {
    viewBox: '0 0 12 12',
    width: 11,
    height: 11,
    'aria-hidden': 'true',
    focusable: 'false',
  });
  svg.appendChild(
    svgEl('path', {
      d: 'M2 2 L10 10 M10 2 L2 10',
      stroke: 'currentColor',
      'stroke-width': '1.2',
      fill: 'none',
      'stroke-linecap': 'round',
    }),
  );
  btn.appendChild(svg);
  btn.addEventListener('click', (ev) => {
    ev.stopPropagation();
    onClose();
  });
  return btn;
}

/** 焦点元素清单（可见、未禁用） */
export function focusables(root: HTMLElement): HTMLElement[] {
  const raw = root.querySelectorAll<HTMLElement>(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])',
  );
  const out: HTMLElement[] = [];
  for (const node of Array.from(raw)) {
    if (node.offsetParent !== null || node === document.activeElement) out.push(node);
  }
  return out;
}

/**
 * 浮层内 Tab 循环。返回 true 表示本次按键已被 HUD 消费。
 * 只在浮层打开时调用。
 */
export function trapTab(e: KeyboardEvent, root: HTMLElement): boolean {
  const list = focusables(root);
  if (list.length === 0) {
    e.preventDefault();
    return true;
  }
  const first = list[0];
  const last = list[list.length - 1];
  const active = document.activeElement as HTMLElement | null;
  const inside = active ? root.contains(active) : false;
  if (e.shiftKey) {
    if (!inside || active === first) {
      last.focus();
      e.preventDefault();
    }
  } else if (!inside || active === last) {
    first.focus();
    e.preventDefault();
  }
  return true;
}

/** 滚动容器内把一个节点滚到可见处（block: 'nearest' 语义的轻实现） */
export function scrollIntoViewIfNeeded(node: HTMLElement, scroller: HTMLElement): void {
  const nodeTop = node.offsetTop;
  const nodeBottom = nodeTop + node.offsetHeight;
  const viewTop = scroller.scrollTop;
  const viewBottom = viewTop + scroller.clientHeight;
  if (nodeTop < viewTop) scroller.scrollTop = nodeTop - 4;
  else if (nodeBottom > viewBottom) scroller.scrollTop = nodeBottom - scroller.clientHeight + 4;
}

/** 把容器滚动到底部（plain: 不启用 smooth，账本落墨用瞬时贴底更稳） */
export function scrollToBottom(node: HTMLElement, smooth = false): void {
  if (smooth) {
    node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
  } else {
    node.scrollTop = node.scrollHeight;
  }
}

/** 距底部是否在阈值内（判断用户是否在追读最新一笔） */
export function nearBottom(node: HTMLElement, threshold = 16): boolean {
  return node.scrollHeight - node.scrollTop - node.clientHeight <= threshold;
}

/** 目标是否是可编辑控件（HUD 处理键盘时自行兜底，不依赖 main 的顺序） */
export function isEditableTarget(target: EventTarget | null): boolean {
  const node = target as HTMLElement | null;
  if (!node || !node.tagName) return false;
  const tag = node.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
  return node.isContentEditable === true;
}
