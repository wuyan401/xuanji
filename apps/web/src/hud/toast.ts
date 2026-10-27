// XUANJI · 璇玑 — 底部居中短告（2.4s 自散，排队，最多同时 3 条）
import { el } from '../lib/dom';

export interface ToastsHandle {
  show(text: string): void;
  dispose(): void;
}

const LIFETIME = 2400;
const MAX_VISIBLE = 3;

export function createToasts(container: HTMLElement): ToastsHandle {
  const stack = el('div', {
    class: 'toasts',
    attrs: { role: 'status', 'aria-live': 'polite', 'aria-atomic': 'false' },
  });
  container.appendChild(stack);

  const timers = new Set<number>();
  const queue: string[] = [];
  const live = new Set<HTMLElement>();
  let disposed = false;

  function later(fn: () => void, ms: number): void {
    const id = window.setTimeout(() => {
      timers.delete(id);
      if (!disposed) fn();
    }, ms);
    timers.add(id);
  }

  function dismiss(node: HTMLElement): void {
    if (!node.isConnected) return;
    node.classList.add('is-out');
    later(() => {
      node.remove();
      live.delete(node);
      next();
    }, 200);
  }

  function spawn(text: string): void {
    const node = el('div', { class: 'toast' }, [
      el('i', { class: 'toast-mark', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'toast-text', text }),
    ]);
    stack.appendChild(node);
    live.add(node);
    later(() => dismiss(node), LIFETIME);
  }

  function next(): void {
    if (disposed) return;
    while (queue.length > 0 && live.size < MAX_VISIBLE) {
      const text = queue.shift();
      if (text != null) spawn(text);
    }
  }

  return {
    show(text: string): void {
      if (disposed || !text) return;
      if (live.size >= MAX_VISIBLE) {
        // 满员时挤掉最老的一条，保持「最新的话听得见」
        const oldest = live.values().next().value as HTMLElement | undefined;
        if (oldest) {
          live.delete(oldest);
          oldest.remove();
        }
        spawn(text);
        return;
      }
      spawn(text);
    },
    dispose(): void {
      disposed = true;
      for (const id of timers) window.clearTimeout(id);
      timers.clear();
      queue.length = 0;
      live.clear();
      stack.remove();
    },
  };
}
