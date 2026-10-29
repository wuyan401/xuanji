// XUANJI · 璇玑 — 帮助（卷宗页）
// §17.6：页眉 1px 线 + 页码（壹/叁）+ 右下落款「璇玑 · 非商业使用」；不用弹窗阴影、不加圆角。
import { el, setText } from '../lib/dom';
import type { ConnectionState, SourceKind } from '../state/types';
import { trapTab } from './ui';

export interface HelpHandle {
  root: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  handleKey(e: KeyboardEvent): boolean;
  setSource(source: SourceKind | null, connection: ConnectionState): void;
  dispose(): void;
}

interface KeyRow {
  keys: string;
  action: string;
  note?: string;
}

const KEY_ROWS: KeyRow[] = [
  { keys: '1 – 7', action: '七式', note: '云图 · 逐星 · 勘验 · 起居注 · 浑仪 · 拂扫 · 守夜' },
  { keys: '↑ ↓', action: '择星', note: '在浑仪名册里换一颗星' },
  { keys: 'Enter', action: '勘验', note: '打开选中之星的星牒' },
  { keys: 'Space', action: '自动运镜开关', note: '关闭 = 视野已锁，只随你动手' },
  { keys: '滚轮', action: '缩放（对准光标）', note: '光标之下，看得更深' },
  { keys: '双击', action: '复位视野', note: '回云图、清掉缩放与平移' },
  { keys: '视野', action: '会记住：刷新恢复上次取景' },
  { keys: '?reset=1', action: '清空视野', note: '地址后加此参数，回到初始机位' },
  { keys: 'L', action: '起居注', note: '把画面让给这本史书' },
  { keys: '/', action: '调参台', note: '二十五项仪轨' },
  { keys: '?', action: '本卷' },
  { keys: '`', action: '统计覆层', note: '帧率与画质' },
  { keys: 'W', action: '藏 / 显界面' },
  { keys: 'T', action: '切换主题', note: '璇玑（青铜史书）／ 深空（舰桥仪表）' },
  { keys: '[', action: '收放左下面板', note: '起居注 ／ 机枢 ／ 工籍' },
  { keys: ']', action: '收放右方面板', note: '星牒 ／ 器录 ／ 器牒' },
  { keys: 'Esc', action: '收起浮层 · 取消选中' },
  { keys: 'Tab', action: '在打开的浮层内循环' },
];

const SOURCE_CN: Record<SourceKind, string> = {
  live: '实况',
  demo: '演练（假源数据，非真实会话）',
  replay: '回放（历史记录）',
};

export function createHelp(parent: HTMLElement): HelpHandle {
  let open = false;
  let lastFocused: HTMLElement | null = null;

  const backdrop = el('div', { class: 'hp-backdrop', attrs: { 'aria-hidden': 'true' } });
  backdrop.hidden = true;

  const root = el('section', {
    class: 'hp',
    attrs: { role: 'dialog', 'aria-modal': 'true', 'aria-label': '帮助 · 卷宗' },
  });
  root.dataset.open = 'false';
  root.hidden = true;

  const pageNum = el('span', { class: 'hp-page-num', text: '壹 / 叁' });
  const pageHead = el('header', { class: 'hp-head' }, [
    el('span', { class: 'hp-head-title', text: '卷宗' }),
    pageNum,
  ]);

  const sourceText = el('p', { class: 'hp-source-text' });
  const concept = el('p', {
    class: 'hp-concept',
    text: '璇玑把本机 DSH 里每一个正在工作的 agent 点成夜空中的一星——浑仪示其位，起居注记其行，星牒存其档。',
  });
  const conceptTheme = el('p', {
    class: 'hp-concept hp-concept--theme',
    text: '两套主题：璇玑（青铜史书）／ 深空（舰桥仪表）——T 键或顶栏主题铭牌切换，视图与布局不变。',
  });

  const keyTable = el('dl', { class: 'hp-keys' });
  for (const row of KEY_ROWS) {
    const keys = el('dt', { class: 'hp-key' });
    keys.textContent = row.keys;
    const dd = el('dd', { class: 'hp-key-action' });
    dd.appendChild(el('span', { class: 'hp-key-do', text: row.action }));
    if (row.note) dd.appendChild(el('span', { class: 'hp-key-note', text: row.note }));
    keyTable.appendChild(el('div', { class: 'hp-key-row' }, [keys, dd]));
  }

  const closeBtn = el('button', {
    class: 'xj-close hp-close',
    attrs: { type: 'button', 'aria-label': '收起帮助' },
  });
  closeBtn.textContent = '✕';

  const body = el('div', { class: 'hp-body' }, [
    el('section', { class: 'hp-sec' }, [
      el('h2', { class: 'hp-sec-title', text: '一 · 何谓璇玑' }),
      concept,
      conceptTheme,
    ]),
    el('section', { class: 'hp-sec' }, [
      el('h2', { class: 'hp-sec-title', text: '二 · 键位' }),
      keyTable,
    ]),
    el('section', { class: 'hp-sec' }, [
      el('h2', { class: 'hp-sec-title', text: '三 · 数据来源' }),
      sourceText,
      el('p', {
        class: 'hp-fine',
        text: '只读采集器 · 断线时浑仪停转、起居注记「墨尽」。所有数字来自本机 DSH 事件流，页面不编造任何数据。点顶栏「授时」小印，可再看一次开机。',
      }),
    ]),
  ]);

  const sign = el('footer', { class: 'hp-foot' }, [
    el('span', { class: 'hp-foot-left', text: 'HALOFLUX by Ryder191 · 仅借鉴架构思想' }),
    el('span', { class: 'hp-foot-right', text: '璇玑 · 非商业使用' }),
  ]);

  root.append(pageHead, closeBtn, body, sign);
  parent.appendChild(backdrop);
  parent.appendChild(root);

  function setSource(source: SourceKind | null, connection: ConnectionState): void {
    const state =
      connection === 'offline'
        ? '离线 · 与采集器失联'
        : connection === 'reconnecting'
          ? '重连中'
          : connection === 'connecting'
            ? '连接中'
            : '已连接';
    const kind = source ? SOURCE_CN[source] : '尚未收到数据';
    setText(sourceText, `本机 DSH 采集器（127.0.0.1:8787）· ${state} · 当前：${kind}。`);
  }
  setSource(null, 'connecting');

  function openPanel(): void {
    if (open) return;
    open = true;
    lastFocused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    root.hidden = false;
    backdrop.hidden = false;
    root.dataset.open = 'true';
    document.documentElement.classList.add('xj-locked');
    requestAnimationFrame(() => {
      root.classList.add('is-in');
      backdrop.classList.add('is-in');
      closeBtn.focus({ preventScroll: true });
    });
  }

  function close(): void {
    if (!open) return;
    open = false;
    root.dataset.open = 'false';
    root.classList.remove('is-in');
    backdrop.classList.remove('is-in');
    document.documentElement.classList.remove('xj-locked');
    if (lastFocused && lastFocused.isConnected) lastFocused.focus({ preventScroll: true });
    lastFocused = null;
    window.setTimeout(() => {
      if (open) return;
      root.hidden = true;
      backdrop.hidden = true;
    }, 200);
  }

  closeBtn.addEventListener('click', close);
  backdrop.addEventListener('click', close);

  function handleKey(e: KeyboardEvent): boolean {
    if (!open) return false;
    if (e.key === 'Escape') {
      close();
      return true;
    }
    if (e.key === 'Tab') return trapTab(e, root);
    return false;
  }

  return {
    root,
    open: openPanel,
    close,
    isOpen: () => open,
    handleKey,
    setSource,
    dispose(): void {
      document.documentElement.classList.remove('xj-locked');
      backdrop.remove();
      root.remove();
    },
  };
}
