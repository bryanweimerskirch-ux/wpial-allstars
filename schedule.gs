/* ============================================================================
 * schedule.gs — roster assignments for the NFL-week card on the Schedule tab
 * ----------------------------------------------------------------------------
 * The card on index.html shows every NFL game with the fantasy-relevant
 * players in it. A player is only ASSIGNED to a WPIAL team if they are:
 *   (a) a defined keeper (Keepers tab), or
 *   (b) drafted — once the live draft is done and results land in the
 *       draftboard tab (DRAFT_TAB below).
 * Everyone else renders as "Avail" until then. The page flips over
 * automatically the moment the draft tab has picks in it — nothing to deploy.
 *
 * Why this is server-side: keepers and draft results live in the sheet, and
 * the sheet is the single source of truth (ESPN's offseason rosters are stale
 * pre-draft — they don't know about keepers). Schedule + injury data are NOT
 * proxied here; the page pulls those straight from ESPN's public APIs.
 *
 * Wiring: one line in doGet (Code.gs)
 *   if (e && e.parameter && e.parameter.action === 'schedule_rosters') return waSchedRosters_(e);
 *
 * Reads tabs: Keepers (team | player), Owners (owner -> team mapping),
 * and DRAFT_TAB when it exists. Read-only; writes nothing.
 * ==========================================================================*/

var WA_SCHED_KEEPERS_TAB = 'Keepers';
var WA_SCHED_OWNERS_TAB  = 'Owners';
var WA_SCHED_DRAFT_TAB   = '2026 Draft Results';  // paste ClickyDraft grid here after draft night

function waSchedRosters_(e) {
  var ss = SpreadsheetApp.getActiveSpreadsheet();
  var draft = waSchedDraft_(ss);
  var phase = draft.length ? 'post-draft' : 'pre-draft';
  var players = phase === 'post-draft' ? draft : waSchedKeepers_(ss);
  return ContentService
    .createTextOutput(JSON.stringify({ ok: true, phase: phase, players: players }))
    .setMimeType(ContentService.MimeType.JSON);
}

function waSchedKeepers_(ss) {
  var sh = ss.getSheetByName(WA_SCHED_KEEPERS_TAB);
  if (!sh) return [];
  return sh.getDataRange().getValues().slice(1)
    .filter(function (r) { return r[0] && r[1]; })
    .map(function (r) {
      return { team: String(r[0]).trim(), player: String(r[1]).trim(), keeper: true };
    });
}

/* Parses the draft tab in either format:
 *   A) simple columns:  Team | Player        ("(K)" suffix marks keepers)
 *   B) ClickyDraft grid: row 1 = owner/team per column, cells are multiline
 *      "POS\nNFL\nBYE\nFirst\nLast(K)" (defenses: "DEF\nPIT\n5\n \nPIT DEF")
 * Owner first names in grid headers are mapped to team names via Owners tab. */
function waSchedDraft_(ss) {
  var sh = ss.getSheetByName(WA_SCHED_DRAFT_TAB);
  if (!sh || sh.getLastRow() < 2) return [];
  var v = sh.getDataRange().getValues();
  var hdr = v[0].map(function (h) { return String(h || '').trim(); });

  if (waSchedNorm_(hdr[0]) === 'team' && waSchedNorm_(hdr[1]) === 'player') {
    return v.slice(1)
      .filter(function (r) { return r[0] && r[1]; })
      .map(function (r) {
        var raw = String(r[1]).trim();
        return { team: String(r[0]).trim(), player: waSchedStripK_(raw), keeper: waSchedIsK_(raw) };
      });
  }

  var ownerToTeam = {};
  var osh = ss.getSheetByName(WA_SCHED_OWNERS_TAB);
  if (osh) {
    osh.getDataRange().getValues().slice(1).forEach(function (r) {
      if (r[1] && r[2]) ownerToTeam[waSchedNorm_(String(r[1]))] = String(r[2]).trim();
      if (r[2]) ownerToTeam[waSchedNorm_(String(r[2]))] = String(r[2]).trim();
    });
  }
  var out = [];
  for (var c = 1; c < hdr.length; c++) {
    if (!hdr[c]) continue;
    var team = ownerToTeam[waSchedNorm_(hdr[c])] || hdr[c];
    for (var r = 1; r < v.length; r++) {
      var cell = String(v[r][c] || '').trim();
      if (!cell) continue;
      var lines = cell.split('\n').map(function (s) { return s.trim(); }).filter(String);
      if (lines.length < 2) continue;
      var name = lines.length > 3 ? lines.slice(3).join(' ') : lines[lines.length - 1];
      out.push({ team: team, player: waSchedStripK_(name), keeper: waSchedIsK_(name) });
    }
  }
  return out;
}

function waSchedIsK_(s)    { return /\(K\)\s*$/i.test(s); }
function waSchedStripK_(s) { return s.replace(/\s*\(K\)\s*$/i, '').trim(); }
function waSchedNorm_(s) {
  return String(s).toLowerCase().replace(/[.'-]/g, ' ')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
}
