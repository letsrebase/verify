// The main-thread side of src/pipeline-worker.mjs: one worker for the whole wizard, one promise
// per task, progress passed to the caller as it arrives. Nothing here blocks, so the spinner
// the wizard shows keeps moving for as long as the worker computes.
import { Worker } from "node:worker_threads";

const WORKER_URL = new URL("./pipeline-worker.mjs", import.meta.url);

/**
 * @param {{ claudeRoot: string, sources: object, out: string, tz: string, top: string|null, language: string, outDir: string, cmd: string }} data
 */
export function startPipeline(data, { workerUrl = WORKER_URL } = {}) {
  const worker = new Worker(workerUrl, { workerData: data });
  const pending = new Map();
  let seq = 0;
  let stopped = null;

  const settle = (id, how, value) => {
    const p = pending.get(id);
    if (!p) return;
    pending.delete(id);
    p[how](value);
  };
  const stop = (error) => {
    stopped ??= error;
    for (const id of [...pending.keys()]) settle(id, "reject", stopped);
  };

  worker.on("message", (m) => {
    if ("progress" in m) pending.get(m.id)?.onProgress?.(m.progress);
    else if (m.error) settle(m.id, "reject", Object.assign(new Error(m.error.message), { name: m.error.name }));
    else settle(m.id, "resolve", m.ok);
  });
  worker.on("error", (e) => stop(e));
  worker.on("exit", (code) => stop(new Error(`the log reader stopped unexpectedly (exit code ${code})`)));

  const call = (task, args, onProgress) =>
    new Promise((resolve, reject) => {
      if (stopped) return reject(stopped);
      const id = ++seq;
      pending.set(id, { resolve, reject, onProgress });
      worker.postMessage({ id, task, args });
    });

  return {
    /** Reads one source; resolves with `{ sessions }` (null when it is turned off). `onProgress({ done, total })` as files are read. */
    read: (id, { onProgress } = {}) => call("read", { id }, onProgress),
    /** Derives the profile inputs from the sources read; resolves with what the agent is given. `onStep(label)`. */
    prepare: (ids, { onStep } = {}) => call("prepare", { ids }, (p) => p.step && onStep?.(p.step)),
    /** Merges the agent's answers, assembles and saves the profile; resolves with the numbers to show. */
    finish: (run, { onStep } = {}) => call("finish", { run }, (p) => p.step && onStep?.(p.step)),
    /** submit's check of the profile against the logs as they are now. `onStep(label)`, `onProgress({ source, done, total })`. */
    preflight: (profile, { onStep, onProgress } = {}) =>
      call("preflight", { profile }, (p) => (p.step ? onStep?.(p.step) : onProgress?.(p))),
    close: () => worker.terminate(),
  };
}
