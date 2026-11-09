// Cloudflare Worker for the FPL dashboard. It does three jobs:
//
// 1. Live scores: a small read-only proxy so the dashboard can fetch live
//    scores. Browsers can't call the FPL API directly (it sends no CORS
//    headers), so the page asks this Worker, which asks FPL and passes the
//    answer back. Only two FPL endpoints are allowed - the live player scores
//    for a gameweek (event/<gw>/live/) and that gameweek's fixtures
//    (fixtures/?event=<gw>) - and each answer is cached for 60 seconds.
//
// 2. Data updates: a Cloudflare Cron Trigger (every 15 minutes) calls
//    `scheduled`, which asks GitHub to run the "Update dashboard data"
//    workflow with match_window_only = true (GitHub's own scheduler is
//    unreliable). Needs the secret GITHUB_TOKEN.
//
// 3. Deadline alerts (Web Push): invited people tap "Turn on deadline alerts"
//    on the dashboard; their phone's push address is stored here. On the same
//    15-minute timer, when FPL's next deadline is under an hour away, one
//    alert goes to everyone signed up (once per deadline). Needs:
//      - a KV namespace bound as PUSH, holding invite:<code> -> name entries
//      - the secret VAPID_PRIVATE_JWK (the private half of the push key)
//    The push itself carries no content; the phone then fetches the message
//    from /push/latest.
//
// Deploy: paste this whole file into the Cloudflare Worker (see the setup steps).

const FPL = "https://fantasy.premierleague.com/api/";
const SITE = "https://calumjbrown.github.io/fpl-dashboard/";
const ORIGINS = ["https://calumjbrown.github.io", "http://localhost:8000"];
const WORKFLOW = "https://api.github.com/repos/calumjbrown/fpl-dashboard/actions/workflows/update-data.yml/dispatches";
const UA = { "User-Agent": "fpl-dashboard (personal project)" };

// Public half of the push key (the private half is the secret VAPID_PRIVATE_JWK)
const VAPID_PUBLIC = "BA46Wre04dySuzf0tzxG20FflBJRj5oukMsBKBCTOMuBGxcj9vNOVwTw8zBoEOJxKWnfx3sLDQJLwiTJ8aQCHFA";

// Only these push services are allowed as push addresses (Apple, Google,
// Mozilla, Microsoft), so the Worker can't be used to send requests elsewhere
const PUSH_HOSTS = ["web.push.apple.com", "fcm.googleapis.com", "updates.push.services.mozilla.com", "notify.windows.com"];

export default {
  // Runs on the Cron Trigger set up in Cloudflare (every 15 minutes)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(Promise.all([triggerUpdate(env), checkDeadline(env)]));
  },

  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Methods": "GET, POST",
      "Access-Control-Allow-Headers": "Content-Type",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    const path = url.pathname.replace(/^\/+/, "");
    if (path.startsWith("push/")) return handlePush(path, request, env, cors);

    // Live scores: work out which FPL address to fetch, or refuse
    const event = url.searchParams.get("event");
    let target = null;
    if (/^event\/\d{1,2}\/live\/?$/.test(path)) {
      target = FPL + path.replace(/\/?$/, "/");
    } else if (/^fixtures\/?$/.test(path) && /^\d{1,2}$/.test(event || "")) {
      target = `${FPL}fixtures/?event=${event}`;
    }
    if (request.method !== "GET" || !target) {
      return new Response("Not found", { status: 404, headers: cors });
    }

    const upstream = await fetch(target, {
      headers: UA,
      cf: { cacheTtl: 60, cacheEverything: true },  // Cloudflare caches FPL's answer for 60s
    });
    return new Response(await upstream.text(), {
      status: upstream.status,
      headers: {
        ...cors,
        "Content-Type": upstream.headers.get("Content-Type") || "application/json",
        "Cache-Control": "public, max-age=30",
      },
    });
  },
};

// Data updates -----------------------------------------------------------------

// Ask GitHub to start the data update (what the "Run workflow" button does)
async function triggerUpdate(env) {
  const resp = await fetch(WORKFLOW, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${env.GITHUB_TOKEN}`,
      "Accept": "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "fpl-live-worker",
    },
    body: JSON.stringify({ ref: "main", inputs: { match_window_only: "true" } }),
  });
  // 204 = started. Anything else shows in the Worker's logs on Cloudflare
  if (resp.status !== 204) console.log("GitHub trigger failed:", resp.status, await resp.text());
}

// Deadline alerts ----------------------------------------------------------------

const json = (body, status, cors) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

async function handlePush(path, request, env, cors) {
  if (!env.PUSH) return json({ ok: false, error: "not set up" }, 503, cors);

  // The message the phone shows after a push arrives
  if (path === "push/latest" && request.method === "GET") {
    const msg = await env.PUSH.get("message:last", "json");
    return json(msg || { title: "FPL deadline soon", body: "The gameweek deadline is coming up." }, 200, cors);
  }
  if (request.method !== "POST") return json({ ok: false }, 404, cors);

  let input;
  try { input = await request.json(); } catch { return json({ ok: false }, 400, cors); }

  // Sign up: only with a valid invite code, and only a real push address
  if (path === "push/subscribe") {
    const name = input.invite && await env.PUSH.get(`invite:${input.invite}`);
    if (!name) return json({ ok: false, error: "invite" }, 403, cors);
    const endpoint = input.subscription && input.subscription.endpoint;
    if (!allowedEndpoint(endpoint)) return json({ ok: false, error: "endpoint" }, 400, cors);
    await env.PUSH.put(`sub:${await sha256(endpoint)}`, JSON.stringify({
      invite: input.invite, name, subscription: { endpoint }, added: new Date().toISOString(),
    }));
    return json({ ok: true, name }, 200, cors);
  }

  // Turn off: forget this phone
  if (path === "push/unsubscribe") {
    if (allowedEndpoint(input.endpoint)) await env.PUSH.delete(`sub:${await sha256(input.endpoint)}`);
    return json({ ok: true }, 200, cors);
  }

  // Test: send a test alert to this invite's phones only
  if (path === "push/test") {
    const name = input.invite && await env.PUSH.get(`invite:${input.invite}`);
    if (!name) return json({ ok: false, error: "invite" }, 403, cors);
    const result = await pushTo(env, { title: "Test alert", body: `Hi ${name}, deadline alerts are working.` }, input.invite);
    return json({ ok: true, ...result }, 200, cors);
  }
  return json({ ok: false }, 404, cors);
}

// On the 15-minute timer: if FPL's next deadline is under an hour away and we
// haven't alerted for it yet, alert everyone signed up
async function checkDeadline(env) {
  if (!env.PUSH || !env.VAPID_PRIVATE_JWK) return;
  const boot = await (await fetch(FPL + "bootstrap-static/", {
    headers: UA, cf: { cacheTtl: 300, cacheEverything: true },
  })).json();

  const now = Date.now();
  const next = boot.events
    .filter((e) => Date.parse(e.deadline_time) > now)
    .sort((a, b) => Date.parse(a.deadline_time) - Date.parse(b.deadline_time))[0];
  if (!next) return;

  const mins = (Date.parse(next.deadline_time) - now) / 60000;
  if (mins > 60) return;
  if (await env.PUSH.get(`sent:${next.id}`)) return;             // already alerted
  await env.PUSH.put(`sent:${next.id}`, new Date().toISOString(),  // mark first, so
    { expirationTtl: 60 * 60 * 24 * 30 });                         // it never repeats

  const at = new Date(next.deadline_time).toLocaleString("en-GB", {
    timeZone: "Europe/London", weekday: "short", hour: "2-digit", minute: "2-digit",
  });
  const rounded = Math.max(5, Math.round(mins / 5) * 5);
  const result = await pushTo(env, {
    title: `${next.name} deadline in ${rounded} min`,
    body: `Deadline ${at}. Get your transfers and captain sorted.`,
  });
  console.log(`Deadline alert for ${next.name}:`, JSON.stringify(result));
}

// Send a push to every signed-up phone (or just one invite's phones). Push
// addresses that no longer work (404 / 410) are removed
async function pushTo(env, message, invite = null) {
  await env.PUSH.put("message:last", JSON.stringify(message));
  let cursor, sent = 0, removed = 0, failed = 0;
  do {
    const page = await env.PUSH.list({ prefix: "sub:", cursor });
    for (const key of page.keys) {
      const rec = await env.PUSH.get(key.name, "json");
      if (!rec || (invite && rec.invite !== invite)) continue;
      const status = await sendPush(rec.subscription.endpoint, env);
      if (status === 404 || status === 410) { await env.PUSH.delete(key.name); removed++; }
      else if (status >= 200 && status < 300) sent++;
      else { failed++; console.log("Push failed:", status, rec.name); }
    }
    cursor = page.list_complete ? null : page.cursor;
  } while (cursor);
  return { sent, removed, failed };
}

// One content-free push, signed with our VAPID key (RFC 8292)
async function sendPush(endpoint, env) {
  const resp = await fetch(endpoint, {
    method: "POST",
    headers: { "Authorization": await vapidAuth(endpoint, env), "TTL": "3600", "Urgency": "high" },
    body: "",
  });
  return resp.status;
}

async function vapidAuth(endpoint, env) {
  const key = await crypto.subtle.importKey(
    "jwk", JSON.parse(env.VAPID_PRIVATE_JWK), { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64url(enc(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(enc(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: SITE,
  })));
  const sig = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, enc(`${head}.${claims}`));
  return `vapid t=${head}.${claims}.${b64url(sig)}, k=${VAPID_PUBLIC}`;
}

function allowedEndpoint(endpoint) {
  try {
    const u = new URL(endpoint);
    return u.protocol === "https:" && PUSH_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith("." + h));
  } catch { return false; }
}

const enc = (s) => new TextEncoder().encode(s);
const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
async function sha256(s) {
  return b64url(await crypto.subtle.digest("SHA-256", enc(s)));
}
