// FPL dashboard frontend.
// Loads data/dashboard.json (written by R/03_export.R) and draws the three
// tabs. Plain JavaScript, no libraries.
//
// How it works: each render function builds an HTML string from the data and
// drops it into its <section>. The URL hash (#leaderboard, #metrics, #chips)
// decides which section is visible, so tabs can be linked to directly.

const CHIPS = [
  { id: "wildcard", short: "WC", name: "Wildcard" },
  { id: "freehit",  short: "FH", name: "Free Hit" },
  { id: "bboost",   short: "BB", name: "Bench Boost" },
  { id: "3xc",      short: "TC", name: "Triple Captain" },
];

const TABS = ["leaderboard", "gameweek", "metrics", "chips"];

let data = null;           // the whole dashboard.json
let byEntry = {};          // per-GW tables split by manager, see indexData()
let byElement = new Map(); // current GW points breakdown rows by player id
let leagueHistory = new Map(); // league position after each GW, by manager
let metricView = "transfers";
let gwView = "leaderboard";  // Gameweek tab: "leaderboard" or "players"
let chipHalf = 1;
let chipSort = { key: "manager", dir: 1 };  // Chips table sort: column, 1 = ascending

// Helpers -------------------------------------------------------------------

// Manager and team names are typed by users, so escape them before they go
// into HTML
function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[c]);
}

const signed = (n) => (n > 0 ? "+" : n < 0 ? "−" : "") + Math.abs(n);

// Colour a number by whether it's good (green) or bad (coral). Colour is only
// used for this, so it always means something. tone(5) -> green "+5"
const tone = (n, text = signed(n)) =>
  n > 0 ? `<span class="good">${text}</span>`
  : n < 0 ? `<span class="bad">${text}</span>`
  : text;

// Transfer hits are always bad: 4 -> coral "−4", 0 -> "0"
const hit = (n) => (n ? tone(-n) : "0");
const chipName = (id) => (CHIPS.find((c) => c.id === id) || { name: id }).name;

// Like dplyr::group_by + split: rows -> Map of key -> array of rows
function groupBy(rows, key) {
  const groups = new Map();
  for (const row of rows) {
    if (!groups.has(row[key])) groups.set(row[key], []);
    groups.get(row[key]).push(row);
  }
  return groups;
}

// Rank with ties sharing a position (1, 2, 2, 4), given rows already sorted
function tiedRanks(rows, value) {
  return rows.map((row) => rows.findIndex((r) => value(r) === value(row)) + 1);
}

const who = (r) =>
  `<span class="who"><b>${esc(r.manager)}</b><small>${esc(r.team)}</small></span>`;

// A titled block of lines inside an expanded row
function block(title, total, lines) {
  return `<div class="gw">
    <div class="gw-head"><span>${title}</span><span class="num">${total}</span></div>
    <ul>${lines.join("")}</ul>
  </div>`;
}

const gwBlock = (gw, total, lines) => block("GW" + gw, total, lines);

const line = (label, value, cls = "") =>
  `<li${cls ? ` class="${cls}"` : ""}><span>${label}</span><span class="num">${value}</span></li>`;

// Leaderboard ---------------------------------------------------------------

function renderLeaderboard() {
  const rows = [...data.standings].sort((a, b) => a.rank - b.rank).map((s) => {
    const change = s.last_rank ? s.last_rank - s.rank : 0;
    const move = change > 0 ? `<span class="move up"><i>▲</i>${change}</span>`
               : change < 0 ? `<span class="move down"><i>▼</i>${-change}</span>`
               : "";
    return `<div class="row">
      <span class="rank"><span class="rank-stack">${s.rank}${move}</span></span>
      ${who(s)}
      <span class="mid">${sparkline(s.entry)}</span>
      <span class="num">${s.event_total}</span>
      <span class="num strong">${s.total}</span>
    </div>`;
  });

  return `<div class="list" style="--n:3">
    <div class="row head">
      <span class="mid">#</span><span>Manager</span><span class="mid">Form</span>
      <span class="num">GW</span><span class="num">Total</span>
    </div>
    ${rows.join("")}
  </div>
  <p class="note">Form: league position over the last 5 gameweeks (up = climbing).
    The dot is green if they've climbed over that time, coral if they've dropped.
    Hover or long-press a line for the exact positions.</p>`;
}

// 1 -> "1st", 2 -> "2nd", 11 -> "11th", 22 -> "22nd"
function ordinal(n) {
  const s = ["th", "st", "nd", "rd"], v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

// League position over the last 5 gameweeks as a tiny line chart (inline
// SVG), higher = better. Each line is scaled to that manager's own range
// (at least 4 places, so a one-place wobble doesn't look dramatic). The end
// dot is green if they've climbed over the 5 weeks, coral if they've fallen
function sparkline(entry) {
  const pts = [...(leagueHistory.get(entry) || [])].sort((a, b) => a.gw - b.gw).slice(-5);
  if (!pts.length) return "";

  const W = 48, H = 24, pad = 3;
  const ranks = pts.map((p) => p.league_rank);
  const mid = (Math.min(...ranks) + Math.max(...ranks)) / 2;
  const span = Math.max(Math.max(...ranks) - Math.min(...ranks), 4);
  const top = mid - span / 2;  // the best position shown at the top edge
  const x = (i) => (pts.length === 1 ? W / 2 : pad + (i * (W - 2 * pad)) / (pts.length - 1));
  const y = (rank) => pad + ((rank - top) * (H - 2 * pad)) / span;

  const path = pts.map((p, i) =>
    `${i ? "L" : "M"}${x(i).toFixed(1)},${y(p.league_rank).toFixed(1)}`).join("");
  const first = pts[0].league_rank, last = pts[pts.length - 1].league_rank;
  const trend = last < first ? "good" : last > first ? "bad" : "flat";
  const title = "League position: " +
    pts.map((p) => `GW${p.gw} ${ordinal(p.league_rank)}`).join(", ");

  return `<svg class="spark" viewBox="0 0 ${W} ${H}" role="img" aria-label="${title}">
    <title>${title}</title>
    <path d="${path}"/>
    <circle class="${trend}" cx="${x(pts.length - 1).toFixed(1)}" cy="${y(last).toFixed(1)}" r="2.6"/>
  </svg>`;
}

// Live gameweek scoring --------------------------------------------------------
// During a gameweek FPL doesn't add bonus until ~1 hour after each match, and
// doesn't apply auto-subs or pass the armband to the vice-captain until the
// whole gameweek ends. So the current gameweek is scored here, provisionally:
//
// Bonus: in each match that has started but whose bonus FPL hasn't confirmed,
//   the top three by BPS get 3 / 2 / 1. Ties share the higher place, which
//   gives FPL's tie rules (3,3,1 / 3,2,2 / 3,2,1,1).
// Auto-subs: a starter is only subbed off once every match his team plays
//   this gameweek has ended and he played 0 minutes (no match at all counts
//   as ended). The bench is tried in order; the bench GK only replaces the GK
//   and the formation must stay legal (1 GKP, 3+ DEF, 2+ MID, 1+ FWD). A bench
//   player only comes on if he has played; if one whose match hasn't ended yet
//   would be next, the sub waits rather than guess.
// Armband: passes to the vice-captain only once the captain's matches have
//   ended without him playing, and the vice (in the XI) has played.
// No subs in Bench Boost weeks. Once FPL has finalised the gameweek
// (data.gw_final) its own figures are used as they are.

let live = null;  // set by computeLive(): scored teams and player points

function computeLive() {
  const fixtures = data.gw_fixtures || [];
  const teamFixtures = groupBy(fixtures.flatMap((f) =>
    [{ team: f.team_h, ...f }, { team: f.team_a, ...f }]), "team");

  // Provisional bonus, and each player's BPS, from each match
  const provBonus = new Map(), bps = new Map();
  for (const [fixture, rows] of groupBy(data.gw_bps || [], "fixture")) {
    for (const r of rows) bps.set(r.element, (bps.get(r.element) || 0) + r.bps);
    const f = fixtures.find((x) => x.fixture === fixture);
    if (data.gw_final || !f || !f.started || f.bonus_final) continue;
    const sorted = [...rows].sort((a, b) => b.bps - a.bps);
    for (const r of sorted) {
      const place = sorted.findIndex((x) => x.bps === r.bps) + 1;  // ties share
      const bonus = Math.max(0, 4 - place);
      if (bonus) provBonus.set(r.element, (provBonus.get(r.element) || 0) + bonus);
    }
  }

  const teamDone = (team) => (teamFixtures.get(team) || []).every((f) => f.ended);
  const summary = new Map(data.gw_summary.map((s) => [s.entry, s]));

  live = { provBonus, bps, byEntry: new Map() };
  for (const [entry, picks] of groupBy(data.gw_lineups, "entry")) {
    const s = summary.get(entry) || {};
    live.byEntry.set(entry, scoreTeam(picks, s.chip, s.transfer_cost || 0, teamDone));
  }
}

const POS_ORDER = ["GKP", "DEF", "MID", "FWD"];

// One manager's gameweek: returns the lineup rows (XI then bench, each with
// its points `pts`, multiplier `mult` and sub flags), the total and net of hits
function scoreTeam(picks, chip, hits, teamDone) {
  const rows = [...picks]
    .sort((a, b) => a.position - b.position)
    .map((p) => ({ ...p, provBonus: live.provBonus.get(p.element) || 0,
                   pts: p.points + (live.provBonus.get(p.element) || 0),
                   subIn: false, subOut: false }));
  const total = (rs) => rs.reduce((sum, r) => sum + r.pts * r.mult, 0);

  // Finalised by FPL: subs, vice-captain and bonus are already in its figures
  if (data.gw_final) {
    for (const r of rows) r.mult = r.pick_multiplier;
    const xi = rows.filter((r) => r.position <= 11), bench = rows.filter((r) => r.position > 11);
    const gross = total(rows);
    return { rows: [...xi, ...bench], xi, bench, gross, net: gross - hits };
  }

  const played = (p) => p.minutes > 0;
  const noShow = (p) => !played(p) && teamDone(p.team_id);  // match(es) over, didn't play
  const legal = (team) => {
    const n = (pos) => team.filter((p) => p.pos === pos).length;
    return n("GKP") === 1 && n("DEF") >= 3 && n("MID") >= 2 && n("FWD") >= 1;
  };

  let xi = rows.slice(0, 11);
  const bench = rows.slice(11);
  const bb = chip === "bboost";

  if (!bb) {
    for (const out of xi.filter(noShow)) {
      for (const cand of bench) {
        if (cand.subIn || (out.pos === "GKP") !== (cand.pos === "GKP")) continue;
        const trial = xi.map((p) => (p === out ? cand : p));
        if (!legal(trial)) continue;
        if (played(cand)) { xi = trial; cand.subIn = true; out.subOut = true; break; }
        if (teamDone(cand.team_id)) continue;  // didn't play: try the next one
        break;                                 // might still play: wait
      }
    }
  }

  // Armband: captain unless he's a confirmed no-show, then the vice if he's
  // in the XI and has played (if the vice is still to play, nobody yet)
  const capMult = chip === "3xc" ? 3 : 2;
  const cap = rows.find((p) => p.is_captain), vice = rows.find((p) => p.is_vice_captain);
  const wearer = cap && !noShow(cap) ? cap
               : vice && xi.includes(vice) && played(vice) ? vice : null;

  const counted = new Set(bb ? rows : xi);
  for (const r of rows) r.mult = counted.has(r) ? (r === wearer ? capMult : 1) : 0;

  // XI in position order (a sub takes his own position's place), then bench
  const xiSorted = [...xi].sort((a, b) =>
    POS_ORDER.indexOf(a.pos) - POS_ORDER.indexOf(b.pos) || a.position - b.position);
  const benchRows = rows.filter((r) => !xi.includes(r));
  const gross = total(rows);
  return { rows: [...xiSorted, ...benchRows], xi: xiSorted, bench: benchRows,
           gross, net: gross - hits };
}

// Put the live scores into the tables the tabs read: GW scores, and the
// league table (total = last GW's total + live GW score, rank and movement
// recalculated) and the current GW's point on the form sparkline
function applyLive() {
  const gw = data.current_gw;
  const prev = new Map(data.league_history.filter((h) => h.gw === gw - 1)
    .map((h) => [h.entry, h]));

  for (const s of data.gw_summary) {
    const t = live.byEntry.get(s.entry);
    if (t) { s.gw_points = t.gross; s.net_points = t.net; }
  }

  const net = new Map(data.gw_summary.map((s) => [s.entry, s.net_points]));
  for (const s of data.standings) {
    if (!net.has(s.entry)) continue;
    s.event_total = net.get(s.entry);
    s.total = (prev.get(s.entry)?.total || 0) + s.event_total;
    s.last_rank = prev.get(s.entry)?.league_rank ?? null;
  }
  data.standings.sort((a, b) => b.total - a.total);
  data.standings.forEach((s, i, all) => { s.rank = all.findIndex((x) => x.total === s.total) + 1; });

  for (const h of data.league_history) {
    if (h.gw !== gw) continue;
    const s = data.standings.find((x) => x.entry === h.entry);
    if (s) { h.total = s.total; h.league_rank = s.rank; }
  }
}

// Live updates -------------------------------------------------------------------
// While the gameweek is in progress, fetch FPL's live player scores and the
// fixtures through our Cloudflare Worker (worker/fpl-live.js), merge them into
// the data and re-score the gameweek with the rules above. Every 60 seconds
// while a match is on, every 5 minutes otherwise; paused while the page is
// hidden; stops once FPL finalises the gameweek. If the Worker can't be
// reached the page simply keeps the data it already has.

const LIVE_URL = "https://fpl-live.calubrow.workers.dev";
let liveAt = null;     // when live data last arrived
let liveTimer = null;
let liveBusy = false;

async function pollLive() {
  clearTimeout(liveTimer);
  if (data.gw_final || liveBusy) return;
  if (document.hidden) { liveTimer = setTimeout(pollLive, 60000); return; }

  let matchOn = false;
  liveBusy = true;
  try {
    matchOn = await fetchLive();
  } catch (err) {
    // Worker or FPL unavailable (FPL goes offline while it updates): try later
  } finally {
    liveBusy = false;
  }
  liveTimer = setTimeout(pollLive, matchOn ? 60000 : 300000);
}

// Fetch, merge, re-score and redraw. Returns true if a match is in progress
async function fetchLive() {
  const get = (p) => fetch(`${LIVE_URL}/${p}`).then((r) => {
    if (!r.ok) throw new Error("HTTP " + r.status);
    return r.json();
  });
  const gw = data.current_gw;
  const [scores, fixtures] = await Promise.all([get(`event/${gw}/live/`), get(`fixtures/?event=${gw}`)]);

  mergeLive(scores, fixtures);
  computeLive();
  applyLive();
  liveAt = new Date();
  rerender("leaderboard");
  rerender("gameweek");
  showStatus();
  return fixtures.some((f) => f.started && !f.finished_provisional);
}

// Put FPL's live answers into the same shape 03_export.R produces
function mergeLive(scores, fixtures) {
  const byId = new Map(scores.elements.map((e) => [e.id, e]));

  for (const p of data.gw_lineups) {
    const e = byId.get(p.element);
    if (e) { p.minutes = e.stats.minutes; p.points = e.stats.total_points; }
  }

  // Points breakdown per player and stat, summed over a double gameweek
  const rows = new Map();
  for (const id of new Set(data.gw_lineups.map((p) => p.element))) {
    for (const f of byId.get(id)?.explain || []) {
      for (const s of f.stats) {
        const key = id + "|" + s.identifier;
        const r = rows.get(key) || { element: id, stat: s.identifier, value: 0, points: 0 };
        r.value += s.value;
        r.points += s.points;
        rows.set(key, r);
      }
    }
  }
  data.gw_breakdown = [...rows.values()];
  byElement = groupBy(data.gw_breakdown, "element");

  data.gw_fixtures = fixtures.map((f) => ({
    fixture: f.id, team_h: f.team_h, team_a: f.team_a, started: !!f.started,
    ended: !!f.finished_provisional, bonus_final: !!f.finished,
  }));
  data.gw_bps = fixtures.flatMap((f) => {
    const s = (f.stats || []).find((x) => x.identifier === "bps");
    return s ? [...s.h, ...s.a].map((x) => ({ fixture: f.id, element: x.element, bps: x.value })) : [];
  });
}

// Redraw a tab without collapsing the rows someone has expanded
function rerender(tab) {
  const section = document.getElementById("tab-" + tab);
  const open = new Set([...section.querySelectorAll("details[open][data-key]")]
    .map((d) => d.dataset.key));
  render(tab);
  for (const d of section.querySelectorAll("details[data-key]")) {
    if (open.has(d.dataset.key)) d.open = true;
  }
}

// Coming back to the page: fetch straight away rather than wait
document.addEventListener("visibilitychange", () => {
  if (!document.hidden && liveAt) pollLive();
});

// Gameweek ------------------------------------------------------------------
// The current gameweek only: ranked by points after hits, each manager
// expanding to their lineup

// Two views, chosen from the Gameweek dropdown in the nav (and the URL, e.g.
// #gameweek/players): the managers' table, or every player picked in the league
const GW_VIEWS = { leaderboard: "Leaderboard", players: "Players" };

function renderGameweek() {
  const provisional = data.gw_final ? ""
    : " Until FPL finalises the gameweek, bonus (from live BPS), auto-subs and " +
      "vice-captain switches are provisional; subs only happen once a " +
      "player's match has ended.";

  return `<h2 class="page-title">Gameweek ${data.current_gw} · ${GW_VIEWS[gwView]}</h2>
    ${gwView === "players" ? gwPlayers(provisional) : gwLeaderboard(provisional)}`;
}

function gwLeaderboard(provisional) {
  // Ranked on points BEFORE transfer hits (owner's rule); hits shown alongside
  const sorted = [...data.gw_summary].sort((a, b) => b.gw_points - a.gw_points);
  const ranks = tiedRanks(sorted, (s) => s.gw_points);

  const rows = sorted.map((s, i) => `<details data-key="m${s.entry}">
      <summary class="row toggle">
        <span class="rank">${ranks[i]}</span>
        ${who(s)}
        <span class="num">${hit(s.transfer_cost)}</span>
        <span class="num strong">${s.gw_points}</span>
      </summary>
      <div class="detail">${lineupDetail(s, live.byEntry.get(s.entry))}</div>
    </details>`);

  return `<div class="list" style="--n:2">
      <div class="row head toggle">
        <span>#</span><span>Manager</span><span class="num">Hits</span><span class="num">Pts</span>
      </div>
      ${rows.join("")}
    </div>
    <p class="note">Ranked on points before transfer hits; hits are shown but
      don't count here (they still come off the season total).${provisional}
      Tap a manager to see their team.</p>`;
}

// Every player picked by anyone in the league this gameweek, highest score
// first (ties: most owned first, then name). Each expands to who picked him
function gwPlayers(provisional) {
  const managers = new Map(data.standings.map((s) => [s.entry, s.manager]));
  const leagueSize = data.standings.length;

  // Each manager's scored row for every player they picked (live points,
  // multiplier after subs and armband)
  const allRows = [...live.byEntry.values()].flatMap((t) => t.rows);
  const players = [...groupBy(allRows, "element").values()]
    .map((picks) => ({ ...picks[0], picks }))
    .sort((a, b) => b.pts - a.pts || b.picks.length - a.picks.length ||
                    a.player.localeCompare(b.player));
  const ranks = tiedRanks(players, (p) => p.pts);

  // One line per manager who picked him: armband badge, and the points he
  // earned them (x2 / x3 as captain), or "bench" if he didn't count
  const pickedBy = (p) => [...p.picks]
    .sort((a, b) => managers.get(a.entry).localeCompare(managers.get(b.entry)))
    .map((k) => {
      const tc = data.gw_summary.find((s) => s.entry === k.entry)?.chip === "3xc";
      const armband = k.is_captain ? (tc ? "TC" : "C") : k.is_vice_captain ? "V" : "";
      const label = esc(managers.get(k.entry)) +
                    (armband ? ` <span class="badge">${armband}</span>` : "") +
                    (k.subIn ? ` <span class="tag">sub on</span>` : "");
      return k.mult > 0
        ? line(label, k.pts * k.mult)
        : line(label, k.subOut ? "subbed off" : "bench", "benched");
    });

  const rows = players.map((p, i) => `<details data-key="e${p.element}">
      <summary class="row toggle">
        <span class="rank">${ranks[i]}</span>
        <span class="who"><b>${esc(p.player)}</b><small>${p.pos} · ${esc(p.club)}</small></span>
        <span class="num">${p.picks.length}</span>
        <span class="num strong">${p.pts}</span>
      </summary>
      <div class="detail lineup">
        ${block(`Picked by ${p.picks.length} of ${leagueSize}`, "", pickedBy(p))}
      </div>
    </details>`);

  return `<div class="list" style="--n:2">
      <div class="row head toggle">
        <span>#</span><span>Player</span><span class="num">Owned</span><span class="num">Pts</span>
      </div>
      ${rows.join("")}
    </div>
    <p class="note">Every player picked by someone in the league this gameweek. Pts is
      the player's own score, including provisional bonus; tap a player to see
      who picked him and what he earned each of them (doubled as captain).${provisional}</p>`;
}

// Names for FPL's points categories, in FPL's order (used to sort too)
const STATS = {
  minutes: "Minutes played",
  goals_scored: "Goals scored",
  assists: "Assists",
  clean_sheets: "Clean sheet",
  goals_conceded: "Goals conceded",
  own_goals: "Own goals",
  penalties_saved: "Penalties saved",
  penalties_missed: "Penalties missed",
  yellow_cards: "Yellow card",
  red_cards: "Red card",
  saves: "Saves",
  defensive_contribution: "Defensive contributions",
  bonus: "Bonus",
};
const statOrder = Object.keys(STATS);

// Starting XI and bench (after provisional auto-subs, see scoreTeam). Each
// player expands to his points breakdown: one line per stat with its count
// and the points it earned, plus provisional bonus and the captain multiplier
function lineupDetail(s, team) {
  if (!team) return `<p class="empty">No team this gameweek.</p>`;
  const { xi, bench } = team;
  const counted = (ps) => ps.reduce((sum, p) => sum + p.pts * p.mult, 0);

  const breakdown = (p) => {
    const stats = [...(byElement.get(p.element) || [])]
      .sort((a, b) => statOrder.indexOf(a.stat) - statOrder.indexOf(b.stat));
    const rows = stats.map((b) =>
      `<li><span>${STATS[b.stat] || b.stat}</span><span>${b.value}</span>` +
      `<span>${b.points < 0 ? tone(b.points) : b.points}</span></li>`);  // only losses coloured

    // Provisional bonus (count = his BPS), captain multiplier, bench status
    if (p.provBonus) {
      rows.push(`<li><span>Bonus (provisional)</span><span>${live.bps.get(p.element)} BPS</span>` +
                `<span>${p.provBonus}</span></li>`);
    }
    if (p.mult > 1) {
      const label = p.mult === 3 ? "Triple Captain" : p.is_captain ? "Captain" : "Vice-captain (captain didn't play)";
      rows.push(`<li><span>${label}</span><span>×${p.mult}</span>` +
                `<span>+${p.pts * (p.mult - 1)}</span></li>`);
    }
    if (p.subIn) rows.push(`<li><span>Auto-sub: came on</span><span></span><span></span></li>`);
    if (p.subOut) {
      rows.push(`<li><span>Auto-sub: didn't play, subbed off</span><span></span><span></span></li>`);
    } else if (p.mult === 0) {
      rows.push(`<li><span>Benched, not counted</span><span></span><span></span></li>`);
    }

    return `<ul class="breakdown">
      <li class="bd-head"><span></span><span>Count</span><span>Pts</span></li>
      ${rows.join("")}
    </ul>`;
  };

  const player = (p) => {
    const armband = p.is_captain ? (s.chip === "3xc" ? "TC" : "C")
                  : p.is_vice_captain ? "V" : "";
    const pts = p.mult > 0 ? p.pts * p.mult : p.pts;
    const tag = p.subIn ? ` <span class="tag">sub on</span>`
              : p.subOut ? ` <span class="tag">subbed off</span>` : "";
    return `<li class="player${p.mult > 0 ? "" : " benched"}"><details data-key="p${s.entry}-${p.element}">
      <summary>
        <span><span class="pos">${p.pos}</span>${esc(p.player)} <small>${esc(p.club)}</small>` +
        `${armband ? ` <span class="badge">${armband}</span>` : ""}${tag}</span>
        <span class="num">${pts}</span>
      </summary>
      ${breakdown(p)}
    </details></li>`;
  };

  const chip = s.chip && s.chip !== "bboost" ? ` · ${chipName(s.chip)}` : "";
  const benchTitle = s.chip === "bboost" ? "Bench · Bench Boost" : "Bench · not counted";
  const benchTotal = s.chip === "bboost" ? counted(bench) : "";
  const hits = s.transfer_cost ? block("Transfer hits", hit(s.transfer_cost), []) : "";

  return `<div class="lineup">
    ${block("Starting XI" + chip, counted(xi), xi.map(player))}
    ${block(benchTitle, benchTotal, bench.map(player))}
    ${hits}
  </div>`;
}

// Metrics -------------------------------------------------------------------
// Each metric: the season columns to show, how to sort (best first), a short
// definition, and the per-gameweek breakdown shown when a row is expanded.

const METRICS = {
  transfers: {
    label: "Net transfer points",
    note: "Points scored by players transferred in minus players out, in the " +
          "gameweek of the transfer, minus hits. Wildcard and Free Hit weeks don't count.",
    cols: [
      { head: "Hits", value: (s) => hit(s.hit_points) },
      { head: "Net", value: (s) => tone(s.net_transfer_points), main: true },
    ],
    score: (s) => s.net_transfer_points,
    detail: transferDetail,
  },
  cards: {
    label: "Cards",
    note: "Cards for players who ended up on the pitch (starting XI after " +
          "auto-subs; all 15 in Bench Boost weeks). Points lost include the " +
          "captain multiplier (×2, or ×3 with Triple Captain).",
    cols: [
      { head: '<span class="card y"></span>', value: (s) => s.yellow_cards, mid: true },
      { head: '<span class="card r"></span>', value: (s) => s.red_cards, mid: true },
      { head: "Pts", value: (s) => tone(s.card_points_lost), main: true },
    ],
    score: (s) => s.card_points_lost,
    detail: cardDetail,
  },
  missed: {
    label: "Missed points",
    note: "Bench: points lost by not picking your best possible XI, i.e. bench " +
          "players who outscored a starter they could legally have replaced " +
          "(formation rules apply; not counted in Bench Boost weeks). Captain: " +
          "points lost by not giving the armband to the squad's top scorer.",
    cols: [
      { head: "Bench", value: (s) => s.bench_points },
      { head: "Capt", value: (s) => s.captain_gap },
      { head: "Total", value: (s) => s.missed_points, main: true },
    ],
    score: (s) => -s.missed_points,  // fewest missed is best
    detail: missedDetail,
  },
  dfyter: {
    label: "DFYTer Index",
    note: "How much your squad overlaps with the rest of the league. Each player " +
          "scores the share of the other managers who also own him that gameweek; " +
          "the index is the average across your 15, then across the season. " +
          "0% = nothing in common with anyone, 100% = identical to everyone.",
    cols: [
      { head: "Index", value: (s) => pct(s.dfyter), main: true },
    ],
    score: (s) => s.dfyter,
    detail: dfyterDetail,
  },
};

// Pints: one for every gameweek lost (lowest score after hits). Added after
// METRICS is defined because it refers to the current gameweek
METRICS.pints = {
  label: "Pints",
  note: "Lose a gameweek (lowest score in the league, before transfer hits) and " +
        "you down a pint. Joint-bottom: everyone tied drinks. A gameweek " +
        "counts once its points are final (bonus and corrections applied, " +
        "usually the day after the last match).",
  cols: [
    { head: "Pints", value: (s) => s.pints, main: true },
  ],
  score: (s) => s.pints,  // most pints at the top
  detail: pintsDetail,
};

function pintsDetail(entry) {
  const losses = [...(byEntry.gw_pints.get(entry) || [])].sort((a, b) => b.gw - a.gw);
  if (!losses.length) return `<p class="empty">No pints yet. Clean record.</p>`;

  return losses.map((p) => gwBlock(p.gw, "1 pint", [
    line(`Lowest score: ${p.points} pts` +
         (p.joint_with ? ` (joint with ${esc(p.joint_with)})` : ""), ""),
  ])).join("");
}

// Squad value: current team value (players at today's prices + money in the
// bank), in GBP m. Each manager expands to how it's moved gameweek by gameweek
const money = (x) => x.toFixed(1);

METRICS.value = {
  label: "Squad value",
  note: "Current team value in £m: players at today's prices plus money in the " +
        "bank. Tap a manager for the squad / bank split each gameweek. This is " +
        "FPL's market value, not what the players would sell for.",
  cols: [
    { head: "Value", value: (s) => money(s.total_value), main: true },
  ],
  score: (s) => s.total_value,  // highest value at the top
  detail: valueDetail,
};

function valueDetail(entry) {
  const weeks = [...(byEntry.gw_value.get(entry) || [])].sort((a, b) => a.gw - b.gw);
  return weeks.map((w, i) => {
    // Change in total value since the previous gameweek, green / coral
    const change = i ? Math.round((w.total_value - weeks[i - 1].total_value) * 10) / 10 : 0;
    const lines = [line(`Squad ${money(w.squad_value)} · bank ${money(w.bank)}`,
                        i ? tone(change, (change > 0 ? "+" : change < 0 ? "−" : "") + money(Math.abs(change))) : "")];
    return gwBlock(w.gw, "£" + money(w.total_value) + "m", lines);
  }).reverse().join("");
}

const pct = (x) => (x * 100).toFixed(1) + "%";

function dfyterDetail(entry) {
  const weeks = [...(byEntry.gw_dfyter.get(entry) || [])].sort((a, b) => b.gw - a.gw);

  return weeks.map((w) => gwBlock(w.gw, pct(w.dfyter), [
    line(w.unique_players ? `Only they own: ${esc(w.unique_players)}` : "No players only they own", ""),
  ])).join("");
}

function transferDetail(entry) {
  const transfers = groupBy(byEntry.transfer_detail.get(entry) || [], "gw");
  const weeks = (byEntry.gw_transfers.get(entry) || [])
    .filter((w) => w.transfers > 0 || w.transfer_cost > 0)
    .sort((a, b) => b.gw - a.gw);

  if (!weeks.length) return `<p class="empty">No transfers yet.</p>`;

  return weeks.map((w) => {
    // Wildcard / Free Hit weeks don't count, so just say so in one line
    if (!w.counted) {
      return gwBlock(w.gw, "not counted",
        [line(`${chipName(w.chip)} · ${w.transfers} transfers`, "")]);
    }
    const lines = (transfers.get(w.gw) || []).map((t) => line(
      `${esc(t.player_in)} ${t.in_points} for ${esc(t.player_out)} ${t.out_points}`,
      tone(t.gain),
    ));
    if (w.transfer_cost) lines.push(line("Hit", hit(w.transfer_cost)));
    return gwBlock(w.gw, tone(w.net_transfer_points), lines);
  }).join("");
}

function cardDetail(entry) {
  const cards = groupBy(byEntry.card_detail.get(entry) || [], "gw");
  const weeks = [...cards.keys()].sort((a, b) => b - a);

  if (!weeks.length) return `<p class="empty">No cards yet.</p>`;

  return weeks.map((gw) => {
    const players = cards.get(gw);
    const lines = players.map((p) => {
      const badges = '<span class="card y"></span>'.repeat(p.yellow_cards) +
                     '<span class="card r"></span>'.repeat(p.red_cards);
      const mult = p.multiplier > 1 ? ` (×${p.multiplier})` : "";
      return line(`${badges}${esc(p.player)}${mult}`, tone(p.card_points_lost));
    });
    const total = players.reduce((sum, p) => sum + p.card_points_lost, 0);
    return gwBlock(gw, tone(total), lines);
  }).join("");
}

function missedDetail(entry) {
  const weeks = [...(byEntry.gw_missed.get(entry) || [])].sort((a, b) => b.gw - a.gw);

  return weeks.map((w) => {
    // Bench: which bench players should have started, and instead of whom
    const bench = w.chip === "bboost" ? [line("Bench (Bench Boost played)", 0)]
      : w.bench_points === 0 ? [line("Bench: best XI already picked", 0)]
      : [line(`Bench: should have started ${esc(w.bench_in)}`, w.bench_points),
         line(`instead of ${esc(w.bench_out)}`, "")];

    const tc = w.chip === "3xc" ? " (TC)" : "";
    const captain = w.armband_player === null
      ? line("Captain and vice both didn't play", w.captain_gap)
      : line(`Armband ${esc(w.armband_player)} ${w.armband_points}${tc} · ` +
             `best ${esc(w.best_player)} ${w.best_points}`, w.captain_gap);

    return gwBlock(w.gw, w.missed_points, [...bench, captain]);
  }).join("");
}

function renderMetrics() {
  const m = METRICS[metricView];
  const n = m.cols.length;

  const sorted = [...data.season_summary].sort((a, b) => m.score(b) - m.score(a));
  const ranks = tiedRanks(sorted, m.score);

  const cell = (c, s) =>
    `<span class="${c.mid ? "mid" : "num"}${c.main ? " strong" : ""}">${c.value(s)}</span>`;

  const rows = sorted.map((s, i) => `<details>
      <summary class="row toggle">
        <span class="rank">${ranks[i]}</span>
        ${who(s)}
        ${m.cols.map((c) => cell(c, s)).join("")}
      </summary>
      <div class="detail">${m.detail(s.entry)}</div>
    </details>`);

  const provisional = data.gw_finished ? ""
    : ` GW${data.current_gw} is still in progress, so its numbers are provisional.`;

  return `<h2 class="page-title">${m.label}</h2>
    <div class="list" style="--n:${n}">
      <div class="row head toggle">
        <span>#</span><span>Manager</span>
        ${m.cols.map((c) => `<span class="${c.mid ? "mid" : "num"}">${c.head}</span>`).join("")}
      </div>
      ${rows.join("")}
    </div>
    <p class="note">${m.note}${provisional} Tap a manager for the gameweek breakdown.</p>`;
}

// Chips ---------------------------------------------------------------------

function renderChips() {
  const status = groupBy(data.chip_status.filter((c) => c.half === chipHalf), "entry");

  const switcher = [1, 2].map((h) =>
    `<button class="seg${h === chipHalf ? " on" : ""}" data-half="${h}">` +
    `${h === 1 ? "GW1–18" : "GW19–38"}</button>`
  ).join("");

  const pill = (c) => {
    if (!c) return "";
    const text = c.status === "used" ? `GW${c.gw}`
               : c.status === "available" ? "✓"
               : "–";
    return `<span class="pill ${c.status}" title="${chipName(c.chip)}: ${c.status}">${text}</span>`;
  };

  const chipOf = (entry, id) => (status.get(entry) || []).find((x) => x.chip === id);

  // Sorting (click a header; click again to reverse). A chip column orders
  // used chips by gameweek, then ✓ still available, then – expired/locked.
  // Ties, and the Manager column, go alphabetically (first name, then surname)
  const chipRank = (c) =>
    !c ? [3, 0] : c.status === "used" ? [0, c.gw] : c.status === "available" ? [1, 0] : [2, 0];

  const compare = (a, b) => {
    if (chipSort.key !== "manager") {
      const [ga, va] = chipRank(chipOf(a.entry, chipSort.key));
      const [gb, vb] = chipRank(chipOf(b.entry, chipSort.key));
      if (ga !== gb || va !== vb) return chipSort.dir * (ga - gb || va - vb);
      return a.manager.localeCompare(b.manager);
    }
    return chipSort.dir * a.manager.localeCompare(b.manager);
  };

  const rows = [...data.standings].sort(compare).map((s) => `<div class="row">
      <span></span>
      ${who(s)}
      ${CHIPS.map((c) => `<span class="mid">${pill(chipOf(s.entry, c.id))}</span>`).join("")}
    </div>`);

  // A sortable header: a button showing ▲/▼ when it's the active sort
  const sortHead = (key, label, title = "") => {
    const on = chipSort.key === key;
    const arrow = on ? `<i>${chipSort.dir === 1 ? "▲" : "▼"}</i>` : "";
    return `<button class="sort${on ? " on" : ""}" data-sort="${key}"` +
           `${title ? ` title="Sort by ${title}"` : ""}>${label}${arrow}</button>`;
  };

  const note = chipHalf === 1
    ? "First set: must be played before the GW19 deadline and doesn't carry over."
    : "Second set: available from GW19.";

  return `<div class="segs">${switcher}</div>
    <div class="list no-rank" style="--n:${CHIPS.length}">
      <div class="row head">
        <span></span><span>${sortHead("manager", "Manager", "manager")}</span>
        ${CHIPS.map((c) => `<span class="mid">${sortHead(c.id, c.short, c.name)}</span>`).join("")}
      </div>
      ${rows.join("")}
    </div>
    <p class="note">${note} ✓ = still available, GW = when it was played.
      Tap a column heading to sort.</p>`;
}

// Page setup ----------------------------------------------------------------

const RENDER = {
  leaderboard: renderLeaderboard,
  gameweek: renderGameweek,
  metrics: renderMetrics,
  chips: renderChips,
};

function render(tab) {
  document.getElementById("tab-" + tab).innerHTML = RENDER[tab]();
  markScrollable();
}

// Mark lists that are wider than the screen, so CSS can draw the divider on
// the frozen manager column. Hidden tabs measure 0, so this re-runs whenever
// a tab is shown and when the window is resized
function markScrollable() {
  for (const list of document.querySelectorAll(".list")) {
    list.classList.toggle("scrollable", list.scrollWidth > list.clientWidth + 1);
  }
}

// The hash is "#tab" or, for metrics, "#metrics/<metric>" (e.g. #metrics/cards)
function showTab() {
  const [hash, sub] = location.hash.slice(1).split("/");
  const tab = TABS.includes(hash) ? hash : "leaderboard";

  if (tab === "metrics" && METRICS[sub] && sub !== metricView) {
    metricView = sub;
    render("metrics");
  }
  if (tab === "gameweek" && GW_VIEWS[sub] && sub !== gwView) {
    gwView = sub;
    render("gameweek");
  }

  for (const t of TABS) document.getElementById("tab-" + t).hidden = t !== tab;
  for (const el of document.querySelectorAll(".tabs .tab")) {
    el.classList.toggle("on", el.dataset.tab === tab);
  }
  renderMenus(tab);
  setMenu(null);
  markScrollable();
}

// Dropdowns in the nav (Gameweek and Metrics) ---------------------------------
// Each tab with a dropdown: its items as [id, label], and the one showing now

const MENUS = {
  gameweek: { items: () => Object.entries(GW_VIEWS), current: () => gwView },
  metrics: {
    items: () => Object.entries(METRICS).map(([id, x]) => [id, x.label]),
    current: () => metricView,
  },
};

function renderMenus(tab) {
  for (const [name, menu] of Object.entries(MENUS)) {
    document.getElementById(name + "-menu").innerHTML = menu.items().map(([id, label]) => {
      const on = tab === name && id === menu.current() ? ' class="on"' : "";
      return `<a href="#${name}/${id}"${on}>${label}</a>`;
    }).join("");
  }
}

// Open the named dropdown and close the others; setMenu(null) closes them all
function setMenu(name) {
  for (const button of document.querySelectorAll(".menu .tab")) {
    const open = button.dataset.tab === name;
    button.setAttribute("aria-expanded", open);
    document.getElementById(button.dataset.tab + "-menu").hidden = !open;
  }
}

function indexData() {
  for (const key of ["gw_transfers", "transfer_detail", "card_detail", "gw_missed",
                     "gw_dfyter", "gw_pints", "gw_value"]) {
    byEntry[key] = groupBy(data[key], "entry");
  }
  byElement = groupBy(data.gw_breakdown, "element");
  leagueHistory = groupBy(data.league_history, "entry");
}

function showStatus() {
  const updated = new Date(data.updated).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  // current_gw is the latest gameweek that has started, including one in progress.
  // With live data, say how long ago it arrived (refreshed every 15s below)
  const status = document.getElementById("status");
  document.getElementById("league").textContent = data.league;
  status.textContent = liveAt
    ? `GW${data.current_gw} · live · updated ${ago(liveAt)}`
    : `GW${data.current_gw} · updated ${updated}`;
  status.classList.toggle("live", !!liveAt);
}

// "just now", "40s ago", "3 min ago"
function ago(time) {
  const s = Math.round((Date.now() - time) / 1000);
  return s < 10 ? "just now" : s < 60 ? `${s}s ago` : `${Math.round(s / 60)} min ago`;
}

setInterval(() => { if (liveAt) showStatus(); }, 15000);

// One click listener for the whole page
document.addEventListener("click", (e) => {
  // A dropdown's button (Gameweek / Metrics) opens its menu, or closes it if open
  const menuButton = e.target.closest(".menu .tab");
  if (menuButton) {
    const name = menuButton.dataset.tab;
    setMenu(document.getElementById(name + "-menu").hidden ? name : null);
    return;
  }
  // Any other click (including picking an item) closes the menus
  setMenu(null);

  const half = e.target.closest("[data-half]");
  if (half) { chipHalf = Number(half.dataset.half); render("chips"); }

  // Chips table headings: same column again reverses, a new column starts ascending
  const sort = e.target.closest("[data-sort]");
  if (sort) {
    const key = sort.dataset.sort;
    chipSort = { key, dir: chipSort.key === key ? -chipSort.dir : 1 };
    render("chips");
  }
});

// While a list is scrolled sideways, mark it so CSS can shadow the frozen
// manager column. Scroll events don't bubble, so listen in the capture phase
document.addEventListener("scroll", (e) => {
  const list = e.target;
  if (list.classList && list.classList.contains("list")) {
    list.classList.toggle("scrolled", list.scrollLeft > 0);
  }
}, true);

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") setMenu(null);
});

async function init() {
  try {
    // The ?t= stops the browser reusing an old copy of the data
    const resp = await fetch("data/dashboard.json?t=" + Date.now());
    if (!resp.ok) throw new Error("HTTP " + resp.status);
    data = await resp.json();
  } catch (err) {
    document.getElementById("status").textContent =
      "Couldn't load the data (" + err.message + "). Try refreshing.";
    return;
  }

  chipHalf = data.current_gw >= 19 ? 2 : 1;
  indexData();
  computeLive();   // provisional bonus and auto-subs for the current gameweek
  applyLive();     // ...fed into the Gameweek and Leaderboard tabs
  showStatus();
  for (const tab of TABS) render(tab);
  showTab();
  window.addEventListener("hashchange", showTab);
  pollLive();      // live scores while the gameweek is in progress
  window.addEventListener("resize", markScrollable);
}

init();
