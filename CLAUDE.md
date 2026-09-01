# MAF26 Interval Tracker — Cloud Backup (PUBLIC repo)

Backup runner for `shared/maf-interval-tracker/`. The **laptop** (Windows Task Scheduler)
is primary and punctual; this covers slots the laptop misses.
Repo: `ColinNg-MLB/maf-interval-tracker-cloud` — **PUBLIC on purpose.**

**Covers ALL 8 slots since 9 Aug 2026** (commit b24c87a). It was evenings-only
(2000/2130/2300) on the assumption that the laptop was awake through the working day —
wrong. A laptop that is merely ASLEEP loses its triggers exactly like one that is off:
Colin's slept Sat 8 Aug 22:11 → Sun 9 Aug 15:26 (17h 15m), so LLV's 1030/1145/1400 rungs
never ran on an armed day, and Windows `StartWhenAvailable` then ran the missed job at
15:32 — 28 min from the 1600 rung, inside the ±35 tolerance — so it filled the **4pm** row
and alerted "2pm to 4pm" at half past three. Cron→slot map:

| Cron (UTC) | Starts (SGT) | Target slot | Idle |
|---|---|---|---|
| `50 23 * * *` | 07:50 | 1030 | 161 min |
| `5 1 * * *` | 09:05 | 1145 | 161 min |
| `20 3 * * *` | 11:20 | 1400 | 161 min |
| `20 5 * * *` | 13:20 | 1600 | 161 min |
| `5 7 * * *` | 15:05 | 1745 | 161 min |
| `30 9 * * *` | 17:30 | 2000 | 151 min |
| `0 11 * * *` | 19:00 | 2130 | 151 min |
| `30 12 * * *` | 20:30 | 2300 | 151 min |

**Every cron MUST have a matching arm in the `Map schedule -> target slot` case block.**
A cron with no arm falls through to the manual input, which is blank on a scheduled run —
that means "nearest slot to now", and after a lagged start that is the WRONG rung, filled
silently. Minutes are deliberately off the hour (`:00` UTC is GitHub's busiest, laggiest
slot). Idle stays under `WAIT_CAP_MIN` (210 min) with room for the 30–90 min cron lag.
**A `workflow_dispatch` cannot test these arms** — it sends an empty `github.event.schedule`,
so only a real scheduled fire exercises them; verify the mapping statically instead.

## Test-dispatching this workflow (read before picking a `target`)
- **Leave `target` BLANK for a smoke test.** Blank means "nearest slot to now", which skips
  the idle loop entirely and finishes in ~30s — the fast way to prove a code change runs in
  CI. Pair it with `apply=false`.
- **A `target` more than `WAIT_CAP_MIN` (210 min) from now ABORTS BY DESIGN** and the run goes
  **red**: `FATAL: target 2300 is 703 min away (> 210 cap) — cron fired far too early`. That
  guard exists so a wildly-early cron never idles for hours. It also means a careless test
  dispatch leaves a failure in the run history that looks like a real outage.
  **Run `31454984084` (11 Aug 2026, 03:18 UTC, red) is exactly that — a mis-targeted manual
  test, not a fault.** Before diagnosing any red run here, check its `event`: a
  `workflow_dispatch` failure is usually someone testing.
- **A dispatch still cannot exercise the cron→target arms** (empty `github.event.schedule`);
  only a real scheduled fire does. Verify that mapping statically.

## `--skip-if-filled` needs the fill-date stamp — never weaken it back to "is the cell empty?"
This runner passes `--skip-if-filled` so it no-ops whenever the laptop already wrote the
slot. Until 11 Aug 2026 that check only asked whether `I<row>` was non-empty, which cannot
tell a laptop fill from leftovers. **Mon 10 Aug 2026: MLB armed (R4 close 12 Aug), laptop off
all day, all 8 slots fired, all 8 exited with "already filled (I2=33.99) — the laptop run got
it" — those were Wed 5 Aug's numbers.** Zero fills, zero Telegram, on an armed day, and
self-reinforcing: the skip at the 1030 rung meant the day-clear never ran, so every later
rung looked filled too. The engine now stamps which DAY it last filled (Sheets developer
metadata on the tab) and skips only when the stamp says today; a missing stamp never skips.
Verified in CI dry run 31455012179 — both brands read the stamp with the runner's own
`GOOGLE_*` secrets, no extra scope needed. Full detail: `shared/maf-interval-tracker/CLAUDE.md`.

## Why public (do not move to the private automations repo)
Each run **idles ~2.5h** waiting for the exact slot minute (GitHub cron fires 30-90+ min
late, so we start early and sleep to the target). Idle time is **billed** — on a private
repo that is ~150 min/run and would blow the 2,000-min account cap in one evening. Public
repos get **unlimited free Actions minutes**, so the idle-wait is free. This is the
sanctioned minute-cap workaround (see main CLAUDE.md "GitHub Actions minute budget").
- Public = the CODE and the sheet ID / ad-account ID are visible (already non-secret by
  convention). All tokens are **encrypted repo secrets** — not readable even on a public
  repo. No `pull_request` trigger, so fork PRs can never access the secrets.

## Files (COPY of the laptop engine — keep in sync)
`tracker.js` + `render-shot.py` + `round-schedule.json` + `run-dates.json` are copied from
`shared/maf-interval-tracker/`. **Any edit to the engine must be applied to BOTH**
(laptop copy + this copy, then push). Two copies is an accepted trade-off for a seasonal
tool (Colin, 21 Jul 2026). `render-shot.py` (since 28 Jul 2026) renders the two Telegram
screenshot attachments (ladder table + decision block) from the Sheets range-PDF export;
the workflow pip-installs `pypdfium2 pillow` for it.

## How it runs
- 3 crons, each ~2.5h before its slot; a step maps the cron string → `--target=HHMM`:
  `30 9 * * *`→2000, `0 11 * * *`→2130, `30 12 * * *`→2300 (SGT).
- **BOTH brands in ONE job, SEQUENTIALLY (MLB then LLV) since 3 Aug 2026.** Each brand
  proceeds only if today is armed for IT, so a round-close day for one brand is a fast no-op
  for the other. Both brands' secrets sit in the job `env` under `MLB_*` / `LLV_*` names and
  the run step exports the right pair per brand — **the repo secret names themselves did not
  change** (`META_ACCESS_TOKEN`/`WC_*` for MLB, `LLV_META_ACCESS_TOKEN`/`LLV_WOOCOMMERCE_*`
  for LLV).
  - **Was a parallel 2-brand matrix 24 Jul – 3 Aug 2026.** Replaced because the two jobs hit
    the same slot minute and their Telegram sends interleaved (MLB text, LLV text, MLB
    photos, LLV photos) — screenshots take ~10s longer to build than text.
  - **`max-parallel: 1` is NOT the fix — don't "simplify" back to it.** LLV's job would only
    start after MLB's job *finished*, and MLB's job contains the ~2.5h idle wait, so LLV
    would wake long after its slot. Both brands must share ONE wait: MLB sleeps to slot+1min,
    fills and sends; LLV then hits the `waitMin <= 0` branch and proceeds immediately.
  - The run step uses `set +e` and rolls up both exit codes, so **LLV still runs when MLB
    fails** and the job still reports red if either brand failed.
- Dispatch inputs: `target` (slot HHMM), `apply` (default false = dry), `force`
  (default false; ignores the run-dates gate — testing only).
- `tracker.js --target=HHMM --skip-if-filled --apply`: sleeps until slot+1min (cap 3.5h via
  `WAIT_CAP_MIN`), then — if the laptop hasn't already filled col I for that row — pulls
  Meta spend + WC-analytics sales + live budgets, writes the row, sends Telegram. If the
  laptop already filled it, exits silently (no double write, no double alert).
- **Arming gate = fast no-op on non-round days (checked BEFORE the sleep).** Since 3 Aug 2026
  the armed days are derived from `round-schedule.json` (each round's CLOSE + the 2 days
  before it), unioned with any manual `run-dates.json` entries. Both files live here as well
  as on the laptop — **a round-date change must be pushed to this copy too**, or the cloud
  backup silently skips the slots the laptop was covering. Full rationale + the
  3 Aug 2026 silent-no-op incident: `shared/maf-interval-tracker/CLAUDE.md`.
- Manual test: Actions → Run workflow → `target=<slot>`, `apply=false` (dry). Data lands
  ~1-2 min after the slot; console shows the sleep countdown.
  **Pick a target LESS THAN `WAIT_CAP_MIN` (210 min) away or the run fails by design** —
  `FATAL: target X is N min away (> 210 cap)` is the anti-runaway guard doing its job, not a
  bug (3 Aug 2026: dispatched `target=2000` at 11:03 SGT, 538 min out, and read the red X as
  a regression for a moment). The gate/auth steps still run BEFORE the abort, so a
  deliberately-capped dispatch is a valid cheap smoke test of everything up to the sleep —
  just say that is what it proved, and don't claim the fill path was exercised.

## Secrets (set via `gh secret set`)
MLB: `META_ACCESS_TOKEN`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`.
LLV (added 24 Jul 2026 from `llv/.env`): `LLV_META_ACCESS_TOKEN`,
`LLV_WOOCOMMERCE_CONSUMER_KEY`, `LLV_WOOCOMMERCE_CONSUMER_SECRET`.
Shared: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
(digitalmarketing@ trio), plus `TELEGRAM_BOT_TOKEN` + `TELEGRAM_CHAT_ID` (set 28 Jul 2026
— the "Last Day Tracker" bot, `@last_day_tracker_bot`, one bot for both brands; local copy
of the creds in `~/.telegram.env`; chat id = the "Last Day Tracker" GROUP -5434698446 with
Colin + Kien + Shannon, switched from Colin's DM same day). If the Telegram secrets are ever missing the
cloud still fills the sheet, it just sends no alert (graceful skip).

## Teardown (end of MAF26 season)
Disable/delete **both** workflows with the other MAF jobs. Or just clear `run-dates.json` —
the gate makes every run a no-op. Consider archiving the public repo at season end.

---

## `slot-relay.yml` — the second workflow, added 1 Sep 2026

**Read this before "tidying" either workflow. There are now TWO, and they are not duplicates.**

`interval-tracker.yml` asks GitHub to be **punctual** — one cron per rung, starting ~2.7h
early, idling to the exact minute. That is the right design while GitHub's scheduler is
within ~90 min. It stopped being within ~90 min.

`slot-relay.yml` asks GitHub only to **start once**, any time in the morning, and then walks
itself down the ladder. A GitHub *job* is capped at 6h; a *run* made of chained jobs is not.
So `hop → day → eve1 → eve2` each wait for their own start time (capped at 5h per job) and
fill their share of the rungs. Lag tolerance goes from ~50 min to **~14 hours**.

### The measurement that forced it (both repos — this is account-wide, not a workflow bug)

| Date (UTC) | Scheduled-run lag on `ColinNg-MLB` |
|---|---|
| 22–26 Aug 2026 | ~20–75 min — everything worked, 8/8 rungs daily |
| 27 Aug 2026 | ~3h30m – 10h |
| 28 Aug 2026 | ~8h – 11h40m |
| 29–31 Aug 2026 | ~2h – 8h, several crons dropped outright |

Verified on the **private `automations` repo too** (`shopee-darkhours-watch`, cron 01:37 UTC:
02:38→02:50 on 22–26 Aug, then 11:58 on 27 Aug and 13:19 on 28 Aug). Nothing in our config
changed at that boundary. **Do not go looking for a cause in this repo — there isn't one.**

20–29 Aug contained no armed round-close days, so the degradation was invisible until it hit
Sun 30 Aug (runs dropped) and Mon 31 Aug: every evening cron landed **after SGT midnight**,
its target rolled to the next day, and `WAIT_CAP_MIN` correctly aborted it. Both brands'
ladders stopped at 1745 and Colin's phone went quiet after 17:45 on an armed night.

### Rules

- **Do NOT add a `concurrency:` group to `slot-relay.yml`.** Its runs idle for hours on
  purpose; a shared group makes the second cron of the day queue behind the first and wake
  up around midnight.
- **Do NOT delete `interval-tracker.yml`.** It is still the punctual path when GitHub is
  healthy, and `--skip-if-filled` makes the two harmless to each other — first one to a rung
  writes and alerts, the rest exit silently.
- **Do NOT raise `WAIT_CAP_MIN`.** The rung lists in each job are sized so no target is ever
  more than ~135 min out once the previous rung has fired. The cap is what stops a 22h idle.
- The rung lists live in `.github/run-rungs.sh` (`SLOTS` env per job). If a ladder TIME
  changes, update `START_AT`/`SLOTS` here, the sibling workflow's crons and case arms, the
  laptop's Task Scheduler triggers, and column A of both brands' tabs — all four.
- A relay job that arrives after its rung fills it **as of now** and says so. Honest late
  data beats a blank row; that is the sibling's existing behaviour, unchanged.
