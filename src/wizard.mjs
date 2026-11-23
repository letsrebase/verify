// The interactive path of `npx @letsrebase/verify`: read the sources, choose an
// agent and a model, consent, run, show the profile, offer to submit. It holds
// decisions and copy only; every step that touches the logs, the agents or
// the disk is injected, and the bin passes the same functions the sub-commands
// use. `ui` is the @clack/prompts surface.
import { rmSync } from "node:fs";
import { basename, join } from "node:path";
import { AGENT_RUN_MARKER } from "./agent-run.mjs";
import { spawnSync } from "node:child_process";
import { AgentAuthError, AgentStartError, ModelNotOfferedError, ToolUseError } from "./agents/acp.mjs";
import { RUN_SYSTEM } from "./agents/run.mjs";

const REDRAW_MS = 100;
const plural = (n, one, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;
const kilo = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

function money(c) {
  const amount = Number(c?.amount);
  if (!Number.isFinite(amount)) return null;
  return c.currency === "USD" || !c.currency ? `$${amount.toFixed(2)}` : `${amount.toFixed(2)} ${c.currency}`;
}

/** Seconds as the status line shows them: "42s", "1m 05s". */
function clock(ms) {
  const s = Math.max(0, Math.floor(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
}

/**
 * The spinner message for a step and what the event stream has reported so far. Before the
 * first written character the narrative says which phase it is in (waiting for the model, or
 * the model reasoning when the agent streams its thoughts), so a long first token never reads
 * as "0 chars"; the step's elapsed time, when given, ticks at the end.
 */
export function statusLine(status, { chars = 0, thought = 0, tokens = null, cost = null, elapsed = null } = {}) {
  const parts = [];
  if (status.step === "narrative") {
    parts.push("Writing the narrative");
    if (chars > 0) parts.push(`${kilo(chars)} chars`);
    else if (thought > 0) parts.push(`the model is reasoning (${kilo(thought)} chars)`);
    else parts.push("waiting for the model");
  } else parts.push("Classifying practices", `batch ${status.batch} of ${status.total}${status.retry ? " (again)" : ""}`);
  if (tokens != null) parts.push(`${kilo(tokens)} tokens`);
  const m = cost ? money(cost) : null;
  if (m) parts.push(m);
  if (elapsed != null) parts.push(clock(elapsed));
  return parts.join(" · ");
}

const downloadNote = (agent) => `Downloads ${agent.download} from npm with npx.`;

/** What the person agrees to, in the words of the agent that will run. */
export function consentText(agent) {
  const lines = [];
  if (agent.kind === "api") {
    lines.push(`These go to the Anthropic API with your key:`);
  } else {
    lines.push(`These go to ${agent.label} and to its model provider:`);
  }
  lines.push(
    `- the narrative input: project labels, README and CLAUDE.md excerpts, lines you added to CLAUDE.md or README over time, dependency names, commit subjects, sampled prompts, topics you researched and up to six compaction summaries;`,
    `- up to 60 sessions × 12 of your own messages, redacted, so the practices can be classified.`,
    ``,
    `rebase receives nothing until you choose to submit.`,
  );
  if (agent.download) lines.push(downloadNote(agent));
  if (agent.kind !== "api") lines.push(`A local log of the exchange is written to out/agent-log.jsonl.`);
  if (agent.kind === "api") {
    lines.push(
      `No tools are involved: it is a plain request.`,
      `To stay fully local until submit, stop here, unset ANTHROPIC_API_KEY and use the /rebase-verify slash command instead.`,
    );
  } else if (agent.id === "omp" || agent.id === "claude-code") {
    lines.push(`${agent.label} starts with its tools switched off, and the run stops if it tries to use one.`);
  } else if (agent.id === "codex") {
    lines.push(`${agent.label} runs read-only with an instruction not to use tools, and the run stops if it tries to use one.`);
  } else {
    lines.push(`Whether ${agent.label} lets us switch its tools off is not known. The run stops if it tries to use one, and nothing it wrote is kept.`);
  }
  if (agent.id === "omp" || agent.id === "codex") {
    lines.push(`${agent.label} keeps a transcript of the run; rebase-verify removes it afterwards and never reads it.`);
  }
  return lines.join("\n");
}

/** The one-line reason the wizard cannot take these flags, or null. They belong to a sub-command. */
export function rejectedFlags(has) {
  const bad = ["narrative-file", "dry-run"].filter((f) => has(f));
  return bad.length ? `${bad.map((f) => `--${f}`).join(" and ")} ${bad.length > 1 ? "need" : "needs"} a sub-command (generate, finalize or submit); the wizard does not use ${bad.length > 1 ? "them" : "it"}.` : null;
}

// Last resort when the process is going down while an agent is alive: the agent runs in its
// own process group, which a dying parent does not take with it.
function killGroup(pid) {
  if (!pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(pid), "/T", "/F"], { windowsHide: true });
  else {
    try {
      process.kill(-pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
}

const NO_AGENT_NOTE = [
  `rebase-verify writes your profile with a coding agent you already use,`,
  `and none was found on this machine (and no ANTHROPIC_API_KEY is set).`,
  ``,
  `Two ways forward:`,
  `1. Install one of the tested agents, then run this again:`,
  `   - oh-my-pi (omp): install omp from https://github.com/can1357/oh-my-pi`,
  `   - Claude Code: install Claude Code from https://claude.com/claude-code`,
  `   - Codex: install Codex from https://github.com/openai/codex`,
  `2. Or use the /rebase-verify slash command from a clone of the repository,`,
  `   inside the agent you use.`,
].join("\n");

/**
 * @param {object} p
 * @param {object} p.ui clack: intro, outro, cancel, note, log, spinner, multiselect, select, confirm, isCancel
 * @param {object} p.deps sources, availableAgents, defaultAgent, startAgent, runWithAgent, submit,
 *   sendNotice() -> the text of the screen shown before the question about sending, and the
 *   steps that read and compute, all async so the spinner keeps moving while they work:
 *   readSource(id, { onProgress }) -> { sessions } | null, prepare(ids, { onStep }) -> { narrativeInput, practicesInput },
 *   finish(run, { onStep }) -> { sessions, products, practices, summary }
 * @param {{ version?: string, agent?: string, model?: string }} p.flags
 * @returns {Promise<number>} the process exit code
 */
export async function runWizard({ ui, deps, flags = {}, out, proc = process, now = Date.now }) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  const kill = deps.killGroup ?? killGroup;
  // only ever a run dir of ours
  const removeDir = deps.removeDir ?? ((d) => basename(d).startsWith(AGENT_RUN_MARKER) && rmSync(d, { recursive: true, force: true }));
  let agent = null;
  let session = null;
  let runDir = null;
  let pid = null;
  let sessionHandedOver = false;
  let chosenModel;

  // Closes an agent the wizard still owns, then removes the transcript its session left
  // (best effort). Once the run has the session, the run does both itself.
  const closeSession = async () => {
    if (sessionHandedOver) return;
    try {
      await session?.close();
    } catch {
      // the run's own outcome stays
    }
    session = null;
    if (runDir && agent?.cleanup) {
      try {
        agent.cleanup(runDir);
      } catch {
        // a cleanup that cannot run must not hide the outcome
      }
    }
    runDir = null;
  };
  // The process is exiting while an agent may be alive (a signal the wizard did not see,
  // an uncaught error): kill its group, remove the run dir and its transcript, synchronously.
  const onExit = () => {
    proc.stdout?.write?.("\x1b[?25h");
    kill(pid);
    if (runDir) {
      try {
        removeDir(runDir);
      } catch {}
      try {
        agent?.cleanup?.(runDir);
      } catch {}
    }
    if (!proc.exitCode) proc.exitCode = 130;
  };
  const cancelled = async (v) => {
    if (!ui.isCancel(v)) return false;
    await closeSession();
    ui.cancel("Stopped. Nothing was sent.");
    return true;
  };

  ui.intro(`rebase-verify${flags.version ? ` ${flags.version}` : ""}`);

  // 1. Sources, one spinner each so the counts appear as they finish. The reading runs off the
  // main thread (deps.readSource is async), so the spinner keeps moving and shows the files so far.
  const found = [];
  for (const src of deps.sources) {
    const s = ui.spinner();
    s.start(`Reading ${src.label}`);
    let read = null;
    try {
      read = await deps.readSource(src.id, {
        onProgress: ({ done, total }) => s.message(`Reading ${src.label} (${done} of ${plural(total, "file")})`),
      });
    } catch {
      read = null;
    }
    const n = read?.sessions ?? 0;
    s.stop(read ? `${src.label}: ${plural(n, "session")}` : `${src.label}: could not be read`);
    if (n > 0) found.push({ ...src, count: n });
  }
  if (!found.length) {
    ui.cancel("No sessions found in your logs, so there is nothing to build a profile from. Nothing was sent.");
    return 1;
  }
  const chosen = await ui.multiselect({
    message: "Which sources should the profile be built from?",
    options: found.map((f) => ({ value: f.id, label: f.label, hint: plural(f.count, "session") })),
    initialValues: found.map((f) => f.id),
    required: true,
  });
  if (await cancelled(chosen)) return 130;
  const picked = found.filter((f) => chosen.includes(f.id));

  // 2. The profile inputs, from the chosen sources only.
  const sessionsBySource = Object.fromEntries(found.map((f) => [f.id, f.count]));
  const ps = ui.spinner();
  ps.start("Building your profile from the logs");
  let prepared;
  try {
    prepared = await deps.prepare(picked.map((f) => f.id), { onStep: (m) => ps.message(`Building your profile: ${m.toLowerCase()}`) });
  } catch (e) {
    ps.error(`Could not build the profile: ${e.message}`);
    return 1;
  }
  ps.stop("Profile inputs ready");

  // 3. Agent.
  const agents = deps.availableAgents(sessionsBySource);
  if (!agents.length) {
    ui.note(NO_AGENT_NOTE, "No coding agent found");
    ui.cancel("Nothing was written or sent.");
    return 1;
  }
  if (flags.agent) {
    agent = agents.find((a) => a.id === flags.agent);
    if (!agent) {
      ui.log.error(`Agent "${flags.agent}" is not installed. Found: ${agents.map((a) => a.id).join(", ")}.`);
      return 2;
    }
  } else {
    const first = deps.defaultAgent(agents);
    const id = await ui.select({
      message: "Which agent should write your profile?",
      options: agents.map((a) => ({
        value: a.id,
        label: a.label,
        hint: `${plural(a.sessions, "session")} in your logs · ${a.tested ? "tested" : "not tested"}${a.download ? ` · ${downloadNote(a).replace(/\.$/, "")}` : ""}`,
      })),
      initialValue: first.id,
    });
    if (await cancelled(id)) return 130;
    agent = agents.find((a) => a.id === id);
  }

  // The agent is started once: its models are read from the session the run then uses.
  const fail = async (e) => {
    await closeSession();
    if (e?.name === "AbortError" || ctl.signal.aborted) {
      ui.cancel("Stopped. Nothing was sent.");
      return 130;
    }
    if (e instanceof AgentAuthError) ui.log.error(`${agent.label} is not logged in: ${agent.loginHint}.`);
    else if (e instanceof ToolUseError) ui.log.error("The agent tried to use a tool; nothing it wrote was kept.");
    else if (e instanceof ModelNotOfferedError) ui.log.error(`${agent.label} does not offer model "${chosenModel ?? flags.model}"${e.offered?.length ? `. It offers: ${e.offered.join(", ")}` : ""}.`);
    else if (e instanceof AgentStartError) ui.log.error(`${e.message}.`);
    else ui.log.error(e?.message ?? String(e));
    ui.cancel("Nothing was sent.");
    return 2;
  };

  const live = { chars: 0, thought: 0, tokens: null, cost: null, elapsed: null };
  let paint = () => {};
  const onEvent = (e) => {
    if (e.kind === "started") {
      runDir = e.cwd;
      pid = e.pid ?? null;
    }
    else if (e.kind === "turn-start") {
      live.chars = 0;
      live.thought = 0;
    }
    else if (e.kind === "agent_message_chunk" && e.content?.type === "text") live.chars += e.content.text.length;
    else if (e.kind === "agent_thought_chunk" && e.content?.type === "text") live.thought += e.content.text.length;
    else if (e.kind === "usage_update") {
      if (Number.isFinite(e.used)) live.tokens = e.used;
      if (e.cost) live.cost = e.cost;
    } else return;
    paint();
  };

  proc.on("SIGINT", stop);
  proc.on("SIGTERM", stop);
  proc.on("SIGHUP", stop);
  try {
    let model;
    if (agent.kind === "api") {
      model = flags.model;
    } else {
      const s = ui.live({ onCancel: stop });
      s.start(`Starting ${agent.label}`);
      proc.on("exit", onExit);
      try {
        session = await deps.startAgent(agent.spec({ system: RUN_SYSTEM }), { logFile: `${out}/agent-log.jsonl`, signal: ctl.signal, onEvent });
      } catch (e) {
        s.error(`Could not start ${agent.label}`);
        return await fail(e);
      }
      s.stop(`${agent.label} is ready`);
      const models = session.models ?? [];
      if (flags.model) {
        chosenModel = flags.model;
        if (!models.some((m) => m.id === flags.model)) return await fail(Object.assign(new ModelNotOfferedError(flags.model), { offered: models.map((m) => m.id) }));
        model = flags.model;
      } else if (models.length) {
        const names = models.map((o) => o.name ?? o.id);
        const m = await ui.select({
          message: "Which model?",
          options: models.map((o, i) => {
            const dup = names.filter((n) => n === names[i]).length > 1;
            const hint = [o.id === session.currentModel ? "current" : null, dup ? o.id : null].filter(Boolean).join(" · ");
            return { value: o.id, label: names[i], hint: hint || undefined };
          }),
          initialValue: session.currentModel ?? models[0].id,
        });
        if (await cancelled(m)) return 130;
        model = m;
        chosenModel = m;
      } else {
        ui.log.info(`${agent.label} offers no model choice: its default model will be used.`);
      }
    }

    // 4. Consent.
    ui.note(consentText(agent), "Before anything is sent");
    const ok = await ui.confirm({ message: `Send this to ${agent.label} and continue?`, initialValue: true });
    if (await cancelled(ok)) return 130;
    if (!ok) {
      await closeSession();
      ui.cancel("Stopped. Nothing was written or sent.");
      return 0;
    }

    // 5. The run, with live status.
    const spin = ui.live({ onCancel: stop });
    spin.start(`Starting the run with ${agent.label}`);
    let status = { step: "narrative" };
    let last = -Infinity;
    let stepStart = now();
    paint = () => {
      const t = now();
      if (t - last < REDRAW_MS) return;
      last = t;
      live.elapsed = t - stepStart;
      spin.message(statusLine(status, live));
    };
    // A first token can take a minute: the elapsed time ticks even when the agent sends nothing.
    const tick = setInterval(() => paint(), 1000);
    tick.unref?.();
    let result;
    try {
      sessionHandedOver = true;
      result = await deps.runWithAgent({
        agent,
        model,
        narrativeInput: prepared.narrativeInput,
        practicesInput: prepared.practicesInput,
        logFile: `${out}/agent-log.jsonl`,
        signal: ctl.signal,
        warn: () => {},
        session: session ?? undefined,
        runDir: runDir ?? undefined,
        onStatus: (s) => {
          status = s;
          live.chars = 0;
          live.thought = 0;
          stepStart = now();
          last = -Infinity;
          paint();
        },
      });
    } catch (e) {
      spin.error(ctl.signal.aborted || e?.name === "AbortError" ? "Stopped" : `${agent.label} could not finish`);
      return await fail(e);
    } finally {
      clearInterval(tick);
      // the run has closed the agent and removed what it left: nothing for the exit net to do
      proc.off("exit", onExit);
      // from here on Ctrl-C belongs to whatever comes next (the sign-in wait of submit)
      proc.off("SIGINT", stop);
      proc.off("SIGTERM", stop);
      proc.off("SIGHUP", stop);
    }
    spin.stop("The narrative and the practices are ready");
    session = null;

    // 6. The profile.
    const assembling = ui.spinner();
    assembling.start("Assembling your profile");
    let done;
    try {
      done = await deps.finish(result, { onStep: (m) => assembling.message(`Assembling your profile: ${m.toLowerCase()}`) });
    } catch (e) {
      assembling.error("Could not assemble your profile");
      return await fail(e);
    }
    assembling.stop("Your profile is ready");
    const rows = (done.practices ?? []).map((p) => `  ${p.id}: seen in ${p.seen} of ${p.of}`);
    ui.note(
      [
        `${plural(done.sessions, "session")} read, ${plural(done.products, "product")}.`,
        ...(done.summary ? [``, done.summary] : []),
        ...(rows.length ? [``, `How the work is done (sessions where it was seen):`, ...rows] : []),
        ``,
        `Read the full profile: ${join(out, "profile.md")}`,
      ].join("\n"),
      "Your profile",
    );
    // The screen that says who receives what comes first and is never skipped; then one question,
    // whose first and default answer is to send. Anything but that answer (no, Ctrl-C) sends nothing.
    ui.note(deps.sendNotice(), "What leaves your machine, and who receives it");
    const choice = await ui.select({
      message: `Send this profile to rebase? It is what rebase will see (${join(out, "profile.md")}).`,
      options: [
        { value: "send", label: "Send it to rebase" },
        { value: "exit", label: "Do not send", hint: "send later with: npx @letsrebase/verify submit --yes" },
      ],
      initialValue: "send",
    });
    if (await cancelled(choice)) return 130;
    if (choice === "send") {
      await deps.submit();
      ui.outro("Sent.");
    } else {
      ui.outro("Done. Nothing was sent. To send it later: npx @letsrebase/verify submit --yes");
    }
    return 0;
  } finally {
    await closeSession();
    proc.off("SIGINT", stop);
    proc.off("SIGTERM", stop);
    proc.off("SIGHUP", stop);
    proc.off("exit", onExit);
  }
}
