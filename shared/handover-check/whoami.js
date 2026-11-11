// Handover check: WHICH ACCOUNT does each robot login belong to? Read-only. Prints identities only, never a key.
// Runs inside GitHub Actions (the only place the real robot keys can be read). Triggered by hand.
// A login that resolves to a person who is leaving FAILS. A login whose owner cannot be read is NO DATA, never a pass.
// Exit 0 = every login resolved and none belongs to a leaving account. 1 = at least one does. 2 = at least one unreadable.

const LEAVING = (process.env.LEAVING_ACCOUNTS || '').toLowerCase().split(',').map(s => s.trim()).filter(Boolean);

const GOOGLE_SETS = [
  // [label, client id env, client secret env, refresh token env]
  ['Google: sheets + email robots (GOOGLE_*)', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'GOOGLE_REFRESH_TOKEN'],
  ['Google: task tracker robots (TRACKER_GOOGLE_*)', 'TRACKER_GOOGLE_CLIENT_ID', 'TRACKER_GOOGLE_CLIENT_SECRET', 'TRACKER_GOOGLE_REFRESH_TOKEN'],
  ['Google Ads robots (GOOGLE_ADS_*)', 'GOOGLE_ADS_CLIENT_ID', 'GOOGLE_ADS_CLIENT_SECRET', 'GOOGLE_ADS_REFRESH_TOKEN'],
  ['Google Analytics robots (GA4_OAUTH_*)', 'GA4_OAUTH_CLIENT_ID', 'GA4_OAUTH_CLIENT_SECRET', 'GA4_OAUTH_REFRESH_TOKEN'],
];
const META_SETS = [['Meta: MLB (META_ACCESS_TOKEN)', 'META_ACCESS_TOKEN'], ['Meta: LLV (LLV_META_ACCESS_TOKEN)', 'LLV_META_ACCESS_TOKEN']];

async function getJson(url, opts) {
  try { const r = await fetch(url, opts); return { status: r.status, body: await r.json().catch(() => ({})) }; }
  catch (e) { return { status: 0, body: { error: e.message } }; }
}

async function googleWho(id, secret, refresh) {
  const t = await getJson('https://oauth2.googleapis.com/token', { method: 'POST', body: new URLSearchParams({ client_id: id, client_secret: secret, refresh_token: refresh, grant_type: 'refresh_token' }) });
  if (!t.body.access_token) return { who: null, note: `login REFUSED by Google (HTTP ${t.status}: ${t.body.error || '?'})`, dead: true };
  const at = t.body.access_token, H = { headers: { Authorization: 'Bearer ' + at } };
  const ti = await getJson('https://www.googleapis.com/oauth2/v3/tokeninfo?access_token=' + at);
  if (ti.body.email) return { who: ti.body.email, note: 'from token info' };
  const gm = await getJson('https://gmail.googleapis.com/gmail/v1/users/me/profile', H);
  if (gm.body.emailAddress) return { who: gm.body.emailAddress, note: 'from Gmail profile' };
  const dr = await getJson('https://www.googleapis.com/drive/v3/about?fields=user(emailAddress)', H);
  if (dr.body.user && dr.body.user.emailAddress) return { who: dr.body.user.emailAddress, note: 'from Drive' };
  return { who: null, note: 'login works, but its permissions do not include reading whose it is' };
}

(async () => {
  const rows = [];
  for (const [label, a, b, c] of GOOGLE_SETS) {
    if (!process.env[c]) { rows.push([label, 'NOT SET', 'no such key on this repo']); continue; }
    const r = await googleWho(process.env[a], process.env[b], process.env[c]);
    const status = r.dead ? 'FAIL' : !r.who ? 'NODATA' : LEAVING.includes(r.who.toLowerCase()) ? 'FAIL' : 'PASS';
    rows.push([label, status, `${r.who || '(unknown)'} - ${r.note}`]);
  }
  for (const [label, env] of META_SETS) {
    if (!process.env[env]) { rows.push([label, 'NOT SET', 'no such key on this repo']); continue; }
    const me = await getJson('https://graph.facebook.com/v21.0/me?fields=id,name&access_token=' + encodeURIComponent(process.env[env]));
    if (!me.body.id) rows.push([label, 'FAIL', `login REFUSED by Meta (HTTP ${me.status}: ${(me.body.error && me.body.error.message) || '?'})`]);
    else {
      const name = String(me.body.name || '');
      const personal = LEAVING.some(l => l && name.toLowerCase().includes(l.split('@')[0].split('.')[0]));
      rows.push([label, personal ? 'FAIL' : 'PASS', `logs in as "${name}"${personal ? ' (looks like a leaving person, not a company system user)' : ''}`]);
    }
  }
  for (const [label, status, detail] of rows) console.log(`${status.padEnd(7)} | ${label}\n          ${detail}`);
  const n = s => rows.filter(r => r[1] === s).length;
  console.log(`\nlogins: ${rows.length} | pass: ${n('PASS')} | fail: ${n('FAIL')} | no data: ${n('NODATA')} | not set: ${n('NOT SET')}`);
  console.log('WHOAMI_DONE');
  process.exit(n('FAIL') ? 1 : n('NODATA') ? 2 : 0);
})().catch(e => { console.error('NO DATA: ' + e.message); process.exit(2); });
