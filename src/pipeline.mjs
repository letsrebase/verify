// The steps between the logs and the profile, as plain functions of their inputs, so the
// sub-commands run them in place and the wizard runs the same ones in a worker thread
// (src/pipeline-worker.mjs), where a long synchronous stretch cannot freeze its spinner.
// Nothing here prints or exits: output goes through the `ctx` callbacks and a failure is thrown.
//
// `ctx` = { tz, top, language, outDir, cmd, say, warn, step }:
//   tz, language    the profile's timezone and language
//   top             the forced number of representative projects, or null for adaptive
//   outDir, cmd     how the person's own messages name the output folder and this command
//   say, warn       progress and notes for the sub-commands' terminal output (default: silent)
//   step            a short label of the stretch about to start, for the wizard's spinner
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readAllSources } from "./sources.mjs";
import { computeFingerprint } from "./fingerprint.mjs";
import { computeForensics } from "./forensics.mjs";
import { buildDigest } from "./digest.mjs";
import { enrichRepo, describeContextGaps } from "./enrich.mjs";
import { selectRepresentatives, assembleProfile, renderMarkdown, summarizeSources } from "./profile.mjs";
import { narrativeInputFor } from "./profile-llm.mjs";
import { practicesFiles } from "./practices-sample.mjs";
import { buildTrajectory } from "./trajectory.mjs";
import { computeAiRelationship } from "./ai-relationship.mjs";
import { computeAgenticLiteracy } from "./agentic-literacy.mjs";
import { computeIntensity } from "./intensity.mjs";
import { computeDistribution } from "./distribution.mjs";
import { computeTechUsage, recordedTechUsageTz } from "./tech-usage.mjs";
import { computeCodePractices, mergeModelPractices, practicesBlock, recordedPracticesTz } from "./practices.mjs";
import { assessGroundedness } from "./groundedness.mjs";
import { assessAgainstLogs } from "./consistency.mjs";
import { DEFAULT_TZ } from "./days.mjs";

const quiet = () => {};

/** The model's answers could not be used; the message says what to fix. */
export class PracticesAnswersError extends Error {
  name = "PracticesAnswersError";
}

/** The output folder, created once logs were found. A `*` .gitignore inside keeps every file in it out of a commit. */
export function ensureOutDir(out) {
  mkdirSync(out, { recursive: true });
  const ignore = join(out, ".gitignore");
  if (!existsSync(ignore)) writeFileSync(ignore, "*\n");
  return out;
}

// Everything computed from the parsed logs; the wizard passes the sources the person chose.
export function deriveInputs(parsed, out, { tz, top = null, say = quiet, warn = quiet, step = quiet }) {
  step("Fingerprinting the logs");
  say(`[2/5] Fingerprint, manifest, consistency ...`);
  const fingerprint = computeFingerprint(parsed, { tz });
  const forensics = computeForensics(parsed);

  step("Grouping the work into projects");
  say(`[3/5] Deep digest + per-repo clustering (PII redacted: ${parsed.redaction.hits}) ...`);
  const digest = buildDigest(parsed, { tz });
  const projects = selectRepresentatives(digest.projects, top ? +top : "auto");
  const selected = projects.filter((p) => p.selected);
  say(`      ${digest.projectCount} products, ${selected.length}${top ? "" : " (adaptive 3-5)"} representative: ${selected.map((p) => `${p.repo}[${p.type[0]}]`).join(", ")}`);

  step("Reading the representative projects");
  const enrichments = selected.map((p) => enrichRepo(p.cwdRaw));
  const contextGap = describeContextGaps(enrichments);
  if (contextGap) warn(`      note: ${contextGap}`);
  step("Measuring how the work changed over time");
  const trajectory = buildTrajectory(parsed);
  const aiRelationship = computeAiRelationship(parsed);
  const agenticLiteracy = computeAgenticLiteracy(parsed);
  const intensity = computeIntensity(parsed, { tz });
  const distribution = computeDistribution(projects);
  const techUsage = computeTechUsage(projects, { tz });
  step("Counting the work practices");
  const practices = practicesBlock(computeCodePractices(parsed, { tz })?.items, { tz });
  const sources = summarizeSources(parsed);
  return { parsed, fingerprint, forensics, projects, selected, enrichments, trajectory, aiRelationship, agenticLiteracy, intensity, distribution, techUsage, practices, sources, out };
}

export const narrativeOptionsOf = (i, language) => ({
  trajectory: i.trajectory,
  aiRelationship: i.aiRelationship,
  agenticLiteracy: i.agenticLiteracy,
  intensity: i.intensity,
  distribution: i.distribution,
  allProjects: i.projects,
  compactionSummaries: i.parsed.compactionSummaries,
  language,
});

const sharedPractices = () => JSON.parse(readFileSync(new URL("../share/practices.json", import.meta.url), "utf8"));

// The model-classified practices: written only when some are published and
// there is something to read. Both files stay local; the sample file maps the
// opaque ids back to real sessions and is never sent.
export function writePracticesInput(out, parsed, { tz, outDir, say = quiet }) {
  // A stale sample from an earlier run must never be read by finalize.
  for (const f of ["practices-input.json", "practices-sample.json", "practices-detail.json", "practices.json"]) rmSync(join(out, f), { force: true });
  const practices = (sharedPractices().practices ?? []).filter((p) => p.method === "model");
  const files = practicesFiles(parsed, { tz, practices });
  if (!files) return;
  writeFileSync(join(out, "practices-input.json"), JSON.stringify(files.input, null, 2));
  writeFileSync(join(out, "practices-sample.json"), JSON.stringify(files.sample, null, 2));
  say(`Wrote ${outDir}/practices-input.json (${files.sample.length} sessions of your own messages, for your model to classify) and ${outDir}/practices-sample.json (local only).`);
}

// The model's answers, when the person's model wrote out/practices.json: checked
// against the sample file written at prepare (never resampled), then merged into
// the block, with who classified them. A bad or unreadable file stops the step;
// nothing is saved.
export function mergePracticesAnswers(out, codeBlock, classifiedBy, { tz, outDir, cmd, say = quiet }) {
  const answersFile = join(out, "practices.json");
  if (!existsSync(answersFile)) return codeBlock;
  const sampleFile = join(out, "practices-sample.json");
  const fail = (msg) => {
    throw new PracticesAnswersError(`${msg} Fix it, or delete ${outDir}/practices.json to leave the model practices out.`);
  };
  const read = (file) => { try { return JSON.parse(readFileSync(file, "utf8")); } catch { return undefined; } };
  const sample = read(sampleFile);
  if (!Array.isArray(sample)) fail(`Missing or unreadable ${sampleFile}: run ${cmd} prepare again.`);
  const answers = read(answersFile);
  if (answers === undefined) fail(`${answersFile} is not valid JSON.`);
  const ids = (sharedPractices().practices ?? []).filter((p) => p.method === "model").map((p) => p.id);
  try {
    const { block, detail } = mergeModelPractices(codeBlock, answers, sample, ids, { tz, classifiedBy });
    writeFileSync(join(out, "practices-detail.json"), JSON.stringify(detail, null, 2));
    say(`Merged the model's answers for ${sample.length} sessions (per-session detail in ${outDir}/practices-detail.json, local only).`);
    return block;
  } catch (e) {
    return fail(`${answersFile}: ${e.message}.`);
  }
}

// What the agent run adds to the profile: the answers merged into the practices block, who
// wrote the narrative. The answers stay in practices-detail.json, so a later finalize never
// reads them as the slash command's.
export function applyAgentRun(out, codePractices, run, ctx) {
  if (run.practicesAnswers) writeFileSync(join(out, "practices.json"), JSON.stringify(run.practicesAnswers, null, 2));
  const practices = run.practicesAnswers ? mergePracticesAnswers(out, codePractices, run.used, ctx) : codePractices;
  rmSync(join(out, "practices.json"), { force: true });
  return { practices, narrative: run.narrative, generatedBy: { narrative: run.used } };
}

// Assemble + compute groundedness on the assembled draft + re-assemble with
// the score embedded. Centralised so generate, finalize and the wizard share it.
export function assembleWithGroundedness(args, { language, warn = quiet }) {
  // The raw vocabularyCandidates never enter the profile (they can carry
  // client names), so a narrative that omitted its filtered pick leaves
  // newVocabulary empty. Say so instead of failing silently.
  if (args.narrative && args.trajectory?.vocabularyCandidates?.length && !args.narrative.trajectory?.vocabulary_adopted?.length) {
    warn(`      note: the narrative has no trajectory.vocabulary_adopted, newVocabulary stays empty (raw candidates are never used; re-run the narrative step to fill it)`);
  }
  const withLanguage = { language, ...args };
  const draft = assembleProfile(withLanguage);
  const groundedness = assessGroundedness(draft);
  return assembleProfile({ ...withLanguage, groundedness });
}

/** Writes candidate.json and profile.md; returns the markdown. */
export function saveProfile(out, profile) {
  writeFileSync(join(out, "candidate.json"), JSON.stringify(profile, null, 2));
  const md = renderMarkdown(profile);
  writeFileSync(join(out, "profile.md"), md);
  return md;
}

/** The numbers the wizard shows after a run. */
export const profileSummary = (profile) => ({
  sessions: profile.volume?.sessions ?? 0,
  products: profile.volume?.products ?? 0,
  practices: profile.practices?.items ?? [],
  summary: profile.summary ?? null,
});

/**
 * submit's pre-flight against the logs as they are now: re-reads the SAME source mix the
 * profile was generated from (see sourceFlags() in the bin for why this must never drift),
 * then re-derives what the profile claims.
 * @returns {{ issues: string[], excessClaims: number, warnings: string[] }}
 */
export function checkAgainstLogs(profile, { claudeRoot, sources, step = quiet, onProgress }) {
  step("Reading your logs again");
  const parsed = readAllSources({ claudeRoot, sources, onProgress });
  step("Re-deriving what the profile claims");
  // Re-derive day-based intensity and tech-usage months in the zone the
  // profile RECORDED, never the machine zone, so the comparison measures
  // the data, not the bucketing.
  const techTz = recordedTechUsageTz(profile);
  const digest = buildDigest(parsed, { tz: techTz });
  const intensity = computeIntensity(parsed, { tz: profile.intensity?.timezone || DEFAULT_TZ });
  const techUsage = computeTechUsage(digest.projects, { tz: techTz });
  const practices = computeCodePractices(parsed, { tz: recordedPracticesTz(profile) });
  const logs = assessAgainstLogs(profile, digest.projects, { intensity, techUsage, practices });
  return { issues: logs.issues, excessClaims: logs.excessClaims || 0, warnings: logs.warnings };
}
