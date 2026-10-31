# Step 1: fetch everything the dashboard needs from the FPL API into data/raw/.
#
# Finished, checked gameweeks never change, so they are fetched once and then
# read from the cache on every later run. Only the current gameweek and the
# small per-manager files are refreshed each time.
#
# Run from the project root:
#   $env:LEAGUE_ID = "123456"
#   Rscript R/01_ingest.R

source("R/fpl_api.R")

raw_dir <- "data/raw"

run_ingest <- function(league_id = Sys.getenv("LEAGUE_ID")) {
  if (league_id == "") stop("LEAGUE_ID is not set", call. = FALSE)

  # 1. Game state ----------------------------------------------------------
  # If FPL is mid-update this fails; we stop quietly and keep the old cache.
  boot_text <- tryCatch(
    fpl_get_text("bootstrap-static/"),
    error = function(e) {
      message("Skipping run: ", conditionMessage(e))
      NULL
    }
  )
  if (is.null(boot_text)) return(invisible(FALSE))

  write_text_atomic(boot_text, path(raw_dir, "bootstrap.json"))
  events <- fromJSON(boot_text)$events

  # Gameweeks that have started (finished, or in progress now)
  started_gws <- events %>%
    filter(finished | is_current) %>%
    pull(id)

  # Gameweeks whose scores are final and will never change again
  final_gws <- events %>%
    filter(finished, data_checked) %>%
    pull(id)

  if (length(started_gws) == 0) {
    message("No gameweeks have started yet - nothing to fetch.")
    return(invisible(FALSE))
  }

  current_gw <- max(started_gws)
  message("Current GW: ", current_gw,
          " | final GWs cached permanently: ", length(final_gws))

  # The half-hourly schedule sets MATCH_WINDOW_ONLY so that it only fetches
  # while a match is on or just finished. The daily run always fetches.
  if (Sys.getenv("MATCH_WINDOW_ONLY") == "true" && !match_in_window(current_gw)) {
    message("No match in the last 3 hours - skipping run.")
    return(invisible(FALSE))
  }

  # 2. League members -------------------------------------------------------
  standings <- fetch_standings(league_id)
  write_json(standings, path(raw_dir, "standings.json"),
             auto_unbox = TRUE, pretty = TRUE)

  managers <- standings$results %>%
    select(entry, entry_name, player_name)

  message("League: ", standings$league$name,
          " | managers: ", nrow(managers))

  # 3. Player scores per gameweek (one call covers every player) -----------
  walk(started_gws, function(gw) {
    fetch_to_cache(
      path   = paste0("event/", gw, "/live/"),
      file   = path(raw_dir, "live", sprintf("gw_%02d.json", gw)),
      frozen = gw %in% final_gws
    )
    # Fixtures: which teams play, whether each match has started / ended /
    # had its bonus confirmed, and live BPS - for provisional bonus and
    # auto-subs on the website
    fetch_to_cache(
      path   = paste0("fixtures/?event=", gw),
      file   = path(raw_dir, "fixtures", sprintf("gw_%02d.json", gw)),
      frozen = gw %in% final_gws
    )
  })

  # 4. Per-manager data -----------------------------------------------------
  walk(managers$entry, function(entry) {
    # Season history: GW points, bench points, hits, chips. Small, so always
    # refreshed (it gains a row each gameweek).
    history_file <- path(raw_dir, "history", paste0(entry, ".json"))
    fetch_to_cache(paste0("entry/", entry, "/history/"), history_file)

    # All transfers made this season. Also small, always refreshed.
    fetch_to_cache(
      paste0("entry/", entry, "/transfers/"),
      path(raw_dir, "transfers", paste0(entry, ".json"))
    )

    # Team picks for each gameweek the manager actually played. Using the
    # history file avoids asking for gameweeks before they joined.
    played_gws <- read_cached(history_file)$current$event
    played_gws <- intersect(played_gws, started_gws)

    walk(played_gws, function(gw) {
      fetch_to_cache(
        path   = paste0("entry/", entry, "/event/", gw, "/picks/"),
        file   = path(raw_dir, "picks", sprintf("gw_%02d", gw),
                      paste0(entry, ".json")),
        frozen = gw %in% final_gws
      )
    })
  })

  # 5. Record what happened -------------------------------------------------
  run_info <- list(
    run_at       = format(Sys.time(), tz = "UTC", usetz = TRUE),
    current_gw   = current_gw,
    final_gws    = length(final_gws),
    managers     = nrow(managers),
    api_calls    = .fpl_env$calls
  )
  write_json(run_info, path(raw_dir, "last_run.json"),
             auto_unbox = TRUE, pretty = TRUE)

  message("Done. API calls this run: ", .fpl_env$calls)
  invisible(TRUE)
}

run_ingest()