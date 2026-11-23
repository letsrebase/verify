# rebase-verify

> `rebase-verify`: show rebase how you work, and get verified for it.

Credit where it is due: this is [`letsrebase/verify`](https://github.com/letsrebase/verify), rebase's fork of [apply-new](https://github.com/Play-New/apply-new) by Play New, released under the MIT licence. rebase adapts it so that freelancers in the rebase community can send their work profile to the rebase hub, where a person reviews it before it counts for anything. If approved, the profile earns «Verificato da rebase» and companies rebase works with can see its summary, its domains of work and the sectors of its representative projects, next to your name and your card, for example in the talent cloud or when rebase proposes you for a project (written by your own model, reviewed by you); its text is also used to write your anonymous card. It is kept at most 12 months and you can delete it from your member area. `submit` sends to rebase, never to Play New. Changes that fit the original go back upstream as pull requests; how the two are kept apart is in [AGENTS.md](AGENTS.md).

A CV is a list of what you did, formatted for keyword scans. For work that happens inside agent logs, it's the wrong surface. The signal that matters (how you decompose, how you verify, what you do when the model misunderstands) already exists in your agent sessions, whichever CLI they happen to live in. A resume can't see it.

This tool makes it visible. You run it on your laptop, you see the profile before anyone else does, and you decide whether to send it to rebase. The tool doesn't score you; if a person at rebase approves the profile, it earns «Verificato da rebase», which the talent cloud lists first. The profile describes how you work, and it opens a conversation.

## You'll need

Node 20.12 or newer, one coding agent installed and signed in (or an Anthropic API key), and a terminal. Nothing to clone.

## How it goes

```
npx @letsrebase/verify
```

On a terminal this starts a short wizard. It lists the sources it found in your logs, asks which coding agent should write the narrative and classify the practices (the default is the tested agent with most sessions in your logs, on that agent's current model), shows a consent note, then runs with live progress. It asks nothing about who you are. Two files come out in `out/`: `profile.md` for humans, `candidate.json` for agents (plus working files described under "Work practices" and "Commands"). The wizard ends with a summary and a choice: submit now or later. You can keep the profile for yourself.

To submit later:

```
npx @letsrebase/verify submit --yes
```

The second way is the Claude Code slash command from a clone. It uses your Claude Code session as the agent and records `slash-command` as the agent in the profile (a narrative you wrote by hand and ran through `prepare` and `finalize` is labelled `slash-command` too):

```
git clone https://github.com/letsrebase/verify
cd verify
claude
> /rebase-verify
```

Then `node bin/rebase-verify.mjs submit --yes`.

## Which agent writes and classifies

The narrative and the four model practices are written by a coding agent you choose, started over ACP (the Agent Client Protocol). Each turn (the narrative, then each batch of 10 sessions) runs in its own agent session, with a minimal environment: no API keys unless the agent needs its own.

| Agent | How it is started | Tools | Transcript of the run | Tested |
|---|---|---|---|---|
| oh-my-pi | `omp acp`, natively | switched off | oh-my-pi keeps one; rebase-verify removes it and never reads it | yes |
| Claude Code | the adapter `@agentclientprotocol/claude-agent-acp`, downloaded with npx when picked | switched off | none kept; it leaves an empty folder that rebase-verify removes | yes |
| Codex | the adapter `@agentclientprotocol/codex-acp`, downloaded with npx when picked | read-only mode, with an instruction not to use tools | Codex keeps one; rebase-verify removes it and never reads it | yes |
| OpenCode, Gemini CLI, Cursor, Copilot CLI, Kimi, Qwen Code | their own ACP mode, offered when installed | not switched off; any tool use stops the run and its answer is thrown away | depends on the agent | no |
| Anthropic API | your `ANTHROPIC_API_KEY` | none | none | no agent; the gate figures were measured with this prompt |

The tools are switched off where the agent allows it (oh-my-pi, Claude Code). Codex runs read-only with an instruction not to use tools. Agents not tested rely on the stop-on-tool rule, which also backs up the others: any tool use stops the run and its answer is thrown away. The tool never reads its own agent runs: they live in temp folders named `rebase-verify-agent-run-*` and are skipped as a source.

**Model.** The wizard offers the agent's current model by default and lets you pick another. For scripts: `npx @letsrebase/verify generate --agent <id> --model <id> --yes`. `--model` needs `--agent`; `--yes` skips the wizard and every prompt.

**Local log.** `out/agent-log.jsonl` holds every message exchanged with the agent except the answers to initialize and authenticate: your messages and the agent's answers. It stays on your machine and is never sent. Delete `out/` to remove it.

**What is recorded.** The profile records `generatedBy.narrative` and `practices.classifiedBy` as `{ agent, model }`, and the hub shows the latter next to «dal modello della persona, non ricontrollato». The gate figures in "Work practices" hold for claude-opus-4-7 only; any other model is recorded, not measured.

## Sources

The tool reads every supported agent CLI it finds on your machine and folds them into one profile. Each source is disclosed in the profile's `sources` block with its capture level: *full* means tamper-evident records the authenticity screen can verify, *structural* means well-formed data without a verification story.

| | Reads from | Skip with | Capture |
|---|---|---|---|
| [![Claude Code](https://img.shields.io/badge/Claude_Code-555?logo=claudecode&logoColor=white)](https://claude.com/claude-code) | `~/.claude/projects` | always read (`--root` points it elsewhere) | full |
| [![opencode](https://img.shields.io/badge/opencode-555?logo=opencode&logoColor=white)](https://opencode.ai) | `~/.local/share/opencode` (sqlite; JSON fallback via `--opencode-json`) | `--no-opencode` | structural |
| [![Codex CLI](https://img.shields.io/badge/Codex_CLI-555)](https://github.com/openai/codex) | `~/.codex/sessions` | `--no-codex` | structural |
| [![pi](https://img.shields.io/badge/pi-555?logo=pi&logoColor=white)](https://pi.dev) | `~/.pi/agent/sessions` | `--no-pi` | structural |
| [![cursor-agent](https://img.shields.io/badge/cursor--agent-555?logo=cursor&logoColor=white)](https://cursor.com/cli) | `~/.cursor/chats` (sqlite; needs Node 22.5+, otherwise read as empty and disclosed) | `--no-cursor` | structural |
| ![omp](https://img.shields.io/badge/oh--my--pi-555) | `~/.omp/agent/sessions` | `--no-omp` | structural |
| ![kimi-code](https://img.shields.io/badge/kimi--code-555?logo=moonshotai&logoColor=white) | `~/.kimi-code/sessions` | `--no-kimi` | structural |

Every source normalizes into the same session model, so all seven lenses below read them identically. Each `--<source>-root <dir>` flag overrides the default location. What never gets opened per source (credential files, config, telemetry) is enumerated in [PRIVACY.md](PRIVACY.md). Gemini CLI and ChatGPT / Claude.ai exports are on the roadmap.

## What we look at

Seven lenses, all built from your logs.

**What you work on.** Three to five fields of work, derived from the evidence of every product in your logs (type of work, stack, code areas, research topics). Each domain carries a count of products and sessions, never a name: "talent operations, 8 products, 14 sessions".

**How you reason.** Cognitive tags derived from concrete signals: *research-first* if your read-to-edit ratio is above 2, *orchestrator* if you delegate to sub-agents 15+ times, *verification-heavy* if checks run in half your projects, *risk-calibrated* if your revert-to-commit ratio stays below 10%. A short paragraph from your Claude on decomposition, verification, error handling, calibrated trust.

**How you work with the model.** One continuous axis from *directing* (long structured prompts, file paths, acceptance criteria) to *co-thinking* (short conversational turns, open questions, the model as a partner). The midpoint is co-construction. Most people switch by context, and the narrative says when.

**How deeply Claude is your practice.** Active days over the observed window, median sessions per active day, session depth, longest streak, peak day. The difference between *daily driver, deep sessions* and *occasional, short bursts on specific tasks*.

**How you spread your work.** Sessions per product, concentration on your top products, products carried across months. Two sessions each across twenty products reads as portfolio steering; nine sessions each across nine products reads as sustained building. Both are legitimate shapes, and they match different projects.

**How long you have used each technology.** For every technology the stack detection saw (always a public label such as Supabase or Playwright, never a repo, client or private package name), how many sessions, products and distinct calendar months it appears in, and the first and last month. A plain-language band labels the month counts: *continuous* (6+ months, and present in at least 75% of the months between its first and last), *recurring* (3+ months), *occasional* (1 to 2 months). The thresholds are empirical, like the cognitive-tag ones, and the band is a label for the counts printed next to it, never a score. The stack is detected per product, so the session count means "sessions in products where the technology was detected", an upper bound on sessions that touched it. Months are bucketed in the same `--tz` as the day counts, and no model is involved. At submit the month window (first month, last month, month count) and the band are hard checks against your logs; session and product counts and the presence of a technology depend on your repos as they are on disk now, so a difference there is a warning, not a block.

**How fluent you are in the agentic stack.** Three axes: what you use (sub-agents, MCP servers, slash commands you invoke), what you build (skills, commands, hooks, the `CLAUDE.md` files you maintain), and how you organise work (planning, subtask tracking, clarifying before assuming). All counts. Custom MCP servers and custom skills are counted but never named (they can carry client information).

Plus a trajectory block (how your behavior shifted across the observed window), three to five representative projects (adaptive: flagships by significance, extra slots only for type diversity or comparable significance), each carrying per-product orchestration counts: sessions per agent CLI (with overlapping vs disjoint activity periods), sub-agent delegations, and headless agent-dispatch commands (to the same tool or another; all lower bounds), and a groundedness check (the prose has to track back to the data; below 60%, submission is blocked).

At submit time everything is re-checked, not trusted: groundedness is recomputed on the file as it is now, the structured numbers are re-derived from your logs (the profile can't claim more sessions, commits or code practice counts than the logs contain), and the intake recomputes groundedness and the structural invariants server-side on what it receives. An incoherent hand-edit of `candidate.json` doesn't survive the trip; the log-level re-derivation runs only on your machine, since your logs never leave it.

The profile also discloses its own coverage: a `sources` block records which log sources were read, at what capture level (*full* = tamper-evident records the authenticity screen can verify; *structural* = well-formed data without a verification story), and how many sessions each contributed. The window and every count are **lower bounds** of your real activity, logs rotate and old sessions are pruned, so what the tool can still see is never more than what you did. Like the authenticity score, this is a screen, not proof.

## Work practices

The profile also carries counts of eleven work practices: seven counted by code and four classified by your own model. Each one is shown as "seen in N of M sessions", with the number of products and months it spans. It is never a score, a percentage or a total, and nothing here says anything about tone, skill or character. You can read the counts in the "How the work is done" section of `out/profile.md` before you submit anything. That section only appears when at least one practice could be counted in your sessions.

The seven code practices are counted from the tool calls and file paths your logs already contain. No model is involved and nothing new is read.

Each code practice is counted against the sessions where it could have happened (M):

- `checks_before_commit`: After the last file edit before a git commit, a check ran in the session: tests, a linter, a type check or a build. M is the sessions with a commit.
- `tests_with_changes`: Both a source file and a test file were edited in the session. M is the sessions that edited a source file.
- `failure_reproduced_before_fix`: A check command (tests, a linter, a type check or a build) failed, files were edited, and then the same check succeeded in the session. M is the sessions where a check command failed.
- `plan_before_edit`: A planning step came before the first file edit in the session: plan mode, a task list, or writing a plan or spec file. M is the sessions with an edit.
- `reviews_changes`: Before a commit or a pull request, the diff appeared in the session (git diff, git show or gh pr diff), whoever asked for it; the session cannot show whether anyone read it. M is the sessions with a commit or a pull request.
- `design_documents`: A design document (an ADR, RFC, spec or design file, by path) was written or edited in the session. M is the sessions with an edit.
- `security_checks`: A dependency audit or a security scanner ran in the session. M is the sessions with an edit.

The four model practices are classified by the coding agent and model you chose (see "Which agent writes and classifies"), not by rebase: the agent picked in the wizard or with `--agent`, the slash-command agent in Claude Code, or your own API key when you run `generate` with `ANTHROPIC_API_KEY` set. They read at most 60 sampled sessions (only sessions with at least two messages from you, spread across products and months) and at most 12 of your own messages in each, first and then evenly spaced, each cut to 600 characters and already redacted. The agent's replies and your files are never read, and neither are the texts an agent wrote: Claude Code sub-agent briefs, task notifications, compaction summaries, and opencode child sessions are skipped. The model answers one yes or no per practice per session, and nothing else. Tone, feelings, politeness and wording quality are never grounds for a yes. M is the number of sessions classified, at most 60:

- `asks_for_alternatives`: asks for options or trade-offs before choosing one.
- `pushes_back_with_reason`: rejects or corrects what the agent proposed or did, and says why.
- `states_done_criteria`: states acceptance criteria, the expected behaviour, or the check that proves it.
- `limits_scope`: cuts, splits or defers part of the work explicitly.

With the slash command, your messages go to whatever provider your agent already uses; rebase never receives them. With `generate` and `ANTHROPIC_API_KEY` set, the sample (up to 60 sessions, 12 messages of 600 characters each, yours, redacted) is sent to api.anthropic.com under your key, even when `--narrative-file` is given. Only the counts leave your machine for rebase. The per-session answers stay in `out/practices-detail.json`, which is never sent. The slash command's clean-up step deletes `out/practices-input.json`, `out/practices-sample.json` and `out/practices.json`; with `generate` or a manual `prepare` and `finalize` they stay in `out/` until you delete it (`out/` is the one folder to delete), and the next `prepare` replaces them. The hub shows these four as "dal modello della persona, non ricontrollato": it cannot recheck them, because your messages never reach it.

**How the four were checked.** A model practice is published only if it reaches 90% on two checks, measured with the shipped prompt wording and examples (with all six candidates in the prompt, where production lists only the four published) and the shipped message selection. The stability sessions came from Claude Code and omp logs, where the skip of opencode child sessions does not apply. Pooled agreement: the model's answers match a written reference set of 224 sessions (Italian and English, with at least 8 clear cases and 8 near misses per practice, expected answers fixed when written and checked by a blind second reader, a separate agent given only the messages and the rubric). Every session is classified on all six candidates, so each practice is also tried on the other practices' sessions. Stability: two runs of the model on the same 40 real sessions give the same answer (the developer's own sessions, client work excluded). The reference sessions were written by an agent, not by people. The model measured was `claude-opus-4-7`, through the API-path prompt in batches of 10 sessions, so these figures hold for that model and that prompt, not for whichever model you run or for the slash-command path:

| Practice | Positives found (own sessions) | Near misses not counted (own sessions) | False positives on other practices' sessions | Pooled agreement (224) | Stability (40, true in run A / run B) | Result |
|---|---|---|---|---|---|---|
| `asks_for_alternatives` | 20/20 | 20/20 | 1 | 223/224 | 39/40 (4 / 3) | published |
| `pushes_back_with_reason` | 16/16 | 20/20 | 5 (and 1 missed secondary positive) | 218/224 | 38/40 (10 / 8) | published |
| `states_done_criteria` | 20/20 | 20/20 | 1 | 223/224 | 38/40 (3 / 3) | published |
| `gives_context_and_constraints` | 20/20 | 14/20 | 22 | 196/224 | 35/40 (26 / 31) | not published (agreement and stability below 90%) |
| `raises_risks` | 17/17 | 16/17 | 3 | 220/224 | 35/40 (2 / 5) | not published (stability below 90%) |
| `limits_scope` | 18/18 | 15/16 | 4 | 219/224 | 39/40 (6 / 7) | published |

How to read the table. A classifier that always answered false would score 202 to 207 of 224 pooled, which is why the two own-session columns matter more than the pooled figure. Almost every miss is a false positive: the model errs towards counting a practice, so read each count as an upper bound. Stability rests on few true answers for some practices (3 to 10 per run), so it shows that the answers repeat, not that they are right. The reference sessions are written, not real: the blind second reader, a separate agent, labelled them, and the sessions where it disagreed with the writer were rewritten or dropped (6 rewritten, 16 dropped of 240), so the agreement figures are on cases two readers agree on. Some of the 40 stability sessions were dispatched by an agent rather than typed by a person. Neither number is accuracy on real sessions.

`gives_context_and_constraints` (explains the goal, the constraints, or who the work is for, before asking for changes) and `raises_risks` (raises a risk: security, data loss, cost, performance, compatibility, rollout) did not reach the threshold, so they are not published and are not classified. To run the checks again: `node scripts/practices-gate.mjs agreement` and `node scripts/practices-gate.mjs stability` (see the header of the script for the options).

The figures above hold for claude-opus-4-7 through the API prompt. With another agent or model the profile records which one answered and the hub shows it, but its accuracy was not measured.

How it is read:

- **Paths.** Paths are compared lower-cased, with a backslash read as a forward slash, and read relative to the project folder of the session, so a folder above the project named `test` or `specs` changes nothing. A test file is one under a `test/`, `tests/`, `__tests__/` or `spec/` folder, or named `*.test.*`, `*.spec.*`, `*_test.*` or `test_*.py`. A design document is one under an `adr/`, `rfcs/`, `docs/rfc/`, `docs/design/` or `specs/` folder, or named `adr-*`, `*-adr.md`, `rfc*`, `design.md`, `*-design.md` or `*-spec.md`. A plan is one under a `plans/` or `specs/` folder, or named `plan.md`, `*-plan.md` or `*-spec.md`. So a spec file counts as a plan, and an ADR does not. A source file is a code file by extension: `.js`, `.mjs`, `.cjs`, `.jsx`, `.ts`, `.mts`, `.cts`, `.tsx`, `.vue`, `.svelte`, `.py`, `.go`, `.rs`, `.java`, `.kt`, `.kts`, `.scala`, `.rb`, `.php`, `.cs`, `.c`, `.cc`, `.cpp`, `.h`, `.hpp`, `.swift`, `.m`, `.dart`, `.ex`, `.exs` or `.lua`. Other files such as `.sql`, `.sh`, `.html` or `.css` are not source files. A test file is never a source file, and config files (`*.config.*`), type declarations (`*.d.ts`), `conftest.py`, `setup.py` and anything under `docs/` are not counted as source files either.
- **Commands.** rebase-verify reads each command up to its first 240 characters, so a check at the end of a long chained command can be missed. Leading environment assignments and runner wrappers such as `npx`, `uv run`, `python -m` and `pnpm exec` are skipped before a command is matched.
- **Reviews.** `reviews_changes` means the diff appeared in the session, whoever asked for it. It does not mean anyone read it. Options that list files or statistics instead of the diff, such as `--stat` and `--name-only`, and `git show <rev>:<path>`, do not count as a diff appearing.
- **Failures.** `failure_reproduced_before_fix` only counts failed checks. A failed command that contains a check counts as a failed check, and in a chain such as `npm test && git push` the exit status cannot say which part failed, so the chain counts as its first check. Two runs are the same check when their command words match (the words before the first flag or path, wrappers dropped), so a narrower rerun of the same check (`pytest tests/a.py` after `pytest`) is the same command. Pi, oh-my-pi and Cursor sessions are left out of this practice, because their logs cannot show a failure reliably. A session whose adapter cannot give a field for a practice is left out of that practice rather than counted as not seen.
- **Sessions with no time.** A session with no timestamped message cannot be placed in a month, so it is left out of every practice's counts. A practice no session could show (M is 0) is left out of the profile.
- **Counts only.** Only the counts leave your machine, never a command, a path or a file name.
- **At submit.** The seven code practices are counted again from your logs, in the timezone the profile recorded, and a profile that claims more than that count is blocked, like the other numbers. The four model practices cannot be counted again, so only their shape is checked.

The full rules are in `share/practices.json`, generated from `src/practices-rules.mjs`: every command pattern, the path patterns, the source extensions, the commit and pull request patterns, and the tool names read as a planning step or an edit.

## What it isn't

It isn't a personality test, and the cognitive tags are descriptive: there's no "better" tag, only different patterns. The profile doesn't compare you with anyone else, and it doesn't predict performance.

It doesn't score you. The only scores in the pipeline (authenticity, groundedness) measure the *report's* integrity: whether the logs are internally consistent and the prose tracks the data, never you. Nothing counts until a person at rebase has read the profile and approved it. Approval means three things: your profile carries «Verificato da rebase», and the talent cloud lists verified talents first; companies rebase works with can see its own summary, its domains of work and the sectors of its representative projects, next to your name and your card (for example in the talent cloud or when rebase proposes you for a project), which your own model wrote and you reviewed; and the profile's text is used to write your anonymous card, through the AI provider named in [rebase's privacy notice](https://letsrebase.com/privacy). Deleting the profile does not remove «Verificato da rebase»; write to ciao@letsrebase.com to have it removed. A person decides; the tool never does.

It doesn't replace a conversation. The decision about humans stays with humans.

## What we send, what we don't

You sign in to rebase in your browser when you send, so rebase knows it is you: no name, email or city goes with the profile, and the tool no longer asks for them. What is sent is the profile JSON (counts, abstract domains, tags, a short narrative, and any artifact *link* you chose to add). We don't see client names, product names, person names, repository names, your code, or your raw logs. The redaction runs on your machine before anything leaves it. rebase takes no attached files: an artifact has to be a link.

The profile waits as a draft until a person at rebase reviews it. It is kept at most 12 months, and you can delete it from your member area at any time. Locally, everything the tool generated lives in the `out/` folder: delete it and it's gone.

## Policy

Legal basis: explicit consent (GDPR Art. 6(1)(a)). You run `submit --yes` after seeing what's in the payload, and you can read the exact payload first with `submit --dry-run`. The controller is the one named in [rebase's privacy notice](https://letsrebase.com/privacy). Retention: at most 12 months from the day you send it, and you can delete it earlier from your member area. Your rights (access, rectification, erasure, portability, objection) are exercised by writing to ciao@letsrebase.com.

Under the EU AI Act (Regulation 2024/1689), systems that filter job applications and evaluate candidates are classified high-risk (Annex III §4(a)). We treat the work profile that way. Transparency: this README and the source on GitHub. Human oversight: no automated decision; a person at rebase reads each profile, and only that person's approval verifies it. Disclosure: you're interacting with an AI tool. Data governance: raw logs stay local, only a consented subset is transmitted, retention is declared. Full text in [PRIVACY.md](PRIVACY.md).

## Limits

You decide which projects rebase sees, so the tool can't see what's missing. Logs of solo work mostly show execution, which means leadership, mentoring, and the work of being with humans is invisible from here. The thresholds (read-to-edit above 2, ≥15 delegations) are empirical: we don't know yet how they hold across hundreds of people. The narrative is written by a model; the prompt constrains it, it doesn't make it neutral. A person at rebase reads each profile by hand, and we're still learning what to look for.

The four model practices come from your own model reading your own messages: you can steer your agent or edit the answers file, and the hub cannot recheck them. Agent-written text is skipped only where the logs mark it (Claude Code sub-agent briefs, task notifications, compaction summaries, opencode child sessions); a session another tool's agent drove (a dispatched or headless run) can still be read as if you typed it, since the logs cannot always tell.

If you spot something we should change, [open an issue](https://github.com/letsrebase/verify/issues).

## Commands

| | |
|---|---|
| `npx @letsrebase/verify` | on a terminal, the wizard: finds your sources, lets you pick the agent and the model, writes and classifies the profile, shows a summary, then submits now or later |
| `generate --agent <id> --model <id>` | the same without the wizard, for scripts; add `--yes` to skip every prompt |
| `generate` *(default)* | full profile, locally; with `ANTHROPIC_API_KEY` set, the key sends the practices sample, and the narrative input unless `--narrative-file` is given, to Anthropic |
| `prepare` | `out/narrative-input.json`, for writing the narrative manually, and `out/practices-input.json` with `out/practices-sample.json` for the model practices; `finalize` must get the same `--tz` |
| `finalize --narrative-file out/narrative.json` | finalize after `prepare` |
| `submit --dry-run` | write the exact outgoing payload to `out/payload-preview.json`, send nothing |
| `submit --yes` | sign in to rebase in the browser, then send the profile; a person at rebase reviews it |

All commands run as `node bin/rebase-verify.mjs <sub>` or as `rebase-verify <sub>` after `npm link`. Common flags: `--top N` (force the project count; default is adaptive 3–5), `--root <dir>`, the per-source roots and opt-outs from the Sources table above, `--hub <url>` (where `submit` sends; default `https://letsrebase.com`, also settable with `REBASE_VERIFY_HUB_URL`; `--hub preview` means `https://preview.letsrebase.com`), `--lang <code>` (the language the profile is written in: `it` Italian, the default, or `en` English; it sets the language of the model-written prose and of `out/profile.md`, and is recorded as `language` in the profile; the enum codes in the payload stay English), `--tz <IANA zone>` (bucket the day and month counts (active days, streak, technology-usage months) in your timezone instead of the UTC default; the zone you choose is recorded in the profile, which is also why UTC is the default: a zone names a place, and nothing location-shaped should leave your machine unless you opt in). Without Claude Code, set `ANTHROPIC_API_KEY` and the narrative goes through the API instead of your subscription, note that on this path the narrative input (project labels, README/CLAUDE.md excerpts, dependency names, commit subjects, sampled prompts) is sent to api.anthropic.com under your own key, before any name-stripping; the tool warns when this happens, and an explicit `--narrative-file` always takes precedence over the key. The subscription and manual paths stay fully local until submit. Details in [PRIVACY.md](PRIVACY.md).

## Tests

```
npm test
```

## Contributing

PRs and issues are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the rules
that make this repo unusual (schema discipline, privacy boundaries, the
[ADR-001](docs/adr/001-just-a-report.md) frame, the current six-source policy).
Security issues go privately via [SECURITY.md](SECURITY.md), never as public issues.

## License

MIT. See [LICENSE](LICENSE).
