/* ============================================================================
 * matchup.gs — full box scores for one scoring period.
 *
 * WHY IT EXISTS
 * The spike (claude/spike-h2h-detail.md) found that everything the detail view
 * needs — position, injury status, projected points, actual points, starter vs
 * bench — is ALREADY in the payload Code.gs fetches today. `getWeekTopScorers_`
 * walks every player on every roster, keeps the single highest scorer, and
 * throws the other ~160 rows away. This file stops throwing them away.
 *
 * WHY IT IS A SEPARATE FILE
 * Same reasoning as bench.gs. `getWeekTopScorers_` is the code path the live
 * scoreboard runs on; editing it in place to return more risks the thing that
 * already works. This file brings its own fetch, its own cache and one new
 * read-only action, and touches nothing else.
 *
 * WHY IT RETURNS THE WHOLE WEEK, NOT ONE MATCHUP
 * The obvious signature was matchup_detail(week, teamA, teamB). It is the wrong
 * one. Team NAMES are not a safe join key — the h2h feed alone ships
 * "THE Vagitarians " with a trailing space — and asking the server to match two
 * of them means reimplementing teamKey()/the franchise registry in Apps Script,
 * where it would drift. Returning every matchup in the week instead means:
 *   - the server never matches a name, it only reports ESPN team ids and the
 *     current ESPN name, exactly like bench.gs;
 *   - the client picks its matchup with the same resolver it already uses for
 *     everything else;
 *   - one ESPN call and one cache entry serve all five matchups, so opening a
 *     second matchup in the same week is free.
 *
 * Wiring: ONE line in doGet (Code.gs), guarded form —
 *   if (e && e.parameter && e.parameter.action === 'matchup_detail') return waMatchupDetail_(e);
 *
 * GET ?action=matchup_detail&week=5[&season=2025][&refresh=1]
 * Read-only. Writes nothing. Never throws — every failure answers ok:false.
 * ==========================================================================*/

var WA_MU_CACHE_PREFIX = 'wa_matchup_v1_';
var WA_MU_TTL_LIVE  = 300;      // 5 min while a week can still change
var WA_MU_TTL_FINAL = 21600;    // 6 h once every game in the week is decided
var WA_MU_CACHE_MAX = 90000;    // CacheService rejects >100KB; stay clear of the edge

var WA_MU_BENCH_SLOTS = { 20: 1, 21: 1 };          // 20 = BE, 21 = IR

/* ESPN lineup slot ids -> what a box score calls them. Anything not listed is a
   defensive/IDP slot this league does not use; it falls through to the player's
   own position so an unexpected slot can never render blank. */
var WA_MU_SLOTS = {
  0: 'QB', 2: 'RB', 3: 'RB/WR', 4: 'WR', 5: 'WR/TE', 6: 'TE',
  7: 'OP', 16: 'D/ST', 17: 'K', 18: 'P', 19: 'HC',
  20: 'BE', 21: 'IR', 23: 'FLEX'
};
var WA_MU_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
var WA_MU_PRO = {
  0: 'FA', 1: 'ATL', 2: 'BUF', 3: 'CHI', 4: 'CIN', 5: 'CLE', 6: 'DAL', 7: 'DEN',
  8: 'DET', 9: 'GB', 10: 'TEN', 11: 'IND', 12: 'KC', 13: 'LV', 14: 'LAR', 15: 'MIA',
  16: 'MIN', 17: 'NE', 18: 'NO', 19: 'NYG', 20: 'NYJ', 21: 'PHI', 22: 'ARI',
  23: 'PIT', 24: 'LAC', 25: 'SF', 26: 'SEA', 27: 'TB', 28: 'WSH', 29: 'CAR',
  30: 'JAX', 33: 'BAL', 34: 'HOU'
};

/* ---------------------------------------------------------------- helpers */

function waMuJson_(obj) {
  /* Deliberately not reusing Code.gs's waJson_. This file is meant to be
     droppable into the project with one wiring line and no other assumptions. */
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function waMuRound_(n) {
  var v = Number(n);
  if (!isFinite(v)) return 0;
  return Math.round(v * 10) / 10;
}

/* ---------------------------------------------------------------- fetch */

/** Raw ESPN box score for one scoring period. null on any failure. */
function waMuFetch_(week, seasonOverride) {
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
    return JSON.parse(res.getContentText());
  } catch (err) {
    return null;
  }
}

/* ---------------------------------------------------------------- parse */

/**
 * One roster entry -> one row.
 * `proj` and `pts` are separate reads on purpose. `appliedStatTotal` is the
 * actual, and is 0 for a game that has not kicked off; the projection lives in
 * player.stats[] under statSourceId 1 and exists for FUTURE weeks too, which is
 * what lets the page show a lineup before Sunday.
 */
function waMuPlayer_(entry, week, season) {
  var pool = entry.playerPoolEntry || {};
  var p = pool.player || {};
  var slotId = entry.lineupSlotId;
  var pos = WA_MU_POS[p.defaultPositionId] || '';

  var proj = null, actual = null;
  var stats = p.stats || [];
  for (var i = 0; i < stats.length; i++) {
    var s = stats[i];
    if (s.scoringPeriodId !== week) continue;
    if (Number(s.seasonId) !== Number(season)) continue;
    if (s.statSourceId === 1) proj = s.appliedTotal;
    else if (s.statSourceId === 0) actual = s.appliedTotal;
  }
  /* appliedStatTotal is the number ESPN itself shows in the box score column.
     Prefer it; fall back to the stats[] read only if it is missing entirely. */
  if (pool.appliedStatTotal != null) actual = pool.appliedStatTotal;

  return {
    name: p.fullName || '',
    pos: pos,
    slot: WA_MU_SLOTS[slotId] || pos || '',
    nfl: WA_MU_PRO[p.proTeamId] || '',
    inj: p.injuryStatus || 'ACTIVE',
    proj: proj == null ? null : waMuRound_(proj),
    pts: actual == null ? null : waMuRound_(actual),
    starter: !WA_MU_BENCH_SLOTS[slotId]
  };
}

/** One side of one matchup. */
function waMuSide_(side, week, season, names) {
  if (!side) return null;
  var entries = (side.rosterForCurrentScoringPeriod && side.rosterForCurrentScoringPeriod.entries) || [];
  var players = [];
  var benchPts = 0, starterProj = 0, benchProj = 0;

  for (var i = 0; i < entries.length; i++) {
    var row = waMuPlayer_(entries[i], week, season);
    players.push(row);
    if (row.starter) { starterProj += row.proj || 0; }
    else { benchPts += row.pts || 0; benchProj += row.proj || 0; }
  }

  /* Starters first, in board order, then the bench. The client should be able to
     render the list as-is without knowing ESPN's slot numbering. */
  var order = ['QB', 'RB', 'RB/WR', 'WR', 'WR/TE', 'TE', 'FLEX', 'OP', 'D/ST', 'K', 'P', 'HC', 'BE', 'IR'];
  players.sort(function (a, b) {
    if (a.starter !== b.starter) return a.starter ? -1 : 1;
    var ai = order.indexOf(a.slot), bi = order.indexOf(b.slot);
    if (ai === -1) ai = 99;
    if (bi === -1) bi = 99;
    return ai - bi || (b.pts || 0) - (a.pts || 0);
  });

  var id = String(side.teamId);
  return {
    teamId: side.teamId,
    team: (names && names[id]) || '',
    score: waMuRound_(side.totalPoints),
    projected: waMuRound_(starterProj),
    bench: waMuRound_(benchPts),
    benchProjected: waMuRound_(benchProj),
    players: players
  };
}

/* ---------------------------------------------------------------- build */

/**
 * Every matchup in one scoring period, both rosters in full.
 * { ok, season, week, played, matchups: [ {winner, played, away, home} ] }
 */
function waMuWeek_(week, force, seasonOverride) {
  var season = seasonOverride || PropertiesService.getScriptProperties().getProperty('ESPN_SEASON') ||
               (typeof ESPN_SEASON !== 'undefined' ? ESPN_SEASON : 2026);
  var ckey = WA_MU_CACHE_PREFIX + season + '_' + week;
  var cache = CacheService.getScriptCache();
  if (!force) {
    var hit = cache.get(ckey);
    if (hit) { try { return JSON.parse(hit); } catch (e) {} }
  }

  var data = waMuFetch_(week, seasonOverride);
  if (!data) return { ok: false, error: 'ESPN unavailable or credentials missing', week: week, matchups: [] };

  /* Names come from the same id -> name map the name sync and bench totals use,
     so a mid-season rename cannot orphan a matchup. Its absence is survivable —
     the client resolves identity from ESPN team ids and its own registry — so a
     failed name lookup degrades to empty strings rather than failing the call. */
  var names = {};
  try {
    var espn = waEspnTeams_();
    if (espn && espn.ok) names = espn.teams;
  } catch (e) {}

  var sched = (data && data.schedule) || [];
  var out = [], anyPlayed = false;

  for (var i = 0; i < sched.length; i++) {
    var mu = sched[i];
    if (mu.matchupPeriodId !== Number(week)) continue;
    var away = waMuSide_(mu.away, Number(week), Number(season), names);
    var home = waMuSide_(mu.home, Number(week), Number(season), names);
    if (!away || !home) continue;
    var decided = !!(mu.winner && mu.winner !== 'UNDECIDED');
    if (decided) anyPlayed = true;
    out.push({
      winner: mu.winner || 'UNDECIDED',
      /* `played` is per matchup, not per week: it is legal for a Thursday game to
         be final while the rest of the slate has not kicked off. */
      played: decided || away.score > 0 || home.score > 0,
      away: away,
      home: home
    });
  }

  var res = {
    ok: true,
    season: Number(season),
    week: Number(week),
    /* Pre-draft, ESPN still answers with last season's rosters or none at all.
       Saying so here is cheaper than every client guessing from empty arrays. */
    hasRosters: out.some(function (m) { return m.away.players.length || m.home.players.length; }),
    played: anyPlayed,
    updated: new Date().toISOString(),
    matchups: out
  };

  try {
    var body = JSON.stringify(res);
    /* CacheService rejects anything over 100KB by throwing. A week that is
       somehow too big should still be SERVED — it just is not cached. */
    if (body.length < WA_MU_CACHE_MAX) {
      cache.put(ckey, body, anyPlayed && out.every(function (m) {
        return m.winner && m.winner !== 'UNDECIDED';
      }) ? WA_MU_TTL_FINAL : WA_MU_TTL_LIVE);
    }
  } catch (e) {}

  return res;
}

/* ---------------------------------------------------------------- action */

/** GET action=matchup_detail&week=N — public, same as the other read feeds. */
function waMatchupDetail_(e) {
  var p = (e && e.parameter) || {};
  var week = parseInt(p.week, 10);
  if (!(week >= 1 && week <= 18)) {
    return waMuJson_({ ok: false, error: 'week must be 1-18', matchups: [] });
  }
  var force = String(p.refresh || '') === '1';
  var season = p.season ? parseInt(p.season, 10) : null;
  return waMuJson_(waMuWeek_(week, force, season));
}

/* ---------------------------------------------------------------- ops */

/** Proof the parser works against a season that actually has games in it. */
function previewMatchup2025() { previewMatchupWeek(1, 2025); }

/** Run from the editor. Prints one matchup in full so the parse can be eyeballed. */
function previewMatchupWeek(week, season) {
  var r = waMuWeek_(week || 1, true, season || null);
  if (!r.ok) { Logger.log('FAILED: ' + r.error); return; }
  var lines = ['season ' + r.season + ' week ' + r.week +
               '  matchups: ' + r.matchups.length +
               '  played: ' + r.played + '  rosters: ' + r.hasRosters];
  if (r.matchups.length) {
    var m = r.matchups[0];
    ['away', 'home'].forEach(function (k) {
      var s = m[k];
      lines.push('');
      lines.push(k.toUpperCase() + '  ' + (s.team || ('id ' + s.teamId)) +
                 '   score ' + s.score + '  proj ' + s.projected + '  bench ' + s.bench);
      s.players.forEach(function (pl) {
        lines.push('   ' + (pl.starter ? ' ' : '·') + ' ' +
                   (pl.slot + '    ').slice(0, 5) + ' ' +
                   (pl.name + '                    ').slice(0, 22) +
                   ' ' + (pl.nfl + '   ').slice(0, 4) +
                   ' proj ' + (pl.proj == null ? '—' : pl.proj) +
                   '  pts ' + (pl.pts == null ? '—' : pl.pts) +
                   (pl.inj && pl.inj !== 'ACTIVE' ? '  ' + pl.inj : ''));
      });
    });
  }
  Logger.log(lines.join('\n'));
}
