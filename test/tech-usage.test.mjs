// Per-technology usage: counts, deterministic bands, tz bucketing, the submit
// re-derivation and the groundedness support of the new numbers.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { computeTechUsage, bandFor, recordedTechUsageTz } from "../src/tech-usage.mjs";
import { generateNarrative } from "../src/profile-llm.mjs";
import { buildDigest, detectStack, labelVocabulary } from "../src/digest.mjs";
import { assessStructure, assessAgainstLogs } from "../src/consistency.mjs";
import { assessGroundedness } from "../src/groundedness.mjs";
import { assembleProfile, renderMarkdown } from "../src/profile.mjs";
import { sess } from "./factories.mjs";

const months = (from, n) => Array.from({ length: n }, (_, i) => {
  const t = (+from.slice(0, 4)) * 12 + (+from.slice(5) - 1) + i;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, "0")}`;
});
const proj = (tech, sessions, ms) => ({ tech, sessions, months: ms });

test("counts sessions, products and distinct months per technology across all products", () => {
  const u = computeTechUsage([
    proj(["Supabase", "Zod"], 10, ["2026-01", "2026-02"]),
    proj(["Supabase"], 4, ["2026-02", "2026-04"]),
    proj([], 3, ["2026-05"]),
  ]);
  const s = u.technologies.find((t) => t.name === "Supabase");
  assert.deepEqual(s, { name: "Supabase", sessions: 14, products: 2, months: 3, firstMonth: "2026-01", lastMonth: "2026-04", band: "recurring" });
  assert.equal(u.technologies.find((t) => t.name === "Zod").sessions, 10);
  assert.equal(u.timezone, "UTC");
  assert.deepEqual(u.technologies.map((t) => t.name), ["Supabase", "Zod"]); // sessions desc
});

test("returns null when no technology was detected", () => {
  assert.equal(computeTechUsage([proj([], 3, ["2026-05"])]), null);
  assert.equal(computeTechUsage([]), null);
  assert.equal(computeTechUsage(null), null);
});

test("band thresholds: occasional < 3 months <= recurring; continuous needs 6 months AND 75% coverage", () => {
  const b = (n, from, last) => bandFor({ months: n, firstMonth: from, lastMonth: last });
  assert.equal(b(1, "2026-01", "2026-01"), "occasional");
  assert.equal(b(2, "2026-01", "2026-09"), "occasional");
  assert.equal(b(3, "2026-01", "2026-12"), "recurring");
  assert.equal(b(5, "2026-01", "2026-05"), "recurring"); // full coverage but under 6 months
  assert.equal(b(6, "2026-01", "2026-06"), "continuous");
  assert.equal(b(9, "2026-01", "2026-12"), "continuous"); // 9/12 = 75%
  assert.equal(b(8, "2026-01", "2026-12"), "recurring"); // 8/12 < 75%
  assert.equal(b(6, "2025-11", "2026-04"), "continuous"); // spans a year boundary: 6/6
});

test("a technology seen only in months-less products is not reported", () => {
  assert.equal(computeTechUsage([proj(["Zod"], 5, [])]), null);
});

test("digest buckets months in the requested timezone, like days", () => {
  // 2026-03-31T23:30Z is already April in Rome (UTC+2 in summer time).
  const parsed = { source: "claude-code", sessions: [sess("claude-code", "acme-app", [], { ts: "2026-03-31T23:30:00.000Z" })] };
  assert.deepEqual(buildDigest(parsed).projects[0].months, ["2026-03"]);
  assert.deepEqual(buildDigest(parsed, { tz: "Europe/Rome" }).projects[0].months, ["2026-04"]);
});

test("real detection path: private package names never surface, only vocabulary labels", () => {
  const dir = mkdtempSync(join(tmpdir(), "tech-usage-"));
  try {
    writeFileSync(join(dir, "package.json"), JSON.stringify({
      name: "acme-client-portal",
      dependencies: { "@acme/internal-billing": "1.0.0", zod: "3.0.0", "acme-secret-sdk": "2.0.0" },
    }));
    const tech = detectStack({ cwdRaw: dir, exts: {}, cmdsText: "" });
    assert.ok(tech.includes("Zod"), tech.join(","));
    const u = computeTechUsage([{ tech, sessions: 3, months: ["2026-01"] }]);
    const vocab = new Set(labelVocabulary());
    assert.ok(u.technologies.length >= 1);
    for (const t of u.technologies) assert.ok(vocab.has(t.name), t.name);
    const wire = JSON.stringify(u);
    assert.ok(!/acme|internal-billing/i.test(wire), wire);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("structure: a name outside the detector vocabulary is blocked, with or without logs", () => {
  const p = { volume: { products: 3, sessions: 20 }, techUsage: { timezone: "UTC", technologies: [
    { name: "acme-billing-core", sessions: 5, products: 1, months: 1, firstMonth: "2026-01", lastMonth: "2026-01", band: "occasional" },
    { name: 42, sessions: 5, products: 1, months: 1, firstMonth: "2026-01", lastMonth: "2026-01", band: "occasional" },
  ] } };
  const issues = assessStructure(p).issues.filter((i) => i.startsWith("techUsage"));
  assert.equal(issues.length, 2, issues.join("\n"));
});

test("structure: malformed block is an issue, not a throw", () => {
  assert.ok(assessStructure({ techUsage: { timezone: "UTC", technologies: "Zod" } }).issues.some((i) => i.includes("not a list")));
  assert.ok(assessStructure({ techUsage: { timezone: "Mars/Olympus", technologies: [] } }).issues.some((i) => i.includes("not a valid IANA")));
});

test("structure: techUsage and intensity must record the same zone", () => {
  const p = { techUsage: { timezone: "Europe/Rome", technologies: [] }, intensity: { timezone: "UTC" } };
  assert.ok(assessStructure(p).issues.some((i) => i.includes("one generation uses one zone")));
  p.intensity.timezone = "Europe/Rome";
  assert.deepEqual(assessStructure(p).issues, []);
});

test("submit wiring: months re-derive in the RECORDED zone; invalid or absent zone falls back to UTC", () => {
  const parsed = { source: "claude-code", sessions: [sess("claude-code", "acme-app", [], { ts: "2026-03-31T23:30:00.000Z" })] };
  const rederive = (profile) => buildDigest(parsed, { tz: recordedTechUsageTz(profile) }).projects[0].months;
  assert.deepEqual(rederive({ techUsage: { timezone: "Europe/Rome" } }), ["2026-04"]);
  assert.deepEqual(rederive({ techUsage: { timezone: "Mars/Olympus" } }), ["2026-03"]);
  assert.deepEqual(rederive({}), ["2026-03"]);
});

test("months and techUsage never reach the narrative input", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tech-usage-narr-"));
  try {
    const f = join(dir, "n.json");
    writeFileSync(f, JSON.stringify({ summary: "s", cognitive: { narrative: "c" }, projects: [] }));
    const p = { ...baseProj, months: ["2026-01", "2026-02"], topAreas: {}, learningTopics: [], promptSamples: [] };
    const { input } = await generateNarrative([p], [{}], { overrideFile: f, allProjects: [p] });
    const wire = JSON.stringify(input);
    assert.ok(!wire.includes('"months"') && !wire.includes("techUsage") && !wire.includes("2026-02"), wire);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

// --- profile wiring ----------------------------------------------------------

const usage = () => ({
  timezone: "UTC",
  technologies: [
    { name: "Supabase", sessions: 14, products: 2, months: 7, firstMonth: "2026-01", lastMonth: "2026-08", band: "continuous" },
    { name: "Zod", sessions: 6, products: 1, months: 2, firstMonth: "2026-02", lastMonth: "2026-03", band: "occasional" },
  ],
});
const baseProj = { repo: "acme-app", cwdRaw: "", type: ["feature-work"], from: "2026-01", to: "2026-08", sessions: 14, userMessages: 30, tech: ["Supabase"], landing: { commits: 1, reverts: 0, revertChurn: "low", checksRun: false }, selected: true };

test("assembleProfile carries techUsage and defaults it to null (old shape unchanged)", () => {
  const args = { contact: { name: "X" }, projects: [baseProj], narrative: null, fingerprint: null, forensics: null };
  assert.equal(assembleProfile(args).techUsage, null);
  assert.deepEqual(assembleProfile({ ...args, techUsage: usage() }).techUsage, usage());
});

test("profile.md renders the block deterministically, with the zone when not UTC", () => {
  const profile = { ...assembleProfile({ contact: { name: "X" }, projects: [baseProj], narrative: null, fingerprint: null, forensics: null, techUsage: usage(), language: "en" }) };
  const md = renderMarkdown(profile);
  assert.ok(md.includes("## Technology usage"));
  assert.ok(md.includes("- Supabase: continuous · 14 sessions · 2 products · 7 months (2026-01 to 2026-08)"), md);
  assert.ok(md.includes("- Zod: occasional · 6 sessions · 1 product · 2 months (2026-02 to 2026-03)"), md);
  profile.techUsage.timezone = "Europe/Rome";
  assert.ok(renderMarkdown(profile).includes("months counted in Europe/Rome"));
  profile.techUsage = null;
  assert.ok(!renderMarkdown(profile).includes("Technology usage"));
});

const prof = () => ({
  volume: { products: 3, sessions: 20, instructions: 10 },
  projects: [], otherProjects: [],
  techUsage: usage(),
});

test("structure: an honest block passes; a band that does not match its counts is caught", () => {
  assert.deepEqual(assessStructure(prof()).issues.filter((i) => i.startsWith("techUsage")), []);
  const p = prof();
  p.techUsage.technologies[1].band = "continuous";
  assert.ok(assessStructure(p).issues.some((i) => i.includes("techUsage.Zod") && i.includes("band")));
});

test("structure: impossible counts are caught", () => {
  const p = prof();
  p.techUsage.technologies[0].months = 40; // cannot fit in 2026-01..2026-08
  p.techUsage.technologies[1].sessions = 99; // more than the profile has
  const issues = assessStructure(p).issues.join("\n");
  assert.ok(issues.includes("cannot fit"), issues);
  assert.ok(issues.includes("99 sessions"), issues);
});

// Re-derivation built through the real computeTechUsage so the month list is real.
const derive = (rows) => computeTechUsage(rows.flatMap((r) => Array.from({ length: r.products ?? 1 }, (_, i) =>
  proj([r.name], i === 0 ? r.sessions - ((r.products ?? 1) - 1) : 1, r.months))));
const SUPA_MONTHS = ["2026-01", "2026-02", "2026-03", "2026-04", "2026-05", "2026-06", "2026-08"];
const REACT_MONTHS = ["2026-02", "2026-03"];
const logsDerived = () => derive([
  { name: "Supabase", sessions: 14, products: 2, months: SUPA_MONTHS },
  { name: "Zod", sessions: 6, months: REACT_MONTHS },
]);
const techIssues = (r) => r.issues.filter((i) => i.startsWith("techUsage"));

test("logs: an honest claim passes with no issues and no warnings", () => {
  const r = assessAgainstLogs(prof(), [], { techUsage: logsDerived() });
  assert.deepEqual(techIssues(r), []);
  assert.deepEqual(r.warnings.filter((w) => w.startsWith("techUsage")), []);
});

test("logs: inflated month windows are blocking excess claims", () => {
  const p = prof();
  p.techUsage.technologies[0].months = 8; // logs have 7 up to 2026-08
  p.techUsage.technologies[1].firstMonth = "2025-12"; // earlier than the logs
  p.techUsage.technologies[1].lastMonth = "2026-05"; // later than the logs
  const r = assessAgainstLogs(p, [], { techUsage: logsDerived() });
  const t = techIssues(r).join("\n");
  assert.ok(t.includes("claims 8 months"), t);
  assert.ok(t.includes("first month 2025-12"), t);
  assert.ok(t.includes("last month 2026-05"), t);
  assert.equal(techIssues(r).length, 3, t);
  assert.ok(r.excessClaims >= 3);
});

test("logs: a NARROWED window cannot turn a recurring history into continuous", () => {
  // Logs: 6 months spread over 2026-01..2026-12 = recurring (6/12 coverage).
  const spread = ["2026-01", "2026-03", "2026-05", "2026-07", "2026-09", "2026-12"];
  const derived = derive([{ name: "Supabase", sessions: 12, months: spread }]);
  assert.equal(derived.technologies[0].band, "recurring");
  // Claim: the same 6 months but a window starting 2026-07: coverage 100%.
  const claim = { name: "Supabase", sessions: 12, products: 1, months: 6, firstMonth: "2026-07", lastMonth: "2026-12", band: "continuous" };
  assert.equal(bandFor(claim), "continuous"); // internally consistent, so structure passes...
  const p = { volume: { products: 3, sessions: 20 }, techUsage: { timezone: "UTC", technologies: [claim] } };
  assert.deepEqual(assessStructure(p).issues.filter((i) => i.startsWith("techUsage")), []);
  // ...but the logs refuse it: first month differs, and only 3 months fit by 2026-12 from the claim's view.
  const t = techIssues(assessAgainstLogs(p, [], { techUsage: derived })).join("\n");
  assert.ok(t.includes("claims first month 2026-07"), t);
  // Same first month but too many months for the window is flagged on `months`.
  const c2 = { ...claim, firstMonth: "2026-01", lastMonth: "2026-09", months: 6 };
  const t2 = techIssues(assessAgainstLogs({ ...p, techUsage: { timezone: "UTC", technologies: [c2] } }, [], { techUsage: derived })).join("\n");
  assert.ok(t2.includes("claims 6 months up to 2026-09, logs re-derive 5"), t2);
});

test("logs: disk-dependent deltas are warnings, not blockers", () => {
  const p = prof();
  const derived = derive([{ name: "Supabase", sessions: 9, months: SUPA_MONTHS }]);
  const r = assessAgainstLogs(p, [], { techUsage: derived });
  assert.deepEqual(techIssues(r), []);
  const w = r.warnings.join("\n");
  assert.ok(w.includes("techUsage.Zod: the logs no longer re-derive this technology"), w);
  assert.ok(w.includes("claims 14 sessions, logs now re-derive 9"), w);
});

test("logs: no check without a claimed block, or without a re-derivation", () => {
  assert.deepEqual(assessAgainstLogs({ volume: {} }, [], { techUsage: usage() }).issues, []);
  assert.deepEqual(assessAgainstLogs(prof(), []).issues.filter((i) => i.startsWith("techUsage")), []);
});

test("groundedness: the new counts and months support prose that cites them, and nothing else", () => {
  const p = prof();
  p.projects = [];
  p.summary = "Used Supabase across 7 months, in 14 sessions and 2 products.";
  const ok = assessGroundedness(p);
  assert.equal(ok.anomalies.length, 0, JSON.stringify(ok.anomalies));
  assert.ok(ok.total >= 4);
  // First and last months join the period pool.
  const per = assessGroundedness({ ...p, summary: "Active since 2026-01 and until 2026-08." });
  assert.ok(!per.anomalies.some((a) => a.kind === "period"), JSON.stringify(per.anomalies));

  const bad = { ...p, summary: "Used Supabase across 31 months in 477 sessions." };
  const g = assessGroundedness(bad);
  assert.ok(g.anomalies.some((a) => a.anchor === "477"), JSON.stringify(g.anomalies));
  assert.ok(g.anomalies.some((a) => a.anchor === "31"), JSON.stringify(g.anomalies));
});

test("groundedness: a technology only in techUsage still grounds its name", () => {
  const p = { ...prof(), projects: [], summary: "Worked with Zod for 2 months, 6 sessions, 14 sessions overall." };
  const g = assessGroundedness(p);
  assert.ok(!g.anomalies.some((a) => a.kind === "tech"), JSON.stringify(g.anomalies));
  const without = { ...p, techUsage: null };
  assert.ok(assessGroundedness(without).anomalies.some((a) => a.anchor.toLowerCase() === "zod"));
});
