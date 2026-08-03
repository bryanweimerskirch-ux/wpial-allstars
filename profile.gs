/**
 * profile.gs — franchise identity + owner profiles (P0: migration + read).
 *
 * WHY
 * The team-name string was the primary key of the whole league. This file introduces a
 * stable `franchise_id` and a place for owner-editable display data, WITHOUT changing
 * any existing key. `Owners.team` stays exactly as it is and remains the join key for
 * KeeperPicks, Watchlist, tokens and every existing handler.
 *
 * WHERE TEAM NAMES COME FROM
 * ESPN. Owners rename their team in the ESPN app and the site follows, hourly. There is
 * no rename UI and no rename field — which also means no rename validation, no name
 * collisions, no rate limit, and no way for the site and ESPN to disagree.
 *
 * The match to ESPN is by **espn_team_id**, never by name. ESPN ids survive renames;
 * names are the one thing we cannot trust. `Profiles.team_name` is a CACHE of the last
 * name ESPN reported, so an ESPN outage leaves the site looking completely normal.
 *
 * Owner-editable in the profile UI: first_name, colors, logo, jersey, motto. Not the
 * team name.
 *
 * Wiring: ONE line in doPost (Code.gs), in the guarded form the rest of the chain uses —
 *   if (e && e.parameter && e.parameter.action === 'profiles_all') return waProfilesAll_(e);
 *
 * ALSO REQUIRED, in auth.gs (one line): add the franchise id to the public user object
 * returned by waPublicUser_, so the client can compare identities instead of strings:
 *   fid: String(rec.franchise_id || '')
 * Nothing breaks if this is skipped — the client falls back to the old string compare —
 * but do it, so the comparison is on identity rather than on a string that merely
 * happens to be stable.
 *
 * RUN ONCE from the editor: setupFranchises()   (idempotent, safe to re-run)
 * It also installs the hourly ESPN name-sync trigger and runs the first sync.
 * Ops helpers: previewFranchises(), previewProfiles(), previewEspnTeams(), syncEspnNamesNow()
 *
 * Helpers used from auth.gs / admin.gs: waVerifyToken_, waFindOwner_, waJson_, waErr_,
 * waNormEmail_, waTruthy_, WA_OWNER_HEADERS. Tab access is deliberately local rather
 * than via waTab_, so this file has no dependency on a helper signature.
 */

var WA_PROFILE_TAB = 'Profiles';
var WA_PROFILE_HEADERS = ['franchise_id', 'espn_team_id', 'email', 'first_name', 'team_name',
  'logo_kind', 'logo_data', 'color_primary', 'color_secondary', 'color_accent', 'jersey_json',
  'motto', 'logo_prompt', 'updated_at', 'updated_by'];

/* ESPN is the source of truth for TEAM NAMES. Owners rename in the ESPN app; this file
   reads the change and the site follows. Two consequences worth stating plainly:

   1. `team_name` in the Profiles tab is a CACHE, not an input. Nothing owner-facing may
      write it. It exists so the site renders normally when ESPN is unreachable.
   2. Franchises are matched to ESPN by **espn_team_id**, never by name. ESPN team ids
      are stable across renames; names are exactly what we cannot trust. Matching by name
      is what produced an 11-row standings table and a silently vanishing all-time series
      line. The id is established once, in setupFranchises(), while the names still agree.

   Owner-editable, in the profile UI: first_name, colors, logo, jersey, motto. Not the
   team name. */
/* Code.gs already defines ESPN_LEAGUE_ID and ESPN_SEASON and uses them for the
   espn_schedule and insider feeds. Prefer those so there is one source of truth; these
   are only the fallback if that ever changes. Script Properties override both. */
var WA_ESPN_LEAGUE_ID = '11564022';
var WA_ESPN_SEASON = 2026;
var WA_ESPN_SYNC_PROP = 'ESPN_NAMES_SYNCED_AT';

var WA_NAMEHIST_TAB = 'NameHistory';
var WA_NAMEHIST_HEADERS = ['franchise_id', 'field', 'old_value', 'new_value', 'changed_at', 'changed_by'];

/** Frozen assignment. canon MUST match Owners.team exactly. Order matches the draft
 *  order only because that made the ids reproducible from the code — nothing may derive
 *  draft order from a franchise id.
 *  `priors` are the historical names already public in the lineage ribbons on index.html.
 *  Deliberately absent: the name Bindgamer3 played under before the July privacy wipe. */
var WA_FRANCHISES = [
  { fid: 'f01', canon: 'Drake Draaaake?', priors: ['Najee Germany', 'Sutton My Face', 'Team Balzer'], p: '#F4C430', s: '#E8862E', a: '#FFDE59' },
  { fid: 'f02', canon: 'Kweef Farts', priors: ['Injured Reserve', 'My Dick hERTZ', 'Under The InfluWENTZ'], p: '#9FB8C7', s: '#6E8B9A', a: '#F2F7FA' },
  { fid: 'f03', canon: "Syd Sweeney's Denim Jeans", priors: ["Sydney Sweeney's Fat T!ts", 'Wet Chops'], p: '#3B5F8A', s: '#28405E', a: '#D9C24A' },
  { fid: 'f04', canon: 'G. O. A. T.', priors: [], p: '#C9A24B', s: '#222222', a: '#F3EEDD' },
  { fid: 'f05', canon: 'THE Vagitarians', priors: [], p: '#3E9F5C', s: '#1B3B12', a: '#8FE07A' },
  { fid: 'f06', canon: 'Mud Dogs', priors: [], p: '#7A5230', s: '#5C3A1E', a: '#F2E2C4' },
  { fid: 'f07', canon: 'Bindgamer3', priors: [], p: '#4C4C6D', s: '#D64545', a: '#E4E4EC' },
  { fid: 'f08', canon: 'Bijan Mustard', priors: ['Bench Taylor Swift', 'Mr. Necksock'], p: '#E8A93C', s: '#7A3B12', a: '#FFF8E1' },
  { fid: 'f09', canon: 'Mean Machine', priors: [], p: '#5A5A5A', s: '#E63946', a: '#CFCFCF' },
  { fid: 'f10', canon: 'Return of The Mac', priors: [], p: '#2E5C8A', s: '#F4C430', a: '#EAF1F8' }
];

/* ---------------------------------------------------------------- infrastructure */

/** The spreadsheet. This project is NOT container-bound — Code.gs reaches the sheet with
 *  SpreadsheetApp.openById(SHEET_ID), and getActive() would return null here. Falls back
 *  to getActive() only so the file stays runnable if it is ever bound. */
function waProfSS_() {
  try {
    if (typeof SHEET_ID === 'string' && SHEET_ID) return SpreadsheetApp.openById(SHEET_ID);
  } catch (err) {}
  return SpreadsheetApp.getActive();
}

/** Get-or-create a tab and guarantee its header row. Local on purpose (see header). */
function waProfSheet_(name, headers) {
  var ss = waProfSS_();
  var sh = ss.getSheetByName(name);
  if (!sh) {
    sh = ss.insertSheet(name);
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
    return sh;
  }
  if (sh.getLastRow() === 0) {
    sh.getRange(1, 1, 1, headers.length).setValues([headers]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/** Same normalization the client uses, so both sides agree on what "the same name" means. */
function waProfNorm_(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^\s+|\s+$/g, '');
}

function waProfIndex_(headers) {
  var idx = {};
  headers.forEach(function (h, k) { idx[h] = k; });
  return idx;
}

/** canon (or any historical name) -> franchise record from the frozen table. */
function waFranchiseByName_(name) {
  var n = waProfNorm_(name);
  if (!n) return null;
  for (var i = 0; i < WA_FRANCHISES.length; i++) {
    var f = WA_FRANCHISES[i];
    if (waProfNorm_(f.canon) === n || f.fid === String(name).trim()) return f;
    for (var j = 0; j < f.priors.length; j++) if (waProfNorm_(f.priors[j]) === n) return f;
  }
  return null;
}

/* ---------------------------------------------------------------- ESPN */

/**
 * Current team names straight from ESPN, keyed by ESPN team id.
 * Returns { ok:true, teams:{ '1':'Mud Dogs', ... } } or { ok:false, error:'…' }.
 * Never throws — every caller has a sane fallback and an ESPN outage must not take the
 * site down. The league is private, so this needs the ESPN_S2 / ESPN_SWID cookies that
 * are already in Script Properties for espn_schedule.
 */
function waEspnTeams_() {
  var props = PropertiesService.getScriptProperties();
  var s2 = props.getProperty('ESPN_S2');
  var swid = props.getProperty('ESPN_SWID');
  if (!s2 || !swid) return { ok: false, error: 'ESPN_S2 / ESPN_SWID not set' };

  var league = props.getProperty('ESPN_LEAGUE_ID') ||
               (typeof ESPN_LEAGUE_ID !== 'undefined' ? ESPN_LEAGUE_ID : WA_ESPN_LEAGUE_ID);
  var season = props.getProperty('ESPN_SEASON') ||
               (typeof ESPN_SEASON !== 'undefined' ? ESPN_SEASON : WA_ESPN_SEASON);
  var paths = [
    'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '/segments/0/leagues/' + league + '?view=mTeam',
    'https://fantasy.espn.com/apis/v3/games/ffl/seasons/' + season + '/segments/0/leagues/' + league + '?view=mTeam'
  ];
  var opts = {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Cookie': 'espn_s2=' + s2 + '; SWID=' + swid, 'Accept': 'application/json' }
  };

  for (var i = 0; i < paths.length; i++) {
    try {
      var res = UrlFetchApp.fetch(paths[i], opts);
      if (res.getResponseCode() !== 200) continue;
      var data = JSON.parse(res.getContentText());
      var list = data && data.teams;
      if (!list || !list.length) continue;
      var teams = {};
      for (var t = 0; t < list.length; t++) {
        var tm = list[t];
        /* ESPN moved from location+nickname to a single `name` around 2023. Support both. */
        var nm = String(tm.name || ((tm.location || '') + ' ' + (tm.nickname || ''))).replace(/\s+/g, ' ');
        nm = nm.replace(/^\s+|\s+$/g, '');
        if (tm.id != null && nm) teams[String(tm.id)] = nm;
      }
      if (Object.keys(teams).length) return { ok: true, teams: teams };
    } catch (err) { /* try the next host */ }
  }
  return { ok: false, error: 'ESPN unreachable or returned no teams' };
}

/**
 * Read ESPN, write any changed names into Profiles, and append a NameHistory row for
 * each change so the lineage maintains itself.
 *
 * Silent on failure by design: if ESPN is down the cached names stay and the site looks
 * completely normal. ESPN_NAMES_SYNCED_AT records the last SUCCESSFUL sync, so staleness
 * is observable later without bothering anyone now.
 *
 * Returns a small summary object for the ops helpers and the trigger log.
 */
function waSyncEspnNames_() {
  var espn = waEspnTeams_();
  if (!espn.ok) return { ok: false, error: espn.error, changed: 0 };

  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (err) { return { ok: false, error: 'busy', changed: 0 }; }
  try {
    var sh = waProfSheet_(WA_PROFILE_TAB, WA_PROFILE_HEADERS);
    var idx = waProfIndex_(WA_PROFILE_HEADERS);
    var last = sh.getLastRow();
    if (last < 2) return { ok: true, changed: 0, note: 'no profile rows' };

    var vals = sh.getRange(2, 1, last - 1, WA_PROFILE_HEADERS.length).getValues();
    var nsh = waProfSheet_(WA_NAMEHIST_TAB, WA_NAMEHIST_HEADERS);
    var now = new Date();
    var changes = [], seenFid = {};

    for (var i = 0; i < vals.length; i++) {
      var fid = String(vals[i][idx.franchise_id] || '').trim();
      if (!fid || seenFid[fid]) continue;          // first row wins
      seenFid[fid] = true;
      var eid = String(vals[i][idx.espn_team_id] || '').trim();
      if (!eid) continue;                          // never matched — leave it alone
      var fresh = espn.teams[eid];
      if (!fresh) continue;                        // team missing from this response
      var cached = String(vals[i][idx.team_name] || '').trim();
      if (!cached) { cached = ''; }
      if (waProfNorm_(fresh) === waProfNorm_(cached)) continue;

      sh.getRange(i + 2, idx.team_name + 1).setValue(fresh);
      sh.getRange(i + 2, idx.updated_at + 1).setValue(now);
      sh.getRange(i + 2, idx.updated_by + 1).setValue('espn');
      nsh.appendRow([fid, 'team_name', cached, fresh, now, 'espn']);
      changes.push(fid + ': "' + cached + '" -> "' + fresh + '"');
    }

    if (changes.length) waBumpProfilesVersion_();
    PropertiesService.getScriptProperties().setProperty(WA_ESPN_SYNC_PROP, now.toISOString());
    return { ok: true, changed: changes.length, changes: changes };
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }
}

/** Installed by setupFranchises(). Hourly is plenty — nobody renames twice an hour, and
 *  keeping ESPN out of the page-load path is what keeps profiles_all fast. */
function syncEspnNamesHourly() {
  var r = waSyncEspnNames_();
  Logger.log(JSON.stringify(r));
}

function waInstallEspnTrigger_() {
  var fns = ScriptApp.getProjectTriggers();
  for (var i = 0; i < fns.length; i++) {
    if (fns[i].getHandlerFunction() === 'syncEspnNamesHourly') return false;   // already installed
  }
  ScriptApp.newTrigger('syncEspnNamesHourly').timeBased().everyHours(1).create();
  return true;
}

/* ---------------------------------------------------------------- the migration */

/**
 * Run once from the editor. Idempotent — re-running changes nothing and re-reports.
 * Does NOT touch Owners.team, KeeperPicks, or Watchlist. If it cannot match an Owners
 * row to a franchise it says so and skips it rather than guessing; an unmatched row is
 * a real problem worth a human look, not something to paper over.
 */
function setupFranchises() {
  var out = [];
  var ss = waProfSS_();
  out.push('Spreadsheet: ' + ss.getName());

  var osh = ss.getSheetByName('Owners');
  if (!osh) { Logger.log('ABORT — no Owners tab found in "' + ss.getName() + '".'); return; }

  /* --- 1. franchise_id column on Owners --- */
  var lastCol = osh.getLastColumn();
  var header = osh.getRange(1, 1, 1, lastCol).getValues()[0].map(function (h) { return String(h).trim(); });
  var fidCol = header.indexOf('franchise_id') + 1;
  if (!fidCol) {
    fidCol = lastCol + 1;
    osh.getRange(1, fidCol).setValue('franchise_id');
    out.push('Added Owners column ' + fidCol + ' = franchise_id');
  } else {
    out.push('Owners.franchise_id already at column ' + fidCol);
  }

  var teamCol = header.indexOf('team') + 1;
  var emailCol = header.indexOf('email') + 1;
  var nameCol = header.indexOf('name') + 1;
  if (!teamCol || !emailCol) { Logger.log('ABORT — Owners is missing an email or team column.'); return; }

  var last = osh.getLastRow();
  if (last < 2) { Logger.log('ABORT — Owners has no data rows.'); return; }

  var teams = osh.getRange(2, teamCol, last - 1, 1).getValues();
  var emails = osh.getRange(2, emailCol, last - 1, 1).getValues();
  var names = nameCol ? osh.getRange(2, nameCol, last - 1, 1).getValues() : null;
  var fids = osh.getRange(2, fidCol, last - 1, 1).getValues();

  var assigned = 0, already = 0, unmatched = [];
  var owners = [];                       // {fid, email, first, canon}
  for (var i = 0; i < teams.length; i++) {
    var canon = String(teams[i][0] || '').trim();
    var f = waFranchiseByName_(canon);
    if (!f) { if (canon) unmatched.push('row ' + (i + 2) + ': "' + canon + '"'); continue; }
    if (String(fids[i][0] || '').trim() === f.fid) already++;
    else { fids[i][0] = f.fid; assigned++; }
    owners.push({
      fid: f.fid,
      email: waNormEmail_(emails[i][0]),
      first: names ? String(names[i][0] || '').trim() : '',
      canon: canon,
      f: f
    });
  }
  osh.getRange(2, fidCol, last - 1, 1).setValues(fids);
  out.push('franchise_id: ' + assigned + ' assigned, ' + already + ' already correct');
  if (unmatched.length) out.push('UNMATCHED Owners rows (left blank on purpose): ' + unmatched.join(' | '));

  /* --- 2. Profiles, one row per franchise --- */
  var psh = waProfSheet_(WA_PROFILE_TAB, WA_PROFILE_HEADERS);
  var pIdx = waProfIndex_(WA_PROFILE_HEADERS);
  var pLast = psh.getLastRow();
  var existing = {};
  if (pLast > 1) {
    var pv = psh.getRange(2, 1, pLast - 1, WA_PROFILE_HEADERS.length).getValues();
    for (var q = 0; q < pv.length; q++) {
      var k = String(pv[q][pIdx.franchise_id] || '').trim();
      if (k && !existing[k]) existing[k] = q + 2;     // first row wins
    }
  }

  var now = new Date();
  var added = 0;
  owners.forEach(function (o) {
    if (existing[o.fid]) return;
    var row = [];
    row[pIdx.franchise_id] = o.fid;
    row[pIdx.espn_team_id] = '';              // filled in by the ESPN matching step below
    row[pIdx.email] = o.email;
    row[pIdx.first_name] = o.first;          // seeded from Owners.name
    row[pIdx.team_name] = o.canon;           // display name starts equal to canon
    row[pIdx.logo_kind] = 'default';
    row[pIdx.logo_data] = '';
    row[pIdx.color_primary] = o.f.p;
    row[pIdx.color_secondary] = o.f.s;
    row[pIdx.color_accent] = o.f.a;
    row[pIdx.jersey_json] = '';
    row[pIdx.motto] = '';
    row[pIdx.logo_prompt] = '';
    row[pIdx.updated_at] = now;
    row[pIdx.updated_by] = 'migration';
    for (var c = 0; c < WA_PROFILE_HEADERS.length; c++) if (row[c] === undefined) row[c] = '';
    psh.appendRow(row);
    added++;
  });
  out.push('Profiles: ' + added + ' created, ' + Object.keys(existing).length + ' already present');

  /* --- 3. NameHistory, append-only, backfilled from the lineage ribbons --- */
  var nsh = waProfSheet_(WA_NAMEHIST_TAB, WA_NAMEHIST_HEADERS);
  var nLast = nsh.getLastRow();
  var seen = {};
  if (nLast > 1) {
    var nv = nsh.getRange(2, 1, nLast - 1, WA_NAMEHIST_HEADERS.length).getValues();
    for (var z = 0; z < nv.length; z++) {
      seen[String(nv[z][0]).trim() + '|' + String(nv[z][1]).trim() + '|' + waProfNorm_(nv[z][3])] = true;
    }
  }
  var hist = 0;
  WA_FRANCHISES.forEach(function (f) {
    /* oldest first, current last, so the chain reads forward */
    var chain = f.priors.slice().reverse().concat([f.canon]);
    var prev = '';
    chain.forEach(function (n) {
      var key = f.fid + '|team_name|' + waProfNorm_(n);
      if (!seen[key]) {
        nsh.appendRow([f.fid, 'team_name', prev, n, '', n === f.canon ? 'migration' : 'archive']);
        seen[key] = true;
        hist++;
      }
      prev = n;
    });
  });
  out.push('NameHistory: ' + hist + ' rows backfilled');

  /* --- 4. Bind each franchise to its ESPN team id ---
     This is the ONLY time we ever match ESPN by name, and we do it now precisely because
     the names still agree. After this, renames in ESPN are read through the id and the
     name can drift as far as it likes. */
  var espn = waEspnTeams_();
  if (!espn.ok) {
    out.push('ESPN: NOT BOUND — ' + espn.error);
    out.push('  Names will stay frozen at canon until this succeeds. Re-run setupFranchises()');
    out.push('  once ESPN_S2 / ESPN_SWID are valid. Everything else above is already done.');
  } else {
    var espnByNorm = {};
    Object.keys(espn.teams).forEach(function (id) { espnByNorm[waProfNorm_(espn.teams[id])] = id; });

    var psh2 = waProfSheet_(WA_PROFILE_TAB, WA_PROFILE_HEADERS);
    var pLast2 = psh2.getLastRow();
    var bound = 0, unbound = [];
    if (pLast2 > 1) {
      var pv2 = psh2.getRange(2, 1, pLast2 - 1, WA_PROFILE_HEADERS.length).getValues();
      for (var b = 0; b < pv2.length; b++) {
        var bfid = String(pv2[b][pIdx.franchise_id] || '').trim();
        if (!bfid) continue;
        if (String(pv2[b][pIdx.espn_team_id] || '').trim()) { bound++; continue; }   // already bound
        var bf = waFranchiseByName_(bfid);
        if (!bf) continue;
        /* try the canon name, then every historical name */
        var cands = [bf.canon].concat(bf.priors);
        var hit = null;
        for (var ci = 0; ci < cands.length && !hit; ci++) hit = espnByNorm[waProfNorm_(cands[ci])] || null;
        if (hit) {
          psh2.getRange(b + 2, pIdx.espn_team_id + 1).setValue(hit);
          bound++;
        } else {
          unbound.push(bfid + ' (' + bf.canon + ')');
        }
      }
    }
    out.push('ESPN: ' + bound + ' of 10 franchises bound to an ESPN team id');
    if (unbound.length) {
      out.push('  UNBOUND: ' + unbound.join(', '));
      out.push('  ESPN currently reports: ' + Object.keys(espn.teams).map(function (id) {
        return id + '="' + espn.teams[id] + '"';
      }).join(', '));
      out.push('  Fill espn_team_id by hand for these, then re-run. Do NOT guess.');
    }

    var installed = waInstallEspnTrigger_();
    out.push('Hourly ESPN name sync trigger: ' + (installed ? 'installed' : 'already present'));
    var first = waSyncEspnNames_();
    out.push('Initial sync: ' + JSON.stringify(first));
  }

  out.push('');
  out.push('Owners.team was NOT modified. It stays the join key for every existing handler.');
  out.push('Profiles.team_name is a CACHE of the ESPN name — nothing owner-facing writes it.');
  Logger.log(out.join('\n'));
}

/* ---------------------------------------------------------------- read endpoint */

/**
 * profiles_all — the registry hydration read. Token required: this response carries
 * first names, and the site repo is public, so none of it may ever be baked into a file.
 * Returns all ten franchises; every client needs every logo and name to render the
 * roster grid and the draft board.
 */
function waProfilesAll_(e) {
  var claim = waVerifyToken_((e.parameter || {}).token);
  if (!claim) return waErr_('Session expired — log in again.', 'bad_token');
  var me = waFindOwner_(claim.e);
  if (!me) return waErr_('Account not found.', 'not_member');

  var v = waProfilesVersion_();
  var asked = String((e.parameter || {}).v || '').trim();
  if (asked && asked === String(v)) return waJson_({ ok: true, v: v, unchanged: true });

  return waJson_({ ok: true, v: v, profiles: waProfilesList_() });
}

/** The ten profiles, built field by field. Shared by profiles_all and profile_save so
 *  the client's optimistic copy and the server's echo can never drift in shape. */
function waProfilesList_() {
  var priors = waNameHistoryMap_();
  var sh = waProfSheet_(WA_PROFILE_TAB, WA_PROFILE_HEADERS);
  var idx = waProfIndex_(WA_PROFILE_HEADERS);
  var last = sh.getLastRow();
  var rows = last > 1 ? sh.getRange(2, 1, last - 1, WA_PROFILE_HEADERS.length).getValues() : [];

  var byFid = {};
  rows.forEach(function (r) {
    var fid = String(r[idx.franchise_id] || '').replace(/^\s+|\s+$/g, '');
    if (!fid || byFid[fid]) return;                    // first row wins
    byFid[fid] = r;
  });

  var out = [];
  WA_FRANCHISES.forEach(function (f) {
    var r = byFid[f.fid];
    var current = r ? (String(r[idx.team_name] || '').replace(/^\s+|\s+$/g, '') || f.canon) : f.canon;
    /* prior_names renders as "Formerly ...", so the name they go by right now must not
       appear in it. History is stored oldest-first, so this order is already correct. */
    var chain = (priors[f.fid] || f.priors.slice()).filter(function (n) {
      return waProfNorm_(n) !== waProfNorm_(current);
    });
    /* Built field by field, never by handing back the row, so a column added later
       cannot leak by accident. Same rule as admin.gs. */
    out.push({
      fid: f.fid,
      canon: f.canon,
      espn_id: r ? String(r[idx.espn_team_id] || '') : '',
      first_name: r ? String(r[idx.first_name] || '') : '',
      team_name: current,
      prior_names: chain,
      logo_kind: r ? (String(r[idx.logo_kind] || '').replace(/^\s+|\s+$/g, '') || 'default') : 'default',
      logo_data: r ? String(r[idx.logo_data] || '') : '',
      colors: {
        primary: r ? (String(r[idx.color_primary] || '').replace(/^\s+|\s+$/g, '') || f.p) : f.p,
        secondary: r ? (String(r[idx.color_secondary] || '').replace(/^\s+|\s+$/g, '') || f.s) : f.s,
        accent: r ? (String(r[idx.color_accent] || '').replace(/^\s+|\s+$/g, '') || f.a) : f.a
      },
      jersey: r ? waProfParse_(r[idx.jersey_json]) : null,
      motto: r ? String(r[idx.motto] || '') : ''
    });
  });
  return out;

}

function waProfParse_(s) {
  try { return JSON.parse(String(s || '') || 'null'); } catch (err) { return null; }
}

/** Cheap ETag. profile_save (P1) bumps this inside its lock. */
function waProfilesVersion_() {
  var p = PropertiesService.getScriptProperties();
  var v = parseInt(p.getProperty('PROFILES_VERSION') || '0', 10);
  return isNaN(v) ? 0 : v;
}
function waBumpProfilesVersion_() {
  var p = PropertiesService.getScriptProperties();
  var v = waProfilesVersion_() + 1;
  p.setProperty('PROFILES_VERSION', String(v));
  return v;
}

/** fid -> [oldest .. newest] display names, excluding the current one. */
function waNameHistoryMap_() {
  var sh = waProfSheet_(WA_NAMEHIST_TAB, WA_NAMEHIST_HEADERS);
  var last = sh.getLastRow();
  var map = {};
  if (last < 2) return map;
  var rows = sh.getRange(2, 1, last - 1, WA_NAMEHIST_HEADERS.length).getValues();
  rows.forEach(function (r) {
    if (String(r[1]).trim() !== 'team_name') return;
    var fid = String(r[0] || '').trim();
    var val = String(r[3] || '').trim();
    if (!fid || !val) return;
    if (!map[fid]) map[fid] = [];
    if (map[fid].indexOf(val) < 0) map[fid].push(val);
  });
  return map;
}

/* ---------------------------------------------------------------- ops helpers */

function previewFranchises() {
  var ss = waProfSS_();
  var osh = ss.getSheetByName('Owners');
  if (!osh) { Logger.log('No Owners tab.'); return; }
  var header = osh.getRange(1, 1, 1, osh.getLastColumn()).getValues()[0].map(function (h) { return String(h).trim(); });
  var t = header.indexOf('team') + 1, f = header.indexOf('franchise_id') + 1;
  var last = osh.getLastRow();
  var lines = ['Owners headers: ' + header.join(' | ')];
  if (t && last > 1) {
    var vals = osh.getRange(2, 1, last - 1, osh.getLastColumn()).getValues();
    vals.forEach(function (r, i) {
      lines.push((i + 2) + '  ' + (f ? (String(r[f - 1] || '(none)')) : '(no fid col)') + '  ' + String(r[t - 1] || ''));
    });
  }
  Logger.log(lines.join('\n'));
}

function previewProfiles() {
  var sh = waProfSS_().getSheetByName(WA_PROFILE_TAB);
  if (!sh) { Logger.log('No Profiles tab yet — run setupFranchises().'); return; }
  var idx = waProfIndex_(WA_PROFILE_HEADERS);
  var last = sh.getLastRow();
  var synced = PropertiesService.getScriptProperties().getProperty(WA_ESPN_SYNC_PROP);
  var lines = [
    'PROFILES_VERSION = ' + waProfilesVersion_(),
    'last successful ESPN name sync = ' + (synced || 'never'),
    'rows = ' + Math.max(0, last - 1)
  ];
  if (last > 1) {
    sh.getRange(2, 1, last - 1, WA_PROFILE_HEADERS.length).getValues().forEach(function (r) {
      lines.push([
        r[idx.franchise_id],
        'espn#' + (String(r[idx.espn_team_id] || '').trim() || 'UNBOUND'),
        r[idx.team_name],
        r[idx.logo_kind],
        'logo_data ' + String(r[idx.logo_data] || '').length + ' chars',
        r[idx.color_primary]
      ].join('  ·  '));
    });
  }
  var hist = waNameHistoryMap_();
  Object.keys(hist).forEach(function (k) { lines.push('history ' + k + ': ' + hist[k].join(' -> ')); });
  Logger.log(lines.join('\n'));
}

/** Force an ESPN name sync now, outside the hourly trigger. Safe to run any time. */
function syncEspnNamesNow() {
  Logger.log(JSON.stringify(waSyncEspnNames_(), null, 1));
}

/** Show exactly what ESPN is reporting right now, without writing anything.
 *  First thing to run when a name looks wrong or stale. */
function previewEspnTeams() {
  var r = waEspnTeams_();
  if (!r.ok) { Logger.log('ESPN read FAILED: ' + r.error); return; }
  var lines = ['ESPN currently reports ' + Object.keys(r.teams).length + ' teams:'];
  Object.keys(r.teams).forEach(function (id) { lines.push('  ' + id + '  ' + r.teams[id]); });
  Logger.log(lines.join('\n'));
}

/* ---------------------------------------------------------------- profile_save */

/**
 * profile_save — the owner-editable half of a profile.
 *
 * WRITABLE: first_name, color_primary, color_secondary, color_accent, logo_kind,
 *           logo_data, jersey_json, motto, logo_prompt.
 * NOT WRITABLE, and rejected if sent: team_name and espn_team_id (names come from
 *           ESPN), franchise_id, email, and anything on the Owners tab except `name`,
 *           which is mirrored so the commish dashboard keeps showing the right person.
 *
 * Partial updates: an absent key means "leave it alone", so the UI can autosave one
 * field at a time without shipping the whole object.
 */
function waProfileSave_(e) {
  var p = e.parameter || {};
  var claim = waVerifyToken_(p.token);
  if (!claim) return waErr_('Session expired — log in again.', 'bad_token');
  var me = waFindOwner_(claim.e);
  if (!me) return waErr_('Account not found.', 'not_member');

  var isCommish = waTruthy_(me.rec.is_commish);
  var fid = String(p.fid || '').trim();
  if (fid && !isCommish) return waErr_('You can only edit your own profile.', 'forbidden');
  if (!fid) fid = String(me.rec.franchise_id || '').trim();
  if (!fid) return waErr_('No franchise on your account — text the commish.', 'no_team');
  if (!waFranchiseByName_(fid)) return waErr_('Unknown franchise.', 'bad_payload');

  /* Sent-but-forbidden is an error, not a silent ignore. If a client thinks it can
     rename a team we want to hear about it, not quietly drop it on the floor. */
  if (p.team_name != null) return waErr_('Team names come from ESPN — rename your team in the ESPN app and the site follows.', 'read_only');
  if (p.espn_team_id != null || p.franchise_id != null) return waErr_('That field is not editable.', 'read_only');

  var patch = {}, hist = [];

  if (p.first_name != null) {
    var fn = String(p.first_name).replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (!fn) return waErr_('First name cannot be empty.', 'bad_payload');
    if (fn.length > 16) return waErr_('First name is a bit long — 16 characters max.', 'bad_payload');
    /* Rhino has no unicode property escapes, so this is a plain class rather than \p{L}. */
    if (!/^[A-Za-zÀ-ɏ .'\-]+$/.test(fn)) return waErr_('Letters, spaces, hyphens and apostrophes only in a first name.', 'bad_payload');
    patch.first_name = fn;
  }

  var COLS = ['color_primary', 'color_secondary', 'color_accent'];
  for (var c = 0; c < COLS.length; c++) {
    var k = COLS[c];
    if (p[k] == null) continue;
    var hex = String(p[k]).replace(/^\s+|\s+$/g, '');
    if (!/^#[0-9a-fA-F]{6}$/.test(hex)) return waErr_('Colors must look like #RRGGBB.', 'bad_payload');
    patch[k] = hex.toUpperCase();
  }

  if (p.logo_kind != null) {
    var kind = String(p.logo_kind).replace(/^\s+|\s+$/g, '');
    if (['default', 'builder', 'upload', 'ai'].indexOf(kind) < 0) return waErr_('Unknown logo type.', 'bad_payload');
    patch.logo_kind = kind;
  }

  if (p.logo_data != null) {
    var ld = String(p.logo_data);
    if (ld.length > 32000) {
      return waErr_('That logo is too big even after resizing — try a simpler image, or use the builder.', 'too_big');
    }
    if (ld) {
      var looksBuilder = ld.charAt(0) === '{';
      /* SVG is deliberately NOT accepted: an uploaded logo renders on nine other
         people's screens, and SVG executes script. The builder covers the vector case. */
      var looksImage = /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+\/=]+$/.test(ld);
      if (!looksBuilder && !looksImage) return waErr_('That image format is not supported — PNG, JPEG or WebP.', 'bad_payload');
      if (looksBuilder) { try { JSON.parse(ld); } catch (err) { return waErr_('Logo spec was not readable.', 'bad_payload'); } }
    }
    patch.logo_data = ld;
  }

  if (p.jersey_json != null) {
    var jj = String(p.jersey_json);
    if (jj.length > 400) return waErr_('Jersey settings are too large.', 'bad_payload');
    if (jj) { try { JSON.parse(jj); } catch (err2) { return waErr_('Jersey settings were not readable.', 'bad_payload'); } }
    patch.jersey_json = jj;
  }

  if (p.motto != null) {
    var mo = String(p.motto).replace(/[\r\n]+/g, ' ').replace(/\s+/g, ' ').replace(/^\s+|\s+$/g, '');
    if (mo.length > 60) return waErr_('Motto is 60 characters max.', 'bad_payload');
    patch.motto = mo;
  }

  if (p.logo_prompt != null) {
    patch.logo_prompt = String(p.logo_prompt).slice(0, 200);
  }

  if (!waHasKeys_(patch)) return waErr_('Nothing to save.', 'bad_payload');

  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (err3) { return waErr_('Busy — try again.', 'locked'); }
  try {
    var sh = waProfSheet_(WA_PROFILE_TAB, WA_PROFILE_HEADERS);
    var idx = waProfIndex_(WA_PROFILE_HEADERS);
    var last = sh.getLastRow();
    var rowNum = 0, cur = null;
    if (last > 1) {
      var vals = sh.getRange(2, 1, last - 1, WA_PROFILE_HEADERS.length).getValues();
      for (var i = 0; i < vals.length; i++) {
        if (String(vals[i][idx.franchise_id] || '').replace(/^\s+|\s+$/g, '') === fid) { rowNum = i + 2; cur = vals[i]; break; }
      }
    }
    if (!rowNum) return waErr_('No profile row — run setupFranchises().', 'no_team');

    if (patch.first_name != null) {
      var was = String(cur[idx.first_name] || '').replace(/^\s+|\s+$/g, '');
      if (was !== patch.first_name) hist.push([fid, 'first_name', was, patch.first_name, new Date(), waNormEmail_(claim.e)]);
    }

    var now = new Date();
    for (var key in patch) {
      if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
      if (idx[key] == null) continue;
      sh.getRange(rowNum, idx[key] + 1).setValue(patch[key]);
    }
    sh.getRange(rowNum, idx.updated_at + 1).setValue(now);
    sh.getRange(rowNum, idx.updated_by + 1).setValue(waNormEmail_(claim.e));

    if (hist.length) {
      var nsh = waProfSheet_(WA_NAMEHIST_TAB, WA_NAMEHIST_HEADERS);
      for (var h = 0; h < hist.length; h++) nsh.appendRow(hist[h]);
    }

    /* Mirror the first name onto Owners.name — dashboard.html and schedule.gs read it. */
    if (patch.first_name != null) waProfMirrorName_(fid, patch.first_name);

    waBumpProfilesVersion_();
  } finally {
    try { lock.releaseLock(); } catch (err4) {}
  }

  return waJson_({ ok: true, v: waProfilesVersion_(), profile: waProfileOne_(fid) });
}

function waHasKeys_(o) { for (var k in o) { if (Object.prototype.hasOwnProperty.call(o, k)) return true; } return false; }

/** Keep Owners.name in step with the profile's first name. */
function waProfMirrorName_(fid, firstName) {
  var osh = waProfSS_().getSheetByName('Owners');
  if (!osh) return;
  var header = osh.getRange(1, 1, 1, osh.getLastColumn()).getValues()[0];
  var cFid = 0, cName = 0;
  for (var i = 0; i < header.length; i++) {
    var h = String(header[i]).replace(/^\s+|\s+$/g, '');
    if (h === 'franchise_id') cFid = i + 1;
    if (h === 'name') cName = i + 1;
  }
  if (!cFid || !cName) return;
  var last = osh.getLastRow();
  if (last < 2) return;
  var col = osh.getRange(2, cFid, last - 1, 1).getValues();
  for (var r = 0; r < col.length; r++) {
    if (String(col[r][0] || '').replace(/^\s+|\s+$/g, '') === fid) { osh.getRange(r + 2, cName).setValue(firstName); return; }
  }
}

/** One profile in the same shape profiles_all returns, so the client can trust the echo. */
function waProfileOne_(fid) {
  var all = waProfilesList_();
  for (var i = 0; i < all.length; i++) if (all[i].fid === fid) return all[i];
  return null;
}
