/* ============================================================================
 * watchlist.gs — per-owner draft watchlists
 * ----------------------------------------------------------------------------
 * Why this is server-side and not just localStorage: on draft night the
 * commissioner's browser is the board. When the clock expires it has to be able
 * to read the *other nine* owners' lists to make their pick. A list that only
 * exists in its owner's browser is invisible to the board and useless for that.
 *
 * Wiring: three lines in doPost (Code.gs)
 *   if (e && e.parameter && e.parameter.action === 'watchlist_get')  return waWatchGet_(e);
 *   if (e && e.parameter && e.parameter.action === 'watchlist_save') return waWatchSave_(e);
 *   if (e && e.parameter && e.parameter.action === 'watchlist_all')  return waWatchAll_(e);
 *
 * Sheet tab `Watchlist`, one row per team, replaced in place — same shape and
 * same one-writer rule as KeeperPicks.
 *
 * Privacy: a watchlist is a statement of intent about the draft, so it is
 * readable by its owner and the commissioner only. `watchlist_all` is the only
 * route that returns everyone, and it refuses non-commissioners.
 *
 * Reuses auth.gs helpers (Apps Script files share one global scope):
 *   waVerifyToken_ / waFindOwner_ / waJson_ / waErr_ / waNormEmail_ / waTab_
 * and admin.gs's waTruthy_ / waIso_.
 * ==========================================================================*/

var WA_WATCH_TAB = 'Watchlist';
var WA_WATCH_HEADERS = ['team', 'email', 'players_json', 'count', 'updated_at', 'updated_by'];
var WA_WATCH_MAX = 50;   // per team. Keeps the cell well under the 50k char limit.

function waWatchTab_() { return waTab_(WA_WATCH_TAB, WA_WATCH_HEADERS); }

/** {row, players, updated_at, updated_by} for a team, or null. First row wins. */
function waWatchRow_(team) {
  var sh = waWatchTab_();
  var last = sh.getLastRow();
  if (last < 2) return null;
  var vals = sh.getRange(2, 1, last - 1, WA_WATCH_HEADERS.length).getValues();
  var want = String(team || '').trim().toLowerCase();
  for (var i = 0; i < vals.length; i++) {
    if (String(vals[i][0] || '').trim().toLowerCase() === want) {
      var arr = [];
      try { arr = JSON.parse(vals[i][2] || '[]') || []; } catch (err) { arr = []; }
      return {
        row: i + 2,
        players: arr,
        updated_at: waIso_(vals[i][4]),
        updated_by: String(vals[i][5] || '') || null
      };
    }
  }
  return null;
}

/**
 * Normalises whatever the client sent into the only four fields the board needs
 * to resolve a player against the ranking pool. Anything else is dropped — the
 * client does not get to decide what lives in the sheet.
 */
function waWatchClean_(raw) {
  var arr;
  try { arr = JSON.parse(raw || '[]'); } catch (err) { return null; }
  if (!arr || Object.prototype.toString.call(arr) !== '[object Array]') return null;

  var out = [], seen = {};
  for (var i = 0; i < arr.length && out.length < WA_WATCH_MAX; i++) {
    var p = arr[i];
    if (!p || typeof p !== 'object') continue;
    var name = String(p.n || p.name || '').trim();
    if (!name) continue;
    var key = name.toLowerCase().replace(/[^a-z]/g, '');
    if (seen[key]) continue;          // order is meaningful; first mention wins
    seen[key] = true;
    out.push({
      id: String(p.id || '').trim(),
      n: name.slice(0, 60),
      p: String(p.p || p.pos || '').trim().slice(0, 4),
      t: String(p.t || '').trim().slice(0, 4)
    });
  }
  return out;
}

/** Resolve which team the caller may act on. Commish may pass ?team=. */
function waWatchTarget_(e, me) {
  var asked = String((e.parameter && e.parameter.team) || '').trim();
  if (asked && waTruthy_(me.rec.is_commish)) return asked;
  return String(me.rec.team || '').trim();
}

function waWatchGet_(e) {
  var claim = waVerifyToken_((e.parameter || {}).token);
  if (!claim) return waErr_('Session expired — log in again.', 'bad_token');
  var me = waFindOwner_(claim.e);
  if (!me) return waErr_('Account not found.', 'not_member');

  var team = waWatchTarget_(e, me);
  if (!team) return waErr_('No team on your account — text the commish.', 'no_team');

  var row = waWatchRow_(team);
  return waJson_({
    ok: true,
    team: team,
    players: row ? row.players : [],
    count: row ? row.players.length : 0,
    max: WA_WATCH_MAX,
    updated_at: row ? row.updated_at : null
  });
}

function waWatchSave_(e) {
  var claim = waVerifyToken_((e.parameter || {}).token);
  if (!claim) return waErr_('Session expired — log in again.', 'bad_token');
  var me = waFindOwner_(claim.e);
  if (!me) return waErr_('Account not found.', 'not_member');

  var team = waWatchTarget_(e, me);
  if (!team) return waErr_('No team on your account — text the commish.', 'no_team');

  var players = waWatchClean_((e.parameter || {}).players_json);
  if (players === null) return waErr_('Could not read that watchlist.', 'bad_payload');

  // Deliberately NOT locked by the keeper deadline: a watchlist is draft-night
  // ammunition, so it stays editable right up to and during the draft.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(8000); } catch (err) { return waErr_('Busy — try again.', 'locked'); }
  try {
    var sh = waWatchTab_();
    var existing = waWatchRow_(team);
    var now = new Date();
    var rowVals = [team, waNormEmail_(claim.e), JSON.stringify(players),
                   players.length, now, waNormEmail_(claim.e)];
    if (existing) sh.getRange(existing.row, 1, 1, WA_WATCH_HEADERS.length).setValues([rowVals]);
    else sh.appendRow(rowVals);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }

  return waJson_({ ok: true, team: team, count: players.length, updated_at: new Date().toISOString() });
}

/** Commissioner only — every team's list, for the draft-night auto-pick. */
function waWatchAll_(e) {
  var claim = waVerifyToken_((e.parameter || {}).token);
  if (!claim) return waErr_('Session expired — log in again.', 'bad_token');
  var me = waFindOwner_(claim.e);
  if (!me) return waErr_('Account not found.', 'not_member');
  if (!waTruthy_(me.rec.is_commish)) return waErr_('Commissioner only.', 'forbidden');

  var teams = {};
  var sh = waWatchTab_();
  var last = sh.getLastRow();
  if (last >= 2) {
    var vals = sh.getRange(2, 1, last - 1, WA_WATCH_HEADERS.length).getValues();
    for (var i = 0; i < vals.length; i++) {
      var team = String(vals[i][0] || '').trim();
      if (!team || teams[team]) continue;   // first row wins
      var arr = [];
      try { arr = JSON.parse(vals[i][2] || '[]') || []; } catch (err) { arr = []; }
      teams[team] = { players: arr, count: arr.length, updated_at: waIso_(vals[i][4]) };
    }
  }
  return waJson_({ ok: true, teams: teams, generated_at: new Date().toISOString() });
}

/** Ops helper — log every team's list length without dumping the lists. */
function previewWatchlists() {
  var sh = waWatchTab_();
  var last = sh.getLastRow();
  if (last < 2) { Logger.log('No watchlists yet.'); return; }
  var vals = sh.getRange(2, 1, last - 1, WA_WATCH_HEADERS.length).getValues();
  Logger.log(vals.map(function (v) {
    return String(v[0]) + ' — ' + (Number(v[3]) || 0) + ' players, updated ' + (waIso_(v[4]) || 'never');
  }).join('\n'));
}
