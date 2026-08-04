/** espn-rankings.gs — adds ?action=rankings to the WPIAL Feed API.
 * Pulls ESPN 2026 season projections from the public leaguedefaults endpoint
 * (no login, no SWID/espn_s2 needed) and converts to TRUE half-PPR:
 *   half = PPR appliedTotal - 0.5 x projected receptions (stat id 53).
 * Also flags 2026 rookies (rk:1) using Sleeper's public player DB (years_exp === 0).
 * Response is cached 6 hours. Shape matches what Draftboard.html expects:
 *   { ok:true, players:[{ id, n, p, t, adp, pts, rk, r }] }
 */

var RANK_SEASON = 2026;
var RANK_CACHE_KEY = 'espn_rankings_v2';
var RANK_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'DEF' };
var RANK_NFL = { 0:'FA',1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU' };

function rankingsResponse_(e) {
  var cache = CacheService.getScriptCache();
  var hit = cache.get(RANK_CACHE_KEY);
  var payload = hit || JSON.stringify(buildRankings_());
  if (!hit) { try { cache.put(RANK_CACHE_KEY, payload, 21600); } catch (err) {} }
  return ContentService.createTextOutput(payload).setMimeType(ContentService.MimeType.JSON);
}

function rankNorm_(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/ +/g, ' ').trim();
}

/* Rookie set from Sleeper's public player DB (big file, so only fetched on cache miss). */
function fetchRookieSet_() {
  try {
    var res = UrlFetchApp.fetch('https://api.sleeper.app/v1/players/nfl', { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return null;
    var db = JSON.parse(res.getContentText());
    var set = {};
    Object.keys(db).forEach(function (k) {
      var p = db[k];
      if (p && p.years_exp === 0 && p.active === true && p.full_name && p.position) set[rankNorm_(p.full_name) + '|' + p.position] = true;
    });
    return set;
  } catch (err) { return null; }
}

function buildRankings_() {
  try {
    var filter = { players: { limit: 500, sortDraftRanks: { sortPriority: 1, sortAsc: true, value: 'PPR' } } };
    var url = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + RANK_SEASON + '/segments/0/leaguedefaults/3?view=kona_player_info';
    var res = UrlFetchApp.fetch(url, { headers: { 'X-Fantasy-Filter': JSON.stringify(filter) }, muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) return { ok: false, error: 'ESPN HTTP ' + res.getResponseCode() };
    var data = JSON.parse(res.getContentText());
    var rookies = fetchRookieSet_();   // null if Sleeper fetch fails; rankings still work
    var out = [];
    (data.players || []).forEach(function (w) {
      var pl = w.player || w;
      var pos = RANK_POS[pl.defaultPositionId];
      if (!pos || !pl.stats) return;
      var proj = null;
      pl.stats.forEach(function (st) { if (st.statSourceId === 1 && st.statSplitTypeId === 0 && st.seasonId === RANK_SEASON) proj = st; });
      if (!proj || !proj.appliedTotal) return;
      var rec = (proj.stats && proj.stats['53']) ? Number(proj.stats['53']) : 0;
      var half = Math.round((proj.appliedTotal - 0.5 * rec) * 10) / 10;
      if (half <= 0) return;
      var adp = (pl.ownership && pl.ownership.averageDraftPosition) ? Math.round(pl.ownership.averageDraftPosition * 10) / 10 : null;
      var rk = (rookies && rookies[rankNorm_(pl.fullName) + '|' + pos]) ? 1 : 0;
      out.push({ id: String(pl.id), n: pl.fullName, p: pos, t: RANK_NFL[pl.proTeamId] || 'FA', adp: adp, pts: half, rk: rk });
    });
    if (out.length < 100) return { ok: false, error: 'only ' + out.length + ' usable players from ESPN' };
    out.sort(function (a, b) { return b.pts - a.pts; });
    out.forEach(function (p, i) { p.r = i + 1; });
    return { ok: true, season: RANK_SEASON, updated: new Date().toISOString(), scoring: 'half-ppr (PPR - 0.5*rec)', rookies: rookies ? true : false, players: out };
  } catch (err) {
    return { ok: false, error: String(err) };
  }
}

/* Run this once from the toolbar to sanity-check (Execution log shows the output). */
function testRankings() {
  var r = buildRankings_();
  if (r.ok) {
    var rks = r.players.filter(function (p) { return p.rk; });
    Logger.log(r.players.length + ' players, ' + rks.length + ' rookies. Top 3: ' + r.players.slice(0, 3).map(function (p) { return p.n + ' ' + p.pts; }).join(' | ') + ' || Top rookies: ' + rks.slice(0, 3).map(function (p) { return p.n; }).join(', '));
  } else {
    Logger.log('FAILED: ' + r.error);
  }
}
