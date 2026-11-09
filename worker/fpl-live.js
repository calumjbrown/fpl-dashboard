// Cloudflare Worker: a small read-only proxy so the dashboard can fetch live
// scores. Browsers can't call the FPL API directly (it sends no CORS headers),
// so the page asks this Worker, which asks FPL and passes the answer back.
//
// - Only two FPL endpoints are allowed: the live player scores for a gameweek
//   (event/<gw>/live/) and that gameweek's fixtures (fixtures/?event=<gw>).
//   Anything else gets a 404, so it can't be used as a general proxy.
// - Each answer is cached for 60 seconds, so however many people have the
//   dashboard open, FPL is asked at most about once a minute per endpoint.
// - Only the dashboard (and the local preview) may read it from a browser.
//
// It also replaces GitHub's unreliable scheduler: a Cloudflare Cron Trigger
// (every 15 minutes) calls `scheduled` below, which asks GitHub to run the
// "Update dashboard data" workflow with match_window_only = true, so the run
// only fetches from FPL around deadlines and matches. Needs a GitHub token
// stored in the Worker as the secret GITHUB_TOKEN (never in this file).
//
// Deploy: paste this whole file into a Cloudflare Worker (see the setup steps).

const FPL = "https://fantasy.premierleague.com/api/";
const ORIGINS = ["https://calumjbrown.github.io", "http://localhost:8000"];
const WORKFLOW = "https://api.github.com/repos/calumjbrown/fpl-dashboard/actions/workflows/update-data.yml/dispatches";

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

export default {
  // Runs on the Cron Trigger set up in Cloudflare (every 15 minutes)
  async scheduled(event, env, ctx) {
    ctx.waitUntil(triggerUpdate(env));
  },

  async fetch(request) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin");
    const cors = {
      "Access-Control-Allow-Origin": ORIGINS.includes(origin) ? origin : ORIGINS[0],
      "Access-Control-Allow-Methods": "GET",
      "Vary": "Origin",
    };

    if (request.method === "OPTIONS") return new Response(null, { headers: cors });

    // Work out which FPL address to fetch, or refuse
    const path = url.pathname.replace(/^\/+/, "");
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
      headers: { "User-Agent": "fpl-dashboard (personal project)" },
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
