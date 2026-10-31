# FPL Dashboard – project context and status

A free, public, fast dashboard for a 15-manager Fantasy Premier League classic
mini-league. No login. All data comes from the public FPL API.

## Architecture (decided)

- **Data pipeline: R**, run on a schedule by GitHub Actions. Fetches from the
  FPL API, caches raw responses in `data/raw/`, computes metrics, and (to do)
  exports small JSON files to `docs/data/` and commits them back to the repo.
- **Frontend: plain HTML/CSS/JS** (no framework), served by GitHub Pages from
  `docs/` on `main`. Pages fetch the pre-built JSON; the browser never calls
  the FPL API (it has no CORS support anyway).
- **Live:** a Cloudflare Worker proxy feeds minute-by-minute scores to the
  Gameweek and Leaderboard tabs (see "Live updates" below).
- **Everything must stay free.**

## Owner and environment

- Owner is primarily an R developer, not a full-stack coder. Explain JS/web
  steps clearly.
- R style: tidyverse functions, `%>%` pipes, `data.table::fread` for CSV import.
- Windows, VS Code, PowerShell terminal. Project lives in a OneDrive folder
  (owner's choice) – if Git lock/permission errors appear, OneDrive syncing is
  the likely cause.
- Run R scripts with `Rscript R/<file>.R` from the project root (R is on PATH).
- League ID is set per terminal session: `$env:LEAGUE_ID = "<id>"`. It is also
  stored as a GitHub Actions repository **variable** `LEAGUE_ID`.

## Repo setup (done)

- Public repo `fpl-dashboard`, branch `main`.
- GitHub Pages live from `main` / `docs` (placeholder `docs/index.html`).
- Actions workflow permissions set to read and write.
- `.github/workflows/smoke-test.yml` (manual trigger) passes. It runs in the
  `rocker/r-ver:4.5` container on `ubuntu-24.04` with `actions/checkout@v5`.
  Do **not** use `r-lib/actions/setup-r` – it hung on system package installs.
  Install packages with `Rscript -e 'install.packages(...)'` inside the
  container (pre-built binaries, fast). Note `resp_body_json()` needs
  `jsonlite` installed explicitly.

## Files

- `R/smoke_test.R` – basic API reachability check.
- `R/fpl_api.R` – helpers: `fpl_get_text()` (user agent, 30s timeout, 3
  retries, 0.3s pause, errors if FPL returns non-JSON while updating),
  `write_text_atomic()`, `fetch_to_cache(path, file, frozen)`, `read_cached()`,
  `fetch_standings()` (handles pagination).
- `R/01_ingest.R` – **working.** Caches into `data/raw/`:
  `bootstrap.json`, `standings.json`, `live/gw_XX.json`,
  `history/<entry>.json`, `transfers/<entry>.json`,
  `picks/gw_XX/<entry>.json`, `last_run.json`. Finished + `data_checked` GWs
  are frozen and never refetched. Only fetches picks for GWs present in each
  manager's history. First run ~175 calls, later runs ~50.
- `R/02_metrics.R` – **working.** Metrics computed and CSVs written to
  `data/processed/`. All `library()` calls live in `fpl_api.R` inside
  `suppressPackageStartupMessages()`. Per-GW tables (`gw_transfers`,
  `gw_cards`, `gw_missed`) cover every manager × GW and carry manager/team
  names, for the dashboard's gameweek breakdown. Drill-down tables
  `transfer_detail` and `card_detail` name the players; `gw_missed` names
  `best_player` and `armband_player`. In `gw_transfers`, Wildcard/Free Hit
  weeks have `counted = FALSE` and `net_transfer_points = NA`. Numbers
  verified by the owner against the FPL site. `data/processed/` is
  gitignored (local checking only).
- `R/03_export.R` – sources `02_metrics.R` and writes one file,
  `docs/data/dashboard.json`: `updated`, `data_hash`, `league`,
  `current_gw`, `gw_finished`, plus row-array tables `standings`,
  `season_summary`, `gw_transfers`, `transfer_detail`, `gw_cards`,
  `card_detail`, `gw_missed`, `chip_status` (manager × half × chip, status
  used / available / locked / expired). Only rewritten when `data_hash`
  changes, so `updated` = when the data last changed.
- `.github/workflows/update-data.yml` – ingest → export → commit. Cron
  `7,37 11-23 * * *` sets `MATCH_WINDOW_ONLY=true`, so ingest only fetches if
  a fixture in the current GW kicked off in the last 3 hours
  (`match_in_window()` in `fpl_api.R`); `17 6 * * *` is a daily full run.
  Manual / API trigger (`workflow_dispatch`) takes input `match_window_only`
  (default false = full fetch). Installs git and libuv1 in the container.
  Commits `docs/data` + `data/raw` only when `docs/data` changed.
- **GitHub's scheduler proved unreliable** (24 Oct 2026: runs hours late or
  dropped – only 4 scheduled runs in ~17h, none during a 12:30 kickoff).
  Odd-minute crons help a bit; the intended reliable trigger is an external
  free cron (e.g. cron-job.org) POSTing every 15 min to
  `https://api.github.com/repos/calumjbrown/fpl-dashboard/actions/workflows/update-data.yml/dispatches`
  with body `{"ref":"main","inputs":{"match_window_only":true}}` and headers
  `Authorization: Bearer <fine-grained PAT, this repo only, Actions: read &
  write>`, `Accept: application/vnd.github+json`. The token lives only in the
  cron service – never in the repo.

Known gap: if FPL starts updating partway through an ingest run, the run
errors instead of skipping quietly (the next run recovers).

## Dashboard tabs

1. **Custom leaderboard** – rank (with ▲▼ movement), manager, Form, GW,
   Total. Rank, movement (vs previous GW) and Total come from
   `league_history`, GW = live net points from `gw_summary` – NOT FPL's
   standings, whose `last_rank` isn't refreshed until a GW is processed
   (arrows showed the previous GW's movement) and whose `event_total` lags.
   **All GW scores are calculated live** in `02_metrics.R`: Σ live player
   points × FPL `pick_multiplier` (FPL's stored `entry_history.points` and
   history `total_points` lag mid-GW – showed 0 when the FPL site showed 16).
   `league_history` total = cumsum(GW score − hits). Both verified identical
   to FPL's stored figures for finished GWs 1–7. Form = sparkline of league position over the last 5 GWs
   (`league_history`: rank by running total within the league, ties share –
   verified to match FPL's rank/last_rank). Each line is scaled to the
   manager's own range (min span 4 places); end dot green = climbed over the
   5 GWs, coral = dropped.
2. **Gameweek** – nav dropdown (same as Metrics; both share `MENUS` in
   app.js), current GW only, two views (`#gameweek/leaderboard`,
   `#gameweek/players`). **Players**: every player
   picked by anyone in the league, by GW points (ties: most owned, then
   name), with Owned count; expands to who picked him (C/V/TC badge, points
   earned them incl. captain multiplier, or "bench"). Built in the browser
   from `gw_lineups` – no extra data. **Leaderboard**: ranked by points after hits; each manager
   expands to their XI and bench with points per player (FPL's
   `pick_multiplier` applied, so captain ×2 and auto-subs are reflected).
   Data: `gw_summary` and `gw_lineups` in `dashboard.json`. Each player in
   the lineup expands to a list: stat | count (goals = 1) | points (goals = 4),
   from FPL's `explain` (`gw_breakdown`), plus a captain/TC line. (A
   column-per-stat table was tried and rejected by the owner as messy.)
3. **Metrics** – nav dropdown (Net transfer points, Cards, Missed points,
   DFYTer Index, Pints); definitions agreed below.
4. **Chip monitor** – which chips each manager has left and when they played them.

**Live updates (Cloudflare Worker)** – `worker/fpl-live.js`, deployed by the
owner at `https://fpl-live.calubrow.workers.dev` (free plan). Read-only proxy
for only `event/<gw>/live/` and `fixtures/?event=<gw>`; caches 60s; CORS for
calumjbrown.github.io and localhost:8000. To change it, the owner pastes the
file into the Cloudflare dashboard (Workers & Pages → fpl-live → Edit code →
Deploy). `pollLive()` / `fetchLive()` / `mergeLive()` in app.js: while the
GW isn't final, fetch every 60s if a match is in progress, else every 5 min;
paused while the page is hidden; merge into `gw_lineups` (minutes, points),
`gw_breakdown`, `gw_fixtures`, `gw_bps`, then `computeLive()` +
`applyLive()` and redraw Leaderboard + Gameweek keeping expanded rows open
(`data-key` on details). Header shows "live · updated Ns ago". On failure
the page keeps its data.

**Provisional bonus and auto-subs (current GW, in the browser)** –
`computeLive()` / `scoreTeam()` / `applyLive()` in app.js, so the same code
will serve a future live Worker. Inputs exported by `03_export.R`:
`gw_fixtures` (fixture, team_h, team_a, started, `ended` =
finished_provisional, `bonus_final` = finished), `gw_bps`, `team_id` on
lineups, `league_history.total`, and `gw_final` (finished && data_checked).
`01_ingest.R` caches `fixtures/gw_XX.json`.
- Bonus: matches started but not `bonus_final` → top 3 by BPS get 3/2/1,
  ties share the higher place (FPL's 3,3,1 / 3,2,2 / 3,2,1,1).
- Auto-subs (owner's condition): a starter is only subbed once **all his
  team's matches this GW have ended** and he played 0 min (no match = ended).
  Bench in order, GK↔GK only, formation stays legal; a bench player comes on
  only if he played; if the next one might still play, the sub waits.
- Armband → vice only when the captain is a confirmed no-show and the vice
  (in the XI) has played. No subs with Bench Boost.
- When `gw_final`, FPL's processed multipliers are used as-is.
- Applied to Gameweek (both views) and Leaderboard (GW, total = previous GW
  total + live score, rank, movement, Form's last point). Metrics stay on
  R's figures. Logic covered by scenario tests (16 cases) run during build.

## Metric definitions (agreed with owner)

All computed per manager per gameweek, then summed for the season.

**Net transfer points**
- Σ (player in's points − player out's points) for the GW the transfer was
  made for only, minus that GW's hit cost (`event_transfers_cost`).
- Raw player points regardless of whether the player started or was benched;
  no captain multiplier.
- Exclude GWs where the manager played Wildcard (`wildcard`) or Free Hit
  (`freehit`). Bench Boost and Triple Captain weeks count.

**Cards** (show three columns)
- Only players who ended up on the pitch: FPL's per-pick `multiplier` > 0
  (starting XI after auto-subs – FPL swaps positions/multipliers in the picks
  file – and all 15 in Bench Boost weeks). Bench players are excluded.
- Yellow card count and red card count, unmultiplied.
- Points lost: card deductions from FPL's per-player `explain` breakdown
  (identifiers `yellow_cards`, `red_cards`), multiplied by the armband
  multiplier (×2, or ×3 with Triple Captain); everyone else ×1.
- Display points lost as a negative number.

**Missed points**
- Bench gap + captain gap.
- Bench gap (changed by owner from plain `points_on_bench`) = points of the
  best legal XI from the 15 − points of the XI that actually counted (after
  auto-subs), raw points, no captain multiplier. Formation rules: 1 GKP,
  3–5 DEF, 2–5 MID, 1–3 FWD (`best_xi()` in `02_metrics.R`; ties favour
  actual starters, both within a position and between formations with equal
  points – so swaps are only shown when they gain points, never 0-for-0;
  owner reported this for Alex Macpherson GW8). Never negative. Forced to 0
  in Bench Boost weeks.
  `bench_in` / `bench_out` name the swaps for the GW breakdown.
- Captain gap = (highest-scoring player in the 15 − armband wearer's points)
  × (multiplier − 1). So ×1 normally, ×2 in Triple Captain weeks.
- Armband wearer = captain if he played (minutes > 0), else vice-captain if he
  played, else nobody (armband points = 0). Provisional during a live GW.

**DFYTer Index** (owner's own metric)
- Per GW, each player's score = (managers with him in their 15 − 1) ÷
  (managers in the league − 1), i.e. the share of the OTHER managers (those
  with a team that GW) who also own him. Unique player = 0, owned by all = 1.
  So a squad sharing no one's players scores 0%; identical teams all score
  100%.
- Manager GW score = mean over their 15 players. Season score = mean over
  their GWs. Shown as a percentage; ranked highest (most template) first.
- GW breakdown also lists players nobody else in the league owned.

**Pints** (owner's own metric)
- A manager downs a pint for every gameweek they lose: lowest GW score in
  the league, after transfer hits (`gw_points − transfer_cost`, live-calculated).
- Joint-bottom: everyone tied drinks (assumption – owner can change).
- A gameweek only counts once its points are final: FPL event `finished`
  AND `data_checked` (owner changed this from "exclude the current GW"). `gw_pints` lists each loss with `joint_with`; season count is
  `pints` in `season_summary`. Ranked most pints first.

## Chip rules 2026/27

- Eight chips: Wildcard, Free Hit, Bench Boost, Triple Captain – one set per
  half of the season.
- First set must be used before the GW19 deadline (13:30 GMT, Sat 2 Jan 2027)
  and does not carry over. Set two is available from GW19.
- One chip per gameweek. No Assistant Manager chip.
- API chip names: `wildcard`, `freehit`, `bboost`, `3xc`.

## Build plan

| Step | Status |
|---|---|
| 0. Setup and smoke test | Done |
| 1. Ingest and cache script | Done |
| 2. Metric functions | Done (verified) |
| 3. JSON export to `docs/data/`, scheduled workflow, commit-back | Done |
| 4. Frontend shell (tabs) | Done – live at calumjbrown.github.io/fpl-dashboard |
| 5. Design each page with the owner | In progress (ongoing tweaks) |
| 6. Optional live-score Worker | Done – fpl-live.calubrow.workers.dev |

Notes for Step 5: the leaderboard design may need per-GW points history,
which is in the cached `history/` files but not yet exported.
