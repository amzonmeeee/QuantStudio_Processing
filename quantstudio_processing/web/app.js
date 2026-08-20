/* QuantStudio_Processing GUI
 *
 * Behaviour follows interior.dev's three rules:
 *   1. nothing reflows on a state change — every label a control can reach has
 *      its width reserved before it gets there;
 *   2. transitions are interruptible — they run on transform/opacity so a
 *      change mid-flight interpolates from the current computed value;
 *   3. motion is never the only channel — with reduced motion on, the same
 *      status text, colour and count still arrive.
 */

import { localBackend } from './pyodide-client.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

const DYES = 8;
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const FORMATS = { 96: { rows: 8, cols: 12 }, 384: { rows: 16, cols: 24 } };
const COARSE_POINTER = matchMedia('(pointer: coarse)').matches;
const REDUCED_MOTION = matchMedia('(prefers-reduced-motion: reduce)');
const SYSTEM_THEME = matchMedia('(prefers-color-scheme: dark)');
const THEME_MODES = ['system', 'light', 'dark'];
const EDITION_TRANSITION_TIMEOUT = 850;

let currentTheme = THEME_MODES.includes(document.documentElement.dataset.themePreference)
  ? document.documentElement.dataset.themePreference
  : 'system';
let activeThemeTransition = null;
let fallbackThemeTimer = 0;

function effectiveTheme(theme) {
  return theme === 'system' ? (SYSTEM_THEME.matches ? 'dark' : 'light') : theme;
}

function updateThemeControl() {
  $$('[data-theme-choice]').forEach(button => {
    const active = button.dataset.themeChoice === currentTheme;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
}

function setThemeLoading(loading) {
  const control = $('.theme-control');
  if (loading) control?.setAttribute('aria-busy', 'true');
  else control?.removeAttribute('aria-busy');
}

function applyTheme(theme, persist = true) {
  currentTheme = THEME_MODES.includes(theme) ? theme : 'system';
  const root = document.documentElement;
  root.dataset.themePreference = currentTheme;
  if (currentTheme === 'system') delete root.dataset.theme;
  else root.dataset.theme = currentTheme;

  const themeColor = $('#theme-color');
  if (themeColor) {
    themeColor.content = effectiveTheme(currentTheme) === 'dark'
      ? (themeColor.dataset.dark || '#10171C')
      : (themeColor.dataset.light || '#E7ECEF');
  }

  if (persist) {
    try {
      if (currentTheme === 'system') localStorage.removeItem('theme');
      else localStorage.setItem('theme', currentTheme);
    } catch (_) {
      /* The selected theme still applies to this page view. */
    }
  }
  updateThemeControl();
}

function stopThemeTransition() {
  if (activeThemeTransition) {
    activeThemeTransition.skipTransition();
    activeThemeTransition = null;
  }
  if (fallbackThemeTimer) {
    clearTimeout(fallbackThemeTimer);
    fallbackThemeTimer = 0;
  }
  document.documentElement.classList.remove(
    'theme-transitioning', 'theme-fallback-transitioning',
  );
  setThemeLoading(false);
}

function transitionTheme(theme, persist = true) {
  const nextTheme = THEME_MODES.includes(theme) ? theme : 'system';
  if (nextTheme === currentTheme) return;

  const changesAppearance = effectiveTheme(nextTheme) !== effectiveTheme(currentTheme);
  if (!changesAppearance || REDUCED_MOTION.matches) {
    stopThemeTransition();
    applyTheme(nextTheme, persist);
    return;
  }

  stopThemeTransition();
  const root = document.documentElement;
  if (typeof document.startViewTransition !== 'function') {
    root.classList.add('theme-fallback-transitioning');
    setThemeLoading(true);
    void root.offsetWidth;
    applyTheme(nextTheme, persist);
    fallbackThemeTimer = setTimeout(() => {
      fallbackThemeTimer = 0;
      root.classList.remove('theme-fallback-transitioning');
      setThemeLoading(false);
    }, EDITION_TRANSITION_TIMEOUT);
    return;
  }

  root.classList.add('theme-transitioning');
  setThemeLoading(true);
  let transition;
  try {
    transition = document.startViewTransition(() => applyTheme(nextTheme, persist));
  } catch (_) {
    root.classList.remove('theme-transitioning');
    setThemeLoading(false);
    applyTheme(nextTheme, persist);
    return;
  }
  activeThemeTransition = transition;
  transition.ready?.catch?.(() => {});
  const cleanUp = () => {
    if (activeThemeTransition !== transition) return;
    activeThemeTransition = null;
    root.classList.remove('theme-transitioning');
    setThemeLoading(false);
  };
  transition.finished.then(cleanUp, cleanUp);
}

$$('[data-theme-choice]').forEach(button => {
  button.addEventListener('click', () => transitionTheme(button.dataset.themeChoice));
});

function handleSystemThemeChange() {
  if (currentTheme === 'system') applyTheme('system', false);
}

if (SYSTEM_THEME.addEventListener) SYSTEM_THEME.addEventListener('change', handleSystemThemeChange);
else SYSTEM_THEME.addListener(handleSystemThemeChange);
updateThemeControl();

const state = {
  loaded: false, loading: false, runtimeReady: false, sourceFile: null,
  filename: null, format: 96,
  ct: new Map(),                 // well position -> Ct (or null)
  present: new Set(),            // wells that exist in the export
  fields: new Map(),             // field -> Map(well -> value)
  values: new Map(),             // field -> [value, ...] in creation order
  activeField: null,
  activeValue: null,
  touchPaint: false,
  flags: new Map(),              // well -> qc flag text
  undo: [],
  results: null,
  activeResultTab: null,
  plotUrls: [],
  plotBlobs: new Map(),
};

let fieldEditor = null;
let valueEditor = null;
let resultTableObserver = null;
let scrollLensFrame = 0;
let analysisRevision = 0;
const scrollLensSyncers = [];
const scrollLensObservers = [];

function animatePanel(node, { x = 0, y = 5 } = {}) {
  if (REDUCED_MOTION.matches || !node?.animate) return;
  node.getAnimations().forEach(animation => animation.cancel());
  node.animate(
    [
      { opacity: .35, transform: `translate(${x}px, ${y}px)` },
      { opacity: 1, transform: 'translate(0, 0)' },
    ],
    { duration: 230, easing: 'cubic-bezier(.22, 1, .36, 1)' },
  );
}

/* ------------------------------------------------------------ press depth */
/* The press is released on cancel and on losing the pointer, not only on a
   clean click, so a drag off the button never leaves it stuck down. */
document.addEventListener('pointerdown', e => {
  const b = e.target.closest('.btn, .tab, .value');
  if (b && !b.disabled) b.dataset.pressed = '';
});
for (const ev of ['pointerup', 'pointercancel', 'pointerleave', 'blur'])
  document.addEventListener(ev, () => {
    $$('[data-pressed]').forEach(b => delete b.dataset.pressed);
  }, true);

/* ------------------------------------------------------- reserved widths */
/* Measure every label the button can reach and pin the widest, so the toolbar
   beside it does not shift when "Run analysis" becomes "Running". */
function reserveWidth(btn) {
  const label = $('.btn-label', btn);
  if (!label) return;
  const ghost = document.createElement('span');
  ghost.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap';
  ghost.style.font = getComputedStyle(label).font;
  document.body.append(ghost);
  let w = 0;
  for (const s of btn.dataset.states.split('|')) {
    ghost.textContent = s;
    w = Math.max(w, ghost.offsetWidth);
  }
  ghost.remove();
  const pad = parseFloat(getComputedStyle(btn).paddingLeft) * 2;
  btn.style.setProperty('--reserved', `${Math.ceil(w + pad + 20)}px`);
}

/* -------------------------------------------------------- async envelope */
/* The spinner does not appear for work that finishes quickly, and once it has
   appeared it stays long enough to be read instead of flashing. */
const SPIN_DELAY = 180, SPIN_MIN = 420;

async function withPending(
  btn, labelEl, spinEl, busyText, doneText, fn, canEnable = () => true,
) {
  const idle = labelEl.textContent;
  let shown = 0;
  const timer = setTimeout(() => {
    shown = performance.now();
    labelEl.textContent = busyText;
    spinEl.hidden = false;
  }, SPIN_DELAY);
  btn.disabled = true;
  try {
    return await fn();
  } finally {
    clearTimeout(timer);
    const held = shown ? performance.now() - shown : SPIN_MIN;
    setTimeout(() => {
      spinEl.hidden = true;
      labelEl.textContent = typeof doneText === 'function'
        ? doneText()
        : (doneText ?? idle);
      btn.disabled = !canEnable();
    }, Math.max(0, SPIN_MIN - held));
  }
}

/* ---------------------------------------------------------------- toaster */
function toast(message, { tone = 'info', action, onAction, timeout = 5200 } = {}) {
  const el = document.createElement('div');
  el.className = 'toast';
  el.dataset.tone = tone;
  el.append(Object.assign(document.createElement('span'), { textContent: message }));
  if (action) {
    const b = Object.assign(document.createElement('button'), { textContent: action });
    b.onclick = () => { onAction?.(); dismiss(); };
    el.append(b);
  }
  const stack = $('#toaster');
  // the stack is bounded: a burst of edits should not bury the interface
  while (stack.children.length >= 3) {
    const removable = [...stack.children]
      .find(item => !item.contains(document.activeElement));
    if (!removable) break;
    removable.remove();
  }
  stack.append(el);
  requestAnimationFrame(() => el.dataset.open = '');
  let timer = 0;
  let dismissed = false;
  const pause = () => clearTimeout(timer);
  const schedule = () => {
    clearTimeout(timer);
    if (dismissed || el.matches(':hover') || el.contains(document.activeElement)) return;
    timer = setTimeout(dismiss, timeout);
  };
  el.addEventListener('pointerenter', pause);
  el.addEventListener('pointerleave', schedule);
  el.addEventListener('focusin', pause);
  el.addEventListener('focusout', () => setTimeout(schedule));
  schedule();
  function dismiss() {
    if (dismissed) return;
    dismissed = true;
    clearTimeout(timer);
    delete el.dataset.open;
    setTimeout(() => el.remove(), 200);
  }
  return dismiss;
}

/* --------------------------------------------------------- local runtime */
function messageFor(error, fallback = 'The local analysis failed.') {
  return error?.message || fallback;
}

function releasePlotUrls() {
  for (const url of state.plotUrls) URL.revokeObjectURL(url);
  state.plotUrls = [];
  state.plotBlobs = new Map();
}

function clearResults(message = 'Results appear here once you run the analysis.') {
  resultTableObserver?.disconnect();
  resultTableObserver = null;
  releasePlotUrls();
  state.results = null;
  state.activeResultTab = null;
  state.flags = new Map();
  $('#resultTabs').replaceChildren();
  const body = $('#resultBody');
  delete body.dataset.kind;
  body.removeAttribute('aria-labelledby');
  body.setAttribute('aria-label', 'Analysis results');
  body.setAttribute('aria-busy', 'false');
  body.replaceChildren(el('p', { class: 'empty', textContent: message }));
  $('#btnDownload').disabled = true;
}

function invalidateAnalysis() {
  analysisRevision += 1;
  if (!state.results) return;
  clearResults('The plate or analysis settings changed. Run again to refresh these results.');
  paintAll();
  $('#runLabel').textContent = 'Run analysis';
}

function clearLoadedUi() {
  analysisRevision += 1;
  state.loaded = false;
  state.sourceFile = null;
  state.filename = null;
  state.ct = new Map();
  state.present = new Set();
  state.fromFile = {};
  state.fields = new Map();
  state.values = new Map();
  state.flags = new Map();
  state.undo = [];
  state.activeField = null;
  state.activeValue = null;
  fieldEditor = null;
  valueEditor = null;
  $('#fileChip').hidden = true;
  $('#drop').hidden = false;
  $('#plateWrap').hidden = true;
  $('#btnRun').disabled = true;
  $('#btnYaml').disabled = true;
  $('#btnPlateRetry').hidden = true;
  clearResults();
}

function runtimeStatusLabel(status) {
  if (status.state === 'error') return 'Analyzer unavailable';
  if (status.state === 'ready') return 'Ready';
  return {
    runtime: 'Starting analyzer…',
    packages: 'Loading components…',
    application: 'Starting analyzer…',
    workbook: 'Opening workbook…',
    analysis: 'Running analysis…',
    export: 'Preparing export…',
  }[status.phase] || 'Working…';
}

function updateRuntimeStatus(status) {
  const runtime = $('#runtimeState');
  const runtimeState = status.state || 'loading';
  state.runtimeReady = runtimeState === 'ready';
  runtime.dataset.state = runtimeState;
  $('#runtimeText').textContent = runtimeStatusLabel(status);
  const canRetry = runtimeState === 'error' && status.recoverable !== false;
  $('#btnRuntimeRetry').hidden = !canRetry;
  $('#btnPlateRetry').hidden = !canRetry || !state.loaded;
  $$('.plots-download-all, .plots-download-all-svg, .plot-download-svg').forEach(button => {
    button.disabled = runtimeState !== 'ready';
  });

  if (runtimeState === 'error') {
    $('#btnRun').disabled = true;
    $('#btnYaml').disabled = true;
    $('#btnDownload').disabled = true;
    if (state.loaded) setStatus('The local analyzer stopped. Retry to reload this workbook.');
  } else if (runtimeState === 'loading' && state.loaded) {
    setStatus(status.message);
  } else if (runtimeState === 'ready' && state.results) {
    setStatus(
      `${state.results.n_wells} wells analysed. `
      + `${state.results.n_flagged} carry a QC flag.`,
    );
  }
}

localBackend.onStatus(updateRuntimeStatus);

async function prepareRuntime({ restart = false } = {}) {
  const retryFile = restart ? state.sourceFile : null;
  $('#btnRuntimeRetry').hidden = true;
  try {
    if (restart) await localBackend.restart();
    else await localBackend.prepare();
    if (retryFile) await loadFile(retryFile);
  } catch (error) {
    toast(messageFor(error, 'Could not start the local analyzer.'), {
      tone: 'error', timeout: 8000,
    });
  }
}

$('#btnRuntimeRetry').onclick = () => { void prepareRuntime({ restart: true }); };
$('#btnPlateRetry').onclick = () => { void prepareRuntime({ restart: true }); };
$('#btnFilePicker').onclick = () => $('#fileInput').click();

let replaceCloseTimer = null;

function closeReplaceConfirm({ restoreFocus = false } = {}) {
  const confirm = $('#replaceConfirm');
  if (confirm.hidden) return;
  delete confirm.dataset.open;
  clearTimeout(replaceCloseTimer);
  replaceCloseTimer = setTimeout(() => {
    replaceCloseTimer = null;
    confirm.hidden = true;
    if (restoreFocus) $('#btnSelectAnother').focus();
  }, REDUCED_MOTION.matches ? 0 : 180);
}

$('#btnSelectAnother').onclick = () => {
  const confirm = $('#replaceConfirm');
  clearTimeout(replaceCloseTimer);
  replaceCloseTimer = null;
  confirm.hidden = false;
  requestAnimationFrame(() => {
    confirm.dataset.open = '';
    $('#btnReplaceCancel').focus({ preventScroll: true });
  });
};
$('#btnReplaceCancel').onclick = () => closeReplaceConfirm({ restoreFocus: true });
$('#btnReplaceConfirm').onclick = () => {
  closeReplaceConfirm();
  $('#fileInput').click();
};

let pendingNavigation = null;
let leaveReturnFocus = null;
let leaveCloseTimer = null;
let allowUnload = false;

function openLeaveGuard(link) {
  clearTimeout(leaveCloseTimer);
  pendingNavigation = { href: link.href, target: link.target };
  leaveReturnFocus = link;
  const guard = $('#leaveGuard');
  guard.hidden = false;
  requestAnimationFrame(() => {
    guard.dataset.open = '';
    $('#btnStayHere').focus({ preventScroll: true });
  });
}

function closeLeaveGuard({ restoreFocus = false } = {}) {
  const guard = $('#leaveGuard');
  if (guard.hidden) return;
  delete guard.dataset.open;
  leaveCloseTimer = setTimeout(() => {
    guard.hidden = true;
    if (restoreFocus && leaveReturnFocus?.isConnected) leaveReturnFocus.focus();
    leaveReturnFocus = null;
    pendingNavigation = null;
  }, REDUCED_MOTION.matches ? 0 : 180);
}

$('#btnStayHere').onclick = () => closeLeaveGuard({ restoreFocus: true });
$('#btnLeavePage').onclick = () => {
  if (!pendingNavigation) return;
  const destination = pendingNavigation;
  if (destination.target === '_blank') {
    window.open(destination.href, '_blank', 'noopener');
    closeLeaveGuard({ restoreFocus: true });
    return;
  }
  allowUnload = true;
  window.location.assign(destination.href);
};

$('#leaveGuard').addEventListener('pointerdown', event => {
  if (event.target === event.currentTarget) closeLeaveGuard({ restoreFocus: true });
});
$('#leaveGuard').addEventListener('keydown', event => {
  if (event.key === 'Escape') {
    event.preventDefault();
    closeLeaveGuard({ restoreFocus: true });
    return;
  }
  if (event.key !== 'Tab') return;
  const controls = $$('button:not(:disabled)', event.currentTarget);
  const first = controls[0], last = controls.at(-1);
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault(); last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault(); first.focus();
  }
});

document.addEventListener('click', event => {
  const link = event.target.closest('a[href]');
  if (!link || !state.loaded || link.hasAttribute('download')) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const destination = new URL(link.href, window.location.href);
  const current = new URL(window.location.href);
  const sameDocument = destination.origin === current.origin
    && destination.pathname === current.pathname
    && destination.search === current.search;
  if (sameDocument) return;
  event.preventDefault();
  openLeaveGuard(link);
});

/* ------------------------------------------------------------------ load */
async function loadFile(file) {
  if (state.loading) return;
  if (!/\.xlsx$/i.test(file.name)) {
    toast('Choose a .xlsx QuantStudio export. Legacy .xls files are not supported.', {
      tone: 'error',
    });
    return;
  }
  if (!file.size) {
    toast('That workbook is empty.', { tone: 'error' });
    return;
  }
  if (file.size > MAX_FILE_BYTES) {
    toast('That workbook is larger than the 50 MiB browser limit.', {
      tone: 'error', timeout: 7000,
    });
    return;
  }

  state.loading = true;
  closeReplaceConfirm();
  closePop();
  fieldEditor = null;
  valueEditor = null;
  clearLoadedUi();
  $('#drop').dataset.busy = '';
  $('#fileInput').disabled = true;
  $('#runtimeText').textContent = 'Opening workbook…';

  try {
    const d = await localBackend.load(file);
    if (!FORMATS[d.plate_format]) {
      throw new Error(
        `This interface supports 96- and 384-well plates, not ${d.plate_format || 'this'}-well plates.`,
      );
    }

    state.loaded = true;
    state.sourceFile = file;
    state.filename = d.filename;
    state.format = d.plate_format;
    state.ct = new Map(d.wells.map(w => [w.pos, w.ct]));
    state.present = new Set(d.wells.map(w => w.pos));
    state.fromFile = d.from_file;
    state.fields = new Map();
    state.values = new Map();
    state.flags = new Map();
    state.undo = [];

    fillFromFile({ quiet: true });

    $('#chipName').textContent = d.filename;
    $('#chipMeta').textContent =
      `${d.n_wells} wells · ${d.plate_format}-well · ${d.instrument || 'unknown instrument'}`;
    $('#fileChip').hidden = false;
    $('#drop').hidden = true;
    $('#plateWrap').hidden = false;
    $('#btnRun').disabled = false;
    $('#btnYaml').disabled = false;

    renderAll();
    setStatus(`${d.filename} loaded. ${d.n_wells} wells have data.`);
  } catch (error) {
    clearLoadedUi();
    toast(messageFor(error, 'Could not read that workbook.'), {
      tone: 'error', timeout: 8000,
    });
  } finally {
    state.loading = false;
    delete $('#drop').dataset.busy;
    $('#fileInput').disabled = false;
  }
}

function fillFromFile({ quiet = false } = {}) {
  const src = state.fromFile || {};
  const before = snapshotAll();
  fieldEditor = null;
  valueEditor = null;
  state.fields = new Map();
  state.values = new Map();
  for (const [field, mapping] of Object.entries(src)) {
    const m = new Map();
    for (const [well, v] of Object.entries(mapping)) if (v) m.set(well, v);
    if (!m.size) continue;
    state.fields.set(field, m);
    state.values.set(field, [...new Set(m.values())]);
  }
  if (!state.fields.size) {
    state.fields.set('assay', new Map());
    state.values.set('assay', []);
  }
  state.activeField = [...state.fields.keys()][0];
  state.activeValue = (state.values.get(state.activeField) || [])[0] ?? null;
  if (!quiet) {
    invalidateAnalysis();
    pushUndo(before, 'Filled the plate from the file');
    renderAll();
  }
}

/* ------------------------------------------------------------ undo stack */
function snapshotAll() {
  return {
    fields: new Map([...state.fields].map(([f, m]) => [f, new Map(m)])),
    values: new Map([...state.values].map(([f, v]) => [f, [...v]])),
    activeField: state.activeField, activeValue: state.activeValue,
  };
}

function pushUndo(snapshot, label) {
  state.undo.push(snapshot);
  if (state.undo.length > 60) state.undo.shift();
  if (label) toast(label, { action: 'Undo', onAction: undo });
}

function undo() {
  const s = state.undo.pop();
  if (!s) { toast('Nothing to undo'); return; }
  invalidateAnalysis();
  Object.assign(state, s);
  renderAll();
  setStatus('Reverted the last change.');
}

document.addEventListener('keydown', e => {
  const editingText = e.target instanceof Element
    && Boolean(e.target.closest('input, textarea, select, [contenteditable="true"]'));
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey && !editingText) {
    e.preventDefault(); undo();
  }
  if (e.key === 'Escape') {
    closePop({ restoreFocus: true });
    closeReplaceConfirm({ restoreFocus: true });
  }
});

/* ----------------------------------------------------------- plate paint */
let stroke = null;

function renderPlate() {
  const { rows, cols } = FORMATS[state.format];
  const plate = $('#plate');
  plate.dataset.format = state.format;
  $('.seg').dataset.active = state.format;
  // wells are capped rather than stretched: a 96-well plate on a wide screen
  // should still look like a plate, not fill the window
  const cap = COARSE_POINTER ? 44 : state.format === 384 ? 26 : 44;
  const header = COARSE_POINTER ? 44 : 18;
  plate.style.gridTemplateColumns = `${header}px repeat(${cols}, ${cap}px)`;
  plate.replaceChildren();

  plate.append(el('div'));
  for (let c = 1; c <= cols; c++) {
    const header = el('button', { class: 'hdr', textContent: c, dataset: { col: c } });
    header.type = 'button';
    header.tabIndex = c === 1 ? 0 : -1;
    header.setAttribute('aria-label', `Paint column ${c}. Right-click or Shift+Enter to edit all properties.`);
    plate.append(header);
  }

  for (let r = 0; r < rows; r++) {
    const letter = String.fromCharCode(65 + r);
    const header = el('button', { class: 'hdr', textContent: letter, dataset: { row: letter } });
    header.type = 'button';
    header.tabIndex = r === 0 ? 0 : -1;
    header.setAttribute('aria-label', `Paint row ${letter}. Right-click or Shift+Enter to edit all properties.`);
    plate.append(header);
    for (let c = 1; c <= cols; c++) {
      const pos = letter + c;
      const w = el('button', { class: 'well', dataset: { pos } });
      w.type = 'button';
      w.tabIndex = -1;
      plate.append(w);
    }
  }
  syncTouchMode();
  paintAll();
}

function syncTouchMode() {
  const button = $('#btnTouchMode');
  button.setAttribute('aria-pressed', String(state.touchPaint));
  button.textContent = state.touchPaint ? 'Drag to paint' : 'Drag to pan';
  $('#plate').dataset.touchMode = state.touchPaint ? 'paint' : 'pan';
}

$('#btnTouchMode').onclick = () => {
  state.touchPaint = !state.touchPaint;
  syncTouchMode();
  setStatus(state.touchPaint
    ? 'Touch paint is on. Drag across wells to assign the selected value.'
    : 'Touch pan is on. Drag to move around the plate; tap a well to assign it.');
};

function colourOf(field, value) {
  const list = state.values.get(field) || [];
  const i = list.indexOf(value);
  return i < 0 ? null : `var(--dye-${(i % DYES) + 1})`;
}

function paintAll() {
  const field = state.activeField;
  const map = state.fields.get(field) || new Map();
  const wells = $$('.well', $('#plate'));
  let roving = wells.find(w => w.tabIndex === 0 && state.present.has(w.dataset.pos));
  roving ||= wells.find(w => state.present.has(w.dataset.pos));
  for (const w of wells) {
    const pos = w.dataset.pos;
    const has = state.present.has(pos);
    toggleAttr(w, 'data-empty', !has);
    w.disabled = !has;
    w.tabIndex = has && w === roving ? 0 : -1;
    const v = map.get(pos);
    toggleAttr(w, 'data-assigned', !!v);
    w.style.background = v ? colourOf(field, v) : '';
    const ct = state.ct.get(pos);
    w.textContent = has ? (ct == null ? '—' : ct.toFixed(1)) : '';
    const flag = state.flags.get(pos);
    toggleAttr(w, 'data-flag', !!flag);
    const label = has
      ? `${pos}${v ? ` · ${field}: ${v}` : ''}${ct == null ? ' · Undetermined' : ` · Ct ${ct}`}` +
        (flag ? ` · ${flag}` : '')
      : `${pos} · no data in this export`;
    w.title = label;
    w.setAttribute('aria-label', `${label}. Right-click or Shift+Enter edits every property.`);
  }
  renderValues();
}

function assign(pos, value) {
  if (!state.present.has(pos)) return false;
  const map = state.fields.get(state.activeField);
  if (value == null) map.delete(pos); else map.set(pos, value);
  return true;
}

function targetsForHeader(header) {
  return header.dataset.col
    ? [...Array(FORMATS[state.format].rows)].map((_, i) =>
        String.fromCharCode(65 + i) + header.dataset.col)
    : [...Array(FORMATS[state.format].cols)].map((_, i) =>
        header.dataset.row + (i + 1));
}

function assignTargets(targets, label) {
  if (!state.activeValue) {
    setStatus('Pick a value in the Values list first, or add one.');
    return;
  }
  const before = snapshotAll();
  let touched = 0;
  let skipped = 0;
  for (const pos of targets) {
    if (assign(pos, state.activeValue)) touched++; else skipped++;
  }
  if (touched) {
    invalidateAnalysis();
    pushUndo(before, `Assigned ${label}`);
    paintAll();
    syncSelects();
  }
  setStatus(skipped
    ? `${touched} well${touched === 1 ? '' : 's'} set. ${skipped} skipped — no data in this export.`
    : `${touched} well${touched === 1 ? '' : 's'} set to ${state.activeValue}.`);
}

$('#plate').addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  const hdr = e.target.closest('.hdr');
  const well = e.target.closest('.well');
  if (!hdr && !well) return;
  if (e.pointerType === 'touch' && !state.touchPaint) return;
  if (!state.activeValue && !e.altKey) {
    setStatus('Pick a value in the Values list first, or add one.');
    return;
  }
  e.preventDefault();
  stroke = { erase: e.altKey, before: snapshotAll(), touched: 0, skipped: 0 };

  if (hdr) {
    targetsForHeader(hdr).forEach(p => applyStroke(p));
    endStroke();
    return;
  }
  $('#plate').setPointerCapture(e.pointerId);
  applyStroke(well.dataset.pos);
});

$('#plate').addEventListener('pointermove', e => {
  if (!stroke) return;
  const t = document.elementFromPoint(e.clientX, e.clientY);
  const well = t?.closest?.('.well');
  if (well) applyStroke(well.dataset.pos);
});

$('#plate').addEventListener('pointerup', endStroke);
$('#plate').addEventListener('pointercancel', endStroke);

function applyStroke(pos) {
  if (!stroke) return;
  const ok = assign(pos, stroke.erase ? null : state.activeValue);
  if (ok) stroke.touched++; else stroke.skipped++;
  const w = $(`.well[data-pos="${pos}"]`);
  if (w) {
    const v = state.fields.get(state.activeField).get(pos);
    toggleAttr(w, 'data-assigned', !!v);
    w.style.background = v ? colourOf(state.activeField, v) : '';
  }
}

function endStroke() {
  if (!stroke) return;
  const { touched, skipped, before, erase } = stroke;
  stroke = null;
  if (!touched && !skipped) return;
  if (touched) {
    invalidateAnalysis();
    pushUndo(before, `${erase ? 'Cleared' : 'Assigned'} ${touched} well${touched > 1 ? 's' : ''}`);
    renderValues();
    syncSelects();
  }
  setStatus(skipped
    ? `${touched} well${touched === 1 ? '' : 's'} set. ${skipped} skipped — no data in this export.`
    : `${touched} well${touched === 1 ? '' : 's'} set.`);
}

/* Scope editor: a secondary click edits every user-defined property without
   making instrument Ct values mutable. */
$('#plate').addEventListener('click', e => {
  const hdr = e.target.closest('.hdr');
  const w = e.target.closest('.well');
  if (!hdr && !w) return;
  if (e.altKey) {
    openPop(w || hdr);
    return;
  }
  // Pointer painting is handled above. A keyboard-generated button click has
  // detail 0. In touch-pan mode, a tap assigns while a drag scrolls.
  const shouldAssign = e.detail === 0
    || (e.pointerType === 'touch' && !state.touchPaint);
  if (!shouldAssign) return;
  if (hdr) {
    const label = hdr.dataset.col ? `column ${hdr.dataset.col}` : `row ${hdr.dataset.row}`;
    assignTargets(targetsForHeader(hdr), label);
    return;
  }
  assignTargets([w.dataset.pos], w.dataset.pos);
});
$('#plate').addEventListener('keydown', e => {
  const target = e.target.closest('.well, .hdr');
  if (!target) return;
  if (e.key === 'Enter' && e.shiftKey) {
    e.preventDefault();
    openPop(target);
    return;
  }
  if (target.classList.contains('hdr')) {
    const headers = target.dataset.col
      ? $$('.hdr[data-col]', $('#plate'))
      : $$('.hdr[data-row]', $('#plate'));
    const step = target.dataset.col
      ? { ArrowLeft: -1, ArrowRight: 1 }[e.key]
      : { ArrowUp: -1, ArrowDown: 1 }[e.key];
    if (!step) return;
    e.preventDefault();
    const next = headers[headers.indexOf(target) + step];
    if (!next) return;
    target.tabIndex = -1;
    next.tabIndex = 0;
    next.focus({ preventScroll: true });
    next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    return;
  }
  if (!target.classList.contains('well') || !e.key.startsWith('Arrow')) return;
  const { rows, cols } = FORMATS[state.format];
  const match = target.dataset.pos.match(/^([A-Z])(\d+)$/);
  if (!match) return;
  const delta = {
    ArrowLeft: [0, -1], ArrowRight: [0, 1], ArrowUp: [-1, 0], ArrowDown: [1, 0],
  }[e.key];
  if (!delta) return;
  e.preventDefault();
  let row = match[1].charCodeAt(0) - 65;
  let col = Number(match[2]) - 1;
  do {
    row += delta[0];
    col += delta[1];
    if (row < 0 || row >= rows || col < 0 || col >= cols) return;
  } while (!state.present.has(`${String.fromCharCode(65 + row)}${col + 1}`));
  const next = $(`.well[data-pos="${String.fromCharCode(65 + row)}${col + 1}"]`);
  if (!next) return;
  target.tabIndex = -1;
  next.tabIndex = 0;
  next.focus({ preventScroll: true });
  next.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
$('#plate').addEventListener('focusin', e => {
  const header = e.target.closest('.hdr');
  if (header) {
    const selector = header.dataset.col ? '.hdr[data-col][tabindex="0"]' : '.hdr[data-row][tabindex="0"]';
    $$(selector, $('#plate')).forEach(item => { if (item !== header) item.tabIndex = -1; });
    header.tabIndex = 0;
    return;
  }
  const well = e.target.closest('.well:not(:disabled)');
  if (!well) return;
  $$('.well[tabindex="0"]', $('#plate')).forEach(item => { if (item !== well) item.tabIndex = -1; });
  well.tabIndex = 0;
});
$('#plate').addEventListener('contextmenu', e => {
  const target = e.target.closest('.well, .hdr');
  if (!target) return;
  e.preventDefault();
  openPop(target);
});

let popReturnFocus = null;
let popCloseTimer = null;

function openPop(targetEl) {
  clearTimeout(popCloseTimer);
  const isWell = targetEl.classList.contains('well');
  const targets = (isWell ? [targetEl.dataset.pos] : targetsForHeader(targetEl))
    .filter(pos => state.present.has(pos));
  const scope = isWell
    ? targetEl.dataset.pos
    : targetEl.dataset.col ? `Column ${targetEl.dataset.col}` : `Row ${targetEl.dataset.row}`;
  const pop = $('#pop');
  const r = targetEl.getBoundingClientRect();

  popReturnFocus = targetEl;
  pop.replaceChildren();
  const heading = el('p', { class: 'pop-head', textContent: `Edit ${scope}` });
  const close = el('button', { class: 'pop-close', textContent: 'Close' });
  close.type = 'button';
  close.setAttribute('aria-label', `Close properties for ${scope.toLowerCase()}`);
  close.onclick = () => closePop({ restoreFocus: true });
  const head = el('div', { class: 'pop-head-row' });
  head.append(heading, close);
  pop.append(
    head,
    el('p', {
      class: 'pop-scope',
      textContent: isWell
        ? 'Set every plate-map field for this well.'
        : `Changes apply to ${targets.length} wells with instrument data.`,
    }),
  );

  if (isWell) {
    const pos = targets[0];
    const ct = state.ct.get(targetEl.dataset.pos);
    const meta = el('dl', { class: 'pop-meta' });
    meta.append(
      el('dt', { textContent: 'Ct · read only' }),
      el('dd', {
        textContent: !pos ? 'no data' : ct == null ? 'Undetermined' : ct.toFixed(2),
      }),
    );
    pop.append(meta);
    const flag = state.flags.get(targetEl.dataset.pos);
    if (flag) pop.append(el('p', { class: 'pop-flag', textContent: flag }));
  }

  const form = el('form', { class: 'pop-form' });
  for (const [field, mapping] of state.fields) {
    const values = targets.map(pos => mapping.get(pos) ?? '');
    const unique = new Set(values);
    const select = el('select', { dataset: { field } });
    if (unique.size > 1) {
      const mixed = new Option('Mixed — leave unchanged', '__mixed__');
      mixed.disabled = true;
      mixed.selected = true;
      select.append(mixed);
    }
    select.append(new Option('Unassigned', '__none__'));
    for (const value of state.values.get(field) || []) select.append(new Option(value, value));
    if (unique.size === 1) select.value = values[0] || '__none__';
    const label = el('label', { class: 'pop-field' });
    label.append(el('span', { textContent: field }), select);
    form.append(label);
  }
  if (!state.fields.size) {
    form.append(el('p', { class: 'pop-empty', textContent: 'Add a field before editing plate properties.' }));
  }
  const actions = el('div', { class: 'pop-actions' });
  const clear = el('button', { class: 'btn btn-mini btn-quiet', textContent: 'Clear assignments' });
  clear.type = 'button';
  clear.disabled = !targets.length || !state.fields.size;
  clear.onclick = () => {
    const before = snapshotAll();
    for (const mapping of state.fields.values()) targets.forEach(pos => mapping.delete(pos));
    invalidateAnalysis();
    pushUndo(before, `Cleared properties for ${scope.toLowerCase()}`);
    paintAll();
    syncSelects();
    closePop({ restoreFocus: true });
  };
  const save = el('button', { class: 'btn btn-mini btn-primary', textContent: 'Save changes' });
  save.type = 'submit';
  save.disabled = !targets.length || !state.fields.size;
  actions.append(clear, save);
  form.append(actions);
  form.onsubmit = event => {
    event.preventDefault();
    const before = snapshotAll();
    let changed = false;
    for (const select of $$('select[data-field]', form)) {
      if (select.value === '__mixed__') continue;
      const mapping = state.fields.get(select.dataset.field);
      for (const pos of targets) {
        const old = mapping.get(pos) ?? '';
        const next = select.value === '__none__' ? '' : select.value;
        if (old === next) continue;
        changed = true;
        if (next) mapping.set(pos, next); else mapping.delete(pos);
      }
    }
    if (changed) {
      invalidateAnalysis();
      pushUndo(before, `Updated properties for ${scope.toLowerCase()}`);
      paintAll();
      syncSelects();
      setStatus(`${scope} properties updated.`);
    }
    closePop({ restoreFocus: true });
  };
  pop.append(form);

  pop.hidden = false;
  requestAnimationFrame(() => {
    const margin = 10;
    const left = Math.max(margin, Math.min(r.left, innerWidth - pop.offsetWidth - margin));
    const below = r.bottom + 7;
    const top = below + pop.offsetHeight <= innerHeight - margin
      ? below
      : Math.max(margin, r.top - pop.offsetHeight - 7);
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.transformOrigin =
      `${r.left + r.width / 2 - left}px ${r.top < top ? 0 : pop.offsetHeight}px`;
    pop.dataset.open = '';
    $('select, button', form)?.focus({ preventScroll: true });
  });
}

function closePop({ restoreFocus = false } = {}) {
  const pop = $('#pop');
  if (pop.hidden) return;
  clearTimeout(popCloseTimer);
  delete pop.dataset.open;
  popCloseTimer = setTimeout(() => {
    pop.hidden = true;
    if (restoreFocus && popReturnFocus?.isConnected) popReturnFocus.focus();
    popReturnFocus = null;
  }, REDUCED_MOTION.matches ? 0 : 190);
}
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#pop') && !e.target.closest('.well, .hdr')) closePop();
  if (!e.target.closest('#replaceConfirm, #btnSelectAnother')) closeReplaceConfirm();
});

/* ------------------------------------------------------- fields & values */
function editorError(form, message) {
  const input = $('.inline-input', form);
  let error = $('.inline-error', form);
  if (!error) {
    error = el('span', { class: 'inline-error' });
    error.id = `inline-error-${++editorErrorSequence}`;
    error.setAttribute('role', 'alert');
    form.append(error);
  }
  error.textContent = message;
  input?.setAttribute('aria-invalid', 'true');
  if (input) input.setAttribute('aria-describedby', error.id);
}

let editorErrorSequence = 0;

function replaceMapKey(source, oldKey, newKey) {
  return new Map([...source].map(([key, value]) => [key === oldKey ? newKey : key, value]));
}

function makeEditor({ kind, current = '', onSave, onCancel }) {
  const form = el('form', { class: 'inline-editor' });
  const input = el('input', {
    class: 'inline-input',
    value: current,
    placeholder: kind === 'field' ? 'Field name' : 'Value label',
  });
  input.type = 'text';
  input.autocomplete = 'off';
  input.setAttribute('aria-label', `${current ? 'Edit' : 'New'} ${kind}`);
  input.addEventListener('input', () => {
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
    $('.inline-error', form)?.remove();
  });
  const controls = el('span', { class: 'inline-actions' });
  const save = el('button', { class: 'btn btn-mini btn-primary', textContent: current ? 'Save' : 'Add' });
  save.type = 'submit';
  const cancel = el('button', { class: 'btn btn-mini btn-quiet', textContent: 'Cancel' });
  cancel.type = 'button';
  cancel.onclick = onCancel;
  controls.append(save, cancel);
  form.append(input, controls);
  form.onsubmit = event => {
    event.preventDefault();
    onSave(input.value, form);
  };
  requestAnimationFrame(() => input.focus({ preventScroll: true }));
  return form;
}

function itemAction(kind, label, onClick) {
  const button = el('button', { class: `item-action item-${kind}` });
  button.type = 'button';
  button.setAttribute('aria-label', label);
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('viewBox', '0 0 18 18');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute(
    'd',
    kind === 'remove'
      ? 'M4.5 4.5l9 9m0-9-9 9'
      : 'M4 12.8V15h2.2L14 7.2 10.8 4 3 11.8M9.8 5l3.2 3.2',
  );
  svg.append(path);
  button.append(svg, el('span', { class: 'sr-only', textContent: label }));
  button.onclick = event => {
    event.stopPropagation();
    onClick();
  };
  return button;
}

function editableChoice(button, onSelect, onEdit) {
  let singleClick = null;
  button.addEventListener('click', event => {
    if (event.detail === 0) { onSelect(); return; }
    if (event.detail !== 1) return;
    clearTimeout(singleClick);
    singleClick = setTimeout(onSelect, 190);
  });
  button.addEventListener('dblclick', event => {
    event.preventDefault();
    clearTimeout(singleClick);
    onEdit();
  });
  button.addEventListener('keydown', event => {
    if (event.key !== 'F2') return;
    event.preventDefault();
    clearTimeout(singleClick);
    onEdit();
  });
}

function fieldEditorNode() {
  const original = fieldEditor?.original ?? null;
  return makeEditor({
    kind: 'field',
    current: original || '',
    onCancel: () => { fieldEditor = null; renderFields(); },
    onSave: (raw, form) => {
      const name = raw.trim();
      if (!name) { editorError(form, 'Enter a field name.'); return; }
      if (name === 'well_position') {
        editorError(form, '“well_position” is reserved for workbook addresses.');
        return;
      }
      if (state.fields.has(name) && name !== original) {
        editorError(form, `“${name}” is already a field.`);
        return;
      }
      if (name === original) { fieldEditor = null; renderFields(); return; }
      const before = snapshotAll();
      if (original) {
        state.fields = replaceMapKey(state.fields, original, name);
        state.values = replaceMapKey(state.values, original, name);
        if (state.assayCol === original) state.assayCol = name;
        if (state.quantityCol === original) state.quantityCol = name;
        if (state.groupCols) state.groupCols = state.groupCols.map(key => key === original ? name : key);
      } else {
        state.fields.set(name, new Map());
        state.values.set(name, []);
      }
      state.activeField = name;
      state.activeValue = (state.values.get(name) || [])[0] ?? null;
      fieldEditor = null;
      invalidateAnalysis();
      pushUndo(before, `${original ? 'Renamed' : 'Added'} the field “${name}”`);
      renderAll();
    },
  });
}

function deleteField(field) {
  if (state.fields.size <= 1) {
    toast('Keep at least one plate-map field.', { tone: 'error' });
    return;
  }
  const before = snapshotAll();
  const keys = [...state.fields.keys()];
  const next = keys[keys.indexOf(field) + 1] || keys[keys.indexOf(field) - 1];
  state.fields.delete(field);
  state.values.delete(field);
  state.activeField = next;
  state.activeValue = (state.values.get(next) || [])[0] ?? null;
  fieldEditor = null;
  valueEditor = null;
  invalidateAnalysis();
  pushUndo(before, `Deleted the field “${field}”`);
  renderAll();
}

function renderFields() {
  const tabs = $('#fieldTabs');
  tabs.replaceChildren();
  let index = 0;
  for (const field of state.fields.keys()) {
    const item = el('div', { class: 'field-item' });
    item.setAttribute('role', 'presentation');
    const b = el('button', { class: 'tab', textContent: field });
    b.type = 'button';
    b.id = `field-tab-${index++}`;
    b.setAttribute('aria-controls', 'values');
    b.setAttribute('aria-pressed', String(field === state.activeField));
    b.tabIndex = field === state.activeField ? 0 : -1;
    const selectField = () => {
      state.activeField = field;
      state.activeValue = (state.values.get(field) || [])[0] ?? null;
      valueEditor = null;
      renderAll();
    };
    const editField = () => {
      state.activeField = field;
      state.activeValue = (state.values.get(field) || [])[0] ?? null;
      fieldEditor = { original: field };
      renderAll();
    };
    editableChoice(b, selectField, editField);
    const rename = itemAction('rename', `Rename field ${field}`, editField);
    const remove = state.fields.size > 1
      ? itemAction('remove', `Delete field ${field}`, () => deleteField(field))
      : null;
    item.append(b, rename);
    if (remove) item.append(remove);
    tabs.append(item);
    if (fieldEditor?.original === field) tabs.append(fieldEditorNode());
  }
  if (fieldEditor && !fieldEditor.original) tabs.append(fieldEditorNode());
  const selected = $('.tab[aria-pressed="true"]', tabs);
  if (selected) $('#values').setAttribute('aria-labelledby', selected.id);
}

function valueEditorNode(value = null) {
  const field = state.activeField;
  const map = state.fields.get(field) || new Map();
  return makeEditor({
    kind: 'value',
    current: value || '',
    onCancel: () => { valueEditor = null; renderValues(); },
    onSave: (raw, form) => {
      const name = raw.trim();
      const list = state.values.get(field) || [];
      if (!name) { editorError(form, 'Enter a value label.'); return; }
      if (list.includes(name) && name !== value) {
        editorError(form, `“${name}” is already in this field.`);
        return;
      }
      if (name === value) { valueEditor = null; renderValues(); return; }
      const before = snapshotAll();
      if (value) {
        const index = list.indexOf(value);
        list[index] = name;
        for (const [pos, assigned] of map) if (assigned === value) map.set(pos, name);
      } else {
        list.push(name);
      }
      state.activeValue = name;
      valueEditor = null;
      invalidateAnalysis();
      pushUndo(before, `${value ? 'Renamed' : 'Added'} “${name}”`);
      paintAll();
      syncSelects();
    },
  });
}

function deleteValue(field, value) {
  const map = state.fields.get(field) || new Map();
  const count = [...map.values()].filter(item => item === value).length;
  const before = snapshotAll();
  const list = state.values.get(field);
  list.splice(list.indexOf(value), 1);
  for (const [pos, assigned] of map) if (assigned === value) map.delete(pos);
  state.activeValue = list[0] ?? null;
  valueEditor = null;
  invalidateAnalysis();
  pushUndo(before, `Deleted “${value}” and cleared ${count} assignment${count === 1 ? '' : 's'}`);
  paintAll();
  syncSelects();
}

function renderValues() {
  const box = $('#values');
  const field = state.activeField;
  const list = state.values.get(field) || [];
  const map = state.fields.get(field) || new Map();
  box.replaceChildren();

  if (!list.length && !valueEditor) {
    box.append(el('p', { class: 'rail-note', textContent: 'No values yet. Add one, then drag across the plate.' }));
    return;
  }
  for (const v of list) {
    const n = [...map.values()].filter(x => x === v).length;
    const row = el('div', { class: 'value-row' });
    const b = el('button', { class: 'value' });
    b.type = 'button';
    b.setAttribute('aria-pressed', String(v === state.activeValue));
    b.append(el('span', { class: 'swatch', style: `background:${colourOf(field, v)}` }),
             el('span', { class: 'value-name', textContent: v }),
             el('span', { class: 'value-count', textContent: n }));
    const selectValue = () => { state.activeValue = v; renderValues(); };
    const editValue = () => { valueEditor = { value: v }; renderValues(); };
    editableChoice(b, selectValue, editValue);
    const rename = itemAction('rename', `Rename value ${v}`, editValue);
    const remove = itemAction('remove', `Delete value ${v}`, () => deleteValue(field, v));
    row.append(b, rename, remove);
    box.append(row);
    if (valueEditor?.value === v) box.append(valueEditorNode(v));
  }
  if (valueEditor && !valueEditor.value) box.append(valueEditorNode());
}

$('#btnAddField').onclick = () => {
  if (!state.loaded) { toast('Load a workbook before editing the plate.'); return; }
  fieldEditor = { original: null };
  renderFields();
};

$('#btnAddValue').onclick = () => {
  if (!state.loaded || !state.activeField) {
    toast('Load a workbook before editing the plate.');
    return;
  }
  valueEditor = { value: null };
  renderValues();
};

$('#btnFromFile').onclick = () => fillFromFile();

/* hold to clear: a destructive action confirmed by time, cancelled by
   everything else — releasing early, leaving the button, or Escape */
(() => {
  const btn = $('#btnClear');
  let raf = null, start = 0;
  const HOLD = 600;

  const stop = () => {
    cancelAnimationFrame(raf); raf = null;
    btn.style.setProperty('--hold', 0);
  };
  const tick = () => {
    const p = Math.min(1, (performance.now() - start) / HOLD);
    btn.style.setProperty('--hold', p);
    if (p >= 1) { stop(); doClear(); return; }
    raf = requestAnimationFrame(tick);
  };
  btn.addEventListener('pointerdown', e => {
    e.preventDefault();
    start = performance.now();
    raf = requestAnimationFrame(tick);
  });
  for (const ev of ['pointerup', 'pointerleave', 'pointercancel'])
    btn.addEventListener(ev, stop);
  btn.addEventListener('keydown', e => {
    if (!['Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    if (e.repeat || raf) return;
    start = performance.now();
    raf = requestAnimationFrame(tick);
  });
  btn.addEventListener('keyup', e => {
    if (!['Enter', ' '].includes(e.key)) return;
    e.preventDefault();
    stop();
  });
  btn.addEventListener('blur', stop);
  document.addEventListener('keydown', e => { if (e.key === 'Escape') stop(); });

  function doClear() {
    const before = snapshotAll();
    for (const m of state.fields.values()) m.clear();
    invalidateAnalysis();
    pushUndo(before, 'Cleared every assignment');
    renderAll();
    setStatus('Plate cleared.');
  }
})();

/* --------------------------------------------------------------- selects */
function syncSelects() {
  const fields = [...state.fields.keys()];
  fillSelect($('#selAssay'), fields, state.assayCol ?? fields[0]);
  fillSelect($('#selQuantity'), ['(none)', ...fields], state.quantityCol ?? '(none)');

  const gsel = $('#selGroup');
  const chosen = new Set(state.groupCols ?? fields.slice(0, 2));
  gsel.replaceChildren(...fields.map(f => {
    const o = new Option(f, f);
    o.selected = chosen.has(f);
    return o;
  }));
  gsel.size = Math.min(4, Math.max(2, fields.length));
  renderGroupPicker();

  const assay = $('#selAssay').value;
  const assayValues = state.values.get(assay) || [];
  fillSelect($('#selDctA'), ['(none)', ...assayValues], state.dctA ?? '(none)');
  fillSelect($('#selDctB'), ['(none)', ...assayValues], state.dctB ?? '(none)');
}

function renderGroupPicker() {
  const picker = $('#groupPicker');
  const select = $('#selGroup');
  picker.replaceChildren();
  for (const option of select.options) {
    const button = el('button', { class: 'multi-option' });
    button.type = 'button';
    button.setAttribute('aria-pressed', String(option.selected));
    button.append(
      el('span', { class: 'multi-check', 'aria-hidden': 'true' }),
      el('span', { class: 'multi-name', textContent: option.value }),
    );
    button.onclick = () => {
      option.selected = !option.selected;
      state.groupCols = [...select.selectedOptions].map(item => item.value);
      invalidateAnalysis();
      renderGroupPicker();
    };
    picker.append(button);
  }
}

function fillSelect(sel, options, chosen) {
  sel.replaceChildren(...options.map(o => new Option(o, o)));
  if (options.includes(chosen)) sel.value = chosen;
}

$('#selAssay').onchange = e => {
  state.assayCol = e.target.value;
  syncSelects();
  invalidateAnalysis();
};
$('#selQuantity').onchange = e => {
  state.quantityCol = e.target.value;
  invalidateAnalysis();
};
$('#selGroup').onchange = e =>
  {
    state.groupCols = [...e.target.selectedOptions].map(o => o.value);
    invalidateAnalysis();
    renderGroupPicker();
  };
$('#selDctA').onchange = e => {
  state.dctA = e.target.value;
  invalidateAnalysis();
};
$('#selDctB').onchange = e => {
  state.dctB = e.target.value;
  invalidateAnalysis();
};

$('#optCurveBg').addEventListener('change', event => {
  $('#curveBgState').textContent = event.target.checked ? 'White' : 'Transparent';
  invalidateAnalysis();
});

const thresholdInputs = [
  ['#optNtc', 'NTC margin'],
  ['#optSd', 'Max Ct SD'],
  ['#optCtMin', 'Min Ct'],
];

function clearThresholdError() {
  const error = $('#thresholdError');
  error.hidden = true;
  error.textContent = '';
  thresholdInputs.forEach(([selector]) => {
    const input = $(selector);
    input.removeAttribute('aria-invalid');
    input.removeAttribute('aria-describedby');
  });
}

function validateThresholds({ focus = false, reveal = false } = {}) {
  clearThresholdError();
  const invalidThreshold = thresholdInputs.find(([selector]) => {
    const value = $(selector).valueAsNumber;
    return !Number.isFinite(value) || value < 0;
  });
  if (!invalidThreshold) return '';

  const [selector, label] = invalidThreshold;
  const input = $(selector);
  const message = `${label} must be a non-negative number.`;
  if (reveal && $('#btnThresholds').getAttribute('aria-expanded') !== 'true') {
    $('#btnThresholds').click();
  }
  input.setAttribute('aria-invalid', 'true');
  input.setAttribute('aria-describedby', 'thresholdError');
  const error = $('#thresholdError');
  error.textContent = message;
  error.hidden = false;
  if (focus) input.focus();
  return message;
}

thresholdInputs.forEach(([selector]) => {
  $(selector).addEventListener('input', () => {
    validateThresholds();
    invalidateAnalysis();
  });
});

$$('.seg-btn').forEach(b => {
  b.onclick = () => {
    const next = Number(b.dataset.format);
    if (next === state.format) return;
    const direction = next > state.format ? 1 : -1;
    state.format = next;
    renderAll();
    animatePanel($('#plate'), { x: direction * 10, y: 0 });
    setStatus(`Showing a ${state.format}-well layout.`);
  };
});

$('#btnThresholds').onclick = () => {
  const button = $('#btnThresholds');
  const open = button.getAttribute('aria-expanded') !== 'true';
  button.setAttribute('aria-expanded', String(open));
  const body = $('#thresholdBody');
  body.setAttribute('aria-hidden', String(!open));
  body.inert = !open;
  $('#thresholds').toggleAttribute('data-open', open);
};

/* ----------------------------------------------------------------- run */
$('#btnRun').onclick = () => {
  const btn = $('#btnRun');
  void withPending(
    btn, $('#runLabel'), $('#runSpin'), 'Running',
    () => state.results ? 'Run again' : 'Run analysis', runAnalysis,
    () => state.loaded && state.runtimeReady,
  ).catch(error => {
    const message = messageFor(error);
    clearResults(message);
    paintAll();
    setStatus(message);
    toast(message, { tone: 'error', timeout: 8000 });
  });
};

async function runAnalysis() {
  if (!state.loaded) throw new Error('Load a workbook before running the analysis.');
  const fields = {};
  for (const [f, m] of state.fields) {
    const o = {};
    for (const [w, v] of m) if (state.present.has(w)) o[w] = v;
    if (Object.keys(o).length) fields[f] = o;
  }
  const dctA = $('#selDctA').value, dctB = $('#selDctB').value;

  const thresholdMessage = validateThresholds({ focus: true, reveal: true });
  if (thresholdMessage) throw new Error(thresholdMessage);

  const options = {
    ntc_margin: $('#optNtc').valueAsNumber,
    sd_max: $('#optSd').valueAsNumber,
    ct_min: $('#optCtMin').valueAsNumber,
    curve_background: $('#optCurveBg').checked,
  };

  const body = {
    fields,
    assay_col: $('#selAssay').value,
    group_cols: [...$('#selGroup').selectedOptions].map(o => o.value),
    quantity_col: $('#selQuantity').value === '(none)' ? null : $('#selQuantity').value,
    dct: dctA !== '(none)' && dctB !== '(none)' ? [dctA, dctB] : null,
    options,
  };
  const runRevision = analysisRevision;

  clearResults();
  paintAll();
  showSkeleton();
  const d = await localBackend.analyze(body);
  if (runRevision !== analysisRevision) {
    const message = 'The plate or analysis settings changed while this run was in progress. Run again to refresh the results.';
    clearResults(message);
    paintAll();
    setStatus(message);
    return false;
  }

  for (const [name, bytes] of Object.entries(d.plots || {})) {
    const blob = new Blob([bytes], { type: 'image/png' });
    const url = URL.createObjectURL(blob);
    state.plotUrls.push(url);
    state.plotBlobs.set(name, blob);
    d.plots[name] = url;
  }

  state.results = d;
  state.flags = new Map();
  const pw = d.tables.per_well;
  const iPos = pw.columns.indexOf('well_position');
  const iFlag = pw.columns.indexOf('qc_flags');
  for (const row of pw.rows) if (row[iFlag]) state.flags.set(row[iPos], row[iFlag]);

  paintAll();
  $('#btnDownload').disabled = false;
  renderResults();
  setStatus(`${d.n_wells} wells analysed. ${d.n_flagged} carry a QC flag.`);
  requestAnimationFrame(() => $('#results').scrollIntoView({
    behavior: REDUCED_MOTION.matches ? 'auto' : 'smooth',
    block: 'start',
  }));
}

/* ------------------------------------------------------------- results */
function showSkeleton() {
  resultTableObserver?.disconnect();
  resultTableObserver = null;
  const body = $('#resultBody');
  body.dataset.kind = 'table';
  body.removeAttribute('aria-labelledby');
  body.setAttribute('aria-label', 'Analysis running');
  body.setAttribute('aria-busy', 'true');
  body.replaceChildren();
  /* rows are the height they will be when real, so arrival does not shift
     anything below them */
  for (let i = 0; i < 9; i++) {
    const row = el('div', { class: 'skel-row' });
    for (const w of [70, 120, 54, 54, 80, 46])
      row.append(el('div', { class: 'skel-cell', style: `width:${w}px` }));
    body.append(row);
  }
}

const TAB_LABEL = {
  summary: 'Summary', per_well: 'Per well',
  standard_curve: 'Standard curve', delta_ct: 'ΔCt', plots: 'Curves',
};

const PLOT_META = {
  amplification: { label: 'Amplification curves', suffix: 'amplification' },
  melt: { label: 'Melt curves', suffix: 'melt' },
  plate: { label: 'Ct plate heatmap', suffix: 'plate_ct' },
};

function plotMeta(name) {
  if (PLOT_META[name]) return PLOT_META[name];
  const fallback = String(name).replaceAll('_', ' ').trim() || 'Plot';
  const suffix = String(name).toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'plot';
  return {
    label: fallback.replace(/\b\w/g, letter => letter.toUpperCase()),
    suffix,
  };
}

function renderResults() {
  const d = state.results;
  const keys = [...Object.keys(d.tables)];
  if (Object.keys(d.plots).length) keys.push('plots');
  const order = ['summary', 'per_well', 'standard_curve', 'delta_ct', 'plots']
    .filter(k => keys.includes(k));

  if (!order.includes(state.activeResultTab)) state.activeResultTab = order[0];

  const tabs = $('#resultTabs');
  tabs.replaceChildren();
  for (const k of order) {
    const b = el('button', { class: 'tab', textContent: TAB_LABEL[k] ?? k });
    b.type = 'button';
    b.id = `result-tab-${k}`;
    b.setAttribute('role', 'tab');
    b.setAttribute('aria-controls', 'resultBody');
    b.setAttribute('aria-selected', String(k === state.activeResultTab));
    b.tabIndex = k === state.activeResultTab ? 0 : -1;
    b.onclick = () => {
      if (state.activeResultTab === k) return;
      const previous = order.indexOf(state.activeResultTab);
      state.activeResultTab = k;
      renderResults();
      animatePanel($('#resultBody'), { x: (order.indexOf(k) > previous ? 1 : -1) * 9, y: 0 });
    };
    tabs.append(b);
  }

  const body = $('#resultBody');
  resultTableObserver?.disconnect();
  resultTableObserver = null;
  body.removeAttribute('aria-label');
  body.setAttribute('aria-busy', 'false');
  body.setAttribute('aria-labelledby', `result-tab-${state.activeResultTab}`);
  body.dataset.kind = state.activeResultTab === 'plots' ? 'plots' : 'table';
  body.replaceChildren();
  if (state.activeResultTab === 'plots') {
    const wrap = el('div', { class: 'plots' });
    const plotEntries = Object.entries(d.plots);
    if (plotEntries.length > 1) {
      const label = el('span', {
        class: 'btn-label',
        textContent: 'Download all PNGs',
      });
      const spinner = el('span', {
        class: 'spinner spinner-dark',
        hidden: true,
      });
      spinner.setAttribute('aria-hidden', 'true');
      const downloadAll = el('button', {
        class: 'btn reserve plots-download-all',
        dataset: { states: 'Download all PNGs|Preparing ZIP' },
      });
      downloadAll.type = 'button';
      downloadAll.disabled = !state.runtimeReady;
      downloadAll.append(label, spinner);
      downloadAll.onclick = () => {
        void withPending(
          downloadAll, label, spinner,
          'Preparing ZIP', 'Download all PNGs',
          async () => {
            const bytes = await localBackend.curvesZip();
            downloadBlob(
              new Blob([bytes], { type: 'application/zip' }),
              downloadName(state.filename, '_plots', 'zip'),
            );
            toast(`${plotEntries.length} plot images packaged locally.`);
          },
          () => Boolean(state.results) && state.runtimeReady,
        ).catch(error => {
          toast(messageFor(error, 'Could not package the plot images.'), {
            tone: 'error', timeout: 8000,
          });
        });
      };
      const svgAllLabel = el('span', {
        class: 'btn-label',
        textContent: 'Download all SVGs',
      });
      const svgAllSpinner = el('span', {
        class: 'spinner spinner-dark',
        hidden: true,
      });
      svgAllSpinner.setAttribute('aria-hidden', 'true');
      const downloadAllSvg = el('button', {
        class: 'btn reserve plots-download-all-svg',
        dataset: { states: 'Download all SVGs|Preparing ZIP' },
      });
      downloadAllSvg.type = 'button';
      downloadAllSvg.disabled = !state.runtimeReady;
      downloadAllSvg.append(svgAllLabel, svgAllSpinner);
      downloadAllSvg.onclick = () => {
        void withPending(
          downloadAllSvg, svgAllLabel, svgAllSpinner,
          'Preparing ZIP', 'Download all SVGs',
          async () => {
            const bytes = await localBackend.curvesSvgZip();
            downloadBlob(
              new Blob([bytes], { type: 'application/zip' }),
              downloadName(state.filename, '_plots_svg', 'zip'),
            );
            toast(`${plotEntries.length} vector plots packaged locally.`);
          },
          () => Boolean(state.results) && state.runtimeReady,
        ).catch(error => {
          toast(messageFor(error, 'Could not package the vector plots.'), {
            tone: 'error', timeout: 8000,
          });
        });
      };
      const toolbar = el('div', {
        class: 'plots-toolbar',
      });
      toolbar.append(
        el('span', {
          class: 'plots-toolbar-copy',
          textContent: 'PNG previews and vector SVG exports are generated locally.',
        }),
      );
      const allActions = el('span', { class: 'plots-toolbar-actions' });
      allActions.append(downloadAll, downloadAllSvg);
      toolbar.append(allActions);
      wrap.append(toolbar);
    }

    for (const [name, src] of plotEntries) {
      const meta = plotMeta(name);
      const heading = el('span', { class: 'plot-name', textContent: meta.label });
      const downloadPng = el('button', {
        class: 'btn plot-download-png',
        textContent: 'Download PNG',
      });
      downloadPng.type = 'button';
      downloadPng.setAttribute(
        'aria-label',
        `Download ${meta.label.toLowerCase()} as PNG`,
      );
      downloadPng.onclick = () => {
        const blob = state.plotBlobs.get(name);
        if (!blob) {
          toast('That PNG is no longer available. Run the analysis again.', {
            tone: 'error',
          });
          return;
        }
        downloadBlob(
          blob,
          downloadName(state.filename, `_${meta.suffix}`, 'png'),
        );
      };

      const svgLabel = el('span', {
        class: 'btn-label',
        textContent: 'Download SVG',
      });
      const svgSpinner = el('span', {
        class: 'spinner spinner-dark',
        hidden: true,
      });
      svgSpinner.setAttribute('aria-hidden', 'true');
      const downloadSvg = el('button', {
        class: 'btn reserve plot-download-svg',
        dataset: { states: 'Download SVG|Preparing SVG' },
      });
      downloadSvg.type = 'button';
      downloadSvg.disabled = !state.runtimeReady;
      downloadSvg.setAttribute(
        'aria-label',
        `Download ${meta.label.toLowerCase()} as SVG`,
      );
      downloadSvg.append(svgLabel, svgSpinner);
      downloadSvg.onclick = () => {
        void withPending(
          downloadSvg, svgLabel, svgSpinner,
          'Preparing SVG', 'Download SVG',
          async () => {
            const bytes = await localBackend.plotSvg(name);
            downloadBlob(
              new Blob([bytes], { type: 'image/svg+xml;charset=utf-8' }),
              downloadName(state.filename, `_${meta.suffix}`, 'svg'),
            );
            toast('Vector SVG created locally.');
          },
          () => Boolean(state.results?.plots?.[name]) && state.runtimeReady,
        ).catch(error => {
          toast(messageFor(error, 'Could not create that SVG.'), {
            tone: 'error', timeout: 8000,
          });
        });
      };

      const actions = el('span', { class: 'plot-actions' });
      actions.setAttribute('role', 'group');
      actions.setAttribute('aria-label', `Download ${meta.label.toLowerCase()}`);
      actions.append(downloadPng, downloadSvg);
      const caption = el('figcaption', { class: 'plot-head' });
      caption.append(heading, actions);
      const figure = el('figure', { class: 'plot' });
      figure.append(
        caption,
        el('img', {
          src,
          alt: `${meta.label} generated from the current analysis`,
        }),
      );
      wrap.append(figure);
    }
    body.append(wrap);
    const allButton = $('.plots-download-all', wrap);
    if (allButton) reserveWidth(allButton);
    const allSvgButton = $('.plots-download-all-svg', wrap);
    if (allSvgButton) reserveWidth(allSvgButton);
    $$('.plot-download-svg', wrap).forEach(reserveWidth);
  } else {
    body.append(table(d.tables[state.activeResultTab]));
  }
}

function moveTabFocus(event) {
  const list = event.currentTarget;
  const selector = list.id === 'fieldTabs' ? '.tab' : '[role="tab"]';
  const tab = event.target.closest(selector);
  if (!tab) return;
  const tabs = $$(selector, list);
  const current = tabs.indexOf(tab);
  let next = null;
  if (event.key === 'ArrowRight') next = tabs[(current + 1) % tabs.length];
  if (event.key === 'ArrowLeft') next = tabs[(current - 1 + tabs.length) % tabs.length];
  if (event.key === 'Home') next = tabs[0];
  if (event.key === 'End') next = tabs.at(-1);
  if (!next) return;
  event.preventDefault();
  next.focus();
  next.click();
  requestAnimationFrame(() => {
    const selectedSelector = list.id === 'fieldTabs'
      ? '.tab[aria-pressed="true"]'
      : '[role="tab"][aria-selected="true"]';
    $(selectedSelector, list)?.focus();
  });
}

$('#fieldTabs').addEventListener('keydown', moveTabFocus);
$('#resultTabs').addEventListener('keydown', moveTabFocus);

function fmt(v) {
  if (v === null || v === undefined || v === '') return '—';
  if (typeof v !== 'number') return String(v);
  if (!Number.isFinite(v)) return '—';
  if (Number.isInteger(v)) return String(v);
  const a = Math.abs(v);
  if (a >= 1e5 || (a > 0 && a < 1e-3)) return v.toExponential(2);
  return v.toFixed(2);
}

function table({ columns, rows }) {
  resultTableObserver?.disconnect();
  resultTableObserver = null;

  const t = el('table');
  const thead = el('thead');
  const hr = el('tr');
  columns.forEach(c => hr.append(el('th', { textContent: c })));
  thead.append(hr);
  const tb = el('tbody');
  const iFlag = columns.indexOf('qc_flags');
  for (const row of rows) {
    const tr = el('tr');
    if (iFlag >= 0 && row[iFlag]) tr.dataset.flagged = '';
    row.forEach((v, i) => {
      const td = el('td', { textContent: fmt(v) });
      if (typeof v === 'number') td.className = 'num';
      if (i === iFlag && v) td.className = 'flagcell';
      tr.append(td);
    });
    tb.append(tr);
  }
  t.append(thead, tb);

  /* Horizontal data movement and vertical page movement deliberately live in
     different elements. The visible header is outside the horizontal scroller,
     stays pinned below the result tabs, and mirrors its column geometry. */
  const copyTable = el('table', { class: 'table-head-copy' });
  copyTable.setAttribute('aria-hidden', 'true');
  const colgroup = el('colgroup');
  const copyCols = columns.map(() => el('col'));
  colgroup.append(...copyCols);
  const copyHead = el('thead');
  const copyRow = el('tr');
  columns.forEach(column => copyRow.append(el('th', { textContent: column })));
  copyHead.append(copyRow);
  copyTable.append(colgroup, copyHead);

  const stickyTrack = el('div', { class: 'table-sticky-track' });
  stickyTrack.append(copyTable);
  const sticky = el('div', { class: 'table-sticky-head' });
  sticky.append(stickyTrack);

  const scroller = el('div', { class: 'table-x-scroll' });
  scroller.tabIndex = 0;
  scroller.setAttribute('role', 'region');
  scroller.setAttribute('aria-label', 'Analysis result table. Scroll horizontally for more columns.');
  scroller.append(t);

  const region = el('div', { class: 'table-region' });
  region.append(sticky, scroller);

  let headerFrame = 0;
  const syncHeaderX = () => {
    cancelAnimationFrame(headerFrame);
    headerFrame = requestAnimationFrame(() => {
      headerFrame = 0;
      if (stickyTrack.isConnected) {
        stickyTrack.style.transform = `translateX(${-scroller.scrollLeft}px)`;
      }
    });
  };
  const measureHeader = () => {
    if (!t.isConnected) return;
    const cells = $$('th', thead);
    const tableWidth = Math.ceil(t.getBoundingClientRect().width);
    const widths = cells.map(cell => cell.getBoundingClientRect().width);
    const headHeight = Math.ceil(thead.getBoundingClientRect().height);
    copyCols.forEach((column, index) => { column.style.width = `${widths[index]}px`; });
    copyTable.style.width = `${tableWidth}px`;
    stickyTrack.style.width = `${tableWidth}px`;
    sticky.style.setProperty('--table-head-height', `${headHeight}px`);
    syncHeaderX();
  };
  scroller.addEventListener('scroll', syncHeaderX, { passive: true });
  if ('ResizeObserver' in window) {
    resultTableObserver = new ResizeObserver(measureHeader);
    resultTableObserver.observe(scroller);
    resultTableObserver.observe(t);
  }
  requestAnimationFrame(measureHeader);
  return region;
}

/* ------------------------------------------------------------- exports */
function downloadName(filename, suffix, extension) {
  const stem = (filename || 'quantstudio_export')
    .replace(/\.[^.]+$/, '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim() || 'quantstudio_export';
  return `${stem}${suffix}.${extension}`;
}

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const link = Object.assign(document.createElement('a'), { href: url, download: filename });
  document.body.append(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

$('#btnDownload').onclick = () => {
  if (!state.results) return;
  const btn = $('#btnDownload');
  void withPending(
    btn, $('#downloadLabel'), $('#downloadSpin'),
    'Preparing download', 'Download workbook',
    async () => {
      const bytes = await localBackend.workbook();
      downloadBlob(
        new Blob([bytes], { type: XLSX_MIME }),
        downloadName(state.filename, '_processed', 'xlsx'),
      );
      toast('Processed workbook created locally.');
    },
    () => Boolean(state.results) && state.runtimeReady,
  ).catch(error => {
    toast(messageFor(error, 'Could not build the workbook.'), {
      tone: 'error', timeout: 8000,
    });
  });
};

$('#btnYaml').onclick = async () => {
  const button = $('#btnYaml');
  button.disabled = true;
  const fields = {};
  for (const [f, m] of state.fields) {
    const o = {};
    for (const [w, v] of m) if (v) o[w] = v;
    if (Object.keys(o).length) fields[f] = o;
  }
  try {
    const d = await localBackend.platemapYaml({ fields, name: state.filename });
    try {
      await navigator.clipboard.writeText(d.yaml);
      toast('Platemap YAML copied. Save it next to the export and pass it to qsp -m.');
    } catch {
      downloadBlob(
        new Blob([d.yaml], { type: 'text/yaml;charset=utf-8' }),
        downloadName(state.filename, '', 'yaml'),
      );
      toast('Clipboard access was blocked, so the YAML was downloaded instead.');
    }
  } catch (error) {
    toast(messageFor(error, 'Could not create the platemap YAML.'), {
      tone: 'error', timeout: 7000,
    });
  } finally {
    button.disabled = !state.loaded || !state.runtimeReady;
  }
};

/* ---------------------------------------------------------------- input */
const drop = $('#drop');
['dragenter', 'dragover'].forEach(ev =>
  drop.addEventListener(ev, e => { e.preventDefault(); drop.dataset.over = ''; }));
['dragleave', 'drop'].forEach(ev =>
  drop.addEventListener(ev, () => delete drop.dataset.over));
drop.addEventListener('drop', e => {
  e.preventDefault();
  const f = e.dataTransfer.files[0];
  if (f) loadFile(f);
});
$('#fileInput').addEventListener('change', e => {
  const f = e.target.files[0];
  if (f) loadFile(f);
  e.target.value = '';          // re-selecting the same file still fires change
});

/* --------------------------------------------------------------- helpers */
function el(tag, props = {}) {
  const n = document.createElement(tag);
  const { dataset, ...rest } = props;
  Object.assign(n, rest);
  if (props.style) n.style.cssText = props.style;
  if (props.class) n.className = props.class;
  for (const [k, v] of Object.entries(dataset || {})) n.dataset[k] = v;
  return n;
}

function toggleAttr(node, attr, on) {
  if (on) node.setAttribute(attr, ''); else node.removeAttribute(attr);
}

function setStatus(text) { $('#plateStatus').textContent = text; }

function syncScrollLens(lens) {
  const viewport = $('[data-scroll-viewport]', lens);
  if (!viewport) return;
  const overflow = viewport.scrollHeight > viewport.clientHeight + 2;
  const atStart = !overflow || viewport.scrollTop <= 1;
  const atEnd = !overflow
    || viewport.scrollTop + viewport.clientHeight >= viewport.scrollHeight - 1;
  lens.toggleAttribute('data-overflow', overflow);
  lens.toggleAttribute('data-at-start', atStart);
  lens.toggleAttribute('data-at-end', atEnd);
  viewport.tabIndex = overflow ? 0 : -1;
}

function scheduleScrollLenses() {
  cancelAnimationFrame(scrollLensFrame);
  scrollLensFrame = requestAnimationFrame(() => {
    scrollLensFrame = 0;
    scrollLensSyncers.forEach(sync => sync());
  });
}

function setupScrollLenses() {
  $$('[data-scroll-lens]').forEach(lens => {
    const viewport = $('[data-scroll-viewport]', lens);
    const sync = () => syncScrollLens(lens);
    scrollLensSyncers.push(sync);
    viewport.addEventListener('scroll', sync, { passive: true });

    if ('ResizeObserver' in window) {
      const resize = new ResizeObserver(sync);
      resize.observe(viewport);
      if (viewport.firstElementChild) resize.observe(viewport.firstElementChild);
      scrollLensObservers.push(resize);
    }
    const mutation = new MutationObserver(scheduleScrollLenses);
    mutation.observe(viewport, { childList: true, subtree: true });
    scrollLensObservers.push(mutation);
  });
  scheduleScrollLenses();
}

function syncStickyOffsets() {
  const root = document.documentElement;
  const barHeight = Math.ceil($('.bar').getBoundingClientRect().height);
  const tabsHeight = Math.ceil($('#resultTabs').getBoundingClientRect().height);
  root.style.setProperty('--bar-height', `${barHeight}px`);
  if (tabsHeight > 1) root.style.setProperty('--result-tabs-height', `${tabsHeight}px`);
}

function setupStickyOffsets() {
  syncStickyOffsets();
  if ('ResizeObserver' in window) {
    const observer = new ResizeObserver(syncStickyOffsets);
    observer.observe($('.bar'));
    observer.observe($('#resultTabs'));
    scrollLensObservers.push(observer);
  } else {
    window.addEventListener('resize', syncStickyOffsets, { passive: true });
  }
}

function renderAll() {
  $$('.seg-btn').forEach(b =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.format) === state.format)));
  renderFields();
  renderPlate();
  syncSelects();
  if (state.results) renderResults();
  scheduleScrollLenses();
}

window.addEventListener('beforeunload', event => {
  if (!state.loaded || allowUnload) return;
  event.preventDefault();
  event.returnValue = '';
});
window.addEventListener('pagehide', event => {
  if (!event.persisted) releasePlotUrls();
});

reserveWidth($('#btnRun'));
reserveWidth($('#btnDownload'));
setupScrollLenses();
setupStickyOffsets();
void prepareRuntime();
