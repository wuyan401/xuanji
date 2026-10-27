// XUANJI · 璇玑 — 极简 DOM 构建工具（Lead 维护；HUD 专用，避免直接 innerHTML 拼接）
// 用法：el('span', { class: 'ledger-mark', text: '遣' })
//       el('div', { class: 'row' }, [child1, child2])

type Child = Node | string | number | null | undefined | false;

export interface ElProps {
  class?: string;
  text?: string;
  html?: string;
  title?: string;
  role?: string;
  id?: string;
  style?: Partial<CSSStyleDeclaration> | string;
  dataset?: Record<string, string>;
  attrs?: Record<string, string | number | boolean | null | undefined>;
  on?: Partial<{ [K in keyof HTMLElementEventMap]: (ev: HTMLElementEventMap[K]) => void }>;
}

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  props: ElProps = {},
  children: Child[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (props.class) node.className = props.class;
  if (props.id) node.id = props.id;
  if (props.text != null) node.textContent = props.text;
  if (props.html != null) node.innerHTML = props.html;
  if (props.title) node.title = props.title;
  if (props.role) node.setAttribute('role', props.role);
  if (props.style) {
    if (typeof props.style === 'string') node.setAttribute('style', props.style);
    else Object.assign(node.style, props.style);
  }
  if (props.dataset) for (const [k, v] of Object.entries(props.dataset)) node.dataset[k] = v;
  if (props.attrs) {
    for (const [k, v] of Object.entries(props.attrs)) {
      if (v === false || v == null) continue;
      node.setAttribute(k, v === true ? '' : String(v));
    }
  }
  if (props.on) {
    for (const [k, fn] of Object.entries(props.on)) {
      if (fn) node.addEventListener(k, fn as EventListener);
    }
  }
  for (const c of children) {
    if (c == null || c === false) continue;
    node.appendChild(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return node;
}

/** 创建 svg 元素的轻量包装（HUD 内的图标用，避免依赖图标库） */
export function svgEl(tag: string, attrs: Record<string, string | number> = {}, children: Node[] = []): SVGElement {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  for (const c of children) node.appendChild(c);
  return node as SVGElement;
}

/** 安全设置文本（等价 textContent，语义化） */
export function setText(node: Element | null, text: string): void {
  if (node) node.textContent = text;
}

/** 清空子节点 */
export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}
