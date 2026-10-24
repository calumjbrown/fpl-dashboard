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
#   gw_dfyter.csv        DFYTer Index per manager per GW, with the players
#                        nobody else in the league owned
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
      select(element, position, is_captain, is_vice_captain,
             pick_multiplier = multiplier) %>%
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

# Best possible XI from a 15-man squad under FPL's formation rules: 1 GKP,
# 3-5 DEF, 2-5 MID, 1-3 FWD. Tries every legal formation, takes the top
# scorers in each position, and keeps the formation with the most points.
# Ties favour players who actually started, so equal scores aren't "swaps".
# Returns the elements in that XI.
best_xi <- function(element, pos, points, started) {
  top <- function(p, n) {
    i <- which(pos == p)
    i[order(-points[i], -started[i])][seq_len(min(n, length(i)))]
  }

  formations <- expand_grid(d = 3:5, m = 2:5, f = 1:3) %>% filter(d + m + f == 10)
  options <- pmap(formations, function(d, m, f) {
    c(top("GKP", 1), top("DEF", d), top("MID", m), top("FWD", f))
  })

  element[options[[which.max(map_dbl(options, ~ sum(points[.x])))]]]
}

# Metrics -----------------------------------------------------------------------

build_metrics <- function() {

  managers <- read_cached(path(raw_dir, "standings.json"))$results %>%
    as_tibble() %>%
    transmute(entry, manager = clean_name(player_name), team = entry_name)

  # Puts the manager and team name at the front of a per-manager table
  add_names <- function(df) {
    managers %>%
      right_join(df, by = "entry") %>%
      arrange(entry, gw)
  }

  # Player names, so detail tables show "Salah" rather than an ID, plus
  # position (GKP/DEF/MID/FWD) and club for the gameweek lineups
  bootstrap <- read_cached(path(raw_dir, "bootstrap.json"))
  players <- bootstrap$elements %>%
    as_tibble() %>%
    left_join(bootstrap$teams %>% select(team = id, club = short_name),
              by = "team") %>%
    left_join(bootstrap$element_types %>% select(element_type = id, pos = singular_name_short),
              by = "element_type") %>%
    transmute(element = id, player = web_name, pos, club)

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

  # GW score = live player points x FPL's pick multiplier. FPL's stored
  # entry_history points lag during a live GW (they sat at 0 while players
  # were scoring); for finished GWs the two are identical (checked GW1-7)
  gw_info <- gw_info %>%
    select(-gw_points) %>%
    left_join(squad %>%
                group_by(gw, entry) %>%
                summarise(gw_points = sum(points * pick_multiplier), .groups = "drop"),
              by = c("gw", "entry"))

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
    left_join(players %>% select(element_in = element, player_in = player),
              by = "element_in") %>%
    left_join(players %>% select(element_out = element, player_out = player),
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
  # Only players who ended up on the pitch: FPL's own multiplier is 0 for the
  # bench after auto-subs (and nobody is benched in a Bench Boost week).
  # Counts are unmultiplied; points lost apply the captain multiplier.
  # Kept as a row per manager per GW, so GWs with no cards still show 0
  gw_cards <- squad %>%
    mutate(on_pitch = pick_multiplier > 0) %>%
    group_by(gw, entry) %>%
    summarise(
      yellow_cards     = sum(yellow_cards[on_pitch]),
      red_cards        = sum(red_cards[on_pitch]),
      card_points_lost = sum(card_points[on_pitch] * multiplier[on_pitch]),
      .groups = "drop"
    )

  card_detail <- squad %>%
    filter(pick_multiplier > 0, yellow_cards > 0 | red_cards > 0) %>%
    transmute(entry, gw, player, yellow_cards, red_cards, multiplier,
              card_points_lost = card_points * multiplier)

  # 3. Missed points ----------------------------------------------------------
  # Bench gap + captain gap.
  # Bench gap = best legal XI's points - the XI that actually counted (after
  # auto-subs), raw points with no captain multiplier. So a bench player only
  # counts if he could legally have replaced a lower-scoring starter. Zero
  # in Bench Boost weeks. bench_in / bench_out name the swaps.
  # Captain gap = (best player - armband wearer) x the extra multiplier
  bench_gap <- squad %>%
    mutate(started = pick_multiplier > 0) %>%
    group_by(gw, entry) %>%
    group_modify(function(d, key) {
      best <- d$element %in% best_xi(d$element, d$pos, d$points, d$started)
      swap <- function(rows) {
        rows <- rows[order(-d$points[rows])]
        paste(paste(d$player[rows], d$points[rows]), collapse = ", ")
      }
      tibble(
        bench_gain = sum(d$points[best]) - sum(d$points[d$started]),
        bench_in   = swap(which(best & !d$started)),
        bench_out  = swap(which(!best & d$started))
      )
    }) %>%
    ungroup()

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
    left_join(bench_gap, by = c("gw", "entry")) %>%
    mutate(
      bench_points  = if_else(chip %in% "bboost", 0, bench_gain),
      across(c(bench_in, bench_out), ~ if_else(chip %in% "bboost", "", .x)),
      captain_gap   = (best_points - armband_points) * (cap_mult - 1),
      missed_points = bench_points + captain_gap
    ) %>%
    select(-bench_gain)

  # 4. DFYTer Index -----------------------------------------------------------
  # Each player's score that GW = share of the OTHER managers in the league
  # (those with a team that GW) who also have him in their 15. So a player
  # only you own scores 0 and one everybody owns scores 1. A manager's GW
  # score is the average over their 15 players; the season score averages
  # the GWs. 0 = nothing in common with anyone, 1 = identical to everyone
  ownership <- picks %>%
    group_by(gw) %>%
    mutate(league_size = n_distinct(entry)) %>%
    group_by(gw, element) %>%
    mutate(owners    = n_distinct(entry),
           ownership = (owners - 1) / (league_size - 1)) %>%
    ungroup() %>%
    left_join(players, by = "element")

  gw_dfyter <- ownership %>%
    group_by(gw, entry) %>%
    summarise(
      dfyter         = mean(ownership),
      unique_players = paste(sort(player[owners == 1]), collapse = ", "),
      .groups = "drop"
    )

  # 5. Pints ------------------------------------------------------------------
  # Lose a gameweek (lowest score in the league, after hits) and you down a
  # pint. Joint-bottom: everyone tied drinks. The current (latest started)
  # gameweek isn't counted until the next one begins
  latest_gw <- max(gw_info$gw)

  gw_pints <- gw_info %>%
    filter(gw < latest_gw) %>%
    mutate(net_points = gw_points - transfer_cost) %>%
    left_join(managers %>% select(entry, manager), by = "entry") %>%
    group_by(gw) %>%
    filter(net_points == min(net_points)) %>%
    mutate(joint_with = map_chr(manager, ~ paste(setdiff(manager, .x), collapse = ", "))) %>%
    ungroup() %>%
    select(gw, entry, net_points, joint_with)

  # League position after each GW ----------------------------------------------
  # For the leaderboard (rank, movement, total) and the form sparkline.
  # Running total = cumulative (GW score - hits), using the live GW score
  # above, so it's live during a GW (FPL's stored total_points lags too).
  # Matches FPL's totals exactly for finished GWs (checked GW1-7). Ranked
  # within the league after each GW, ties sharing a position
  league_history <- gw_info %>%
    arrange(entry, gw) %>%
    group_by(entry) %>%
    mutate(total = cumsum(gw_points - transfer_cost)) %>%
    group_by(gw) %>%
    mutate(league_rank = min_rank(desc(total))) %>%
    ungroup() %>%
    select(entry, gw, total, league_rank)

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
    left_join(
      gw_dfyter %>%
        group_by(entry) %>%
        summarise(dfyter = mean(dfyter)),
      by = "entry"
    ) %>%
    left_join(gw_pints %>% count(entry, name = "pints"), by = "entry") %>%
    mutate(across(where(is.numeric) & !entry, ~ replace_na(.x, 0)))

  list(
    managers        = managers,
    season_summary  = season_summary,
    gw_transfers    = add_names(gw_transfers),
    transfer_detail = add_names(transfer_detail),
    gw_cards        = add_names(gw_cards),
    card_detail     = add_names(card_detail),
    gw_missed       = add_names(gw_missed),
    gw_dfyter       = add_names(gw_dfyter),
    gw_pints        = add_names(gw_pints),
    chips_played    = add_names(chips_played),
    league_history  = league_history,
    # For the Gameweek tab: each manager's GW score and their 15 picks.
    # pick_multiplier is FPL's own (0 = bench after auto-subs, 2 = captain,
    # 3 = TC), so points x pick_multiplier summed over the 15 = gw_points
    gw_points       = add_names(gw_info %>%
                                  select(gw, entry, chip, gw_points, transfer_cost)),
    squads          = add_names(squad %>%
                                  select(gw, entry, position, element, player, pos,
                                         club, is_captain, is_vice_captain,
                                         pick_multiplier, minutes, points))
  )
}

# Run -----------------------------------------------------------------------------

metrics <- build_metrics()

dir_create(out_dir)
walk(
  c("season_summary", "gw_transfers", "transfer_detail", "gw_cards",
    "card_detail", "gw_missed", "gw_dfyter", "gw_pints", "chips_played"),
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