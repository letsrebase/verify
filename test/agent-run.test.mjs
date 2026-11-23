// The narrative and the practices through the person's chosen agent: one ACP
// session for both steps, answers read as the first balanced JSON object,
// cleanup after every run, and `generate --agent` through the real bin.
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { RUN_SYSTEM, runWithAgent } from "../src/agents/run.mjs";
import { AgentAuthError, ModelNotOfferedError, ToolUseError, startAgent } from "../src/agents/acp.mjs";
import { AGENT_RUN_MARKER } from "../src/agent-run.mjs";
import { MODEL, narrativeSystem } from "../src/profile-llm.mjs";
import { PRACTICES_BATCH, practicesPrompt } from "../src/practices-llm.mjs";
import { MODEL_PRACTICE_CANDIDATES, PUBLISHED_MODEL_IDS, RUBRIC } from "../src/practices-rules.mjs";
import { assembleProfile } from "../src/profile.mjs";
import { assessStructure } from "../src/consistency.mjs";
import { computeModelPractices, mergeModelPractices, practicesBlock } from "../src/practices.mjs";

const FAKE = fileURLToPath(new URL("./fixtures/fake-acp-agent.mjs", import.meta.url));
const BIN = fileURLToPath(new URL("../bin/rebase-verify.mjs", import.meta.url));
const ids = MODEL_PRACTICE_CANDIDATES.map((p) => p.id);

const sessions = (n) => Array.from({ length: n }, (_, i) => ({ id: `s${String(i + 1).padStart(2, "0")}`, messages: ["first", "second"] }));
const narrativeInput = { language: "it", domainEvidence: [], projects: [{ id: "p1", type: ["web"] }] };
const practicesInput = (n) => ({ practices: MODEL_PRACTICE_CANDIDATES, sessions: sessions(n) });

// A registry-shaped entry that starts the fake agent; its FAKE_* script comes from process.env.
const fakeEntry = (extra = {}) => ({
  id: "fake-agent",
  label: "Fake agent",
  kind: "acp",
  spec: ({ system } = {}) => ({
    command: process.execPath,
    args: [FAKE],
    env: Object.keys(process.env).filter((k) => k.startsWith("FAKE_")),
    systemPromptVia: "inline",
    system,
  }),
  cleanup: () => [],
  ...extra,
});

async function withEnv(env, fn) {
  const old = {};
  for (const [k, v] of Object.entries(env)) {
    old[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(old)) v === undefined ? delete process.env[k] : (process.env[k] = v);
  }
}

async function run(env, args = {}) {
  const dir = mkdtempSync(join(tmpdir(), "agent-run-test-"));
  const logFile = join(dir, "agent-log.jsonl");
  const promptLog = join(dir, "prompts.jsonl");
  const status = [];
  try {
    return await withEnv({ FAKE_SMART: "1", FAKE_PROMPT_LOG: promptLog, ...env }, async () => {
      let result;
      let error;
      try {
        result = await runWithAgent({ agent: fakeEntry(), narrativeInput, practicesInput: practicesInput(12), onStatus: (s) => status.push(s), logFile, ...args });
      } catch (e) {
        error = e;
      }
      const prompts = existsSync(promptLog) ? readFileSync(promptLog, "utf8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l)) : [];
      const log = existsSync(logFile) ? readFileSync(logFile, "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
      return { result, error, prompts, log, status };
    });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test("one session writes the narrative, then classifies every batch, and names who did it", async () => {
  const { result, error, prompts, log, status } = await run({ FAKE_MODELS: "m1,m2" }, { model: "m2" });
  assert.ifError(error);
  assert.equal(result.narrative.summary, "Builds a web product with an AI agent.");
  assert.deepEqual(result.narrative.projects.map((p) => p.id), ["p1"]);
  assert.equal(Object.keys(result.practicesAnswers).length, 12);
  assert.equal(result.practicesAnswers.s12.limits_scope, true);
  assert.deepEqual(result.used, { agent: "fake-agent", model: "m2" });
  assert.equal(log.filter((l) => l.dir === "out" && l.msg?.method === "initialize").length, 1, "one session for both steps");
  assert.equal(prompts.length, 1 + Math.ceil(12 / PRACTICES_BATCH));
  assert.ok(prompts[0].startsWith(`${RUN_SYSTEM}\n\n${narrativeSystem("it")}`), "the narrative turn opens with the narrative prompt");
  assert.match(prompts[0], /Write every text in Italian/, "the prompt names the language");
  assert.ok(prompts[0].endsWith(JSON.stringify(narrativeInput)));
  assert.ok(prompts[1].startsWith(`${RUN_SYSTEM}\n\n${practicesPrompt(MODEL_PRACTICE_CANDIDATES)}`));
  assert.deepEqual(JSON.parse(prompts[1].split("\n").pop()).practices, ids);
  assert.deepEqual(status.map((s) => s.step), ["narrative", "practices", "practices"]);
  assert.deepEqual(status.slice(1).map((s) => [s.batch, s.total]), [[1, 2], [2, 2]]);
});

test("every turn runs in its own session with the chosen model, and the inline prompt opens with the run system", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-turns-"));
  const turns = join(dir, "turns.jsonl");
  try {
    const { prompts, error } = await run({ FAKE_MODELS: "m1,m2", FAKE_TURN_LOG: turns }, { model: "m2" });
    assert.ifError(error);
    const seen = readFileSync(turns, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen.map((t) => t.sessionId)).size, 3, "no turn sees an earlier one");
    assert.ok(seen.every((t) => t.model === "m2"));
    for (const p of prompts) assert.ok(p.startsWith(RUN_SYSTEM + "\n\n"), "the no-tools line reaches inline agents");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a retried batch also runs in a new session", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-turns-"));
  const turns = join(dir, "turns.jsonl");
  try {
    const { error } = await run({ FAKE_PRACTICES_BAD: "once", FAKE_TURN_LOG: turns });
    assert.ifError(error);
    const seen = readFileSync(turns, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(seen.length, 4);
    assert.equal(new Set(seen.map((t) => t.sessionId)).size, 4);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a failing close does not stop the transcript cleanup or hide the typed error", async () => {
  const calls = [];
  const agent = fakeEntry({ cleanup: (dir) => (calls.push(dir), []) });
  const start = async (spec, opts) => {
    const session = await startAgent(spec, opts);
    const close = session.close;
    session.close = async () => {
      await close();
      throw new Error("close failed");
    };
    return session;
  };
  const { error } = await run({ FAKE_TOOL: "1", FAKE_SMART: "" }, { agent, start });
  assert.ok(error instanceof ToolUseError, String(error));
  assert.equal(calls.length, 1);
});

test("the API entry stops on an aborted signal before calling, and hands the signal to fetch", async () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const seen = [];
  globalThis.fetch = async (url, init) => {
    seen.push(init.signal);
    return { ok: true, json: async () => ({ content: [{ type: "text", text: JSON.stringify({ summary: "S", cognitive: { narrative: "C" }, projects: [] }) }] }) };
  };
  console.error = () => {};
  const api = { id: "anthropic-api", label: "Anthropic API", kind: "api", cleanup: () => [] };
  try {
    await withEnv({ ANTHROPIC_API_KEY: "sk-test" }, async () => {
      const before = new AbortController();
      before.abort();
      await assert.rejects(runWithAgent({ agent: api, narrativeInput, practicesInput: null, signal: before.signal }), { name: "AbortError" });
      assert.equal(seen.length, 0, "no request once aborted");
      const live = new AbortController();
      await runWithAgent({ agent: api, narrativeInput, practicesInput: null, signal: live.signal });
      assert.equal(seen[0], live.signal);
      const mid = new AbortController();
      await assert.rejects(runWithAgent({ agent: api, narrativeInput, practicesInput: practicesInput(12), signal: mid.signal, onStatus: (s) => s.step === "practices" && s.batch === 1 && mid.abort() }), { name: "AbortError" });
    });
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});

test("without --model the agent's current model is kept and recorded; with none offered it is null", async () => {
  assert.deepEqual((await run({ FAKE_MODELS: "m1,m2" })).result.used, { agent: "fake-agent", model: "m1" });
  assert.deepEqual((await run({})).result.used, { agent: "fake-agent", model: null });
});

test("a model the agent does not offer fails naming what it offers", async () => {
  const { error } = await run({ FAKE_MODELS: "m1,m2" }, { model: "nope" });
  assert.ok(error instanceof ModelNotOfferedError);
  assert.deepEqual(error.offered, ["m1", "m2"]);
});

test("a very long model id is cut to the bound the hub applies", async () => {
  const { result } = await run({ FAKE_MODELS: "x".repeat(200) });
  assert.equal(result.used.model.length, 120);
});

test("the first balanced JSON object wins over chatter and stray braces", async () => {
  const { result, error } = await run({ FAKE_CHATTER: "1" });
  assert.ifError(error);
  assert.equal(result.narrative.cognitive.narrative, "Splits work into small checked steps.");
  assert.equal(Object.keys(result.practicesAnswers).length, 12);
});

test("a batch answered without JSON is asked once more, then the run goes on", async () => {
  const { result, error, prompts, status } = await run({ FAKE_PRACTICES_BAD: "once" });
  assert.ifError(error);
  assert.equal(Object.keys(result.practicesAnswers).length, 12);
  assert.equal(prompts.length, 1 + 2 + 1, "narrative, the bad batch, its retry, the second batch");
  assert.equal(prompts[1], prompts[2], "the retry asks the same thing");
  assert.ok(status.some((s) => s.retry === true));
});

test("a batch that fails twice fails the run, naming the batch and the agent", async () => {
  const { error, result, prompts } = await run({ FAKE_PRACTICES_BAD: "always" });
  assert.equal(result, undefined);
  assert.match(error.message, /practices batch 1 of 2/);
  assert.match(error.message, /Fake agent/);
  assert.equal(prompts.length, 3, "narrative plus the batch and one retry");
});

test("an answer that is not a narrative fails the run, naming the agent", async () => {
  const { error } = await run({ FAKE_SMART: "", FAKE_ANSWER: '{"summary":"only"}' });
  assert.match(error.message, /Fake agent/);
  assert.match(error.message, /narrative/);
});

test("a narrative answered without JSON is asked once more, in a new session; twice fails the run", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-turns-"));
  const turns = join(dir, "turns.jsonl");
  try {
    const once = await run({ FAKE_NARRATIVE_BAD: "once", FAKE_TURN_LOG: turns }, { practicesInput: null });
    assert.ifError(once.error);
    assert.equal(once.result.narrative.summary, "Builds a web product with an AI agent.");
    assert.equal(once.prompts.length, 2);
    assert.equal(once.prompts[0], once.prompts[1], "the retry asks the same thing");
    assert.ok(once.status.some((s) => s.step === "narrative" && s.retry === true));
    const seen = readFileSync(turns, "utf8").trim().split("\n").map((l) => JSON.parse(l));
    assert.equal(new Set(seen.map((t) => t.sessionId)).size, 2);
    const twice = await run({ FAKE_NARRATIVE_BAD: "always" });
    assert.match(twice.error.message, /Fake agent: the narrative answer cannot be used/);
    assert.equal(twice.prompts.length, 2, "one retry, no practices turns");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a narrative that fails validation is retried too, and a trailing comma is tolerated", async () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-turns-"));
  try {
    const { error, prompts } = await run({ FAKE_SMART: "", FAKE_ANSWER: '{"summary":"only"}' }, { practicesInput: null });
    assert.match(error.message, /narrative answer cannot be used/);
    assert.equal(prompts.length, 2);
    const ok = await run({ FAKE_SMART: "", FAKE_ANSWER: '{"summary":"S","cognitive":{"narrative":"C",},"projects":[],}' }, { practicesInput: null });
    assert.ifError(ok.error);
    assert.equal(ok.result.narrative.summary, "S");
    assert.equal(ok.prompts.length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a tool call fails the run as tool use", async () => {
  const { error } = await run({ FAKE_TOOL: "1", FAKE_SMART: "" });
  assert.ok(error instanceof ToolUseError);
});

test("an auth failure surfaces as AgentAuthError", async () => {
  const { error } = await run({ FAKE_AUTH: "new" });
  assert.ok(error instanceof AgentAuthError);
});

test("cleanup runs after the session is closed, on success and on failure, and the count is logged", async () => {
  for (const [env, fails] of [[{}, false], [{ FAKE_TOOL: "1", FAKE_SMART: "" }, true]]) {
    const calls = [];
    const agent = fakeEntry({ cleanup: (dir) => (calls.push({ dir, gone: !existsSync(dir) }), ["a", "b", "c"]) });
    const { error, log } = await run(env, { agent });
    assert.equal(Boolean(error), fails);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].dir.includes(AGENT_RUN_MARKER));
    assert.equal(calls[0].gone, true, "the run dir is removed before the transcript cleanup");
    const line = log.find((l) => l.dir === "cleanup");
    assert.equal(line.removed, 3);
  }
});

test("an abort rejects with AbortError after cleanup", async () => {
  const calls = [];
  const ctl = new AbortController();
  const agent = fakeEntry({ cleanup: (dir) => (calls.push(dir), []) });
  const { error } = await run({ FAKE_HANG: "1", FAKE_SMART: "" }, { agent, signal: ctl.signal, onStatus: (s) => s.step === "narrative" && ctl.abort() });
  assert.equal(error?.name, "AbortError");
  assert.equal(calls.length, 1);
});

test("the API entry calls the Anthropic key path through the same shape, with today's warnings", async () => {
  const realFetch = globalThis.fetch;
  const realError = console.error;
  const warnings = [];
  const bodies = [];
  globalThis.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    bodies.push({ url, key: init.headers["x-api-key"], model: body.model });
    const user = JSON.parse(body.messages[0].content);
    const text = Array.isArray(user.sessions)
      ? JSON.stringify(Object.fromEntries(user.sessions.map((s) => [s.id, Object.fromEntries(user.practices.map((p) => [p, false]))])))
      : JSON.stringify({ summary: "S", cognitive: { narrative: "C" }, projects: [] });
    return { ok: true, json: async () => ({ content: [{ type: "text", text: `Here: ${text} thanks` }] }) };
  };
  console.error = (m) => warnings.push(String(m));
  try {
    const out = await withEnv({ ANTHROPIC_API_KEY: "sk-test" }, () =>
      runWithAgent({ agent: { id: "anthropic-api", label: "Anthropic API", kind: "api", cleanup: () => assert.fail("no run dir to clean") }, narrativeInput, practicesInput: practicesInput(3) }),
    );
    assert.deepEqual(out.used, { agent: "anthropic-api", model: MODEL });
    assert.equal(out.narrative.summary, "S");
    assert.equal(Object.keys(out.practicesAnswers).length, 3);
    assert.deepEqual([...new Set(bodies.map((b) => b.key))], ["sk-test"]);
    assert.equal(warnings.filter((w) => w.includes("api.anthropic.com")).length, 2);
  } finally {
    globalThis.fetch = realFetch;
    console.error = realError;
  }
});

test("without model practices only the narrative is asked", async () => {
  const { result, prompts } = await run({}, { practicesInput: null });
  assert.equal(result.practicesAnswers, null);
  assert.equal(prompts.length, 1);
});

// ---- the records in the profile

const sample = [1, 2, 3].map((n) => ({ id: `s0${n}`, session: `r${n}`, date: "2026-03-05", product: "p1", month: "2026-03" }));
const answers = Object.fromEntries(sample.map((s) => [s.id, Object.fromEntries(PUBLISHED_MODEL_IDS.map((i) => [i, true]))]));
const baseProfile = () => JSON.parse(readFileSync(new URL("./fixtures/candidate.sample.json", import.meta.url), "utf8"));
const withRecords = ({ practicesBy, generatedBy }) => {
  const p = baseProfile();
  p.intensity = { ...(p.intensity ?? {}), timezone: "UTC" };
  p.practices = { ...practicesBlock(computeModelPractices(answers, sample, PUBLISHED_MODEL_IDS), { tz: "UTC" }), ...(practicesBy === undefined ? {} : { classifiedBy: practicesBy }) };
  if (generatedBy !== undefined) p.generatedBy = generatedBy;
  return p;
};
const provenance = (p) => assessStructure(p).issues.filter((i) => /classifiedBy|generatedBy/.test(i));

test("merging the model answers records who classified them, only when model items exist", () => {
  const by = { agent: "omp", model: "claude-opus-4" };
  const { block } = mergeModelPractices({ rubric: RUBRIC, timezone: "UTC", items: [] }, answers, sample, PUBLISHED_MODEL_IDS, { tz: "UTC", classifiedBy: by });
  assert.deepEqual(block.classifiedBy, by);
  assert.ok(!("classifiedBy" in mergeModelPractices({ rubric: RUBRIC, timezone: "UTC", items: [] }, answers, sample, PUBLISHED_MODEL_IDS, { tz: "UTC" }).block));
  assert.equal(practicesBlock([], { tz: "UTC", classifiedBy: by }), null);
});

test("generatedBy is written when the narrative source is known, and absent otherwise", () => {
  const args = { projects: [], narrative: null, fingerprint: null, forensics: null, manifestHash: null };
  const by = { narrative: { agent: "codex", model: null } };
  assert.deepEqual(assembleProfile({ ...args, generatedBy: by }).generatedBy, by);
  assert.ok(!("generatedBy" in assembleProfile(args)));
});

test("assessStructure accepts the records and refuses other shapes (the hub's bounds)", () => {
  assert.deepEqual(provenance(withRecords({})), []);
  for (const v of [
    { agent: "omp", model: "claude-opus-4" },
    { agent: "omp", model: null },
    { agent: "a".repeat(40), model: "m".repeat(120) },
    { agent: "slash-command", model: null },
  ]) {
    assert.deepEqual(provenance(withRecords({ practicesBy: v, generatedBy: { narrative: v } })), [], JSON.stringify(v));
  }
  for (const v of [
    "omp", null, [], { agent: "omp" }, { agent: "omp", model: null, x: 1 }, { agent: "", model: null }, { agent: "a".repeat(41), model: null },
    { agent: "Claude Code", model: null }, { agent: 3, model: null }, { agent: "omp", model: "m".repeat(121) },
    { agent: "omp", model: "bad\nname" }, { agent: "omp", model: 5 }, { agent: "omp", model: "" }, { agent: "omp", model: "   " },
  ]) {
    const a = provenance(withRecords({ practicesBy: v }));
    assert.equal(a.length, 1, `classifiedBy ${JSON.stringify(v)}`);
    assert.match(a[0], /^practices\.classifiedBy: .*\[a-z0-9-\]/);
    const b = provenance(withRecords({ generatedBy: { narrative: v } }));
    assert.equal(b.length, 1, `generatedBy.narrative ${JSON.stringify(v)}`);
    assert.match(b[0], /^generatedBy\.narrative: .*\[a-z0-9-\]/);
  }
  for (const g of ["x", null, [], {}, { narrative: { agent: "omp", model: null }, other: 1 }]) {
    assert.equal(provenance(withRecords({ generatedBy: g })).length, 1, `generatedBy ${JSON.stringify(g)}`);
  }
});

// ---- generate --agent through the real bin

function setup() {
  const tmp = mkdtempSync(join(tmpdir(), "gen-agent-"));
  const home = join(tmp, "home");
  const cwd = join(tmp, "work");
  const tmpd = join(tmp, "tmp");
  const emptyBin = join(tmp, "bin");
  for (const d of [home, cwd, tmpd, emptyBin]) mkdirSync(d, { recursive: true });
  const root = join(home, "projects", "-h-p-x");
  mkdirSync(root, { recursive: true });
  const lines = ["first message", "second message", "third message"].map((t, i) =>
    JSON.stringify({ type: "user", sessionId: "s", cwd: "/h/p/x", timestamp: `2026-05-01T10:0${i}:00.000Z`, message: { role: "user", content: t } }),
  );
  writeFileSync(join(root, "s.jsonl"), lines.join("\n") + "\n");
  const go = (args, env = {}) =>
    spawnSync(process.execPath, [BIN, "generate", "--root", join(home, "projects"), "--no-opencode", "--no-codex", "--no-pi", "--no-omp", "--no-cursor", "--no-kimi", ...args], {
      cwd,
      encoding: "utf8",
      timeout: 120000,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, TMPDIR: tmpd, TEMP: tmpd, TMP: tmpd, REBASE_VERIFY_TEST_AGENT: FAKE, FAKE_MODELS: "m1,m2", FAKE_SMART: "1", ...env },
    });
  const out = (f) => join(cwd, "out", f);
  const candidate = () => (existsSync(out("candidate.json")) ? JSON.parse(readFileSync(out("candidate.json"), "utf8")) : null);
  return { tmp, tmpd, emptyBin, go, out, candidate };
}

test("generate --agent runs the whole flow, writes the profile with both records and the log, and leaves no run dir", () => {
  const t = setup();
  try {
    const r = t.go(["--agent", "test-agent", "--model", "m2"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const c = t.candidate();
    const by = { agent: "test-agent", model: "m2" };
    assert.deepEqual(c.generatedBy, { narrative: by });
    assert.deepEqual(c.practices.classifiedBy, by);
    assert.equal(c.summary, "Builds a web product with an AI agent.");
    const model = c.practices.items.filter((i) => i.method === "model");
    assert.deepEqual(model.map((i) => i.id), PUBLISHED_MODEL_IDS);
    assert.ok(model.every((i) => i.of === 1 && i.seen === 1));
    assert.deepEqual(assessStructure(c).issues.filter((i) => /classifiedBy|generatedBy/.test(i)), []);
    assert.ok(existsSync(t.out("profile.md")));
    assert.ok(!existsSync(t.out("practices.json")), "the answers stay in the local detail file only");
    assert.ok(existsSync(t.out("practices-detail.json")));
    assert.ok(readFileSync(t.out("agent-log.jsonl"), "utf8").includes('"cleanup"'));
    assert.deepEqual(readdirSync(t.tmpd).filter((n) => n.startsWith(AGENT_RUN_MARKER)), []);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("without --model the agent's current model is recorded; a stale agent log is replaced", () => {
  const t = setup();
  try {
    mkdirSync(join(t.tmp, "work", "out"), { recursive: true });
    writeFileSync(t.out("agent-log.jsonl"), '{"stale":true}\n');
    const r = t.go(["--agent", "test-agent"]);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.deepEqual(t.candidate().practices.classifiedBy, { agent: "test-agent", model: "m1" });
    assert.ok(!readFileSync(t.out("agent-log.jsonl"), "utf8").includes("stale"));
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("a tool call exits 2 with one line and writes no candidate", () => {
  const t = setup();
  try {
    const r = t.go(["--agent", "test-agent"], { FAKE_TOOL: "1" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /The agent tried to use a tool; nothing it wrote was kept\./);
    assert.ok(!/\n\s+at /.test(r.stderr), "no stack trace");
    assert.equal(t.candidate(), null);
    assert.ok(!existsSync(t.out("practices.json")));
    assert.deepEqual(readdirSync(t.tmpd).filter((n) => n.startsWith(AGENT_RUN_MARKER)), []);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("a logged-out agent exits 2 with its login hint and no candidate", () => {
  const t = setup();
  try {
    const r = t.go(["--agent", "test-agent"], { FAKE_AUTH: "new" });
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /log in to the test agent/);
    assert.equal(t.candidate(), null);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("a batch with no JSON twice exits 2, names the batch and writes no candidate; once is retried", () => {
  const t = setup();
  try {
    const bad = t.go(["--agent", "test-agent"], { FAKE_PRACTICES_BAD: "always" });
    assert.equal(bad.status, 2, bad.stdout + bad.stderr);
    assert.match(bad.stderr, /practices batch 1 of 1/);
    assert.equal(t.candidate(), null);
    assert.ok(!existsSync(t.out("practices.json")));
    const once = t.go(["--agent", "test-agent"], { FAKE_PRACTICES_BAD: "once" });
    assert.equal(once.status, 0, once.stdout + once.stderr);
    assert.ok(t.candidate());
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("chatter around the JSON is tolerated through the bin", () => {
  const t = setup();
  try {
    const r = t.go(["--agent", "test-agent"], { FAKE_CHATTER: "1" });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(t.candidate().cognitive.narrative, "Splits work into small checked steps.");
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("unknown agent, missing install, unknown model and conflicting flags all exit 2 in one line", () => {
  const t = setup();
  try {
    const unknown = t.go(["--agent", "nope"]);
    assert.equal(unknown.status, 2);
    assert.match(unknown.stderr, /Unknown agent "nope"\. Agents: .*omp.*claude-code.*test-agent/);
    const noTest = t.go(["--agent", "nope"], { REBASE_VERIFY_TEST_AGENT: "" });
    assert.ok(!/test-agent/.test(noTest.stderr), "the test agent exists only when the test variable is set");
    const missing = t.go(["--agent", "gemini"], { PATH: t.emptyBin });
    assert.equal(missing.status, 2, missing.stdout + missing.stderr);
    assert.match(missing.stderr, /install the Gemini CLI/);
    const model = t.go(["--agent", "test-agent", "--model", "nope"]);
    assert.equal(model.status, 2, model.stdout + model.stderr);
    assert.match(model.stderr, /does not offer model "nope".*m1, m2/);
    assert.equal(t.go(["--model", "m1"]).status, 2);
    assert.equal(t.go(["--agent", "test-agent", "--narrative-file", "x.json"]).status, 2);
    assert.equal(t.candidate(), null);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("finalize records the slash command for the narrative and the practices it was handed", () => {
  const t = setup();
  try {
    const prep = spawnSync(process.execPath, [BIN, "prepare", "--root", join(t.tmp, "home", "projects"), "--no-opencode", "--no-codex", "--no-pi", "--no-omp", "--no-cursor", "--no-kimi"], {
      cwd: join(t.tmp, "work"), encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: join(t.tmp, "home"), USERPROFILE: join(t.tmp, "home") },
    });
    assert.equal(prep.status, 0, prep.stdout + prep.stderr);
    writeFileSync(t.out("narrative.json"), JSON.stringify({ summary: "A short test summary.", cognitive: { narrative: "A short test narrative." }, projects: [] }));
    writeFileSync(t.out("practices.json"), JSON.stringify({ s01: Object.fromEntries(PUBLISHED_MODEL_IDS.map((id) => [id, true])) }));
    const fin = spawnSync(process.execPath, [BIN, "finalize", "--root", join(t.tmp, "home", "projects"), "--no-opencode", "--no-codex", "--no-pi", "--no-omp", "--no-cursor", "--no-kimi"], {
      cwd: join(t.tmp, "work"), encoding: "utf8", timeout: 120000, env: { ...process.env, HOME: join(t.tmp, "home"), USERPROFILE: join(t.tmp, "home") },
    });
    assert.equal(fin.status, 0, fin.stdout + fin.stderr);
    const c = t.candidate();
    const by = { agent: "slash-command", model: null };
    assert.deepEqual(c.generatedBy, { narrative: by });
    assert.deepEqual(c.practices.classifiedBy, by);
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("the key path records the API as writer and classifier, and leaves no practices.json for a later finalize", () => {
  const t = setup();
  try {
    const stub = pathToFileURL(fileURLToPath(new URL("./fixtures/stub-anthropic.mjs", import.meta.url))).href;
    const r = t.go([], { ANTHROPIC_API_KEY: "sk-test", NODE_OPTIONS: `--import=${stub}` });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    const by = { agent: "anthropic-api", model: MODEL };
    const c = t.candidate();
    assert.deepEqual(c.generatedBy, { narrative: by });
    assert.deepEqual(c.practices.classifiedBy, by);
    assert.ok(!existsSync(t.out("practices.json")));
    assert.ok(existsSync(t.out("practices-detail.json")));
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});

test("--agent and --model are for generate only", () => {
  const t = setup();
  try {
    for (const sub of ["prepare", "finalize", "submit"]) {
      for (const args of [["--agent", "test-agent"], ["--model", "m1"]]) {
        const r = spawnSync(process.execPath, [BIN, sub, ...args], { cwd: join(t.tmp, "work"), encoding: "utf8", timeout: 60000, env: { ...process.env, HOME: join(t.tmp, "home"), USERPROFILE: join(t.tmp, "home"), REBASE_VERIFY_TEST_AGENT: FAKE } });
        assert.equal(r.status, 2, `${sub} ${args[0]}: ${r.stdout}${r.stderr}`);
        assert.match(r.stderr.trim(), /^--agent and --model work with generate only\.$/);
      }
    }
    assert.ok(!existsSync(t.out("narrative-input.json")), "nothing was read");
  } finally {
    rmSync(t.tmp, { recursive: true, force: true });
  }
});
