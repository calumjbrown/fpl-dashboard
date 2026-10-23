library(httr2)
library(magrittr)

league_id <- Sys.getenv("LEAGUE_ID")
if (league_id == "") stop("LEAGUE_ID is not set")

fpl_get <- function(path) {
  request(paste0("https://fantasy.premierleague.com/api/", path)) %>%
    req_user_agent("fpl-dashboard (personal project)") %>%
    req_retry(max_tries = 3) %>%
    req_perform() %>%
    resp_body_json()
}

boot <- fpl_get("bootstrap-static/")
current_gw <- Filter(function(e) isTRUE(e$is_current), boot$events)

cat("Players:", length(boot$elements), "\n")
cat("Current GW:", if (length(current_gw) > 0) current_gw[[1]]$id else "none", "\n")

league <- fpl_get(paste0("leagues-classic/", league_id, "/standings/"))

cat("League:", league$league$name, "\n")
cat("Managers on page 1:", length(league$standings$results), "\n")
cat("More pages:", league$standings$has_next, "\n")
