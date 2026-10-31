# Step 3: export everything the website needs to docs/data/dashboard.json.
# Makes no API calls - builds the metrics from data/raw/ via 02_metrics.R.
#
# The file is only rewritten when the data inside it has changed, so a
# scheduled run with nothing new leaves nothing to commit. Its `updated`
# time is therefore when the data last changed.
#
# Run from the project root:
#   Rscript R/03_export.R

source("R/02_metrics.R")  # builds `metrics` (and writes the CSVs)

export_file <- "docs/data/dashboard.json"

# Chip monitor: every manager x season half x chip, with the GW it was played
# (NA if not). First-half chips expire at GW19; second-half ones open then.
build_chip_status <- function(chips_played, managers, current_gw) {
  managers %>%
    cross_join(tibble(half = c(1L, 2L))) %>%
    cross_join(tibble(chip = c("wildcard", "freehit", "bboost", "3xc"))) %>%
    left_join(chips_played %>% select(entry, chip, half, gw),
              by = c("entry", "chip", "half")) %>%
    mutate(status = case_when(
      !is.na(gw)                   ~ "used",
      half == 1 & current_gw >= 19 ~ "expired",
      half == 2 & current_gw < 19  ~ "locked",
      TRUE                         ~ "available"
    ))
}

# Gameweek tab: each lineup player's points breakdown, straight from FPL's
# explain data - one row per stat with its count (goals = 1) and the points
# it earned (goals = 4), summed over fixtures in a double gameweek. FPL only
# lists stats that scored, plus minutes, so the points add up to his total.
read_player_breakdown <- function(gw, elements) {
  live <- fromJSON(path(raw_dir, "live", sprintf("gw_%02d.json", gw)),
                   simplifyVector = FALSE)

  live$elements %>%
    keep(~ .x$id %in% elements) %>%
    map(function(el) {
      el$explain %>%
        map(~ .x$stats) %>%
        list_flatten() %>%
        map(~ tibble(element = el$id, stat = .x$identifier,
                     value = .x$value, points = .x$points)) %>%
        list_rbind()
    }) %>%
    list_rbind() %>%
    group_by(element, stat) %>%
    summarise(value = sum(value), points = sum(points), .groups = "drop")
}

# Current GW fixtures for provisional bonus and auto-subs on the website:
# which teams play, whether each match has started, ended (finished_provisional)
# and had its bonus confirmed (finished), plus every player's live BPS
read_gw_fixtures <- function(gw) {
  file <- path(raw_dir, "fixtures", sprintf("gw_%02d.json", gw))
  if (!file_exists(file)) return(list(fixtures = tibble(), bps = tibble()))
  fx <- fromJSON(file, simplifyVector = FALSE)

  fixtures <- fx %>%
    map(~ tibble(fixture = .x$id, team_h = .x$team_h, team_a = .x$team_a,
                 started = isTRUE(.x$started),
                 ended = isTRUE(.x$finished_provisional),
                 bonus_final = isTRUE(.x$finished))) %>%
    list_rbind()

  bps <- fx %>%
    map(function(f) {
      s <- keep(f$stats, ~ .x$identifier == "bps")
      if (!length(s)) return(NULL)
      c(s[[1]]$h, s[[1]]$a) %>%
        map(~ tibble(fixture = f$id, element = .x$element, bps = .x$value)) %>%
        list_rbind()
    }) %>%
    list_rbind()

  list(fixtures = fixtures, bps = bps)
}

to_json <- function(x) {
  toJSON(x, dataframe = "rows", na = "null", auto_unbox = TRUE, digits = NA)
}

# Fingerprint of the data, used to tell whether anything has changed
data_hash <- function(x) {
  tmp <- tempfile()
  writeLines(to_json(x), tmp)
  unname(tools::md5sum(tmp))
}

run_export <- function() {
  events    <- read_cached(path(raw_dir, "bootstrap.json"))$events
  standings <- read_cached(path(raw_dir, "standings.json"))

  current_gw <- max(events$id[events$finished | events$is_current])

  gw_fx <- read_gw_fixtures(current_gw)

  # Current GW score per manager, after hits (live during the GW)
  gw_summary <- metrics$gw_points %>%
    filter(gw == current_gw) %>%
    mutate(net_points = gw_points - transfer_cost)

  # Leaderboard. FPL's standings lag during a live GW: last_rank isn't
  # refreshed until the GW is processed (so arrows would show last week's
  # movement) and event_total trails the live score. So rank, movement and
  # totals come from each manager's history (refetched every run), falling
  # back to FPL's figures only for a manager with no history row yet
  history_at <- function(g) metrics$league_history %>% filter(gw == g)

  leaderboard <- standings$results %>%
    as_tibble() %>%
    transmute(entry, manager = clean_name(player_name), team = entry_name,
              fpl_rank = rank, fpl_total = total, fpl_event = event_total) %>%
    left_join(history_at(current_gw) %>% select(entry, rank = league_rank, total),
              by = "entry") %>%
    left_join(history_at(current_gw - 1) %>% select(entry, last_rank = league_rank),
              by = "entry") %>%
    left_join(gw_summary %>% select(entry, event_total = net_points), by = "entry") %>%
    mutate(rank        = coalesce(rank, fpl_rank),
           total       = coalesce(total, fpl_total),
           event_total = coalesce(event_total, fpl_event)) %>%
    select(entry, manager, team, rank, last_rank, total, event_total) %>%
    arrange(rank)

  data <- list(
    league      = standings$league$name,
    current_gw  = current_gw,
    gw_finished = events$finished[events$id == current_gw],
    # Final = FPL has processed the GW (bonus, auto-subs, vice-captain all
    # applied in the picks), so the website shows FPL's figures as they are
    gw_final    = events$finished[events$id == current_gw] &&
                  events$data_checked[events$id == current_gw],
    standings   = leaderboard,
    season_summary  = metrics$season_summary,
    league_history  = metrics$league_history %>% select(entry, gw, total, league_rank),
    gw_fixtures     = gw_fx$fixtures,
    gw_bps          = gw_fx$bps,
    gw_transfers    = metrics$gw_transfers,
    transfer_detail = metrics$transfer_detail,
    gw_cards        = metrics$gw_cards,
    card_detail     = metrics$card_detail,
    gw_missed       = metrics$gw_missed,
    gw_dfyter       = metrics$gw_dfyter,
    gw_pints        = metrics$gw_pints %>% select(entry, gw, points, joint_with),
    # Gameweek tab: current GW only
    gw_summary      = gw_summary,
    gw_lineups      = metrics$squads %>%
      filter(gw == current_gw) %>%
      select(-manager, -team, -gw),
    gw_breakdown    = read_player_breakdown(
      current_gw,
      metrics$squads %>% filter(gw == current_gw) %>% pull(element) %>% unique()
    ),
    chip_status     = build_chip_status(metrics$chips_played,
                                        metrics$managers, current_gw)
  )

  new_hash <- data_hash(data)
  old_hash <- if (file_exists(export_file)) read_cached(export_file)$data_hash

  if (identical(new_hash, old_hash)) {
    message("Dashboard data unchanged - ", export_file, " left as is.")
    return(invisible(FALSE))
  }

  out <- c(
    list(updated   = format(Sys.time(), "%Y-%m-%dT%H:%M:%SZ", tz = "UTC"),
         data_hash = new_hash),
    data
  )
  write_text_atomic(to_json(out), export_file)
  message("Wrote ", export_file)
  invisible(TRUE)
}

run_export()
