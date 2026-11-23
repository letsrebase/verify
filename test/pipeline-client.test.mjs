// The wizard's worker: the steps run off the main thread, give back small answers, report their
// progress, and fail with the worker's own message.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { startPipeline } from "../src/pipeline-client.mjs";

const OFF = Object.fromEntries(["opencode", "codex", "pi", "omp", "cursor", "kimi"].map((id) => [id, { disabled: true }]));

// A tree of Claude Code logs: `files` sessions of `turns` exchanges each.
function logs(tmp, files, turns) {
  const root = join(tmp, "projects");
  const proj = join(root, "-tmp-demo");
  mkdirSync(proj, { recursive: true });
  const cwd = join(tmp, "demo");
  for (let f = 0; f < files; f++) {
    const lines = [];
    for (let t = 0; t < turns; t++) {
      const ts = (m) => `2026-05-01T10:${String(m % 60).padStart(2, "0")}:00.000Z`;
      lines.push({ type: "user", sessionId: `s${f}`, cwd, timestamp: ts(t), uuid: `u${f}-${t}`, version: "1.0.0", message: { role: "user", content: `let's build the agent route and the api, step ${t}` } });
      lines.push({ type: "assistant", sessionId: `s${f}`, cwd, timestamp: ts(t), uuid: `a${f}-${t}`, parentUuid: `u${f}-${t}`, version: "1.0.0", message: { role: "assistant", model: "claude-x", content: [{ type: "text", text: "ok ".repeat(200) }] } });
    }
    writeFileSync(join(proj, `s${f}.jsonl`), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  }
  return root;
}

const start = (tmp, claudeRoot, over = {}) =>
  startPipeline({ claudeRoot, sources: OFF, out: join(tmp, "out"), tz: "UTC", top: null, language: "en", outDir: "out", cmd: "rebase-verify", ...over });

test("read answers with the session count and reports the files read", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-"));
  const work = start(tmp, logs(tmp, 6, 3));
  try {
    const seen = [];
    assert.deepEqual(await work.read("claude-code", { onProgress: (p) => seen.push(p) }), { sessions: 6 });
    assert.deepEqual(seen[0], { done: 0, total: 6 });
    assert.equal(await work.read("codex"), null, "a source that is turned off reads as null");
  } finally {
    await work.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a missing Claude Code folder reads as no sessions", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-"));
  const work = start(tmp, join(tmp, "nowhere"));
  try {
    assert.deepEqual(await work.read("claude-code"), { sessions: 0 });
  } finally {
    await work.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("the main thread keeps running while the logs are read", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-"));
  const work = start(tmp, logs(tmp, 80, 60));
  try {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 5);
    await work.read("claude-code");
    clearInterval(timer);
    assert.ok(ticks >= 3, `the timer fired ${ticks} times during the read`);
  } finally {
    await work.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("prepare, finish and preflight run in order and leave the profile in out/", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-"));
  const root = logs(tmp, 3, 4);
  const work = start(tmp, root);
  try {
    await assert.rejects(work.finish({ narrative: null, practicesAnswers: null, used: { agent: "x", model: null } }), /not ready/);
    await work.read("claude-code");
    const steps = [];
    const prepared = await work.prepare(["claude-code"], { onStep: (m) => steps.push(m) });
    assert.ok(prepared.narrativeInput && typeof prepared.narrativeInput === "object");
    assert.ok(steps.includes("Fingerprinting the logs") && steps.includes("Counting the work practices"), steps.join("|"));
    assert.equal(readFileSync(join(tmp, "out", ".gitignore"), "utf8"), "*\n");

    const finished = await work.finish({ narrative: null, practicesAnswers: null, used: { agent: "x", model: null } });
    assert.equal(finished.sessions, 3);
    assert.ok(existsSync(join(tmp, "out", "candidate.json")) && existsSync(join(tmp, "out", "profile.md")));

    const profile = JSON.parse(readFileSync(join(tmp, "out", "candidate.json"), "utf8"));
    const progress = [];
    const check = await work.preflight(profile, { onStep: () => {}, onProgress: (p) => progress.push(p) });
    assert.deepEqual(check.issues, [], "a profile checked against the logs it came from has no issues");
    assert.equal(check.excessClaims, 0);
    assert.ok(Array.isArray(check.warnings));
    assert.equal(progress[0]?.source, "claude-code");
  } finally {
    await work.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("answers that cannot be merged reject with the reason and keep the worker's error name", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-"));
  const work = start(tmp, logs(tmp, 3, 4));
  try {
    await work.read("claude-code");
    await work.prepare(["claude-code"]);
    const e = await work.finish({ narrative: null, practicesAnswers: { nonsense: true }, used: { agent: "x", model: null } }).then(() => null, (err) => err);
    assert.equal(e?.name, "PracticesAnswersError");
    assert.match(e.message, /Fix it, or delete out\/practices\.json/);
  } finally {
    await work.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("a worker that dies rejects what is waiting on it and everything after", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "pc-"));
  const dying = join(tmp, "dying.mjs");
  writeFileSync(dying, `import { parentPort } from "node:worker_threads"; parentPort.on("message", () => process.exit(3));`);
  const work = startPipeline({}, { workerUrl: pathToFileURL(dying) });
  try {
    await assert.rejects(work.read("claude-code"), /stopped unexpectedly/);
    await assert.rejects(work.read("claude-code"), /stopped unexpectedly/);
  } finally {
    await work.close();
    rmSync(tmp, { recursive: true, force: true });
  }
});
