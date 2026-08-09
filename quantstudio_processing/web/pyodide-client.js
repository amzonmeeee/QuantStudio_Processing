const PROTOCOL = 1;

let worker = null;
let nextId = 1;
let revision = 0;
const pending = new Map();
const statusListeners = new Set();

export class LocalAnalysisError extends Error {
  constructor(message, { detail = '', recoverable = true } = {}) {
    super(message);
    this.name = 'LocalAnalysisError';
    this.detail = detail;
    this.recoverable = recoverable;
  }
}

function emitStatus(status) {
  for (const listener of statusListeners) listener(status);
}

function rejectPending(error) {
  for (const { reject } of pending.values()) reject(error);
  pending.clear();
}

function discardWorker(message, detail = '') {
  worker?.terminate();
  worker = null;
  const error = new LocalAnalysisError(message, { detail });
  rejectPending(error);
  emitStatus({ phase: 'runtime', state: 'error', message, recoverable: true });
}

function ensureWorker() {
  if (worker) return worker;
  if (!globalThis.Worker || !globalThis.WebAssembly) {
    throw new LocalAnalysisError(
      'This browser cannot run the local Python analysis engine.',
      { recoverable: false },
    );
  }

  worker = new Worker(new URL('./pyodide-worker.js', import.meta.url), { type: 'module' });
  worker.addEventListener('message', event => {
    const message = event.data;
    if (message?.protocol !== PROTOCOL) return;
    if (message.type === 'status') {
      emitStatus(message.status);
      return;
    }

    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);

    if (message.revision !== request.revision) {
      request.reject(new LocalAnalysisError(
        'The local analyzer returned an invalid response revision.',
      ));
      return;
    }
    if (request.op !== 'prepare' && message.revision !== revision) {
      request.reject(new LocalAnalysisError(
        'A newer workbook replaced this result. Run the operation again.',
      ));
      return;
    }

    if (message.type === 'error') {
      if (message.error?.detail) console.error(message.error.detail);
      request.reject(new LocalAnalysisError(
        message.error?.message || 'Local analysis failed.',
        message.error,
      ));
    } else {
      request.resolve(message.value);
    }
  });
  worker.addEventListener('error', event => {
    discardWorker(
      'The local analysis engine stopped. Retry to start a fresh copy.',
      event.message || String(event.error || ''),
    );
  });
  worker.addEventListener('messageerror', () => {
    discardWorker('The browser could not read a response from the analysis engine.');
  });
  return worker;
}

function request(op, payload = {}, transfer = [], requestRevision = revision) {
  let target;
  try {
    target = ensureWorker();
  } catch (error) {
    emitStatus({
      phase: 'runtime', state: 'error', message: error.message,
      recoverable: error.recoverable,
    });
    return Promise.reject(error);
  }
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject, revision: requestRevision, op });
    target.postMessage(
      { protocol: PROTOCOL, id, revision: requestRevision, op, payload },
      transfer,
    );
  });
}

export const localBackend = {
  onStatus(listener) {
    statusListeners.add(listener);
    return () => statusListeners.delete(listener);
  },

  prepare() {
    return request('prepare');
  },

  async load(file) {
    revision += 1;
    const thisRevision = revision;
    const bytes = await file.arrayBuffer();
    return request('load', { name: file.name, bytes }, [bytes], thisRevision);
  },

  analyze(options) {
    return request('analyze', options);
  },

  workbook() {
    return request('workbook');
  },

  curvesZip() {
    return request('curves-zip');
  },

  curvesSvgZip() {
    return request('curves-svg-zip');
  },

  plotSvg(name) {
    return request('plot-svg', { name });
  },

  platemapYaml(options) {
    return request('platemap-yaml', options);
  },

  async reset() {
    revision += 1;
    if (worker) await request('reset', {}, [], revision);
  },

  restart() {
    discardWorker('Restarting the local analysis engine.');
    return this.prepare();
  },
};
