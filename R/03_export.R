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

  data <- list(
    league      = standings$league$name,
    current_gw  = current_gw,
    gw_finished = events$finished[events$id == current_gw],
    standings   = standings$results %>%
      as_tibble() %>%
      transmute(entry, manager = player_name, team = entry_name,
                rank, last_rank, total, event_total),
    season_summary  = metrics$season_summary,
    gw_transfers    = metrics$gw_transfers,
    transfer_detail = metrics$transfer_detail,
    gw_cards        = metrics$gw_cards,
    card_detail     = metrics$card_detail,
    gw_missed       = metrics$gw_missed,
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
