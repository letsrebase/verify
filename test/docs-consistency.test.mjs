// Defect-to-test: every one of these was first caught by hand.
//
// 1. The slash command's narrative.json schema lagged behind the fields
//    assembleProfile actually consumes (ai_relationship and intensity were
//    missing — the model only wrote them by accident).
// 2. The slash command quoted a CLI output string ("… rappresentativi: …")
//    that the CLI no longer prints (output was translated to English).
// 3. The slash command used a REAL repo name of a real candidate as its
//    example repoLabel — a proper-name leak in the public repo of a tool
//    whose privacy rule is "counts, not names".

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { labelsFor } from "../src/languages.mjs";

const command = readFileSync(new URL("../.claude/commands/rebase-verify.md", import.meta.url), "utf8");
const profileSrc = readFileSync(new URL("../src/profile.mjs", import.meta.url), "utf8");
const llmSrc = readFileSync(new URL("../src/profile-llm.mjs", import.meta.url), "utf8");
const binSrc = readFileSync(new URL("../bin/rebase-verify.mjs", import.meta.url), "utf8");

test("slash command schema covers every narrative key assembleProfile consumes", () => {
  const keys = new Set([...profileSrc.matchAll(/narrative\?\.([a-z_]+)/g)].map((m) => m[1]));
  keys.delete("projects"); // rendered as the projects array, present in the schema by example
  for (const key of keys) {
    assert.ok(command.includes(`"${key}"`), `slash command schema is missing narrative key "${key}"`);
  }
});

test("LLM system prompt schema covers the same narrative keys", () => {
  const keys = new Set([...profileSrc.matchAll(/narrative\?\.([a-z_]+)/g)].map((m) => m[1]));
  keys.delete("projects");
  for (const key of keys) {
    assert.ok(llmSrc.includes(`"${key}"`), `profile-llm SYSTEM schema is missing narrative key "${key}"`);
  }
});

test("CLI output strings quoted in the slash command still exist in the CLI", () => {
  assert.ok(!/rappresentativ/i.test(command), "slash command quotes the old Italian CLI output");
  assert.ok(binSrc.includes("representative:"), "CLI no longer prints the 'representative:' line the slash command refers to");
  assert.ok(command.includes("representative:"), "slash command no longer quotes the 'representative:' CLI line");
});

test("slash command does not hardcode the representative-project count (it's adaptive 3-5)", () => {
  // 4. The slash command said "the four that were auto-selected" while the CLI
  //    moved to an adaptive 3-5 selection — a hardcoded count in the docs that
  //    silently lies as soon as the selection logic changes.
  assert.ok(
    !/\b(four|three|five) (representative|auto-selected)\b|\bthe (four|three|five) that were\b/i.test(command),
    "slash command hardcodes a representative-project count",
  );
});

test("slash command paths match the out/ folder bin actually writes to", () => {
  // 5. Generated files moved from the repo root to out/; any doc still
  //    telling the model to read/write the bare filename would make the
  //    narrative step look in the wrong place.
  const outDir = binSrc.match(/const OUT_DIR = "([^"]+)"/)?.[1];
  assert.ok(outDir, "bin must declare OUT_DIR");
  for (const f of ["narrative-input.json", "narrative.json", "candidate.json", "profile.md", "payload-preview.json"]) {
    assert.ok(command.includes(`\`${outDir}/${f}\``), `slash command must reference ${outDir}/${f}`);
    assert.ok(!command.includes(`\`${f}\``), `slash command references ${f} without the ${outDir}/ prefix`);
  }
});

test("example repoLabels in the slash command are fictional (acme-*)", () => {
  // Any italicised repo-style example must be an obviously fake name. A real
  // repoLabel here is a privacy leak in a public file.
  const examples = [...command.matchAll(/\*([a-z][a-z0-9]*(?:-[a-z0-9]+)+)\*/g)].map((m) => m[1]);
  assert.ok(examples.length > 0, "expected at least one italicised repoLabel example");
  for (const e of examples) {
    assert.ok(e.startsWith("acme-"), `example repoLabel "${e}" must start with "acme-" so it can never be a real repo`);
  }
});

// --- the Node floor and the payload preview (defect-to-test) -----------------
// 6. engines >=20.12 was advisory only: `node bin/rebase-verify.mjs` bypassed npm's
//    check entirely and died on old Node with a bare ReferenceError. The floor
//    now lives in three places that must not drift: engines, the README
//    requirement line, and the runtime check in bin.
// 7. The repoLabel strip ran invisibly inside submitProfile; --dry-run makes
//    the exact payload inspectable and must stay documented where users look.
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
const privacy = readFileSync(new URL("../PRIVACY.md", import.meta.url), "utf8");

test("the Node floor is pinned in engines, README, and the runtime check", () => {
  assert.equal(pkg.engines?.node, ">=20.12", "package.json engines must state >=20.12");
  assert.ok(readme.includes("Node 20.12 or newer"), "README must state the Node requirement");
  assert.match(binSrc, /process\.versions\.node/, "bin must check the running Node version");
  assert.match(binSrc, /< 20\.12|nodeMajor === 20 && nodeMinor < 12/, "the runtime floor must match engines (20.12)");
});

test("submit --dry-run and its output file are documented in all three user surfaces", () => {
  for (const [name, text] of [["README", readme], ["PRIVACY", privacy], ["slash command", command]]) {
    assert.ok(text.includes("--dry-run"), `${name} must mention submit --dry-run`);
    assert.ok(text.includes("payload-preview.json"), `${name} must name the preview file`);
  }
});

// --- orchestration disclosure (review follow-up on #5) -------------------------
// 8. PR #5 added per-project orchestration metrics to the submitted payload but
//    PRIVACY.md's consent enumeration (§2) was not updated — the previous two
//    payload-shape changes (sources block, intensity) both updated PRIVACY in
//    the same commit, and nothing catches the drift class. Pin the disclosure.
test("PRIVACY §2 consent enumeration discloses the per-project orchestration counts", () => {
  const sec2 = privacy.slice(privacy.indexOf("## 2. What we collect"), privacy.indexOf("## 2a."));
  assert.ok(sec2.length > 0, "PRIVACY must keep §2 and §2a headings");
  assert.ok(/orchestration/i.test(sec2), "PRIVACY §2 must disclose the orchestration counts");
  assert.ok(/agent CLI|per-CLI/i.test(sec2), "PRIVACY §2 must say the split is per agent CLI");
});

test("PRIVACY §7 transparency list names the orchestration signals", () => {
  const sec7 = privacy.slice(privacy.indexOf("## 7."), privacy.indexOf("## 8."));
  assert.ok(/orchestration/i.test(sec7), "PRIVACY §7 must name the orchestration counts among the measured signals");
});

// 9. The narrative model receives per-project orchestration data, but neither
//    narrative surface (the SYSTEM prompt, the slash command) described the
//    field — and the "toolCount is a LOWER BOUND under single-source capture"
//    caveat lived only as a code comment in digest.mjs, invisible to the one
//    consumer that interprets the data. Without it the model is invited to
//    read {toolCount: 1, dispatchCommands: 0} as "no fan-out happened", and
//    disjoint-era multi-tool as concurrent orchestration.
test("both narrative surfaces describe the orchestration input and its caveats", () => {
  for (const [name, text] of [["profile-llm SYSTEM", llmSrc], ["slash command", command]]) {
    assert.ok(text.includes("orchestration"), `${name} must describe the orchestration field`);
    assert.ok(/lower bound/i.test(text), `${name} must carry the lower-bound caveat`);
    assert.ok(text.includes("toolOverlap"), `${name} must explain toolOverlap`);
    assert.ok(/migration/i.test(text), `${name} must warn that multi-tool without overlap may be migration, not fan-out`);
  }
});

// 10. PRIVACY §7 says "This file and the README describe ... the per-product
//     orchestration counts" — so the README half of that claim must be true,
//     and stay true.
test("README describes the per-product orchestration counts PRIVACY §7 attributes to it", () => {
  assert.ok(/orchestration counts/i.test(readme), "README must describe the per-product orchestration counts");
  assert.ok(/agent CLI/i.test(readme), "README must say the split is per agent CLI");
});

// 11. dispatchCommands counts headless agent dispatch INCLUDING the same CLI
//     (claude -p from a Claude Code session is the most common case). A surface
//     that presents dispatchCommands > 0 as evidence of CROSS-CLI fan-out
//     licenses a claim the data does not show.
test("all three surfaces say dispatch may target the same CLI, not only another", () => {
  for (const [name, text] of [["profile-llm SYSTEM", llmSrc], ["slash command", command], ["PRIVACY", privacy]]) {
    assert.ok(/same (CLI|tool)/i.test(text), `${name} must say dispatch may target the same CLI/tool`);
  }
});

// 11. The technology-usage block is transmitted, so PRIVACY §2 must disclose it
//     and the README must describe it with the same band names the code emits.
test("PRIVACY §2 and README disclose the technology-usage block and its bands", () => {
  const sec2 = privacy.split(/^## 3\./m)[0];
  assert.ok(/technology-usage/i.test(sec2), "PRIVACY §2 must disclose the technology-usage block");
  assert.ok(/never appears/i.test(sec2), "PRIVACY §2 must say custom/private dependencies never appear");
  for (const band of ["continuous", "recurring", "occasional"]) {
    assert.ok(readme.includes(`*${band}*`), `README must describe the ${band} band`);
  }
  assert.ok(/empirical/i.test(readme), "README must say the thresholds are empirical");
});

// --- work practices texts (REB-1143) -----------------------------------------
// The README names every practice with its published definition, PRIVACY
// discloses that the profile carries the counts, and none of the three user
// texts uses an em dash.
const practices = JSON.parse(readFileSync(new URL("../share/practices.json", import.meta.url), "utf8"));

test("README lists every practice id with the first sentence of its definition", () => {
  assert.match(readme, /^## Work practices$/m);
  for (const p of practices.practices) {
    assert.ok(readme.includes(p.id), `README lacks ${p.id}`);
    const first = p.definition.split(/(?<=\.)\s|;\s/)[0].replace(/\.$/, "");
    assert.ok(readme.includes(first), `README lacks the definition of ${p.id}`);
  }
});

test("PRIVACY §2 discloses the practices counts", () => {
  const s2 = privacy.slice(privacy.indexOf("## 2. What we collect"), privacy.indexOf("## 2a."));
  assert.match(s2, /practices/i);
  assert.match(s2, /counts/i);
  assert.match(s2, /never commands, paths or file names/);
});

test("README and the slash command name the profile section the code writes", () => {
  const heading = labelsFor("en").practices;
  assert.ok(profileSrc.includes("## ${T.practices}"), "src/profile.mjs no longer writes the practices heading");
  assert.ok(readme.includes(`"${heading}"`), "README does not name the heading");
  assert.ok(command.includes(`"${heading}"`), "slash command does not name the heading");
});

test("the three user texts use no em dash", () => {
  for (const [name, text] of [["README", readme], ["PRIVACY", privacy], ["rebase-verify.md", command]]) {
    assert.ok(!text.includes("\u2014"), `${name} contains an em dash`);
  }
});

test("slash command has a model-practices step naming both files and who reads what", () => {
  assert.ok(command.includes("practices-input.json"));
  assert.ok(command.includes("practices.json"));
  assert.ok(command.includes("practices-detail.json"));
  assert.ok(/60 sessions/.test(command) && /12 messages/.test(command));
});

test("slash command classifies before the first finalize, so the review shows every row", () => {
  const at = (re) => command.search(re);
  const classify = at(/\*\*Classify the model practices/);
  const finalize = at(/\*\*Run finalize\.\*\*/);
  const review = at(/\*\*Show `out\/profile\.md`\*\*/);
  assert.ok(classify > 0 && classify < finalize && finalize < review);
});

test("texts say sub-agent briefs, task notifications and compaction summaries are not read", () => {
  for (const [name, text] of [["README", readme], ["PRIVACY", privacy], ["rebase-verify.md", command]]) {
    assert.ok(/sub-agent briefs, task notifications/.test(text), `${name} does not say what is skipped`);
  }
});

test("the texts count four published model practices and none of them names the unpublished ones as classified", () => {
  for (const [name, text] of [["README", readme], ["PRIVACY", privacy], ["rebase-verify.md", command]]) {
    assert.ok(!/\bfive (model|classified)\b|\bFive are classified\b|\btwelve\b/.test(text), `${name} still says five or twelve`);
  }
  assert.ok(/eleven work practices: seven counted by code and four classified/.test(readme));
  assert.ok(/eleven practices/.test(privacy) && /Four are classified/.test(privacy));
  assert.ok(/four classified by their own model/.test(command));
  assert.ok(!/- `raises_risks`:/.test(readme), "README lists raises_risks as classified");
});

// --- run from npx with the agent you choose (REB-1149) -----------------------
test("README leads with npx and has the agent section, the flags and the local log", () => {
  const youllNeed = readme.indexOf("## You'll need");
  const how = readme.indexOf("## How it goes");
  const which = readme.indexOf("## Which agent writes and classifies");
  assert.ok(youllNeed > 0 && how > youllNeed && which > how);
  assert.ok(readme.slice(how, which).indexOf("npx @letsrebase/verify") < readme.slice(how, which).indexOf("git clone"), "npx must come before the clone");
  assert.ok(readme.slice(how, which).includes("slash-command"));
  const section = readme.slice(which, readme.indexOf("## Sources"));
  for (const t of ["oh-my-pi", "Claude Code", "Codex", "--agent", "--model", "--yes", "agent-log.jsonl", "claude-agent-acp", "codex-acp", "generatedBy.narrative", "practices.classifiedBy"]) {
    assert.ok(section.includes(t), `README agent section lacks ${t}`);
  }
  assert.ok(readme.includes("`npx @letsrebase/verify` | on a terminal, the wizard"), "Commands table lacks the wizard row");
  assert.ok(/claude-opus-4-7 through the API prompt/.test(readme), "gate section must say whose figures these are");
});

test("PRIVACY discloses the chosen agent's provider, the npm adapters, the local log and the recorded agent", () => {
  const s = privacy.slice(privacy.indexOf("## 2b."), privacy.indexOf("## 3."));
  assert.ok(s.length > 0, "PRIVACY lacks 2b");
  for (const t of ["provider", "npm", "agent-log.jsonl", "{ agent, model }", "admins", "transcript"]) {
    assert.ok(s.includes(t), `PRIVACY 2b lacks ${t}`);
  }
});

test("the slash command says npx is the main way and records slash-command", () => {
  assert.ok(command.includes("npx @letsrebase/verify") && command.includes("`slash-command`"));
});

test("the omp registry label is oh-my-pi", async () => {
  const { AGENTS } = await import("../src/agents/registry.mjs");
  assert.equal(AGENTS.find((a) => a.id === "omp").label, "oh-my-pi");
});
