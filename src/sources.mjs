// Source resolution: which log sources get read for a run, and where they
// come from. Shared by `rebase-verify generate` (the producer) and `rebase-verify
// submit` (which re-derives ground truth from the same logs).
//
// Sources can be combined:
//   - claude-code: ~/.claude/projects, always read
//   - opencode:    ~/.local/share/opencode/{storage,opencode.db}, opt-out
//   - codex:       ~/.codex/sessions, opt-out
//   - pi:          ~/.pi/agent/sessions, opt-out
//   - omp:         ~/.omp/agent/sessions, opt-out (oh-my-pi, pi's format)
//   - cursor:      ~/.cursor/chats, opt-out (readCursor returns an EMPTY
//                  bundle with stats.backend: null on Node < 22.5 — no
//                  node:sqlite — so it just contributes zero sessions there)
//   - kimi:        ~/.kimi-code/sessions, opt-out
//
// Both opencode backends (sqlite and JSON) live in src/adapters/opencode.mjs;
// this file just decides *whether* to read each source at all and *which*
// backend, keyed by source name so future adapters slot in as another
// `sources.<name>` block below without touching the others.

import { readClaudeCode } from "./adapters/claude-code.mjs";
import { readOpencode, readOpencodeJson, defaultOpencodeRoot, mergeSources } from "./adapters/opencode.mjs";
import { readCodex, defaultCodexRoot } from "./adapters/codex.mjs";
import { readPi, defaultPiRoot } from "./adapters/pi.mjs";
import { readOmp, defaultOmpRoot } from "./adapters/omp.mjs";
import { isAgentRun } from "./agent-run.mjs";
import { readCursor, defaultCursorRoot } from "./adapters/cursor.mjs";
import { readKimi, defaultKimiRoot } from "./adapters/kimi.mjs";

// rebase-verify's own agent runs leave transcripts in the agents' session
// stores; they are dropped here, once, for every source.
function dropAgentRuns(b) {
  // Files go too: they feed the provenance manifest and the malformed-line
  // count, and a run killed mid-write leaves a truncated line. A file is an
  // agent run's by its recorded cwd, or by its path (encoded cwd dirs).
  const sessions = b.sessions.filter((s) => !isAgentRun(s.cwdRaw));
  const files = b.files.filter((f) => !isAgentRun(f.cwdRaw) && !isAgentRun(f.relPath));
  return { ...b, sessions, files };
}

// The sources in the order they are read and shown. `claude-code` is the base
// and is always read by readAllSources; the others are opt-out.
export const SOURCES = [
  { id: "claude-code", label: "Claude Code" },
  { id: "opencode", label: "opencode" },
  { id: "codex", label: "Codex" },
  { id: "pi", label: "pi" },
  { id: "omp", label: "oh-my-pi" },
  { id: "cursor", label: "Cursor" },
  { id: "kimi", label: "Kimi" },
];

/**
 * Read one source by its id (see SOURCES) with agent-run transcripts dropped,
 * or null when `sources.<id>.disabled`. Same roots and flags as readAllSources.
 * `onProgress({ done, total })` is called as the files of the source are read, for the
 * sources that are files (the sqlite ones are read in one query).
 */
export function readSource(id, { claudeRoot, sources, onProgress }) {
  if (id === "claude-code") return dropAgentRuns(readClaudeCode(claudeRoot, { onProgress }));
  const o = sources?.[id] ?? {};
  if (o.disabled) return null;
  switch (id) {
    case "opencode": {
      // `flag("opencode-root")` returns null when the flag is absent, so we
      // can't rely on a default parameter alone. Fall back to
      // defaultOpencodeRoot() when o.root is null OR undefined.
      const root = o.root ?? defaultOpencodeRoot();
      return dropAgentRuns(o.json ? readOpencodeJson(root) : readOpencode(root));
    }
    case "codex": return dropAgentRuns(readCodex(o.root ?? defaultCodexRoot(), { onProgress }));
    case "pi": return dropAgentRuns(readPi(o.root ?? defaultPiRoot(), { onProgress }));
    case "omp": return dropAgentRuns(readOmp(o.root ?? defaultOmpRoot(), { onProgress }));
    case "cursor": return dropAgentRuns(readCursor(o.root ?? defaultCursorRoot()));
    case "kimi": return dropAgentRuns(readKimi(o.root ?? defaultKimiRoot()));
    default: throw new Error(`unknown source: ${id}`);
  }
}

/** One parsed set from the bundles read (a single bundle is returned as it is). */
export function combineSources(bundles) {
  return bundles.length > 1 ? mergeSources(...bundles) : bundles[0];
}

export function readAllSources({ claudeRoot, sources, onProgress }) {
  const bundles = [];
  for (const { id } of SOURCES) {
    const b = readSource(id, { claudeRoot, sources, onProgress: onProgress && ((p) => onProgress({ ...p, source: id })) });
    // claude-code is always part of the result; the others only when they have sessions.
    if (b && (id === "claude-code" || b.sessions.length)) bundles.push(b);
  }
  return combineSources(bundles);
}
