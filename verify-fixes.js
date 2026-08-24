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

  // 5b. clicking a shell tab writes the hash. (This used to click the Gelly
  // Feed tab; that tab was removed 2026-08-20 — the behaviour under test, "the
  // hash follows the visible tab", is unchanged and now exercised via Standings.)
  const shell = new JSDOM(`<!doctype html><html><body><header><h1>x</h1><nav>
      <button data-tab="rosters" class="active">Rosters and Round Values</button>
      <button data-tab="standings">Standings</button>
    </nav></header><section id="rosters" class="active"></section><section id="standings"></section></body></html>`,
    { url: 'https://wadi.solutions/board.html#rosters', runScripts: 'outside-only', pretendToBeVisual: true });
  shell.window.eval(SRC);
  return_after_load(shell, () => {
    const st = [...shell.window.document.querySelectorAll('nav button')]
      .find((b) => b.dataset.tab === 'standings');
    st.click();
    check('clicking Standings moves the hash off #rosters',
      shell.window.location.hash === '#standings',
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

/* ---------------------------------------------------------------------------
 * 7. The 2026-08-20 Gelly Feed removal. Bryan: "I don't want to see the gelly
 *    tab anywhere. Gelly is now in League News." The tab, its section, the tip
 *    FAB/modal and the feed fetches all left board.html together. Each check
 *    names the way the removal could silently un-happen.
 * ------------------------------------------------------------------------- */
console.log('\n2026-08-20 — Gelly Feed tab removed from the shell');
{
  const BD = read('board.html');
  check('board.html: no Gelly Feed tab button',
    !/data-tab="board"/.test(BD) && !/>\s*Gelly Feed\s*</.test(BD));
  check('board.html: no #board section (gotcha 33-B — button and section leave together)',
    !/<section id="board"/.test(BD));
  check('board.html: Rosters is the default active tab (button AND section)',
    /data-tab="rosters" class="active"/.test(BD) &&
    /<section id="rosters" class="active">/.test(BD));
  check('board.html: feed fetch is guarded (no ?action=feed spend for a card nothing renders)',
    /function loadLiveFeed\(\) \{[\s\S]{0,600}?getElementById\('live-feed-posts'\)\) return;/.test(BD));
  check('board.html: insider fetch is guarded the same way',
    /function loadInsiderReports\(\) \{[\s\S]{0,600}?getElementById\('insider-report-card'\)\) return;/.test(BD));
  check('board.html: tip FAB and modal left with the section',
    BD.indexOf('id="tipFab"') < 0 && BD.indexOf('id="tipModal"') < 0);

  const NAV2 = read('sitenav.js');
  check('sitenav: retireRosters no longer clicks the removed board button',
    !/data-tab="board"/.test(NAV2));
}

/* ---------------------------------------------------------------------------
 * 8. draftsync sign-in: a link that lands in the wrong browser must still be
 *    completable THERE. The original code answered that case by mailing a
 *    fresh link, which is unreachable for an owner whose mail app opens its
 *    own browser — every new link landed back in the same place. Reverting any
 *    of this puts Yahoo/iCloud owners back in that loop.
 * ------------------------------------------------------------------------ */
console.log('\ndraftsync — email-link sign-in has three ways in');
{
  const DS = read('draftsync.js');

  const complete = (DS.match(/function completeLinkSignIn\(\)[\s\S]*?\n  \}/) || [''])[0];
  check('draftsync: no-stored-email path does NOT send another link',
    complete.length > 0 && !/sendSignInLinkToEmail/.test(complete) &&
      !/Send link again/.test(complete),
    complete ? '' : 'completeLinkSignIn() not found');
  check('draftsync: no-stored-email path asks for the address instead',
    /uiMode = 'finish'/.test(complete));

  const finishClick = (DS.match(/function finishClick\(\)[\s\S]*?\n  \}/) || [''])[0];
  check('draftsync: Finish sign-in completes a link rather than mailing one',
    /finishSignIn\(/.test(finishClick) && !/sendSignInLinkToEmail/.test(finishClick));
  check('draftsync: a pasted link is validated before it is used',
    /isSignInWithEmailLink\(url\)/.test(finishClick));

  const finish = (DS.match(/function finishSignIn\([\s\S]*?\n  \}/) || [''])[0];
  check('draftsync: finishSignIn is the single call that signs anyone in',
    /signInWithEmailLink\(email, url\)/.test(finish));
  check('draftsync: a used or expired link says so in words, not a code',
    /invalid-action-code/.test(finish) && /already used/.test(finish));

  const send = (DS.match(/function sendLink\([\s\S]*?\n  \}/) || [''])[0];
  check('draftsync: the email is stashed BEFORE the link is sent',
    send.indexOf('setItem(K_EMAIL') > 0 &&
    send.indexOf('setItem(K_EMAIL') < send.indexOf('sendSignInLinkToEmail'));
  check('draftsync: the sent message tells owners to copy the link, not tap it',
    /choose Copy/.test(send));

  check('draftsync: the paste-a-link path is reachable from the strip',
    /id="dsPaste"/.test(DS) && /id="dsLink"/.test(DS) && /id="dsFinish"/.test(DS));
  check('draftsync: Connect is still offered when nothing is in flight',
    /id="dsConnect"/.test(DS));

  /* The one-click link is the path that does not depend on the owner doing
     anything right. Losing any of this puts draft night back on the mail app. */
  const link = (DS.match(/function maybeSignInFromLink\([\s\S]*?\n  \}/) || [''])[0];
  check('draftsync: a ?k= link signs in with a password, not another email',
    /signInWithEmailAndPassword/.test(link) && !/sendSignInLinkToEmail/.test(link));
  check('draftsync: an unclaimed franchise is created on first click',
    /createUserWithEmailAndPassword/.test(link) && /user-not-found/.test(link));
  check('draftsync: re-clicking the same link is a no-op (no sign-out churn)',
    /if \(have === k\.email\) return false/.test(link));
  check('draftsync: a link opened in another session takes it over',
    /signOut\(\)/.test(link));
  check('draftsync: the link identity is synthetic, never the owner inbox',
    /LINK_DOMAIN = '@wpial\.invalid'/.test(DS) &&
    /fid \+ LINK_DOMAIN/.test(DS));
  const lp = (DS.match(/function linkParam\([\s\S]*?\n  \}/) || [''])[0];
  check('draftsync: a mangled ?k= is rejected rather than half-honoured',
    /\^f\[0-9\]\{2\}\$/.test(lp) && /secret\.length < 12/.test(lp));
  check('draftsync: the link is resolved once, from the auth-state callback',
    /if \(!linkChecked\) \{ linkChecked = true;/.test(DS));
}

/* ---------------------------------------------------------------------------
 * 9. The 2026-08-23 rehearsal batch. Every one of these reproduces a defect the
 *    league hit during the live staging run-through, so a revert fails here
 *    rather than on draft night.
 * ------------------------------------------------------------------------ */
console.log('\nrehearsal batch — keepers, byes, roster legality, watchlists');
{
  const DS = read('draftsync.js'), BD2 = read('draftboard.html'), DC = read('draftclock.js'), WL = read('watchlist.js');

  /* 9a. Keeper picks were seeded with nfl:'' — which blinded the whole bye
         planner to 47 of the ~60 players on the board. */
  const seed = (DS.match(/upd\['picks\/' \+ s\.overall\] = \{[\s\S]*?\};/) || [''])[0];
  check('draftsync: keeper seed resolves a real NFL team (not nfl:"")',
    /nfl: nflOf\(k\.player\)/.test(seed) && !/nfl: ''/.test(seed));
  check('draftsync: resolution is by normalised NAME, never by id (gotcha 21)',
    /function nflResolver\(\)[\s\S]{0,400}poolByNorm\(\)[\s\S]{0,300}norm\(name\)/.test(DS));
  const apply = (DS.match(/var local = \{\};[\s\S]*?picks = local;/) || [''])[0];
  check('draftsync: an empty nfl is healed on READ, so a bad seed cannot blind byes again',
    /if \(!t && p\.name\)/.test(apply) && /nflResolver\(\)/.test(apply));

  /* 9b. Bye context followed whoever was on the clock, so an owner's warnings
         vanished the instant they used them. */
  const ctx = (BD2.match(/function ctxTeam\(\)\{[\s\S]*?\n\}/) || [''])[0];
  check('draftboard: ctxTeam anchors to the signed-in franchise, not the clock',
    /syncTeam\(\)/.test(ctx) && !/cursor<SLOTS\.length \? SLOTS\[cursor\]\.team : null; \}$/.test(ctx));
  check('draftboard: the commissioner still follows the clock (he drafts for others)',
    /syncCommish\(\)/.test(ctx) && /clockTeam\(\)/.test(ctx));
  check('draftboard: needs count keeper ghosts as well as committed picks',
    /function rosterCountAll\(team\)\{[\s\S]{0,200}teamPlayers\(team\)/.test(BD2) &&
    /function teamNeeds\(team\)\{[\s\S]{0,120}rosterCountAll\(team\)/.test(BD2));

  /* 9c. Endgame legality — a team could finish with no QB, K or DEF. */
  const forced = (BD2.match(/function forcedPositions\(team\)\{[\s\S]*?\n\}/) || [''])[0];
  check('draftboard: restriction engages only once slack is gone',
    /if\(cur\.total < left\) return null;/.test(forced));
  check('draftboard: legality is "does it still fit AFTER this pick", not "do I have one"',
    /needsFromCount\(bumpCount\(c,pos\)\)\.total <= left-1/.test(forced));
  check('draftboard: an unsatisfiable roster still gets options (no deadlock)',
    /if\(!list\.length\)\{/.test(forced) && /over=true/.test(forced));
  check('draftboard: tryDraft refuses a pick that would strand the roster',
    /function tryDraft\(p\)\{[\s\S]{0,700}forcedPositions\(s\.team\)[\s\S]{0,300}return;/.test(BD2));
  check('draftboard: Best Available is filtered, not merely annotated',
    /if\(fx\) avail=avail\.filter\(p=>fx\.list\.indexOf\(p\.p\)>=0\);/.test(BD2));
  check('draftboard: and says which positions are required and why',
    /class="forcedbar/.test(BD2) && /function forcedNote\(/.test(BD2));

  /* 9d. Auto-pick had to learn the same rule or it recreates the hole. */
  const choose = (DC.match(/function choose\(team\) \{[\s\S]*?\n  \}/) || [''])[0];
  check('draftclock: auto-pick filters the watchlist by roster legality',
    /stillOnBoard\(p\) && fits\(p\)/.test(choose));
  check('draftclock: and the Best Available fallback too',
    /open\.filter\(fits\)/.test(choose));
  check('draftclock: but never stalls the clock over legality',
    /legal\.length \? legal : open/.test(choose));

  /* 9e. Watchlists kept drafted players, struck through, behind a manual button. */
  check('watchlist: drafted players are pruned, not just struck through',
    /function pruneGone\(\)/.test(WL) && /addEventListener\('wpial-board-render', pruneGone\)/.test(WL));
  check('watchlist: the prune is guarded so it does not save on every repaint',
    /if \(L\.length !== before\) changed\(\);/.test(WL));
  check('draftboard: render fires the event the prune listens for',
    /dispatchEvent\(new CustomEvent\('wpial-board-render'\)\)/.test(BD2));

  /* 9f. The two states a quiet strip line demonstrably failed to convey: three
         people drafted for an hour on one shared link, and a disconnected board
         looks identical to a working one. */
  const mism = (DS.match(/function identityMismatch\(\)[\s\S]*?\n  \}/) || [''])[0];
  check('draftsync: draft identity is cross-checked against the site login',
    /siteFid\(\)/.test(mism) && /s === myFid/.test(mism));
  check('draftsync: compared by fid, never by team name (ESPN names drift hourly)',
    /function siteFid\(\)[\s\S]{0,300}u\.fid/.test(DS) && !/WPIAL_USER\.team === teamOf/.test(DS));
  check('draftsync: a mismatch says WRONG ACCOUNT and names both franchises',
    /WRONG ACCOUNT/.test(DS) && /teamOf\(mm\.draft\)/.test(DS) && /teamOf\(mm\.site\)/.test(DS));
  check('draftsync: not-connected gets its own loud banner, not just a strip line',
    /NOT CONNECTED/.test(DS) && /stay on this device and nobody else sees them/.test(DS));
  check('draftsync: that banner offers Connect without hunting for it',
    /id="dsAlertGo"/.test(DS) && /ag\.onclick = connectClick/.test(DS));
  check('draftsync: neither banner fires in MOCK (private simulator)',
    /if \(!isLive\(\)\) \{ el\.style\.display = 'none'; alertBar\(''\); return; \}/.test(DS));
}

/* ---------------------------------------------------------------------------
 * 2026-08-24 — the keeper feed was pointed at a dead action and failed silently
 *
 * The live symptom: the strip read a confident "15 declared · 3/10 teams in" while
 * the sheet and keepers_v2 both held 47 across all ten clubs. Cause was not a race:
 *   - KEEPERS_URL pointed at ?action=keepers, which returns 404
 *   - fetchLiveKeepers ended in .catch(()=>{}) — the failure vanished
 *   - init() had already loaded KEEPERS_SNAPSHOT (a hardcoded July list of 15 across
 *     3 clubs, including Sam Darnold and Dalton Kincaid, no longer kept) tagged as
 *     source:'live', so nothing on screen could tell snapshot from truth
 *   - setupLive() seeds from whatever `keepers` holds, and merges rather than
 *     overwrites, so a bad seed could not be cleanly re-run
 * ------------------------------------------------------------------------- */
console.log('\n2026-08-24 — keeper feed endpoint, silent failure, snapshot disguise');
{
  const DB = read('draftboard.html');
  const DS = read('draftsync.js');

  check('draftboard: keeper feed points at keepers_v2, not the 404ing keepers action',
    /KEEPERS_URL\s*=\s*'[^']*action=keepers_v2'/.test(DB));
  check('draftboard: a non-2xx keeper response is an error, not success',
    /if\(!r\.ok\) throw new Error\('HTTP '\+r\.status\)/.test(DB));
  check('draftboard: an empty keeper feed is an error too',
    /throw new Error\('empty keeper feed'\)/.test(DB));
  check('draftboard: the keeper failure is no longer swallowed by an empty catch',
    !/\.catch\(\(\)=>\{\}\);\s*\n\}\s*\nfunction fetchFeedRankings/.test(DB) &&
    /keeper feed failed:/.test(DB));
  check('draftboard: both feed shapes parse (keepers_v2 teams map + legacy array)',
    /function flattenKeeperFeed/.test(DB) && /d\.teams/.test(DB) && /Array\.isArray\(d\.keepers\)/.test(DB));
  check('draftboard: the embedded list loads as a snapshot, never as live',
    /loadKeepersFromList\(KEEPERS_SNAPSHOT,'snapshot'\)/.test(DB) &&
    !/loadKeepersFromList\(KEEPERS_SNAPSHOT,'live'\)/.test(DB));
  check('draftboard: an unverified board says so instead of stating a count',
    /keeper feed unavailable/.test(DB) && /DO NOT start the draft/.test(DB));
  check('draftboard: verification state is mirrored onto window (gotcha 24)',
    /window\.WPIAL_KEEPERS_OK\s*=/.test(DB));
  check('draftboard: the declared round from the sheet wins over the derived one',
    /declared \(league sheet\)/.test(DB));
  check('draftboard: the offline snapshot is the current 47, not the July 15',
    (DB.match(/KEEPERS_SNAPSHOT = (\[.*?\]);/s) || [,''])[1].split('"team"').length - 1 === 47);
  check('draftboard: the two players who are no longer kept are gone from the snapshot',
    !/"player":"Sam Darnold"/.test(DB) && !/"player":"Dalton Kincaid"/.test(DB));
  check('draftsync: setupLive refuses to seed an unverified keeper set',
    /window\.WPIAL_KEEPERS_OK !== true/.test(DS) && /refusing to seed/.test(DS));
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
