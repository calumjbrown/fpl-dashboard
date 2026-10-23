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
let chipHalf = 1;

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

// Gameweek ------------------------------------------------------------------
// The current gameweek only: ranked by points after hits, each manager
// expanding to their lineup

function renderGameweek() {
  const lineups = groupBy(data.gw_lineups, "entry");
  const sorted = [...data.gw_summary].sort((a, b) => b.net_points - a.net_points);
  const ranks = tiedRanks(sorted, (s) => s.net_points);

  const rows = sorted.map((s, i) => `<details>
      <summary class="row toggle">
        <span class="rank">${ranks[i]}</span>
        ${who(s)}
        <span class="num">${hit(s.transfer_cost)}</span>
        <span class="num strong">${s.net_points}</span>
      </summary>
      <div class="detail">${lineupDetail(s, lineups.get(s.entry) || [])}</div>
    </details>`);

  const provisional = data.gw_finished ? ""
    : " The gameweek is still in progress, so points and auto-subs are provisional.";

  return `<h2 class="page-title">Gameweek ${data.current_gw}</h2>
    <div class="list" style="--n:2">
      <div class="row head toggle">
        <span>#</span><span>Manager</span><span class="num">Hits</span><span class="num">Pts</span>
      </div>
      ${rows.join("")}
    </div>
    <p class="note">Points after transfer hits.${provisional} Tap a manager to see their team.</p>`;
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

// Starting XI and bench. Each player expands to his points breakdown: one
// line per stat with its count and the points it earned. FPL has already
// applied auto-subs to the order, and pick_multiplier is 0 for anyone left
// on the bench (so their points don't count)
function lineupDetail(s, picks) {
  const sorted = [...picks].sort((a, b) => a.position - b.position);
  const xi = sorted.filter((p) => p.position <= 11);
  const bench = sorted.filter((p) => p.position > 11);
  const counted = (ps) => ps.reduce((sum, p) => sum + p.points * p.pick_multiplier, 0);

  const breakdown = (p) => {
    const stats = [...(byElement.get(p.element) || [])]
      .sort((a, b) => statOrder.indexOf(a.stat) - statOrder.indexOf(b.stat));
    const rows = stats.map((b) =>
      `<li><span>${STATS[b.stat] || b.stat}</span><span>${b.value}</span>` +
      `<span>${b.points < 0 ? tone(b.points) : b.points}</span></li>`);  // only losses coloured

    // Captain / Triple Captain extra points, and bench status
    if (p.pick_multiplier > 1) {
      const label = p.pick_multiplier === 3 ? "Triple Captain" : "Captain";
      rows.push(`<li><span>${label}</span><span>×${p.pick_multiplier}</span>` +
                `<span>+${p.points * (p.pick_multiplier - 1)}</span></li>`);
    }
    if (p.pick_multiplier === 0) {
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
    const pts = p.pick_multiplier > 0 ? p.points * p.pick_multiplier : p.points;
    return `<li class="player${p.pick_multiplier > 0 ? "" : " benched"}"><details>
      <summary>
        <span><span class="pos">${p.pos}</span>${esc(p.player)} <small>${esc(p.club)}</small>` +
        `${armband ? ` <span class="badge">${armband}</span>` : ""}</span>
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

  // Alphabetical by name (so first name, then surname); no rank on this tab
  const byName = [...data.standings].sort((a, b) => a.manager.localeCompare(b.manager));
  const rows = byName.map((s) => {
    const chips = status.get(s.entry) || [];
    return `<div class="row">
      <span></span>
      ${who(s)}
      ${CHIPS.map((c) => `<span class="mid">${pill(chips.find((x) => x.chip === c.id))}</span>`).join("")}
    </div>`;
  });

  const note = chipHalf === 1
    ? "First set: must be played before the GW19 deadline and doesn't carry over."
    : "Second set: available from GW19.";

  return `<div class="segs">${switcher}</div>
    <div class="list no-rank" style="--n:${CHIPS.length}">
      <div class="row head">
        <span></span><span>Manager</span>
        ${CHIPS.map((c) => `<span class="mid" title="${c.name}">${c.short}</span>`).join("")}
      </div>
      ${rows.join("")}
    </div>
    <p class="note">${note} ✓ = still available, GW = when it was played.</p>`;
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

  for (const t of TABS) document.getElementById("tab-" + t).hidden = t !== tab;
  for (const el of document.querySelectorAll(".tabs .tab")) {
    el.classList.toggle("on", el.dataset.tab === tab);
  }
  renderMenu(tab);
  setMenu(false);
  markScrollable();
}

// Metrics dropdown in the nav -------------------------------------------------

function renderMenu(tab) {
  document.getElementById("metrics-menu").innerHTML = Object.entries(METRICS).map(([id, x]) => {
    const on = tab === "metrics" && id === metricView ? ' class="on"' : "";
    return `<a href="#metrics/${id}"${on}>${x.label}</a>`;
  }).join("");
}

function setMenu(open) {
  document.querySelector(".menu .tab").setAttribute("aria-expanded", open);
  document.getElementById("metrics-menu").hidden = !open;
}

function indexData() {
  for (const key of ["gw_transfers", "transfer_detail", "card_detail", "gw_missed", "gw_dfyter"]) {
    byEntry[key] = groupBy(data[key], "entry");
  }
  byElement = groupBy(data.gw_breakdown, "element");
  leagueHistory = groupBy(data.league_history, "entry");
}

function showStatus() {
  const updated = new Date(data.updated).toLocaleString("en-GB", {
    weekday: "short", day: "numeric", month: "short", hour: "2-digit", minute: "2-digit",
  });
  // current_gw is the latest gameweek that has started, including one in progress
  document.getElementById("league").textContent = data.league;
  document.getElementById("status").textContent = `GW${data.current_gw} · updated ${updated}`;
}

// One click listener for the whole page
document.addEventListener("click", (e) => {
  // Metrics button opens / closes its menu
  if (e.target.closest(".menu .tab")) {
    setMenu(document.getElementById("metrics-menu").hidden);
    return;
  }
  // Any other click (including picking a metric) closes the menu
  setMenu(false);

  const half = e.target.closest("[data-half]");
  if (half) { chipHalf = Number(half.dataset.half); render("chips"); }
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
  if (e.key === "Escape") setMenu(false);
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
  showStatus();
  for (const tab of TABS) render(tab);
  showTab();
  window.addEventListener("hashchange", showTab);
  window.addEventListener("resize", markScrollable);
}

init();
