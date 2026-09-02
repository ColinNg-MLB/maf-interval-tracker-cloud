#!/usr/bin/env bash
# Tests .github/relay-rank.sh — the real script, via its RELAY_RANK_FIXTURE seam.
# Read-only, no network, no writes. Run: bash .github/relay-rank.test.sh
#
# Case 1 is the ACTUAL 1 Sep 2026 incident, replayed from the real run ids:
#   33460418347  workflow_dispatch 09:52 SGT  (the older walker)
#   33484655044  schedule          15:57 SGT  (the one that duplicated every alert)
# Both were in_progress together all evening. Under the fix the younger one must
# rank 1 and stand behind; the older must rank 0 and keep the exact minute.
#
# The FAIL-OPEN cases matter as much as the detection ones: every degenerate input
# must yield 0, because a wrong "yield" loses a round-close night silently.

set -u
cd "$(dirname "${BASH_SOURCE[0]}")/.." || exit 1

FIX=$(mktemp -d)
trap 'rm -rf "$FIX"' EXIT

pass=0; fail=0
check() { # check <name> <expected> <actual>
  if [ "$2" = "$3" ]; then printf '  PASS  %-58s rank=%s\n' "$1" "$3"; pass=$((pass+1));
  else printf '  FAIL  %-58s expected %s, got %s\n' "$1" "$2" "$3"; fail=$((fail+1)); fi
}

# Today, in the same SGT date form the script derives with `date +%F`.
TODAY=$(date +%F)
Y=$(date -d 'yesterday' +%F 2>/dev/null || date +%F)

# created_at is UTC in the API; the script converts to SGT. Use 04:00Z = 12:00 SGT
# so the date does not straddle midnight either way.
mk() { # mk <file> <json-array-body>
  printf '{"total_count":9,"workflow_runs":[%s]}' "$2" > "$FIX/$1"
}
run() { # run <id> <status> <date> <event>
  printf '{"id":%s,"status":"%s","conclusion":null,"event":"%s","created_at":"%sT04:00:00Z"}' \
    "$1" "$2" "$4" "$3"
}

# ---- Case 1: the real 1 Sep 2026 incident -----------------------------------
mk inc.json "$(run 33460418347 in_progress "$TODAY" workflow_dispatch),$(run 33484655044 in_progress "$TODAY" schedule)"
r=$(RELAY_RANK_FIXTURE="$FIX/inc.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=33484655044 bash .github/relay-rank.sh 2>/dev/null)
check "1 Sep incident: the 15:57 schedule run stands behind" 1 "$r"

r=$(RELAY_RANK_FIXTURE="$FIX/inc.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=33460418347 bash .github/relay-rank.sh 2>/dev/null)
check "1 Sep incident: the 09:52 dispatch owns the ladder" 0 "$r"

# ---- Case 2: takeover — the owner has finished/died -------------------------
mk done.json "$(run 33460418347 completed "$TODAY" workflow_dispatch),$(run 33484655044 in_progress "$TODAY" schedule)"
r=$(RELAY_RANK_FIXTURE="$FIX/done.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=33484655044 bash .github/relay-rank.sh 2>/dev/null)
check "owner completed -> younger run takes over at full speed" 0 "$r"

# ---- Case 3: three crons all alive (the designed-for worst case) ------------
mk three.json "$(run 100 in_progress "$TODAY" schedule),$(run 200 in_progress "$TODAY" schedule),$(run 300 in_progress "$TODAY" schedule)"
for id in 100:0 200:1 300:2; do
  r=$(RELAY_RANK_FIXTURE="$FIX/three.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
      GITHUB_RUN_ID=${id%%:*} bash .github/relay-rank.sh 2>/dev/null)
  check "three live relay runs: run ${id%%:*} ranks ${id##*:}" "${id##*:}" "$r"
done

# ---- Case 4: yesterday's stuck run must NOT own today's ladder --------------
mk stale.json "$(run 100 in_progress "$Y" schedule),$(run 300 in_progress "$TODAY" schedule)"
r=$(RELAY_RANK_FIXTURE="$FIX/stale.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=300 bash .github/relay-rank.sh 2>/dev/null)
check "a run left over from yesterday is not today's owner" 0 "$r"

# ---- Case 5: I am the only run ----------------------------------------------
mk solo.json "$(run 300 in_progress "$TODAY" schedule)"
r=$(RELAY_RANK_FIXTURE="$FIX/solo.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=300 bash .github/relay-rank.sh 2>/dev/null)
check "sole relay run owns the ladder" 0 "$r"

# ---- Case 6: my own run absent from the page (API lag) ----------------------
mk absent.json "$(run 100 completed "$TODAY" schedule)"
r=$(RELAY_RANK_FIXTURE="$FIX/absent.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=999 bash .github/relay-rank.sh 2>/dev/null)
check "my run not yet listed, nothing live ahead" 0 "$r"

# ---- FAIL-OPEN cases: every one of these must be 0 -------------------------
printf '  ---- fail-open (a wrong yield loses a whole close night) ----\n'

printf 'not json at all' > "$FIX/garbage.json"
r=$(RELAY_RANK_FIXTURE="$FIX/garbage.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=300 bash .github/relay-rank.sh 2>/dev/null)
check "unparseable response fails open" 0 "$r"

printf '{"message":"Bad credentials"}' > "$FIX/err.json"
r=$(RELAY_RANK_FIXTURE="$FIX/err.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=300 bash .github/relay-rank.sh 2>/dev/null)
check "API error body fails open" 0 "$r"

printf '' > "$FIX/empty.json"
r=$(RELAY_RANK_FIXTURE="$FIX/empty.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=300 bash .github/relay-rank.sh 2>/dev/null)
check "empty response fails open" 0 "$r"

r=$(RELAY_RANK_FIXTURE="$FIX/inc.json" GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=33484655044 bash .github/relay-rank.sh 2>/dev/null)
check "no GITHUB_TOKEN fails open" 0 "$r"

r=$(RELAY_RANK_FIXTURE="$FIX/inc.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    bash .github/relay-rank.sh 2>/dev/null)
check "no GITHUB_RUN_ID fails open" 0 "$r"

r=$(RELAY_RANK_FIXTURE="$FIX/nope.json" GITHUB_TOKEN=x GITHUB_REPOSITORY=o/r \
    GITHUB_RUN_ID=300 bash .github/relay-rank.sh 2>/dev/null)
check "missing fixture -> real curl path, no network -> fails open" 0 "$r"

printf '\n  %d passed, %d failed\n' "$pass" "$fail"
[ "$fail" -eq 0 ] || exit 1
