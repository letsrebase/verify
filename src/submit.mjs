// Sending the profile to the rebase hub.
//
// The candidate generates the profile FIRST (saved locally), then submits as a
// second, explicit step: sign in in the browser (src/hub.mjs), then POST
// candidate.json as the single multipart part `profile`. The hub knows who
// sent it from the token, so `contact` never leaves the machine, and it takes
// no attachments, so a project artifact must be a link.

import { readFileSync, existsSync } from "node:fs";
import { resolveHub, signIn, USER_AGENT } from "./hub.mjs";

// The exact JSON that leaves the machine, as one pure step, shared by the
// real POST and `submit --dry-run`, so what the candidate inspects IS what is
// sent. Does not mutate its input.
export function buildPayload(profile) {
  if (profile.schema !== "playnew-profile/v1") throw new Error(`expected schema playnew-profile/v1, got ${profile.schema}`);
  const file = (profile.projects ?? []).find((p) => p.artifact?.type === "file");
  if (file) {
    throw new Error(`project ${file.id} attaches a file; the hub takes links only. Replace it with a link (a deploy URL, a repo, a PR) or remove the artifact in out/candidate.json.`);
  }
  const payload = structuredClone(profile);
  // Strip repoLabel from every project before sending. The label is the
  // candidate's own directory name and is meant ONLY to help them recognise
  // their projects locally during curation, it must not reach rebase.
  stripRepoLabels(payload);
  // The sign-in identifies the person; nothing typed about them is sent.
  delete payload.contact;
  return payload;
}

// What the person is told before anything is sent: who receives it, what it holds, what a person at
// rebase does with it, how long it is kept, what never leaves the machine. One text for the
// sub-command and for the wizard, so the screen before the last question is the same in both.
export function sendNotice({ hub, profile, cmd }) {
  const links = (profile.projects || []).filter((p) => p.artifact).length;
  return [
    `About to send to rebase (${hub}):`,
    `  profile: ${profile.volume?.sessions} sessions, ${profile.volume?.products} products`,
    `  artifact links: ${links}`,
    ``,
    `You sign in in the browser first, so rebase knows it is you; no name, email or city is sent with the profile.`,
    `A person at rebase reads it before it counts. If they approve it, your profile gets «Verificato da rebase»,`,
    `companies rebase works with can see its summary, its domains of work and the sectors of its representative projects, next to your name and your card (written by your model, reviewed by you), for example in the talent cloud or when rebase proposes you for a project, and its text is used to write your anonymous card.`,
    `It is kept at most 12 months, and you can delete it from your member area.`,
    `Controller: Rebase S.r.l. (VAT IT 14971460960). Details: https://letsrebase.com/privacy and PRIVACY.md.`,
    `NOT sent: raw logs, local repo context, third-party proper names.`,
    `Repository names (repoLabel) are stripped from the payload before it leaves your machine.`,
    `Inspect the exact outgoing payload:  ${cmd} submit --dry-run`,
  ];
}

// Signs in, then posts. `fetchFn`, `open`, `sleep` and `log` are injectable; `around(label, fn)`
// wraps each wait (the sign-in code, the approval in the browser, the upload) so a caller can show it.
export async function submitProfile(profilePath, { hub, fetchFn = fetch, around = (_label, fn) => fn(), ...flow } = {}) {
  if (!existsSync(profilePath)) throw new Error(`profile not found: ${profilePath}`);
  // Refuse before signing in: no point asking for a browser round trip for a payload the hub would reject.
  const payload = buildPayload(JSON.parse(readFileSync(profilePath, "utf8")));

  const base = resolveHub(hub);
  const token = await signIn(base, { fetchFn, around, ...flow });

  const form = new FormData();
  form.append("profile", new Blob([JSON.stringify(payload)], { type: "application/json" }), "candidate.json");
  let res;
  try {
    res = await around("Sending your profile to rebase", () => fetchFn(`${base}/api/hub/work-profiles`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "user-agent": USER_AGENT },
      body: form,
    }));
  } catch (e) {
    throw new Error(`could not reach the hub to send the profile (${e.message}). The sign-in is spent by the first attempt, so run submit again and sign in anew.`);
  }
  if (res.status === 401) {
    throw new Error("the hub did not accept the sign-in (it is valid for one profile only and 15 minutes). Run submit again to sign in anew.");
  }
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`submit failed ${res.status}: ${text}. If the profile was refused for its content, fix it and run submit again; a retry needs a new sign-in.`);
  }
  return await res.json().catch(() => ({}));
}

function stripRepoLabels(profile) {
  for (const p of profile.projects ?? []) delete p.repoLabel;
  for (const o of profile.otherProjects ?? []) delete o.repoLabel;
}
