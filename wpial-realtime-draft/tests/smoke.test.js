/* End-to-end smoke test of draftsync.js in a real browser against the
 * Firebase emulators: commish setup writes 160 slots, a pick lands via the
 * patched commitPick, a second owner's board renders it live, an out-of-turn
 * pick is rejected with the "not your pick" message, and a slot race between
 * the two browsers produces exactly one winner and a visible rejection.
 */
const { chromium } = require('playwright');
const http = require('http');
const path = require('path');
const fs = require('fs');

const SITE = '/home/claude/wpial-allstars';
const NS = 'wpial-allstars-default-rtdb';           // from databaseURL in firebase-config.js
const DB = `http://127.0.0.1:9000`;
const AUTH = `http://127.0.0.1:9099`;
const KEY = 'AIzaSyA-dHNnIHtzUwOWU1Dqa8G5qQ-67pDgg4Y';

let pass = 0, fail = 0; const bad = [];
function check(name, cond, extra) {
  if (cond) { pass++; console.log('  PASS ' + name); }
  else { fail++; bad.push(name + (extra ? ' :: ' + extra : '')); console.log('  FAIL ' + name + (extra ? ' — ' + extra : '')); }
}

function serve() {
  return new Promise((res) => {
    const srv = http.createServer((req, r2) => {
      const p = path.join(SITE, decodeURIComponent(req.url.split('?')[0]).replace(/^\//, '') || 'index.html');
      fs.readFile(p, (err, data) => {
        if (err) { r2.writeHead(404); r2.end('nope'); return; }
        const ext = path.extname(p);
        r2.writeHead(200, { 'Content-Type': { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' }[ext] || 'text/plain' });
        r2.end(data);
      });
    }).listen(8080, '127.0.0.1', () => res(srv));
  });
}

async function jf(url, opts) { const r = await fetch(url, opts); return r.json(); }

async function makeUser(email) {
  const r = await jf(`${AUTH}/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email, password: 'test1234', returnSecureToken: true })
  });
  return r.localId;
}

async function seed(uidBryan) {
  // admin writes: emulator accepts ?access_token=owner as admin
  const put = (p, body) => fetch(`${DB}/${p}.json?ns=${NS}&access_token=owner`, { method: 'PUT', body: JSON.stringify(body) });
  await put('', null);
  await put('emailToFid', {
    'bryan,weimerskirch@gmail,com': 'f08',
    'chad@example,com': 'f01'
  });
  await put('commish', { [uidBryan]: true });
}
const dbGet = async (p) => jf(`${DB}/${p}.json?ns=${NS}&access_token=owner`);

function initScript(user) {
  const tok = Buffer.from(JSON.stringify({ x: Date.now() + 86400000 })).toString('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') + '.fakesig';
  return `
    window.WPIAL_FIREBASE_EMULATOR = { dbHost: '127.0.0.1', dbPort: 9000, authUrl: '${AUTH}' };
    try {
      localStorage.setItem('wpial_auth_token', ${JSON.stringify(tok)});
      localStorage.setItem('wpial_auth_user', ${JSON.stringify(JSON.stringify(user))});
      localStorage.setItem('wpial_mode', JSON.stringify('live'));
      localStorage.setItem('wpial_coach_done', 'true');
    } catch (e) {}
  `;
}

async function signIn(page, email) {
  await page.evaluate(async (em) => {
    await firebase.auth().signInWithEmailAndPassword(em, 'test1234');
  }, email);
}

async function main() {
  const srv = await serve();
  await fetch(`${AUTH}/emulator/v1/projects/wpial-allstars/accounts`, { method: 'DELETE' });
  const uidBryan = await makeUser('bryan.weimerskirch@gmail.com');
  const uidChad = await makeUser('chad@example.com');
  await seed(uidBryan);

  const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium_headless_shell-1194/chrome-linux/headless_shell' });

  /* ---------- page A: the commissioner ---------- */
  const ctxA = await browser.newContext();
  await ctxA.addInitScript(initScript({ email: 'bryan.weimerskirch@gmail.com', name: 'Bryan', team: 'Bijan Mustard', is_commish: true }));
  const A = await ctxA.newPage();
  const errsA = [];
  A.on('pageerror', (e) => errsA.push(String(e)));
  await A.goto('http://127.0.0.1:8080/draftboard.html', { waitUntil: 'domcontentloaded' });
  await A.waitForTimeout(1500);
  check('A: page loads without JS errors', errsA.length === 0, errsA.join(' | ').slice(0, 300));
  check('A: staging banner is shown on localhost', await A.locator('#wpial-env-banner').count() > 0);
  check('A: dsBar strip exists', await A.locator('#dsBar').count() > 0);
  const notConn = await A.locator('#dsBar').innerText();
  check('A: shows not-connected state before sign-in', /not connected/i.test(notConn), notConn.slice(0, 120));

  await signIn(A, 'bryan.weimerskirch@gmail.com');
  await A.waitForSelector('#dsSetup', { timeout: 8000 }).catch(() => {});
  check('A: commish sees Start live draft button', await A.locator('#dsSetup').count() > 0,
    (await A.locator('#dsBar').innerText()).slice(0, 160));

  await A.click('#dsSetup');
  await A.waitForTimeout(300);
  const modalOpen = await A.locator('#confirmModal.open').count();
  check('A: setup asks for confirmation via confirmBox', modalOpen === 1);
  if (modalOpen) await A.click('#confirmYes');
  await A.waitForTimeout(1500);

  const slots = await dbGet('drafts/staging/2026/slots');
  check('setup wrote 160 slots', slots && Object.keys(slots).length === 160, slots && Object.keys(slots).length);
  check('slot 0 is f01 (Drake Draaaake?), snake verified at 10/11',
    slots && slots[0].fid === 'f01' && slots[9].fid === 'f10' && slots[10].fid === 'f10' && slots[19].fid === 'f01');
  const cur0 = await dbGet('drafts/staging/2026/cursor');
  check('cursor seeded to first open slot', cur0 !== null, String(cur0));

  /* commish picks on behalf of whoever is on the clock (bypass) */
  await A.evaluate(() => commitPick(POOL[0]));
  await A.waitForTimeout(1200);
  const p0 = await dbGet('drafts/staging/2026/picks/' + cur0);
  check('A: commish pick landed at the on-clock slot', p0 && p0.name === 'Bijan Robinson', JSON.stringify(p0).slice(0, 120));
  check('A: pick is server-stamped (at is a number, by = commish uid)', p0 && typeof p0.at === 'number' && p0.by === uidBryan);
  const cur1 = await dbGet('drafts/staging/2026/cursor');
  check('A: cursor advanced', cur1 === cur0 + 1, `${cur0} -> ${cur1}`);
  const logv = await dbGet('drafts/staging/2026/log');
  check('A: audit log entry written', logv && Object.values(logv).some(e => e.type === 'pick' && e.overall === cur0));

  /* ---------- page B: an owner (chad, f01 = Drake Draaaake?) ---------- */
  const ctxB = await browser.newContext();
  await ctxB.addInitScript(initScript({ email: 'chad@example.com', name: 'Chad', team: 'Drake Draaaake?', is_commish: false }));
  const B = await ctxB.newPage();
  const errsB = [];
  B.on('pageerror', (e) => errsB.push(String(e)));
  await B.goto('http://127.0.0.1:8080/draftboard.html', { waitUntil: 'domcontentloaded' });
  await signIn(B, 'chad@example.com');
  await B.waitForTimeout(2000);
  check('B: page loads without JS errors', errsB.length === 0, errsB.join(' | ').slice(0, 300));
  const stB = await B.evaluate(() => WPIAL_SYNC.state());
  check('B: synced with franchise f01', stB.synced === true && stB.fid === 'f01', JSON.stringify(stB));
  const boardTxt = await B.locator('#board').innerText();
  check('B: sees the commish\'s pick on the board live', boardTxt.indexOf('B. Robinson') >= 0 || boardTxt.indexOf('Bijan Robinson') >= 0);
  const presB = await dbGet('drafts/staging/2026/presence');
  check('presence shows both connected', presB && Object.keys(presB).length === 2, presB && Object.keys(presB).length);
  const barB = await B.locator('#dsBar').innerText();
  check('B: strip shows owners online', /2 of 10 owners online/.test(barB), barB.slice(0, 200));

  /* B tries to pick out of turn (cursor slot belongs to f02 now) */
  await B.evaluate(() => commitPick(POOL[1]));
  await B.waitForTimeout(800);
  const rejTxt = await B.locator('#dsBar').innerText();
  check('B: out-of-turn pick rejected with words, not silence', /Not your pick/i.test(rejTxt), rejTxt.slice(0, 200));
  const cur2 = await dbGet('drafts/staging/2026/cursor');
  check('B: cursor unmoved by rejected pick', cur2 === cur1, `${cur1} vs ${cur2}`);

  /* ---------- the race: cursor slot is f02's; commish (bypass) vs commish-for-f02...
     make it a real two-writer race on ONE slot: both browsers write slot cur1.
     A is commish (bypass ok). B is f01 — B's write on an f02 slot must lose at
     the server even if it fires first. ---------- */
  const [ra, rb] = await Promise.all([
    A.evaluate((ov) => firebase.database().ref('drafts/staging/2026').update({
      ['picks/' + ov]: { fid: 'f02', name: 'RACE-A', pos: 'RB', nfl: '', id: null, keeper: false, overall: ov, by: firebase.auth().currentUser.uid, at: firebase.database.ServerValue.TIMESTAMP },
      cursor: ov + 1
    }).then(() => 'landed', () => 'denied'), cur1),
    B.evaluate((ov) => firebase.database().ref('drafts/staging/2026').update({
      ['picks/' + ov]: { fid: 'f02', name: 'RACE-B', pos: 'RB', nfl: '', id: null, keeper: false, overall: ov, by: firebase.auth().currentUser.uid, at: firebase.database.ServerValue.TIMESTAMP },
      cursor: ov + 1
    }).then(() => 'landed', () => 'denied'), cur1)
  ]);
  const raceWinner = await dbGet('drafts/staging/2026/picks/' + cur1);
  check('race: exactly one writer landed', ra === 'landed' && rb === 'denied' && raceWinner.name === 'RACE-A',
    `A=${ra} B=${rb} slot=${raceWinner && raceWinner.name}`);

  /* ---------- undo: commish deletes the race pick, board B follows ---------- */
  await A.evaluate(() => undo());
  await A.waitForTimeout(1200);
  const afterUndo = await dbGet('drafts/staging/2026/picks/' + cur1);
  check('undo: commish delete removed the pick', afterUndo === null);
  const curU = await dbGet('drafts/staging/2026/cursor');
  check('undo: cursor rewound', curU === cur1, String(curU));
  const boardB2 = await B.locator('#board').innerText();
  check('undo: B\'s board no longer shows the undone pick', boardB2.indexOf('RACE-A') < 0);

  /* ---------- clock: commish starts local clock, B sees shared countdown ---- */
  await A.evaluate(() => { document.querySelector('#dcBar').style.display = ''; WPIAL_CLOCK && document.getElementById('dcStart') && document.getElementById('dcStart').click(); });
  await A.waitForTimeout(2500);
  const clock = await dbGet('drafts/staging/2026/clock');
  check('clock: commish clock published with absolute deadline', clock && typeof clock.deadline === 'number' && clock.forOverall === curU, JSON.stringify(clock));
  const barB2 = await B.locator('#dsBar').innerText();
  check('clock: B sees countdown + team on the clock', /⏱/.test(barB2) && /on the clock/.test(barB2), barB2.slice(0, 220));

  /* ---------- MOCK isolation: live picks must never touch the simulator ---- */
  await B.evaluate(() => setMode('mock'));
  await B.waitForTimeout(300);
  const mockBefore = await B.evaluate(() => Object.keys(picks).length);
  await A.evaluate(() => commitPick(POOL[2]));          // live pick lands while B is in mock
  await A.waitForTimeout(1200);
  const mockAfter = await B.evaluate(() => ({ n: Object.keys(picks).length, mode: mode }));
  check('mock isolation: live pick did not leak into B\'s mock board',
    mockAfter.mode === 'mock' && mockAfter.n === mockBefore, JSON.stringify(mockAfter) + ' vs ' + mockBefore);
  await B.evaluate(() => setMode('live'));
  await B.waitForTimeout(800);
  const liveBack = await B.evaluate(() => ({ n: Object.keys(picks).length, has: Object.values(picks).some(p => p.name === POOL[2].n) }));
  check('mock isolation: switching back to LIVE re-asserts the shared board (new pick present)',
    liveBack.has === true, JSON.stringify(liveBack));

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  bad.forEach(b => console.log('  ✗ ' + b));
  await browser.close();
  srv.close();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
