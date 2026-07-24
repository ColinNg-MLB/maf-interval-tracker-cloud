# MAF26 Interval Tracker — Cloud Backup (PUBLIC repo)

Backup runner for `shared/maf-interval-tracker/`. The **laptop** (Windows Task Scheduler)
is primary and punctual; this covers slots the laptop misses (Colin's laptop is off in the
evenings). Repo: `ColinNg-MLB/maf-interval-tracker-cloud` — **PUBLIC on purpose.**

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
`tracker.js` + `run-dates.json` are copied from `shared/maf-interval-tracker/`. **Any edit
to the engine must be applied to BOTH** (laptop copy + this copy, then push). Two copies is
an accepted trade-off for a seasonal tool (Colin, 21 Jul 2026).

## How it runs
- 3 crons, each ~2.5h before its slot; a step maps the cron string → `--target=HHMM`:
  `30 9 * * *`→2000, `0 11 * * *`→2130, `30 12 * * *`→2300 (SGT).
- **2-brand matrix since 24 Jul 2026 (MLB + LLV):** every cron/dispatch runs BOTH brands as
  parallel jobs; each brand proceeds only if today is in ITS list in `run-dates.json`
  (per-brand format `{"MLB":[...],"LLV":[...]}`), so a round-close day for one brand is a
  fast no-op for the other. Per-brand secrets are mapped via `secrets[matrix.*]`.
- Dispatch inputs: `target` (slot HHMM), `apply` (default false = dry), `force`
  (default false; ignores the run-dates gate — testing only).
- `tracker.js --target=HHMM --skip-if-filled --apply`: sleeps until slot+1min (cap 3.5h via
  `WAIT_CAP_MIN`), then — if the laptop hasn't already filled col I for that row — pulls
  Meta spend + WC-analytics sales + live budgets, writes the row, sends Telegram. If the
  laptop already filled it, exits silently (no double write, no double alert).
- `run-dates.json` gate = fast no-op on non-round days (checked before the sleep).
- Manual test: Actions → Run workflow → `target=2000`, `apply=false` (dry). Data lands
  ~1-2 min after the slot; console shows the sleep countdown.

## Secrets (set via `gh secret set`)
MLB: `META_ACCESS_TOKEN`, `WC_CONSUMER_KEY`, `WC_CONSUMER_SECRET`.
LLV (added 24 Jul 2026 from `llv/.env`): `LLV_META_ACCESS_TOKEN`,
`LLV_WOOCOMMERCE_CONSUMER_KEY`, `LLV_WOOCOMMERCE_CONSUMER_SECRET`.
Shared: `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REFRESH_TOKEN`
(digitalmarketing@ trio), and — once the bot exists — `TELEGRAM_BOT_TOKEN`,
`TELEGRAM_CHAT_ID`. Until the Telegram secrets are added the cloud fills the sheet but
sends no alert (graceful skip).

## Teardown (end of MAF26 season)
Disable/delete this workflow with the other MAF jobs. Or just clear `run-dates.json` — the
gate makes every run a no-op. Consider archiving the public repo at season end.
