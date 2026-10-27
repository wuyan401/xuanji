// XUANJI · 璇玑 — 调参台（右侧面板，25 项 · 6 组 · 5 预设 · 导入导出）
// 全部由 design/params.ts 的 PARAM_SPECS / PRESETS 生成，不手写任何参数。
// §17.6：保留右侧面板，不用径向盘；分组标题用胶囊（20px / 11px / +0.05em / 999px / gold @8%）。
import { el, setText } from '../lib/dom';
import {
  DEFAULT_PARAMS,
  PARAM_SPECS,
  PRESETS,
  clampParams,
  exportParams,
  importParams,
  type ParamSpec,
  type PresetName,
  type VisualParams,
} from '../design/params';
import { makeCloseButton, rafThrottle, trapTab } from './ui';

export interface ConsoleCallbacks {
  onParamsChange(params: VisualParams): void;
  onNotice(text: string): void;
}

export interface ConsoleHandle {
  root: HTMLElement;
  open(): void;
  close(): void;
  isOpen(): boolean;
  setParams(params: VisualParams, opts?: { silent?: boolean }): void;
  handleKey(e: KeyboardEvent): boolean;
  dispose(): void;
}

const PRESET_ORDER: PresetName[] = ['仪轨·夜航', '静观', '疾录', '勘验', '守夜'];

function decimalsFor(spec: ParamSpec): number {
  if (spec.step >= 1) return 0;
  if (spec.step >= 0.1) return 1;
  return 2;
}

function formatValue(value: number, spec: ParamSpec): string {
  // v2.1：自动运镜是开关语义，显示「开 / 关」而不是 0 / 1
  if (spec.key === 'autoDirector') return value >= 0.5 ? '开' : '关';
  return value.toFixed(decimalsFor(spec));
}

function presetParams(name: PresetName): VisualParams {
  return clampParams({ ...DEFAULT_PARAMS, ...PRESETS[name] });
}

export function createConsole(parent: HTMLElement, initial: VisualParams, cb: ConsoleCallbacks): ConsoleHandle {
  let current: VisualParams = { ...initial };
  let open = false;
  let lastFocused: HTMLElement | null = null;

  const backdrop = el('div', { class: 'cs-backdrop', attrs: { 'aria-hidden': 'true' } });
  backdrop.hidden = true;

  const root = el('section', {
    class: 'cs',
    attrs: {
      role: 'dialog',
      'aria-modal': 'true',
      'aria-label': '调参台 · 仪轨参数',
    },
  });
  root.dataset.open = 'false';
  root.hidden = true;

  const head = el('header', { class: 'cs-head' }, [
    el('div', { class: 'cs-head-text' }, [
      el('h2', { class: 'cs-title', text: '调参台' }),
      el('span', { class: 'cs-sub', text: '仪轨 · 廿五' }),
    ]),
    makeCloseButton('收起调参台', () => close()),
  ]);

  // 预设
  const presetsBox = el('div', {
    class: 'cs-presets',
    attrs: { role: 'group', 'aria-label': '仪轨预设' },
  });
  const presetButtons = new Map<PresetName, HTMLButtonElement>();
  for (const name of PRESET_ORDER) {
    const btn = el('button', {
      class: 'cs-preset',
      attrs: { type: 'button', 'aria-label': `应用预设 ${name}` },
    });
    btn.textContent = name;
    btn.addEventListener('click', () => {
      applyParams(presetParams(name), true);
      cb.onNotice(`已行仪轨「${name}」`);
    });
    presetsBox.appendChild(btn);
    presetButtons.set(name, btn);
  }

  // 滑杆
  const scroller = el('div', { class: 'cs-scroll' });
  const inputs = new Map<keyof VisualParams, HTMLInputElement>();
  const outputs = new Map<keyof VisualParams, HTMLElement>();

  const commit = rafThrottle((): void => {
    cb.onParamsChange(clampParams({ ...current }));
  });

  let lastGroup = '';
  for (const spec of PARAM_SPECS) {
    if (spec.group !== lastGroup) {
      lastGroup = spec.group;
      scroller.appendChild(
        el('div', { class: 'cs-group', attrs: { role: 'heading', 'aria-level': '3' } }, [
          el('span', { class: 'cs-group-title', text: spec.group }),
        ]),
      );
    }
    const input = el('input', {
      class: 'cs-range',
      attrs: {
        type: 'range',
        min: String(spec.min),
        max: String(spec.max),
        step: String(spec.step),
        value: String(current[spec.key]),
        'aria-label': `${spec.group} · ${spec.label}`,
        title: spec.hint ?? `${spec.label}（${spec.min}–${spec.max}）`,
      },
    });
    const output = el('output', {
      class: 'cs-value',
      attrs: { 'aria-hidden': 'true' },
    });
    output.textContent = formatValue(current[spec.key], spec);
    input.value = String(current[spec.key]);

    input.addEventListener('input', () => {
      const value = Number(input.value);
      if (Number.isFinite(value)) current[spec.key] = value;
      output.textContent = formatValue(current[spec.key], spec);
      markPresetActive(null);
      commit();
    });
    // 键盘微调后同步（range 的 change 在松手/按键结束时触发）
    input.addEventListener('change', () => {
      commit();
    });

    const row = el('div', { class: 'cs-row' }, [
      el('span', { class: 'cs-row-label', text: spec.label, attrs: { 'aria-hidden': 'true' } }),
      el('span', { class: 'cs-row-track' }, [input]),
      el('span', { class: 'cs-row-out' }, [output]),
    ]);
    // v2.1：有 hint 的参数（如自动运镜）在行下显示一行小注
    if (spec.hint) {
      scroller.appendChild(
        el('div', { class: 'cs-item' }, [
          row,
          el('span', { class: 'cs-row-note', text: spec.hint }),
        ]),
      );
    } else {
      scroller.appendChild(row);
    }
    inputs.set(spec.key, input);
    outputs.set(spec.key, output);
  }

  // 导入区
  const importBox = el('div', { class: 'cs-import' });
  importBox.hidden = true;
  const importArea = el('textarea', {
    class: 'cs-import-text',
    attrs: {
      rows: '4',
      spellcheck: 'false',
      placeholder: '在此粘贴导出的 JSON，或从文件读取……',
      'aria-label': '粘贴仪轨 JSON',
    },
  });
  const importError = el('p', { class: 'cs-import-error', attrs: { role: 'alert' } });
  importError.hidden = true;
  const fileInput = el('input', {
    class: 'sr-only',
    attrs: { type: 'file', accept: 'application/json,.json', 'aria-hidden': 'true', tabindex: '-1' },
  });
  const importActions = el('div', { class: 'cs-import-actions' }, [
    el('button', { class: 'cs-act', attrs: { type: 'button' }, text: '从文件…' }),
    el('button', { class: 'cs-act cs-act--go', attrs: { type: 'button' }, text: '导入' }),
    el('button', { class: 'cs-act cs-act--quiet', attrs: { type: 'button' }, text: '取消' }),
  ]);
  const [fileBtn, goBtn, cancelBtn] = Array.from(importActions.querySelectorAll('button'));
  importBox.append(importArea, importError, importActions, fileInput);

  function tryImport(text: string): void {
    const parsed = importParams(text);
    if (!parsed) {
      importError.hidden = false;
      importError.textContent = '这段 JSON 认不出是一副仪轨。';
      return;
    }
    importError.hidden = true;
    importBox.hidden = true;
    importArea.value = '';
    applyParams(parsed, true);
    cb.onNotice('仪轨已按 JSON 重排');
  }

  fileBtn?.addEventListener('click', () => fileInput.click());
  fileInput.addEventListener('change', () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      tryImport(String(reader.result ?? ''));
      fileInput.value = '';
    };
    reader.onerror = () => {
      importError.hidden = false;
      importError.textContent = '文件读取失败。';
    };
    reader.readAsText(file, 'utf-8');
  });
  goBtn?.addEventListener('click', () => tryImport(importArea.value));
  cancelBtn?.addEventListener('click', () => {
    importBox.hidden = true;
    importError.hidden = true;
  });

  // 底部动作
  const footHint = el('span', { class: 'cs-foot-hint', text: 'T 切换主题 · Esc 收起' });
  const foot = el('footer', { class: 'cs-foot' }, [
    el('div', { class: 'cs-foot-actions' }, [
      el('button', { class: 'cs-act', attrs: { type: 'button' }, text: '导出' }),
      el('button', { class: 'cs-act', attrs: { type: 'button' }, text: '导入' }),
      el('button', { class: 'cs-act cs-act--quiet', attrs: { type: 'button' }, text: '还原' }),
    ]),
    footHint,
  ]);
  const footButtons = Array.from(foot.querySelectorAll('button'));

  footButtons[0]?.addEventListener('click', () => {
    const json = exportParams(clampParams({ ...current }));
    const blob = new Blob([json], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = el('a', { attrs: { href: url, download: `xuanji-yigui-${Date.now()}.json` } });
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    cb.onNotice('仪轨已导出为 JSON');
  });
  footButtons[1]?.addEventListener('click', () => {
    importBox.hidden = !importBox.hidden;
    if (!importBox.hidden) {
      importArea.focus();
      importBox.scrollIntoView({ block: 'nearest' });
    }
  });
  footButtons[2]?.addEventListener('click', () => {
    applyParams({ ...DEFAULT_PARAMS }, true);
    cb.onNotice('仪轨已还原到「仪轨·夜航」');
  });

  root.append(head, presetsBox, scroller, importBox, foot);
  parent.appendChild(backdrop);
  parent.appendChild(root);

  // ── 状态同步 ────────────────────────────────────────────────
  function markPresetActive(name: PresetName | null): void {
    for (const [presetName, btn] of presetButtons) {
      btn.classList.toggle('is-active', presetName === name);
    }
  }

  function detectPreset(params: VisualParams): PresetName | null {
    for (const name of PRESET_ORDER) {
      const merged = presetParams(name);
      let same = true;
      for (const spec of PARAM_SPECS) {
        if (Math.abs((params[spec.key] ?? 0) - (merged[spec.key] ?? 0)) > 1e-9) {
          same = false;
          break;
        }
      }
      if (same) return name;
    }
    return null;
  }

  function syncInputs(): void {
    for (const spec of PARAM_SPECS) {
      const input = inputs.get(spec.key);
      const output = outputs.get(spec.key);
      const value = current[spec.key];
      if (input && document.activeElement !== input) input.value = String(value);
      if (output instanceof HTMLElement) setText(output, formatValue(value, spec));
    }
    markPresetActive(detectPreset(current));
  }

  function applyParams(next: VisualParams, commitChange: boolean): void {
    current = { ...next };
    syncInputs();
    if (commitChange) cb.onParamsChange(clampParams({ ...current }));
  }

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
      const first =
        root.querySelector<HTMLElement>('.cs-preset.is-active') ??
        root.querySelector<HTMLElement>('.cs-preset');
      first?.focus({ preventScroll: true });
    });
    syncInputs();
  }

  function close(): void {
    if (!open) return;
    open = false;
    root.dataset.open = 'false';
    root.classList.remove('is-in');
    backdrop.classList.remove('is-in');
    document.documentElement.classList.remove('xj-locked');
    const finish = (): void => {
      if (open) return;
      root.hidden = true;
      backdrop.hidden = true;
    };
    if (lastFocused && lastFocused.isConnected) lastFocused.focus({ preventScroll: true });
    lastFocused = null;
    window.setTimeout(finish, 220);
  }

  backdrop.addEventListener('click', () => close());

  // main 的按键分发在 INPUT/TEXTAREA 焦点时不进 hud.handleKey，浮层自备一份兜底
  root.addEventListener('keydown', (e) => {
    if (!open) return;
    if (e.key === 'Escape') {
      e.stopPropagation();
      close();
    } else if (e.key === 'Tab') {
      if (trapTab(e, root)) e.stopPropagation();
    }
  });

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
    setParams(params: VisualParams, _opts?: { silent?: boolean }): void {
      current = { ...params };
      syncInputs();
    },
    handleKey,
    dispose(): void {
      commit.cancel();
      document.documentElement.classList.remove('xj-locked');
      backdrop.remove();
      root.remove();
    },
  };
}
