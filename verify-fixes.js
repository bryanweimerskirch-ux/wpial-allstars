/* Regression checks for the 2026-08-16 fix batch.
 *
 * These are the defects the batch claims to fix. Each test reproduces the ORIGINAL failure
 * against the patched source, so a revert makes them fail rather than silently pass.
 *
 * Run: node verify-fixes.js   (needs jsdom)
 */
const fs = require('fs');
const path = require('path');
const { JSDOM } = require('jsdom');

const read = (f) => fs.readFileSync(path.join(__dirname, f), 'utf8');
const fails = [];
function check(name, cond, detail) {
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '\n          ' + detail : ''));
  if (!cond) fails.push(name);
}

/* Pull an inline <script> body out of a page so its functions can be exercised without a
   DOM. Returns the concatenated source of every non-src script tag. */
function inlineJs(file) {
  const src = read(file);
  const out = [];
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m;
  while ((m = re.exec(src))) out.push(m[1]);
  return out.join('\n');
}

/* ---------------------------------------------------------------------------
 * 1. qp() survives a malformed percent-escape
 * ------------------------------------------------------------------------ */
console.log('\nqp() — malformed query strings');
for (const [file, search] of [
  ['roster.html', '?team=100%'],
  ['roster.html', '?team=%'],
  ['matchup.html', '?week=%zz'],
]) {
  const body = inlineJs(file);
  const qpSrc = body.match(/function qp\(k\)\s*\{[\s\S]*?\n  \}/);
  /* runScripts is required: without it window.eval is Node's eval in the Node realm, where
     `location` does not exist — the harness would fail for a reason unrelated to qp(). */
  const dom = new JSDOM('<!doctype html><html><body></body></html>',
    { url: 'https://wadi.solutions/' + file + search, runScripts: 'outside-only' });
  let threw = null, value;
  try {
    value = dom.window.eval('(function(){' + qpSrc[0] + ' return qp("team") + "|" + qp("week"); })()');
  } catch (e) { threw = e; }
  check(`${file}${search} does not throw`, !threw,
    threw ? String(threw) : 'returned ' + JSON.stringify(value));
}

/* ---------------------------------------------------------------------------
 * 2. roster.html no longer matches null === null
 * ------------------------------------------------------------------------ */
console.log('\nroster.html — null fid must not adopt a stranger\'s roster');
{
  const body = inlineJs('roster.html');
  const sideFor = body.match(/function sideFor\(fid\)\s*\{[\s\S]*?\n  \}/)[0];
  const opponentFor = body.match(/function opponentFor\(week, fid\)\s*\{[\s\S]*?\n  \}/)[0];

  // Registry has not hydrated: fidOf() returns null for every name, and state.fid is null.
  const harness = `
    var state = { fid: null, week: 1,
      weeks: { 1: [ {away:'Alpha',home:'Beta'}, {away:'Gamma',home:'Delta'} ] },
      detail: { ok:true, hasRosters:true, matchups:[
        {away:{name:'Alpha'},home:{name:'Beta'}}, {away:{name:'Gamma'},home:{name:'Delta'}} ] } };
    function fx(){ return null; }
    function fidOf(n){ return (fx() && fx().resolve(n)) || null; }
    ${sideFor}
    ${opponentFor}
    return { side: sideFor(null), opp: opponentFor(1, null) };
  `;
  const dom = new JSDOM('<!doctype html>',
    { url: 'https://wadi.solutions/roster.html', runScripts: 'outside-only' });
  const r = dom.window.eval('(function(){' + harness + '})()');
  check('sideFor(null) returns null, not the last team in the feed',
    r.side === null, 'got ' + JSON.stringify(r.side));
  check('opponentFor(week, null) returns null',
    r.opp === null, 'got ' + JSON.stringify(r.opp));
}

/* ---------------------------------------------------------------------------
 * 3. Ties: state and record formatting, on both pages
 * ------------------------------------------------------------------------ */
console.log('\nties — a finished tie is final, and shows in the record');
for (const file of ['roster.html', 'matchup.html']) {
  const body = inlineJs(file);
  const gameState = body.match(/function gameState\(mu\)\s*\{[\s\S]*?\n  \}/)[0];
  const dom = new JSDOM('<!doctype html>');
  const gs = dom.window.eval('(function(){' + gameState + ' return gameState; })()');

  check(`${file}: ESPN TIE reads final`,
    gs({ winner: 'TIE', awayScore: 112.4, homeScore: 112.4 }) === 'final',
    'got ' + gs({ winner: 'TIE', awayScore: 112.4, homeScore: 112.4 }));
  check(`${file}: in-progress game still reads live`,
    gs({ winner: 'UNDECIDED', awayScore: 40, homeScore: 31 }) === 'live');
  check(`${file}: unplayed game still reads pre`,
    gs({ winner: 'UNDECIDED', awayScore: 0, homeScore: 0 }) === 'pre');
  check(`${file}: a decided win still reads final`,
    gs({ winner: 'HOME', awayScore: 90, homeScore: 101 }) === 'final');
}
{
  const body = inlineJs('matchup.html');
  const recordOf = body.match(/function recordOf\(fid\)\s*\{[\s\S]*?\n  \}/)[0];
  const dom = new JSDOM('<!doctype html>');
  const fn = dom.window.eval(`(function(){
    var state = { form: { k: { g: 11, w: 5, l: 5, pf: 0, pa: 0 } } };
    var R = { teamKey: function(){ return 'k'; } };
    function nameOf(f){ return f; }
    ${recordOf}
    return recordOf; })()`);
  check('matchup.html: 5-5-1 renders as 5-5-1, not 5-5', fn('x') === '5-5-1', 'got ' + fn('x'));
}

/* ---------------------------------------------------------------------------
 * 4. board.html forwards all six projectWin arguments
 * ------------------------------------------------------------------------ */
console.log('\nboard.html — win probability uses the projections');
{
  const src = read('board.html');
  const wrapper = src.match(/function projectWin\([^)]*\)\s*\{[\s\S]*?\n\}/)[0];
  const dom = new JSDOM('<!doctype html>');
  const got = dom.window.eval(`(function(){
    var seen = null;
    var WPIAL_ROW = { projectWin: function () { seen = Array.prototype.slice.call(arguments); return {p:0.5}; } };
    ${wrapper}
    projectWin('A','B',{},null, 128.4, 96.1);
    return seen; })()`);
  check('all six arguments reach WPIAL_ROW.projectWin',
    got.length === 6 && got[4] === 128.4 && got[5] === 96.1,
    'forwarded ' + JSON.stringify(got));
}

/* ---------------------------------------------------------------------------
 * 5. sitenav.js: guarded auth path, hash on every tab, retire re-runs
 * ------------------------------------------------------------------------ */
console.log('\nsitenav.js');
{
  const SRC = read('sitenav.js');

  // 5a. wpial-auth on a page with no <header> must not throw.
  const noHeader = new JSDOM('<!doctype html><html><body><main></main></body></html>',
    { url: 'https://wadi.solutions/somepage.html', runScripts: 'outside-only', pretendToBeVisual: true });
  const errs = [];
  noHeader.window.addEventListener('error', (e) => errs.push(e.message));
  noHeader.window.eval(SRC);
  let threw = null;
  try {
    noHeader.window.document.dispatchEvent(new noHeader.window.Event('wpial-auth'));
  } catch (e) { threw = e; }
  check('wpial-auth on a headerless page does not throw',
    !threw && !errs.length, threw ? String(threw) : errs.join('; '));

  // 5b. clicking the shell's own Gelly Feed tab writes the hash.
  const shell = new JSDOM(`<!doctype html><html><body><header><h1>x</h1><nav>
      <button data-tab="board" class="active">Gelly Feed</button>
      <button data-tab="rosters">Rosters and Round Values</button>
      <button data-tab="standings">Standings</button>
    </nav></header><section id="rosters"></section><section id="board"></section></body></html>`,
    { url: 'https://wadi.solutions/board.html#rosters', runScripts: 'outside-only', pretendToBeVisual: true });
  shell.window.eval(SRC);
  return_after_load(shell, () => {
    const feed = [...shell.window.document.querySelectorAll('nav button')]
      .find((b) => b.dataset.tab === 'board');
    feed.click();
    check('clicking Gelly Feed moves the hash off #rosters',
      shell.window.location.hash === '#board',
      'hash is ' + JSON.stringify(shell.window.location.hash));
  });
}

/* ---------------------------------------------------------------------------
 * 6. The 2026-08-19 phone-screenshot batch (commit 28d6836). Static source
 *    checks in the same spirit as the rest of this file: each one names the
 *    ORIGINAL failure, so a revert fails loudly here instead of shipping.
 * ------------------------------------------------------------------------- */
console.log('\n2026-08-19 batch — mobile header squeeze, countdown time, pool cap');
{
  const NAV = read('sitenav.js');
  /* 6a. THE SQUEEZE. An unscoped mobile `body > header{...132px...}` rule (meant
     for board.html's centred-title header) shrank every WRAPPED draftboard header
     row to 267px on a 412px phone — mode toggle, ticker, clock and nav all
     clipped at a hard edge two-thirds across the screen. The 132px reservation
     may only exist scoped to the header that has an <h1>. */
  check('sitenav: no unscoped body>header 132px padding rule',
    !/body > header\{[^}]*132px/.test(NAV),
    'an unscoped 132px reservation squeezes every wrapped header row on phones');
  check('sitenav: 132px reservation is scoped to :has(> h1)',
    NAV.indexOf('body > header:has(> h1){padding-right:132px') >= 0);
  check('sitenav: draftboard Hide toggle keeps clearance from the pinned chip',
    NAV.indexOf('#wpial-mhdr-toggle{margin-right:') >= 0);

  const DB = read('draftboard.html');
  /* 6b. The countdown chip said "Aug 30" with no start time; owners had to go
     find it on board.html's banner. Date AND time, matching DRAFT_DATE. */
  check('draftboard: countdown carries the draft start time',
    /Draft: Sun Aug 30 · 5:30 PM MT/.test(DB));
  check('draftboard: DRAFT_DATE unchanged (2026-08-30 17:30 -06:00)',
    DB.indexOf("new Date('2026-08-30T17:30:00-06:00')") >= 0);
  /* 6c. Best Available hard-stopped at a silent slice(0,18) — on a phone it read
     as "the pool ends here". The cap must be pageable. */
  check('draftboard: pool render is pageable (baShown), not a bare slice(0,18)',
    DB.indexOf('avail.slice(0,baShown)') >= 0 && !/available\(posFilter\)\.slice\(0,18\)/.test(DB));
  check('draftboard: Show-more button exists and grows the list',
    DB.indexOf('id="baMore"') >= 0 && DB.indexOf('baShown+=30') >= 0);
}

/* jsdom defers DOMContentLoaded; sitenav's init() waits for it. */
function return_after_load(dom, fn) {
  if (dom.window.document.readyState === 'loading') {
    dom.window.document.addEventListener('DOMContentLoaded', () => setTimeout(fn, 0));
  } else { setTimeout(fn, 0); }
}

setTimeout(() => {
  console.log('\n' + (fails.length ? 'FAILURES: ' + fails.join(' / ') : 'All checks passed.'));
  process.exit(fails.length ? 1 : 0);
}, 400);
