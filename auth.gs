/**
 * WPIAL AUTH v1 — owner login + keeper declaration
 * ------------------------------------------------
 * Self-contained. Every helper is wa*-prefixed so nothing here collides with
 * the existing Code.gs (jsonOut_, getTab_, etc. are NOT redefined).
 *
 * INSTALL
 *   1. Paste this whole file as a new script file named  auth.gs
 *   2. Run  setupAuth()  once  (creates Owners + KeeperPicks tabs, mints AUTH_SECRET)
 *   3. Add the dispatch lines shown in wiringInstructions() to doGet/doPost
 *   4. Deploy > Manage deployments > edit > New version
 *
 * SECURITY MODEL
 *   - Owners tab is the allowlist. No self-signup: unknown email => rejected.
 *   - Passwords: 16-byte random salt + HMAC-SHA256 keyed with AUTH_SECRET
 *     (a "pepper"), iterated WA_ROUNDS times. Plaintext is never stored or logged.
 *     Because the pepper lives in Script Properties and NOT in the sheet, a leak
 *     of the sheet alone does not enable offline cracking.
 *   - Sessions: stateless HMAC-signed token, payload.signature, 200-day expiry.
 *   - Keeper writes: token required, 5-max and one-per-round enforced SERVER-side,
 *     lock deadline enforced SERVER-side. UI enforcement is a convenience only.
 */

/* ================= CONFIG ================= */
const WA_SHEET_ID   = '1txXMABMobhOObWZKUJZ-yot7YtD5TgZny5Dxg1ucJbw';
const WA_OWNERS_TAB = 'Owners';
const WA_PICKS_TAB  = 'KeeperPicks';

const WA_ROUNDS      = 600;   // password stretch iterations (see benchmarkAuthHash)
const WA_SESSION_DAYS = 200;  // token lifetime — covers the whole season
const WA_MAX_KEEPERS  = 5;

// 24h before the Aug 30 2026 5:30pm MT draft
const WA_LOCK_ISO = '2026-08-29T17:30:00-06:00';

// Failed-login throttle
const WA_MAX_FAILS   = 5;
const WA_FAIL_WINDOW = 900; // seconds

/* League roster: team -> player -> keeper round value.
   Generated from the ROSTERS block in draftboard.html (source of truth for
   keeper cost). Used to enforce one-keeper-per-round on the server. */
const WA_ROUND_MAP = {"Mud Dogs":{"Jonathan Taylor":1,"Nico Collins":1,"Lamar Jackson":2,"Tony Pollard":3,"Matthew Golden":6,"Deebo Samuel":6,"George Pickens":7,"Quinshon Judkins":9,"Dak Prescott":9,"Blake Corum":10,"Philadelphia Eagles Defense":11,"Cam Little":14,"Bam Knight":16,"Theo Johnson":16,"Tank Dell":16,"Jake Tonges":16},"Syd Sweeney's Denim Jeans":{"Jahmyr Gibbs":1,"TreVeyon Henderson":1,"Chuba Hubbard":2,"CeeDee Lamb":3,"Emeka Egbuka":4,"Jalen Hurts":5,"Ricky Pearsall":5,"Michael Pittman Jr.":6,"Garrett Wilson":7,"Harold Fannin Jr.":8,"Jayden Reed":9,"Quentin Johnston":10,"Brian Thomas Jr.":11,"Jakobi Meyers":11,"Woody Marks":12,"Will Reichard":16,"Cleveland Browns Defense":16},"Bindgamer3":{"Puka Nacua":1,"A.J. Brown":1,"D'Andre Swift":2,"DJ Moore":3,"Trey McBride":4,"DK Metcalf":5,"Xavier Worthy":5,"Patrick Mahomes":6,"James Conner":7,"Caleb Williams":7,"Brock Bowers":8,"Javonte Williams":9,"Kenny Gainwell":11,"Cameron Dicker":13,"C.J. Stroud":13,"Oronde Gadsden":15,"Tre Tucker":16,"Josh Reynolds":16,"New Orleans Saints Defense":16},"Return of The Mac":{"De'Von Achane":1,"Tyreek Hill":1,"Ja'Marr Chase":2,"Zay Flowers":4,"George Kittle":4,"Travis Hunter":5,"James Cook III":6,"Jaylen Warren":7,"Jaxon Smith-Njigba":8,"Alec Pierce":8,"Chase Brown":9,"Zach Charbonnet":10,"Bhayshul Tuten":11,"Drake Maye":12,"Houston Texans Defense":14,"Andy Borregales":16,"Taysom Hill":16,"AJ Barner":16,"Michael Mayer":16},"Drake Draaaake?":{"Kyren Williams":1,"Josh Jacobs":1,"Josh Allen":2,"Tetairoa McMillan":3,"Drake London":4,"Rome Odunze":5,"Joe Mixon":7,"Jauan Jennings":8,"Rhamondre Stevenson":8,"Tucker Kraft":9,"Rico Dowdle":9,"Denver Broncos Defense":10,"Brandon Aiyuk":11,"Chris Boswell":12,"Luther Burden III":12,"Chris Rodriguez Jr.":13,"Dylan Sampson":15,"Dalton Schultz":16,"Emanuel Wilson":16},"Kweef Farts":{"Christian McCaffrey":1,"Terry McLaurin":1,"Breece Hall":2,"Tee Higgins":3,"Travis Kelce":6,"Jordan Addison":6,"Jacory Croskey-Merritt":7,"Tyler Warren":9,"J.K. Dobbins":10,"Chris Godwin Jr.":11,"Wan'Dale Robinson":11,"Bo Nix":12,"Jared Goff":12,"Detroit Lions Defense":14,"Jalen McMillan":15,"New England Patriots Defense":16,"Devin Neal":16,"Eddy Pineiro":16},"G. O. A. T.":{"Derrick Henry":1,"Malik Nabers":1,"Alvin Kamara":2,"Rashee Rice":4,"Kenneth Walker III":5,"Amon-Ra St. Brown":6,"Baker Mayfield":7,"Aaron Jones Sr.":8,"Brenton Strange":9,"Pittsburgh Steelers Defense":10,"Dallas Goedert":12,"Sam LaPorta":13,"Jayden Higgins":13,"Daniel Jones":16,"Troy Franklin":16,"Jason Myers":16,"Seattle Seahawks Defense":16,"Kayshon Boutte":16,"Riley Leonard":16},"Mean Machine":{"Saquon Barkley":1,"Omarion Hampton":1,"Davante Adams":2,"DeVonta Smith":3,"Cam Skattebo":7,"Colston Loveland":8,"Courtland Sutton":8,"Jameson Williams":9,"Kyle Monangai":9,"Justin Herbert":10,"Brock Purdy":10,"Jayden Daniels":11,"Los Angeles Rams Defense":14,"Khalil Shakir":15,"Hunter Henry":15,"Michael Carter":16,"New York Giants Defense":16,"Harrison Mevis":16,"Devin Singletary":16},"Bijan Mustard":{"Bijan Robinson":1,"Tyrone Tracy Jr.":1,"Mike Evans":2,"Travis Etienne Jr.":3,"RJ Harvey":3,"Stefon Diggs":4,"Justin Jefferson":5,"Ladd McConkey":7,"Jaxson Dart":9,"Jordan Mason":10,"Michael Wilson":10,"Dalton Kincaid":12,"Brandon Aubrey":13,"Sam Darnold":15,"Darren Waller":16,"Chicago Bears Defense":16},"THE Vagitarians":{"Ashton Jeanty":1,"Marvin Harrison Jr.":1,"Bucky Irving":2,"David Montgomery":3,"Jaylen Waddle":4,"Chris Olave":5,"Jerry Jeudy":6,"Christian Watson":7,"Joe Burrow":8,"Kyle Pitts Sr.":9,"Matthew Stafford":11,"Jake Ferguson":12,"Jake Bates":14,"Kareem Hunt":16,"Jacksonville Jaguars Defense":16,"Chimere Dike":16}};

/* Seed roster for setupAuth(). email | display name | team | commish */
const WA_SEED = [
  ['chadtrozzi@yahoo.com',            'Chad',   'Mud Dogs',                  false],
  ['tbalzer9@yahoo.com',              'Balzer', 'Drake Draaaake?',           false],
  ['justinhorn00@gmail.com',          'Justin', 'G. O. A. T.',               false],
  ['bbianco27@icloud.com',            'Bianco', 'Mean Machine',              false],
  ['dhighhh@gmail.com',               'D. High','THE Vagitarians',           false],
  ['alexhannigan@comcast.net',        'Alex',   'Kweef Farts',               false],
  ['nickolauswork@gmail.com',         'Nick',   'Bindgamer3',                false],
  ['jorziemianski@aol.com',           'Jordan', 'Return of The Mac',         false],
  ['boydgkirk@gmail.com',             'Boyd',   "Syd Sweeney's Denim Jeans", false],
  ['bryan.weimerskirch@gmail.com',    'Bryan',  'Bijan Mustard',             true ]
];

const WA_OWNER_HEADERS = [
  'email','name','team','is_commish','pass_hash','pass_salt','created_at','last_login','login_count', 'franchise_id'
];
const WA_PICK_HEADERS = [
  'team','email','players_json','count','updated_at','updated_by'
];

/* ================= SMALL HELPERS ================= */

function waSS_()  { return SpreadsheetApp.openById(WA_SHEET_ID); }
function waJson_(o){
  return ContentService.createTextOutput(JSON.stringify(o))
    .setMimeType(ContentService.MimeType.JSON);
}
function waErr_(msg, code){ return waJson_({ ok:false, error:msg, code:code||'error' }); }
function waNormEmail_(s){ return String(s||'').trim().toLowerCase(); }
function waStrBytes_(s){ return Utilities.newBlob(String(s)).getBytes(); }
function waNow_(){ return new Date(); }
function waLockDate_(){ return new Date(WA_LOCK_ISO); }
function waIsLocked_(){ return waNow_().getTime() >= waLockDate_().getTime(); }

function waProps_(){ return PropertiesService.getScriptProperties(); }
function waSecret_(){
  const p = waProps_();
  let s = p.getProperty('AUTH_SECRET');
  if (!s) {
    s = Utilities.base64Encode(waRandomBytes_(32));
    p.setProperty('AUTH_SECRET', s);
  }
  return s;
}
function waRandomBytes_(n){
  // Apps Script has no CSPRNG; mix Math.random with a UUID + high-res-ish clock,
  // then run it through SHA-256 so the output is uniformly distributed.
  let seed = Utilities.getUuid() + '|' + new Date().getTime() + '|';
  for (let i=0;i<n;i++) seed += Math.random().toString(36).slice(2);
  let out = [];
  let block = 0;
  while (out.length < n) {
    const d = Utilities.computeDigest(
      Utilities.DigestAlgorithm.SHA_256, seed + '#' + (block++) + Utilities.getUuid());
    out = out.concat(d);
  }
  return out.slice(0, n);
}

/* ================= TAB ACCESS ================= */

function waTab_(name, headers){
  const ss = waSS_();
  let sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1,1,1,headers.length).setValues([headers]).setFontWeight('bold');
    sh.setFrozenRows(1);
  }
  return sh;
}
function waOwnersTab_(){ return waTab_(WA_OWNERS_TAB, WA_OWNER_HEADERS); }
function waPicksTab_ (){ return waTab_(WA_PICKS_TAB,  WA_PICK_HEADERS ); }

/** Returns {row, rec} for an email, or null. row is 1-based sheet row. */
function waFindOwner_(email){
  const sh = waOwnersTab_();
  const last = sh.getLastRow();
  if (last < 2) return null;
  const vals = sh.getRange(2,1,last-1,WA_OWNER_HEADERS.length).getValues();
  const want = waNormEmail_(email);
  for (let i=0;i<vals.length;i++){
    if (waNormEmail_(vals[i][0]) === want) {
      const r = {};
      WA_OWNER_HEADERS.forEach((h,k)=>{ r[h] = vals[i][k]; });
      return { row: i+2, rec: r };
    }
  }
  return null;
}

/* ================= PASSWORD HASHING ================= */

function waHash_(password, saltB64){
  const keyBytes = waStrBytes_(waSecret_());
  let d = Utilities.computeHmacSha256Signature(
    Utilities.base64Decode(saltB64).concat(waStrBytes_(password)), keyBytes);
  for (let i=1;i<WA_ROUNDS;i++){
    d = Utilities.computeHmacSha256Signature(d, keyBytes);
  }
  return Utilities.base64Encode(d);
}

/** Constant-time-ish string compare. */
function waSafeEq_(a, b){
  a = String(a||''); b = String(b||'');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i=0;i<a.length;i++) diff |= (a.charCodeAt(i) ^ b.charCodeAt(i));
  return diff === 0;
}

/* ================= SESSION TOKENS ================= */

function waB64u_(s){
  return Utilities.base64EncodeWebSafe(s).replace(/=+$/,'');
}
function waB64uBytes_(bytes){
  return Utilities.base64EncodeWebSafe(bytes).replace(/=+$/,'');
}
function waSign_(payload){
  return waB64uBytes_(
    Utilities.computeHmacSha256Signature(waStrBytes_(payload), waStrBytes_(waSecret_())));
}
function waMakeToken_(rec){
  const exp = waNow_().getTime() + WA_SESSION_DAYS*24*60*60*1000;
  const payload = waB64u_(JSON.stringify({
    e: waNormEmail_(rec.email),
    n: String(rec.name||''),
    t: String(rec.team||''),
    c: !!rec.is_commish,
    x: exp
  }));
  return payload + '.' + waSign_(payload);
}
/** Returns the decoded claim object, or null if invalid/expired. */
function waVerifyToken_(token){
  if (!token || String(token).indexOf('.') < 0) return null;
  const parts = String(token).split('.');
  if (parts.length !== 2) return null;
  if (!waSafeEq_(parts[1], waSign_(parts[0]))) return null;
  let claim;
  try {
    claim = JSON.parse(Utilities.newBlob(Utilities.base64DecodeWebSafe(parts[0])).getDataAsString());
  } catch (err) { return null; }
  if (!claim || !claim.x || waNow_().getTime() > Number(claim.x)) return null;
  return claim;
}

/* ================= THROTTLE ================= */

function waFailKey_(email){
  return 'wafail_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, waNormEmail_(email))).slice(0,20);
}
function waFailCount_(email){
  const v = CacheService.getScriptCache().get(waFailKey_(email));
  return v ? Number(v) : 0;
}
function waBumpFail_(email){
  const c = CacheService.getScriptCache();
  c.put(waFailKey_(email), String(waFailCount_(email)+1), WA_FAIL_WINDOW);
}
function waClearFail_(email){
  CacheService.getScriptCache().remove(waFailKey_(email));
}

/* ================= PUBLIC HANDLERS ================= */

/** GET ?action=auth_ping — no auth. Lets the front end learn lock state. */
function waPing_(){
  return waJson_({
    ok: true,
    now: waNow_().toISOString(),
    lock_at: waLockDate_().toISOString(),
    locked: waIsLocked_(),
    max_keepers: WA_MAX_KEEPERS
  });
}

/**
 * POST action=auth_status&email=...
 * Tells the UI whether to show "set your password" or "log in".
 * Deliberately reveals league membership — 10 known people, and the UX win
 * (no confusing dead-ends) is worth more than hiding it.
 */
function waStatus_(e){
  const email = waNormEmail_(e.parameter.email);
  if (!email) return waErr_('Email required','no_email');
  const found = waFindOwner_(email);
  if (!found) return waJson_({ ok:true, known:false });
  return waJson_({
    ok: true,
    known: true,
    has_password: !!String(found.rec.pass_hash||'').trim(),
    name: found.rec.name,
    team: found.rec.team
  });
}

/** POST action=auth_signup&email=&password=&name=(optional) */
function waSignup_(e){
  const email = waNormEmail_(e.parameter.email);
  const pw    = String(e.parameter.password||'');
  const name  = String(e.parameter.name||'').trim();

  if (!email) return waErr_('Email required','no_email');
  if (pw.length < 6) return waErr_('Password must be at least 6 characters','weak');

  const found = waFindOwner_(email);
  if (!found) return waErr_('That email is not on the league list. Text the commish.','not_member');
  if (String(found.rec.pass_hash||'').trim()) {
    return waErr_('You already set a password — log in instead.','already');
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    const salt = Utilities.base64Encode(waRandomBytes_(16));
    const hash = waHash_(pw, salt);
    const sh = waOwnersTab_();
    const now = waNow_();
    sh.getRange(found.row, 5).setValue(hash);          // pass_hash
    sh.getRange(found.row, 6).setValue(salt);          // pass_salt
    sh.getRange(found.row, 7).setValue(now);           // created_at
    sh.getRange(found.row, 8).setValue(now);           // last_login
    sh.getRange(found.row, 9).setValue(1);             // login_count
    if (name) sh.getRange(found.row, 2).setValue(name);
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  const rec = waFindOwner_(email).rec;
  if (name) rec.name = name;
  waClearFail_(email);
  return waJson_({ ok:true, token: waMakeToken_(rec), user: waPublicUser_(rec) });
}

/** POST action=auth_login&email=&password= */
function waLogin_(e){
  const email = waNormEmail_(e.parameter.email);
  const pw    = String(e.parameter.password||'');
  if (!email || !pw) return waErr_('Email and password required','missing');

  if (waFailCount_(email) >= WA_MAX_FAILS) {
    return waErr_('Too many attempts. Wait 15 minutes and try again.','throttled');
  }

  const found = waFindOwner_(email);
  if (!found) { waBumpFail_(email); return waErr_('Email or password is wrong.','bad_creds'); }

  const stored = String(found.rec.pass_hash||'').trim();
  const salt   = String(found.rec.pass_salt||'').trim();
  if (!stored || !salt) {
    return waErr_('No password set yet — use "First time here?" to create one.','no_password');
  }
  if (!waSafeEq_(stored, waHash_(pw, salt))) {
    waBumpFail_(email);
    return waErr_('Email or password is wrong.','bad_creds');
  }

  waClearFail_(email);
  const sh = waOwnersTab_();
  sh.getRange(found.row, 8).setValue(waNow_());
  sh.getRange(found.row, 9).setValue(Number(found.rec.login_count||0)+1);

  return waJson_({ ok:true, token: waMakeToken_(found.rec), user: waPublicUser_(found.rec) });
}

function waPublicUser_(rec){
  return {
    email: waNormEmail_(rec.email),
    name:  String(rec.name||''),
    team:  String(rec.team||''),
    is_commish: !!rec.is_commish,
    fid: String(rec.franchise_id || '')
  };
}

/** POST action=auth_me&token= — revalidates and returns identity + own picks. */
function waMe_(e){
  const claim = waVerifyToken_(e.parameter.token);
  if (!claim) return waErr_('Session expired — log in again.','bad_token');
  const found = waFindOwner_(claim.e);
  if (!found) return waErr_('Account not found.','not_member');
  return waJson_({
    ok: true,
    user: waPublicUser_(found.rec),
    picks: waPicksForTeam_(found.rec.team),
    locked: waIsLocked_(),
    lock_at: waLockDate_().toISOString()
  });
}

/* ================= KEEPER PICKS ================= */

/** Row number (1-based) of a team's KeeperPicks row, or 0. Always the FIRST match —
    every reader and writer must agree on which row is canonical. */
function waPicksRow_(team){
  const sh = waPicksTab_();
  const last = sh.getLastRow();
  if (last < 2) return 0;
  const teams = sh.getRange(2,1,last-1,1).getValues();
  for (let i=0;i<teams.length;i++){
    if (String(teams[i][0]) === String(team)) return i+2;
  }
  return 0;
}
function waPicksForTeam_(team){
  const row = waPicksRow_(team);
  if (!row) return [];
  const raw = waPicksTab_().getRange(row,3).getValue();
  try { return JSON.parse(raw) || []; } catch(err){ return []; }
}
/** Single writer for KeeperPicks: replace the team's row in place, or append one. */
function waWritePicks_(team, email, clean, who){
  const sh = waPicksTab_();
  const row = [ team, waNormEmail_(email), JSON.stringify(clean),
                clean.length, waNow_(), who || waNormEmail_(email) ];
  const at = waPicksRow_(team);
  if (at) sh.getRange(at,1,1,row.length).setValues([row]);
  else    sh.appendRow(row);
}

/** Resolve a keeper round: roster map first, else caller-supplied FA value. */
function waResolveRound_(team, playerName, claimedRound){
  const map = WA_ROUND_MAP[team] || {};
  if (Object.prototype.hasOwnProperty.call(map, playerName)) {
    return { round: map[playerName], fa: false };
  }
  const r = parseInt(claimedRound, 10);
  if (r >= 1 && r <= 16) return { round: r, fa: true };
  return { round: null, fa: true };
}

/**
 * POST action=keeper_save&token=&players=<json>
 * players: [{name, pos, round}]  — round only trusted for off-roster (FA) adds.
 * Replaces that team's declaration wholesale so owners can edit freely.
 */
function waKeeperSave_(e){
  const claim = waVerifyToken_(e.parameter.token);
  if (!claim) return waErr_('Session expired — log in again.','bad_token');

  const found = waFindOwner_(claim.e);
  if (!found) return waErr_('Account not found.','not_member');
  const isCommish = !!found.rec.is_commish;

  // Commish may save on behalf of another team; everyone else is locked to their own.
  let team = String(found.rec.team||'');
  if (isCommish && e.parameter.team) team = String(e.parameter.team);

  if (waIsLocked_() && !isCommish) {
    return waErr_('Keepers locked at ' + waLockDate_().toLocaleString() +
                  ' (24h before the draft). Text the commish if you need a change.','locked');
  }

  let players;
  try { players = JSON.parse(e.parameter.players || '[]'); }
  catch (err) { return waErr_('Could not read your picks.','bad_json'); }
  if (!Array.isArray(players)) return waErr_('Could not read your picks.','bad_json');

  if (players.length > WA_MAX_KEEPERS) {
    return waErr_('Max ' + WA_MAX_KEEPERS + ' keepers — you sent ' + players.length + '.','too_many');
  }

  // Validate: no dupes, resolve rounds, enforce one per round.
  const seen = {}, byRound = {}, clean = [];
  for (let i=0;i<players.length;i++){
    const p = players[i] || {};
    const nm = String(p.name||'').trim();
    if (!nm) return waErr_('One of your picks has no player name.','bad_player');
    const nk = nm.toLowerCase();
    if (seen[nk]) return waErr_('You listed ' + nm + ' twice.','dupe');
    seen[nk] = true;

    const rr = waResolveRound_(team, nm, p.round);
    if (rr.round === null) {
      return waErr_(nm + ' is not on your roster and has no round value.','no_round');
    }
    if (byRound[rr.round]) {
      return waErr_('Only one keeper per round — ' + nm + ' and ' +
                    byRound[rr.round] + ' are both Round ' + rr.round + '.','round_conflict');
    }
    byRound[rr.round] = nm;
    clean.push({ name: nm, pos: String(p.pos||''), round: rr.round, fa: rr.fa });
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    waWritePicks_(team, claim.e, clean);
    waMirrorToLegacy_(team, clean);   // keep ?action=keepers in step
    SpreadsheetApp.flush();
  } finally {
    lock.releaseLock();
  }

  return waJson_({ ok:true, team: team, count: clean.length, players: clean });
}

/** GET ?action=keepers_v2 — every team's declaration, for the board. */
function waKeepersV2_(){
  const sh = waPicksTab_();
  const last = sh.getLastRow();
  const teams = {};
  if (last >= 2) {
    const vals = sh.getRange(2,1,last-1,WA_PICK_HEADERS.length).getValues();
    vals.forEach(function(v){
      if (!v[0]) return;
      let arr = [];
      try { arr = JSON.parse(v[2]) || []; } catch(err){ arr = []; }
      teams[String(v[0])] = {
        players: arr,
        count: arr.length,
        updated_at: v[4] ? new Date(v[4]).toISOString() : null
      };
    });
  }
  return waJson_({
    ok: true, teams: teams,
    locked: waIsLocked_(), lock_at: waLockDate_().toISOString()
  });
}

/* ================= SETUP / OPS ================= */

/** Run this ONCE from the editor. Idempotent — safe to re-run. */
function setupAuth(){
  const secret = waSecret_();
  const sh = waOwnersTab_();
  waPicksTab_();

  let added = 0, existing = 0;
  WA_SEED.forEach(function(s){
    const found = waFindOwner_(s[0]);
    if (found) {
      // refresh name/team/commish but NEVER touch an existing password
      sh.getRange(found.row,2).setValue(s[1]);
      sh.getRange(found.row,3).setValue(s[2]);
      sh.getRange(found.row,4).setValue(s[3]);
      existing++;
    } else {
      sh.appendRow([ s[0], s[1], s[2], s[3], '', '', '', '', 0 ]);
      added++;
    }
  });
  sh.autoResizeColumns(1, WA_OWNER_HEADERS.length);
  SpreadsheetApp.flush();

  const msg = 'setupAuth OK\n' +
    '  AUTH_SECRET: ' + (secret ? 'present (' + secret.length + ' chars)' : 'MISSING') + '\n' +
    '  Owners tab: ' + added + ' added, ' + existing + ' refreshed\n' +
    '  KeeperPicks tab: ready\n' +
    '  Lock at: ' + waLockDate_().toString() + '\n' +
    '  Teams in round map: ' + Object.keys(WA_ROUND_MAP).length;
  Logger.log(msg);
  return msg;
}

/** Confirms login latency is acceptable before we ship. */
function benchmarkAuthHash(){
  const salt = Utilities.base64Encode(waRandomBytes_(16));
  const t0 = new Date().getTime();
  waHash_('correct horse battery staple', salt);
  const ms = new Date().getTime() - t0;
  const msg = WA_ROUNDS + ' rounds took ' + ms + 'ms per login attempt.';
  Logger.log(msg);
  return msg;
}

/** Sanity check: sign a token, verify it, reject a tampered one. */
function selfTestAuth(){
  const rec = { email:'test@example.com', name:'T', team:'Mud Dogs', is_commish:false };
  const tok = waMakeToken_(rec);
  const good = waVerifyToken_(tok);
  const bad  = waVerifyToken_(tok.slice(0,-2) + 'xx');
  const salt = Utilities.base64Encode(waRandomBytes_(16));
  const h    = waHash_('hunter2', salt);
  const msg = [
    'token verify      : ' + (good && good.e === 'test@example.com' ? 'PASS' : 'FAIL'),
    'tamper rejected   : ' + (bad === null ? 'PASS' : 'FAIL'),
    'hash match        : ' + (waSafeEq_(h, waHash_('hunter2', salt)) ? 'PASS' : 'FAIL'),
    'wrong pw rejected : ' + (!waSafeEq_(h, waHash_('hunter3', salt)) ? 'PASS' : 'FAIL'),
    'round map teams   : ' + Object.keys(WA_ROUND_MAP).length + ' (expect 10)',
    'locked now        : ' + waIsLocked_() + ' (expect false until Aug 29)'
  ].join('\n');
  Logger.log(msg);
  return msg;
}

/** Commissioner escape hatch: clear someone's password so they can re-register. */
function resetOwnerPassword(email){
  const found = waFindOwner_(email);
  if (!found) { Logger.log('No such owner: ' + email); return 'No such owner: ' + email; }
  const sh = waOwnersTab_();
  sh.getRange(found.row,5).setValue('');
  sh.getRange(found.row,6).setValue('');
  waClearFail_(email);
  const msg = 'Cleared password for ' + email + ' — they can set a new one on next visit.';
  Logger.log(msg);
  return msg;
}

/** Prints the exact lines to paste into doGet/doPost. */
function wiringInstructions(){
  const msg = [
    'In doGet(e), alongside the other  if (action === ...)  lines:',
    "  if (action === 'auth_ping')   return waPing_();",
    "  if (action === 'keepers_v2')  return waKeepersV2_();",
    '',
    'In doPost(e), alongside the other  if (action === ...)  lines:',
    "  if (action === 'auth_status') return waStatus_(e);",
    "  if (action === 'auth_signup') return waSignup_(e);",
    "  if (action === 'auth_login')  return waLogin_(e);",
    "  if (action === 'auth_me')     return waMe_(e);",
    "  if (action === 'keeper_save') return waKeeperSave_(e);"
  ].join('\n');
  Logger.log(msg);
  return msg;
}

/* ============ LEGACY "Keepers" TAB BRIDGE ============
   The site had a Keepers tab (served by ?action=keepers) long before KeeperPicks
   existed. Two sources of truth would show four teams as "declared" on the
   countdown card while the new per-team bars read 0/5 — so those owners would
   re-pick. These helpers (a) migrate the old tab into KeeperPicks once, and
   (b) mirror every future keeper_save back to the old tab so both agree.
   Column positions are DETECTED, not assumed, because the tab predates this code. */

/** Locate the legacy keepers tab and work out which columns hold team + player. */
function waLegacyInfo_(){
  const ss = waSS_();
  const names = ['Keepers','keepers','Keeper','KEEPERS'];
  let sh = null;
  for (let i=0;i<names.length;i++){ sh = ss.getSheetByName(names[i]); if (sh) break; }
  if (!sh) return null;

  const last = sh.getLastRow(), lastC = sh.getLastColumn();
  if (last < 1 || lastC < 1) return { sheet: sh, teamCol: 0, playerCol: 0, headerRow: 1, rows: [] };
  const vals = sh.getRange(1,1,last,lastC).getValues();

  // team column = the one with the most cells matching a known team name
  const teams = Object.keys(WA_ROUND_MAP);
  let teamCol = -1, best = 0;
  for (let c=0;c<lastC;c++){
    let hits = 0;
    for (let r=0;r<vals.length;r++){
      if (teams.indexOf(String(vals[r][c]).trim()) > -1) hits++;
    }
    if (hits > best) { best = hits; teamCol = c; }
  }
  if (teamCol < 0) return { sheet: sh, teamCol: 0, playerCol: 0, headerRow: 1, rows: [] };

  // player column = the one with the most cells matching a player on that row's team
  let playerCol = -1, pbest = 0;
  for (let c=0;c<lastC;c++){
    if (c === teamCol) continue;
    let hits = 0;
    for (let r=0;r<vals.length;r++){
      const t = String(vals[r][teamCol]).trim();
      const map = WA_ROUND_MAP[t];
      if (map && Object.prototype.hasOwnProperty.call(map, String(vals[r][c]).trim())) hits++;
    }
    if (hits > pbest) { pbest = hits; playerCol = c; }
  }
  if (playerCol < 0) playerCol = (teamCol === 0 ? 1 : 0);

  // first row that actually carries a team name is where data starts
  let headerRow = 1;
  for (let r=0;r<vals.length;r++){
    if (teams.indexOf(String(vals[r][teamCol]).trim()) > -1) { headerRow = r; break; }
  }

  const rows = [];
  for (let r=headerRow;r<vals.length;r++){
    const t = String(vals[r][teamCol]).trim();
    const p = String(vals[r][playerCol]).trim();
    if (t && p && teams.indexOf(t) > -1) rows.push({ row: r+1, team: t, player: p });
  }
  return { sheet: sh, teamCol: teamCol+1, playerCol: playerCol+1, headerRow: headerRow+1, rows: rows, width: lastC };
}

/** Replace a team's rows in the legacy tab with its current declaration. */
function waMirrorToLegacy_(team, clean){
  try {
    const info = waLegacyInfo_();
    if (!info || !info.teamCol) return;
    const sh = info.sheet;
    // delete existing rows for this team, bottom-up so indices stay valid
    const mine = info.rows.filter(function(r){ return r.team === team; }).map(function(r){ return r.row; });
    mine.sort(function(a,b){ return b-a; }).forEach(function(rowNum){ sh.deleteRow(rowNum); });
    // append the new set
    const width = Math.max(info.width || 2, info.teamCol, info.playerCol);
    clean.forEach(function(p){
      const row = new Array(width).fill('');
      row[info.teamCol-1]   = team;
      row[info.playerCol-1] = p.name;
      sh.appendRow(row);
    });
  } catch (err) {
    Logger.log('waMirrorToLegacy_ failed for ' + team + ': ' + err);
  }
}

/**
 * ONE-TIME (idempotent): copy the legacy Keepers tab into KeeperPicks.
 * Never overwrites a team that already has picks in KeeperPicks.
 * Caps at 5, drops duplicates, and reports any round conflicts instead of guessing.
 */
function migrateKeepersToPicks(){
  const info = waLegacyInfo_();
  if (!info) return 'No legacy Keepers tab found — nothing to migrate.';
  if (!info.rows.length) {
    return 'Legacy tab found ("' + info.sheet.getName() + '") but no team/player rows detected.';
  }

  const byTeam = {};
  info.rows.forEach(function(r){ (byTeam[r.team] = byTeam[r.team] || []).push(r.player); });

  const log = [];
  log.push('Legacy tab "' + info.sheet.getName() + '": team col ' + info.teamCol +
           ', player col ' + info.playerCol + ', ' + info.rows.length + ' rows, ' +
           Object.keys(byTeam).length + ' teams.');

  Object.keys(byTeam).forEach(function(team){
    const existing = waPicksForTeam_(team);
    if (existing && existing.length) {
      log.push('  SKIP ' + team + ' — already has ' + existing.length + ' pick(s) in KeeperPicks.');
      return;
    }
    const map = WA_ROUND_MAP[team] || {};
    const seen = {}, byRound = {}, clean = [], problems = [];
    byTeam[team].forEach(function(nm){
      if (clean.length >= WA_MAX_KEEPERS) { problems.push('over cap: ' + nm); return; }
      const key = nm.toLowerCase();
      if (seen[key]) { problems.push('duplicate: ' + nm); return; }
      if (!Object.prototype.hasOwnProperty.call(map, nm)) { problems.push('not on roster: ' + nm); return; }
      const rd = map[nm];
      if (byRound[rd]) { problems.push('round ' + rd + ' clash: ' + nm + ' vs ' + byRound[rd]); return; }
      seen[key] = true; byRound[rd] = nm;
      clean.push({ name: nm, pos: '', round: rd, fa: false });
    });

    if (!clean.length) { log.push('  ' + team + ': nothing usable. ' + problems.join('; ')); return; }

    waWritePicks_(team, '', clean, 'migration');
    log.push('  OK ' + team + ': ' + clean.length + ' -> ' +
             clean.map(function(p){ return 'R' + p.round + ' ' + p.name; }).join(', ') +
             (problems.length ? '  [' + problems.join('; ') + ']' : ''));
  });

  SpreadsheetApp.flush();
  const msg = log.join('\n');
  Logger.log(msg);
  return msg;
}

/** Read-only: shows what the migration WOULD do, without writing anything. */
function previewKeeperMigration(){
  const info = waLegacyInfo_();
  if (!info) { Logger.log('No legacy tab.'); return 'No legacy tab.'; }
  const byTeam = {};
  info.rows.forEach(function(r){ (byTeam[r.team] = byTeam[r.team] || []).push(r.player); });
  const out = ['tab="' + info.sheet.getName() + '" teamCol=' + info.teamCol +
               ' playerCol=' + info.playerCol + ' rows=' + info.rows.length];
  Object.keys(byTeam).forEach(function(t){
    const map = WA_ROUND_MAP[t] || {};
    out.push('  ' + t + ' (' + byTeam[t].length + '): ' + byTeam[t].map(function(n){
      return (Object.prototype.hasOwnProperty.call(map,n) ? 'R'+map[n] : '??') + ' ' + n;
    }).join(', '));
  });
  const msg = out.join('\n');
  Logger.log(msg);
  return msg;
}
