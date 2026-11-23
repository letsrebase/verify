// Sign-in against the rebase hub: the device authorization of the hub's
// work profile design (a small RFC 8628). The CLI asks for a code, the person
// approves it in the browser, and the CLI polls until it holds an access token.
// The token is returned to the caller and lives only in memory: it can send one
// profile and is spent by it, so there is nothing to store and nothing to revoke.

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";

// The hub reads the tool version from this header on every request.
const { version: TOOL_VERSION } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
export const USER_AGENT = `rebase-verify/${TOOL_VERSION}`;

export const DEFAULT_HUB = "https://letsrebase.com";
export const PREVIEW_HUB = "https://preview.letsrebase.com";

// --hub <url>, else REBASE_VERIFY_HUB_URL, else production. `preview` is a
// shorthand for the preview host.
export function resolveHub(flagValue, env = process.env) {
  const raw = (flagValue || env.REBASE_VERIFY_HUB_URL || DEFAULT_HUB).trim();
  const url = raw === "preview" ? PREVIEW_HUB : raw;
  return url.replace(/\/+$/, "");
}

// The address the opener may be given: https (http only for a local hub), on the hub's own
// origin, and free of characters a shell would treat specially. Returns the href, or null.
export function safeBrowserUrl(raw, hub) {
  if (typeof raw !== "string" || /[\s|<>^"`]/.test(raw)) return null;
  let u;
  let base;
  try {
    u = new URL(raw);
    base = new URL(hub);
  } catch {
    return null;
  }
  const local = u.hostname === "localhost" || u.hostname === "127.0.0.1";
  if (u.protocol !== "https:" && !(u.protocol === "http:" && local)) return null;
  if (u.origin !== base.origin) return null;
  return u.href;
}

// Opens a URL with the platform's opener, never through a shell. Resolves true when the opener
// started, false when there is none; never throws.
export function openInBrowser(url, { platform = process.platform, spawnFn = spawn } = {}) {
  const [cmd, args] =
    platform === "darwin" ? ["open", [url]]
    : platform === "win32" ? ["rundll32", ["url.dll,FileProtocolHandler", url]]
    : ["xdg-open", [url]];
  return new Promise((resolve) => {
    try {
      const child = spawnFn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref?.(); resolve(true); });
    } catch {
      resolve(false);
    }
  });
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

// `parsed` is the JSON body or null when there was none; `data` is the same with {} for null.
async function postJson(fetchFn, url, body) {
  const res = await fetchFn(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json", "user-agent": USER_AGENT },
    body: JSON.stringify(body),
  });
  const parsed = await res.json().catch(() => null);
  return { res, data: parsed ?? {}, parsed };
}

// Runs the device flow and resolves with the access token. Everything that
// touches the outside is injectable so the flow tests without network or timers.
export async function signIn(hub, {
  fetchFn = fetch,
  open = openInBrowser,
  sleep = sleepMs,
  now = Date.now,
  log = console.log,
  around = (_label, fn) => fn(),
} = {}) {
  const start = await around("Asking rebase for a sign-in code", () => postJson(fetchFn, `${hub}/api/hub/cli/device`, { scope: "work_profile" }));
  if (!start.res.ok) {
    throw new Error(`could not start the sign-in (${start.res.status}): ${start.data.detail || start.data.error || "no answer from the hub"}`);
  }
  const { device_code, user_code, verification_uri, verification_uri_complete } = start.data;
  if (!device_code || !user_code) throw new Error("the hub answered the sign-in start without a code");
  let interval = Number(start.data.interval) || 5;
  const expiresIn = Number(start.data.expires_in) || 600;

  log(`\nSign in to rebase to send your profile.`);
  log(`Your code: ${user_code}`);
  const link = verification_uri_complete || verification_uri;
  // Only a link on the hub's own origin is handed to the system opener; anything else is printed.
  const href = safeBrowserUrl(link, hub);
  const opened = href ? await open(href) : false;
  if (opened) {
    log(`A browser tab should have opened. Check the code matches, then press «Autorizza».`);
    log(`If it did not open, go to: ${href}`);
  } else {
    log(`Open this address in a browser, check the code matches, then press «Autorizza»:`);
    log(`  ${link}`);
  }
  log(`Waiting for you to approve (the code is valid ${Math.round(expiresIn / 60)} minutes)...`);

  const deadline = now() + expiresIn * 1000 + 30_000;
  return around("Waiting for you to approve the sign-in in your browser", async () => {
    for (;;) {
      await sleep(interval * 1000);
      let data = null;
      try {
        const answer = await postJson(fetchFn, `${hub}/api/hub/cli/token`, { device_code });
        if (answer.res.status < 500) data = answer.parsed;
      } catch {
        data = null;
      }
      // A network error, a 5xx or a non-JSON answer is a hiccup, not a verdict (RFC 8628 § 3.5):
      // back off and keep polling until the code expires.
      if (!data) data = { error: "slow_down" };
      if (data.access_token) return data.access_token;
      switch (data.error) {
        case "authorization_pending":
          break;
        case "slow_down":
          interval += 5;
          break;
        case "access_denied":
          throw new Error("you pressed «Annulla» in the browser, so nothing was sent. Run submit again when you want to send the profile.");
        case "expired_token":
          throw new Error("the code expired before it was approved, so nothing was sent. Run submit again for a new code.");
        default:
          throw new Error(`the hub answered the sign-in with an error: ${data.error || data.detail || "unknown"}`);
      }
      if (now() > deadline) throw new Error("the sign-in took too long, so nothing was sent. Run submit again for a new code.");
    }
  });
}
