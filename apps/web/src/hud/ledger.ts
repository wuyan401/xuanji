// XUANJI · 璇玑 — 《起居注》：一本会自己落墨的史书（DOM 实时账本）
// 落墨：clip-path 自左向右展开（禁用 opacity+translateY 作主入场）；朱批/钤印 180ms 后盖章。
// 纪律：单行档案行、无竖线、无斑马纹、不卡片化；上限 120 行；用户上读时不抢滚动。
import { el } from '../lib/dom';
import { formatClock, truncate } from '../lib/format';
import type {
  AstroEvent,
  ClientFleetSnapshot,
  ConnectionState,
  SourceKind,
} from '../state/types';
import { sourceShort } from '../state/types';
import {
  DIVIDER_INTERVAL,
  SHIERCI,
  buildRow,
  dividerTime,
  volumeLabel,
  type LedgerContext,
  type LedgerRow,
} from './ledger-templates';
import { nearBottom, scrollToBottom } from './ui';

const MAX_ROWS = 120;
const ANNOUNCE_GAP = 2000;
const STAMP_DELAY = 180;

export interface LedgerCallbacks {
  onSelectSession(id: string): void;
}

export interface LedgerHandle {
  root: HTMLElement;
  setFleet(snap: ClientFleetSnapshot): void;
  pushEvents(events: AstroEvent[]): void;
  setConnection(state: ConnectionState): void;
  setSelection(id: string | null): void;
  setReducedMotion(reduced: boolean): void;
  focus(): void;
  handleKey(e: KeyboardEvent): boolean;
  rowCount(): number;
  dispose(): void;
}

interface RowEntry {
  row: LedgerRow;
  node: HTMLElement;
  /** 时间列是否复用上一行（同一刻内的连续记录不再重复写时辰） */
  ditto: boolean;
}

function makeStamp(text: string, vertical: boolean): HTMLElement {
  const stamp = el('span', { class: vertical ? 'led-vertical' : 'led-stamp', attrs: { 'aria-hidden': 'true' } });
  stamp.textContent = text;
  return stamp;
}

export function createLedger(parent: HTMLElement, cb: LedgerCallbacks): LedgerHandle {
  // ── 骨架 ────────────────────────────────────────────────────
  const root = el('aside', {
    class: 'led',
    attrs: { 'aria-label': '《起居注》 · 事件实时账本', 'data-expanded': 'false' },
  });
  root.dataset.open = 'false';

  const grip = el('button', {
    class: 'led-grip',
    attrs: { type: 'button', 'aria-label': '展开《起居注》', 'aria-expanded': 'false' },
  });

  const vertical = makeStamp('起居', true);
  const volText = el('span', { class: 'led-vol', text: '卷〇一' });
  const head = el('div', { class: 'led-head' }, [
    grip,
    vertical,
    el('div', { class: 'led-title' }, [
      el('h2', { class: 'led-title-main', text: '起居注' }),
      el('span', { class: 'led-title-sub', text: '实况 · 落墨' }),
    ]),
    el('div', { class: 'led-head-right' }, [
      el('span', { class: 'led-pulse', attrs: { 'aria-hidden': 'true' } }),
      volText,
    ]),
  ]);

  const offlineText = el('span', { class: 'led-offline-text' });
  const offline = el('div', { class: 'led-offline' }, [
    el('i', { class: 'led-offline-mark', text: '墨尽', attrs: { 'aria-hidden': 'true' } }),
    offlineText,
  ]);
  offline.hidden = true;

  const body = el('div', {
    class: 'led-body',
    attrs: { role: 'region', 'aria-label': '起居注条目', tabindex: '0' },
  });

  const emptyText = el('p', { class: 'led-empty-text' });
  const emptySub = el('p', { class: 'led-empty-sub' });
  const empty = el('div', { class: 'led-empty' }, [emptyText, emptySub]);

  const newMore = el('button', {
    class: 'led-new',
    attrs: { type: 'button', 'aria-label': '有新墨，跳到最新一条' },
  });
  newMore.textContent = '新墨 ↓';
  newMore.hidden = true;

  const live = el('div', {
    class: 'led-live',
    attrs: { role: 'log', 'aria-live': 'polite', 'aria-relevant': 'additions', 'aria-atomic': 'false' },
  });

  root.append(head, offline, body, newMore, live);
  body.appendChild(empty);
  parent.appendChild(root);
  root.dataset.connection = 'connecting';
  root.dataset.source = 'none';

  // ── 状态 ────────────────────────────────────────────────────
  const ctx: LedgerContext = {
    sessions: new Map(),
    domains: new Map(),
    source: null,
    now: Date.now(),
  };

  let volume = 1;
  let lastDividerAt = 0;
  let connection: ConnectionState = 'connecting';
  let selectedId: string | null = null;
  let reduced = false;
  let rowCount = 0;

  const entries: RowEntry[] = [];
  const seen = new Set<string>();
  const stampTimers = new Set<number>();
  const announceQueue: string[] = [];
  const announceLines: HTMLElement[] = [];
  let announceTimer = 0;

  let follow = true;
  let hoverPause = false;
  let activeIndex = -1;
  /** ≥2 个已发现来源时，账本行首加来源短名小签（BIBLE §19.1） */
  let multiSource = false;
  /** 当前时间脊柱所在的「刻」（一刻 = 15 分钟）；-1 表示需要重新写时辰 */
  let spineBucket = -1;
  const SHICHEN_KE_MS = 15 * 60 * 1000;

  // 恢复连接后补写的一笔「续」
  let lostInk = false;

  // ── 落墨 ────────────────────────────────────────────────────
  function scheduleStamp(node: HTMLElement): void {
    const seal = node.querySelector<HTMLElement>('.led-seal');
    if (!seal) return;
    if (reduced) {
      seal.classList.add('is-stamped');
      return;
    }
    const id = window.setTimeout(() => {
      stampTimers.delete(id);
      seal.classList.add('is-stamped');
    }, STAMP_DELAY);
    stampTimers.add(id);
  }

  function rowNode(entry: LedgerRow, ditto: boolean): HTMLElement {
    const node = el('button', {
      class: 'led-row',
      attrs: {
        type: 'button',
        tabindex: '-1',
        'aria-label': entry.summary,
        title: [
          entry.domain,
          entry.workspace ? `行 ${entry.workspace}` : '',
          entry.sessionTitle,
          entry.detail,
        ]
          .filter(Boolean)
          .join(' · '),
      },
    });
    node.dataset.kind = entry.kind;
    if (entry.isError) node.classList.add('is-error');
    if (entry.isRipple) node.classList.add('is-ripple');
    if (entry.isArchived) node.classList.add('is-archived');
    if (entry.sessionId === selectedId) node.classList.add('is-sel');

    // 来源小签（仅多来源时显示；单来源省略，保持整行留白）
    const session = ctx.sessions.get(entry.sessionId);
    const srcTag = el('span', { class: 'led-src', attrs: { 'aria-hidden': 'true' } });
    if (multiSource && session) {
      srcTag.textContent = sourceShort(session.source);
      srcTag.dataset.source = session.source;
    } else {
      srcTag.hidden = true;
    }

    // 时间列是一根「刻」的脊柱：同一刻内后续记录用史书叠记号 〃，不再重复写时辰
    const time = el('span', {
      class: ditto ? 'led-time is-ditto' : 'led-time',
      text: ditto ? '〃' : entry.time,
      attrs: ditto ? { 'aria-label': entry.time } : {},
    });
    const domain = el('span', { class: 'led-domain', text: entry.domain });
    const ws = el('span', { class: 'led-ws', text: truncate(entry.workspace, 22) });
    const star = el('span', { class: 'led-star' }, [domain, ws]);

    const mark = el('i', { class: 'led-mark', attrs: { 'aria-hidden': 'true' } });
    if (entry.mark) {
      mark.textContent = entry.mark;
      if (entry.cat) mark.dataset.cat = entry.cat;
    } else {
      mark.classList.add('is-blank');
    }
    const main = el('span', { class: 'led-main' }, [
      mark,
      el('span', { class: 'led-text', text: entry.text }),
    ]);

    const meta = el('span', { class: 'led-meta', text: entry.meta });
    const seal = el('span', { class: 'led-seal', attrs: { 'aria-hidden': 'true' } });
    if (entry.seal) {
      seal.dataset.seal = entry.seal;
      seal.textContent = entry.seal === 'zhu' ? '朱批' : '钤印';
    } else {
      seal.classList.add('is-none');
    }
    const demo = el('span', { class: 'led-demo', attrs: { 'aria-hidden': 'true' } });
    if (entry.demo) demo.textContent = '演';

    node.append(srcTag, time, star, main, meta, seal, demo);
    node.addEventListener('click', () => {
      cb.onSelectSession(entry.sessionId);
      node.focus({ preventScroll: true });
      const idx = entries.findIndex((item) => item.node === node);
      if (idx >= 0) activeIndex = idx;
    });
    return node;
  }

  function dividerNode(at: number, label: string): HTMLElement {
    const node = el('div', { class: 'led-div', attrs: { role: 'separator', 'aria-label': label } }, [
      el('span', { class: 'led-div-line', attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'led-div-text', text: label }),
      el('span', { class: 'led-div-line', attrs: { 'aria-hidden': 'true' } }),
    ]);
    node.dataset.at = String(at);
    return node;
  }

  function updateEmpty(): void {
    const hasRows = rowCount > 0;
    empty.hidden = hasRows;
    if (hasRows) return;
    if (connection === 'offline' || connection === 'reconnecting') {
      emptyText.textContent = '墨尽。';
      emptySub.textContent = '与采集器失联，正在重连……';
    } else if (connection === 'connecting') {
      emptyText.textContent = '墨未至。';
      emptySub.textContent = '正在候采集器回话，仪器仍在走时。';
    } else {
      emptyText.textContent = '今夜无事。仪器仍在走时。';
      emptySub.textContent = '打开任意 DSH 会话，星就会亮起。';
    }
  }

  function hideNewMore(): void {
    newMore.hidden = true;
  }

  function scrollToLatest(): void {
    scrollToBottom(body);
    follow = true;
    hideNewMore();
  }

  function append(node: HTMLElement): void {
    if (empty.parentElement === body) body.insertBefore(node, empty);
    else body.appendChild(node);
  }

  function afterAppend(count: number): void {
    if (count > 0) {
      if (follow && !hoverPause) {
        requestAnimationFrame(() => {
          scrollToBottom(body);
        });
      } else {
        newMore.hidden = false;
      }
    }
    updateEmpty();
  }

  function pushDivider(at: number): void {
    volume += 1;
    spineBucket = -1;
    volText.textContent = `卷${volumeLabel(volume)}`;
    const label = `${dividerTime(at)} · 卷${volumeLabel(volume)}`;
    append(dividerNode(at, label));
  }

  function maybeDivider(at: number): void {
    if (lastDividerAt === 0) {
      lastDividerAt = at;
      spineBucket = -1;
      volText.textContent = `卷${volumeLabel(volume)}`;
      append(dividerNode(at, `${dividerTime(at)} · 卷${volumeLabel(volume)}`));
      return;
    }
    let guard = 0;
    while (at - lastDividerAt >= DIVIDER_INTERVAL && guard < 12) {
      lastDividerAt += DIVIDER_INTERVAL;
      pushDivider(lastDividerAt);
      guard += 1;
    }
  }

  function flushAnnounce(): void {
    announceTimer = 0;
    if (announceQueue.length === 0) return;
    const line = el('p', { class: 'led-live-line', text: announceQueue.join('；') });
    announceQueue.length = 0;
    live.appendChild(line);
    announceLines.push(line);
    if (announceLines.length > 3) {
      const old = announceLines.shift();
      old?.remove();
    }
  }

  function announce(row: LedgerRow): void {
    // 摘要格式：<时分> <星名> <动作>，节流 ≥2s，避免屏幕阅读器被高频事件淹没
    announceQueue.push(`${row.clock} ${row.summary}`);
    if (announceTimer) return;
    announceTimer = window.setTimeout(flushAnnounce, ANNOUNCE_GAP);
  }

  function prune(): void {
    while (rowCount > MAX_ROWS && entries.length > 0) {
      const first = entries.shift();
      if (!first) break;
      // 一并清掉这条旧行前面悬空的卷分隔，避免开头出现无主的「卷」
      let prev = first.node.previousElementSibling;
      while (prev && prev.classList.contains('led-div')) {
        const older = prev.previousElementSibling;
        prev.remove();
        prev = older;
      }
      first.node.remove();
      rowCount -= 1;
    }
    // 老行被裁掉后，新的第一行若只是墨点，要补回完整时辰（脊柱必须有起点）
    const head = entries[0];
    if (head && head.ditto) {
      head.ditto = false;
      const timeEl = head.node.querySelector<HTMLElement>('.led-time');
      if (timeEl) {
        timeEl.textContent = head.row.time;
        timeEl.classList.remove('is-ditto');
        timeEl.removeAttribute('aria-label');
      }
    }
    if (activeIndex >= entries.length) activeIndex = entries.length - 1;
  }

  /** 一步只落一笔：step/end 并进上一行 step/start，改成「第 N 步 · 毕 · 耗时」的涟漪行 */
  function mergeStepEnd(ev: AstroEvent, row: LedgerRow): boolean {
    if (ev.kind !== 'step/end') return false;
    const last = entries[entries.length - 1];
    if (!last || last.row.kind !== 'step/start' || last.row.sessionId !== ev.sessionId) return false;
    last.row.kind = 'step/end';
    last.row.text = row.text;
    last.row.meta = row.meta;
    last.row.summary = row.summary;
    last.row.isRipple = true;
    last.node.dataset.kind = 'step/end';
    last.node.classList.add('is-ripple');
    const textEl = last.node.querySelector('.led-text');
    if (textEl) textEl.textContent = row.text;
    const metaEl = last.node.querySelector('.led-meta');
    if (metaEl) metaEl.textContent = row.meta;
    last.node.setAttribute('aria-label', row.summary);
    return true;
  }

  function ingest(ev: AstroEvent): HTMLElement | null {
    if (!ev || !ev.id || typeof ev.at !== 'number' || Number.isNaN(ev.at)) return null;
    if (seen.has(ev.id)) return null;
    seen.add(ev.id);
    if (seen.size > 1500) seen.clear();

    const row = buildRow(ev, { ...ctx, now: Date.now() });
    if (!row) return null;

    if (mergeStepEnd(ev, row)) {
      announce(row);
      return null;
    }

    if (lostInk && (connection === 'live' || connection === 'connecting' || connection === 'reconnecting') && ev.kind !== 'session/live') {
      lostInk = false;
      offline.hidden = true;
      append(el('div', { class: 'led-resume' }, [el('span', { class: 'led-resume-mark', text: '续' })]));
    }

    maybeDivider(ev.at);
    const bucket = Math.floor(row.at / SHICHEN_KE_MS);
    const ditto = bucket === spineBucket;
    spineBucket = bucket;
    const node = rowNode(row, ditto);
    append(node);
    entries.push({ row, node, ditto });
    rowCount += 1;
    prune();

    if (row.isError) {
      // 错误行额外一次钤印强调（CSS 里是 3px 朱线与朱批）
      node.classList.add('is-fresh');
    }
    scheduleStamp(node);
    announce(row);
    if (row.isArchived) node.classList.add('is-archived');
    return node;
  }

  // ── 滚动 / 悬停 ─────────────────────────────────────────────
  function onScroll(): void {
    if (nearBottom(body)) {
      follow = true;
      hideNewMore();
    } else {
      follow = false;
      if (rowCount > 0) newMore.hidden = false;
    }
  }
  function onEnter(): void {
    hoverPause = true;
  }
  function onLeave(): void {
    hoverPause = false;
    if (follow && nearBottom(body)) scrollToBottom(body);
  }
  body.addEventListener('scroll', onScroll, { passive: true });
  body.addEventListener('mouseenter', onEnter);
  body.addEventListener('mouseleave', onLeave);

  newMore.addEventListener('click', () => {
    scrollToLatest();
    body.focus({ preventScroll: true });
  });

  // ── 移动端抽屉 ──────────────────────────────────────────────
  let touchStartY = 0;
  function setOpen(open: boolean): void {
    root.dataset.open = open ? 'true' : 'false';
    root.dataset.expanded = open ? 'true' : 'false';
    grip.setAttribute('aria-expanded', open ? 'true' : 'false');
    grip.setAttribute('aria-label', open ? '收起《起居注》' : '展开《起居注》');
    if (open) {
      requestAnimationFrame(() => {
        if (follow) scrollToBottom(body);
      });
    }
  }
  grip.addEventListener('click', () => setOpen(root.dataset.open !== 'true'));
  const onTouchStart = (ev: TouchEvent): void => {
    touchStartY = ev.touches[0]?.clientY ?? 0;
  };
  const onTouchEnd = (ev: TouchEvent): void => {
    const endY = ev.changedTouches[0]?.clientY ?? touchStartY;
    const dy = endY - touchStartY;
    if (dy < -36) setOpen(true);
    else if (dy > 36 && body.scrollTop <= 2) setOpen(false);
  };
  head.addEventListener('touchstart', onTouchStart, { passive: true });
  head.addEventListener('touchend', onTouchEnd, { passive: true });

  // ── 对外 ────────────────────────────────────────────────────
  function setFleet(snap: ClientFleetSnapshot): void {
    ctx.now = Date.now();
    ctx.source = snap.source as SourceKind;
    root.dataset.source = snap.source ?? 'none';
    const nextMulti = (snap.sources ?? []).filter((src) => src.state !== 'absent').length > 1;
    ctx.sessions.clear();
    for (const session of snap.sessions) ctx.sessions.set(session.id, session);
    ctx.domains.clear();
    snap.sectors.forEach((sector, index) => {
      const domain = SHIERCI[index % SHIERCI.length] ?? SHIERCI[0];
      for (const id of sector.sessionIds) ctx.domains.set(id, domain);
    });
    // 来源数变化时切换账本行首来源小签的显示模式
    if (nextMulti !== multiSource) {
      multiSource = nextMulti;
      root.dataset.multiSource = nextMulti ? 'true' : 'false';
    }
    // 历史行可能先于快照落墨（pushEvents 早于 setFleet）：每次快照后补齐/收起来源小签
    for (const entry of entries) {
      const tag = entry.node.querySelector<HTMLElement>('.led-src');
      if (!tag) continue;
      const rowSession = ctx.sessions.get(entry.row.sessionId);
      if (multiSource && rowSession) {
        tag.hidden = false;
        tag.textContent = sourceShort(rowSession.source);
        tag.dataset.source = rowSession.source;
      } else {
        tag.hidden = true;
      }
    }
    // 实时刷新归档降饱和与选中态
    const now = ctx.now;
    for (const entry of entries) {
      const session = ctx.sessions.get(entry.row.sessionId);
      const archived =
        session != null && session.state === 'ended' && now - session.lastActivityAt > 30 * 60 * 1000;
      if (archived !== entry.row.isArchived) {
        entry.row.isArchived = archived;
        entry.node.classList.toggle('is-archived', archived);
      }
    }
    // 首次拿到快照时把历史事件一并落墨（调用方也会 pushEvents，靠 id 去重）
    if (snap.events && snap.events.length > 0) pushEvents(snap.events);
    if (connection === 'connecting' || connection === 'live') updateEmpty();
  }

  function pushEvents(events: AstroEvent[]): void {
    if (!events || events.length === 0) return;
    const ordered = [...events].sort((a, b) => a.at - b.at);
    let added = 0;
    let batchIndex = 0;
    for (const ev of ordered) {
      const node = ingest(ev);
      if (!node) continue;
      // 同批落墨错开 55ms，像史官一行行写下去（上限 8 档，避免长队列延迟）
      node.style.animationDelay = `${Math.min(batchIndex, 8) * 55}ms`;
      batchIndex += 1;
      added += 1;
    }
    afterAppend(added);
  }

  function setConnection(state: ConnectionState): void {
    const prev = connection;
    connection = state;
    root.dataset.connection = state;
    const lost = state === 'offline' || state === 'reconnecting';
    offline.hidden = !lost;
    if (lost) {
      lostInk = true;
      offlineText.textContent =
        state === 'offline'
          ? '与采集器失联，正在重连……'
          : '与采集器失联，正在重连……';
      updateEmpty();
    } else if (prev === 'offline' || prev === 'reconnecting') {
      lostInk = true;
      updateEmpty();
    }
    if (state === 'live' || state === 'connecting') updateEmpty();
  }

  function setSelection(id: string | null): void {
    if (selectedId === id) return;
    selectedId = id;
    for (const entry of entries) {
      entry.node.classList.toggle('is-sel', entry.row.sessionId === id);
    }
  }

  function setReducedMotion(value: boolean): void {
    reduced = value;
    root.classList.toggle('is-reduced', value);
  }

  function focus(): void {
    body.focus({ preventScroll: true });
  }

  function moveActive(delta: number): boolean {
    if (entries.length === 0) return false;
    if (activeIndex < 0) activeIndex = entries.length - 1;
    activeIndex = Math.max(0, Math.min(entries.length - 1, activeIndex + delta));
    const entry = entries[activeIndex];
    if (!entry) return false;
    entry.node.focus({ preventScroll: false });
    entry.node.scrollIntoView({ block: 'nearest' });
    cb.onSelectSession(entry.row.sessionId);
    return true;
  }

  function handleKey(e: KeyboardEvent): boolean {
    if (e.metaKey || e.ctrlKey || e.altKey) return false;
    const active = document.activeElement as HTMLElement | null;
    const inside = active != null && root.contains(active);
    if (!inside) return false;
    switch (e.key) {
      case 'ArrowDown':
        return moveActive(1);
      case 'ArrowUp':
        return moveActive(-1);
      case 'Home':
        if (entries.length === 0) return false;
        activeIndex = -1;
        return moveActive(1);
      case 'End':
        if (entries.length === 0) return false;
        activeIndex = entries.length;
        return moveActive(-1);
      case 'PageDown':
        return moveActive(6);
      case 'PageUp':
        return moveActive(-6);
      default:
        return false;
    }
  }

  // 窗口改变（转屏/缩放）后若在追读，重新贴底
  let resizeRaf = 0;
  const onResize = (): void => {
    if (resizeRaf) return;
    resizeRaf = requestAnimationFrame(() => {
      resizeRaf = 0;
      if (follow) scrollToBottom(body);
    });
  };
  window.addEventListener('resize', onResize);

  updateEmpty();

  return {
    root,
    setFleet,
    pushEvents,
    setConnection,
    setSelection,
    setReducedMotion,
    focus,
    handleKey,
    rowCount: () => rowCount,
    dispose(): void {
      window.removeEventListener('resize', onResize);
      if (resizeRaf) cancelAnimationFrame(resizeRaf);
      for (const id of stampTimers) window.clearTimeout(id);
      stampTimers.clear();
      if (announceTimer) window.clearTimeout(announceTimer);
      announceTimer = 0;
      entries.length = 0;
      seen.clear();
      root.remove();
    },
  };
}
