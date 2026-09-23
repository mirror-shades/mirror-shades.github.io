'use strict';

(function () {
  const sourceEl = document.getElementById('source');
  const inputEl = document.getElementById('programInput');
  const runEl = document.getElementById('run');
  const timeoutEl = document.getElementById('timeout');
  const stdoutEl = document.getElementById('stdout');
  const stderrEl = document.getElementById('stderr');
  const stderrWrapEl = document.getElementById('stderr-wrap');
  const statusEl = document.getElementById('status');
  const errorEl = document.getElementById('error');
  const doxaSourceEl = document.getElementById('doxaSource');
  const sampleButtons = document.querySelectorAll('[data-sample]');

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const DEFAULT_TIMEOUT_MS = 5000;

  const SAMPLES = {
    hello: {
      source: '++++++++++[>+++++++>++++++++++>+++>+<<<<-]>++.>+.+++++++..+++.>++.<<+++++++++++++++.>.+++.------.--------.>+.>.',
      input: '',
    },
    echo: {
      source: ',[.,]',
      input: 'Hello, Brainfuck!',
    },
    shift: {
      source: ',[+.,]',
      input: 'abc',
    },
  };

  let worker = null;
  let timer = 0;
  let running = false;

  const embeddedSource = document.getElementById('bfDoxaSource');
  if (embeddedSource && doxaSourceEl) {
    doxaSourceEl.textContent = embeddedSource.textContent.replace(/^\n/, '');
  }

  function setStatus(text, kind) {
    statusEl.textContent = text;
    statusEl.className = kind || '';
  }

  function formatDuration(ms) {
    if (ms > 0 && ms < 0.01) return '<0.01 ms';
    if (ms < 10) return (Math.round(ms * 100) / 100) + ' ms';
    return Math.round(ms) + ' ms';
  }

  function showError(message) {
    errorEl.textContent = message;
    errorEl.hidden = false;
  }

  function clearError() {
    errorEl.textContent = '';
    errorEl.hidden = true;
  }

  function clearPanes() {
    stdoutEl.textContent = '';
    stderrEl.textContent = '';
    stderrWrapEl.hidden = true;
  }

  function renderBytes(element, bytes) {
    element.textContent = decoder.decode(bytes);
  }

  function describe(source, index) {
    let line = 1;
    let column = 1;
    for (let i = 0; i < index; i++) {
      if (source[i] === '\n') {
        line += 1;
        column = 1;
      } else {
        column += 1;
      }
    }
    return 'line ' + line + ', column ' + column;
  }

  // Returns null when the brackets balance, otherwise a precise location for the
  // first offending bracket. Validating here gives an immediate, readable message
  // instead of the interpreter's terse assertion.
  function findBracketError(source) {
    const stack = [];
    for (let i = 0; i < source.length; i++) {
      const ch = source[i];
      if (ch === '[') {
        stack.push(i);
      } else if (ch === ']') {
        if (stack.length === 0) {
          return "Unmatched ']' at " + describe(source, i) + '.';
        }
        stack.pop();
      }
    }
    if (stack.length > 0) {
      return "Unmatched '[' at " + describe(source, stack[stack.length - 1]) + '.';
    }
    return null;
  }

  function ensureWorker() {
    if (worker !== null) return worker;
    worker = new Worker('bf.worker.js');
    worker.onmessage = handleWorkerMessage;
    worker.onerror = (event) => {
      event.preventDefault();
      finishWithError(event.message || 'worker error');
    };
    return worker;
  }

  function clearTimer() {
    if (timer !== 0) {
      window.clearTimeout(timer);
      timer = 0;
    }
  }

  function finish() {
    clearTimer();
    running = false;
    runEl.disabled = false;
  }

  function handleWorkerMessage(event) {
    const message = event.data || {};
    if (message.type === 'result') {
      finish();
      renderBytes(stdoutEl, message.stdout);
      if (message.stderr.length > 0) {
        renderBytes(stderrEl, message.stderr);
        stderrWrapEl.hidden = false;
      }
      const ms = message.durationMs;
      if (message.exitCode === 0) {
        if (message.stdout.length === 0 && message.stderr.length === 0) {
          stdoutEl.textContent = '(no output)';
        }
        let statusText = 'Finished in ' + formatDuration(ms);
        if (message.iterations > 1) {
          statusText += ' (avg of ' + message.iterations + ' runs)';
        }
        setStatus(statusText, 'ok');
      } else {
        if (message.stdout.length === 0 && message.stderr.length === 0) {
          stdoutEl.textContent = 'Program exited with code ' + message.exitCode + '.';
        }
        setStatus('Failed (exit ' + message.exitCode + ')', 'error');
      }
    } else if (message.type === 'error') {
      finishWithError(message.message);
    }
  }

  function finishWithError(message) {
    finish();
    stderrEl.textContent = message;
    stderrWrapEl.hidden = false;
    setStatus('Runtime error', 'error');
  }

  function run() {
    if (running) return;
    clearError();

    const bracketError = findBracketError(sourceEl.value);
    if (bracketError !== null) {
      clearPanes();
      showError(bracketError + ' Fix the brackets, then run again.');
      setStatus('Unmatched brackets', 'error');
      return;
    }

    running = true;
    runEl.disabled = true;
    clearPanes();
    setStatus('Running…', 'pending');

    const active = ensureWorker();
    const timeoutMs = Math.max(50, Number(timeoutEl.value) || DEFAULT_TIMEOUT_MS);

    timer = window.setTimeout(() => {
      timer = 0;
      if (worker !== null) {
        worker.terminate();
        worker = null;
      }
      running = false;
      runEl.disabled = false;
      stdoutEl.textContent = 'Execution terminated after ' + timeoutMs + ' ms.';
      setStatus('Timed out after ' + timeoutMs + ' ms', 'error');
    }, timeoutMs);

    active.postMessage({
      type: 'run',
      source: sourceEl.value,
      input: inputEl.value,
    });
  }

  function selectSample(name) {
    const sample = SAMPLES[name];
    if (sample === undefined) return;
    sourceEl.value = sample.source;
    inputEl.value = sample.input;
    clearError();
    clearPanes();
    for (const button of sampleButtons) {
      button.setAttribute('aria-pressed', button.dataset.sample === name ? 'true' : 'false');
    }
  }

  for (const button of sampleButtons) {
    button.addEventListener('click', () => selectSample(button.dataset.sample));
  }

  sourceEl.addEventListener('input', () => {
    for (const button of sampleButtons) button.setAttribute('aria-pressed', 'false');
    clearError();
  });

  runEl.addEventListener('click', run);

  for (const el of [sourceEl, inputEl]) {
    el.addEventListener('keydown', (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
        event.preventDefault();
        run();
      }
    });
  }

  window.addEventListener('beforeunload', () => {
    if (worker !== null) worker.terminate();
  });
})();
