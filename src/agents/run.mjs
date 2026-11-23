// The narrative and the model practices through the person's chosen agent:
// one session for both steps (narrative turn first, then the practices
// batches), every answer read as the first balanced JSON object and checked
// before anything is used. The agent's transcript is removed afterwards.
import { appendFileSync } from "node:fs";
import { PRACTICES_WARN_WHAT, classifyPractices } from "../practices-llm.mjs";
import { MODEL, anthropicCall, narrativeSystem, validateNarrative, warnApiKey } from "../profile-llm.mjs";
import { AgentAuthError, AgentStartError, ModelNotOfferedError, ToolUseError, startAgent } from "./acp.mjs";
import { firstJsonObject } from "./json-answer.mjs";

// Fixed at session start for agents that take a system prompt there, and put in front of
// every turn for the ones that do not; the turn's own instructions travel in the message.
export const RUN_SYSTEM = "Do not use any tool. Answer only from the text in this message, and reply with the JSON object it asks for, nothing else.";

const MAX_MODEL = 120;

// The hub takes 1 to 120 printable characters or null: cut and clean what the agent reports.
function boundModel(m) {
  if (typeof m !== "string") return null;
  const clean = [...m.replace(/[\p{C}\p{Z}]/gu, (c) => (c === " " ? " " : ""))].slice(0, MAX_MODEL).join("").trim();
  return clean || null;
}

const typed = (e) =>
  e instanceof ToolUseError || e instanceof AgentAuthError || e instanceof AgentStartError || e instanceof ModelNotOfferedError || e?.name === "AbortError";

/**
 * Run the narrative turn, then the practices batches, with `agent` (a registry entry).
 *
 * @returns {Promise<{ narrative: object, practicesAnswers: object | null, used: { agent: string, model: string | null } }>}
 * `practicesAnswers` is null when there is no `practicesInput`. Typed failures
 * (ToolUseError, AgentAuthError, AgentStartError, ModelNotOfferedError with
 * `offered`, AbortError) are thrown as they are; any other failure names the agent.
 * Every turn after the first runs in a new session on the same agent process, so
 * no answer sees an earlier one. `start` replaces startAgent (tests). `session` (and the
 * `runDir` its "started" event reported) hands in an agent the caller already started, for
 * instance to read its models first; the run closes it like one it started itself.
 * `warn` replaces the API path's stderr notice (the wizard shows it in its consent note).
 */
export async function runWithAgent({ agent, model, narrativeInput, practicesInput, onStatus = () => {}, logFile, signal, start = startAgent, session: given = null, runDir: givenDir = null, warn = warnApiKey }) {
  const label = agent.label ?? agent.id;
  const fail = (e) => {
    if (signal?.aborted) return e?.name === "AbortError" ? e : Object.assign(new Error("aborted"), { name: "AbortError" });
    return typed(e) ? e : new Error(`${label}: ${e.message}`);
  };

  async function steps(ask, before = () => {}) {
    before("narrative");
    // like a practices batch: one more try, in a new session, when the answer holds no JSON or does not fit
    let narrative;
    for (let attempt = 0; !narrative; attempt++) {
      onStatus({ step: "narrative", retry: attempt > 0 });
      const text = await ask(narrativeSystem(narrativeInput.language), JSON.stringify(narrativeInput));
      try {
        narrative = validateNarrative(firstJsonObject(text), agent.id);
      } catch (e) {
        if (attempt >= 1) throw new Error(`the narrative answer cannot be used: ${e.message}`);
      }
    }
    let practicesAnswers = null;
    if (practicesInput) {
      before("practices");
      practicesAnswers = await classifyPractices(practicesInput, {
        retries: 1,
        onBatch: (b) => onStatus({ step: "practices", ...b }),
        call: ({ system, user }) => ask(system, user),
      });
    }
    return { narrative, practicesAnswers };
  }

  if (agent.kind === "api") {
    if (model && model !== MODEL) throw Object.assign(new ModelNotOfferedError(model), { offered: [MODEL] });
    const call = anthropicCall(process.env.ANTHROPIC_API_KEY, { signal });
    const out = await steps(
      (system, user) => {
        if (signal?.aborted) throw fail(new Error("aborted"));
        return call({ system, user });
      },
      (step) => (step === "narrative" ? warn() : warn(PRACTICES_WARN_WHAT)),
    );
    return { ...out, used: { agent: agent.id, model: MODEL } };
  }

  const log = (extra) => {
    if (logFile) appendFileSync(logFile, JSON.stringify({ t: Date.now(), ...extra }) + "\n");
  };
  let runDir = givenDir;
  let session = given;
  try {
    session ??= await start(agent.spec({ system: RUN_SYSTEM }), {
      logFile,
      signal,
      onEvent: (e) => {
        if (e.kind === "started") runDir = e.cwd;
      },
    });
    if (model) {
      try {
        await session.setModel(model);
      } catch (e) {
        if (e instanceof ModelNotOfferedError) e.offered = session.models.map((m) => m.id);
        throw e;
      }
    }
    const used = { agent: agent.id, model: boundModel(model ?? session.currentModel) };
    let turns = 0;
    const out = await steps(async (system, user) => {
      if (turns++ > 0) await session.renew();
      return (await session.prompt(`${system}\n\n${user}`, { system: RUN_SYSTEM })).text;
    });
    return { ...out, used };
  } catch (e) {
    throw fail(e);
  } finally {
    try {
      await session?.close();
    } catch {
      // the transcript cleanup below still runs, and the run's own error stays
    }
    if (runDir) {
      let removed = [];
      try {
        removed = agent.cleanup(runDir) ?? [];
      } catch {
        // a cleanup that cannot run must not hide the run's own result
      }
      log({ dir: "cleanup", removed: removed.length });
    }
  }
}
