// The wizard's heavy work, in a worker thread: reading the logs of each harness, deriving the
// profile inputs, assembling the profile and the pre-flight against the logs take seconds of
// synchronous CPU and file reads each. On the main thread they stop @clack's spinner (it
// animates on a timer), so they run here and the main thread only paints.
//
// The worker holds the parsed logs between tasks (they are large and never leave it); a task
// answers with small, cloneable values. Driven by src/pipeline-client.mjs; the tasks are the
// functions of src/pipeline.mjs, so the sub-commands and the wizard compute the same thing.
import { parentPort, workerData } from "node:worker_threads";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { readSource, combineSources } from "./sources.mjs";
import { narrativeInputFor } from "./profile-llm.mjs";
import {
  applyAgentRun, assembleWithGroundedness, checkAgainstLogs, deriveInputs, ensureOutDir,
  narrativeOptionsOf, profileSummary, saveProfile, writePracticesInput,
} from "./pipeline.mjs";

const { claudeRoot, sources, out, tz, top, language, outDir, cmd } = workerData;
const ctx = { tz, top, language, outDir, cmd };

const PROGRESS_EVERY_MS = 100;
const state = { bundles: new Map(), inputs: null };

// A task's progress goes out at most every PROGRESS_EVERY_MS, so a loop over thousands of files
// does not flood the main thread.
function reporter(id) {
  let last = -Infinity;
  const post = (progress) => parentPort.postMessage({ id, progress });
  return {
    step: (label) => post({ step: label }),
    onProgress: (p) => {
      const t = performance.now();
      if (t - last < PROGRESS_EVERY_MS) return;
      last = t;
      post(p);
    },
  };
}

const EMPTY_CLAUDE = { source: "claude-code", files: [], sessions: [], compactionSummaries: [], redaction: { hits: 0, charsRemoved: 0 } };

const tasks = {
  read({ id }, { onProgress }) {
    const bundle = id === "claude-code" && !existsSync(claudeRoot) ? EMPTY_CLAUDE : readSource(id, { claudeRoot, sources, onProgress });
    if (!bundle) return null;
    state.bundles.set(id, bundle);
    return { sessions: bundle.sessions.length };
  },

  prepare({ ids }, { step }) {
    step("Merging the sources");
    const parsed = combineSources(ids.map((id) => state.bundles.get(id)));
    ensureOutDir(out);
    rmSync(join(out, "agent-log.jsonl"), { force: true });
    const inputs = deriveInputs(parsed, out, { ...ctx, step });
    writePracticesInput(out, parsed, ctx);
    state.inputs = inputs;
    const inputFile = join(out, "practices-input.json");
    return {
      narrativeInput: narrativeInputFor(inputs.selected, inputs.enrichments, narrativeOptionsOf(inputs, language)),
      practicesInput: existsSync(inputFile) ? JSON.parse(readFileSync(inputFile, "utf8")) : null,
    };
  },

  finish({ run }, { step }) {
    const inputs = state.inputs;
    if (!inputs) throw new Error("the profile inputs are not ready");
    step("Merging the practices");
    const { practices, narrative, generatedBy } = applyAgentRun(out, inputs.practices, run, ctx);
    step("Checking the prose against the data");
    const profile = assembleWithGroundedness(
      { ...inputs, narrative, practices, generatedBy, manifestHash: inputs.fingerprint.manifest.bundleHash },
      { language },
    );
    step("Saving the profile");
    saveProfile(out, profile);
    // Nothing reads the parsed logs again from here, and the pre-flight reads them afresh.
    state.bundles.clear();
    state.inputs = null;
    return profileSummary(profile);
  },

  preflight({ profile }, { step, onProgress }) {
    return checkAgainstLogs(profile, { claudeRoot, sources, step, onProgress });
  },
};

parentPort.on("message", ({ id, task, args }) => {
  try {
    parentPort.postMessage({ id, ok: tasks[task](args, reporter(id)) ?? null });
  } catch (e) {
    parentPort.postMessage({ id, error: { name: e?.name ?? "Error", message: e?.message ?? String(e) } });
  }
});
