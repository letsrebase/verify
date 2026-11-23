---
description: Work profile: build your agentic work profile using your Claude subscription and send it to rebase for review
---

You are running the **narrative step** of `rebase-verify` for the human in front of you (the candidate). The deterministic pipeline (reading their Claude Code logs, redacting PII, clustering, scoring authenticity) is in `bin/rebase-verify.mjs`. Your job is to produce the qualitative prose so the candidate's own Claude subscription writes it, no API key needed.

`npx @letsrebase/verify` is the main way to make a profile now: a wizard that lets the candidate pick the coding agent. This slash command is the second way, from a clone of the repo. A profile made through it records `slash-command` as the agent that wrote and classified it, with no model.

The default is **save, don't submit**. Submitting is a separate, explicit action the candidate triggers later.

## Steps

1. **Timezone, in ONE sentence.** Day-based counts (active days, longest streak) are bucketed in UTC by default so nothing location-shaped leaves the machine; if they'd rather have them in their local timezone, you'll pass `--tz <IANA zone>` (e.g. `--tz Europe/Rome`) and the zone gets recorded in the profile. Don't push either way: UTC is a fine default. There are no contact questions: when they send the profile, they sign in to rebase and that identifies them.

2. **Run prepare.** Execute:
   ```
   node bin/rebase-verify.mjs prepare
   ```
   The profile is written in Italian unless the candidate asks for another language: then append `--lang <code>` (`it` or `en`). `finalize` reads the language back from `out/narrative-input.json`.
   If the candidate opted into a local timezone in step 1, append `--tz <zone>` here AND to the `finalize` call in step 6. `prepare` and `finalize` must use the same `--tz`: the sampled sessions in `out/practices-sample.json` and every day and month count are bucketed in that zone, and `finalize` re-reads the logs.
   Show the candidate the line `… representative: …` from the output. This is the auto-selection of representative projects, 3 to 5, adaptive: flagships by significance, plus a 4th/5th slot only when a project adds a new primary type or comparable significance. `--top N` forces a fixed count if the candidate asks.

3. **Read `out/narrative-input.json`.** It contains:
   - For each representative project: an id (`p1`, `p2`, …), a `repoLabel` (the candidate's own repo directory name, use this to talk to the candidate so they know which project you mean), type tags, sessions, repo areas touched, stack, landing signals, an `orchestration` block, sampled prompts, learning topics, LOCAL repo context.
   - The `orchestration` block per project: `delegation` (sub-agent Task calls), `tools` (per-CLI session split), `toolCount` (distinct agent CLIs; an `"unknown"` bucket never counts as one), `toolOverlap` (true = at least two CLIs active in overlapping periods, false = disjoint eras, null = nothing to compare), `dispatchCommands` (shell commands that launched an agent CLI headless, may target the same CLI, e.g. `claude -p` from a Claude Code session). Every count is a lower bound (under single-source capture `toolCount` is pinned at 1), so never read `toolCount` 1 / `dispatchCommands` 0 as "did not orchestrate". `toolCount` >= 2 with `toolOverlap` false is tool adoption/migration across different periods, not concurrent fan-out: describe cross-CLI fan-out only when `toolOverlap` is true; `dispatchCommands` > 0 evidences programmatic agent dispatch, not cross-CLI fan-out by itself. Naming the agent CLIs themselves (Claude Code, opencode, …) is fine, they are tools, not client brands.
   - A `trajectory` block: behavioral shifts (numbers, early vs late half), topic clusters per quarter from web research, `vocabularyCandidates` (raw recurring-late words, many are common chat words, you pick the technical/domain-specific ones).
   - A `principlesDiff`: lines the candidate ADDED to their own CLAUDE.md / README over time, their codified doctrine.
   - `compactionSummaries`: dense self-portraits the model wrote about earlier sessions (already redacted).
   The local context contains real names and is for your eyes only.

   **Always refer to projects by `repoLabel` when talking to the candidate** (e.g. "for *acme-storefront* you'd want to..."), never by opaque `p1`/`p2`.

4. **Write `out/narrative.json`** with exactly this shape:
   ```json
   {
     "summary": "2-3 sentences: WHAT this person works on (top domains) and HOW they work with AI.",
     "domains": [
       { "label": "abstract field of work (no proper names), derived from the domainEvidence array covering ALL products", "products": 1, "sessions": 1, "note": "1 short clause of evidence (optional)" }
     ],
     "cognitive": { "narrative": "4-6 sentences: decomposition, verification, error handling, orchestration, risk, calibrated trust in AI." },
     "agentic_literacy": { "narrative": "2-3 sentences on agentic-stack maturity. NO custom skill / MCP / project / client names. Describe in the abstract: 'has authored custom commands', 'integrates a custom MCP server', 'orchestrates extensively through sub-agents', etc." },
     "ai_relationship": { "narrative": "2-3 sentences on WHEN they pick directing vs co-thinking mode (from the AI_RELATIONSHIP block)." },
     "intensity": { "narrative": "1-2 sentences on how deeply Claude is embedded in their daily workflow (from the PRACTICE_INTENSITY block)." },
     "distribution": { "narrative": "1-2 sentences on how they spread work across products (from the WORK_DISTRIBUTION block): many products touched briefly (portfolio steering) vs few products returned to repeatedly (sustained building), and what it implies about how they engage. Neither pole is better. The summary should reflect this breadth-vs-depth shape in one clause too." },
     "trajectory": {
       "narrative": "3-5 sentences on STRATEGIC and CULTURAL change over the window. Cite the data when it backs a claim. NO stack names here, those go in the separate stack section.",
       "vocabulary_adopted": ["6-10 technical/domain words picked from vocabularyCandidates (skip common verbs/adverbs)"],
       "principles_adopted": [
         { "when": "YYYY-MM", "text": "a principle the candidate codified (paraphrased from principlesDiff, abstract, no proper names)" }
       ]
     },
     "projects": [
       { "id": "p1", "domain": "abstract domain description", "did": "2-3 sentences on what they did", "why_representative": "1 sentence" }
     ]
   }
   ```

   **Hard rules (do not bend):**
   - **No proper names.** No companies, clients, people, products, brands, repositories. Describe each project ONLY by abstract domain and context.
   - Use only the data provided in `out/narrative-input.json`. No invention, no hyperbole.
   - Evidence-based: claims supported by signals (areas, stack, landing, prompts, commits).
   - Write every text in the language `out/narrative-input.json` names in `languageName` (its `language` code is `it` for Italian, `en` for English; Italian unless the candidate passed `--lang`). Dry, readable. Technology, product, library and method names stay as written. Write numbers as plain digits exactly as they appear in the data, with no thousands separator. The JSON keys stay as shown. No emojis, no em dashes.
   - Length: summary ≤ 60 words; cognitive narrative ≤ 130 words; learning summary ≤ 40 words; ai_relationship / intensity / distribution narratives ≤ 50 words each; per-project domain ≤ 60 words; per-project `did` ≤ 60 words.
   - Domains rollup: 3-5 entries. Assign every product in `domainEvidence` to exactly one domain; the summed `products` and `sessions` across domains must not exceed the profile totals (groundedness checks this). Labels abstract, counts only, never names.

5. **Classify the model practices, only when `out/practices-input.json` exists.** If the file is not there, skip this step. Before you read anything, tell the candidate in plain words:
   - which practices are classified: the ids listed under `practices` in `out/practices-input.json`, each with its definition and examples (what counts and what does not);
   - that only their own messages are read, from the sampled sessions (at most 60 sessions, 12 messages each, already redacted), never the agent's answers, sub-agent briefs, task notifications, compaction summaries, opencode child sessions or any file;
   - that the model they are already using here answers, and rebase never receives the messages, only the counts;
   - that only the counts leave their machine ("seen in N of M sessions"), while the per-session answers stay in `out/practices-detail.json`, which is never sent.

   Then read `out/practices-input.json` and write `out/practices.json`: exactly one object per session id (`s01`, `s02`, …) and, in it, exactly one boolean per practice id. No other keys, no reasons, no quotes. Apply each definition as written, answer `false` when in doubt, and never let tone, feelings, politeness or wording quality count as a reason for `true`. Example for two practices and two sessions:
   ```json
   { "s01": { "practice_one": true, "practice_two": false }, "s02": { "practice_one": false, "practice_two": false } }
   ```
   The next step runs `finalize`, which merges the counts; it checks the file and stops with a message if it does not fit.

6. **Run finalize.** Execute:
   ```
   node bin/rebase-verify.mjs finalize \
     --narrative-file out/narrative.json
   ```
   This writes `out/candidate.json` (for agents) and `out/profile.md` (for humans).
   The profile now also carries counts of work practices (seen in N of M sessions, seven counted by code from tool calls and file paths, four classified by their own model in step 5, all visible in this profile; only the counts are carried, never the commands, paths or file names). Tell the candidate they can read them under "How the work is done" in `out/profile.md` (that section only appears when at least one practice could be counted), and that the README section "Work practices" defines each one.

7. **Show `out/profile.md`** to the candidate, then ask the four review questions below **ONE AT A TIME, in order**. Wait for an answer before moving to the next. **Do NOT enumerate them in a single block**: the goal is a conversation, not a survey.

   **Question 1: Representative projects.** State the ones that were auto-selected (3 to 5) with their repoLabel ("acme-storefront, e-commerce storefront", etc.) and ask if any should be swapped for one from the inventory. After their answer, edit `out/candidate.json` if needed.

   **Question 2: Artifacts (optional).** Artifacts MUST belong to the specific project they are attached to. Do NOT pick URLs from the candidate's `learningTopics` or recent web searches: those are research links, not artifacts. Go through the representative projects ONE BY ONE, repoLabel by repoLabel:

   - For each project, name it ("for *acme-storefront* (the e-commerce storefront), do you have a deploy URL, repo or PR that shows THIS specific project?") and wait for the candidate's reply. Links only: rebase takes no attached files, so a screenshot has to be a link to somewhere it already lives.
   - If they say no for that project, move on to the next. Skipping is fine.
   - If they offer a URL, sanity-check it against the project domain you described. If it doesn't seem to match (e.g. they give a personal site URL for a creator platform), ask before attaching.
   - Never invent or guess an artifact. Confidentiality boundary stays with the candidate, never push to attach.

   When updating `out/candidate.json`, write the artifact under the SAME project id:
   ```json
   { "id": "p1", "artifact": { "type": "url", "url": "...", "label": "..." } }
   ```

   **Question 3: New vocabulary review.** Read the list of words you picked for `vocabulary_adopted` aloud with them. Flag any borderline tokens (researcher / framework / library names are signal; client / colleague / brand names are not, distinguishing automatically is hard so you mention them, not pre-decide). Ask if there's anything they'd rather not surface. Edit `out/candidate.json` and re-render `out/profile.md` if needed.

   **Question 4: Narrative refinements.** Ask if anything in the summary, cognitive narrative, trajectory narrative, or per-project text reads off. If yes, rewrite `out/narrative.json` (same hard rules), run `finalize` again (step 6) and, because it rebuilds `out/candidate.json` from scratch, apply the edits from questions 1 to 3 again.

8. **Clean up.** Delete `out/narrative-input.json`, `out/practices-input.json`, `out/practices-sample.json` and `out/practices.json` (when present) once the candidate is satisfied (they contain local repo context or the candidate's own messages; the answers and the sample go together, because `finalize` needs both). `out/practices-detail.json` may stay as the candidate's own record. Keep `out/narrative.json`, `out/candidate.json`, `out/profile.md`.

9. **Mention the groundedness score.** The `assembleProfile` step writes `profile.groundedness.score`: show it to the candidate, e.g. "Groundedness: 92% of the verifiable anchors in the prose match your logs." If anomalies are interesting, glance at them (they're surfaced again at submit).

10. **Tell them how to submit, when ready.** Do NOT submit yourself. Say:
   > "When you're ready to send it to rebase, close this session and run `node bin/rebase-verify.mjs submit --yes` from this folder. It opens a browser tab where you sign in to rebase and press «Autorizza», so rebase knows it is you; no name, email or city is sent with the profile. A person at rebase then reads it before it counts: if they approve it, your profile earns «Verificato da rebase» and companies rebase works with can see its summary, its domains of work and the sectors of its representative projects, next to your name and your card, for example in the talent cloud or when rebase proposes you for a project, which your own model wrote and you reviewed; its text is also used to write your anonymous card. It is kept at most 12 months and you can delete it from your member area. The profile stays on your machine until you send it. You can also keep it just for yourself. To see exactly what would be sent first (repository names and contact already stripped), run `node bin/rebase-verify.mjs submit --dry-run`: it writes `out/payload-preview.json` and sends nothing."

   (If the candidate prefers the shorter `rebase-verify submit --yes`, they can `npm link` once from the repo, but `node bin/rebase-verify.mjs` works without any setup.)

## Notes

- The candidate's Claude Code subscription is doing the LLM work here. No API key required.
- If the candidate hasn't approved running shell commands, ask permission for the `node bin/rebase-verify.mjs …` invocations before executing.
- Iteration is free: re-read `out/narrative-input.json`, rewrite `out/narrative.json`, re-run `finalize`. The deterministic pipeline doesn't need to re-run unless they change `--top` or `--tz`.
