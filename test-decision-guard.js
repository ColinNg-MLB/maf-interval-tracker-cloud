#!/usr/bin/env node
/**
 * test-decision-guard.js — proves the decision-block integrity guard in tracker.js.
 *
 * READ-ONLY. Writes nothing, sends nothing. It `require`s tracker.js, which is safe
 * because tracker.js only runs when invoked directly (`require.main === module`).
 *
 * Why this exists: the guard's whole job is to notice that a formula Colin owns has
 * gone missing. A checker that can fail closed must be proven to find a known positive
 * before its silence means anything — and proven NOT to fire on the healthy case, or
 * it becomes a monitor that cries wolf and gets ignored.
 *
 *   node shared/maf-interval-tracker/test-decision-guard.js           # synthetic only
 *   node shared/maf-interval-tracker/test-decision-guard.js --live    # + both live tabs
 *
 * The --live pass is the false-positive calibration: both brands' real decision blocks
 * must produce ZERO problems. Run it after any change to the block's layout or formulas.
 */
process.env.BRAND = process.env.BRAND || 'LLV'; // tracker.js exits at import without one
const { execSync } = require('child_process');
const { decisionBlockProblems, decisionWarningLines } = require('./tracker.js');

let pass = 0, fail = 0;
const esc = (s) => String(s == null ? '' : s);

function check(name, got, want) {
  const ok = got === want;
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : `\n         expected ${want}, got ${got}`}`);
  ok ? pass++ : fail++;
}

// A healthy block, mid-day: every cell populated. This is the shape the guard must
// stay silent on.
const HEALTHY = [
  ['total amount budgeted', '15,075'],
  ['purchase budgeted', '15000'],
  ['amount spent', '3,050.44'],
  ['total percentage of ad spent', '17.91%'],
  ['% in 2nd last interval', '17.20%'],
  ['percentage of ad spend in last interval', '20.03%'],
  ['percentage change of performance vs last interval', '16.44%'],
  ['how much to change', '-10.00%'],
  ['new purchase amount', '13500'],
  ['estimated hour spend', '562.5'],
  ['hours left', '11.67'],
  ['amount to spend', '6567.13'],
  ['estimated spend for full day', '9,617.58'],
  ['projected sales based on ad spend', '53,691.75'],
];

// First interval of a day: B23/B24 are legitimately EMPTY (their own IFERRORs return "").
// The guard must not treat these as faults — this is the case that would generate a
// false alarm on every single first slot if the rule were "no blanks allowed".
const FIRST_INTERVAL = HEALTHY.map((r) => [...r]);
FIRST_INTERVAL[4][1] = '';
FIRST_INTERVAL[6][1] = '';
FIRST_INTERVAL[7][1] = '';

const clone = (mut) => { const c = HEALTHY.map((r) => [...r]); mut(c); return c; };

console.log('\nSynthetic cases — must stay SILENT (false-positive check)');
check('healthy mid-day block', decisionBlockProblems(HEALTHY).length, 0);
check('first interval of the day (B23/B24 legitimately empty)', decisionBlockProblems(FIRST_INTERVAL).length, 0);
check('headline of exactly zero is a real number, not a fault', decisionBlockProblems(clone((c) => { c[8][1] = '0'; })).length, 0);
check('headline carrying currency/comma formatting', decisionBlockProblems(clone((c) => { c[8][1] = '$13,500.00'; })).length, 0);
check('trailing blank rows in the read range', decisionBlockProblems([...HEALTHY, [], ['', '']]).length, 0);

console.log('\nSynthetic cases — must FIRE (known-positive check)');
check('headline cell deleted (the 12 Aug 2026 LLV incident)', decisionBlockProblems(clone((c) => { c[8][1] = ''; })).length, 1);
check('headline cell is a dash placeholder', decisionBlockProblems(clone((c) => { c[8][1] = '—'; })).length, 1);
check('headline cell erroring', decisionBlockProblems(clone((c) => { c[8][1] = '#DIV/0!'; })).length, 1);
check('headline row deleted entirely', decisionBlockProblems(HEALTHY.filter((r) => !r[0].includes('new purchase'))).length, 1);
check('an input cell erroring (#REF! upstream)', decisionBlockProblems(clone((c) => { c[1][1] = '#REF!'; })).length, 1);
check('empty decision block (whole range cleared)', decisionBlockProblems([]).length, 1);

// The 12 Aug 2026 incident, end to end: B25 cleared kills B26/B28 too. The guard should
// name the headline; the zeros below it are the consequence, not separate faults.
const INCIDENT = clone((c) => { c[8][1] = ''; c[9][1] = '0'; c[11][1] = '0'; });
const iProblems = decisionBlockProblems(INCIDENT);
check('12 Aug incident shape reports exactly one root problem', iProblems.length, 1);
check('...and it names the headline cell', /new purchase amount/.test(iProblems[0]), true);
check('...and it says EMPTY, not a vague failure', /EMPTY/.test(iProblems[0]), true);

console.log('\nWarning block rendering');
check('healthy block adds no lines to the message', decisionWarningLines([], esc).length, 0);
const wl = decisionWarningLines(iProblems, esc);
check('broken block leads with the warning header', /DECISION BLOCK BROKEN/.test(wl[1]), true);
check('warning says do not act', /do not act/i.test(wl[1]), true);

if (process.argv.includes('--live')) {
  console.log('\nLive calibration — both brands\' real tabs must be SILENT');
  const TABS = [
    ['MLB', '1bGCYAnn2Cqtl10xIe6YKsseFYuhEbeIp8Cq3PHzBjG8', 'moving average'],
    ['LLV', '1Q5meBGm7jbw4abgzixEJBy9VvdBY7CnfOzYWqyTqquo', 'daily moving average'],
  ];
  // execSync runs through cmd.exe on Windows, which does not understand single quotes —
  // the JSON has to be double-quoted with its inner quotes escaped, or gws receives
  // fragments and every live read "fails" for a reason that has nothing to do with Sheets.
  const read = (id, range) => {
    const params = JSON.stringify({ spreadsheetId: id, range, valueRenderOption: 'FORMATTED_VALUE' });
    const arg = process.platform === 'win32' ? `"${params.replace(/"/g, '\\"')}"` : `'${params}'`;
    const out = execSync(`gws sheets spreadsheets values get --params ${arg}`, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return JSON.parse(out.slice(out.indexOf('{'))).values || [];
  };
  for (const [brand, id, tab] of TABS) {
    try {
      const colA = read(id, `'${tab}'!A1:A80`);
      const anchor = colA.findIndex((r) => String((r || [])[0] || '').trim().toLowerCase() === 'total amount budgeted') + 1;
      if (!anchor) { console.log(`  FAIL  ${brand}: anchor label not found`); fail++; continue; }
      const block = read(id, `'${tab}'!A${anchor}:B${anchor + 13}`);
      const problems = decisionBlockProblems(block);
      check(`${brand} live decision block (rows ${anchor}-${anchor + 13}) is clean`, problems.length, 0);
      if (problems.length) problems.forEach((p) => console.log(`         - ${p}`));
    } catch (e) {
      console.log(`  SKIP  ${brand} live read failed (${e.message.split('\n')[0].slice(0, 80)})`);
    }
  }
} else {
  console.log('\n(live calibration skipped — pass --live to check both real tabs)');
}

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'} — ${pass} passed, ${fail} failed\n`);
process.exit(fail ? 1 : 0);
