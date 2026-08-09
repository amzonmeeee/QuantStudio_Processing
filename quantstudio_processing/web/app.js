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

const state = {
  loaded: false, loading: false, runtimeReady: false, sourceFile: null,
  filename: null, format: 96,
  ct: new Map(),                 // well position -> Ct (or null)
  present: new Set(),            // wells that exist in the export
  fields: new Map(),             // field -> Map(well -> value)
  values: new Map(),             // field -> [value, ...] in creation order
  activeField: null,
  activeValue: null,
  flags: new Map(),              // well -> qc flag text
  undo: [],
  results: null,
  activeResultTab: null,
  plotUrls: [],
  plotBlobs: new Map(),
};

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
      labelEl.textContent = doneText ?? idle;
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
  while (stack.children.length >= 3) stack.firstElementChild.remove();
  stack.append(el);
  requestAnimationFrame(() => el.dataset.open = '');
  const t = setTimeout(dismiss, timeout);
  function dismiss() {
    clearTimeout(t);
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
  releasePlotUrls();
  state.results = null;
  state.activeResultTab = null;
  state.flags = new Map();
  $('#resultTabs').replaceChildren();
  $('#resultBody').replaceChildren(el('p', { class: 'empty', textContent: message }));
  $('#btnDownload').disabled = true;
}

function clearLoadedUi() {
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
  $('#fileChip').hidden = true;
  $('#drop').hidden = false;
  $('#plateWrap').hidden = true;
  $('#btnRun').disabled = true;
  $('#btnYaml').disabled = true;
  $('#btnPlateRetry').hidden = true;
  clearResults();
}

function updateRuntimeStatus(status) {
  const runtime = $('#runtimeState');
  const runtimeState = status.state || 'loading';
  state.runtimeReady = runtimeState === 'ready';
  runtime.dataset.state = runtimeState;
  $('#runtimeText').textContent = status.message;
  const canRetry = runtimeState === 'error' && status.recoverable !== false;
  $('#btnRuntimeRetry').hidden = !canRetry;
  $('#btnPlateRetry').hidden = !canRetry || !state.loaded;
  $$('.plots-download-all').forEach(button => {
    button.disabled = runtimeState !== 'ready';
  });

  if (runtimeState === 'error') {
    $('#btnRun').disabled = true;
    $('#btnYaml').disabled = true;
    $('#btnDownload').disabled = true;
    if (state.loaded) setStatus('The local analyzer stopped. Retry to reload this workbook.');
  } else if (runtimeState === 'loading' && state.loaded) {
    setStatus(status.message);
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
  clearLoadedUi();
  $('#drop').dataset.busy = '';
  $('#fileInput').disabled = true;
  $('#runtimeText').textContent = 'Opening the workbook locally…';

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
  Object.assign(state, s);
  renderAll();
  setStatus('Reverted the last change.');
}

document.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z' && !e.shiftKey) {
    e.preventDefault(); undo();
  }
  if (e.key === 'Escape') closePop();
});

/* ----------------------------------------------------------- plate paint */
let stroke = null;

function renderPlate() {
  const { rows, cols } = FORMATS[state.format];
  const plate = $('#plate');
  plate.dataset.format = state.format;
  // wells are capped rather than stretched: a 96-well plate on a wide screen
  // should still look like a plate, not fill the window
  const cap = state.format === 384 ? 26 : 44;
  plate.style.gridTemplateColumns = `18px repeat(${cols}, minmax(0, ${cap}px))`;
  plate.replaceChildren();

  plate.append(el('div'));
  for (let c = 1; c <= cols; c++)
    plate.append(el('button', { class: 'hdr', textContent: c, dataset: { col: c } }));

  for (let r = 0; r < rows; r++) {
    const letter = String.fromCharCode(65 + r);
    plate.append(el('button', { class: 'hdr', textContent: letter, dataset: { row: letter } }));
    for (let c = 1; c <= cols; c++) {
      const pos = letter + c;
      const w = el('button', { class: 'well', dataset: { pos } });
      w.type = 'button';
      plate.append(w);
    }
  }
  paintAll();
}

function colourOf(field, value) {
  const list = state.values.get(field) || [];
  const i = list.indexOf(value);
  return i < 0 ? null : `var(--dye-${(i % DYES) + 1})`;
}

function paintAll() {
  const field = state.activeField;
  const map = state.fields.get(field) || new Map();
  for (const w of $$('.well', $('#plate'))) {
    const pos = w.dataset.pos;
    const has = state.present.has(pos);
    toggleAttr(w, 'data-empty', !has);
    const v = map.get(pos);
    toggleAttr(w, 'data-assigned', !!v);
    w.style.background = v ? colourOf(field, v) : '';
    const ct = state.ct.get(pos);
    w.textContent = has ? (ct == null ? '—' : ct.toFixed(1)) : '';
    const flag = state.flags.get(pos);
    toggleAttr(w, 'data-flag', !!flag);
    w.title = has
      ? `${pos}${v ? ` · ${field}: ${v}` : ''}${ct == null ? ' · Undetermined' : ` · Ct ${ct}`}` +
        (flag ? ` · ${flag}` : '')
      : `${pos} · no data in this export`;
  }
  renderValues();
}

function assign(pos, value) {
  if (!state.present.has(pos)) return false;
  const map = state.fields.get(state.activeField);
  if (value == null) map.delete(pos); else map.set(pos, value);
  return true;
}

$('#plate').addEventListener('pointerdown', e => {
  const hdr = e.target.closest('.hdr');
  const well = e.target.closest('.well');
  if (!hdr && !well) return;
  if (!state.activeValue && !e.altKey) {
    setStatus('Pick a value in the Values list first, or add one.');
    return;
  }
  e.preventDefault();
  stroke = { erase: e.altKey, before: snapshotAll(), touched: 0, skipped: 0 };

  if (hdr) {
    const targets = hdr.dataset.col
      ? [...Array(FORMATS[state.format].rows)].map((_, i) =>
          String.fromCharCode(65 + i) + hdr.dataset.col)
      : [...Array(FORMATS[state.format].cols)].map((_, i) => hdr.dataset.row + (i + 1));
    targets.forEach(p => applyStroke(p));
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
    pushUndo(before, `${erase ? 'Cleared' : 'Assigned'} ${touched} well${touched > 1 ? 's' : ''}`);
    renderValues();
    syncSelects();
  }
  setStatus(skipped
    ? `${touched} well${touched === 1 ? '' : 's'} set. ${skipped} skipped — no data in this export.`
    : `${touched} well${touched === 1 ? '' : 's'} set.`);
}

/* well detail, opening from the well it was triggered on */
$('#plate').addEventListener('click', e => {
  const w = e.target.closest('.well');
  if (!w || !e.altKey) return;
  openPop(w);
});
$('#plate').addEventListener('contextmenu', e => {
  const w = e.target.closest('.well');
  if (!w) return;
  e.preventDefault();
  openPop(w);
});

function openPop(wellEl) {
  const pos = wellEl.dataset.pos;
  const pop = $('#pop');
  const r = wellEl.getBoundingClientRect();
  const ct = state.ct.get(pos);
  const rows = [...state.fields].map(([f, m]) => [f, m.get(pos) ?? '—']);

  pop.replaceChildren();
  pop.append(el('p', { class: 'pop-head', textContent: pos }));
  const dl = el('dl');
  dl.append(el('dt', { textContent: 'Ct' }),
            el('dd', { textContent: !state.present.has(pos) ? 'no data' : ct == null ? 'Undetermined' : ct.toFixed(2) }));
  for (const [f, v] of rows) dl.append(el('dt', { textContent: f }), el('dd', { textContent: v }));
  pop.append(dl);
  const flag = state.flags.get(pos);
  if (flag) pop.append(el('p', { class: 'pop-flag', textContent: flag }));

  pop.hidden = false;
  const left = Math.min(r.left, innerWidth - 232);
  const top = Math.min(r.bottom + 6, innerHeight - 160);
  pop.style.left = `${Math.max(8, left)}px`;
  pop.style.top = `${top}px`;
  /* the overlay grows out of the well it came from rather than from nowhere */
  pop.style.transformOrigin =
    `${r.left + r.width / 2 - left}px ${r.top < top ? 0 : pop.offsetHeight}px`;
  requestAnimationFrame(() => pop.dataset.open = '');
}

function closePop() {
  const pop = $('#pop');
  if (pop.hidden) return;
  delete pop.dataset.open;
  setTimeout(() => { pop.hidden = true; }, 160);
}
document.addEventListener('pointerdown', e => {
  if (!e.target.closest('#pop') && !e.target.closest('.well')) closePop();
});

/* ------------------------------------------------------- fields & values */
function renderFields() {
  const tabs = $('#fieldTabs');
  tabs.replaceChildren();
  for (const field of state.fields.keys()) {
    const b = el('button', { class: 'tab', textContent: field });
    b.type = 'button';
    b.setAttribute('aria-selected', String(field === state.activeField));
    b.onclick = () => {
      state.activeField = field;
      state.activeValue = (state.values.get(field) || [])[0] ?? null;
      renderAll();
    };
    tabs.append(b);
  }
}

function renderValues() {
  const box = $('#values');
  const field = state.activeField;
  const list = state.values.get(field) || [];
  const map = state.fields.get(field) || new Map();
  box.replaceChildren();

  if (!list.length) {
    box.append(el('p', { class: 'rail-note', textContent: 'No values yet. Add one, then drag across the plate.' }));
    return;
  }
  for (const v of list) {
    const n = [...map.values()].filter(x => x === v).length;
    const b = el('button', { class: 'value' });
    b.type = 'button';
    b.setAttribute('aria-pressed', String(v === state.activeValue));
    b.append(el('span', { class: 'swatch', style: `background:${colourOf(field, v)}` }),
             el('span', { class: 'value-name', textContent: v }),
             el('span', { class: 'value-count', textContent: n }));
    b.onclick = () => { state.activeValue = v; renderValues(); };
    box.append(b);
  }
}

$('#btnAddField').onclick = () => {
  if (!state.loaded) { toast('Load a workbook before editing the plate.'); return; }
  const name = prompt('Name the field (it becomes a column in the results):');
  if (!name) return;
  const key = name.trim();
  if (key === 'well_position') {
    toast('“well_position” is reserved for the workbook well address.', { tone: 'error' });
    return;
  }
  if (!key || state.fields.has(key)) { toast(`“${key}” is already a field`, { tone: 'error' }); return; }
  const before = snapshotAll();
  state.fields.set(key, new Map());
  state.values.set(key, []);
  state.activeField = key;
  state.activeValue = null;
  pushUndo(before, `Added the field “${key}”`);
  renderAll();
};

$('#btnAddValue').onclick = () => {
  if (!state.loaded || !state.activeField) {
    toast('Load a workbook before editing the plate.');
    return;
  }
  const field = state.activeField;
  const name = prompt(`New value for “${field}”:`);
  if (!name) return;
  const v = name.trim();
  const list = state.values.get(field);
  if (!v || list.includes(v)) { toast(`“${v}” is already there`, { tone: 'error' }); return; }
  const before = snapshotAll();
  list.push(v);
  state.activeValue = v;
  pushUndo(before, `Added “${v}”`);
  renderAll();
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
  document.addEventListener('keydown', e => { if (e.key === 'Escape') stop(); });

  function doClear() {
    const before = snapshotAll();
    for (const m of state.fields.values()) m.clear();
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

  const assay = $('#selAssay').value;
  const assayValues = state.values.get(assay) || [];
  fillSelect($('#selDctA'), ['(none)', ...assayValues], state.dctA ?? '(none)');
  fillSelect($('#selDctB'), ['(none)', ...assayValues], state.dctB ?? '(none)');
}

function fillSelect(sel, options, chosen) {
  sel.replaceChildren(...options.map(o => new Option(o, o)));
  if (options.includes(chosen)) sel.value = chosen;
}

$('#selAssay').onchange = e => { state.assayCol = e.target.value; syncSelects(); };
$('#selQuantity').onchange = e => { state.quantityCol = e.target.value; };
$('#selGroup').onchange = e =>
  { state.groupCols = [...e.target.selectedOptions].map(o => o.value); };
$('#selDctA').onchange = e => { state.dctA = e.target.value; };
$('#selDctB').onchange = e => { state.dctB = e.target.value; };

$$('.seg-btn').forEach(b => {
  b.onclick = () => {
    state.format = Number(b.dataset.format);
    renderAll();
    setStatus(`Showing a ${state.format}-well layout.`);
  };
});

/* ----------------------------------------------------------------- run */
$('#btnRun').onclick = () => {
  const btn = $('#btnRun');
  void withPending(
    btn, $('#runLabel'), $('#runSpin'), 'Running', 'Run again', runAnalysis,
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

  const options = {
    ntc_margin: Number($('#optNtc').value),
    sd_max: Number($('#optSd').value),
    ct_min: Number($('#optCtMin').value),
  };
  for (const [key, value] of Object.entries(options)) {
    if (!Number.isFinite(value) || value < 0) {
      const label = key.replaceAll('_', ' ');
      throw new Error(`${label} must be a non-negative number.`);
    }
  }

  const body = {
    fields,
    assay_col: $('#selAssay').value,
    group_cols: [...$('#selGroup').selectedOptions].map(o => o.value),
    quantity_col: $('#selQuantity').value === '(none)' ? null : $('#selQuantity').value,
    dct: dctA !== '(none)' && dctB !== '(none)' ? [dctA, dctB] : null,
    options,
  };

  clearResults();
  paintAll();
  showSkeleton();
  const d = await localBackend.analyze(body);

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
}

/* ------------------------------------------------------------- results */
function showSkeleton() {
  const body = $('#resultBody');
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
    b.setAttribute('aria-selected', String(k === state.activeResultTab));
    b.onclick = () => { state.activeResultTab = k; renderResults(); };
    tabs.append(b);
  }

  const body = $('#resultBody');
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
      const toolbar = el('div', {
        class: 'plots-toolbar',
        textContent: 'PNG images generated locally in this browser.',
      });
      toolbar.append(downloadAll);
      wrap.append(toolbar);
    }

    for (const [name, src] of plotEntries) {
      const meta = plotMeta(name);
      const heading = el('span', { class: 'plot-name', textContent: meta.label });
      const download = el('button', {
        class: 'btn plot-download',
        textContent: 'Download PNG',
      });
      download.type = 'button';
      download.setAttribute('aria-label', `Download ${meta.label.toLowerCase()} as PNG`);
      download.onclick = () => {
        const blob = state.plotBlobs.get(name);
        if (!blob) {
          toast('That curve image is no longer available. Run the analysis again.', {
            tone: 'error',
          });
          return;
        }
        downloadBlob(
          blob,
          downloadName(state.filename, `_${meta.suffix}`, 'png'),
        );
      };
      const caption = el('figcaption', { class: 'plot-head' });
      caption.append(heading, download);
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
  } else {
    body.append(table(d.tables[state.activeResultTab]));
  }
}

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
  return t;
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

function renderAll() {
  $$('.seg-btn').forEach(b =>
    b.setAttribute('aria-pressed', String(Number(b.dataset.format) === state.format)));
  renderFields();
  renderPlate();
  syncSelects();
  if (state.results) renderResults();
}

window.addEventListener('beforeunload', releasePlotUrls);

reserveWidth($('#btnRun'));
reserveWidth($('#btnDownload'));
void prepareRuntime();
