/* Headless check of sitenav.js's two branches after the 2026-08-16 root swap.
   Not a screenshot: it asserts on the DOM sitenav actually produces. */
const fs = require('fs');
const { JSDOM } = require('jsdom');

const SRC = fs.readFileSync(__dirname + '/sitenav.js', 'utf8');

/* Mirrors board.html's hardcoded bar AFTER the 2026-08-20 Gelly Feed removal:
   no 'board' tab, no #board section, Rosters is the default active tab. */
const SHELL_DOM = `<!doctype html><html><body>
  <header><h1>WPIAL All Stars</h1>
    <nav>
      <button data-tab="rosters" class="active">Rosters and Round Values</button>
      <button data-tab="schedule">2026 NFL Schedule</button>
      <button data-tab="scoreboard">Scoreboard</button>
      <button data-tab="standings">Standings</button>
      <button data-tab="rules">Rules</button>
      <button data-tab="history">League History</button>
    </nav>
  </header>
  <section id="rosters" class="active"></section>
</body></html>`;

const PAPER_DOM = `<!doctype html><html><body>
  <header><div class="brand">League News</div>
    <nav class="pager" id="pager"><a href="#p1">1</a></nav>
  </header>
  <main id="paper"></main>
</body></html>`;

/* jsdom fires DOMContentLoaded asynchronously, and sitenav defers init() to it —
   so the assertions have to wait for it or they read an un-inited DOM. */
function run(html, url) {
  const dom = new JSDOM(html, { url, runScripts: 'outside-only', pretendToBeVisual: true });
  return new Promise((resolve) => {
    dom.window.document.addEventListener('DOMContentLoaded', () =>
      setTimeout(() => resolve(dom.window), 0));
    dom.window.eval(SRC);
  });
}

const fails = [];
function check(name, cond, detail) {
  (cond ? console.log : (m) => { console.log(m); fails.push(name); })(
    (cond ? '  PASS  ' : '  FAIL  ') + name + (detail ? '\n          ' + detail : '')
  );
}

(async function () {
/* ---- Branch A: the shell (board.html) ---------------------------------- */
console.log('\nSHELL — https://wadi.solutions/board.html');
{
  const w = await run(SHELL_DOM, 'https://wadi.solutions/board.html');
  const nav = w.document.querySelector('nav');
  const labels = [...nav.children].map((b) => b.textContent.trim());

  check('League News chip is injected into the shell nav',
    labels.includes('League News'), 'nav reads: ' + labels.join(' | '));

  const ln = w.document.getElementById('sn-indexhtml');
  check('...and it is the index.html entry', !!ln, ln ? 'id=' + ln.id : 'no #sn-indexhtml');

  check('Draftboard chip is injected',
    !!w.document.getElementById('sn-draftboardhtml'));
  check('Depth Chart chip is injected',
    !!w.document.getElementById('sn-rosterhtml'));

  const dupes = labels.filter((l, i) => labels.indexOf(l) !== i);
  check('no duplicated tab buttons (hardcoded ones not re-injected)',
    dupes.length === 0, dupes.length ? 'duplicated: ' + dupes.join(', ') : '');

  /* Since the 2026-08-20 Gelly Feed removal every button in the bar is
     NAV-managed, so reorder() owns the whole bar and it must read in exactly
     NAV order — identical to the strip every other page gets. */
  check('the whole bar is in NAV order (no unmanaged tabs left)',
    labels.join('|') === ['League News', 'Draftboard', 'Rosters and Round Values',
      'Depth Chart', '2026 NFL Schedule', 'Scoreboard', 'Standings', 'Rules',
      'League History'].join('|'), 'order: ' + labels.join(' | '));
  check('the Gelly Feed tab is gone (removed 2026-08-20 — feed lives on the paper)',
    !labels.includes('Gelly Feed'), 'nav reads: ' + labels.join(' | '));

  check('renderStrip did NOT run on the shell (it owns its own bar)',
    !w.document.getElementById('siteNav') ||
    w.document.getElementById('siteNav').tagName === 'NAV');
}

/* ---- Branch B: the paper (index.html) ---------------------------------- */
console.log('\nPAPER — https://wadi.solutions/index.html');
{
  const w = await run(PAPER_DOM, 'https://wadi.solutions/index.html');
  const strip = w.document.getElementById('siteNav');
  check('the injected strip exists', !!strip);

  if (strip) {
    const links = [...strip.querySelectorAll('a')].map((a) => ({
      label: a.textContent.trim(), href: a.getAttribute('href')
    }));
    links.forEach((l) => console.log('          ' + l.label.padEnd(26) + ' -> ' + l.href));

    const TABS = ['Rosters and Round Values', '2026 NFL Schedule', 'Scoreboard',
                  'Standings', 'Rules', 'League History'];
    const bad = links.filter((l) => TABS.includes(l.label) && !/^board\.html#/.test(l.href));
    check('all six tab chips point at board.html#<tab>',
      bad.length === 0, bad.map((b) => b.label + ' -> ' + b.href).join('; '));

    const self = links.find((l) => l.label === 'League News');
    check('League News is marked as the current page', self && self.href === '#',
      self ? 'href=' + self.href : 'missing');

    const db = links.find((l) => l.label === 'Draftboard');
    check('Draftboard still points at draftboard.html',
      db && db.href === 'draftboard.html', db ? 'href=' + db.href : 'missing');

    const dc = links.find((l) => l.label === 'Depth Chart');
    check('Depth Chart still points at roster.html',
      dc && dc.href === 'roster.html', dc ? 'href=' + dc.href : 'missing');
  }
}

/* ---- Branch C: a standalone page (matchup.html) ------------------------ */
console.log('\nSTANDALONE — https://wadi.solutions/matchup.html');
{
  const w = await run(PAPER_DOM, 'https://wadi.solutions/matchup.html');
  const strip = w.document.getElementById('siteNav');
  const links = strip ? [...strip.querySelectorAll('a')].map((a) =>
    a.textContent.trim() + ' -> ' + a.getAttribute('href')) : [];
  check('League News is a real link here, not "#"',
    links.some((l) => l === 'League News -> index.html'), links.join(' | '));
  check('no chip is falsely marked current',
    !strip || !strip.querySelector('a.here') ||
    strip.querySelector('a.here').textContent.trim() === '');
}

console.log('\n' + (fails.length ? 'FAILURES: ' + fails.join(' / ') : 'All checks passed.'));
process.exit(fails.length ? 1 : 0);
})();
