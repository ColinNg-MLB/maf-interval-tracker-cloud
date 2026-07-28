/**
 * MAF26 Round-Close Interval Tracker  (SHARED engine, MLB + LLV)
 * ------------------------------------------------------------------------
 * On the last 3 days of a promo round (Colin's rule since 24 Jul 2026: 2 days
 * before, 1 day before, last day), fills the brand's "moving average" tab
 * at the interval times listed in column A (1030/1145/1400/1600/1745/2000/2130/2300):
 *   col I = TOTAL Meta MAF26 spend so far today (campaigns with "MAF26" in the name)
 *   col J = TOTAL WooCommerce sales so far today — refund-netted `wc-analytics` total_sales,
 *           i.e. the SAME number Colin's WooCommerce Analytics dashboard shows (a raw order-sum
 *           read $960 vs his $708 on day one; never "simplify" it back to a gross sum). Falls back
 *           to a raw sum ONLY if the analytics endpoint is unavailable, and says so in the log.
 *   col K = TOTAL paid-order count so far today (analytics orders_count)
 *   B17   = total daily budget of ALL active MAF26 campaigns (live from Meta)
 *   B18   = daily budget of the purchase-objective MAF26 campaign(s)
 * The sheet's own formulas (cols B-H, B19-B30) do all the decision math — this
 * script NEVER writes those cells. After writing, it reads the sheet back and
 * sends Colin a Telegram message ("last day tracker" bot): Overall totals (the slot
 * row's I:M cells) + the latest interval (B:F) + the decision block as text (B25
 * "new purchase amount" highlighted), followed by TWO screenshots — the ladder
 * table (A1:M<last time row>) and the decision block (label-anchored A..:B..+13) —
 * via the Sheets range-PDF export rendered by render-shot.py (pypdfium2 + Pillow).
 *
 * Timing: run by Windows Task Scheduler at the exact interval times (GitHub cron
 * is 30-90 min late — useless here). The script matches "now" to the nearest
 * column-A slot within ±35 min and aborts loudly if none matches.
 *
 * Only runs on dates listed in run-dates.json (so the daily triggers are inert
 * on non-round days and can never overwrite the tab). --force overrides.
 *
 * At the FIRST slot of the day (row 2) it clears I2:K16 first — yesterday's
 * numbers must not mix into a new day.
 *
 * Usage:
 *   BRAND=MLB node tracker.js                 -> dry-run, auto-match slot
 *   BRAND=MLB node tracker.js --slot=1600     -> dry-run, forced slot
 *   BRAND=MLB node tracker.js --apply         -> write + send Telegram
 *   --force = ignore run-dates.json  ·  --no-alert = fill sheet, skip Telegram
 *
 * Auth: Meta + WC creds from env or <brand>/.env; Google token from GOOGLE_* env
 * or the gws login; Telegram from env or ~/.telegram.env (TELEGRAM_BOT_TOKEN +
 * TELEGRAM_CHAT_ID — chat id is auto-discovered from getUpdates and saved back
 * if missing).
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

// ---- per-brand config (public identifiers only) ----
const BRANDS = {
  MLB: { sheetId: '1bGCYAnn2Cqtl10xIe6YKsseFYuhEbeIp8Cq3PHzBjG8', tab: 'moving average', gid: 1787608602, act: '521387868326577', store: 'https://mdmlingbakery.com' },
  LLV: { sheetId: '1Q5meBGm7jbw4abgzixEJBy9VvdBY7CnfOzYWqyTqquo', tab: 'daily moving average', gid: 163728980, act: '3055222664753411', store: 'https://www.lalevain.com' },
};
const BRAND = (process.env.BRAND || '').toUpperCase();
const CFG = BRANDS[BRAND];
if (!CFG) { console.error(`FATAL: set BRAND to one of: ${Object.keys(BRANDS).join(', ')} (got "${process.env.BRAND || ''}")`); process.exit(1); }
if (process.env.TAB_OVERRIDE) CFG.tab = process.env.TAB_OVERRIDE; // testing only — point at a copy of the tab
if (process.env.GID_OVERRIDE) CFG.gid = Number(process.env.GID_OVERRIDE); // pair with TAB_OVERRIDE — screenshots address the tab by gid

const CAMPAIGN_MATCH = process.env.CAMPAIGN_MATCH || 'MAF26';
const PAID_STATUSES = 'completed,processing';
const SGT_OFFSET_H = 8;
const GRAPH_VER = 'v21.0';
const SLOT_TOLERANCE_MIN = 35;

// ---- env: brand .env fallback (same pattern as shared/maf-budget) ----
for (const p of [path.join(__dirname, '..', '..', BRAND.toLowerCase(), '.env'), path.join(os.homedir(), '.telegram.env'), path.join(os.homedir(), '.digitalmarketing.env')]) {
  if (!fs.existsSync(p)) continue;
  for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '').trim();
  }
}
const META_TOKEN = process.env.META_ACCESS_TOKEN;
const ACT = (process.env.META_AD_ACCOUNT_ID || CFG.act).replace('act_', '');
const WC_URL = (process.env.WOOCOMMERCE_STORE_URL || CFG.store).replace(/\/$/, '');
const WC_KEY = process.env.WOOCOMMERCE_CONSUMER_KEY || process.env.WC_CONSUMER_KEY || '';
const WC_SECRET = process.env.WOOCOMMERCE_CONSUMER_SECRET || process.env.WC_CONSUMER_SECRET || '';
// Query-param auth, NOT an Authorization: Basic header — mdmlingbakery.com began
// rejecting header auth with 401 cannot_view on 22 Jul 2026 (host/security change).
const WC_AUTH_Q = `consumer_key=${encodeURIComponent(WC_KEY)}&consumer_secret=${encodeURIComponent(WC_SECRET)}`;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN || '';
let TG_CHAT = process.env.TELEGRAM_CHAT_ID || '';

// ---- args ----
const args = process.argv.slice(2);
let APPLY = args.includes('--apply');
const FORCE = args.includes('--force');
const NO_ALERT = args.includes('--no-alert');
const SPOT = args.includes('--spot'); // ad-hoc read-only check: Telegram/console only, no sheet writes
const SKIP_IF_FILLED = args.includes('--skip-if-filled'); // cloud-backup dedup: exit 0 if the laptop already filled this slot
const getArg = (k) => { const a = args.find((x) => x.startsWith('--' + k + '=')); return a ? a.split('=')[1] : null; };

// ---- SGT clock helpers ----
const nowSGT = () => new Date(Date.now() + SGT_OFFSET_H * 3600 * 1000); // read with getUTC* only
const todaySGT = () => nowSGT().toISOString().slice(0, 10);
function gmtBoundsToday() { // SGT midnight -> now, expressed for WC dates_are_gmt=true
  const start = new Date(todaySGT() + 'T00:00:00Z');
  start.setUTCHours(start.getUTCHours() - SGT_OFFSET_H);
  return { after: start.toISOString().slice(0, 19), before: new Date().toISOString().slice(0, 19) };
}
const hhmmToMin = (v) => Math.floor(Number(v) / 100) * 60 + (Number(v) % 100);
function slotLabel(v) {
  const h = Math.floor(Number(v) / 100), m = Number(v) % 100;
  const h12 = ((h + 11) % 12) + 1;
  return `${h12}${m ? ':' + String(m).padStart(2, '0') : ''}${h < 12 ? 'am' : 'pm'}`;
}

// ---- fetch with retry on 5xx/network (4xx never retried) ----
const RETRY_DELAYS_MS = (process.env.RETRY_DELAYS_MS || '20000,60000').split(',').map(Number);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function jget(url, opts) {
  for (let attempt = 0; ; attempt++) {
    let r, t;
    try { r = await fetch(url, opts); t = await r.text(); }
    catch (e) {
      if (attempt >= RETRY_DELAYS_MS.length) throw e;
      console.log(`   .. network error (${e.message}) — retry in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
      await sleep(RETRY_DELAYS_MS[attempt]); continue;
    }
    if (r.status >= 500 && attempt < RETRY_DELAYS_MS.length) {
      console.log(`   .. HTTP ${r.status} — retry in ${RETRY_DELAYS_MS[attempt] / 1000}s`);
      await sleep(RETRY_DELAYS_MS[attempt]); continue;
    }
    let j; try { j = JSON.parse(t); } catch { j = null; }
    return { status: r.status, json: j, text: t };
  }
}

// ---- Meta: MAF26 spend today (account TZ = SGT) ----
async function metaSpendToday() {
  const iso = todaySGT();
  const filtering = encodeURIComponent(JSON.stringify([{ field: 'campaign.name', operator: 'CONTAIN', value: CAMPAIGN_MATCH }]));
  const tr = encodeURIComponent(JSON.stringify({ since: iso, until: iso }));
  const url = `https://graph.facebook.com/${GRAPH_VER}/act_${ACT}/insights?level=campaign&fields=campaign_name,spend&time_range=${tr}&filtering=${filtering}&limit=200&access_token=${META_TOKEN}`;
  const { json } = await jget(url);
  if (!json || json.error) throw new Error('Meta insights error: ' + JSON.stringify(json && json.error));
  let spend = 0; const names = [];
  for (const r of json.data || []) { spend += parseFloat(r.spend || 0); names.push(r.campaign_name); }
  return { spend, names };
}

// ---- Meta: live daily budgets of ACTIVE MAF26 campaigns (B17 = all, B18 = purchase) ----
// Budget may sit at campaign level (CBO) or ad-set level; both are in minor units (cents).
async function metaBudgets() {
  const url = `https://graph.facebook.com/${GRAPH_VER}/act_${ACT}/campaigns?fields=name,effective_status,daily_budget,adsets{name,effective_status,daily_budget}&limit=200&access_token=${META_TOKEN}`;
  const { json } = await jget(url);
  if (!json || json.error) throw new Error('Meta campaigns error: ' + JSON.stringify(json && json.error));
  let total = 0, purchase = 0; const lines = [];
  for (const c of json.data || []) {
    if (!(c.name || '').includes(CAMPAIGN_MATCH)) continue;
    if (c.effective_status !== 'ACTIVE') continue;
    let b = Number(c.daily_budget || 0) / 100;
    if (!b) for (const a of (c.adsets && c.adsets.data) || []) {
      if (a.effective_status === 'ACTIVE') b += Number(a.daily_budget || 0) / 100;
    }
    total += b;
    if (/purchase/i.test(c.name)) purchase += b;
    lines.push(`${c.name}: $${b.toFixed(0)}/day`);
  }
  return { total, purchase, lines };
}

// ---- WooCommerce: sales + orders, SGT midnight -> now ----
// PRIMARY source = the WC Analytics stats endpoint — the same numbers Colin reads on the
// Analytics dashboard. Its "total sales" nets out refunds ISSUED today (even on older
// orders); a raw order-sum overcounts on refund days (21 Jul 2026: raw $960 vs
// dashboard $708 — two same-day refunds of −$252 on pre-today orders).
async function wcToday() {
  const iso = todaySGT();
  const statsUrl = `${WC_URL}/wp-json/wc-analytics/reports/revenue/stats?after=${iso}T00:00:00&before=${iso}T23:59:59&interval=day&${WC_AUTH_Q}`;
  const s = await jget(statsUrl);
  if (s.status === 200 && s.json && s.json.totals) {
    return { sales: Number(s.json.totals.total_sales) || 0, orders: Number(s.json.totals.orders_count) || 0 };
  }
  console.log(`   .. wc-analytics stats unavailable (HTTP ${s.status}) — falling back to raw order sum (NO refund netting)`);
  const { after, before } = gmtBoundsToday();
  let page = 1, count = 0, total = 0;
  while (true) {
    const url = `${WC_URL}/wp-json/wc/v3/orders?status=${PAID_STATUSES}&after=${after}&before=${before}&dates_are_gmt=true&per_page=100&page=${page}&_fields=id,total&${WC_AUTH_Q}`;
    const { status, json, text } = await jget(url);
    if (status !== 200) throw new Error('WC error ' + status + ': ' + text.slice(0, 200));
    if (!json.length) break;
    for (const o of json) { count++; total += parseFloat(o.total || 0); }
    if (json.length < 100) break;
    page++;
  }
  return { sales: total, orders: count };
}

// ---- Google Sheets ----
// Token is re-minted if >50 min old: access tokens die at 60 min, and a --target run
// sleeps up to ~75 min AFTER the startup sheet read minted one (killed the 2130 cloud
// slot on 21+22 Jul 2026 — "Sheets read error 401" right after the nap).
let _tok = null, _tokAt = 0;
async function googleToken() {
  if (_tok && Date.now() - _tokAt < 50 * 60 * 1000) return _tok;
  if (process.env.GOOGLE_ACCESS_TOKEN) { _tokAt = Date.now(); return (_tok = process.env.GOOGLE_ACCESS_TOKEN); }
  let creds;
  if (process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_REFRESH_TOKEN) {
    creds = { client_id: process.env.GOOGLE_CLIENT_ID, client_secret: process.env.GOOGLE_CLIENT_SECRET, refresh_token: process.env.GOOGLE_REFRESH_TOKEN };
  } else {
    creds = JSON.parse(execSync('gws auth export --unmasked', { shell: 'bash' }).toString());
  }
  const body = new URLSearchParams({ client_id: creds.client_id, client_secret: creds.client_secret, refresh_token: creds.refresh_token, grant_type: 'refresh_token' });
  const { json } = await jget('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body });
  if (!json || !json.access_token) throw new Error('Google token refresh failed');
  _tokAt = Date.now();
  return (_tok = json.access_token);
}
async function sheetGet(range, render = 'FORMATTED_VALUE') {
  const token = await googleToken();
  const url = `https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(`'${CFG.tab}'!${range}`)}?valueRenderOption=${render}`;
  const { status, json, text } = await jget(url, { headers: { Authorization: 'Bearer ' + token } });
  if (status !== 200) throw new Error('Sheets read error ' + status + ': ' + text.slice(0, 200));
  return json.values || [];
}
async function sheetWrite(data) {
  const token = await googleToken();
  const { status, text } = await jget(`https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values:batchUpdate`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ valueInputOption: 'USER_ENTERED', data: data.map((d) => ({ range: `'${CFG.tab}'!${d.range}`, values: d.values })) }),
  });
  if (status !== 200) throw new Error('Sheets write error ' + status + ': ' + text.slice(0, 200));
}
async function sheetStructural(requests) { // spreadsheet-level batchUpdate (row inserts etc.)
  const token = await googleToken();
  const { status, text } = await jget(`https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}:batchUpdate`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token, 'Content-Type': 'application/json' },
    body: JSON.stringify({ requests }),
  });
  if (status !== 200) throw new Error('Sheets structural error ' + status + ': ' + text.slice(0, 200));
}
async function sheetClear(range) {
  const token = await googleToken();
  const { status, text } = await jget(`https://sheets.googleapis.com/v4/spreadsheets/${CFG.sheetId}/values/${encodeURIComponent(`'${CFG.tab}'!${range}`)}:clear`, {
    method: 'POST', headers: { Authorization: 'Bearer ' + token },
  });
  if (status !== 200) throw new Error('Sheets clear error ' + status + ': ' + text.slice(0, 200));
}

// ---- Telegram ----
async function telegramDiscoverChat() {
  const { json } = await jget(`https://api.telegram.org/bot${TG_TOKEN}/getUpdates`);
  const msgs = ((json && json.result) || []).map((u) => u.message || u.channel_post).filter(Boolean);
  if (!msgs.length) return null;
  const id = String(msgs[msgs.length - 1].chat.id);
  // persist so future runs don't depend on getUpdates history (Telegram trims it)
  const p = path.join(os.homedir(), '.telegram.env');
  const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
  if (!/TELEGRAM_CHAT_ID=/.test(cur)) fs.writeFileSync(p, cur.trimEnd() + `\nTELEGRAM_CHAT_ID=${id}\n`);
  return id;
}
async function telegramSend(html) {
  if (!TG_TOKEN) { console.log('   !! Telegram skipped: no TELEGRAM_BOT_TOKEN (put it in ~/.telegram.env)'); return false; }
  if (!TG_CHAT) TG_CHAT = await telegramDiscoverChat();
  if (!TG_CHAT) { console.log('   !! Telegram skipped: no chat id — Colin must open the bot and press Start once'); return false; }
  const { status, json, text } = await jget(`https://api.telegram.org/bot${TG_TOKEN}/sendMessage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: TG_CHAT, text: html, parse_mode: 'HTML', disable_web_page_preview: true }),
  });
  if (status !== 200 || !(json && json.ok)) throw new Error('Telegram send failed: ' + text.slice(0, 200));
  return true;
}
async function telegramSendPhoto(png, caption) {
  if (!TG_TOKEN || !TG_CHAT) return false;
  const fd = new FormData();
  fd.append('chat_id', TG_CHAT);
  if (caption) fd.append('caption', caption);
  fd.append('photo', new Blob([png], { type: 'image/png' }), 'sheet.png');
  const r = await fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendPhoto`, { method: 'POST', body: fd });
  const t = await r.text();
  let j; try { j = JSON.parse(t); } catch { j = null; }
  if (r.status !== 200 || !(j && j.ok)) throw new Error('Telegram photo failed: ' + t.slice(0, 200));
  return true;
}
// Screenshot of a cell range: Sheets range-scoped PDF export -> render-shot.py (pypdfium2)
// -> cropped PNG buffer. Note: the export URL addresses the tab by GID, so TAB_OVERRIDE
// testing must also set GID_OVERRIDE or the shots come from the LIVE tab.
async function rangeShot(range) {
  const token = await googleToken();
  const url = `https://docs.google.com/spreadsheets/d/${CFG.sheetId}/export?format=pdf&gid=${CFG.gid}&range=${encodeURIComponent(range)}` +
    `&portrait=true&fitw=true&gridlines=true&size=A4&top_margin=0.2&bottom_margin=0.2&left_margin=0.2&right_margin=0.2`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
  if (r.status !== 200) throw new Error(`sheet PDF export failed ${r.status} (range ${range})`);
  const stamp = `${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  const pdfPath = path.join(os.tmpdir(), `maf-shot-${stamp}.pdf`);
  const pngPath = path.join(os.tmpdir(), `maf-shot-${stamp}.png`);
  fs.writeFileSync(pdfPath, Buffer.from(await r.arrayBuffer()));
  try {
    const py = process.platform === 'win32' ? 'py' : 'python3';
    execSync(`${py} "${path.join(__dirname, 'render-shot.py')}" "${pdfPath}" "${pngPath}"`, { stdio: 'pipe' });
    return fs.readFileSync(pngPath);
  } finally {
    for (const p of [pdfPath, pngPath]) { try { fs.unlinkSync(p); } catch {} }
  }
}

const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const money = (v) => {
  const n = Number(v);
  if (Number.isFinite(n)) return '$' + n.toFixed(2).replace(/\.00$/, '');
  const s = String(v == null || v === '' ? '—' : v);
  return s.startsWith('#') ? '—' : s; // sheet error cells (#DIV/0! etc) read as "—"
};

// per-row interval formulas, matching Colin's sheet pattern (r = this row, p = row above)
// F = ad cost as % of sales for the interval. An interval with SPEND but ZERO sales has no
// finite ratio — the old `=SUM(B/C)` returned #DIV/0!, and every downstream filter
// (B21/B22, G, H) skips non-numbers, so a dead interval became INVISIBLE and B24 kept
// recommending off the last interval that happened to have sales (27 Jul 2026: +30% at
// 16:00 off the 11:45 reading, after 4.5h and $110 of spend with $0 back — Colin caught it).
// Now: spend + no sales → 9.99 (renders 999%, an obvious flag) so the rule actually sees it.
// No spend and no sales → "" (a genuinely empty interval isn't a performance signal).
const fFormula = (r) => `=IF(C${r}>0, B${r}/C${r}, IF(B${r}>0, 9.99, ""))`;
const gFormula = (r, p) => `=IF(AND(ISNUMBER(F${r}), ISNUMBER(F${p}), F${p}<>0), (F${r}-F${p})/F${p}, "")`;
// H mirrors the sheet's B24 rule: <10% → +30%, <15% → +25%, <20% → +20%; else by
// performance change: ≤+15% hold, ≤+25% → -10%, ≤+40% → -15%, worse → -20%
const hFormula = (r) => `=IF(NOT(ISNUMBER(F${r})),"",IF(F${r}<0.1,0.3,IF(F${r}<0.15,0.25,IF(F${r}<0.2,0.2,IF(NOT(ISNUMBER(G${r})),0,IF(G${r}<=0.15,0,IF(G${r}<=0.25,-0.1,IF(G${r}<=0.4,-0.15,-0.2))))))))`;

(async () => {
  // ---- run-date gate: the scheduled task fires daily; only round-close days proceed ----
  // (--spot and --add-slot are manual, human-initiated actions — never gated)
  // run-dates.json is per-brand since 24 Jul 2026 ({"MLB":[...],"LLV":[...]}) — the brands'
  // round closes don't align. A legacy flat array still works and applies to every brand.
  const runDatesPath = path.join(__dirname, 'run-dates.json');
  const rdRaw = fs.existsSync(runDatesPath) ? JSON.parse(fs.readFileSync(runDatesPath, 'utf8')) : [];
  const runDates = Array.isArray(rdRaw) ? rdRaw : (rdRaw[BRAND] || []);
  const today = todaySGT();
  if (!FORCE && !SPOT && !runDates.includes(today)) {
    console.log(`[${BRAND}] ${today} is not in run-dates.json — nothing to do (use --force to override).`);
    return;
  }

  // ---- locate the decision block by its label — a row insert shifts it, so never hardcode row 17 ----
  const findAnchor = async () => {
    const a = await sheetGet('A1:A80');
    for (let i = 0; i < a.length; i++) if (String((a[i] || [])[0] || '').trim().toLowerCase() === 'total amount budgeted') return i + 1;
    throw new Error('"total amount budgeted" label not found in column A — decision block moved or renamed?');
  };
  let anchor = await findAnchor();

  // ---- SPOT mode: ad-hoc "how are we doing right now" — reads the sheet, never writes ----
  if (SPOT) {
    const [meta, budgets, wc] = await Promise.all([metaSpendToday(), metaBudgets(), wcToday()]);
    const grid = await sheetGet(`A2:K${anchor - 1}`);
    const cellNum = (v) => { const x = parseFloat(String(v == null ? '' : v).replace(/[$,]/g, '')); return Number.isFinite(x) ? x : null; };
    let last = null; // most recent slot row that already has a total-spend value in col I
    for (const r of grid) {
      const iv = cellNum(r[8]);
      if (r[0] && iv != null) last = { slot: r[0], spend: iv, sales: cellNum(r[9]) || 0, orders: cellNum(r[10]) || 0 };
    }
    const nn = nowSGT();
    const lines = [`<b>${BRAND} MAF26 — spot check ${slotLabel(nn.getUTCHours() * 100 + nn.getUTCMinutes())}</b>`, ''];
    if (last) {
      const dOrders = wc.orders - last.orders, dSales = wc.sales - last.sales;
      lines.push(`<b>since the ${slotLabel(last.slot)} slot</b>`);
      lines.push(`spent: ${money(meta.spend - last.spend)}`);
      lines.push(`sales: ${money(dSales)}`);
      lines.push(`orders: ${dOrders}`);
      lines.push(`avg order value: ${dOrders ? money(dSales / dOrders) : '—'}`);
      lines.push('');
    }
    lines.push('<b>Today so far</b>');
    lines.push(`spent: ${money(meta.spend)} of ${money(budgets.total)} budgeted${budgets.total ? ' (' + (meta.spend / budgets.total * 100).toFixed(1) + '%)' : ''}`);
    lines.push(`sales: ${money(wc.sales)}`);
    lines.push(`orders: ${wc.orders}`);
    lines.push(`avg order value: ${wc.orders ? money(wc.sales / wc.orders) : '—'}`);
    lines.push(`ad spend as % of sales: ${wc.sales ? (meta.spend / wc.sales * 100).toFixed(2) + '%' : '—'}`);
    console.log('\n' + lines.join('\n').replace(/<[^>]+>/g, '') + '\n');
    if (!NO_ALERT) console.log(`-> Telegram ${(await telegramSend(lines.join('\n'))) ? 'sent' : 'NOT sent'}`);
    return;
  }

  // ---- --target=HHMM: cloud-backup "start early, wait for the exact minute" ----
  // GitHub cron fires 30-90+ min late, so the workflow starts the job ~2.5h early and the
  // job SLEEPS here until 60s past the target slot, then fills as if --slot=HHMM. If the
  // cron fired so late the slot already passed, sleep is 0 and it runs immediately (data
  // "as of now", honestly late). Sleep is capped so a stuck job can't idle forever.
  const target = getArg('target');
  if (target) {
    const [th, tm] = [Math.floor(Number(target) / 100), Number(target) % 100];
    const wakeMin = th * 60 + tm + 1; // fire at slot + 1 minute
    const capMin = Number(process.env.WAIT_CAP_MIN || 210); // never idle > 3.5h
    while (true) {
      const c = nowSGT(); const curMin = c.getUTCHours() * 60 + c.getUTCMinutes();
      let waitMin = wakeMin - curMin;
      if (waitMin <= 0) { console.log(`  target ${target}: it is ${String(Math.floor(curMin / 60)).padStart(2, '0')}${String(curMin % 60).padStart(2, '0')} SGT — at/past target, proceeding.`); break; }
      if (waitMin > capMin) throw new Error(`target ${target} is ${waitMin} min away (> ${capMin} cap) — cron fired far too early; aborting rather than idling.`);
      const chunk = Math.min(waitMin, 10);
      console.log(`  target ${target}: ${waitMin} min to go (now ${String(Math.floor(curMin / 60)).padStart(2, '0')}${String(curMin % 60).padStart(2, '0')} SGT) — sleeping ${chunk} min...`);
      await sleep(chunk * 60 * 1000);
    }
  }

  // ---- match the interval slot from column A (read fresh every run — Colin edits the ladder) ----
  const colA = (await sheetGet(`A2:A${anchor - 1}`)).map((r, i) => ({ raw: r[0], row: i + 2 })).filter((x) => x.raw && /^\d{3,4}$/.test(String(x.raw).trim()));
  if (!colA.length) throw new Error(`no interval times found in column A2:A${anchor - 1}`);
  const forced = getArg('slot') || target;
  const n = nowSGT(); const nowMin = n.getUTCHours() * 60 + n.getUTCMinutes();
  let slot;
  if (forced) {
    slot = colA.find((x) => Number(x.raw) === Number(forced));
    if (!slot) throw new Error(`--slot=${forced} not found in column A (${colA.map((x) => x.raw).join(', ')})`);
  } else {
    const scored = colA.map((x) => ({ ...x, diff: Math.abs(hhmmToMin(x.raw) - nowMin) })).sort((a, b) => a.diff - b.diff);
    slot = scored[0];
    if (slot.diff > SLOT_TOLERANCE_MIN) throw new Error(`now (${String(Math.floor(nowMin / 60)).padStart(2, '0')}${String(nowMin % 60).padStart(2, '0')} SGT) is ${slot.diff} min from the nearest slot ${slot.raw} — outside ±${SLOT_TOLERANCE_MIN} min, aborting (use --slot= to force)`);
  }
  const isFirstSlot = slot.row === colA[0].row;
  console.log(`[${BRAND}] interval tracker — ${APPLY ? 'APPLY' : 'DRY-RUN'} — ${today}, slot ${slot.raw} (row ${slot.row})${isFirstSlot ? ' [first slot: will clear I2:K16]' : ''}`);

  if (SKIP_IF_FILLED) {
    const v = ((await sheetGet(`I${slot.row}`, 'UNFORMATTED_VALUE'))[0] || [])[0];
    if (v !== '' && v != null && Number.isFinite(parseFloat(v))) {
      console.log(`  slot ${slot.raw} already filled (I${slot.row}=${v}) — the laptop run got it; exiting.`);
      return;
    }
  }

  // ---- pull all three sources ----
  const [meta, budgets, wc] = await Promise.all([metaSpendToday(), metaBudgets(), wcToday()]);
  console.log(`  Meta MAF26 spend today: $${meta.spend.toFixed(2)}  (${meta.names.join(', ') || 'no campaigns'})`);
  console.log(`  Budgets: total $${budgets.total.toFixed(0)}, purchase $${budgets.purchase.toFixed(0)}  (${budgets.lines.join(' | ')})`);
  console.log(`  WooCommerce today: $${wc.sales.toFixed(2)} across ${wc.orders} paid orders`);

  if (!APPLY) { console.log('\nDRY-RUN — nothing written. Add --apply to write + alert.'); return; }

  // ---- write ----
  if (isFirstSlot) {
    // new day: yesterday's numbers must not mix in — snapshot them to the log, then clear.
    // B:H of the first slot row are also cleared (no previous interval to measure; Colin
    // confirmed 21 Jul 2026 the first row's B:H should just stay empty).
    const prev = await sheetGet(`A2:K${anchor - 1}`);
    console.log('  [pre-clear snapshot of I:K]');
    for (const r of prev) if (r[8] || r[9] || r[10]) console.log(`    ${r[0]}: I=${r[8] || ''} J=${r[9] || ''} K=${r[10] || ''}`);
    await sheetClear(`I2:K${anchor - 1}`);
    await sheetClear(`B${slot.row}:H${slot.row}`);
  }

  // previous slot = nearest earlier slot row that actually HAS data. A skipped slot
  // (laptop was off) is bridged: the interval measures from the last RECORDED slot, so
  // the decision formulas never subtract an empty cell (which would inflate the
  // "last interval" to the whole day's totals).
  const iVals = await sheetGet(`I2:I${anchor - 1}`, 'UNFORMATTED_VALUE');
  const hasData = (row) => { const v = (iVals[row - 2] || [])[0]; return v !== '' && v != null && Number.isFinite(parseFloat(v)); };
  const earlier = colA.filter((x) => x.row < slot.row);
  const prevSlot = [...earlier].reverse().find((x) => hasData(x.row)) || null;
  const skippedSlots = prevSlot ? earlier.filter((x) => x.row > prevSlot.row) : earlier;

  // self-heal this row's formulas: after Colin inserts/re-labels ladder rows, the row he
  // added has NO B:H/L:M formulas and the row after his insert still references the
  // pre-insert row (Sheets keeps cell refs, not "row above me"). Also repoints across
  // skipped (empty) slots. Fix here so the fill always measures the right interval.
  const writes = [];
  if (prevSlot) {
    const r = slot.row, p = prevSlot.row;
    const f = (await sheetGet(`B${r}:M${r}`, 'FORMULA'))[0] || [];
    const bRef = String(f[0] || '').replace(/\s/g, '');
    const m = bRef.match(/^=I(\d+)-I(\d+)$/);
    if (!bRef) {
      writes.push({ range: `B${r}:H${r}`, values: [[`=I${r}-I${p}`, `=J${r}-J${p}`, `=K${r}-K${p}`, `=C${r}/D${r}`, fFormula(r), gFormula(r, p), hFormula(r)]] });
      console.log(`  self-heal: row ${r} had no interval formulas — writing B:H (vs row ${p})`);
    } else if (m && Number(m[2]) !== p) {
      writes.push({ range: `B${r}:D${r}`, values: [[`=I${r}-I${p}`, `=J${r}-J${p}`, `=K${r}-K${p}`]] });
      writes.push({ range: `G${r}`, values: [[gFormula(r, p)]] });
      console.log(`  self-heal: row ${r} was measuring vs row ${m[2]} — repointed to row ${p}`);
    }
    if (!String(f[10] || '')) writes.push({ range: `L${r}:M${r}`, values: [[`=SUM(I${r}/J${r})`, `=J${r}/K${r}`]] });
  }

  writes.push(
    { range: `I${slot.row}:K${slot.row}`, values: [[Number(meta.spend.toFixed(2)), Number(wc.sales.toFixed(2)), wc.orders]] },
    { range: `B${anchor}:B${anchor + 1}`, values: [[Number(budgets.total.toFixed(2))], [Number(budgets.purchase.toFixed(2))]] },
  );
  await sheetWrite(writes);
  console.log(`  -> wrote I${slot.row}:K${slot.row} + B${anchor}:B${anchor + 1} (budgets)`);

  // ---- read back the computed sheet for the alert ----
  const grid = await sheetGet(`A1:M${anchor - 1}`);
  const decision = await sheetGet(`A${anchor}:B${anchor + 13}`);
  const rowVals = grid[slot.row - 1] || [];
  const num = (v) => { const x = parseFloat(String(v).replace(/[$,%]/g, '').replace(/,/g, '')); return Number.isFinite(x) ? x : null; };
  const asMoney = (v) => money(num(v) != null ? num(v) : v);
  const asText = (v) => esc(v == null || v === '' || String(v).startsWith('#') ? '—' : v);
  // Message layout = Colin's spec (28 Jul 2026): Overall block first (the slot row's
  // cumulative cells I:M), then the latest-interval block (B:F), both incl. the % column.
  const [iSpend, iSales, iOrders, iPct, iAvg] = [rowVals[8], rowVals[9], rowVals[10], rowVals[11], rowVals[12]];
  const [pSpent, pSales, pOrders, pAvg, pPct] = [rowVals[1], rowVals[2], rowVals[3], rowVals[4], rowVals[5]];

  const lines = [];
  lines.push(`<b>${BRAND} MAF26 — ${slotLabel(slot.raw)} check</b> (${today})`);
  lines.push('');
  lines.push('<b>Overall</b>');
  // Colin's spec (28 Jul 2026): plain cell value, no "$", no "of $X budgeted" suffix
  lines.push(`total spend: ${asText(iSpend)}`);
  lines.push(`total sales: ${asMoney(iSales)}`);
  lines.push(`%: ${asText(iPct)}`);
  lines.push(`orders: ${asText(iOrders)}`);
  lines.push(`avg value: ${asMoney(iAvg)}`);
  lines.push('');
  // interval block: the sheet's own formula cells. First slot of the day has no
  // previous interval — Colin wants no carry-over from yesterday, so it's totals-only.
  if (prevSlot) {
    const missed = skippedSlots.length ? ` (${skippedSlots.map((x) => slotLabel(x.raw)).join(', ')} slot${skippedSlots.length > 1 ? 's' : ''} missed)` : '';
    lines.push(`<b>${esc(slotLabel(prevSlot.raw))} to ${esc(slotLabel(slot.raw))}</b>${esc(missed)}`);
    lines.push(`total spend: ${asMoney(pSpent)}`);
    lines.push(`total sales: ${asMoney(pSales)}`);
    lines.push(`%: ${asText(pPct)}`);
    lines.push(`orders: ${asText(pOrders)}`);
    lines.push(`avg value: ${asMoney(pAvg)}`);
    lines.push('');
  }
  lines.push('<b>Decision block</b>');
  for (let i = 0; i < decision.length; i++) {
    const [a, b] = decision[i] || [];
    if (!a && !b) continue;
    const line = `${esc(a)}: ${esc(b == null || b === '' ? '—' : b)}`;
    lines.push(String(a).toLowerCase().includes('new purchase amount') ? `<b>👉 ${line}</b>` : line);
  }
  const sent = NO_ALERT ? false : await telegramSend(lines.join('\n'));
  console.log(`  -> Telegram ${sent ? 'sent' : 'NOT sent'}`);

  // ---- screenshots: the ladder table + the decision block, as photos ----
  // Ranges are derived, not hardcoded: the ladder shot stops at the last time row in
  // column A (junk formula rows below it stay out of frame), and the decision shot
  // follows the label anchor — both survive Colin's row inserts. A screenshot failure
  // must never fail the run: the sheet is already written and the text alert sent.
  if (sent && !NO_ALERT) {
    try {
      const lastLadderRow = colA[colA.length - 1].row;
      await telegramSendPhoto(await rangeShot(`A1:M${lastLadderRow}`), `${BRAND} intervals`);
      await telegramSendPhoto(await rangeShot(`A${anchor}:B${anchor + 13}`), `${BRAND} decision block`);
      console.log('  -> Telegram screenshots sent (2)');
    } catch (e) { console.log('  !! screenshots failed (alert already sent): ' + e.message); }
  }
})().catch((e) => { console.error('FATAL:', e.message); process.exit(1); });
