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
- **Optional later:** a Cloudflare Worker proxy for live mid-match standings.
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
  weeks have `counted = FALSE` and `net_transfer_points = NA`.

Next: the owner should sanity-check numbers against the FPL site (bench
points, a known transfer, a known captain choice).

## Dashboard tabs

1. **Custom leaderboard** – design to come.
2. **Metrics** – definitions agreed below.
3. **Chip monitor** – which chips each manager has left and when they played them.

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
- Yellow card count and red card count across all 15 squad players,
  unmultiplied.
- Points lost: card deductions from FPL's per-player `explain` breakdown
  (identifiers `yellow_cards`, `red_cards`), multiplied by the armband
  multiplier (×2, or ×3 with Triple Captain); everyone else ×1, bench included.
- Display points lost as a negative number.

**Missed points**
- Bench points (`points_on_bench`, after auto-subs; forced to 0 in Bench Boost
  weeks) + captain gap.
- Captain gap = (highest-scoring player in the 15 − armband wearer's points)
  × (multiplier − 1). So ×1 normally, ×2 in Triple Captain weeks.
- Armband wearer = captain if he played (minutes > 0), else vice-captain if he
  played, else nobody (armband points = 0). Provisional during a live GW.

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
| 2. Metric functions | Built and running; owner to verify numbers |
| 3. JSON export to `docs/data/`, scheduled workflow, commit-back | To do |
| 4. Frontend shell (three tabs) | To do |
| 5. Design each page with the owner | To do |
| 6. Optional live-score Worker | To do |

Notes for Step 3: schedule every 30–60 min on match days, daily otherwise
(cron is UTC). Skip the run quietly if FPL is updating. Commit `data/raw/`
(it is the persistent cache between runs) and `docs/data/`.
