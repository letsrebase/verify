#!/usr/bin/env node
// rebase-verify: turn your Claude Code logs into a tamper-evident, PII-redacted
// work profile (playnew-profile/v1).
//
// Sub-commands (default: generate, save locally, no submit):
//
//   rebase-verify                     # = rebase-verify generate
//   rebase-verify generate            # build out/profile.md + out/candidate.json locally
//   rebase-verify generate --agent <id> [--model <id>]
//                                     # the same, the narrative written and the practices classified
//                                     # by one of your coding agents (see src/agents/registry.mjs)
//   rebase-verify prepare             # only emit out/narrative-input.json (no narrative), plus
//                                     # out/practices-input.json and out/practices-sample.json
//   rebase-verify finalize            # finalize using --narrative-file out/narrative.json
//   rebase-verify submit              # sign in in the browser, then send out/candidate.json to rebase
//   rebase-verify --version | -v      # print the package version and exit
//
// Everything generated lands in ./out, one folder to inspect, one to delete,
// one line of .gitignore. Nothing is written to the repo root.
//
// Common flags:
//   --root <dir>                   # logs root (default ~/.claude/projects)
//   --hub <url|preview>            # rebase hub for submit (default https://letsrebase.com,
//                                  # or REBASE_VERIFY_HUB_URL; "preview" = preview.letsrebase.com)
//   --top 4                        # force the number of representative projects
//                                  # (default: adaptive, 3 to 5)
//   --tz Europe/Rome               # timezone for day and month counts (activeDays,
//                                  # streak, technology-usage months). Default UTC;
//                                  # recorded in the profile.
//   --narrative-file narrative.json
//
// Four ways to provide the narrative step (the qualitative prose):
//   A. Inside Claude Code via .claude/commands/rebase-verify.md, uses the
//      candidate's own subscription, no API key needed.
//   B. With the Claude API:  set ANTHROPIC_API_KEY and run `generate`.
//   C. Manually:  `prepare` -> hand-write narrative.json -> `finalize`.
//   D. With your coding agent over ACP:  `generate --agent <id>`.

import { homedir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { writeFileSync, existsSync, readFileSync, mkdirSync, rmSync } from "node:fs";
import { readClaudeCode } from "../src/adapters/claude-code.mjs";
import { SOURCES, readSource, combineSources, readAllSources } from "../src/sources.mjs";
import { computeFingerprint } from "../src/fingerprint.mjs";
import { computeForensics } from "../src/forensics.mjs";
import { buildDigest } from "../src/digest.mjs";
import { practicesFiles } from "../src/practices-sample.mjs";
import { PRACTICES_WARN_WHAT, runPracticesStep } from "../src/practices-llm.mjs";
import { enrichRepo, describeContextGaps } from "../src/enrich.mjs";
import { MODEL, anthropicCall, generateNarrative, narrativeInputFor, warnApiKey } from "../src/profile-llm.mjs";
import { selectRepresentatives, assembleProfile, renderMarkdown, summarizeSources } from "../src/profile.mjs";
import { resolveHub } from "../src/hub.mjs";
import { submitProfile, buildPayload } from "../src/submit.mjs";
import { buildTrajectory } from "../src/trajectory.mjs";
import { DEFAULT_LANGUAGE, SUPPORTED_LANGUAGES, isSupportedLanguage } from "../src/languages.mjs";
import { assessGroundedness } from "../src/groundedness.mjs";
import { assessStructure, assessAgainstLogs, submitBlockers } from "../src/consistency.mjs";
import { computeAiRelationship } from "../src/ai-relationship.mjs";
import { computeAgenticLiteracy } from "../src/agentic-literacy.mjs";
import { computeIntensity } from "../src/intensity.mjs";
import { computeDistribution } from "../src/distribution.mjs";
import { computeTechUsage, recordedTechUsageTz } from "../src/tech-usage.mjs";
import { computeCodePractices, mergeModelPractices, practicesBlock, recordedPracticesTz } from "../src/practices.mjs";
import { DEFAULT_TZ } from "../src/days.mjs";
import { invocation } from "../src/invocation.mjs";

// Friendly Node floor (package.json `engines` is advisory only when invoked
// as `node bin/rebase-verify.mjs`). Imports hoist and evaluate before this line
// runs, so the check only protects us while src/ stays free of import-time
// Node-20-only syntax and builtins, true today: fetch / FormData /
// structuredClone all live inside function bodies, and everything parses as
// ES2022. Without this, old Node dies later with a bare ReferenceError.
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
if (nodeMajor < 20 || (nodeMajor === 20 && nodeMinor < 12)) {
  console.error(`rebase-verify needs Node 20.12 or newer; you're running ${process.version}.`);
  console.error(`Install a current Node from https://nodejs.org (or: nvm install 20).`);
  process.exit(1);
}

if (process.argv[2] === "--version" || process.argv[2] === "-v") {
  const pkgUrl = new URL("../package.json", import.meta.url);
  console.log(JSON.parse(readFileSync(fileURLToPath(pkgUrl), "utf8")).version);
  process.exit(0);
}

const SUB_COMMANDS = new Set(["generate", "prepare", "finalize", "submit"]);

const argv = process.argv.slice(2);
const sub = argv[0] && !argv[0].startsWith("--") ? argv[0] : "generate";
if (!SUB_COMMANDS.has(sub)) {
  console.error(`Unknown command: ${sub}. Expected: ${[...SUB_COMMANDS].join(" | ")}`);
  process.exit(1);
}
const flag = (n, d = null) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : d;
};
const has = (n) => argv.includes(`--${n}`);

// The `sources` shape readAllSources() expects, read from CLI flags. Called
// from TWO places (loadProfileInputs and the submit command) that must never
// drift: submit re-derives ground truth from the SAME source mix the profile
// was generated from, otherwise a merged profile (claude-code + opencode + codex + pi + omp + cursor + kimi)
// trips the tamper signal because volume.sessions > re-derived sessions.
function sourceFlags() {
  return {
    opencode: { root: flag("opencode-root"), disabled: has("no-opencode"), json: has("opencode-json") },
    codex: { root: flag("codex-root"), disabled: has("no-codex") },
    pi: { root: flag("pi-root"), disabled: has("no-pi") },
    omp: { root: flag("omp-root"), disabled: has("no-omp") },
    cursor: { root: flag("cursor-root"), disabled: has("no-cursor") },
    kimi: { root: flag("kimi-root"), disabled: has("no-kimi") },
  };
}

// Validate --tz up front, before reading any logs, an unknown zone should fail
// fast, not throw mid-pipeline from inside Intl.DateTimeFormat.
const tzFlag = flag("tz", DEFAULT_TZ);
try {
  new Intl.DateTimeFormat("en-CA", { timeZone: tzFlag }).format(0);
} catch {
  console.error(`Invalid --tz "${tzFlag}". Expected an IANA timezone, e.g. UTC or Europe/Rome.`);
  process.exit(2);
}

// Validate --lang the same way: the language is the profile's, so it is checked before anything is read.
const langFlag = flag("lang", DEFAULT_LANGUAGE);
if (!isSupportedLanguage(langFlag)) {
  console.error(`Invalid --lang "${langFlag}". Expected one of: ${SUPPORTED_LANGUAGES.join(", ")}.`);
  process.exit(2);
}

// Every generated file (narrative-input.json, narrative.json, practices-input.json,
// practices-sample.json, practices.json, practices-detail.json, agent-log.jsonl,
// candidate.json, profile.md) lands in ./out, never in the repo root.
const OUT_DIR = "out";
// How to run this tool again, as the person started it (npx, an installed bin, a clone).
const CMD = invocation();
const outPath = () => join(process.cwd(), OUT_DIR);
// Created only once logs were found. A `*` .gitignore inside keeps every file in it out of a commit.
const ensureOut = () => {
  const out = outPath();
  mkdirSync(out, { recursive: true });
  const ignore = join(out, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return out;
};

// The wizard, the agent runner and their dependencies load only where they are used, so the
// sub-commands work in a clone that never ran npm ci.
async function loadOptional(load) {
  try {
    return await load();
  } catch (e) {
    if (e?.code === "ERR_MODULE_NOT_FOUND" && /@clack\/prompts|@agentclientprotocol/.test(e.message)) {
      die("Run it with npx @letsrebase/verify, or run npm ci in this folder first.");
    }
    throw e;
  }
}
const loadAgents = () =>
  loadOptional(async () => ({
    registry: await import("../src/agents/registry.mjs"),
    acp: await import("../src/agents/acp.mjs"),
    run: await import("../src/agents/run.mjs"),
  }));

// Who wrote what, as the profile records it. The slash command (and a hand-written
// narrative) reaches `finalize` through files, so its model is not known.
const SLASH_COMMAND = { agent: "slash-command", model: null };
const API_KEY_PATH = { agent: "anthropic-api", model: MODEL };

const die = (msg, code = 2) => {
  console.error(msg);
  process.exit(code);
};

// The wizard owns the terminal while it runs: the pipeline's progress lines stay quiet then.
let QUIET = false;
const say = (...a) => { if (!QUIET) console.log(...a); };
const warn = (...a) => { if (!QUIET) console.error(...a); };

// The agent behind `generate --agent <id>`, checked before any log is read.
async function resolveAgent() {
  if (!has("agent")) {
    if (has("model")) die("--model needs --agent <id>.");
    return null;
  }
  const { AGENTS } = (await loadAgents()).registry;
  const ids = AGENTS.map((a) => a.id).join(", ");
  const id = flag("agent");
  if (!id) die(`--agent needs an id. Agents: ${ids}`);
  const entry = AGENTS.find((a) => a.id === id);
  if (!entry) die(`Unknown agent "${id}". Agents: ${ids}`);
  if (!entry.detect({ env: process.env }).installed) {
    die(entry.kind === "api" ? `${entry.label} is not set up: ${entry.installHint}.` : `${entry.label} is not installed: ${entry.installHint}.`);
  }
  if (flag("narrative-file")) die("--agent writes the narrative itself; drop --narrative-file.");
  if (has("model") && !flag("model")) die("--model needs a model id.");
  return entry;
}

// One agent run for both steps. Ctrl-C or SIGTERM aborts it (the agent runs in
// its own process group, so the terminal's signal does not reach it); the run
// removes its temp dir and transcript before the abort comes back.
async function runAgentStep(entry, { out, narrativeInput }) {
  const { acp, run } = await loadAgents();
  const { AgentAuthError, AgentStartError, ModelNotOfferedError, ToolUseError } = acp;
  const { runWithAgent } = run;
  const inputFile = join(out, "practices-input.json");
  const practicesInput = existsSync(inputFile) ? JSON.parse(readFileSync(inputFile, "utf8")) : null;
  const model = flag("model");
  console.log(`[4/5] Narrative${practicesInput ? " and practices" : ""} with ${entry.label}${model ? ` (${model})` : ""} ...`);
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  process.once("SIGHUP", stop);
  try {
    return await runWithAgent({
      agent: entry,
      model,
      narrativeInput,
      practicesInput,
      logFile: join(out, "agent-log.jsonl"),
      signal: ctl.signal,
      onStatus: (s) =>
        console.log(s.step === "narrative" ? "      writing the narrative ..." : `      classifying practices, batch ${s.batch} of ${s.total}${s.retry ? " (again)" : ""} ...`),
    });
  } catch (e) {
    if (e?.name === "AbortError") die("Stopped.", 130);
    if (e instanceof AgentAuthError) die(`${entry.label} is not logged in: ${entry.loginHint}.`);
    if (e instanceof ToolUseError) die("The agent tried to use a tool; nothing it wrote was kept.");
    if (e instanceof ModelNotOfferedError) die(`${entry.label} does not offer model "${model}"${e.offered?.length ? `. It offers: ${e.offered.join(", ")}` : ""}.`);
    if (e instanceof AgentStartError) die(`${e.message}.`);
    return die(`${e.message}`);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    process.off("SIGHUP", stop);
  }
}

function logsRoot() {
  let root = flag("root", join(homedir(), ".claude", "projects"));
  if (flag("project")) root = join(root, flag("project"));
  return root;
}

async function loadProfileInputs() {
  const root = logsRoot();
  if (!existsSync(root)) { console.error(`No logs at ${root}.`); process.exit(1); }

  say(`[1/5] Reading ${root} ...`);
  // Sources: claude-code is always read; opencode is folded in unless
  // --no-opencode says otherwise. --opencode-json forces the JSON backend
  // over the default sqlite (more complete but slower on huge logs).
  const parsed = readAllSources({ claudeRoot: root, sources: sourceFlags() });
  say(`      claude-code: ${parsed.sessions.filter(s => s.source === "claude-code").length} sessions`);
  const oc = parsed.sessions.filter(s => s.source === "opencode");
  if (oc.length) {
    // Surface WHICH backend read opencode: the sqlite db is far more complete
    // than the JSON cache, so a silent fallback to JSON is a coverage drop the
    // user should see, not discover later.
    const backend = parsed.backends?.opencode;
    say(`      opencode${backend ? ` (${backend})` : ""}:    ${oc.length} sessions`);
  }
  const cx = parsed.sessions.filter(s => s.source === "codex");
  if (cx.length) say(`      codex:       ${cx.length} sessions`);
  const pi = parsed.sessions.filter(s => s.source === "pi");
  if (pi.length) say(`      pi:          ${pi.length} sessions`);
  const om = parsed.sessions.filter(s => s.source === "omp");
  if (om.length) say(`      omp:         ${om.length} sessions`);
  const cu = parsed.sessions.filter(s => s.source === "cursor");
  if (cu.length) say(`      cursor:      ${cu.length} sessions`);
  const ki = parsed.sessions.filter(s => s.source === "kimi");
  if (ki.length) say(`      kimi:        ${ki.length} sessions`);
  return deriveInputs(parsed, ensureOut());
}

// Everything computed from the parsed logs; the wizard passes the sources the person chose.
function deriveInputs(parsed, out) {
  // Timezone the day-based counts (activeDays, streak) are bucketed in. Default
  // UTC (machine-independent); recorded in the profile so the count reproduces.
  // Validated at startup (tzFlag) before any logs are read.
  const tz = tzFlag;

  say(`[2/5] Fingerprint, manifest, consistency ...`);
  const fingerprint = computeFingerprint(parsed, { tz });
  const forensics = computeForensics(parsed);

  say(`[3/5] Deep digest + per-repo clustering (PII redacted: ${parsed.redaction.hits}) ...`);
  const digest = buildDigest(parsed, { tz });
  const projects = selectRepresentatives(digest.projects, flag("top") ? +flag("top") : "auto");
  const selected = projects.filter((p) => p.selected);
  say(`      ${digest.projectCount} products, ${selected.length}${flag("top") ? "" : " (adaptive 3-5)"} representative: ${selected.map((p) => `${p.repo}[${p.type[0]}]`).join(", ")}`);

  const enrichments = selected.map((p) => enrichRepo(p.cwdRaw));
  const contextGap = describeContextGaps(enrichments);
  if (contextGap) warn(`      note: ${contextGap}`);
  const trajectory = buildTrajectory(parsed);
  const aiRelationship = computeAiRelationship(parsed);
  const agenticLiteracy = computeAgenticLiteracy(parsed);
  const intensity = computeIntensity(parsed, { tz });
  const distribution = computeDistribution(projects);
  const techUsage = computeTechUsage(projects, { tz });
  const practices = practicesBlock(computeCodePractices(parsed, { tz })?.items, { tz });
  const sources = summarizeSources(parsed);
  return { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, techUsage, practices, sources, out };
}

function writeProfile(out, profile, { print = true } = {}) {
  writeFileSync(join(out, "candidate.json"), JSON.stringify(profile, null, 2));
  const md = renderMarkdown(profile);
  writeFileSync(join(out, "profile.md"), md);
  if (!print) return;
  console.log(md);
  console.log(`Saved: ${OUT_DIR}/candidate.json + ${OUT_DIR}/profile.md`);
  console.log(`To send it to rebase when ready:  ${CMD} submit`);
}

// What the agent run adds to the profile: the answers merged into the practices block, who
// wrote the narrative. The answers stay in practices-detail.json, so a later finalize never
// reads them as the slash command's.
function applyAgentRun(out, codePractices, run) {
  if (run.practicesAnswers) writeFileSync(join(out, "practices.json"), JSON.stringify(run.practicesAnswers, null, 2));
  const practices = run.practicesAnswers ? mergePracticesAnswers(out, codePractices, run.used) : codePractices;
  rmSync(join(out, "practices.json"), { force: true });
  return { practices, narrative: run.narrative, generatedBy: { narrative: run.used } };
}

const narrativeOptionsOf = (i) => ({
  trajectory: i.trajectory,
  aiRelationship: i.aiRelationship,
  agenticLiteracy: i.agenticLiteracy,
  intensity: i.intensity,
  distribution: i.distribution,
  allProjects: i.projects,
  compactionSummaries: i.parsed.compactionSummaries,
  language: langFlag,
});

// The model-classified practices: written only when some are published and
// there is something to read. Both files stay local; the sample file maps the
// opaque ids back to real sessions and is never sent.
function writePracticesInput(out, parsed, tz) {
  // A stale sample from an earlier run must never be read by finalize.
  for (const f of ["practices-input.json", "practices-sample.json", "practices-detail.json", "practices.json"]) rmSync(join(out, f), { force: true });
  const shared = JSON.parse(readFileSync(new URL("../share/practices.json", import.meta.url), "utf8"));
  const practices = (shared.practices ?? []).filter((p) => p.method === "model");
  const files = practicesFiles(parsed, { tz, practices });
  if (!files) return;
  writeFileSync(join(out, "practices-input.json"), JSON.stringify(files.input, null, 2));
  writeFileSync(join(out, "practices-sample.json"), JSON.stringify(files.sample, null, 2));
  say(`Wrote ${OUT_DIR}/practices-input.json (${files.sample.length} sessions of your own messages, for your model to classify) and ${OUT_DIR}/practices-sample.json (local only).`);
}

async function cmdGenerate() {
  const entry = await resolveAgent();
  console.log(`\nrebase-verify generate\n`);
  const { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, techUsage, practices: codePractices, sources, out } = await loadProfileInputs();
  if (entry) rmSync(join(out, "agent-log.jsonl"), { force: true });
  writePracticesInput(out, parsed, tzFlag);
  const narrativeOptions = {
    trajectory,
    aiRelationship,
    agenticLiteracy,
    intensity,
    distribution,
    allProjects: projects,
    compactionSummaries: parsed.compactionSummaries,
    language: langFlag,
  };
  let practices;
  let narrative;
  let generatedBy;
  if (entry) {
    // Nothing is written until the agent has answered both steps and every answer checked out.
    const run = await runAgentStep(entry, { out, narrativeInput: narrativeInputFor(selected, enrichments, narrativeOptions) });
    ({ practices, narrative, generatedBy } = applyAgentRun(out, codePractices, run));
  } else {
    const key = process.env.ANTHROPIC_API_KEY;
    const step = await runPracticesStep(out, {
      key, call: key ? anthropicCall(key) : null,
      warn: () => warnApiKey(PRACTICES_WARN_WHAT),
    });
    practices = step === "written" ? mergePracticesAnswers(out, codePractices, API_KEY_PATH) : codePractices;
    if (step === "written") rmSync(join(out, "practices.json"), { force: true });

    console.log(`[4/5] Narrative ...`);
    const generated = await generateNarrative(selected, enrichments, { overrideFile: flag("narrative-file"), ...narrativeOptions });
    narrative = generated.narrative;
    if (!narrative) {
      writeFileSync(join(out, "narrative-input.json"), JSON.stringify(generated.input, null, 2));
      console.log(`      no narrative yet (no API key, no --narrative-file).`);
      console.log(`      From a clone, inside Claude Code:  /rebase-verify   (writes ${OUT_DIR}/narrative.json and finalizes)`);
      console.log(`      Manual:  write ${OUT_DIR}/narrative.json, then  ${CMD} finalize`);
      return;
    }
    if (generated.source === "api") generatedBy = { narrative: API_KEY_PATH };
  }

  console.log(`[5/5] Assembling and saving ...\n`);
  writeProfile(out, assembleWithGroundedness({
    projects, narrative, fingerprint, forensics, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, techUsage, practices, sources, generatedBy,
    manifestHash: fingerprint.manifest.bundleHash,
  }));
}

// Assemble + compute groundedness on the assembled draft + re-assemble with
// the score embedded. Centralised so generate and finalize share it.
function assembleWithGroundedness(args) {
  // The raw vocabularyCandidates never enter the profile (they can carry
  // client names), so a narrative that omitted its filtered pick leaves
  // newVocabulary empty. Say so instead of failing silently.
  if (args.narrative && args.trajectory?.vocabularyCandidates?.length && !args.narrative.trajectory?.vocabulary_adopted?.length) {
    warn(`      note: the narrative has no trajectory.vocabulary_adopted, newVocabulary stays empty (raw candidates are never used; re-run the narrative step to fill it)`);
  }
  const withLanguage = { language: langFlag, ...args };
  const draft = assembleProfile(withLanguage);
  const groundedness = assessGroundedness(draft);
  return assembleProfile({ ...withLanguage, groundedness });
}

async function cmdPrepare() {
  console.log(`\nrebase-verify prepare\n`);
  const { parsed, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, out } = await loadProfileInputs();
  writePracticesInput(out, parsed, tzFlag);
  const input = narrativeInputFor(selected, enrichments, {
    trajectory,
    aiRelationship,
    agenticLiteracy,
    intensity,
    distribution,
    allProjects: projects,
    compactionSummaries: parsed.compactionSummaries,
    language: langFlag,
  });
  writeFileSync(join(out, "narrative-input.json"), JSON.stringify(input, null, 2));
  console.log(`Wrote ${OUT_DIR}/narrative-input.json.`);
  console.log(`Next: write ${OUT_DIR}/narrative.json (rules in the slash command), then  ${CMD} finalize`);
}

// The model's answers, when the person's model wrote out/practices.json: checked
// against the sample file written at prepare (never resampled), then merged into
// the block, with who classified them. A bad or unreadable file stops the step;
// nothing is saved.
function mergePracticesAnswers(out, codeBlock, classifiedBy) {
  const answersFile = join(out, "practices.json");
  if (!existsSync(answersFile)) return codeBlock;
  const sampleFile = join(out, "practices-sample.json");
  const fail = (msg) => { console.error(`${msg} Fix it, or delete ${OUT_DIR}/practices.json to leave the model practices out.`); process.exit(2); };
  const read = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
  const sample = read(sampleFile);
  if (!Array.isArray(sample)) fail(`Missing or unreadable ${sampleFile}: run ${CMD} prepare again.`);
  const answers = read(answersFile);
  if (answers === undefined) fail(`${answersFile} is not valid JSON.`);
  const shared = JSON.parse(readFileSync(new URL("../share/practices.json", import.meta.url), "utf8"));
  const ids = (shared.practices ?? []).filter((p) => p.method === "model").map((p) => p.id);
  try {
    const { block, detail } = mergeModelPractices(codeBlock, answers, sample, ids, { tz: tzFlag, classifiedBy });
    writeFileSync(join(out, "practices-detail.json"), JSON.stringify(detail, null, 2));
    say(`Merged the model's answers for ${sample.length} sessions (per-session detail in ${OUT_DIR}/practices-detail.json, local only).`);
    return block;
  } catch (e) {
    return fail(`${answersFile}: ${e.message}.`);
  }
}

function preparedLanguage(out) {
  try {
    const code = JSON.parse(readFileSync(join(out, "narrative-input.json"), "utf8")).language;
    return isSupportedLanguage(code) ? code : null;
  } catch {
    return null;
  }
}

async function cmdFinalize() {
  console.log(`\nrebase-verify finalize\n`);
  const narrativeFile = flag("narrative-file", join(outPath(), "narrative.json"));
  if (!existsSync(narrativeFile)) {
    console.error(`Missing ${narrativeFile}. Run ${CMD} prepare first, then write ${OUT_DIR}/narrative.json.`);
    process.exit(2);
  }
  const { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, techUsage, practices, sources, out } = await loadProfileInputs();
  const merged = mergePracticesAnswers(out, practices, SLASH_COMMAND);
  // The narrative was written in the language `prepare` put in narrative-input.json; an explicit --lang wins.
  const language = has("lang") ? langFlag : preparedLanguage(out) ?? langFlag;
  const { narrative } = await generateNarrative(selected, enrichments, {
    overrideFile: narrativeFile,
    trajectory,
    aiRelationship,
    agenticLiteracy,
    intensity,
    distribution,
    allProjects: projects,
    compactionSummaries: parsed.compactionSummaries,
    language,
  });
  writeProfile(out, assembleWithGroundedness({
    language,
    projects, narrative, fingerprint, forensics, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, techUsage, practices: merged, sources,
    generatedBy: { narrative: SLASH_COMMAND },
    manifestHash: fingerprint.manifest.bundleHash,
  }));
}

async function cmdSubmit({ yes = false } = {}) {
  // Profiles live in ./out; fall back to the repo root for profiles
  // generated by a version that still wrote there.
  let profilePath = join(process.cwd(), OUT_DIR, "candidate.json");
  if (!existsSync(profilePath) && existsSync(join(process.cwd(), "candidate.json"))) {
    profilePath = join(process.cwd(), "candidate.json");
    console.log(`(using ./candidate.json from an older run, new runs write to ${OUT_DIR}/)`);
  }
  if (!existsSync(profilePath)) {
    console.error(`No ${OUT_DIR}/candidate.json yet. Generate the profile first:  ${CMD} generate`);
    process.exit(2);
  }
  const profile = JSON.parse(readFileSync(profilePath, "utf8"));
  const hub = resolveHub(flag("hub"));
  const links = (profile.projects || []).filter((p) => p.artifact).length;

  console.log(`\nrebase-verify submit\n`);
  console.log(`About to send to rebase (${hub}):`);
  console.log(`  profile: ${profile.volume?.sessions} sessions, ${profile.volume?.products} products`);
  console.log(`  artifact links: ${links}`);
  console.log(`\nYou sign in in the browser first, so rebase knows it is you; no name, email or city is sent with the profile.`);
  console.log(`A person at rebase reads it before it counts. If they approve it, your profile gets «Verificato da rebase»,`);
  console.log(`companies rebase works with can see its summary, its domains of work and the sectors of its representative projects, next to your name and your card (written by your model, reviewed by you), for example in the talent cloud or when rebase proposes you for a project, and its text is used to write your anonymous card.`);
  console.log(`It is kept at most 12 months, and you can delete it from your member area.`);
  console.log(`Controller: Rebase S.r.l. (VAT IT 14971460960). Details: https://letsrebase.com/privacy and PRIVACY.md.`);
  console.log(`NOT sent: raw logs, local repo context, third-party proper names.`);
  console.log(`Repository names (repoLabel) are stripped from the payload before it leaves your machine.`);
  console.log(`Inspect the exact outgoing payload:  ${CMD} submit --dry-run`);

  // Pre-flight groundedness: how much of the prose is anchored in the data.
  // Recomputed on the file as it is NOW, not trusted from the embedded score.
  const g = assessGroundedness(profile);
  console.log(`\nGroundedness check`);
  if (g.score == null) {
    console.log(`  not enough verifiable anchors in the prose (n/a)`);
  } else {
    console.log(`  ${g.score}% of prose anchors are supported by the structured data (${g.supported}/${g.total})`);
  }
  if (g.anomalies.length) {
    console.log(`  Unverifiable in your logs:`);
    for (const a of g.anomalies) console.log(`    - ${a.where}: "${a.anchor}" (${a.kind})`);
    console.log(`  Consider regenerating, or editing candidate.json before submitting.`);
  }
  const embedded = profile.groundedness?.score;
  if (g.score != null && embedded != null && Math.abs(g.score - embedded) > 5) {
    console.log(`  Note: the file says groundedness ${embedded}% but it recomputes to ${g.score}%, candidate.json was edited after generation.`);
  }

  // Pre-flight consistency: structural invariants, then re-derivation from
  // the logs (the ground truth the profile claims to describe).
  console.log(`\nConsistency check`);
  const issues = [...assessStructure(profile).issues];
  let excessClaims = 0;
  let root = flag("root", join(homedir(), ".claude", "projects"));
  if (flag("project")) root = join(root, flag("project"));
  if (existsSync(root)) {
    // Re-derive from the SAME source mix the profile was generated from
    // (see sourceFlags()'s comment for why this must never drift).
    const parsed = readAllSources({ claudeRoot: root, sources: sourceFlags() });
    // Re-derive day-based intensity and tech-usage months in the zone the
    // profile RECORDED, never the machine zone, so the comparison measures
    // the data, not the bucketing.
    const techTz = recordedTechUsageTz(profile);
    const digest = buildDigest(parsed, { tz: techTz });
    const intensity = computeIntensity(parsed, { tz: profile.intensity?.timezone || DEFAULT_TZ });
    const techUsage = computeTechUsage(digest.projects, { tz: techTz });
    const practices = computeCodePractices(parsed, { tz: recordedPracticesTz(profile) });
    const logs = assessAgainstLogs(profile, digest.projects, { intensity, techUsage, practices });
    issues.push(...logs.issues);
    excessClaims = logs.excessClaims || 0;
    for (const w of logs.warnings) console.log(`  ~ ${w}`);
  } else {
    console.log(`  ~ no logs at ${root}, skipping log re-derivation (pass --root if they live elsewhere)`);
  }
  if (issues.length) {
    console.log(`  The structured data does not match ${existsSync(root) ? "your logs / its own invariants" : "its own invariants"}:`);
    for (const i of issues) console.log(`    - ${i}`);
    if (excessClaims > 0) {
      // Claims exceed what the logs can prove now. Since normal use only ever
      // GROWS the logs, the usual cause is Claude Code's cleanup pruning the
      // oldest sessions between generation and submit, not anything the
      // candidate did wrong.
      console.log(`  Your profile claims more than your logs can prove right now. The usual cause:`);
      console.log(`  Claude Code prunes sessions older than its cleanup period (~30 days by default),`);
      console.log(`  and the oldest part of your window aged out after the profile was generated.`);
      console.log(`  Nothing is wrong with what you did: the numbers are just stale.`);
      console.log(`  Fix: regenerate now and submit right away (${CMD} generate, or re-run /rebase-verify).`);
    } else {
      console.log(`  If your logs were pruned since generation, regenerate (${CMD} generate).`);
    }
  } else {
    console.log(`  structured data is internally consistent and matches your logs`);
  }

  const blockers = submitBlockers({ issues, groundedness: g, force: has("force") });
  const printBlockers = () => {
    for (const b of blockers) {
      if (b.kind === "consistency") {
        console.error(`\nConsistency check failed (${b.count} issue${b.count > 1 ? "s" : ""}). Submission blocked.`);
        console.error(`Regenerate the profile (${CMD} generate) or pass --force to bypass.`);
        console.error(`Note: the intake re-checks groundedness and these invariants server-side.`);
      } else if (b.kind === "groundedness-unscored") {
        console.error(`\nGroundedness could not be scored: the prose has too few checkable anchors for the screen to run. Submission blocked.`);
        console.error(`Regenerate the profile (${CMD} generate) or pass --force to bypass.`);
        console.error(`Note: the intake flags unscoreable prose server-side as well.`);
      } else if (b.kind === "groundedness-low") {
        console.error(`\nGroundedness is low (${b.score}%). Submission blocked.`);
        console.error(`Regenerate the profile (${CMD} generate) or pass --force to bypass.`);
      }
    }
  };

  // --dry-run: write the EXACT outgoing JSON (repository names stripped) and
  // stop before any network call, so a candidate under NDA can read the very
  // bytes that would leave the machine. The file is written even when submit
  // would be blocked: inspection is the point; the exit code says which.
  if (has("dry-run")) {
    const previewPath = join(ensureOut(), "payload-preview.json");
    writeFileSync(previewPath, JSON.stringify(buildPayload(profile), null, 2) + "\n");
    console.log(`\nWrote ${OUT_DIR}/payload-preview.json, the exact JSON \`submit --yes\` would POST (repository names and contact stripped). Nothing was sent.`);
    if (blockers.length) {
      console.error(`\nsubmit would be blocked:`);
      printBlockers();
      process.exit(2);
    }
    return;
  }

  if (!(yes || has("yes"))) {
    console.log(`\nTo confirm:  ${CMD} submit --yes`);
    return;
  }
  if (blockers.length) {
    printBlockers();
    process.exit(2);
  }

  try {
    const res = await submitProfile(profilePath, { hub: flag("hub") });
    console.log(`\nSent. Your profile is waiting as a draft: a person at rebase will read it before it counts.`);
    if (res.review_url) console.log(`See its status here: ${res.review_url}`);
  } catch (e) {
    console.error(`\nSubmit failed: ${e.message}`);
    process.exit(1);
  }
}

if (sub !== "generate" && (has("agent") || has("model"))) die("--agent and --model work with generate only.");

// No subcommand, a real terminal on both ends and no --yes: the wizard. Everything else is
// the sub-commands as they always were.
const interactive = !(argv[0] && !argv[0].startsWith("--")) && process.stdin.isTTY && process.stdout.isTTY && !has("yes");

async function cmdWizard() {
  const { wizard, clack, live, agents } = await loadOptional(async () => ({
    wizard: await import("../src/wizard.mjs"),
    clack: await import("@clack/prompts"),
    live: await import("../src/live-status.mjs"),
    agents: await loadAgents(),
  }));
  const rejected = wizard.rejectedFlags(has);
  if (rejected) die(rejected);
  const { availableAgents, defaultAgent } = agents.registry;
  const entry = await resolveAgent();
  const out = outPath();
  const root = logsRoot();
  const flags = sourceFlags();
  const pkg = JSON.parse(readFileSync(fileURLToPath(new URL("../package.json", import.meta.url)), "utf8"));
  const code = await wizard.runWizard({
    ui: { ...clack, live: live.liveStatus },
    out,
    flags: { version: pkg.version, agent: entry?.id, model: flag("model") ?? undefined },
    deps: {
      sources: SOURCES.filter((s) => s.id === "claude-code" || !flags[s.id]?.disabled),
      readSource: (id) =>
        id === "claude-code" && !existsSync(root)
          ? { source: "claude-code", files: [], sessions: [], compactionSummaries: [], redaction: { hits: 0, charsRemoved: 0 } }
          : readSource(id, { claudeRoot: root, sources: flags }),
      combine: combineSources,
      availableAgents: (sessionsBySource) => availableAgents({ sessionsBySource }),
      defaultAgent,
      prepare: (parsed) => {
        QUIET = true;
        ensureOut();
        rmSync(join(out, "agent-log.jsonl"), { force: true });
        const inputs = deriveInputs(parsed, out);
        writePracticesInput(out, parsed, tzFlag);
        const inputFile = join(out, "practices-input.json");
        return {
          inputs,
          narrativeInput: narrativeInputFor(inputs.selected, inputs.enrichments, narrativeOptionsOf(inputs)),
          practicesInput: existsSync(inputFile) ? JSON.parse(readFileSync(inputFile, "utf8")) : null,
        };
      },
      startAgent: agents.acp.startAgent,
      runWithAgent: agents.run.runWithAgent,
      finish: ({ inputs }, run) => {
        const { practices, narrative, generatedBy } = applyAgentRun(out, inputs.practices, run);
        const profile = assembleWithGroundedness({
          ...inputs, narrative, practices, generatedBy,
          manifestHash: inputs.fingerprint.manifest.bundleHash,
        });
        writeProfile(out, profile, { print: false });
        QUIET = false;
        return {
          sessions: profile.volume?.sessions ?? 0,
          products: profile.volume?.products ?? 0,
          practices: profile.practices?.items ?? [],
          summary: profile.summary ?? null,
        };
      },
      submit: () => cmdSubmit({ yes: true }),
    },
  });
  process.exit(code);
}

const main = interactive ? cmdWizard : { generate: cmdGenerate, prepare: cmdPrepare, finalize: cmdFinalize, submit: cmdSubmit }[sub];
main().catch((e) => { console.error("Error:", e.message); process.exit(1); });
