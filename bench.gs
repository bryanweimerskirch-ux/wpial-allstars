/* ============================================================================
 * bench.gs - points left on the bench, per franchise, per season.
 *
 * WHY IT EXISTS
 * Bryan: "used as leverage for Gelly to rip into owners and jab them a bit."
 * Nothing else on the site measures a decision the owner actually made and got
 * wrong. Points-for measures your roster; bench points measure your judgement.
 *
 * WHY IT IS A SEPARATE FILE
 * getWeekTopScorers_ in Code.gs already walks every roster and already identifies
 * the bench - it just skips it:
 *     if (en.lineupSlotId === 20 || en.lineupSlotId === 21) return;
 * Reusing it would have been fewer fetches, but editing that function in place means
 * editing the code path the live scoreboard depends on. This file touches nothing
 * that already works: its own fetch, its own cache, one new read-only action.
 *
 * Wiring: ONE line in doGet (Code.gs), guarded form -
 *   if (e && e.parameter && e.parameter.action === 'bench_points') return waBenchPoints_(e);
 *
 * COST: one ESPN call per scoring period, cached six hours. In the offseason every
 * week returns nothing and the whole thing answers zeros, which is correct.
 *
 * Reuses waEspnTeams_() from profile.gs for the id -> name map, so bench totals key
 * on the same franchise names as everything else. Team NAMES are never matched here;
 * ESPN team ids are, exactly as in the name sync.
 * ==========================================================================*/

var WA_BENCH_CACHE_KEY = 'wa_bench_season_v1';
var WA_BENCH_TTL = 21600;          // 6 hours
var WA_BENCH_MAX_WEEK = 18;
var WA_BENCH_SLOTS = { 20: 1, 21: 1 };   // 20 = bench, 21 = IR

/** Bench points for one scoring period. { espnTeamId: points } - never throws. */
function waBenchWeek_(week, seasonOverride) {
  var props = PropertiesService.getScriptProperties();
  var s2 = props.getProperty('ESPN_S2');
  var swid = props.getProperty('ESPN_SWID');
  if (!s2 || !swid) return null;

  var league = props.getProperty('ESPN_LEAGUE_ID') ||
               (typeof ESPN_LEAGUE_ID !== 'undefined' ? ESPN_LEAGUE_ID : '11564022');
  var season = seasonOverride || props.getProperty('ESPN_SEASON') ||
               (typeof ESPN_SEASON !== 'undefined' ? ESPN_SEASON : 2026);

  var url = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + season +
            '/segments/0/leagues/' + league +
            '?view=mBoxscore&view=mMatchupScore&scoringPeriodId=' + week;
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: { 'Cookie': 'espn_s2=' + s2 + '; SWID=' + swid, 'Accept': 'application/json' }
    });
    if (res.getResponseCode() !== 200) return null;
    var data = JSON.parse(res.getContentText());
    var sched = (data && data.schedule) || [];
    var out = {}, any = false;

    for (var i = 0; i < sched.length; i++) {
      var mu = sched[i];
      if (mu.matchupPeriodId !== week) continue;
      /* Unplayed weeks still come back with full rosters and a column of zeros. Counting
         them reported "14 weeks counted" in August and left every team tied for worst. */
      if (!mu.winner || mu.winner === 'UNDECIDED') continue;
      ['away', 'home'].forEach(function (side) {
        var t = mu[side];
        if (!t || !t.rosterForCurrentScoringPeriod) return;
        var entries = t.rosterForCurrentScoringPeriod.entries || [];
        var bench = 0, counted = 0;
        for (var e = 0; e < entries.length; e++) {
          var en = entries[e];
          if (!WA_BENCH_SLOTS[en.lineupSlotId]) continue;      // starters skipped here
          var pts = (en.playerPoolEntry && en.playerPoolEntry.appliedStatTotal) || 0;
          bench += pts;
          counted++;
        }
        if (counted) {
          out[String(t.teamId)] = (out[String(t.teamId)] || 0) + bench;
          any = true;
        }
      });
    }
    return any ? out : {};
  } catch (err) {
    return null;
  }
}

/**
 * Season totals keyed by franchise NAME (resolved from ESPN team id).
 * Returns { ok, weeks_counted, teams: { name: points } }.
 */
function waBenchSeason_(force, seasonOverride) {
  var cache = CacheService.getScriptCache();
  var ckey = WA_BENCH_CACHE_KEY + (seasonOverride ? '_' + seasonOverride : '');
  if (!force) {
    var hit = cache.get(ckey);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }

  var espn = waEspnTeams_();                       // id -> current name
  if (!espn.ok) return { ok: false, error: espn.error, teams: {} };

  var byId = {}, weeksCounted = 0, emptyRun = 0;
  for (var w = 1; w <= WA_BENCH_MAX_WEEK; w++) {
    var wk = waBenchWeek_(w, seasonOverride);
    if (wk === null) break;                        // ESPN unhappy - keep what we have
    var ks = Object.keys(wk);
    if (!ks.length) {
      /* Every team plays every week, so two empties in a row means we have walked off
         the end of the played season. Without this the offseason costs 18 ESPN calls
         per cache miss to prove nothing has happened yet. */
      if (++emptyRun >= 2) break;
      continue;
    }
    emptyRun = 0;
    weeksCounted++;
    for (var k = 0; k < ks.length; k++) {
      byId[ks[k]] = (byId[ks[k]] || 0) + wk[ks[k]];
    }
  }

  var teams = {};
  Object.keys(espn.teams).forEach(function (id) {
    teams[espn.teams[id]] = Math.round((byId[id] || 0) * 10) / 10;
  });

  var out = { ok: true, weeks_counted: weeksCounted, teams: teams };
  try { cache.put(ckey, JSON.stringify(out), WA_BENCH_TTL); } catch (e) {}
  return out;
}

/** GET action=bench_points  - public, same as the other read feeds. */
function waBenchPoints_(e) {
  var force = String((e && e.parameter && e.parameter.refresh) || '') === '1';
  return waJson_(waBenchSeason_(force));
}

/* ---------------------------------------------------------------- ops */

/** Proof the parser works: 2025 actually has games in it. */
function previewBench2025() { previewBenchPoints(2025); }

/** Run from the editor. Prints the table and how many weeks actually counted. */
function previewBenchPoints(season) {
  var r = waBenchSeason_(true, season);
  if (!r.ok) { Logger.log('FAILED: ' + r.error); return; }
  var lines = ['season: ' + (season || 'current') + '  weeks counted: ' + r.weeks_counted];
  Object.keys(r.teams)
    .sort(function (a, b) { return r.teams[b] - r.teams[a]; })
    .forEach(function (t) { lines.push('  ' + r.teams[t] + '  ' + t); });
  if (!r.weeks_counted) lines.push('(no games played yet - zeros are correct in the offseason)');
  Logger.log(lines.join('\n'));
}
