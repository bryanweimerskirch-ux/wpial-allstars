/**
 * h2hlog.gs — the per-meeting head-to-head log.
 *
 * Implements `claude/h2h-history-infrastructure.md`. Probe results that shaped it are in
 * `claude/h2h-backfill-probe-results.md` — all three of that contract's open assumptions were
 * verified live on 2026-08-04 before a line of this was written:
 *   - every season 2019-2025 is reachable
 *   - `playoffTierType` is populated (16 playoff matchups a season)
 *   - `mTeam` carries `owners: [guid]` for 10 of 10 teams, every season
 *
 * ES5 ONLY. This project runs the deprecated Rhino runtime — no const/let, no arrow
 * functions, no template literals, no Array.prototype.find.
 *
 * WHY THE MEMBER GUID
 * ESPN team ids are per-season league SLOTS and get reissued when an owner leaves. A 2019
 * matchup that says teamId 3 is not necessarily today's f04. Team NAMES are worse: this
 * league's own NameHistory tab shows f01 went Team Balzer -> Sutton My Face -> Najee Germany
 * -> Drake Draaaake?, and the h2h feed still ships "THE Vagitarians " with a trailing space.
 * The member GUID is the only identity stable across seasons, so the walk keys on it and the
 * log STORES it. Names are resolved once, at read time, from the current season — never
 * stored as history.
 *
 * DERIVE, DON'T TRANSCRIBE
 * winsA/winsB/ties are computed from meetings[] on every read. They are never stored. That
 * is the entire point: two hand-maintained aggregates that disagreed is what got us here.
 */

var WA_H2H_TAB     = 'H2HLog';
var WA_H2H_FROM    = 2019;
var WA_H2H_CACHE   = 'wa_h2hlog_v1';
var WA_H2H_TTL     = 21600;                 /* 6h, matching bench.gs */
var WA_H2H_HEADERS = ['season', 'week', 'playoff', 'guid_a', 'guid_b',
                      'score_a', 'score_b', 'winner_guid',
                      'espn_team_a', 'espn_team_b', 'source'];

function waH2hProp_(k) {
  return PropertiesService.getScriptProperties().getProperty(k) || '';
}

/* Column name -> index, so a reordered sheet cannot silently shift the meaning of a column.
   Same discipline as the WA_*_HEADERS map in admin.gs. */
function waH2hCols_(header) {
  var m = {}, i;
  for (i = 0; i < header.length; i++) m[String(header[i]).trim()] = i;
  return m;
}

function waH2hSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(WA_H2H_TAB);
  if (!sh) {
    sh = ss.insertSheet(WA_H2H_TAB);
    sh.getRange(1, 1, 1, WA_H2H_HEADERS.length).setValues([WA_H2H_HEADERS]);
    sh.setFrozenRows(1);
  }
  return sh;
}

/* One season of schedule + teams.
 *
 * TWO endpoint shapes, and neither one covers every season:
 *   - leagueHistory/{id}?seasonId=Y serves COMPLETED seasons. It answered for 2019-2025 on
 *     every probe, but asked for the CURRENT season it returns a payload with no teams. That
 *     is what silently emptied waH2hNames_() and made previewH2hReconcile() report 0 pairings
 *     off a sheet holding 578 rows.
 *   - seasons/Y/segments/0/leagues/{id} serves the current season.
 * So try them in order and take the first answer that actually carries what the caller needs.
 *
 * `want` is 'schedule' for the backfill walk and 'teams' for name resolution. Checking the
 * field the caller depends on — rather than just the status code — is what stops a 200 with
 * the wrong shape from being mistaken for real data. Second host mirrors waEspnTeams_().
 */
function waH2hFetch_(season, want) {
  var need = want || 'schedule';
  var views = '&view=mMatchupScore&view=mTeam';
  var paths = [
    'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/leagueHistory/'
      + ESPN_LEAGUE_ID + '?seasonId=' + season + views,
    'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + season
      + '/segments/0/leagues/' + ESPN_LEAGUE_ID + '?x=1' + views,
    'https://fantasy.espn.com/apis/v3/games/ffl/seasons/' + season
      + '/segments/0/leagues/' + ESPN_LEAGUE_ID + '?x=1' + views
  ];
  var opts = {
    muteHttpExceptions: true,
    followRedirects: true,
    headers: { 'Cookie': 'espn_s2=' + waH2hProp_('ESPN_S2') + '; SWID=' + waH2hProp_('ESPN_SWID'),
               'Accept': 'application/json' }
  };
  var i, res, d;
  for (i = 0; i < paths.length; i++) {
    try {
      res = UrlFetchApp.fetch(paths[i], opts);
      if (res.getResponseCode() !== 200) continue;
      d = null;
      try { d = JSON.parse(res.getContentText()); } catch (e2) { continue; }
      /* leagueHistory answers with a one-element array; seasons/ answers with an object. */
      if (d && typeof d.length === 'number' && d.length) d = d[0];
      if (d && d[need] && d[need].length) return d;
    } catch (e) { /* try the next shape */ }
  }
  return null;
}

/* teamId -> guid, for ONE season. Never reuse across seasons; that is the whole hazard. */
function waH2hGuidMap_(data) {
  var m = {}, teams = (data && data.teams) || [], i;
  for (i = 0; i < teams.length; i++) {
    if (teams[i].owners && teams[i].owners.length) m[teams[i].id] = String(teams[i].owners[0]);
  }
  return m;
}

/* ---------------------------------------------------------------------------
 * backfillH2hLog() — walk 2019..last completed season, write H2HLog.
 * IDEMPOTENT. Row identity is season + week + guid_a + guid_b. Re-running updates in
 * place, appends what is new, and never touches a row whose source is 'manual'.
 * It will be run twice, because the first run will find something wrong.
 * ------------------------------------------------------------------------ */
function backfillH2hLog() {
  var sh = waH2hSheet_();
  var vals = sh.getDataRange().getValues();
  var cols = waH2hCols_(vals.length ? vals[0] : WA_H2H_HEADERS);
  var rowAt = {}, isManual = {}, i, key;

  for (i = 1; i < vals.length; i++) {
    key = [vals[i][cols.season], vals[i][cols.week], vals[i][cols.guid_a], vals[i][cols.guid_b]].join('|');
    rowAt[key] = i + 1;
    if (String(vals[i][cols.source]) === 'manual') isManual[key] = true;
  }

  var thisSeason = Number(ESPN_SEASON) || (new Date()).getFullYear();
  var appended = [], updated = 0, protectedRows = 0, report = [], y;

  for (y = WA_H2H_FROM; y < thisSeason; y++) {
    var d = waH2hFetch_(y);
    if (!d) { report.push(y + ': UNREACHABLE'); continue; }
    var guidOf = waH2hGuidMap_(d);
    var sch = d.schedule || [], kept = 0, orphan = 0, j;

    for (j = 0; j < sch.length; j++) {
      var m = sch[j];
      if (!m.winner || m.winner === 'UNDECIDED') continue;      /* unplayed */
      var aId = m.away ? m.away.teamId : null, hId = m.home ? m.home.teamId : null;
      var ga = guidOf[aId] || '', gh = guidOf[hId] || '';
      if (!ga || !gh) orphan++;                                  /* recorded, never guessed */

      var aS = (m.away && m.away.totalPoints) || 0;
      var hS = (m.home && m.home.totalPoints) || 0;
      var winner = (m.winner === 'AWAY') ? ga : gh;
      var playoff = !!(m.playoffTierType && m.playoffTierType !== 'NONE');

      /* Stored in SORTED guid order so a lookup never has to try both orientations, and
         scores follow that orientation rather than ESPN's home/away. */
      var flip = ga > gh;
      var row = [ y, m.matchupPeriodId, playoff,
                  flip ? gh : ga, flip ? ga : gh,
                  flip ? hS : aS, flip ? aS : hS,
                  winner,
                  flip ? hId : aId, flip ? aId : hId,
                  'espn' ];

      key = [row[0], row[1], row[3], row[4]].join('|');
      if (isManual[key]) { protectedRows++; continue; }
      if (rowAt[key]) {
        sh.getRange(rowAt[key], 1, 1, row.length).setValues([row]);
        updated++;
      } else {
        appended.push(row);
        rowAt[key] = -1;                                          /* claim it within this run */
      }
      kept++;
    }
    report.push(y + ': ' + kept + ' meetings' + (orphan ? ' (' + orphan + ' vs a departed franchise)' : ''));
  }

  /* ONE write for every new row. appendRow in a loop is a round trip per row and will time
     out on a first run of ~578. */
  if (appended.length) {
    sh.getRange(sh.getLastRow() + 1, 1, appended.length, WA_H2H_HEADERS.length).setValues(appended);
  }
  CacheService.getScriptCache().remove(WA_H2H_CACHE);

  Logger.log('backfillH2hLog: +' + appended.length + ' appended, ' + updated + ' updated, '
             + protectedRows + ' manual rows left alone');
  Logger.log(report.join('\n'));
  return { appended: appended.length, updated: updated, manual: protectedRows, seasons: report };
}

/* ---------------------------------------------------------------------------
 * Reading: derive everything from meetings[].
 * ------------------------------------------------------------------------ */

/* guid -> CURRENT team name, from the live season. Recomputed at read time on purpose: a
   rename should follow the franchise, and the log itself stores only guids. */
function waH2hNames_() {
  var d = waH2hFetch_(Number(ESPN_SEASON) || (new Date()).getFullYear(), 'teams');
  var out = {}, teams = (d && d.teams) || [], i, j;
  for (i = 0; i < teams.length; i++) {
    var nm = String(teams[i].name || '').trim();
    var ow = teams[i].owners || [];
    for (j = 0; j < ow.length; j++) out[String(ow[j])] = nm;
  }
  return out;
}

function waH2hBuild_() {
  var sh = waH2hSheet_();
  var vals = sh.getDataRange().getValues();
  if (vals.length < 2) return { ok: false, error: 'H2HLog is empty — run backfillH2hLog() first.' };
  var cols = waH2hCols_(vals[0]);
  var names = waH2hNames_();

  var byPair = {}, seasons = {}, i;
  for (i = 1; i < vals.length; i++) {
    var r = vals[i];
    var ga = String(r[cols.guid_a] || ''), gb = String(r[cols.guid_b] || '');
    var na = names[ga], nb = names[gb];
    /* A side that resolves to no current franchise is real history but not a current
       rivalry. Excluded from every tally, never guessed at. */
    if (!na || !nb) continue;

    var k = ga + '|' + gb;
    if (!byPair[k]) byPair[k] = { teamA: na, teamB: nb, firstSeason: null, meetings: [] };
    var p = byPair[k];
    var season = Number(r[cols.season]);
    seasons[season] = 1;
    if (p.firstSeason === null || season < p.firstSeason) p.firstSeason = season;

    var wg = String(r[cols.winner_guid] || '');
    p.meetings.push({
      season: season,
      week: Number(r[cols.week]),
      playoff: r[cols.playoff] === true || String(r[cols.playoff]).toLowerCase() === 'true',
      a: Number(r[cols.score_a]),
      b: Number(r[cols.score_b]),
      winner: wg === ga ? 'A' : (wg === gb ? 'B' : null)
    });
  }

  var keys = [], yrs = [], k2;
  for (k2 in byPair) if (byPair.hasOwnProperty(k2)) keys.push(k2);
  for (k2 in seasons) if (seasons.hasOwnProperty(k2)) yrs.push(Number(k2));
  yrs.sort(function (x, y) { return x - y; });

  var pairs = [], n;
  for (n = 0; n < keys.length; n++) {
    var pp = byPair[keys[n]];
    /* newest first — the design reads the log top down */
    pp.meetings.sort(function (x, y) { return (y.season - x.season) || (y.week - x.week); });
    pairs.push(pp);
  }

  return {
    ok: true,
    updated: (new Date()).toISOString(),
    seasons: yrs.length ? [yrs[0], yrs[yrs.length - 1]] : [],
    /* complete only if every season from the intended first one is present */
    complete: yrs.length ? (yrs[0] <= WA_H2H_FROM) : false,
    pairs: pairs
  };
}

function waH2hLog_(e) {
  var cache = CacheService.getScriptCache();
  var fresh = e && e.parameter && e.parameter.refresh;
  if (!fresh) {
    var hit = cache.get(WA_H2H_CACHE);
    if (hit) { try { return jsonOut_(JSON.parse(hit)); } catch (ig) {} }
  }
  var payload;
  try { payload = waH2hBuild_(); }
  catch (err) { return jsonOut_({ ok: false, error: String(err) }); }

  var body = JSON.stringify(payload);
  /* CacheService throws above 100KB. Serve it, just do not cache it — same guard matchup.gs
     uses, and the reason the size is logged rather than silently swallowed. */
  if (body.length < 92000) cache.put(WA_H2H_CACHE, body, WA_H2H_TTL);
  else Logger.log('h2h_log payload ' + body.length + ' bytes — served, not cached');
  return jsonOut_(payload);
}

/* ---------------------------------------------------------------------------
 * previewH2hReconcile() — THE ACCEPTANCE GATE.
 * Prints the derived tally beside the hand-kept LEAGUE_H2H_JSON one, per pairing, and
 * flags every disagreement. Bryan reviews this BEFORE the derived number goes live; he
 * should see the diff, not discover it.
 * ------------------------------------------------------------------------ */
function previewH2hReconcile() {
  var built = waH2hBuild_();
  if (!built.ok) { Logger.log(built.error); return built; }

  var old = {}, i, j;
  try {
    var raw = getLeagueH2h_();
    var list = (raw && raw.matchups) || raw || [];
    for (i = 0; i < list.length; i++) {
      var a = String(list[i].teamA || '').trim(), b = String(list[i].teamB || '').trim();
      old[[a, b].sort().join('|')] = { winsA: list[i].winsA, winsB: list[i].winsB,
                                       ties: list[i].ties || 0, teamA: a, teamB: b };
    }
  } catch (e) { Logger.log('could not read LEAGUE_H2H_JSON: ' + e); }

  var lines = [], agree = 0, differ = 0, missing = 0;
  var totalRegular = 0, totalPlayoff = 0;

  for (i = 0; i < built.pairs.length; i++) {
    var p = built.pairs[i], wa = 0, wb = 0, ties = 0, po = 0;
    for (j = 0; j < p.meetings.length; j++) {
      var m = p.meetings[j];
      if (m.playoff) po++;
      if (m.winner === 'A') wa++; else if (m.winner === 'B') wb++; else ties++;
    }
    totalPlayoff += po; totalRegular += (p.meetings.length - po);

    var key = [p.teamA, p.teamB].sort().join('|');
    var o = old[key];
    if (!o) { missing++; lines.push('NEW   ' + p.teamA + ' vs ' + p.teamB + '  derived ' + wa + '-' + wb); continue; }
    /* orient the old record the same way as the derived one */
    var oa = (String(o.teamA).trim() === p.teamA) ? o.winsA : o.winsB;
    var ob = (String(o.teamA).trim() === p.teamA) ? o.winsB : o.winsA;
    if (oa === wa && ob === wb) { agree++; continue; }
    differ++;
    lines.push('DIFF  ' + p.teamA + ' vs ' + p.teamB
               + '   sheet ' + oa + '-' + ob + '   derived ' + wa + '-' + wb
               + '   (' + po + ' playoff of ' + p.meetings.length + ')');
  }

  Logger.log('=== previewH2hReconcile ===');
  Logger.log('pairings: ' + built.pairs.length + '   agree: ' + agree
             + '   differ: ' + differ + '   not in the old feed: ' + missing);
  Logger.log('meetings: ' + (totalRegular + totalPlayoff)
             + '  (regular ' + totalRegular + ', playoff ' + totalPlayoff + ')');
  Logger.log('NOTE: the derived tally INCLUDES playoff meetings. LEAGUE_HISTORY_JSON counts');
  Logger.log('      regular season only — that alone explains most of the gap. Bryan rules');
  Logger.log('      on whether all-time includes January; the log stores the flag either way.');
  Logger.log(lines.length ? lines.join('\n') : 'every pairing agrees');
  return { agree: agree, differ: differ, missing: missing,
           regular: totalRegular, playoff: totalPlayoff };
}

/* Reachability probe. Kept because the contract asks for it, though the 2026-08-04 run
   already answered it: all seven seasons reachable, both endpoint shapes, guids on 10/10. */
function probeSeason() {
  var y, out = [];
  for (y = WA_H2H_FROM; y <= 2025; y++) {
    var d = waH2hFetch_(y);
    var g = d ? waH2hGuidMap_(d) : {};
    var c = 0, k;
    for (k in g) if (g.hasOwnProperty(k)) c++;
    out.push(y + ': ' + (d ? (d.schedule.length + ' matchups, ' + c + ' teams with a guid') : 'UNREACHABLE'));
  }
  Logger.log(out.join('\n'));
  return out;
}
