# Step 2: build the metrics from the cached data in data/raw/.
# Makes no API calls - run R/01_ingest.R first.
#
# Writes CSVs to data/processed/ so you can check the numbers:
#   season_summary.csv   one row per manager, season totals
#   gw_transfers.csv     net transfer points per manager per GW (every GW;
#                        NA in Wildcard / Free Hit weeks, which don't count)
#   transfer_detail.csv  every transfer, with player names and points
#   gw_cards.csv         cards per manager per GW
#   card_detail.csv      every player who got a card, with points lost
#   gw_missed.csv        missed points per manager per GW, with the best
#                        player and the armband wearer named
#   chips_played.csv     every chip played, with the GW and season half
#
# Run from the project root:
#   Rscript R/02_metrics.R

source("R/fpl_api.R")

raw_dir <- "data/raw"
out_dir <- "data/processed"

# Readers ---------------------------------------------------------------------

# One row per player for one gameweek, including card deductions taken from
# FPL's own points breakdown (so it follows FPL's scoring rules exactly)
read_live_file <- function(file) {
  gw <- as.integer(str_extract(path_file(file), "\\d+"))
  live <- fromJSON(file, simplifyVector = FALSE)

  live$elements %>%
    map(function(el) {
      card_points <- el$explain %>%
        map(~ .x$stats) %>%
        list_flatten() %>%
        keep(~ .x$identifier %in% c("yellow_cards", "red_cards")) %>%
        map_dbl(~ .x$points) %>%
        sum()

      tibble(
        gw           = gw,
        element      = el$id,
        minutes      = el$stats$minutes,
        points       = el$stats$total_points,
        yellow_cards = el$stats$yellow_cards,
        red_cards    = el$stats$red_cards,
        card_points  = card_points
      )
    }) %>%
    list_rbind()
}

# A manager's 15 picks for one gameweek, plus that GW's summary
# (chip played, hit cost, points on bench)
read_picks_file <- function(file) {
  gw    <- as.integer(str_extract(path_file(path_dir(file)), "\\d+"))
  entry <- as.integer(path_ext_remove(path_file(file)))
  x     <- fromJSON(file)

  list(
    picks = as_tibble(x$picks) %>%
      select(element, position, is_captain, is_vice_captain) %>%
      mutate(gw = gw, entry = entry, .before = 1),
    gw_info = tibble(
      gw              = gw,
      entry           = entry,
      chip            = x$active_chip %||% NA_character_,
      gw_points       = x$entry_history$points,
      transfer_cost   = x$entry_history$event_transfers_cost,
      points_on_bench = x$entry_history$points_on_bench
    )
  )
}

read_transfers_file <- function(file) {
  x <- fromJSON(file)
  if (length(x) == 0) return(NULL)
  as_tibble(x) %>%
    transmute(entry, gw = event, element_in, element_out)
}

read_chips_file <- function(file) {
  x <- fromJSON(file)
  if (length(x$chips) == 0) return(NULL)
  as_tibble(x$chips) %>%
    transmute(
      entry = as.integer(path_ext_remove(path_file(file))),
      chip  = name,
      gw    = event
    )
}

# Metrics -----------------------------------------------------------------------

build_metrics <- function() {

  managers <- read_cached(path(raw_dir, "standings.json"))$results %>%
    as_tibble() %>%
    transmute(entry, manager = player_name, team = entry_name)

  # Puts the manager and team name at the front of a per-manager table
  add_names <- function(df) {
    managers %>%
      right_join(df, by = "entry") %>%
      arrange(entry, gw)
  }

  # Player names, so detail tables show "Salah" rather than an ID
  players <- read_cached(path(raw_dir, "bootstrap.json"))$elements %>%
    as_tibble() %>%
    transmute(element = id, player = web_name)

  live <- dir_ls(path(raw_dir, "live"), glob = "*.json") %>%
    map(read_live_file) %>%
    list_rbind()

  picks_raw <- dir_ls(path(raw_dir, "picks"), recurse = TRUE, glob = "*.json") %>%
    map(read_picks_file)

  picks <- picks_raw %>% map("picks") %>% list_rbind()

  gw_info <- picks_raw %>%
    map("gw_info") %>%
    list_rbind() %>%
    mutate(cap_mult = if_else(chip %in% "3xc", 3, 2))

  # Squad with each player's score -------------------------------------------
  squad <- picks %>%
    left_join(live, by = c("gw", "element")) %>%
    left_join(players, by = "element") %>%
    mutate(across(c(minutes, points, yellow_cards, red_cards, card_points),
                  ~ replace_na(.x, 0)))

  # Who actually wore the armband: captain if he played, else the vice if he
  # played, else nobody. (During a live GW a captain who hasn't played yet
  # shows as not played - this settles once the GW is final.)
  armband <- squad %>%
    group_by(gw, entry) %>%
    summarise(
      cap_played  = any(is_captain & minutes > 0),
      vice_played = any(is_vice_captain & minutes > 0),
      .groups = "drop"
    ) %>%
    mutate(armband = case_when(
      cap_played  ~ "captain",
      vice_played ~ "vice",
      TRUE        ~ "none"
    ))

  squad <- squad %>%
    left_join(armband %>% select(gw, entry, armband), by = c("gw", "entry")) %>%
    left_join(gw_info %>% select(gw, entry, cap_mult), by = c("gw", "entry")) %>%
    mutate(
      has_armband = (armband == "captain" & is_captain) |
                    (armband == "vice" & is_vice_captain),
      multiplier  = if_else(has_armband, cap_mult, 1)
    )

  # 1. Net transfer points ----------------------------------------------------
  # Player in minus player out, for the transfer GW only, whole squad,
  # minus hits, excluding Wildcard and Free Hit weeks
  player_points <- live %>% select(gw, element, points)

  transfers <- dir_ls(path(raw_dir, "transfers"), glob = "*.json") %>%
    map(read_transfers_file) %>%
    list_rbind()

  # One row per transfer. `counted` is FALSE in Wildcard / Free Hit weeks
  transfer_detail <- transfers %>%
    inner_join(gw_info %>% select(gw, entry, chip), by = c("gw", "entry")) %>%
    left_join(player_points %>% rename(element_in = element, in_points = points),
              by = c("gw", "element_in")) %>%
    left_join(player_points %>% rename(element_out = element, out_points = points),
              by = c("gw", "element_out")) %>%
    left_join(players %>% rename(element_in = element, player_in = player),
              by = "element_in") %>%
    left_join(players %>% rename(element_out = element, player_out = player),
              by = "element_out") %>%
    mutate(
      across(c(in_points, out_points), ~ replace_na(.x, 0)),
      gain    = in_points - out_points,
      counted = !chip %in% c("wildcard", "freehit")
    ) %>%
    select(entry, gw, chip, counted, player_in, in_points,
           player_out, out_points, gain)

  # Every GW for every manager, so "no transfers" (0) and "Wildcard week"
  # (NA, not counted) can be told apart
  gw_transfers <- gw_info %>%
    select(gw, entry, chip, transfer_cost) %>%
    left_join(
      transfer_detail %>%
        group_by(gw, entry) %>%
        summarise(transfers = n(), gross_gain = sum(gain), .groups = "drop"),
      by = c("gw", "entry")
    ) %>%
    mutate(
      across(c(transfers, gross_gain), ~ replace_na(.x, 0)),
      counted             = !chip %in% c("wildcard", "freehit"),
      net_transfer_points = if_else(counted, gross_gain - transfer_cost, NA)
    )

  # 2. Cards ------------------------------------------------------------------
  # Counts are unmultiplied; points lost apply the captain multiplier
  gw_cards <- squad %>%
    group_by(gw, entry) %>%
    summarise(
      yellow_cards     = sum(yellow_cards),
      red_cards        = sum(red_cards),
      card_points_lost = sum(card_points * multiplier),
      .groups = "drop"
    )

  card_detail <- squad %>%
    filter(yellow_cards > 0 | red_cards > 0) %>%
    transmute(entry, gw, player, yellow_cards, red_cards, multiplier,
              card_points_lost = card_points * multiplier)

  # 3. Missed points ----------------------------------------------------------
  # Bench points (zero in Bench Boost weeks) + captain gap, where the gap is
  # (best player - armband wearer) x the extra multiplier
  gw_missed <- squad %>%
    group_by(gw, entry, cap_mult) %>%
    summarise(
      best_points    = max(points),
      best_player    = paste(player[points == best_points], collapse = ", "),
      armband_player = first(player[has_armband], default = NA_character_),
      armband_points = sum(points[has_armband]),
      .groups = "drop"
    ) %>%
    left_join(gw_info %>% select(gw, entry, chip, points_on_bench),
              by = c("gw", "entry")) %>%
    mutate(
      bench_points  = if_else(chip %in% "bboost", 0, points_on_bench),
      captain_gap   = (best_points - armband_points) * (cap_mult - 1),
      missed_points = bench_points + captain_gap
    )

  # Chips -----------------------------------------------------------------------
  # First set must be played before the GW19 deadline
  chips_played <- dir_ls(path(raw_dir, "history"), glob = "*.json") %>%
    map(read_chips_file) %>%
    list_rbind() %>%
    mutate(half = if_else(gw < 19, 1L, 2L))

  # Season summary ------------------------------------------------------------
  season_summary <- managers %>%
    left_join(
      gw_transfers %>%
        filter(counted) %>%
        group_by(entry) %>%
        summarise(net_transfer_points = sum(net_transfer_points),
                  hit_points = sum(transfer_cost)),
      by = "entry"
    ) %>%
    left_join(
      gw_cards %>%
        group_by(entry) %>%
        summarise(across(c(yellow_cards, red_cards, card_points_lost), sum)),
      by = "entry"
    ) %>%
    left_join(
      gw_missed %>%
        group_by(entry) %>%
        summarise(across(c(bench_points, captain_gap, missed_points), sum)),
      by = "entry"
    ) %>%
    mutate(across(where(is.numeric) & !entry, ~ replace_na(.x, 0)))

  list(
    managers        = managers,
    season_summary  = season_summary,
    gw_transfers    = add_names(gw_transfers),
    transfer_detail = add_names(transfer_detail),
    gw_cards        = add_names(gw_cards),
    card_detail     = add_names(card_detail),
    gw_missed       = add_names(gw_missed),
    chips_played    = add_names(chips_played)
  )
}

# Run -----------------------------------------------------------------------------

metrics <- build_metrics()

dir_create(out_dir)
walk(
  c("season_summary", "gw_transfers", "transfer_detail", "gw_cards",
    "card_detail", "gw_missed", "chips_played"),
  ~ write_csv(metrics[[.x]], path(out_dir, paste0(.x, ".csv")))
)

print(
  metrics$season_summary %>%
    select(manager, net_transfer_points, yellow_cards, red_cards,
           card_points_lost, missed_points) %>%
    arrange(desc(net_transfer_points)),
  n = Inf
)
message("CSVs written to ", out_dir)