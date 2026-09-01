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
# that rung today, this exits silently. No double write, no double alert.
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

for slot in $SLOTS; do
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
