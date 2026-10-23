# Helper functions for talking to the FPL API and caching responses.
# Sourced by the ingest script, not run on its own.

suppressPackageStartupMessages({
  library(httr2)
  library(jsonlite)
  library(dplyr)
  library(purrr)
  library(fs)
  library(magrittr)
  library(tibble)
  library(tidyr)
  library(readr)
  library(stringr)
})

fpl_base_url <- "https://fantasy.premierleague.com/api/"

# Keeps a count of API calls made in this run, so we can see caching working
.fpl_env <- new.env()
.fpl_env$calls <- 0

# Fetch an endpoint and return the raw JSON text.
# Pauses briefly before each call to stay polite to the API.
fpl_get_text <- function(path, pause = 0.3) {
  Sys.sleep(pause)

  resp <- request(paste0(fpl_base_url, path)) %>%
    req_user_agent("fpl-dashboard (personal project)") %>%
    req_timeout(30) %>%
    req_retry(max_tries = 3) %>%
    req_perform()

  .fpl_env$calls <- .fpl_env$calls + 1

  # While FPL processes a gameweek it returns an HTML holding page, not JSON
  if (!grepl("json", resp_content_type(resp))) {
    stop("FPL API did not return JSON for ", path,
         " (the game may be updating)", call. = FALSE)
  }

  resp_body_string(resp)
}

# Write to a temporary file first, then rename, so a run that fails midway
# never leaves a half-written file in the cache
write_text_atomic <- function(text, file) {
  dir_create(path_dir(file))
  tmp <- paste0(file, ".tmp")
  writeLines(text, tmp, useBytes = TRUE)
  file_move(tmp, file)
}

# Fetch an endpoint into a cache file.
# frozen = TRUE means the data can no longer change (a finished, checked
# gameweek), so if the file already exists we skip the API call entirely.
fetch_to_cache <- function(path, file, frozen = FALSE) {
  if (frozen && file_exists(file)) {
    return(invisible(FALSE))
  }
  write_text_atomic(fpl_get_text(path), file)
  invisible(TRUE)
}

# Read a cached file back into R (data frames where possible)
read_cached <- function(file) {
  fromJSON(file)
}

# League standings, following pagination (50 managers per page)
fetch_standings <- function(league_id) {
  page <- 1
  pages <- list()

  repeat {
    parsed <- fpl_get_text(paste0(
      "leagues-classic/", league_id, "/standings/?page_standings=", page
    )) %>%
      fromJSON()

    pages[[page]] <- parsed$standings$results
    if (!isTRUE(parsed$standings$has_next)) break
    page <- page + 1
  }

  list(
    league  = parsed$league,
    results = bind_rows(pages)
  )
}