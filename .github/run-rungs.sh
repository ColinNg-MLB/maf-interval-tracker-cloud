#!/usr/bin/env bash
# Shared by every job in slot-relay.yml.
#
# Waits until START_AT (SGT wall clock, capped at 5h so no job nears GitHub's 6h
# ceiling), then runs tracker.js once per rung in SLOTS, MLB fully before LLV.
#
# ORDER MATTERS: MLB text + MLB screenshots, then LLV text + LLV screenshots. Two
# parallel processes interleave their Telegram messages because the screenshots take
# ~10s longer to build than the text — Colin rejected exactly that on 3 Aug 2026.
#
# --skip-if-filled on every call: if the laptop or the sibling workflow already wrote
# that rung today, this exits silently.
#
# THAT GUARD IS NOT ENOUGH ON ITS OWN — 1 Sep 2026. It reads the row and then writes,
# so two relay runs arriving at the same rung in the same second both read "not filled"
# and both alert. Two runs (a 09:52 dispatch + a 15:57 schedule) walked the same ladder
# that day and Colin got two identical Telegram messages per rung from 17:46. Separation
# in TIME is what makes the guard work — which is why every rung below first asks
# relay-rank.sh whether an older relay run owns this ladder, and a non-owner deliberately
# arrives RELAY_LAG_SEC late so the owner's fill is already on the sheet. Same safety
# property as interval-tracker.yml's sweeper crons firing PAST their slot.
#
# tracker.js aborts if its --target is more than WAIT_CAP_MIN (210) away. The rung
# lists here are sized so that never happens: after the previous rung has fired, the
# next one is at most ~135 min out.
#
# LLV must run even if MLB fails, and a failed rung must not abandon the later rungs —
# hence `set +e` and the exit-code roll-up at the end.

set -u

ARGS="--skip-if-filled"
if [ "${APPLY:-false}" = "true" ]; then ARGS="$ARGS --apply"; fi

target=$(date -d "today $START_AT" +%s)
now=$(date +%s)
wait=$(( target - now ))
if [ "$wait" -gt 0 ]; then
  if [ "$wait" -gt 18000 ]; then wait=18000; fi
  echo "waiting ${wait}s for $START_AT SGT (now $(date '+%H:%M'))"
  sleep "$wait"
else
  echo "already past $START_AT SGT (now $(date '+%H:%M')) — filling the rungs as of now"
fi

set +e
rc_total=0

RELAY_LAG_SEC=${RELAY_LAG_SEC:-150}
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

for slot in $SLOTS; do
  # --- Am I the relay run that owns this ladder? (see relay-rank.sh) -------------
  # Re-asked per rung, not once per job, so that if the owner dies mid-evening my
  # rank drops to 0 and I take over the REMAINING rungs at full speed.
  rank=$(bash "$HERE/relay-rank.sh" 2>&1 | tail -1 | tr -dc '0-9')
  rank=${rank:-0}
  if [ "$rank" -gt 0 ]; then
    # Yield: arrive after the owner, never alongside it. tracker.js then sees the
    # target is past, proceeds immediately, finds the row filled TODAY and exits
    # silently. If the owner never filled it, I fill it and alert — coverage kept.
    offset=$(( 60 + rank * RELAY_LAG_SEC ))
    wake=$(( $(date -d "today ${slot:0:2}:${slot:2:2}" +%s) + offset ))
    w=$(( wake - $(date +%s) ))
    if [ "$w" -gt 18000 ]; then w=18000; fi
    if [ "$w" -le 0 ]; then
      # BOTH runs are already past this rung (heavy GitHub lag). Standing off the
      # SLOT time buys nothing then, so stand off NOW instead — otherwise the two
      # late runs call tracker.js in the same second and the 1 Sep race is back.
      w=$(( rank * RELAY_LAG_SEC ))
      echo "rank $rank — an older relay run owns this ladder and $slot is already past; standing off ${w}s from now so it fills first"
    else
      echo "rank $rank — an older relay run owns this ladder; waiting ${w}s (to $(date -d "@$wake" '+%H:%M:%S') SGT) so it alerts on $slot first"
    fi
    [ "$w" -gt 0 ] && sleep "$w"
  fi

  for brand in MLB LLV; do
    key_meta="${brand}_META_ACCESS_TOKEN"
    key_ck="${brand}_WC_CONSUMER_KEY"
    key_cs="${brand}_WC_CONSUMER_SECRET"
    echo "::group::$brand $slot"
    BRAND="$brand" \
      META_ACCESS_TOKEN="${!key_meta}" \
      WC_CONSUMER_KEY="${!key_ck}" \
      WC_CONSUMER_SECRET="${!key_cs}" \
      node tracker.js $ARGS --target="$slot"
    rc=$?
    echo "::endgroup::"
    echo "$brand $slot exit=$rc"
    [ $rc -ne 0 ] && rc_total=1
  done
done

echo "--- rungs done: $SLOTS (roll-up exit $rc_total) ---"
exit $rc_total
