/* ============================================================================
 * admin.gs — commissioner-only league engagement stats
 * ----------------------------------------------------------------------------
 * Answers "who's actually using this and who needs a nudge" from data the
 * sheet ALREADY collects. No new client-side tracking, no new columns.
 *
 *   Owners      -> has a password yet, login_count, last_login, created_at
 *   KeeperPicks -> how many of their 5 are declared, when they last touched it
 *
 * Wiring: one line in doPost (Code.gs)
 *   if (e && e.parameter && e.parameter.action === 'admin_stats') return waAdminStats_(e);
 *
 * POST, not GET, deliberately: the session token stays out of the URL (and out
 * of any referrer header or server log) even though auth_me already accepts it
 * on the query string.
 *
 * Reuses auth.gs helpers — Apps Script files share one global scope:
 *   waVerifyToken_(token) -> claim {e: email, x: expiry} or null
 *   waFindOwner_(email)   -> {row, rec} keyed by WA_OWNER_HEADERS, or null
 *   waOwnersTab_() / waPicksTab_() / waJson_() / waErr_()
 *   waIsLocked_() / waLockDate_() / waNormEmail_()
 *
 * NEVER returns pass_hash or pass_salt. The response is deliberately built
 * field by field rather than by handing back the row, so a future column
 * can't leak by accident.
 * ==========================================================================*/

/** true for TRUE, true, yes, y, 1, x — however the sheet happens to store it. */
function waTruthy_(v) {
  if (v === true) return true;
  return /^(true|yes|y|1|x)$/i.test(String(v == null ? '' : v).trim());
}

/** Date | string | '' -> ISO string or null. Sheets hands back Date objects. */
function waIso_(v) {
  if (!v) return null;
  try {
    var d = (v instanceof Date) ? v : new Date(v);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  } catch (err) { return null; }
}

function waAdminStats_(e) {
  var p = (e && e.parameter) || {};
  var claim = waVerifyToken_(p.token);
  if (!claim) return waErr_('Session expired — log in again.', 'bad_token');

  var me = waFindOwner_(claim.e);
  if (!me) return waErr_('Account not found.', 'not_member');
  if (!waTruthy_(me.rec.is_commish)) return waErr_('Commissioner only.', 'forbidden');

  // ---- keeper picks, keyed by team -------------------------------------
  var picks = {};
  var psh = waPicksTab_();
  var plast = psh.getLastRow();
  if (plast >= 2) {
    var pvals = psh.getRange(2, 1, plast - 1, WA_PICK_HEADERS.length).getValues();
    for (var i = 0; i < pvals.length; i++) {
      var team = String(pvals[i][0] || '').trim();
      if (!team) continue;
      var arr = [];
      try { arr = JSON.parse(pvals[i][2] || '[]') || []; } catch (err) { arr = []; }
      // First row wins, matching waPicksRow_ — the one-writer rule from the
      // migration. A duplicate row must never change what the dashboard says.
      if (picks[team]) continue;
      picks[team] = {
        count: arr.length,
        rounds: arr.map(function (x) { return x && (x.round || x.r); })
                   .filter(function (r) { return r != null; }),
        updated_at: waIso_(pvals[i][4]),
        updated_by: String(pvals[i][5] || '') || null
      };
    }
  }

  // ---- owners ----------------------------------------------------------
  var owners = [];
  var osh = waOwnersTab_();
  var olast = osh.getLastRow();
  if (olast >= 2) {
    var ovals = osh.getRange(2, 1, olast - 1, WA_OWNER_HEADERS.length).getValues();
    var idx = {};
    WA_OWNER_HEADERS.forEach(function (h, k) { idx[h] = k; });

    for (var j = 0; j < ovals.length; j++) {
      var row = ovals[j];
      var email = waNormEmail_(row[idx.email]);
      if (!email) continue;
      var teamName = String(row[idx.team] || '').trim();
      var pk = picks[teamName] || { count: 0, rounds: [], updated_at: null, updated_by: null };
      var logins = Number(row[idx.login_count]) || 0;

      owners.push({
        email: email,
        name: String(row[idx.name] || '').trim(),
        team: teamName,
        is_commish: waTruthy_(row[idx.is_commish]),
        // Presence only. The hash itself never leaves the sheet.
        has_password: !!String(row[idx.pass_hash] || '').trim(),
        created_at: waIso_(row[idx.created_at]),
        last_login: waIso_(row[idx.last_login]),
        login_count: logins,
        keepers: pk.count,
        keeper_rounds: pk.rounds,
        keepers_updated_at: pk.updated_at,
        keepers_updated_by: pk.updated_by
      });
    }
  }

  // Teams that have declared keepers but have no Owners row — a legacy-tab
  // migration artifact or a typo'd team name. Surfaced rather than swallowed.
  var known = {};
  owners.forEach(function (o) { known[o.team] = true; });
  var orphans = Object.keys(picks).filter(function (t) { return !known[t]; });

  var withPw = owners.filter(function (o) { return o.has_password; }).length;
  var declared = owners.filter(function (o) { return o.keepers > 0; }).length;
  var complete = owners.filter(function (o) { return o.keepers >= 5; }).length;
  var totalKeepers = owners.reduce(function (s, o) { return s + o.keepers; }, 0);
  var everLoggedIn = owners.filter(function (o) { return o.login_count > 0; }).length;

  return waJson_({
    ok: true,
    generated_at: new Date().toISOString(),
    locked: waIsLocked_(),
    lock_at: waLockDate_().toISOString(),
    summary: {
      owners: owners.length,
      with_password: withPw,
      ever_logged_in: everLoggedIn,
      any_keepers: declared,
      complete_keepers: complete,
      total_keepers: totalKeepers,
      total_logins: owners.reduce(function (s, o) { return s + o.login_count; }, 0)
    },
    owners: owners,
    orphan_teams: orphans
  });
}

/**
 * Ops helper — run from the editor to eyeball the numbers without the web app.
 * Logs a summary only; no secrets.
 */
function previewAdminStats() {
  var osh = waOwnersTab_();
  var last = osh.getLastRow();
  if (last < 2) { Logger.log('No owners.'); return; }
  var vals = osh.getRange(2, 1, last - 1, WA_OWNER_HEADERS.length).getValues();
  var idx = {};
  WA_OWNER_HEADERS.forEach(function (h, k) { idx[h] = k; });
  var lines = vals.map(function (r) {
    return [
      String(r[idx.team] || '(no team)'),
      String(r[idx.pass_hash] || '').trim() ? 'pw' : 'NO PW',
      'logins=' + (Number(r[idx.login_count]) || 0),
      'last=' + (waIso_(r[idx.last_login]) || 'never')
    ].join(' | ');
  });
  Logger.log(lines.join('\n'));
}
