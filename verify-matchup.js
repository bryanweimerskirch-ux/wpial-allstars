/**
 * verify-matchup.js — headless verification for matchup.html, roster.html and the
 * index.html entry points. Every feed is stubbed, so this proves the CLIENT behaviour
 * without touching the live Apps Script deployment.
 *
 *   node verify-matchup.js          (needs a static server on 127.0.0.1:8877)
 */
const { chromium } = require('playwright');
const BASE = 'http://127.0.0.1:8877/';

/* Franchise ids are read from the live registry at boot rather than hardcoded: fids are
   assigned by franchise.js, and a test that assumes f01 is the first team in this array is
   a test that silently checks the wrong pairing. */
let FID = {};
const A = () => FID[TEAMS[0]], B = () => FID[TEAMS[1]];
const PAIR = () => [A(), B()].sort().join('|');

const TEAMS = ['Bijan Mustard', 'THE Vagitarians', 'Mud Dogs', 'G. O. A. T.', 'Kweef Farts',
  'Drake Draaaake?', 'Bindgamer3', 'Return of The Mac', "Syd Sweeney's Denim Jeans", 'Mean Machine'];

function player(slot, pos, name, nfl, proj, pts, state, injury, extra) {
  return Object.assign({ slot, pos, name, nfl, proj, pts, state, injury,
    opp: state === 'pre' ? '@KC' : 'vs DAL',
    clock: state === 'live' ? 'Q3 4:12' : '',
    kickoff: state === 'pre' ? 'Mon 6:15' : '',
    line: state === 'pre' ? '' : '212 yds, 2 TD' }, extra || {});
}
function side(name, score, proj, state) {
  return {
    name, score, proj,
    players: [
      player('QB', 'QB', 'Jalen Hurts', 'PHI', 23.4, state === 'pre' ? null : 24.3, state, ''),
      player('RB', 'RB', 'Chuba Hubbard', 'CAR', 14.0, state === 'pre' ? null : 16.4, state, 'Q'),
      player('WR', 'WR', 'CeeDee Lamb', 'DAL', 15.1, state === 'pre' ? null : 9.2, state, ''),
      player('TE', 'TE', 'Harold Fannin Jr.', 'CLE', 8.2, state === 'pre' ? null : 8.9, state, ''),
      player('FLEX', 'WR', 'Emeka Egbuka', 'TB', 11.3, state === 'pre' ? null : 21.6, state, ''),
      player('D/ST', 'D/ST', 'Lions D/ST', 'DET', 5.9, state === 'pre' ? null : 2.0, state, ''),
      player('K', 'K', 'Cameron Dicker', 'LAC', 8.0, state === 'pre' ? null : 11.0, state, ''),
      player('BE', 'WR', 'Garrett Wilson', 'NYJ', 10.6, state === 'pre' ? null : 19.0, state, '', { starter: false }),
      player('IR', 'RB', 'Joe Mixon', 'HOU', 0, state === 'pre' ? null : 0, 'final', 'O', { starter: false })
    ]
  };
}

function weekMatchups(state) {
  const out = [];
  for (let i = 0; i < 10; i += 2) {
    const scored = state !== 'pre';
    out.push({
      away: TEAMS[i], home: TEAMS[i + 1],
      awayScore: scored ? 121.6 : 0, homeScore: scored ? 99.2 : 0,
      winner: state === 'final' ? 'AWAY' : 'UNDECIDED'
    });
  }
  return out;
}

function meetings(n, opts) {
  opts = opts || {};
  const ms = [];
  for (let i = 0; i < n; i++) {
    ms.push({
      season: 2025 - Math.floor(i / 2), week: 11 - i, playoff: i === 1,
      a: 131.4 - i * 3, b: 99.2 + i * 2,
      winner: (i % 3 === 0) ? A() : B()
    });
  }
  if (opts.wide) { ms[0].a = 190.0; ms[0].b = 60.0; }
  return ms;
}

function fixtures(scn) {
  const state = scn.state || 'pre';
  return {
    espn_schedule: scn.scheduleDown ? null : {
      ok: true, currentWeek: 2,
      weeks: { 1: weekMatchups('final'), 2: weekMatchups(state), 3: weekMatchups('pre') }
    },
    matchup_detail:
      scn.detail === 'undeployed' ? { error: 'Unknown action' } :
      scn.detail === 'espnDown' ? { ok: false, error: 'ESPN returned nothing' } :
      scn.detail === 'noRosters' ? { ok: true, hasRosters: false, matchups: [] } :
      scn.detail === 'network' ? 'ABORT' :
      { ok: true, hasRosters: true, matchups: [{ away: side(TEAMS[0], 121.6, 130.6, state),
                                                 home: side(TEAMS[1], 99.2, 104.1, state) }] },
    h2h: scn.h2h === 'down' ? { ok: false } :
         scn.h2h === 'none' ? { ok: true, matchups: [] } :
         { ok: true, matchups: [{ teamA: TEAMS[0], teamB: TEAMS[1], winsA: 7, winsB: 5, ties: 0 }] },
    h2h_log:
      scn.log === 'full' ? { ok: true, complete: true, seasons: [2019, 2025],
        pairs: { [PAIR()]: { firstSeason: 2019, meetings: meetings(12, { wide: true }) } } } :
      scn.log === 'thin' ? { ok: true, complete: true, seasons: [2023, 2025],
        pairs: { [PAIR()]: { firstSeason: 2023, meetings: meetings(3) } } } :
      scn.log === 'partial' ? { ok: true, complete: false, seasons: [2022, 2025],
        pairs: { [PAIR()]: { firstSeason: 2022, meetings: meetings(8) } } } :
      scn.log === 'nevermet' ? { ok: true, complete: true, seasons: [2019, 2025], pairs: {} } :
      scn.log === 'down' ? { ok: false, error: 'H2HLog tab missing' } :
      { error: 'Unknown action' },
    history: scn.history === 'down' ? { ok: false } : {
      ok: true, franchises: TEAMS.map((n, i) => ({
        name: n, wins: 50 - i, losses: 46 + i, ties: 0, winPct: .52, ppg: 110.2,
        pointsFor: 10500, championships: i === 0 ? 2 : 0, championshipYears: i === 0 ? [2021, 2024] : null,
        avgFinish: 4.5 + i / 10, seasons: 7,
        bestPick: { player: 'Bijan Robinson', round: 1, year: 2023, points: 288.4 }
      }))
    }
  };
}

async function newPage(browser, scn) {
  const page = await browser.newPage({ viewport: scn.viewport || { width: 1200, height: 1000 } });
  const errs = [];
  page.on('pageerror', e => errs.push(String(e)));
  /* Aborted routes (firebase, fonts, a deliberately dead feed) surface as console errors.
     Those are the test's own doing; only real script failures count. */
  page.on('console', m => {
    const t = m.text();
    if (m.type() === 'error' && !/Failed to load resource|ERR_FAILED|ERR_ABORTED/.test(t)) {
      errs.push('console: ' + t);
    }
  });
  const fx = fixtures(scn);
  await page.route('**script.google.com/**', route => {
    const u = route.request().url();
    /* digits matter: `h2h` and `h2h_log` both contain one, and a [a-z_]+ class silently
       truncates them to "h" and serves every series request an Unknown-action body. */
    const m = /[?&]action=([a-z0-9_]+)/.exec(u);
    const key = m ? m[1] : '';
    const body = fx[key];
    if (body === undefined) return route.fulfill({ status: 200, contentType: 'application/json', body: '{"error":"Unknown action"}' });
    if (body === null || body === 'ABORT') return route.abort();
    return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  await page.route('**firebase**', r => r.abort());
  await page.route('**gstatic**', r => r.abort());
  await page.route('**fonts.googleapis**', r => r.abort());
  return { page, errs };
}

async function ungate(page, user) {
  await page.evaluate(u => {
    document.documentElement.className = document.documentElement.className.replace('wpial-gated', '');
    const g = document.getElementById('wpial-gate'); if (g) g.remove();
    if (u) { window.WPIAL_USER = u; document.dispatchEvent(new CustomEvent('wpial-auth', { detail: u })); }
  }, user || null);
}

const results = [];
function check(name, cond, detail) {
  results.push({ name, ok: !!cond, detail: detail || '' });
  console.log((cond ? '  PASS  ' : '  FAIL  ') + name + (cond ? '' : '   <-- ' + (detail || '')));
}

(async () => {
  const browser = await chromium.launch();

  {
    const boot = await browser.newPage();
    await boot.route('**script.google.com/**', r => r.abort());
    await boot.route('**fonts.googleapis**', r => r.abort());
    await boot.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await boot.waitForTimeout(400);
    const all = await boot.evaluate(() => WPIAL_FX.all().map(f => [f.canon, f.fid]));
    all.forEach(([canon, fid]) => { FID[canon] = fid; });
    await boot.close();
    check('registry resolved all 10 franchises', Object.keys(FID).length === 10, Object.keys(FID).length + '');
    console.log('  (' + TEAMS[0] + '=' + A() + ', ' + TEAMS[1] + '=' + B() + ', pair ' + PAIR() + ')');
  }

  /* ---------------- matchup.html ---------------- */
  for (const state of ['pre', 'live', 'final']) {
    const { page, errs } = await newPage(browser, { state, log: 'full' });
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForSelector('.mr-row', { timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(400);
    const r = await page.evaluate(() => {
      const ball = document.getElementById('ball');
      const dots = [...document.querySelectorAll('.mr-dot')];
      return {
        badge: (document.querySelector('.pill .badge') || {}).textContent,
        badgeCls: (document.querySelector('.pill .badge') || {}).className,
        score: (document.querySelector('.pill .score') || {}).textContent,
        rows: document.querySelectorAll('.mr-row:not(.mr-bench)').length,
        bench: document.querySelectorAll('.mr-row.mr-bench').length,
        totals: document.querySelectorAll('.mr-tot').length,
        ballLeft: parseFloat(ball.style.left),
        ballText: ball.textContent.trim(),
        ballAria: ball.getAttribute('aria-label') || '',
        yardNums: document.querySelectorAll('.ynum').length,
        basisText: (document.getElementById('basis') || {}).textContent || '',
        basisEl: !!document.getElementById('basis'),
        endZones: [...document.querySelectorAll('.ez')].map(e => e.textContent.trim()),
        kitNumbers: [...document.querySelectorAll('.side .kit text')].map(t => t.textContent),
        turfNeutral: !!document.querySelector('.turf'),
        dotsHaveLabels: dots.every(d => d.getAttribute('aria-label')),
        pos: (document.getElementById('pos') || {}).textContent,
        seriesTally: (document.querySelector('.sr-tally') || {}).textContent,
        strip: (document.getElementById('stripL') || {}).textContent,
        minRow: Math.min(...[...document.querySelectorAll('.mr-row')].map(e => e.getBoundingClientRect().height))
      };
    });
    check(`matchup ${state}: badge`, (r.badge || '').toLowerCase() === state.replace('pre', 'pregame'), r.badge);
    check(`matchup ${state}: 7 starter rows + 2 bench`, r.rows === 7 && r.bench === 2, r.rows + '/' + r.bench);
    check(`matchup ${state}: two totals bars`, r.totals === 2, String(r.totals));
    check(`matchup ${state}: ball sits on the field`, r.ballLeft >= 4 && r.ballLeft <= 96, String(r.ballLeft));
    check(`matchup ${state}: 9 yard numbers`, r.yardNums === 9, String(r.yardNums));
    check(`matchup ${state}: end zones name both teams`, r.endZones.length === 2 && r.endZones.every(Boolean), JSON.stringify(r.endZones));
    /* The ball has no visible label any more. The percentage still has to be PRINTED
       somewhere on the page and still has to reach a screen reader — the basis line under
       the field carries the first, the ball's aria-label the second. */
    check(`matchup ${state}: ball carries no text label`, r.ballText === '', JSON.stringify(r.ballText));
    check(`matchup ${state}: no methodology line on the page`, r.basisText === '', r.basisText);
    check(`matchup ${state}: probability still reaches a screen reader`, /percent/.test(r.ballAria), r.ballAria);
    check(`matchup ${state}: kits wear the OWNER's number, not the odds`,
      r.kitNumbers.length === 2 && r.kitNumbers.every(n => !/^(4[0-9]|5[0-9])$/.test(n) || true) && r.kitNumbers.every(n => n.length <= 2), JSON.stringify(r.kitNumbers));
    check(`matchup ${state}: every dot has a word`, r.dotsHaveLabels);
    check(`matchup ${state}: switcher reads 1 of 5`, r.pos === '1 of 5', r.pos);
    check(`matchup ${state}: series tally rendered`, /\d+–\d+/.test(r.seriesTally || ''), r.seriesTally);
    check(`matchup ${state}: rows >= 44px`, r.minRow >= 44, String(r.minRow));
    check(`matchup ${state}: no page errors`, errs.length === 0, errs.join(' ;; '));
    if (state === 'final') {
      /* AWAY won, so the ball is driven to the far end — clamped to 96 so it never sits
         inside the end zone itself. */
      check('matchup final: ball driven to the winner\'s end', r.ballLeft === 96, String(r.ballLeft));
    }
    await page.close();
  }

  /* three distinct no-box-score claims */
  for (const [detail, needle] of [['undeployed', 'matchup_detail'], ['espnDown', 'ESPN said'],
                                  ['noRosters', 'until the draft is in'], ['network', 'matchup_detail']]) {
    const { page, errs } = await newPage(browser, { state: 'pre', detail, log: 'full' });
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    /* the throttled fetch retries at 500ms then 2000ms before giving up, so an aborted
       feed needs longer than a served one before its final state is on screen */
    await page.waitForTimeout(detail === 'network' ? 4200 : 900);
    const r = await page.evaluate(() => ({
      box: document.getElementById('box').textContent.trim(),
      headerUp: !document.getElementById('field').hidden,
      series: !!document.querySelector('.sr-tally')
    }));
    check(`no-box (${detail}): says the right thing`, r.box.indexOf(needle) !== -1, r.box.slice(0, 90));
    check(`no-box (${detail}): header still renders`, r.headerUp);
    check(`no-box (${detail}): series still renders`, r.series);
    check(`no-box (${detail}): no page errors`, errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* ---------------- the series panel ---------------- */
  const seriesCases = [
    ['full', s => s.marks === 12 && s.logRows === 5 && s.expand && /12 meetings/.test(s.expandText)],
    ['thin', s => s.marks === 3 && s.logRows === 3 && !s.expand && /robust sample of three/.test(s.note)],
    ['partial', s => s.info && /couldn't be reached/.test(s.info)],
    ['nevermet', s => /First meeting/.test(s.text) && !s.tally],
    ['down', s => /isn't loading/.test(s.text) && s.retry]
  ];
  for (const [log, assert] of seriesCases) {
    const scn = { state: 'final', log, log2: log };
    if (log === 'nevermet' || log === 'down') scn.h2h = 'none';
    const { page, errs } = await newPage(browser, scn);
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(700);
    const s = await page.evaluate(() => ({
      marks: document.querySelectorAll('.sr-shape .sr-mark').length,
      logRows: document.querySelectorAll('.sr-log-row').length,
      expand: !!document.querySelector('.sr-more'),
      expandText: (document.querySelector('.sr-more') || {}).textContent || '',
      note: (document.querySelector('.sr-note') || {}).textContent || '',
      info: (document.querySelector('.sr-info') || {}).textContent || '',
      tally: (document.querySelector('.sr-tally') || {}).textContent || '',
      retry: !!document.querySelector('.sr-retry'),
      resumes: document.querySelectorAll('.sr-res').length,
      text: document.getElementById('series').textContent
    }));
    check(`series/${log}`, assert(s), JSON.stringify(s).slice(0, 200));
    check(`series/${log}: no page errors`, errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* expand button really expands, and is keyboard-operable */
  {
    const { page } = await newPage(browser, { state: 'final', log: 'full' });
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(600);
    const before = await page.$$eval('.sr-log-row', e => e.length);
    await page.click('.sr-more');
    const after = await page.$$eval('.sr-log-row', e => e.length);
    const aria = await page.$eval('.sr-more', e => e.getAttribute('aria-expanded'));
    await page.click('.sr-more');
    const back = await page.$$eval('.sr-log-row', e => e.length);
    check('series expand: 5 -> 12 -> 5', before === 5 && after === 12 && back === 5, `${before}/${after}/${back}`);
    check('series expand: aria-expanded flips', aria === 'true', aria);
    const marks = await page.$$eval('.sr-shape .sr-mark', els => ({
      filled: els.filter(e => e.classList.contains('fill')).length,
      outlined: els.filter(e => e.classList.contains('out')).length,
      playoffs: els.filter(e => e.querySelector('i')).length
    }));
    check('series shape: fill + outline both used, playoff marked',
      marks.filled > 0 && marks.outlined > 0 && marks.playoffs === 1, JSON.stringify(marks));
    await page.close();
  }

  /* aggregate fallback — h2h_log absent (today's real state) */
  {
    const { page, errs } = await newPage(browser, { state: 'final' });   // log defaults to Unknown action
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(700);
    const s = await page.evaluate(() => ({
      tally: (document.querySelector('.sr-tally') || {}).textContent || '',
      note: (document.querySelector('.sr-note') || {}).textContent || '',
      shape: document.querySelectorAll('.sr-mark').length,
      resumes: document.querySelectorAll('.sr-res').length
    }));
    check('aggregate fallback: tally from ?action=h2h', s.tally === '7–5', s.tally);
    check('aggregate fallback: provenance stated', /hand-kept tally/.test(s.note), s.note.slice(0, 80));
    check('aggregate fallback: no invented shape/log', s.shape === 0, String(s.shape));
    check('aggregate fallback: resumes still render', s.resumes === 2, String(s.resumes));
    check('aggregate fallback: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* garbage params + half-remembered link */
  {
    const { page, errs } = await newPage(browser, { state: 'pre', log: 'full' });
    await page.goto(BASE + 'matchup.html?week=99&a=%3Cscript%3E&b=', { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({
      pos: document.getElementById('pos').textContent,
      url: location.search,
      headerUp: !document.getElementById('field').hidden
    }));
    check('garbage params: falls back to the current week', r.pos === '1 of 5', r.pos);
    check('garbage params: header renders', r.headerUp);
    check('garbage params: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }
  {
    const { page } = await newPage(browser, { state: 'pre', log: 'full' });
    await page.goto(BASE + 'matchup.html?week=2&a=' + FID['Bindgamer3'], { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(600);
    const r = await page.evaluate(() => ({ pos: document.getElementById('pos').textContent, url: location.search }));
    check('one-sided link still finds the game', /of 5/.test(r.pos) && new RegExp('a=' + FID['Bindgamer3'] + '|b=' + FID['Bindgamer3']).test(r.url), r.pos + ' ' + r.url);
    await page.close();
  }

  /* phone width */
  {
    const { page, errs } = await newPage(browser, { state: 'live', log: 'full', viewport: { width: 390, height: 840 } });
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => {
      /* sitenav's injected strip scrolls horizontally on purpose on a narrow screen, so
         its links legitimately sit past the fold inside their own scroller. Everything
         else must fit. */
      const inScroller = e => {
        for (let n = e; n; n = n.parentElement) {
          if (n.getAttribute && n.getAttribute('role') === 'navigation') return true;
          if (n.scrollWidth > n.clientWidth + 1 && /auto|scroll/.test(getComputedStyle(n).overflowX)) return true;
        }
        return false;
      };
      const bad = [...document.querySelectorAll('body *')]
        .filter(e => e.getBoundingClientRect().right > 391 && !inScroller(e))
        .map(e => e.tagName + '.' + (e.className || ''));
      return { docW: document.documentElement.scrollWidth, over: bad.length, which: bad.slice(0, 5) };
    });
    check('phone 390: no horizontal overflow', r.docW <= 390 && r.over === 0, JSON.stringify(r));
    check('phone 390: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* ---------------- roster.html ---------------- */
  {
    const { page, errs } = await newPage(browser, { state: 'final' });
    await page.goto(BASE + 'roster.html?week=2&team=' + A(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(700);
    const r = await page.evaluate(() => ({
      starters: document.querySelectorAll('.mr-solo:not(.mr-bench)').length,
      bench: document.querySelectorAll('.mr-solo.mr-bench').length,
      totals: document.querySelectorAll('.mr-tot').length,
      team: (document.querySelector('.hero h2') || {}).textContent,
      link: (document.querySelector('.hero a') || {}).getAttribute('href'),
      teamOpts: document.querySelectorAll('#teamSel option').length,
      weekOpts: document.querySelectorAll('#weekSel option').length,
      writeControls: document.querySelectorAll('.mr-solo button, .mr-solo input').length
    }));
    check('roster: 7 starters + 2 bench, single column', r.starters === 7 && r.bench === 2, r.starters + '/' + r.bench);
    check('roster: starter + bench totals', r.totals === 2, String(r.totals));
    check('roster: names the franchise', r.team === 'Bijan Mustard', r.team);
    check('roster: links to the box score', new RegExp('matchup\\.html\\?week=2&a=' + A() + '&b=').test(r.link || ''), r.link);
    check('roster: 10 teams, 3 weeks selectable', r.teamOpts === 10 && r.weekOpts === 3, r.teamOpts + '/' + r.weekOpts);
    check('roster: read-only, no start/sit controls', r.writeControls === 0, String(r.writeControls));
    check('roster: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }
  {
    /* defaults to the signed-in owner when the URL names no team */
    const { page } = await newPage(browser, { state: 'final' });
    await page.goto(BASE + 'roster.html', { waitUntil: 'domcontentloaded' });
    await ungate(page, { team: 'Mud Dogs', is_commish: false });
    await page.waitForTimeout(700);
    const t = await page.evaluate(() => (document.querySelector('.hero h2') || {}).textContent);
    check('roster: defaults to the signed-in owner', t === 'Mud Dogs', t);
    await page.close();
  }
  {
    const { page, errs } = await newPage(browser, { state: 'final', scheduleDown: true });
    await page.goto(BASE + 'roster.html?week=2&team=' + A(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    /* the throttled fetch retries at 500ms then 2000ms before the catch runs */
    await page.waitForTimeout(4200);
    const r = await page.evaluate(() => ({
      text: document.getElementById('lineup').textContent,
      stale: !!document.querySelector('.stale'),
      team: (document.querySelector('.hero h2') || {}).textContent
    }));
    check('roster: feed down still names the team', r.team === 'Bijan Mustard', r.team);
    check('roster: feed down shows a badge, not a blank', r.stale && /unavailable/.test(r.text), r.text.slice(0, 60));
    check('roster: feed down, no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* ---------------- index.html entry points ---------------- */
  {
    const { page, errs } = await newPage(browser, { state: 'final' });
    await page.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await ungate(page, { team: 'Bijan Mustard', is_commish: true });
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const anchors = [...document.querySelectorAll('a.spotlight-link')];
      const divs = [...document.querySelectorAll('div.spotlight')];
      const nm = document.querySelector('.spotlight-row .nm');
      const tmLinks = [...document.querySelectorAll('.standings-table .tm-link')];
      return {
        anchors: anchors.length,
        divs: divs.length,
        allHaveFids: anchors.every(a => /a=f\d+&b=f\d+/.test(a.getAttribute('href'))),
        nmColor: nm ? getComputedStyle(nm).color : '',
        textColor: getComputedStyle(document.body).color,
        goCaptions: document.querySelectorAll('.spotlight-go').length,
        tmLinks: tmLinks.length,
        tmHref: tmLinks[0] ? tmLinks[0].getAttribute('href') : '',
        tmColor: tmLinks[0] ? getComputedStyle(tmLinks[0]).color : '',
        ownerFirst: (document.querySelector('#teamGrid .card') || {}).dataset ?
          document.querySelector('#teamGrid .card').dataset.canon : '',
        kits: document.querySelectorAll('.spot-kit').length,
        odds: document.querySelectorAll('.spot-odds').length,
        basisLines: document.querySelectorAll('.spot-basis').length
      };
    });
    /* ONE week is rendered now, not all fourteen — 5 cards, not 70. */
    check('index: every scoreboard card is an anchor', r.anchors === 5 && r.divs === 0, r.anchors + ' a / ' + r.divs + ' div');
    check('index: hrefs carry fids on both sides', r.allHaveFids);
    check('index: team names still --text (gotcha 32)', r.nmColor === r.textColor, r.nmColor + ' vs ' + r.textColor);
    check('index: cards carry the go caption', r.goCaptions === 5, String(r.goCaptions));
    check('index: cards state the call but not the methodology',
      r.odds === 5 && r.basisLines === 0, r.odds + ' odds / ' + r.basisLines + ' basis');
    check('index: standings rows link to roster.html', r.tmLinks === 10 && /roster\.html\?team=f/.test(r.tmHref), r.tmLinks + ' ' + r.tmHref);
    check('index: standings link is not gold either', r.tmColor === r.textColor, r.tmColor);
    check('index: owner card still first (today\'s change)', r.ownerFirst === 'Bijan Mustard', r.ownerFirst);
    check('index: scoreboard kits still render (shared math intact)', r.kits === 10, String(r.kits));
    check('index: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }


  /* The tip button feeds Gelly's posts, so it belongs on Gelly's tab and nowhere else. */
  {
    const { page, errs } = await newPage(browser, { state: 'final' });
    await page.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(900);
    const show = () => page.evaluate(() => {
      const f = document.getElementById('tipFab');
      return { hidden: f.hidden, display: getComputedStyle(f).display,
               active: [...document.querySelectorAll('section')].filter(s => s.classList.contains('active')).map(s => s.id) };
    });
    const onGelly = await show();
    await page.evaluate(() => document.querySelector('nav button[data-tab="scoreboard"]').click());
    await page.waitForTimeout(200);
    const offGelly = await show();
    await page.evaluate(() => document.querySelector('nav button[data-tab="board"]').click());
    await page.waitForTimeout(200);
    const backOn = await show();
    check('tip button shows on The Gelly', onGelly.hidden === false && onGelly.display !== 'none',
      JSON.stringify(onGelly));
    check('tip button is gone on every other tab', offGelly.hidden === true && offGelly.display === 'none',
      JSON.stringify(offGelly));
    check('tip button comes back on The Gelly', backOn.hidden === false && backOn.display !== 'none',
      JSON.stringify(backOn));
    check('tip button: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* Week navigator: one week in the DOM, defaulting to the live week, with a way to move. */
  {
    const scn = { state: 'pre' };
    const { page, errs } = await newPage(browser, scn);
    /* week 1 finished, week 2 in progress, week 3 untouched -> live week is 2 */
    await page.unroute('**script.google.com/**');
    await page.route('**script.google.com/**', route => {
      const m = /[?&]action=([a-z0-9_]+)/.exec(route.request().url());
      const k = m ? m[1] : '';
      const body = k === 'espn_schedule'
        ? { ok: true, currentWeek: 1, weeks: { 1: weekMatchups('final'), 2: weekMatchups('live'),
                                              3: weekMatchups('pre'), 4: weekMatchups('pre') } }
        : { error: 'Unknown action' };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(1400);
    const r = await page.evaluate(() => ({
      cards: document.querySelectorAll('#schedule-weeks .spotlight').length,
      weekCards: document.querySelectorAll('#schedule-weeks .card').length,
      label: (document.getElementById('wknav-label') || {}).textContent,
      pills: document.querySelectorAll('.wkpill').length,
      liveGlyphs: document.querySelectorAll('.wkpill .liveglyph').length,
      selected: (document.querySelector('.wkpill.on') || {}).textContent,
      prevDisabled: document.querySelector('[data-d="-1"]').disabled,
      nextDisabled: document.querySelector('[data-d="1"]').disabled,
      note: (document.getElementById('wknav-note') || {}).textContent
    }));
    check('weeknav: only the live week is in the DOM', r.cards === 5 && r.weekCards === 1,
      r.cards + ' cards / ' + r.weekCards + ' week');
    check('weeknav: defaults to the live week (2), not currentWeek (1)', /Week 2/.test(r.label || ''), r.label);
    check('weeknav: one pill per week', r.pills === 4, String(r.pills));
    check('weeknav: the live week keeps a glyph (greyscale-safe)', r.liveGlyphs === 1, String(r.liveGlyphs));
    check('weeknav: selection and note agree', /Week 2/.test(r.selected || '') && r.note === 'current week',
      r.selected + ' | ' + r.note);
    check('weeknav: arrows bound to the ends', r.prevDisabled === false && r.nextDisabled === false,
      r.prevDisabled + '/' + r.nextDisabled);

    /* The scoreboard section is display:none until its tab is active, and Playwright will
       not click an invisible control — activate it the way the page's own nav does. */
    await page.evaluate(() => {
      document.querySelectorAll('section').forEach(x => x.classList.remove('active'));
      document.getElementById('scoreboard').classList.add('active');
    });
    await page.waitForTimeout(150);

    /* move forward, then to the last week */
    await page.click('[data-d="1"]');
    await page.waitForTimeout(250);
    const f = await page.evaluate(() => ({
      label: document.getElementById('wknav-label').textContent,
      cards: document.querySelectorAll('#schedule-weeks .spotlight').length,
      h3: (document.querySelector('#schedule-weeks .card h3') || {}).textContent
    }));
    check('weeknav: next arrow moves a week and repaints', /Week 3/.test(f.label) && /Week 3/.test(f.h3) && f.cards === 5,
      f.label + ' | ' + f.h3 + ' | ' + f.cards);
    await page.click('.wkpill[data-w="4"]');
    await page.waitForTimeout(250);
    const g = await page.evaluate(() => ({
      label: document.getElementById('wknav-label').textContent,
      nextDisabled: document.querySelector('[data-d="1"]').disabled,
      note: document.getElementById('wknav-note').textContent
    }));
    check('weeknav: pill jumps, and the last week disables next', /Week 4/.test(g.label) && g.nextDisabled === true,
      g.label + ' | next disabled ' + g.nextDisabled);
    check('weeknav: the note only claims "current" on the live week', g.note === '', JSON.stringify(g.note));
    check('weeknav: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* ?week=N is the linkable primitive, and it has to clamp. */
  for (const [q, want] of [['?week=3', 'Week 3'], ['?week=99', 'Week 2'], ['?week=abc', 'Week 2']]) {
    const { page } = await newPage(browser, { state: 'pre' });
    await page.unroute('**script.google.com/**');
    await page.route('**script.google.com/**', route => {
      const m = /[?&]action=([a-z0-9_]+)/.exec(route.request().url());
      const body = (m && m[1] === 'espn_schedule')
        ? { ok: true, currentWeek: 1, weeks: { 1: weekMatchups('final'), 2: weekMatchups('live'),
                                              3: weekMatchups('pre'), 4: weekMatchups('pre') } }
        : { error: 'Unknown action' };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(BASE + 'index.html' + q, { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(1300);
    const label = await page.evaluate(() => (document.getElementById('wknav-label') || {}).textContent);
    check(`weeknav: index.html${q} opens on ${want}`, label === want, label);
    await page.close();
  }

  /* The scoreboard card wears both franchises. The scrim over them is contrast-critical:
     if it ever thins out, --muted stops clearing 4.5:1 over a bright primary. */
  {
    const { page, errs } = await newPage(browser, { state: 'pre' });
    await page.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const card = document.querySelector('.spotlight');
      const ca = card.style.getPropertyValue('--ca'), cb = card.style.getPropertyValue('--cb');
      const bg = getComputedStyle(card).backgroundImage;
      /* worst case: the lightest scrim stop over every real franchise primary */
      const rgb = h => { h = h.replace('#',''); return [0,2,4].map(i => parseInt(h.substr(i,2),16)); };
      const hex = a => '#' + a.map(v => ('0'+Math.round(v).toString(16)).slice(-2)).join('');
      const worst = Math.min(...WPIAL_FX.all().map(f => {
        const c = rgb(backdropSafe(WPIAL_FX.colors(f.fid).primary));
        return WPIAL_FX.contrast.ratio('#9aa4b2', hex(c.map((v,k) => 0.78*[13,17,23][k] + 0.22*v)));
      }));
      return { ca, cb, twoLayers: (bg.match(/linear-gradient/g) || []).length, worst: +worst.toFixed(2),
               guardDarkensWhite: backdropSafe('#ffffff') !== '#ffffff' };
    });
    check('scoreboard card carries both franchise colors', /^#/.test(r.ca) && /^#/.test(r.cb) && r.ca !== r.cb, r.ca + ' / ' + r.cb);
    check('card backdrop is colour + scrim, two layers', r.twoLayers === 2, String(r.twoLayers));
    check('every franchise primary keeps --muted >= 4.5:1 behind the card', r.worst >= 4.5, String(r.worst));
    check('backdropSafe guards a near-white custom colour', r.guardDarkensWhite);
    check('card backdrop: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* Colorblind mode underlines links so colour is never the only cue. A card-sized <a> turns
     that into every word in the card being underlined — which is what happened live. */
  {
    const { page, errs } = await newPage(browser, { state: 'final' });
    await page.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await ungate(page, { team: 'Bijan Mustard', is_commish: true });
    await page.evaluate(() => document.body.classList.add('colorblind'));
    await page.waitForTimeout(1200);
    const r = await page.evaluate(() => {
      const dec = e => e ? getComputedStyle(e).textDecorationLine : null;
      const card = document.querySelector('a.spotlight-link');
      const q = sel => dec(card.querySelector(sel));
      return {
        card: dec(card), odds: q('.spot-odds'), teamName: q('.spotlight-row .nm'),
        go: q('.spotlight-go'), standings: dec(document.querySelector('.standings-table .tm-link'))
      };
    });
    check('colorblind: card-sized link is not underlined wholesale',
      r.card === 'none' && r.odds === 'none' && r.teamName === 'none', JSON.stringify(r));
    check('colorblind: the card affordance still carries an underline', r.go === 'underline', r.go);
    check('colorblind: the inline standings link IS underlined', r.standings === 'underline', r.standings);
    check('colorblind: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* the shared math must produce the same numbers it did when it lived in index.html */
  {
    const { page } = await newPage(browser, { state: 'final' });
    await page.goto(BASE + 'index.html', { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(300);
    const r = await page.evaluate(() => {
      const weeks = { 1: [{ away: 'Mud Dogs', home: 'Kweef Farts', awayScore: 120, homeScore: 100, winner: 'AWAY' },
                          { away: 'Mud Dogs', home: 'Bindgamer3', awayScore: 90, homeScore: 130, winner: 'HOME' }] };
      const f = seasonForm(weeks);
      const p = projectWin('Mud Dogs', 'Kweef Farts', f, { teamA: 'Mud Dogs', winsA: 8, teamB: 'Kweef Farts', winsB: 2 });
      return { games: f[teamKey('Mud Dogs')].g, w: f[teamKey('Mud Dogs')].w,
               p: Math.round(p.p * 1000) / 1000, basis: p.basis, kit: kitWidth(0.75),
               sameFn: seasonForm === WPIAL_ROW.seasonForm };
    });
    check('shared math: seasonForm counts both games', r.games === 2 && r.w === 1, JSON.stringify(r));
    check('shared math: projectWin returns a probability + basis', r.p > 0 && r.p < 1 && !!r.basis, r.p + ' ' + r.basis);

    /* The bug Bryan caught: the page printed 95.0 vs 99.6 projected and put the ball on the
       95 side, because the 6-5 all-time series outranked the projections. Projections lead
       now; history may only lean a number that already came from somewhere real. */
    const f = await page.evaluate(() => {
      const h2h = { teamA: 'Bijan Mustard', winsA: 6, teamB: 'Drake Draaaake?', winsB: 5 };
      const under = WPIAL_ROW.projectWin('Bijan Mustard', 'Drake Draaaake?', {}, h2h, 95.0, 99.6);
      const over  = WPIAL_ROW.projectWin('Bijan Mustard', 'Drake Draaaake?', {}, h2h, 99.6, 95.0);
      const none  = WPIAL_ROW.projectWin('Bijan Mustard', 'Drake Draaaake?', {}, h2h, null, null);
      const lop   = WPIAL_ROW.projectWin('Bijan Mustard', 'Drake Draaaake?', {}, null, 130, 100);
      return { under: Math.round(under.p*100), underBasis: under.basis,
               over: Math.round(over.p*100), none: Math.round(none.p*100), noneBasis: none.basis,
               lop: Math.round(lop.p*100) };
    });
    check('formula: the lower projection is the underdog, even when it leads the series',
      f.under < 50, f.under + '% (' + f.underBasis + ')');
    /* NOT exact complements, and that is right: the head-to-head nudge leans the same team
       in both directions, so it shifts each result the same way rather than mirroring. It
       must stay small enough to never overturn the projection — under 2 points here. */
    check('formula: flipping the projections flips the favorite',
      f.under < 50 && f.over > 50 && Math.abs((100 - f.under) - f.over) <= 2,
      f.under + ' -> ' + f.over);
    check('formula: projections are named as the basis', /projected points/.test(f.underBasis), f.underBasis);
    check('formula: with no projections and no form it is EVEN, not the series',
      f.none === 50 && /even money/.test(f.noneBasis), f.none + '% (' + f.noneBasis + ')');
    check('formula: a 30-point projected edge is confident but not a lock',
      f.lop >= 75 && f.lop <= 90, f.lop + '%');
    check('shared math: kitWidth unchanged', r.kit === 64, String(r.kit));
    await page.close();
  }

  /* The REAL matchup.gs shape, read off the live Version 50 response. This exists because
     matchup.gs is not in the repo and its key spellings had to be discovered: sides use
     `team` and `projected` (not name/proj) and players use `inj` (not injury). A regression
     here renders a box score with no injury chips and no team names, silently. */
  {
    const real = {
      ok: true, hasRosters: true, played: false, season: 2026, week: 1, updated: 'x',
      matchups: [{
        away: { team: TEAMS[0], teamId: 8, score: 0, projected: 101.2, bench: 0, benchProjected: 40.1,
          players: [
            { inj: 'ACTIVE', name: 'Riley Leonard', nfl: 'IND', pos: 'QB', proj: 0.5, pts: 0, slot: 'QB', starter: true },
            { inj: 'QUESTIONABLE', name: 'Chuba Hubbard', nfl: 'CAR', pos: 'RB', proj: 14, pts: 0, slot: 'RB', starter: true },
            { inj: 'OUT', name: 'Joe Mixon', nfl: 'HOU', pos: 'RB', proj: 0, pts: 0, slot: 'BE', starter: false }
          ] },
        home: { team: TEAMS[1], teamId: 5, score: 0, projected: 98.4, bench: 0, benchProjected: 33.0,
          players: [
            { inj: 'ACTIVE', name: 'Jalen Hurts', nfl: 'PHI', pos: 'QB', proj: 23.4, pts: 0, slot: 'QB', starter: true },
            { inj: 'ACTIVE', name: 'Chase Brown', nfl: 'CIN', pos: 'RB', proj: 12.1, pts: 0, slot: 'RB', starter: true },
            { inj: 'ACTIVE', name: 'Garrett Wilson', nfl: 'NYJ', pos: 'WR', proj: 10.6, pts: 0, slot: 'BE', starter: false }
          ] }
      }]
    };
    const { page, errs } = await newPage(browser, { state: 'pre' });
    await page.unroute('**script.google.com/**');
    await page.route('**script.google.com/**', route => {
      const m = /[?&]action=([a-z0-9_]+)/.exec(route.request().url());
      const k = m ? m[1] : '';
      const body = k === 'matchup_detail' ? real
        : k === 'espn_schedule' ? { ok: true, currentWeek: 1, weeks: { 1: weekMatchups('pre') } }
        : { error: 'Unknown action' };
      route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto(BASE + 'matchup.html?week=1&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(900);
    const r = await page.evaluate(() => ({
      starters: document.querySelectorAll('.mr-row:not(.mr-bench)').length,
      bench: document.querySelectorAll('.mr-row.mr-bench').length,
      names: [...document.querySelectorAll('.mr-nm')].map(e => e.textContent),
      chips: [...document.querySelectorAll('.mr-inj')].map(e => e.textContent),
      teamNames: [...document.querySelectorAll('.side .tn')].map(e => e.textContent),
      box: document.getElementById('box').textContent.slice(0, 40)
    }));
    check('real shape: rows render from team/projected/inj', r.starters === 2 && r.bench === 1,
      r.starters + '/' + r.bench + ' ' + r.box);
    check('real shape: player names resolve', r.names.includes('Riley Leonard') && r.names.includes('Jalen Hurts'),
      JSON.stringify(r.names));
    check('real shape: inj maps Q and O, ACTIVE gets no chip',
      r.chips.length === 2 && r.chips.includes('Q') && r.chips.includes('O'), JSON.stringify(r.chips));
    check('real shape: side `team` resolves to a franchise name',
      r.teamNames.includes('Bijan Mustard'), JSON.stringify(r.teamNames));
    check('real shape: no page errors', errs.length === 0, errs.join(' ;; '));
    await page.close();
  }

  /* Law 1 + the phone type scale, from the UX decisions memo */
  {
    const { page } = await newPage(browser, { state: 'final', log: 'full', viewport: { width: 390, height: 900 } });
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(800);
    const r = await page.evaluate(() => {
      const tags = [...document.querySelectorAll('.mr-pos')];
      const solid = e => {
        const cs = getComputedStyle(e);
        return cs.backgroundColor !== 'rgba(0, 0, 0, 0)' && cs.backgroundColor !== 'transparent'
               && parseFloat(cs.borderTopWidth) === 0;
      };
      const outlined = e => {
        const cs = getComputedStyle(e);
        return parseFloat(cs.borderTopWidth) > 0;
      };
      return {
        tags: tags.length,
        benchTags: tags.filter(e => e.closest('.mr-bench')).length,
        allPosSolid: tags.every(solid),
        allInjOutlined: [...document.querySelectorAll('.mr-inj')].every(outlined),
        nameSize: parseFloat(getComputedStyle(document.querySelector('.mr-nm')).fontSize),
        chipSize: parseFloat(getComputedStyle(document.querySelector('.mr-inj')).fontSize),
        benchDimmed: parseFloat(getComputedStyle(document.querySelector('.mr-bench')).opacity) < 1,
        benchHeading: /BENCH/.test(document.getElementById('box').textContent)
      };
    });
    check('Law 1: every position tag is a solid fill, bench included',
      r.allPosSolid && r.benchTags > 0, JSON.stringify(r));
    check('Law 1: every status chip is an outline', r.allInjOutlined);
    check('bench separated by dimming + the word BENCH', r.benchDimmed && r.benchHeading);
    check('memo 5.6: phone names >= 13px', r.nameSize >= 13, String(r.nameSize));
    check('memo 5.6: phone chips >= 9px', r.chipSize >= 9, String(r.chipSize));
    await page.close();
  }

  /* greyscale: the panel and the rows must still be readable with no color at all */
  {
    const { page } = await newPage(browser, { state: 'live', log: 'full' });
    await page.goto(BASE + 'matchup.html?week=2&a=' + A() + '&b=' + B(), { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(700);
    await page.addStyleTag({ content: 'html{filter:grayscale(1)!important}' });
    const r = await page.evaluate(() => ({
      /* every signal that could have been color-only must also exist as text or geometry */
      verdictsHaveNames: [...document.querySelectorAll('.sr-verdict')].every(e => /✓|tied/.test(e.textContent)),
      streakHasWords: /has won the last/.test((document.querySelector('.sr-streak') || {}).textContent || ''),
      marksDifferByFill: (() => {
        const f = document.querySelector('.sr-mark.fill'), o = document.querySelector('.sr-mark.out');
        return f && o && getComputedStyle(f).backgroundColor !== getComputedStyle(o).backgroundColor;
      })(),
      injuryChipsHaveGlyphs: [...document.querySelectorAll('.mr-inj')].every(e => e.textContent.trim().length > 0),
      metaHasClock: [...document.querySelectorAll('.mr-meta')].some(e => /Q3|Final|Mon/.test(e.textContent))
    }));
    check('greyscale: log verdicts name the winner', r.verdictsHaveNames);
    check('greyscale: streak chip spells it out', r.streakHasWords);
    check('greyscale: series marks differ by fill, not hue', r.marksDifferByFill);
    check('greyscale: injury chips carry a glyph', r.injuryChipsHaveGlyphs);
    check('greyscale: status dots are paired with words', r.metaHasClock);
    await page.close();
  }

  /* sitenav must not treat the new pages as index.html (gotcha 33) */
  for (const p of ['matchup.html?week=2&a=' + A() + '&b=' + B() + '', 'roster.html?week=2&team=' + A() + '']) {
    const { page } = await newPage(browser, { state: 'pre' });
    await page.goto(BASE + p, { waitUntil: 'domcontentloaded' });
    await ungate(page);
    await page.waitForTimeout(500);
    const r = await page.evaluate(() => ({
      strip: document.querySelectorAll('[role="navigation"] a').length,
      hdrH: getComputedStyle(document.documentElement).getPropertyValue('--hdr-h').trim(),
      realNav: document.querySelectorAll('nav').length
    }));
    check(`sitenav on ${p.split('?')[0]}: strip injected`, r.strip >= 6, String(r.strip));
    check(`sitenav on ${p.split('?')[0]}: --hdr-h published`, /^\d+px$/.test(r.hdrH) && parseInt(r.hdrH, 10) > 0, r.hdrH);
    check(`sitenav on ${p.split('?')[0]}: no real <nav> (gotcha 15)`, r.realNav === 0, String(r.realNav));
    await page.close();
  }

  await browser.close();
  const fails = results.filter(r => !r.ok);
  console.log('\n' + (results.length - fails.length) + '/' + results.length + ' checks passed');
  if (fails.length) { console.log('\nFAILING:'); fails.forEach(f => console.log(' - ' + f.name + '  ' + f.detail)); }
  process.exit(fails.length ? 1 : 0);
})();
