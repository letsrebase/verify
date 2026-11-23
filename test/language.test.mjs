// The profile's language (REB-1156): the --lang flag, the payload field, the
// narrative prompt and the rendered profile.md.
import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { DEFAULT_LANGUAGE, LANGUAGES, SUPPORTED_LANGUAGES } from "../src/languages.mjs";
import { narrativeInputFor, narrativeSystem } from "../src/profile-llm.mjs";
import { assembleProfile, renderMarkdown } from "../src/profile.mjs";
import { baseProfile } from "./factories.mjs";

const BIN = new URL("../bin/rebase-verify.mjs", import.meta.url).pathname;

test("--lang rejects an unknown code and lists the supported ones", () => {
  const r = spawnSync(process.execPath, [BIN, "prepare", "--lang", "xx"], { encoding: "utf8" });
  assert.equal(r.status, 2);
  assert.match(r.stderr, /Invalid --lang "xx"/);
  for (const code of SUPPORTED_LANGUAGES) assert.ok(r.stderr.includes(code), `error lists ${code}`);
});

test("Italian is the default and every language has a name and a label table", () => {
  assert.equal(DEFAULT_LANGUAGE, "it");
  for (const [code, l] of Object.entries(LANGUAGES)) {
    assert.equal(l.code, code);
    assert.ok(l.name && l.labels.title);
  }
  // A language added later must carry every label English has.
  for (const l of Object.values(LANGUAGES)) assert.deepEqual(Object.keys(l.labels).sort(), Object.keys(LANGUAGES.en.labels).sort());
});

const args = { projects: [], narrative: null, fingerprint: { manifest: {} }, forensics: null };

test("the payload carries the language, Italian unless told otherwise", () => {
  assert.equal(assembleProfile(args).language, "it");
  assert.equal(assembleProfile({ ...args, language: "en" }).language, "en");
});

test("the narrative prompt and input carry the language name", () => {
  assert.match(narrativeSystem("it"), /Write every text in Italian/);
  assert.match(narrativeSystem("en"), /Write every text in English/);
  assert.match(narrativeSystem(), /Italian/);
  assert.ok(!narrativeSystem("it").includes("{LANGUAGE}"));
  const input = narrativeInputFor([], [], { language: "en" });
  assert.equal(input.language, "en");
  assert.equal(input.languageName, "English");
  assert.equal(narrativeInputFor([], []).language, "it");
});

test("profile.md uses Italian labels for headings and for enum codes, payload codes unchanged", () => {
  const p = baseProfile();
  p.language = "it";
  p.intensity = { activeDays: 10, observedDays: 20, activeDaysRatio: 0.5, medianSessionsPerActiveDay: 2, medianSessionToolCalls: 30, longestStreak: 4, peakDayToolCalls: 90, cadence: "heavy regular", sessionShape: "focused sessions", narrative: null };
  p.distribution = { products: 3, medianSessionsPerProduct: 2, meanSessionsPerProduct: 3, top3Share: 1, multiMonthProducts: 1, multiMonthShare: 0.3, shape: "deep focus", narrative: null };
  p.aiRelationship = { directing: 70, coThinking: 30, mode: "directing-leaning", narrative: null };
  const md = renderMarkdown(p);
  assert.match(md, /^# Profilo agentico/);
  assert.ok(md.includes("## Intensità della pratica"));
  assert.ok(md.includes("Cadenza: uso regolare e intenso · sessioni mirate"));
  assert.ok(md.includes("Forma: focus profondo"));
  assert.ok(md.includes("orientata alla guida"));
  assert.equal(p.intensity.cadence, "heavy regular");
  const en = renderMarkdown({ ...p, language: "en" });
  assert.ok(en.includes("Cadence: heavy regular · focused sessions"));
  assert.ok(renderMarkdown({ ...p, language: undefined }).startsWith("# Agentic profile"), "no language reads as English");
});
