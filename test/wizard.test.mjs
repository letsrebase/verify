// The wizard's decisions, driven without a TTY and without agents: the clack
// functions and every reader, agent and writer are injected.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { EventEmitter } from "node:events";
import { runWizard, consentText, statusLine, rejectedFlags } from "../src/wizard.mjs";
import { liveStatus } from "../src/live-status.mjs";
import { AgentAuthError } from "../src/agents/acp.mjs";

const CANCEL = Symbol("cancel");
const BIN = fileURLToPath(new URL("../bin/rebase-verify.mjs", import.meta.url));

const CLEANED = [];
const agentEntry = (id, over = {}) => ({ cleanup: (d) => (CLEANED.push(d), []), id, label: id.toUpperCase(), kind: "acp", tested: id !== "kimi", sessions: 0, loginHint: "log in", installHint: `install ${id}`, spec: () => ({ command: id }), ...over });

// answers: queue per prompt kind; a CANCEL entry cancels that prompt.
function fakeUi(answers = {}) {
  const calls = [];
  CLEANED.length = 0;
  const queue = Object.fromEntries(Object.entries(answers).map(([k, v]) => [k, [...v]]));
  const take = (kind, dflt) => {
    const q = queue[kind];
    return q && q.length ? (q.shift() ?? dflt) : dflt;
  };
  const spin = () => ({
    start: (m) => calls.push(["spinner.start", m]),
    stop: (m) => calls.push(["spinner.stop", m]),
    error: (m) => calls.push(["spinner.error", m]),
    message: (m) => calls.push(["spinner.message", m]),
  });
  return {
    calls,
    isCancel: (v) => v === CANCEL,
    intro: (m) => calls.push(["intro", m]),
    outro: (m) => calls.push(["outro", m]),
    cancel: (m) => calls.push(["cancel", m]),
    note: (m, t) => calls.push(["note", m, t]),
    log: { info: (m) => calls.push(["log.info", m]), error: (m) => calls.push(["log.error", m]), warn: (m) => calls.push(["log.warn", m]) },
    spinner: spin,
    live: (o) => ({ ...spin(), onCancel: o.onCancel }),
    multiselect: async (o) => (calls.push(["multiselect", o]), take("multiselect", o.initialValues)),
    select: async (o) => (calls.push(["select", o]), take("select", o.initialValue ?? o.options[0].value)),
    confirm: async (o) => (calls.push(["confirm", o]), take("confirm", true)),
  };
}

const read = (n) => ({ sessions: n });

function fakeDeps(over = {}) {
  const state = { closed: 0, started: [], ran: [], finished: [], submitted: 0, prepared: [] };
  const session = { models: [{ id: "m1", name: "Model one" }, { id: "m2", name: "Model two" }], currentModel: "m2", close: async () => void state.closed++ };
  const deps = {
    sources: [{ id: "claude-code", label: "Claude Code" }, { id: "omp", label: "oh-my-pi" }, { id: "codex", label: "Codex" }],
    readSource: async (id) => read({ "claude-code": 10, omp: 30, codex: 0 }[id]),
    availableAgents: (by) => [agentEntry("omp", { sessions: by.omp ?? 0 }), agentEntry("claude-code", { sessions: by["claude-code"] ?? 0 }), agentEntry("kimi")],
    defaultAgent: (l) => l[0],
    prepare: async (ids) => (state.prepared.push(ids), { narrativeInput: { n: 1 }, practicesInput: { p: 1 } }),
    startAgent: async (spec, opts) => {
      state.started.push({ spec, opts });
      opts.onEvent?.({ kind: "started", cwd: "/tmp/rebase-verify-agent-run-x", pid: 4242 });
      return session;
    },
    runWithAgent: async (args) => {
      state.ran.push(args);
      args.onStatus({ step: "narrative" });
      return { narrative: {}, practicesAnswers: null, used: { agent: args.agent.id, model: args.model ?? null } };
    },
    finish: async (run) => (state.finished.push(run), { sessions: 40, products: 3, practices: [{ id: "checks_before_commit", seen: 4, of: 9 }], file: "out/profile.md" }),
    sendNotice: () => "About to send to rebase (https://hub.test):\n  profile: 40 sessions, 3 products",
    submit: async () => void state.submitted++,
    ...over,
  };
  return { deps, state, session };
}

const run = (ui, deps, extra = {}) => runWizard({ ui, deps, flags: { version: "1.2.3", ...extra }, out: "out", proc: new EventEmitter(), now: () => 0 });
const kinds = (ui, k) => ui.calls.filter((c) => c[0] === k);

test("accepting every default picks the default agent and the current model, then sends once", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps();
  const code = await run(ui, deps);
  assert.equal(code, 0);
  const [multi] = kinds(ui, "multiselect");
  assert.deepEqual(multi[1].options.map((o) => o.value), ["claude-code", "omp"], "sources without sessions are not offered");
  assert.deepEqual(multi[1].initialValues, ["claude-code", "omp"]);
  const selects = kinds(ui, "select");
  assert.equal(selects.length, 3, "an agent, a model, and the one question about sending");
  const [agentSel, modelSel] = selects;
  assert.equal(agentSel[1].initialValue, "omp");
  assert.match(agentSel[1].options[0].hint, /30 sessions in your logs · tested/);
  assert.match(agentSel[1].options[2].hint, /not tested/);
  assert.equal(modelSel[1].initialValue, "m2");
  assert.equal(state.ran.length, 1);
  assert.equal(state.ran[0].model, "m2");
  assert.equal(state.ran[0].session.currentModel, "m2");
  assert.equal(state.started.length, 1, "the agent is started once and its session reused");
  assert.equal(state.ran[0].runDir, "/tmp/rebase-verify-agent-run-x");
  assert.equal(state.submitted, 1, "the default of the final question is to send");
});

test("the profile is built only from the chosen sources", async () => {
  const ui = fakeUi({ multiselect: [["omp"]] });
  const { deps, state } = fakeDeps();
  await run(ui, deps);
  assert.deepEqual(state.prepared[0], ["omp"]);
  const agentSel = kinds(ui, "select")[0];
  assert.match(agentSel[1].options[1].hint, /10 sessions|0 sessions/);
});

test("the final question comes after the screen of who receives what, defaults to send, and asks once", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps();
  assert.equal(await run(ui, deps), 0);
  assert.equal(kinds(ui, "confirm").length, 1, "only the consent confirm; no confirm about sending");
  const finals = kinds(ui, "select").slice(2);
  assert.equal(finals.length, 1, "one question about sending, no second one");
  const [, final] = finals[0];
  assert.equal(final.initialValue, "send");
  assert.equal(final.options[0].value, "send", "send is the first option");
  assert.match(final.message, /^Send this profile to rebase\?/);
  assert.match(final.message, /It is what rebase will see \(.*profile\.md\)/);
  const at = (pred) => ui.calls.findIndex(pred);
  const screen = at((c) => c[0] === "note" && c[2] === "What leaves your machine, and who receives it");
  assert.ok(screen > -1, "the screen is shown");
  assert.match(ui.calls[screen][1], /About to send to rebase/);
  assert.ok(screen < at((c) => c === finals[0]), "the screen comes before the question");
  assert.equal(state.submitted, 1);
  assert.deepEqual(kinds(ui, "outro").at(-1), ["outro", "Sent."]);
});

for (const [name, answers] of [
  ["declining", { select: [undefined, undefined, "exit"] }],
  ["cancelling (Ctrl-C)", { select: [undefined, undefined, CANCEL] }],
]) {
  test(`${name} the final question submits nothing and does not ask again`, async () => {
    const ui = fakeUi(answers);
    const { deps, state } = fakeDeps();
    const code = await run(ui, deps);
    assert.equal(code, name === "declining" ? 0 : 130);
    assert.equal(state.submitted, 0);
    assert.equal(kinds(ui, "select").length, 3);
    assert.equal(kinds(ui, "confirm").length, 1);
    if (name === "declining") assert.match(kinds(ui, "outro").at(-1)[1], /Nothing was sent\. To send it later: npx @letsrebase\/verify submit --yes/);
    else assert.deepEqual(kinds(ui, "cancel").at(-1), ["cancel", "Stopped. Nothing was sent."]);
  });
}

test("the screen before the question carries who receives what, and is the sub-command's own text", async () => {
  const { sendNotice } = await import("../src/submit.mjs");
  const text = sendNotice({ hub: "https://hub.test", profile: { volume: { sessions: 5, products: 2 }, projects: [{ artifact: { type: "url" } }, {}] }, cmd: "npx @letsrebase/verify" }).join("\n");
  for (const part of ["About to send to rebase (https://hub.test)", "5 sessions, 2 products", "artifact links: 1", "Rebase S.r.l.", "kept at most 12 months", "NOT sent: raw logs", "submit --dry-run"]) {
    assert.ok(text.includes(part), part);
  }
});

for (const [name, answers, closes] of [
  ["the source list", { multiselect: [CANCEL] }, 0],
  ["the agent select", { select: [CANCEL] }, 0],
  ["the model select", { select: [undefined, CANCEL] }, 1],
  ["the consent", { confirm: [CANCEL] }, 1],
  ["the final question", { select: [undefined, undefined, CANCEL] }, 0],
]) {
  test(`Ctrl-C at ${name} exits 130 and closes the session it started`, async () => {
    const ui = fakeUi(answers);
    const { deps, state } = fakeDeps();
    const orig = ui.select;
    ui.select = async (o) => {
      const v = await orig(o);
      return v === undefined ? o.initialValue ?? o.options[0].value : v;
    };
    assert.equal(await run(ui, deps), 130);
    assert.deepEqual(kinds(ui, "cancel").at(-1), ["cancel", "Stopped. Nothing was sent."]);
    if (name === "the final question") assert.equal(state.finished.length, 1, "the profile was already written");
    else assert.equal(state.finished.length, 0);
    assert.equal(state.closed, closes);
  });
}

test("declining at the consent closes the session and writes nothing", async () => {
  const ui = fakeUi({ confirm: [false] });
  const { deps, state } = fakeDeps();
  assert.equal(await run(ui, deps), 0);
  assert.equal(state.closed, 1);
  assert.equal(state.ran.length, 0);
  assert.equal(state.finished.length, 0);
  assert.equal(state.submitted, 0);
  assert.match(kinds(ui, "cancel").at(-1)[1], /Nothing was written or sent/);
});

test("no agent installed and no API key: a note with the two ways, exit 1, nothing written", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps({ availableAgents: () => [] });
  assert.equal(await run(ui, deps), 1);
  const note = kinds(ui, "note").at(-1);
  assert.match(note[1], /slash command/);
  assert.match(note[1], /omp/);
  assert.equal(state.finished.length, 0);
  assert.equal(state.started.length, 0);
});

test("an agent that offers no model skips the model select", async () => {
  const ui = fakeUi();
  const { deps, state, session } = fakeDeps();
  session.models = [];
  session.currentModel = null;
  assert.equal(await run(ui, deps), 0);
  assert.equal(kinds(ui, "select").length, 2, "agent and final select only");
  assert.equal(state.ran[0].model, undefined);
  assert.ok(ui.calls.some((c) => c[0] === "log.info" && /default model/.test(c[1])));
});

test("the consent text follows what each agent can promise", () => {
  const omp = consentText(agentEntry("omp"));
  assert.match(omp, /out\/agent-log\.jsonl/);
  assert.match(omp, /switched off/);
  assert.match(omp, /transcript/);
  assert.match(omp, /rebase receives nothing/i);
  assert.match(omp, /60 sessions/);
  const claude = consentText(agentEntry("claude-code"));
  assert.match(claude, /switched off/);
  assert.doesNotMatch(claude, /transcript/);
  const codex = consentText(agentEntry("codex"));
  assert.match(codex, /read-only/);
  assert.match(codex, /transcript/);
  const other = consentText(agentEntry("kimi"));
  assert.match(other, /not known/);
  assert.match(other, /stops if it tries/);
  for (const t of [omp, claude, codex, other]) assert.doesNotMatch(t, /cannot read|can't read|no access to (your )?files/i);
});

test("the status line shows the phase, characters, batches and usage", () => {
  assert.equal(statusLine({ step: "narrative" }, { chars: 1234 }), "Writing the narrative · 1.2k chars");
  assert.equal(statusLine({ step: "narrative" }, { chars: 80 }), "Writing the narrative · 80 chars");
  assert.equal(statusLine({ step: "practices", batch: 2, total: 6 }, { chars: 0, tokens: 3400 }), "Classifying practices · batch 2 of 6 · 3.4k tokens");
  assert.equal(statusLine({ step: "practices", batch: 2, total: 6 }, { chars: 0, cost: { amount: 0.0213, currency: "USD" } }), "Classifying practices · batch 2 of 6 · $0.02");
});

test("before the first written character the narrative says the phase, and the elapsed time ticks", () => {
  assert.equal(statusLine({ step: "narrative" }, { elapsed: 4200 }), "Writing the narrative · waiting for the model · 4s");
  assert.equal(statusLine({ step: "narrative" }, { thought: 2300, elapsed: 65000 }), "Writing the narrative · the model is reasoning (2.3k chars) · 1m 05s");
  assert.equal(statusLine({ step: "narrative" }, { chars: 80, thought: 2300, elapsed: 70000 }), "Writing the narrative · 80 chars · 1m 10s");
  assert.equal(statusLine({ step: "practices", batch: 1, total: 6 }, { elapsed: 3000 }), "Classifying practices · batch 1 of 6 · 3s");
});

test("live status redraws at most every 100 ms", async () => {
  const ui = fakeUi();
  const { deps } = fakeDeps();
  const seen = {};
  let t = 0;
  const start = deps.startAgent;
  deps.startAgent = async (spec, opts) => ((seen.onEvent = opts.onEvent), start(spec, opts));
  deps.runWithAgent = async (args) => {
    args.onStatus({ step: "narrative" });
    for (let i = 0; i < 5; i++) seen.onEvent({ kind: "agent_message_chunk", content: { type: "text", text: "x".repeat(100) } });
    t = 150;
    seen.onEvent({ kind: "agent_message_chunk", content: { type: "text", text: "y" } });
    return { narrative: {}, practicesAnswers: null, used: { agent: "omp", model: null } };
  };
  await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc: new EventEmitter(), now: () => t });
  const msgs = kinds(ui, "spinner.message").map((c) => c[1]);
  assert.equal(msgs.length, 2, `got: ${msgs}`);
  assert.match(msgs.at(-1), /501 chars/);
});

test("an agent that is not logged in ends with its login hint and exit 2", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps({
    runWithAgent: async () => {
      throw new AgentAuthError("no");
    },
  });
  assert.equal(await run(ui, deps), 2);
  assert.ok(ui.calls.some((c) => c[0] === "log.error" && /log in/.test(c[1])));
  assert.equal(state.finished.length, 0);
});

test("Ctrl-C during the run aborts the agent and exits 130", async () => {
  const ui = fakeUi();
  const proc = new EventEmitter();
  const { deps, state } = fakeDeps({
    runWithAgent: async (args) => {
      proc.emit("SIGINT");
      assert.equal(args.signal.aborted, true);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  const code = await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 });
  assert.equal(code, 130);
  assert.equal(proc.listenerCount("SIGINT"), 0);
  assert.equal(state.finished.length, 0);
});

test("--agent and --model skip their selects", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps();
  assert.equal(await run(ui, deps, { agent: "claude-code", model: "m1" }), 0);
  assert.equal(kinds(ui, "select").length, 1, "only the final select");
  assert.equal(state.ran[0].agent.id, "claude-code");
  assert.equal(state.ran[0].model, "m1");
});

test("the bin never starts the wizard without a TTY", () => {
  const home = mkdtempSync(join(tmpdir(), "rv-wiz-"));
  const cwd = mkdtempSync(join(tmpdir(), "rv-wiz-cwd-"));
  try {
    const r = spawnSync(process.execPath, [BIN, "--root", join(home, "none")], {
      cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"], encoding: "utf8", input: "", timeout: 60000,
    });
    assert.match(r.stderr, /No logs at/, "it behaves as generate");
    assert.doesNotMatch(r.stdout + r.stderr, /rebase-verify \d/);
    assert.equal(existsSync(join(cwd, "out", "profile.md")), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("submit without --yes and without a TTY sends nothing and contacts no hub", async () => {
  const home = mkdtempSync(join(tmpdir(), "rv-sub-"));
  const cwd = mkdtempSync(join(tmpdir(), "rv-sub-cwd-"));
  let hits = 0;
  const hub = createServer((_req, res) => (hits++, res.end("{}")));
  await new Promise((r) => hub.listen(0, "127.0.0.1", r));
  try {
    mkdirSync(join(cwd, "out"));
    copyFileSync(fileURLToPath(new URL("./fixtures/candidate.sample.json", import.meta.url)), join(cwd, "out", "candidate.json"));
    const child = spawn(process.execPath, [BIN, "submit", "--root", join(home, "none"), "--hub", `http://127.0.0.1:${hub.address().port}`], {
      cwd, env: { ...process.env, HOME: home, USERPROFILE: home }, stdio: ["pipe", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.stdin.end();
    const code = await new Promise((r) => child.on("close", r));
    assert.equal(code, 0, out);
    assert.match(out, /About to send to rebase/);
    assert.match(out, /To confirm:.*submit --yes/);
    assert.equal(hits, 0, "nothing reached the hub");
  } finally {
    hub.close();
    rmSync(home, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  }
});

test("the live status maps Ctrl-C to onCancel and restores the terminal", () => {
  const handlers = [];
  const writes = [];
  const raw = [];
  const input = {
    isTTY: true, isRaw: false, isPaused: () => true,
    setRawMode: (v) => raw.push(v), resume() {}, pause() { raw.push("pause"); },
    on: (ev, fn) => handlers.push([ev, fn]), off: (ev, fn) => { const i = handlers.findIndex(([e, f]) => e === ev && f === fn); if (i >= 0) handlers.splice(i, 1); },
  };
  let cancelled = 0;
  const live = liveStatus({ onCancel: () => cancelled++, input, output: { write: (t) => writes.push(t) }, style: (_c, t) => t, delay: 1e6 });
  live.start("Starting");
  assert.deepEqual(raw, [true]);
  assert.equal(handlers.length, 1);
  handlers[0][1](Buffer.from("a"));
  assert.equal(cancelled, 0);
  handlers[0][1](Buffer.from("\x03"));
  assert.equal(cancelled, 1);
  live.message("Writing");
  live.stop("Done");
  assert.deepEqual(raw, [true, false, "pause"], "raw mode restored, stdin paused again");
  assert.equal(handlers.length, 0);
  assert.match(writes.join(""), /◇  Done/);
  live.stop("again");
  assert.equal(writes.join("").match(/Done/g).length, 1, "stop is idempotent");
});

test("Ctrl-C on the live status during the run aborts it and exits 130 with cleanup", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps({
    runWithAgent: async (args) => {
      ui.calls.find((c) => c[0] === "spinner.start" && /run with/.test(c[1]));
      lastLive.onCancel();
      assert.equal(args.signal.aborted, true);
      throw Object.assign(new Error("aborted"), { name: "AbortError" });
    },
  });
  let lastLive;
  const mk = ui.live;
  ui.live = (o) => (lastLive = mk(o));
  assert.equal(await run(ui, deps), 130);
  assert.equal(state.finished.length, 0);
});

test("the exit net kills the agent group and removes the run dir and transcript", async () => {
  const ui = fakeUi();
  const proc = new EventEmitter();
  const killed = [];
  const removed = [];
  const { deps } = fakeDeps({
    killGroup: (pid) => killed.push(pid),
    removeDir: (d) => removed.push(d),
    runWithAgent: async () => {
      proc.emit("exit");
      return { narrative: {}, practicesAnswers: null, used: { agent: "omp", model: null } };
    },
  });
  await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 });
  assert.deepEqual(killed, [4242]);
  assert.deepEqual(removed, ["/tmp/rebase-verify-agent-run-x"]);
  assert.deepEqual(CLEANED, ["/tmp/rebase-verify-agent-run-x"]);
  assert.equal(proc.exitCode, 130);
  assert.equal(proc.listenerCount("exit"), 0);
});

test("no exit handler is left once the run is over", async () => {
  const ui = fakeUi();
  const proc = new EventEmitter();
  const { deps } = fakeDeps();
  await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 });
  assert.equal(proc.listenerCount("exit"), 0);
  assert.equal(proc.exitCode, undefined);
});

for (const [name, answers] of [
  ["a cancelled model select", { select: [undefined, CANCEL] }],
  ["a declined consent", { confirm: [false] }],
  ["a cancelled consent", { confirm: [CANCEL] }],
]) {
  test(`${name} removes the transcript after closing the session`, async () => {
    const ui = fakeUi(answers);
    const { deps, state } = fakeDeps();
    const orig = ui.select;
    ui.select = async (o) => {
      const v = await orig(o);
      return v === undefined ? o.initialValue ?? o.options[0].value : v;
    };
    await run(ui, deps);
    assert.equal(state.closed, 1);
    assert.deepEqual(CLEANED, ["/tmp/rebase-verify-agent-run-x"]);
  });
}

test("the consent mentions the local log only for agents, and carries the API notice", () => {
  const api = consentText(agentEntry("anthropic-api", { kind: "api", label: "Anthropic API (your key)" }));
  assert.doesNotMatch(api, /agent-log/);
  assert.match(api, /unset ANTHROPIC_API_KEY/);
  assert.match(consentText(agentEntry("omp")), /agent-log\.jsonl/);
  assert.match(api, /compaction summaries/);
});

test("the API run's stderr notice is silenced, the consent already says it", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps();
  await run(ui, deps);
  assert.equal(typeof state.ran[0].warn, "function");
  assert.equal(state.ran[0].warn(), undefined);
});

test("a model the agent refuses is named by the id that was chosen", async () => {
  const ui = fakeUi();
  const { ModelNotOfferedError } = await import("../src/agents/acp.mjs");
  const { deps } = fakeDeps({
    runWithAgent: async () => {
      throw new ModelNotOfferedError("m2");
    },
  });
  assert.equal(await run(ui, deps), 2);
  assert.ok(ui.calls.some((c) => c[0] === "log.error" && /model "m2"/.test(c[1])));
});

test("the wizard refuses flags that belong to a sub-command", () => {
  const has = (set) => (f) => set.includes(f);
  assert.equal(rejectedFlags(has([])), null);
  assert.match(rejectedFlags(has(["narrative-file"])), /^--narrative-file needs a sub-command/);
  assert.match(rejectedFlags(has(["narrative-file", "dry-run"])), /^--narrative-file and --dry-run need a sub-command/);
});

test("no SIGINT or SIGTERM listener is left when submit runs", async () => {
  const ui = fakeUi();
  const orig = ui.select;
  ui.select = async (o) => {
    const v = await orig(o);
    return v === undefined ? o.initialValue ?? o.options[0].value : v;
  };
  const proc = new EventEmitter();
  let during = null;
  const { deps } = fakeDeps({ submit: async () => (during = [proc.listenerCount("SIGINT"), proc.listenerCount("SIGTERM")]) });
  assert.equal(await runWizard({ ui, deps, flags: { version: "1" }, out: "out", proc, now: () => 0 }), 0);
  assert.deepEqual(during, [0, 0]);
});

test("the live status never writes a line wider than the terminal", () => {
  const writes = [];
  const input = { on() {}, off() {} };
  const live = liveStatus({ onCancel() {}, input, output: { columns: 30, write: (t) => writes.push(t) }, style: (_c, t) => t, delay: 1e6 });
  live.start("x");
  live.message("Classifying practices · batch 12 of 40 · 123.4k tokens · $12.34");
  const line = writes.at(-1);
  assert.ok(line.length <= 29, `${line.length}: ${line}`);
  assert.match(line, /…$/);
  live.stop("");
});

// ---- REB-1149 final review ----

test("the consent note names every part of the narrative input and the npx download", () => {
  const text = consentText({ id: "claude-code", label: "Claude Code", kind: "acp", download: "@agentclientprotocol/claude-agent-acp@0.108.1" });
  for (const part of ["project labels", "README and CLAUDE.md excerpts", "lines you added to CLAUDE.md or README over time", "dependency names", "commit subjects", "sampled prompts", "topics you researched", "up to six compaction summaries"]) {
    assert.ok(text.includes(part), part);
  }
  assert.match(text, /Downloads @agentclientprotocol\/claude-agent-acp@0\.108\.1 from npm with npx/);
  assert.doesNotMatch(consentText({ id: "omp", label: "oh-my-pi", kind: "acp" }), /Downloads/);
});

test("the agent select hint announces the npx download", async () => {
  const ui = fakeUi();
  const { deps } = fakeDeps({ availableAgents: () => [agentEntry("claude-code", { download: "@agentclientprotocol/claude-agent-acp@0.108.1" }), agentEntry("omp")] });
  await run(ui, deps);
  const [agentSel] = kinds(ui, "select");
  assert.match(agentSel[1].options[0].hint, /Downloads @agentclientprotocol\/claude-agent-acp@0\.108\.1 from npm with npx/);
  assert.doesNotMatch(agentSel[1].options[1].hint, /Downloads/);
});

test("the summary shows the narrative sentence and the absolute out/profile.md", async () => {
  const ui = fakeUi();
  const { deps } = fakeDeps({ finish: () => ({ sessions: 4, products: 1, practices: [], summary: "Builds agent tooling." }) });
  await runWizard({ ui, deps, flags: {}, out: "/work/out", proc: new EventEmitter(), now: () => 0 });
  const note = kinds(ui, "note").find((c) => c[2] === "Your profile")[1];
  assert.match(note, /Builds agent tooling\./);
  assert.ok(note.includes(join("/work/out", "profile.md")));
});

test("every wait of the run shows a spinner with a message that names the step", async () => {
  const ui = fakeUi();
  const { deps } = fakeDeps({
    readSource: async (id, { onProgress }) => (onProgress({ done: 3, total: 12 }), read(id === "claude-code" ? 5 : 0)),
    prepare: async (ids, { onStep }) => (onStep("Counting the work practices"), { narrativeInput: {}, practicesInput: null }),
    finish: async (_run, { onStep }) => (onStep("Saving the profile"), { sessions: 1, products: 1, practices: [] }),
  });
  await run(ui, deps);
  const messages = kinds(ui, "spinner.message").map((c) => c[1]);
  assert.ok(messages.includes("Reading Claude Code (3 of 12 files)"));
  assert.ok(messages.includes("Building your profile: counting the work practices"));
  assert.ok(messages.includes("Assembling your profile: saving the profile"));
  const started = kinds(ui, "spinner.start").map((c) => c[1]);
  assert.deepEqual(started.slice(0, 3), ["Reading Claude Code", "Reading oh-my-pi", "Reading Codex"]);
  assert.ok(started.includes("Building your profile from the logs"));
  assert.ok(started.includes("Assembling your profile"));
});

test("a profile that cannot be assembled ends with the reason, exit 2, nothing sent", async () => {
  const ui = fakeUi();
  const { deps, state } = fakeDeps({ finish: async () => { throw new Error("out/practices.json is not valid JSON."); } });
  assert.equal(await run(ui, deps), 2);
  assert.ok(ui.calls.some((c) => c[0] === "log.error" && /not valid JSON/.test(c[1])));
  assert.equal(state.submitted, 0);
  assert.ok(kinds(ui, "spinner.error").some((c) => /Could not assemble your profile/.test(c[1])));
});

test("SIGHUP stops the run like SIGTERM, and the exit net restores the cursor", async () => {
  const ui = fakeUi();
  const proc = new EventEmitter();
  const written = [];
  proc.stdout = { write: (s) => written.push(s) };
  const { deps } = fakeDeps({
    runWithAgent: (args) => new Promise((_, rej) => args.signal.addEventListener("abort", () => rej(Object.assign(new Error("aborted"), { name: "AbortError" })))),
    killGroup: () => {},
    removeDir: () => {},
  });
  const p = runWizard({ ui, deps, flags: {}, out: "out", proc, now: () => 0 });
  while (!proc.listenerCount("exit")) await new Promise((r) => setImmediate(r));
  proc.emit("exit");
  assert.ok(written.includes("\x1b[?25h"));
  proc.emit("SIGHUP");
  assert.equal(await p, 130);
  assert.equal(proc.listenerCount("SIGHUP"), 0);
});

test("models that share a display name show their id as the hint", async () => {
  const ui = fakeUi();
  const models = [{ id: "a/haiku", name: "Claude Haiku 4.5" }, { id: "b/haiku", name: "Claude Haiku 4.5" }, { id: "c/opus", name: "Claude Opus" }];
  const { deps } = fakeDeps({ startAgent: async () => ({ models, currentModel: "b/haiku", close: async () => {} }) });
  await run(ui, deps);
  const modelSel = kinds(ui, "select").find((c) => c[1].message === "Which model?");
  assert.deepEqual(modelSel[1].options.map((o) => o.hint), ["a/haiku", "current · b/haiku", undefined]);
});
