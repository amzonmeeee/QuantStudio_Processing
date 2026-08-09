const PROTOCOL = 1;
const PYODIDE_VERSION = '314.0.3';
const PYODIDE_MODULE =
  `https://cdn.jsdelivr.net/pyodide/v${PYODIDE_VERSION}/full/pyodide.mjs`;
const INPUT_PATH = '/work/input.xlsx';

const APP_MODULES = [
  '__init__.py',
  'analysis.py',
  'browser.py',
  'io.py',
  'platemap.py',
  'plot.py',
  'webcore.py',
];

let pyodide = null;
let browserApi = null;
let runtimePromise = null;
let plottingPromise = null;
let queue = Promise.resolve();

class UserFacingError extends Error {}

function status(phase, message, state = 'loading') {
  self.postMessage({
    protocol: PROTOCOL,
    type: 'status',
    status: { phase, message, state },
  });
}

function packageProgress(message) {
  console.debug(`[Pyodide] ${message}`);
}

async function installApplication(runtime) {
  const packageRoot = '/app/quantstudio_processing';
  runtime.FS.mkdirTree(packageRoot);
  await Promise.all(APP_MODULES.map(async filename => {
    const url = new URL(`./python/quantstudio_processing/${filename}`, self.location.href);
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) {
      throw new Error(`Could not load ${filename} (${response.status}).`);
    }
    runtime.FS.writeFile(`${packageRoot}/${filename}`, await response.text());
  }));
  runtime.runPython("import sys; sys.path.insert(0, '/app') if '/app' not in sys.path else None");
}

async function ensureRuntime() {
  if (browserApi) return;
  if (!runtimePromise) {
    runtimePromise = (async () => {
      status('runtime', 'Downloading the local Python runtime…');
      const { loadPyodide } = await import(PYODIDE_MODULE);
      const runtime = await loadPyodide();

      status('packages', 'Loading the workbook analysis packages…');
      await runtime.loadPackage(['numpy', 'pandas', 'pyyaml', 'micropip'], {
        messageCallback: packageProgress,
        errorCallback: message => console.warn(`[Pyodide] ${message}`),
      });

      status('packages', 'Installing the Excel reader…');
      const micropip = runtime.pyimport('micropip');
      try {
        await micropip.install('openpyxl==3.1.5');
      } finally {
        micropip.destroy();
      }

      status('application', 'Loading QuantStudio Processing…');
      await installApplication(runtime);
      runtime.FS.mkdirTree('/work');
      pyodide = runtime;
      browserApi = runtime.pyimport('quantstudio_processing.browser');
      status('ready', 'Local analyzer ready. Your workbook never leaves this browser.', 'ready');
    })();
  }

  try {
    await runtimePromise;
  } catch (error) {
    runtimePromise = null;
    pyodide = null;
    browserApi = null;
    status('runtime', 'Could not start the local analyzer. Check the connection and retry.', 'error');
    throw error;
  }
}

async function ensurePlotting() {
  if (plottingPromise) return plottingPromise;
  plottingPromise = (async () => {
    status('packages', 'Loading the plotting engine for the first analysis…');
    await pyodide.loadPackage('matplotlib', {
      messageCallback: packageProgress,
      errorCallback: message => console.warn(`[Pyodide] ${message}`),
    });
  })();
  try {
    await plottingPromise;
  } catch (error) {
    plottingPromise = null;
    throw error;
  }
}

function unwrapEnvelope(text) {
  const envelope = JSON.parse(text);
  if (!envelope.ok) throw new UserFacingError(envelope.error || 'The operation failed.');
  return envelope.data;
}

function copyPythonBytes(proxy) {
  try {
    return Uint8Array.from(proxy.toJs());
  } finally {
    proxy.destroy();
  }
}

function removeInput() {
  if (pyodide.FS.analyzePath(INPUT_PATH).exists) pyodide.FS.unlink(INPUT_PATH);
}

function conciseError(error) {
  if (error instanceof UserFacingError) return error.message;
  const lines = String(error?.message || error).trim().split('\n').filter(Boolean);
  const last = lines.at(-1) || 'Local analysis failed.';
  return last.replace(/^(?:[\w.]+)?(?:Error|Exception):\s*/, '');
}

async function perform(message) {
  const { id, revision, op, payload } = message;
  const transfer = [];
  try {
    await ensureRuntime();
    let value = null;

    if (op === 'prepare') {
      value = { version: PYODIDE_VERSION };
    } else if (op === 'load') {
      status('workbook', 'Reading the workbook in this browser…');
      removeInput();
      pyodide.FS.writeFile(INPUT_PATH, new Uint8Array(payload.bytes));
      try {
        value = unwrapEnvelope(browserApi.load_path(INPUT_PATH, payload.name));
      } finally {
        removeInput();
      }
      status('ready', 'Workbook loaded locally.', 'ready');
    } else if (op === 'analyze') {
      if (!payload.skip_plots) await ensurePlotting();
      status('analysis', 'Running QC, summaries and plots locally…');
      value = unwrapEnvelope(browserApi.analyze_json(JSON.stringify(payload)));
      for (const name of Object.keys(value.plots || {})) {
        const bytes = copyPythonBytes(browserApi.take_plot(name));
        value.plots[name] = bytes.buffer;
        transfer.push(bytes.buffer);
      }
      status('ready', 'Analysis complete.', 'ready');
    } else if (op === 'workbook') {
      status('export', 'Building the processed workbook locally…');
      const bytes = copyPythonBytes(browserApi.workbook_bytes());
      value = bytes.buffer;
      transfer.push(bytes.buffer);
      status('ready', 'Workbook ready to download.', 'ready');
    } else if (op === 'platemap-yaml') {
      value = unwrapEnvelope(browserApi.platemap_yaml_json(JSON.stringify(payload)));
    } else if (op === 'reset') {
      removeInput();
      browserApi.reset();
      value = true;
    } else {
      throw new Error(`Unknown worker operation: ${op}`);
    }

    self.postMessage(
      { protocol: PROTOCOL, id, revision, type: 'result', value },
      transfer,
    );
  } catch (error) {
    const detail = error?.stack || String(error);
    if (browserApi) {
      status('ready', 'Local analyzer ready for another operation.', 'ready');
    }
    self.postMessage({
      protocol: PROTOCOL,
      id,
      revision,
      type: 'error',
      error: {
        message: conciseError(error),
        detail,
        recoverable: true,
      },
    });
  }
}

self.addEventListener('message', event => {
  if (event.data?.protocol !== PROTOCOL) return;
  queue = queue.then(() => perform(event.data), () => perform(event.data));
});
