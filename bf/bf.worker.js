'use strict';

// Runs bf.wasm (a Doxa Brainfuck interpreter compiled to wasm32-wasi) under a
// minimal WASI preview1 shim. The main thread owns the timeout: because wasm
// executes synchronously, a runaway program cannot be interrupted from inside
// this worker, so the page terminates the worker instead.

const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;
const ERRNO_INVAL = 28;
const ERRNO_NOSYS = 52;
const ERRNO_SPIPE = 70;

const FILETYPE_CHARACTER_DEVICE = 2;

const RIGHT_FD_READ = 1n << 1n;
const RIGHT_FD_WRITE = 1n << 6n;

const IOVEC_SIZE = 8;
const FILESTAT_SIZE = 64;
const SUBSCRIPTION_SIZE = 48;
const EVENT_SIZE = 48;

class WasiExit {
  constructor(code) {
    this.code = code | 0;
  }
}

let modulePromise = null;

function loadModule() {
  if (modulePromise === null) {
    const url = new URL('bf.wasm', self.location.href);
    modulePromise = fetch(url).then((response) => {
      if (!response.ok) {
        throw new Error('failed to fetch bf.wasm (HTTP ' + response.status + ')');
      }
      return response.arrayBuffer();
    }).then((buffer) => WebAssembly.compile(buffer));
  }
  return modulePromise;
}

function concatChunks(chunks) {
  let total = 0;
  for (const chunk of chunks) total += chunk.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

function createWasi(module, source, stdinBytes) {
  const encoder = new TextEncoder();
  const args = [encoder.encode('bf'), encoder.encode(source)];

  let memory = null;
  let stdinPos = 0;
  const stdoutChunks = [];
  const stderrChunks = [];

  const bytes = () => new Uint8Array(memory.buffer);
  const view = () => new DataView(memory.buffer);

  function argsSizesGet(argcPtr, argvBufSizePtr) {
    const d = view();
    d.setUint32(argcPtr, args.length, true);
    let size = 0;
    for (const arg of args) size += arg.length + 1;
    d.setUint32(argvBufSizePtr, size, true);
    return ERRNO_SUCCESS;
  }

  function argsGet(argvPtr, argvBufPtr) {
    const d = view();
    const v = bytes();
    let cursor = argvBufPtr;
    for (let i = 0; i < args.length; i++) {
      d.setUint32(argvPtr + i * 4, cursor, true);
      v.set(args[i], cursor);
      v[cursor + args[i].length] = 0;
      cursor += args[i].length + 1;
    }
    return ERRNO_SUCCESS;
  }

  function readInto(iovs, iovsLen, nreadPtr) {
    const d = view();
    const v = bytes();
    let nread = 0;
    for (let i = 0; i < iovsLen; i++) {
      const ptr = d.getUint32(iovs + i * IOVEC_SIZE, true);
      const len = d.getUint32(iovs + i * IOVEC_SIZE + 4, true);
      const available = stdinBytes.length - stdinPos;
      const n = available <= 0 ? 0 : Math.min(len, available);
      if (n > 0) v.set(stdinBytes.subarray(stdinPos, stdinPos + n), ptr);
      stdinPos += n;
      nread += n;
      if (n < len) break;
    }
    d.setUint32(nreadPtr, nread, true);
    return ERRNO_SUCCESS;
  }

  function fdWrite(fd, iovs, iovsLen, nwrittenPtr) {
    const d = view();
    const v = bytes();
    const chunks = [];
    let written = 0;
    for (let i = 0; i < iovsLen; i++) {
      const ptr = d.getUint32(iovs + i * IOVEC_SIZE, true);
      const len = d.getUint32(iovs + i * IOVEC_SIZE + 4, true);
      chunks.push(v.slice(ptr, ptr + len));
      written += len;
    }
    const data = concatChunks(chunks);
    if (fd === 2) stderrChunks.push(data);
    else stdoutChunks.push(data);
    d.setUint32(nwrittenPtr, written, true);
    return ERRNO_SUCCESS;
  }

  function fdFdstatGet(fd, bufPtr) {
    const d = view();
    d.setUint8(bufPtr, FILETYPE_CHARACTER_DEVICE);
    d.setUint16(bufPtr + 2, 0, true);
    let rights = 0n;
    if (fd === 0) rights = RIGHT_FD_READ;
    else if (fd === 1 || fd === 2) rights = RIGHT_FD_WRITE;
    d.setBigUint64(bufPtr + 8, rights, true);
    d.setBigUint64(bufPtr + 16, 0n, true);
    return ERRNO_SUCCESS;
  }

  function fdFilestatGet(fd, bufPtr) {
    const v = bytes();
    v.fill(0, bufPtr, bufPtr + FILESTAT_SIZE);
    v[bufPtr + 16] = FILETYPE_CHARACTER_DEVICE;
    return ERRNO_SUCCESS;
  }

  // No real descriptors are open, so seeking stdio is not supported.
  function fdSeek(fd, offset, whence, newOffsetPtr) {
    return ERRNO_SPIPE;
  }

  function clockResGet(id, resolutionPtr) {
    view().setBigUint64(resolutionPtr, 1000000n, true);
    return ERRNO_SUCCESS;
  }

  function clockTimeGet(id, precision, timePtr) {
    view().setBigUint64(timePtr, BigInt(Date.now()) * 1000000n, true);
    return ERRNO_SUCCESS;
  }

  // The runtime may probe preopens by walking file descriptors from 3 upward;
  // EBADF is the sentinel that says "no more preopens".
  function fdPrestatGet(fd, prestatPtr) {
    return ERRNO_BADF;
  }

  // Clock subscriptions are reported ready immediately; I/O subscriptions are
  // unsupported. The interpreter does not block on poll today.
  function pollOneoff(inPtr, outPtr, nsubscriptions, neventsPtr) {
    if (nsubscriptions === 0) return ERRNO_INVAL;
    const d = view();
    for (let i = 0; i < nsubscriptions; i++) {
      const sub = inPtr + i * SUBSCRIPTION_SIZE;
      const ev = outPtr + i * EVENT_SIZE;
      const userdata = d.getBigUint64(sub, true);
      const type = d.getUint8(sub + 8);
      d.setBigUint64(ev, userdata, true);
      d.setUint8(ev + 10, type);
      if (type === 0) {
        const clockId = d.getUint32(sub + 16, true);
        d.setUint16(ev + 8, ERRNO_SUCCESS, true);
        d.setUint32(ev + 16, clockId, true);
        d.setBigUint64(ev + 24, 0n, true);
      } else {
        d.setUint16(ev + 8, ERRNO_NOSYS, true);
      }
    }
    d.setUint32(neventsPtr, nsubscriptions, true);
    return ERRNO_SUCCESS;
  }

  function randomGet(bufPtr, len) {
    crypto.getRandomValues(bytes().subarray(bufPtr, bufPtr + len));
    return ERRNO_SUCCESS;
  }

  function procExit(code) {
    throw new WasiExit(code);
  }

  const handlers = {
    args_sizes_get: argsSizesGet,
    args_get: argsGet,
    environ_sizes_get: (countPtr, sizePtr) => {
      const d = view();
      d.setUint32(countPtr, 0, true);
      d.setUint32(sizePtr, 0, true);
      return ERRNO_SUCCESS;
    },
    environ_get: () => ERRNO_SUCCESS,
    fd_write: fdWrite,
    fd_read: (fd, iovs, iovsLen, nreadPtr) => readInto(iovs, iovsLen, nreadPtr),
    fd_pread: (fd, iovs, iovsLen, offset, nreadPtr) => readInto(iovs, iovsLen, nreadPtr),
    fd_close: () => ERRNO_SUCCESS,
    fd_seek: fdSeek,
    fd_fdstat_get: fdFdstatGet,
    fd_filestat_get: fdFilestatGet,
    fd_filestat_set_size: () => ERRNO_SUCCESS,
    fd_filestat_set_times: () => ERRNO_SUCCESS,
    fd_prestat_get: fdPrestatGet,
    fd_prestat_dir_name: () => ERRNO_BADF,
    clock_res_get: clockResGet,
    clock_time_get: clockTimeGet,
    random_get: randomGet,
    poll_oneoff: pollOneoff,
    proc_exit: procExit,
  };

  const importObject = {};
  for (const entry of WebAssembly.Module.imports(module)) {
    if (entry.kind !== 'function') continue;
    let namespace = importObject[entry.module];
    if (!namespace) {
      namespace = importObject[entry.module] = {};
    }
    namespace[entry.name] = handlers[entry.name] || (() => ERRNO_NOSYS);
  }

  return {
    importObject,
    attach(instanceMemory) {
      memory = instanceMemory;
    },
    stdout() {
      return concatChunks(stdoutChunks);
    },
    stderr() {
      return concatChunks(stderrChunks);
    },
  };
}

// One full interpreter run: a fresh instance so stdin and the tape start clean.
// Only _start() is timed, so module loading and instantiation do not inflate the
// result.
async function executeOnce(module, source, input) {
  const wasi = createWasi(module, source, input);
  const instance = await WebAssembly.instantiate(module, wasi.importObject);
  wasi.attach(instance.exports.memory);

  let exitCode = 0;
  const startedAt = performance.now();
  try {
    instance.exports._start();
  } catch (error) {
    if (error instanceof WasiExit) {
      exitCode = error.code;
    } else {
      throw error;
    }
  }
  const durationMs = performance.now() - startedAt;

  return { exitCode, stdout: wasi.stdout(), stderr: wasi.stderr(), durationMs };
}

// Clock resolution (often 100µs, sometimes 1ms) makes single tiny runs report 0
// or 1 ms. When a successful run is very short we repeat it and average, which
// recovers sub-resolution precision. The work budget is kept small so it stays
// well under the smallest configurable timeout (50 ms).
const BENCH_TARGET_MS = 20;
const BENCH_TRIGGER_MS = 5;
const BENCH_MAX_ITERATIONS = 1000;
const BENCH_MAX_ELAPSED_MS = 100;

async function run(payload) {
  const source = typeof payload.source === 'string' ? payload.source : '';
  const input = new TextEncoder().encode(
    typeof payload.input === 'string' ? payload.input : ''
  );

  const module = await loadModule();
  const first = await executeOnce(module, source, input);

  let durationMs = first.durationMs;
  let iterations = 1;

  if (first.exitCode === 0 && first.durationMs < BENCH_TRIGGER_MS) {
    let total = first.durationMs;
    const benchStart = performance.now();
    while (
      iterations < BENCH_MAX_ITERATIONS &&
      total < BENCH_TARGET_MS &&
      performance.now() - benchStart < BENCH_MAX_ELAPSED_MS
    ) {
      const next = await executeOnce(module, source, input);
      if (next.exitCode !== 0) break;
      total += next.durationMs;
      iterations += 1;
    }
    durationMs = total / iterations;
  }

  self.postMessage({
    type: 'result',
    stdout: first.stdout,
    stderr: first.stderr,
    exitCode: first.exitCode,
    durationMs,
    iterations,
  }, [first.stdout.buffer, first.stderr.buffer]);
}

let running = false;

self.onmessage = (event) => {
  const message = event.data || {};
  if (message.type !== 'run') return;
  if (running) {
    self.postMessage({ type: 'error', message: 'a program is already running' });
    return;
  }
  running = true;
  run(message).then(
    () => {
      running = false;
    },
    (error) => {
      running = false;
      self.postMessage({
        type: 'error',
        message: error && error.message ? error.message : String(error),
      });
    }
  );
};
