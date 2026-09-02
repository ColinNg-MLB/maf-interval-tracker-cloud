#!/usr/bin/env bash
# Prints THIS run's rank among today's still-in-flight slot-relay runs, on stdout.
#   0 = I am the oldest, so I own the ladder and keep the exact-minute slot.
#   N = N older relay runs are still walking the same ladder ahead of me.
# Diagnostics go to stderr so the caller can capture the rank with $(...).
#
# ============================================================================
# WHY THIS EXISTS — the 1 Sep 2026 duplicate-alert incident.
#
# slot-relay.yml has THREE morning crons plus workflow_dispatch, and nothing
# stopped two of those runs coexisting. Every relay run walks the WHOLE ladder,
# so on Tue 1 Sep 2026 (LLV R5 close day) two of them --
#   33460418347  workflow_dispatch  09:52 SGT
#   33484655044  schedule           15:57 SGT
# -- both ran eve1 16:01-20:01 and eve2 20:01-23:01, and both sent Telegram for
# BOTH brands at rungs 1745, 2000, 2130 and 2300. Colin got two identical
# messages per rung from 17:46 onward.
#
# --skip-if-filled could not catch it. That guard reads the row, then writes;
# with two runs on the same rung in the same second, both read "not filled" and
# both alert. The two sends landed 0.8-2.6s apart. The workflow header used to
# claim "It cannot double-write and it cannot double-alert" -- that was false.
#
# THE FIX reuses the safety property the sibling workflow already depends on:
# a second runner must arrive AFTER the first, never alongside it. (Same reason
# interval-tracker.yml's sweeper crons fire ~22 min PAST each rung and must never
# be "tidied" to fire before it.) Rank 0 keeps the exact minute; rank N waits
# N * RELAY_LAG_SEC past the rung, by which time the owner's fill is on the sheet
# and tracker.js --skip-if-filled exits silently. No duplicate, no lost rung.
#
# WARNING: THIS FAILS OPEN ON PURPOSE -- DO NOT "HARDEN" IT.
# Any error, any timeout, any unparseable response, any doubt => rank 0 => send.
# A duplicate alert is an annoyance Colin can read past. A silent round-close
# night is the failure this repo keeps getting bitten by: the 10 Aug 2026 lost
# day (all 8 rungs skipped on a stale guard) and the 31 Aug 2026 quiet phone.
# Ranking is an optimisation on top of delivery, never a gate in front of it.
# ============================================================================

set -u

fail_open() { echo 0; exit 0; }

[ -n "${GITHUB_TOKEN:-}" ]      || fail_open
[ -n "${GITHUB_REPOSITORY:-}" ] || fail_open
[ -n "${GITHUB_RUN_ID:-}" ]     || fail_open

# TZ=Asia/Singapore is set workflow-wide, so `date` here is already SGT wall clock.
today=$(date +%F) || fail_open

# RELAY_RANK_FIXTURE is a TEST SEAM: a file holding a captured /runs response, used to
# exercise THIS script (not a copy of its logic) against real recorded incidents.
# See relay-rank.test.sh. Never set in the workflow.
if [ -n "${RELAY_RANK_FIXTURE:-}" ] && [ -f "${RELAY_RANK_FIXTURE}" ]; then
  json=$(cat "${RELAY_RANK_FIXTURE}")
else
  json=$(curl -sS -m 25 \
    -H "Authorization: Bearer ${GITHUB_TOKEN}" \
    -H "Accept: application/vnd.github+json" \
    -H "X-GitHub-Api-Version: 2022-11-28" \
    "https://api.github.com/repos/${GITHUB_REPOSITORY}/actions/workflows/slot-relay.yml/runs?per_page=50" \
    2>/dev/null)
fi

[ -n "${json:-}" ] || fail_open

rank=$(printf '%s' "$json" | RELAY_TODAY="$today" RELAY_ME="$GITHUB_RUN_ID" node -e '
try {
  const runs = (JSON.parse(require("fs").readFileSync(0, "utf8")).workflow_runs) || [];
  const me = Number(process.env.RELAY_ME);
  if (!Number.isFinite(me) || me <= 0) { console.log("0"); process.exit(0); }
  // Anything not yet concluded is a potential parallel walker. GitHub has used
  // several names for "finished"; treat every terminal state as done and every
  // other state (queued, in_progress, waiting, pending, requested) as live.
  const DONE = new Set(["completed", "cancelled", "failure", "success", "skipped",
                        "stale", "timed_out", "neutral", "action_required"]);
  const sgtDate = (iso) =>
    new Date(new Date(iso).getTime() + 8 * 3600e3).toISOString().slice(0, 10);
  const ahead = runs.filter((r) =>
    Number(r.id) < me &&
    !DONE.has(String(r.status || "").toLowerCase()) &&
    sgtDate(r.created_at) === process.env.RELAY_TODAY);
  for (const r of ahead) {
    console.error("  ahead of me: run " + r.id + " (" + r.event + ", " + r.status +
                  ", created " + r.created_at + ")");
  }
  console.log(String(ahead.length));
} catch (e) {
  console.error("  rank check failed (" + e.message + ") -- failing open to rank 0");
  console.log("0");
}
')

rank=$(printf '%s' "${rank:-}" | tr -dc '0-9')
[ -n "$rank" ] || fail_open
echo "$rank"
