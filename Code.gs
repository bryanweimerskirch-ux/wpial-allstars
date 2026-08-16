/**
 * WPIAL Feed API
 * Backend for the WPIAL All Stars fantasy site.
 *
 * SCOPE / SECURITY NOTE:
 * This script only ever reads/writes two tabs in this Sheet: "Feed Posts" and "Tips".
 * It never touches any roster, keeper, or draft-value tab, and it never changes
 * this Sheet's or Drive's sharing/privacy settings. Deploying this as a Web App
 * with "Anyone" access only exposes the two functions below (doGet/doPost) -
 * it does not expose the underlying Sheet or Drive file itself. The Gemini API
 * key lives in Script Properties (Project Settings > Script Properties) - it is
 * never sent to the client and never appears in any doGet/doPost response.
 */

var SHEET_ID = '1txXMABMobhOObWZKUJZ-yot7YtD5TgZny5Dxg1ucJbw';
var FEED_SHEET = 'Feed Posts';
var TIPS_SHEET = 'Tips';

// Tips tab column positions (1-indexed, matches the sheet's header row):
// A=timestamp  B=tip_text  C=status  D=reviewed_text  E=feed_row
var TIPS_COL_STATUS = 3;
var TIPS_COL_REVIEWED_TEXT = 4;
var TIPS_COL_FEED_ROW = 5;
var LIVE_STATUSES = ['Approved', 'Approved with Comments'];

// Fallback prefix used only if the Gelly AI rewrite fails or no API key is
// configured - keeps tip-originated posts anonymous ("sources", not the
// submitting owner) even in that degraded case.
var TIP_PREFIX = 'Per Sources: ';
var GEMINI_MODEL = 'gemini-flash-latest';
var SPORTSDB_API_KEY = '123'; // TheSportsDB.com free-tier shared key (public, not a secret)

// Shared Gelly persona voice, used by both the tip-rewrite pipeline
// (generateGellyPost_) and the twice-weekly off-season report
// (generateOffseasonReportPost_) so both surfaces stay voice-consistent.
var GELLY_PERSONA_ =
  'You are Gelly, the self-appointed insider and gossip columnist for ' +
  'a fantasy football league called WPIAL All Stars. He\'s a guy ' +
  '(he/him). Voice: professional enough to run the desk, but ' +
  'underneath it a dumb sports jock - dramatic, self-important, ' +
  'confident to the point of arrogant. Dumb hot takes are the brand: ' +
  'confident, half-baked opinions about players and moves, picked ' +
  'specifically to needle league members, are encouraged - that IS ' +
  'the voice, not a mistake to correct. Signature catchphrase is ' +
  '"I\'ve done the research." You can sign off big posts with ' +
  '"HERE WE GO" but do not force it into every post.' +
  ' RUNNING GAG: any headline about the team Drake Draaaake? (or whatever that ' +
  'franchise is currently called) MUST begin with exactly "He here, HE\'S...." ' +
  'before the rest of the headline. That one team only, headline only, and never ' +
  'explain the joke.';

var GELLY_CONDUCT_POLICY_ =
  'Conduct policy: this is a private fantasy league group having fun ' +
  'together - trash talk, roasting, dumb hot takes, dumb arguments ' +
  'about players, and needling opinions designed to get under a ' +
  'league member\'s skin are all fair game and encouraged, not ' +
  'something to soften - that is the whole voice. But this is still a ' +
  'shared public-facing page, so hold two hard lines: no racism ' +
  '(slurs, stereotypes, or hate speech targeting race, ethnicity, ' +
  'religion, or similar), and nothing else overly offensive - meaning ' +
  'no sexual content about real people, no threats or incitement of ' +
  'violence, no harassment that crosses from ribbing into targeted ' +
  'cruelty, and no sharing anyone\'s private contact info.';

function jsonOut_(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function getTab_(name) {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sheet = ss.getSheetByName(name);
  if (!sheet) throw new Error('Sheet tab not found: ' + name);
  return sheet;
}

function doGet(e) {
  if (e && e.parameter && e.parameter.action === 'insider_reports') return listInsiderReports_(e);
  if (e && e.parameter && e.parameter.action === 'interest_counts') return listInterestCounts_(e);
  if (e && e.parameter && e.parameter.action === 'keepers') return listKeepers_(e);
  if (e && e.parameter && e.parameter.action === 'h2h') return listH2h_(e);
  if (e && e.parameter && e.parameter.action === 'history') return listHistory_(e);
  if (e && e.parameter && e.parameter.action === 'rules') return listRules_(e);
  if (e && e.parameter && e.parameter.action === 'espn_schedule') return listEspnSchedule_(e);
  if (e && e.parameter && e.parameter.action === 'gelly_picks') return listGellyPicks_(e);
  if (e && e.parameter && e.parameter.action === 'rankings') return rankingsResponse_(e);
  if (e && e.parameter && e.parameter.action === 'auth_ping') return waPing_();
  if (e && e.parameter && e.parameter.action === 'bench_points') return waBenchPoints_(e);
  if (e && e.parameter && e.parameter.action === 'matchup_detail') return waMatchupDetail_(e);
  if (e && e.parameter && e.parameter.action === 'h2h_log') return waH2hLog_(e);
  if (e && e.parameter && e.parameter.action === 'keepers_v2') return waKeepersV2_();
  var action = (e && e.parameter && e.parameter.action) || 'feed';

  if (action === 'feed') {
    var sheet = getTab_(FEED_SHEET);
    var values = sheet.getDataRange().getValues();
    if (values.length < 2) return jsonOut_({ posts: [] });

    var headers = values[0].map(function (h) { return String(h).trim().toLowerCase(); });
    var posts = [];
    for (var i = values.length - 1; i >= 1; i--) {
      var row = values[i];
      if (row.join('') === '') continue;
      var post = {};
      headers.forEach(function (h, idx) { post[h] = row[idx]; });
      post.row = i + 1; // stable sheet row - removeFeedPost_ blanks rather than deletes, so this survives
      posts.push(post);
    }
    return jsonOut_({ posts: posts });
  }

  return jsonOut_({ error: 'Unknown action' });
}

function doPost(e) {
  if (e && e.parameter && e.parameter.action === 'insider_report') return handleInsiderPost_(e);
  if (e && e.parameter && e.parameter.action === 'interest') return handleInterest_(e);
  if (e && e.parameter && e.parameter.action === 'keeper_add') return handleKeeperAdd_(e);
  if (e && e.parameter && e.parameter.action === 'gelly_trade') return gellyTrade_(e);
  if (e && e.parameter && e.parameter.action === 'gelly_publish') return gellyPublish_(e);
  if (e && e.parameter && e.parameter.action === 'auth_status') return waStatus_(e);
  if (e && e.parameter && e.parameter.action === 'auth_signup') return waSignup_(e);
  if (e && e.parameter && e.parameter.action === 'auth_login') return waLogin_(e);
  if (e && e.parameter && e.parameter.action === 'auth_me') return waMe_(e);
  if (e && e.parameter && e.parameter.action === 'keeper_save') return waKeeperSave_(e);
  if (e && e.parameter && e.parameter.action === 'admin_stats') return waAdminStats_(e);
  if (e && e.parameter && e.parameter.action === 'watchlist_get') return waWatchGet_(e);
  if (e && e.parameter && e.parameter.action === 'watchlist_save') return waWatchSave_(e);
  if (e && e.parameter && e.parameter.action === 'watchlist_all') return waWatchAll_(e);
  if (e && e.parameter && e.parameter.action === 'auth_firebase') return waFbAuth_(e);
  if (e && e.parameter && e.parameter.action === 'profiles_all') return waProfilesAll_(e);
  if (e && e.parameter && e.parameter.action === 'profile_save')  return waProfileSave_(e);
  try {
    var params = {};
    if (e.postData && e.postData.type === 'application/json') {
      params = JSON.parse(e.postData.contents);
    } else {
      params = e.parameter;
    }

    if (params.website) {
      return jsonOut_({ ok: true });
    }

    var action = params.action || 'tip';

    if (action === 'tip') {
      var tipText = (params.tip_text || '').toString().trim();

      if (!tipText) {
        return jsonOut_({ ok: false, error: 'Empty tip.' });
      }
      if (tipText.length > 1000) {
        return jsonOut_({ ok: false, error: 'Tip is too long (max 1000 characters).' });
      }
      var linkCount = (tipText.match(/https?:\/\//g) || []).length;
      if (linkCount > 1) {
        return jsonOut_({ ok: false, error: 'Too many links.' });
      }

      var sheet = getTab_(TIPS_SHEET);
      var last = sheet.getDataRange().getValues();
      var lastRow = last[last.length - 1];
      if (lastRow && lastRow[1] === tipText) {
        var lastTime = new Date(lastRow[0]).getTime();
        if (Date.now() - lastTime < 60000) {
          return jsonOut_({ ok: true });
        }
      }

      // Tips now auto-publish immediately - no manual commissioner
      // approval step. The guards above (honeypot, length cap, one-link
      // limit, dedupe, formula-injection guard) are now the only line of
      // defense before a tip goes live. Bryan can still take a live post
      // down after the fact by setting this row's Status to Denied (or
      // back to Pending) in the Tips tab - see onEdit()/syncTipRowToFeed_
      // below, which already treat that as "pull it."
      if (/^[=+\-@]/.test(tipText)) tipText = "'" + tipText; // guard against Sheets formula injection
      var lock = LockService.getScriptLock();
      lock.waitLock(5000);
      try {
        sheet.appendRow([new Date(), tipText, 'Approved']);
        syncTipRowToFeed_(sheet, sheet.getLastRow());
      } finally {
        lock.releaseLock();
      }
      return jsonOut_({ ok: true });
    }
    if (action === 'like' || action === 'view') {
      var rowNum = Number(params.row);
      if (!rowNum || rowNum < 2) {
        return jsonOut_({ ok: false, error: 'Invalid post.' });
      }
      var feedSheet = getTab_(FEED_SHEET);
      if (rowNum > feedSheet.getLastRow()) {
        return jsonOut_({ ok: false, error: 'Invalid post.' });
      }
      var statCol = action === 'like' ? 'likes' : 'views';
      var newCount = incrementFeedStat_(feedSheet, rowNum, statCol);
      if (newCount === null) return jsonOut_({ ok: false, error: 'Could not update.' });
      return jsonOut_({ ok: true, count: newCount });
    }


    return jsonOut_({ ok: false, error: 'Unknown action' });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/**
 * Simple trigger - fires automatically on any manual edit to this Sheet.
 * Only acts on edits inside the Tips tab, and only ever writes to the
 * Feed Posts tab (plus the feed_row tracking column back on Tips), in
 * keeping with the scope note above.
 *
 * New tips now auto-publish the moment they're submitted (see doPost),
 * so this trigger is no longer the primary path to a first publish. It
 * still does two things: (1) manual takedown - Bryan can pull a live
 * post by setting its Status to Denied (or back to Pending) in the Tips
 * tab, which removes it from Feed Posts (see the LIVE_STATUSES check in
 * syncTipRowToFeed_); and (2) live edits - if Bryan writes a cleaned-up
 * version into reviewed_text on a row that's already live, this calls
 * Gelly's AI voice (generateGellyPost_) again and updates the SAME Feed
 * Posts row in place instead of creating a duplicate.
 */
function onEdit(e) {
  try {
    if (!e || !e.range) return;
    var sheet = e.range.getSheet();
    if (sheet.getName() !== TIPS_SHEET) return;

    var firstRow = Math.max(e.range.getRow(), 2); // never touch header row
    var lastRow = e.range.getLastRow();
    var firstCol = e.range.getColumn();
    var lastCol = e.range.getLastColumn();

    // Only care about edits that touch Status or Reviewed Text.
    var touchesRelevantCol = (firstCol <= TIPS_COL_STATUS && lastCol >= TIPS_COL_STATUS) ||
      (firstCol <= TIPS_COL_REVIEWED_TEXT && lastCol >= TIPS_COL_REVIEWED_TEXT);
    if (!touchesRelevantCol) return;

    for (var r = firstRow; r <= lastRow; r++) {
      syncTipRowToFeed_(sheet, r);
    }
  } catch (err) {
    console.error('onEdit failed: ' + err);
  }
}

function syncTipRowToFeed_(tipsSheet, row) {
  var rowValues = tipsSheet.getRange(row, 1, 1, TIPS_COL_FEED_ROW).getValues()[0];
  var tipText = String(rowValues[1] || '').trim();
  var status = String(rowValues[TIPS_COL_STATUS - 1] || '').trim();
  var reviewedText = String(rowValues[TIPS_COL_REVIEWED_TEXT - 1] || '').trim();
  var feedRow = rowValues[TIPS_COL_FEED_ROW - 1];

  if (LIVE_STATUSES.indexOf(status) === -1) {
    // Not (or no longer) approved - e.g. denied, or reset back to
    // Pending. If this tip had already been published, pull the post
    // back out of the feed instead of leaving a stale one up.
    if (feedRow) {
      removeFeedPost_(getTab_(FEED_SHEET), Number(feedRow));
      tipsSheet.getRange(row, TIPS_COL_FEED_ROW).clearContent();
    }
    return;
  }

  var rawText = reviewedText || tipText;
  if (!rawText) return;
  var postText = generateGellyPost_(rawText);

  var feedSheet = getTab_(FEED_SHEET);

  if (feedRow) {
    updateFeedPost_(feedSheet, Number(feedRow), postText, rawText);
  } else {
    var newRowNum = appendFeedPost_(feedSheet, postText, rawText);
    tipsSheet.getRange(row, TIPS_COL_FEED_ROW).setValue(newRowNum);
  }
}

/**
 * Sends an approved tip to Gemini to be rewritten in Gelly's voice -
 * dramatic self-appointed league insider, catchphrases like "I've done
 * the research," anonymous sourcing (never names/guesses the submitting
 * owner), tweet-length, no invented facts beyond what's given. If the
 * original tip includes a source URL, that URL is preserved verbatim so
 * it stays a working link once the frontend linkifies it. Also carries a
 * baseline conduct policy (see systemPrompt below) so the league can
 * still talk trash and have fun, but hate speech, threats, harassment,
 * and sexual content about real people get defanged even if they slipped
 * past the commissioner's own review. Falls back to the plain "Per
 * Sources:" prefix (never blocks publishing) if the key is missing, the
 * request fails, or the response is empty - so a Gemini hiccup never
 * means an approved tip silently fails to post.
 */
/**
 * ROSTER SNAPSHOT
 * -----------------
 * League rosters (team, round, keeper status) live entirely in the site's
 * client-side JS (index.html's ROSTERS object) - there is no shared
 * database this script can query directly. To let Gelly reference real
 * roster context in tip rewrites, we keep a manually-refreshed JSON copy
 * of ROSTERS in Script Properties under the key ROSTER_SNAPSHOT_JSON.
 *
 * HOW TO REFRESH (do this whenever a keeper trade or draft changes a
 * roster - expected to be rare, a few times a year at most):
 *   1. Open https://wadi.solutions in a browser.
 *   2. Open DevTools (F12) -> Console tab, and run:
 *        JSON.stringify(ROSTERS)
 *   3. Right-click the printed string in the console -> Copy string
 *      contents (or select it and copy).
 *   4. In this Apps Script project: Project Settings (gear icon, left
 *      sidebar) -> Script Properties -> find ROSTER_SNAPSHOT_JSON ->
 *      paste the new value in -> Save script properties.
 * No code change or redeploy needed - generateGellyPost_ below reads
 * this property fresh on every call, so the new snapshot takes effect
 * on the very next approved tip.
 */
function getRosterSnapshot_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('ROSTER_SNAPSHOT_JSON');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('getRosterSnapshot_ failed: ' + err);
    return null;
  }
}

/**
 * LEAGUE HISTORY SNAPSHOT
 * -----------------
 * Championship history, standings, and career records live as static
 * hardcoded HTML in index.html's "League history" section - there is no
 * shared JS data object for it (unlike ROSTERS). To let Gelly reference
 * real accolades and correct real league history in tip rewrites, we keep
 * a manually-refreshed JSON copy in Script Properties under the key
 * LEAGUE_HISTORY_JSON: an array of franchise records, each with
 * { name, aliases, status, championships, runnerUps, thirds, careerWins,
 * avgWinsPerSeason, avgFinish, grade }, sourced from the site's
 * "Year-by-year champion / runner-up / third" and "Career wins by
 * franchise" tables plus the franchise lineage aliases.
 *
 * HOW TO REFRESH (do this whenever a season ends and the history tables
 * update - expected once a year):
 * 1. Open https://wadi.solutions -> League history tab.
 * 2. Update the LEAGUE_HISTORY_JSON array to match the new year-by-year
 * table and career wins table (add the new season's champion/runner-up/
 * 3rd place, bump career win totals).
 * 3. In this Apps Script project: Project Settings (gear icon, left
 * sidebar) -> Script Properties -> find LEAGUE_HISTORY_JSON -> paste
 * the updated value in -> Save script properties.
 * No code change or redeploy needed - generateGellyPost_ below reads
 * this property fresh on every call.
 */
function getLeagueHistory_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('LEAGUE_HISTORY_JSON');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('getLeagueHistory_ failed: ' + err);
    return null;
  }
}
function getLeagueH2h_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('LEAGUE_H2H_JSON');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('getLeagueH2h_ failed: ' + err);
    return null;
  }
}

function listHistory_(e) {
  var history = getLeagueHistory_();
  if (!history) return jsonOut_({ ok: false, error: 'History data not available' });
  var rows = Object.keys(history).map(function (guid) {
    var f = history[guid];
    var seasons = f.ps || [];
    var finishes = seasons.map(function (s) { return s[6]; }).filter(function (x) { return typeof x === 'number'; });
    var avgFinish = finishes.length ? (finishes.reduce(function (a, b) { return a + b; }, 0) / finishes.length) : null;
    var bestPick = null;
    var topDraftPicks = [];
    if (f.bd && f.bd.length) {
      var top = f.bd[0];
      bestPick = { player: top.pl, year: top.y, round: top.rd, points: top.pts, ppg: top.ppg };
      topDraftPicks = f.bd.slice(0, 3).map(function (p) {
        return { player: p.pl, year: p.y, round: p.rd, points: p.pts, ppg: p.ppg };
      });
    }
    return {
      guid: guid,
      name: f.fr,
      wins: f.w,
      losses: f.l,
      ties: f.t || 0,
      winPct: f.wp,
      pointsFor: f.pf,
      ppg: f.ppg,
      championships: f.ch,
      championshipYears: f.chY || [],
      avgWinsPerSeason: seasons.length ? (f.w / seasons.length) : null,
      avgFinish: avgFinish,
      bestPick: bestPick,
      topDraftPicks: topDraftPicks,
      seasons: seasons.length
    };
  });
  rows.sort(function (a, b) { return b.wins - a.wins; });
  return jsonOut_({ ok: true, franchises: rows });
}

function listH2h_(e) {
  var history = getLeagueHistory_();
  var h2h = getLeagueH2h_();
  if (!history || !h2h) return jsonOut_({ ok: false, error: 'H2H data not available' });
  var nameToGuid = {};
  Object.keys(history).forEach(function (guid) {
    nameToGuid[normalizeTeamName_(history[guid].fr)] = guid;
  });
  var teamA = e && e.parameter && e.parameter.team_a;
  var teamB = e && e.parameter && e.parameter.team_b;
  if (teamA && teamB) {
    var guidA = nameToGuid[normalizeTeamName_(teamA)];
    var guidB = nameToGuid[normalizeTeamName_(teamB)];
    if (!guidA || !guidB) return jsonOut_({ ok: false, error: 'Unknown team(s)' });
    var row = h2h.filter(function (r) {
      return (r[0] === guidA && r[1] === guidB) || (r[0] === guidB && r[1] === guidA);
    })[0];
    if (!row) return jsonOut_({ ok: true, found: false });
    var aWins = row[0] === guidA ? row[2] : row[3];
    var bWins = row[0] === guidA ? row[3] : row[2];
    var ties = row[4];
    return jsonOut_({ ok: true, found: true, teamA: teamA, teamB: teamB, winsA: aWins, winsB: bWins, ties: ties });
  }
  var full = h2h.map(function (r) {
    var fa = history[r[0]], fb = history[r[1]];
    return { teamA: fa ? fa.fr : r[0], teamB: fb ? fb.fr : r[1], winsA: r[2], winsB: r[3], ties: r[4] };
  });
  return jsonOut_({ ok: true, matchups: full });
}

function normalizeTeamName_(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.'?!]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}
/**
 * Scans tip text for mentions of any franchise/owner name or historical
 * alias in the league history snapshot (whole-word, normalized match,
 * same approach as findRosteredPlayers_). Returns the matching franchise
 * records, each still containing its full championships/runnerUps/thirds/
 * careerWins - this is the ONLY source of truth Gelly gets for real
 * league accolades.
 */
function findMentionedFranchises_(text, history) {
  if (!history || !text) return [];
  var normalizedText = ' ' + normalizeTeamName_(text) + ' ';
  var matches = [];
  Object.keys(history).forEach(function (guid) {
    var f = history[guid];
    var names = [f.fr].concat(f.nm || []);
    var hit = names.some(function (n) {
      var norm = normalizeTeamName_(n);
      if (!norm) return false;
      var pattern = new RegExp('\\b' + norm.replace(/\s+/g, '\\s+') + '\\b');
      return pattern.test(normalizedText);
    });
    if (hit) {
      var withGuid = {};
      for (var k in f) withGuid[k] = f[k];
      withGuid.guid = guid;
      matches.push(withGuid);
    }
  });
  return matches;
}

function buildHistoryContext_(matches) {
  if (!matches || !matches.length) return '';
  var lines = matches.map(function (f) {
    var record = f.w + '-' + f.l + (f.t ? '-' + f.t : '') + ' all-time (' + (f.wp * 100).toFixed(1) + '% win rate)';
    var scoring = f.ppg.toFixed(1) + ' points per game for their career, ' + Math.round(f.pf) + ' total points scored across their history';
    var titleText = f.ch > 0
      ? f.ch + ' championship' + (f.ch > 1 ? 's' : '') + (f.chY && f.chY.length ? ' (' + f.chY.join(', ') + ')' : '')
      : 'NO championships on record - never won a title, ever';
    var lineage = (f.nm && f.nm.length > 1) ? ' Known historically as: ' + f.nm.join(' -> ') + '.' : '';
    var bestPickText = '';
    if (f.bd && f.bd.length) {
      var topPicks = f.bd.slice(0, 3);
      var pickList = topPicks.map(function (p) {
        return p.pl + ' (' + p.y + ', round ' + p.rd + ', ' + p.pts.toFixed(1) + ' pts, ' + p.ppg.toFixed(1) + ' ppg)';
      });
      bestPickText = ' Draft track record - real individual draft-pick seasons on record for this franchise, best to worst: ' + pickList.join('; ') + '.';
    }
    return '- ' + f.fr + ': career record ' + record + '. ' + scoring + '. ' + titleText + '.' + lineage + bestPickText;
  });
  return 'Real league history for franchises/owners mentioned in this tip - ' +
    'this is the FULL and ONLY factual record for them, do not assume or ' +
    'invent any additional accomplishments, records, or stats beyond what is listed here:\n' +
    lines.join('\n');
}

function normalizePlayerName_(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/[.']/g, '')
    .replace(/\s+(jr|sr|ii|iii|iv)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Scans tip text for mentions of rostered players. Matches on whole-word,
 * normalized names (case/punctuation/suffix-insensitive), so a tip
 * mentioning "marvin harrison" still matches a roster entry of "Marvin
 * Harrison Jr." Returns an array of { name, pos, team, round, manager }
 * for every rostered player mentioned, deduped by normalized name.
 */
function findRosteredPlayers_(text, roster) {
  if (!roster || !text) return [];
  var normalizedText = ' ' + String(text).toLowerCase().replace(/[.']/g, '') + ' ';
  var seen = {};
  var matches = [];
  Object.keys(roster).forEach(function (team) {
    var teamData = roster[team];
    (teamData.rounds || []).forEach(function (r) {
      (r.players || []).forEach(function (p) {
        var norm = normalizePlayerName_(p.name);
        if (!norm || seen[norm]) return;
        var pattern = new RegExp('\\b' + norm.replace(/\s+/g, '\\s+') + '\\b');
        if (pattern.test(normalizedText)) {
          seen[norm] = true;
          matches.push({
            name: p.name,
            pos: p.pos,
            team: team,
            round: r.round,
            manager: teamData.manager
          });
        }
      });
    });
  });
  return matches;
}

function buildRosterContext_(matches) {
  if (!matches || !matches.length) return '';
  var lines = matches.map(function (m) {
    var who = m.manager ? (m.team + ', managed by ' + m.manager) : m.team;
    return '- ' + m.name + ' (' + m.pos + '): rostered by ' + who + ', round ' + m.round + ' keeper.';
  });
  return 'Real roster context for players mentioned in this tip (use only ' +
    'if directly relevant - do not force it in, and do not invent any ' +
    'roster facts beyond what is listed here):\n' + lines.join('\n');
}

/**
 * Looks up real-world NFL facts (current team, position, roster status)
 * for rostered players mentioned in a tip, via TheSportsDB's free API
 * (https://www.thesportsdb.com - shared free key '123', 30 req/min).
 * This grounds Gelly's take in verified real-NFL facts, separate from
 * the league's own fantasy-roster context above. TheSportsDB is a
 * community-maintained bio/roster database, not a stats provider - it
 * does not reliably carry live injury reports or box-score stats, and
 * team assignments can lag after a trade/free agency move, so this is
 * treated as best-effort context, not gospel. Never blocks the Gelly
 * rewrite: any failure (network, not found, rate limit, non-NFL match)
 * just means that player's line is silently skipped. Capped at 3
 * lookups per tip to keep calls and latency low.
 */
function lookupSportsDbFacts_(matches) {
  if (!matches || !matches.length) return '';
  var lines = [];
  matches.slice(0, 3).forEach(function (m) {
    try {
      var q = encodeURIComponent(String(m.name).replace(/\s+/g, '_'));
      var url = 'https://www.thesportsdb.com/api/v1/json/' + SPORTSDB_API_KEY +
        '/searchplayers.php?p=' + q;
      var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
      if (resp.getResponseCode() !== 200) return;
      var data = JSON.parse(resp.getContentText());
      var p = data && data.player && data.player[0];
      if (!p || p.strSport !== 'American Football') return;
      var bits = [];
      if (p.strTeam) bits.push(p.strTeam);
      if (p.strPosition) bits.push(p.strPosition);
      if (p.strStatus) bits.push(p.strStatus);
      if (!bits.length) return;
      lines.push('- ' + m.name + ': ' + bits.join(', ') + '.');
    } catch (err) {
      console.error('lookupSportsDbFacts_ failed for ' + m.name + ': ' + err);
    }
  });
  if (!lines.length) return '';
  return 'Verified real-world NFL facts (via TheSportsDB - separate from ' +
    'the league fantasy-roster context above; use only if directly ' +
    'relevant, never invent beyond this):\n' + lines.join('\n');
}

function getLeagueRules_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty('LEAGUE_RULES_JSON');
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (err) {
    console.error('getLeagueRules_ failed: ' + err);
    return null;
  }
}

var LEAGUE_RULES_KEYWORDS_ = {
  article_I: ['constitution', 'formation of', 'duration of'],
  article_II: ['buy-in', 'inactive manager', 'definition of terms', 'opening day'],
  article_III: ['commissioner', 'veto', 'suspend', 'suspension', 'ruling', 'appeal', 'reconsideration', 'overturn', 'penalty'],
  article_IV: ['withdraw', 'quit the league', 'new owner', 'expansion team'],
  article_V: ['scoring format', 'roster spot', 'starting lineup', 'ppr', 'points allowed', 'league settings', 'flex spot', 'bench spot'],
  article_VI: ['snake draft', 'draft date', 'draft rules', 'draft order'],
  article_VII: ['waiver wire', 'free agent', 'injured reserve', ' ir ', 'inactive'],
  article_VIII: ['trade veto', 'trade deadline', 'trade review', 'forbidden trade', 'trade rejected', 'veto', 'reject the trade', 'nullify'],
  article_IX: ['playoff', 'playoffs', 'seeding', 'bye week', 'championship game', 'tiebreaker', 'payout', '3rd place', 'third place'],
  article_X: ['offence', 'offense', 'bribery', 'collusion', 'harassment', 'trash talk', 'disrespect', 'gaap', 'non-competitive'],
  appendix_A: ['buy-in amount', 'payout schedule', 'financial matters', 'league dues'],
  appendix_B: ['amendment', 'bylaw change', 'rule change', 'vote history', 'constitutional history'],
  keeper_rules: ['keeper', 'franchise tag', 'round value', 'draft pick value', 'keeper rule', 'keeper eligib']
};

/** LEAGUE_RULES_JSON fields have drifted shape before (object vs array vs string).
 *  Coerce anything into an array so one bad property can never throw and take
 *  every Gelly AI post down with it. */
function asArray_(v) {
  if (v == null) return [];
  if (Array.isArray(v)) return v;
  if (typeof v === "object") return Object.keys(v).map(function (k) { return v[k]; });
  return [v];
}

function buildRulesContext_(rawText) {
  var rules = getLeagueRules_();
  if (!rules) return '';
  var lower = (rawText || '').toLowerCase();
  var matchedKeys = [];
  Object.keys(LEAGUE_RULES_KEYWORDS_).forEach(function (key) {
    if (key === 'appendix_B') return;
    var kws = LEAGUE_RULES_KEYWORDS_[key];
    for (var i = 0; i < kws.length; i++) {
      if (lower.indexOf(kws[i]) !== -1) { matchedKeys.push(key); break; }
    }
  });
  if (!matchedKeys.length) return '';
  matchedKeys = matchedKeys.slice(0, 2);
  var parts = [];
  matchedKeys.forEach(function (key) {
    var label = '';
    var text = '';
    if (key === 'keeper_rules' && rules.keeperRules) {
      label = 'Keeper League Rules';
      // LEAGUE_RULES_JSON nests the rules one level deeper than this line originally
      // assumed: keeperRules is { title: '...', rules: [{n, text}] }, not the array itself.
      // asArray_ converted that wrapper just as happily as the real thing, so what Gelly
      // actually received as the league rules was the literal string
      // "undefined. undefined undefined. undefined" - from 2026-07-29 until 2026-08-04.
      // Accept either shape, and complain in the log rather than degrade silently.
      var kr = rules.keeperRules;
      var krList = asArray_((kr && !Array.isArray(kr) && kr.rules) ? kr.rules : kr)
        .filter(function (r) { return r && r.text; });
      if (!krList.length) {
        console.error('buildRulesContext_: keeperRules matched no {n,text} entries - check the LEAGUE_RULES_JSON shape in Script Properties');
      }
      text = krList.map(function (r) { return (r.n ? r.n + '. ' : '') + r.text; }).join(' ');
    } else if (key.indexOf('article_') === 0 && rules.constitution && rules.constitution.articles) {
      var id = key.replace('article_', '');
      var art = rules.constitution.articles.filter(function (a) { return a.id === id; })[0];
      if (art) { label = 'Article ' + id + ' (' + art.title + ')'; text = art.text; }
    }
    if (text) {
      if (text.length > 1200) text = text.slice(0, 1200) + '...';
      parts.push(label + ': ' + text);
    }
  });
  if (!parts.length) return '';
  // Always bundle the Constitution's amendment/vote history alongside any specific rule
  // citation, so Gelly can reference how/when the league has changed things over time.
  var voteHistoryText = '';
  if (rules.constitution && rules.constitution.appendices) {
    var appB = rules.constitution.appendices.filter(function (a) { return a.id === 'B'; })[0];
    if (appB && appB.votes && appB.votes.length) {
      voteHistoryText = ' Constitution amendment/vote history on record: ' + appB.votes.map(function (v) {
        return 'Amendment ' + v.amendment + (v.date ? ' (' + v.date + ')' : '') + ': ' + v.description;
      }).join('; ') + '.';
    }
  }
  return 'LEAGUE RULES CONTEXT - real excerpts from the official WPIAL All-Stars Constitution/Keeper Rules. ' +
    'When you cite a rule, state it accurately - get it right, this is real and citable - but deliver it in your ' +
    'usual voice: authoritative, not a dry legal brief, but not pure joke either. If a rule you are citing has been ' +
    'formally amended, it is fair game to reference that vote history for color (e.g. that the Constitution has been ' +
    'amended before). Cite only the article/appendix number, rule number, or amendment shown here - never invent a ' +
    'rule, article number, or vote outcome that is not below: ' + parts.join(' | ') + voteHistoryText;
}

function listRules_(e) {
  var rules = getLeagueRules_();
  if (!rules) return jsonOut_({ ok: false, error: 'Rules data not available' });
  return jsonOut_({ ok: true, rules: rules });
}


/**
 * Extracts the publishable answer text from a Gemini generateContent response.
 * Returns '' when the response is unusable, so every caller can fail closed.
 *
 * Two things disqualify a response:
 *
 *   1. finishReason other than STOP. gemini-flash-latest is a THINKING model,
 *      thinking cannot be disabled on it (thinkingBudget:0 returns HTTP 400),
 *      and thinking tokens count against maxOutputTokens. A long prompt can
 *      therefore burn the whole budget reasoning and get cut off mid-thought.
 *      When that happens the trailing partial part comes back WITHOUT
 *      thought:true, so the p.thought filter below does NOT catch it and the
 *      reasoning gets published as the post. That is the 2026-08-04 bug: two
 *      of the three posts on the feed were the model's own scratchpad.
 *
 *   2. a thought part. Filtered explicitly. This half already worked.
 *
 * Every Gemini call site in this project routes through here. Before this,
 * generateGellyPost_ and generateOffseasonReportPost_ each had their own copy
 * of the parsing (which drifted), and generateGellyPicksPost_ took
 * parts[0].text unconditionally - i.e. the reasoning part whenever the model
 * thought first.
 */
function gellyText_(data) {
  var c = data && data.candidates && data.candidates[0];
  if (!c) return '';
  if (c.finishReason && c.finishReason !== 'STOP') {
    console.error('gellyText_: rejecting response, finishReason=' + c.finishReason);
    return '';
  }
  var parts = (c.content && c.content.parts) || [];
  var text = parts.filter(function (p) { return p && p.text && !p.thought; })
                  .map(function (p) { return p.text; }).join(' ');
  return String(text || '').replace(/^\s+|\s+$/g, '');
}

/**
 * Last line of defence before any Gelly text reaches a member. Every pattern
 * here is a shape observed in a leaked reasoning trace or a raw prompt, and
 * none of them can occur in a real post.
 *
 * This is the tmDegraded_ equivalent for every path. tmDegraded_ only ever
 * guarded the trade machine, which is why the feed had no protection at all.
 */
var GELLY_REJECT_ = [
  /URL\s*#\s*\d/i,               // prompt enumeration
  /\(\s*\d{2,4}\s*chars?\s*\)/i,  // the model counting characters out loud
  /Headlines?\s+used\s*:/i,       // self-verification checklist
  /No fabricated/i,
  /Under\s+\d+\s+characters/i,   // the model reciting its own constraints
  /news\.google\.com\/rss/i,     // a source URL is never the post itself
  /^[\s,.;:)\-]/,                 // starts mid-sentence -> truncated tail
  /[A-Za-z0-9_-]{40,}/            // long opaque token / base64 run
];
function gellySane_(t) {
  if (!t || t.length < 20) return false;
  for (var i = 0; i < GELLY_REJECT_.length; i++) {
    if (GELLY_REJECT_[i].test(t)) {
      console.error('gellySane_: rejecting text on rule ' + i + ': ' + String(t).slice(0, 120));
      return false;
    }
  }
  return true;
}

function generateGellyPost_(rawText) {
  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) return TIP_PREFIX + rawText;

    var systemPrompt = 'You are Gelly, the self-appointed insider and gossip ' +
      'columnist for a fantasy football league called WPIAL All Stars. He\'s ' +
      'a guy (he/him). Voice: professional enough to run the desk, but ' +
      'underneath it a dumb sports jock - dramatic, self-important, ' +
      'confident to the point of arrogant. Dumb hot takes are the brand: ' +
      'confident, half-baked opinions about players and moves, picked ' +
      'specifically to needle league members, are encouraged - that IS the ' +
      'voice, not a mistake to correct. Signature catchphrase is "I\'ve ' +
      'done the research." You can sign off big posts with "HERE WE GO ' +
      '🖤💛" but do not force it into every post. ' +
      'Don\'t just rewrite the tip in your own voice - interpret it. Read between ' +
      'the lines and finish the thought the way Gelly would: what does this ' +
      'actually mean for the league, who does it favor or expose, what\'s the ' +
      'verdict. Land a take, a prediction, or a jab - not just a paraphrase. ' +
      'You can speculate and editorialize freely; you just cannot invent new ' +
      'concrete facts (names, numbers, events) that were not in the tip itself. ' +
      'Every post you are given started as an anonymous tip from a league member - ' +
      'NEVER name or guess who sent it, attribute it to "sources," "hearing," or ' +
      'similar instead. Keep it tweet-length, under 300 characters. Do not invent ' +
      'facts, stats, or details beyond what is given, but you can add reaction, ' +
      'spin, or flavor. No hashtags, no surrounding quotation marks, no markdown. ' +
      'If the tip includes a URL (starts with http:// or https://), keep that ' +
      'exact URL character-for-character somewhere in your rewrite - never drop ' +
      'it, shorten it, or alter it, and never invent a URL that was not given.\n\n' +
      'League history accuracy: never state or imply that an owner or ' +
      'franchise has won a championship, set a record, or achieved any ' +
      'specific accolade unless it is explicitly confirmed in the league ' +
      'history context provided below - if a tip implies or asserts a ' +
      'title, record, or accomplishment for someone and no history ' +
      'context confirms it, do not repeat or agree with that claim as ' +
      'fact (you can mock or dismiss it as a lie, but never state it as ' +
      'true). Trash talk, mockery, and speculation about who deserves ' +
      'credit or should win are fine; crediting someone with a real ' +
      'title, record, or win they do not actually have is not.\n\n' +
      'Conduct policy: this is a private fantasy league group having fun ' +
      'together - trash talk, roasting, dumb hot takes, dumb arguments ' +
      'about players, and needling opinions designed to get under a league ' +
      'member\'s skin are all fair game and encouraged, not something to ' +
      'soften - that is the whole voice. But this is still a shared ' +
      'public-facing page, so hold two hard lines: no racism (slurs, ' +
      'stereotypes, or hate speech targeting race, ethnicity, religion, or ' +
      'similar), and nothing else overly offensive - meaning no sexual ' +
      'content about real people, no threats or incitement of violence, no ' +
      'harassment that crosses from ribbing into targeted cruelty, and no ' +
      'sharing anyone\'s private contact info. If the tip itself brushes ' +
      'against those lines, keep the joke but drop or generalize the ' +
      'specific harmful detail rather than refusing outright - push the ' +
      'trash talk as far as it can go short of those two lines.\n\n' +
      'Output ONLY the finished post text - no preamble, no explanation, no labels.';

    var rosterMatches = findRosteredPlayers_(rawText, getRosterSnapshot_());
    var rosterContext = buildRosterContext_(rosterMatches);
    var sportsDbContext = lookupSportsDbFacts_(rosterMatches);
    var historyMatches = findMentionedFranchises_(rawText, getLeagueHistory_());
    var historyContext = buildHistoryContext_(historyMatches);
    var rulesContext = buildRulesContext_(rawText);
    var userMessage = (rosterContext ? rosterContext + '\n\n' : '') +
      (sportsDbContext ? sportsDbContext + '\n\n' : '') +
      (historyContext ? historyContext + '\n\n' : '') +
      (rulesContext ? rulesContext + '\n\n' : '') +
      'Rewrite this approved league tip as a single Gelly post:\n\n' + rawText;

    var payload = {
      contents: [{ role: 'user', parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: systemPrompt }] },
      generationConfig: { temperature: 1.0, maxOutputTokens: 2500, topP: 0.95 }
    };

    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
      ':generateContent?key=' + apiKey;
    var resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    console.log('Gemini response [' + resp.getResponseCode() + ']: ' + resp.getContentText());

    if (resp.getResponseCode() !== 200) {
      console.error('Gemini API error ' + resp.getResponseCode() + ': ' + resp.getContentText());
      return TIP_PREFIX + rawText;
    }

    var data = JSON.parse(resp.getContentText());
    var text = gellyText_(data);

    // Anything that fails the gate degrades to the existing behaviour: the tip's
    // own text behind TIP_PREFIX. tmDegraded_() already recognises that shape, so
    // the trade machine keeps falling back to tmFallback_ exactly as before.
    if (!gellySane_(text)) return TIP_PREFIX + rawText;

    return text;
  } catch (err) {
    console.error('generateGellyPost_ failed: ' + err);
    return TIP_PREFIX + rawText;
  }
}

function feedHeaders_(feedSheet) {
  return feedSheet.getRange(1, 1, 1, feedSheet.getLastColumn()).getValues()[0]
    .map(function (h) { return String(h).trim().toLowerCase(); });
}

function incrementFeedStat_(feedSheet, rowNum, colName) {
  var lock = LockService.getScriptLock();
  lock.waitLock(5000);
  try {
    var headers = feedHeaders_(feedSheet);
    var col = headers.indexOf(colName);
    if (col === -1) return null;
    var cell = feedSheet.getRange(rowNum, col + 1);
    var next = (Number(cell.getValue()) || 0) + 1;
    cell.setValue(next);
    return next;
  } finally {
    lock.releaseLock();
  }
}


function appendFeedPost_(feedSheet, text, sourceText) {
  var headers = feedHeaders_(feedSheet);
  var newRow = headers.map(function (h) {
    if (h === 'timestamp') return new Date();
    if (h === 'author') return 'Gelly';
    if (h === 'text') return text;
    if (h === 'source_text') return sourceText || '';
    if (h === 'comments' || h === 'retweets' || h === 'likes' || h === 'views') return 0;
    return '';
  });
  feedSheet.appendRow(newRow);
  return feedSheet.getLastRow();
}

function updateFeedPost_(feedSheet, rowNum, text, sourceText) {
  var headers = feedHeaders_(feedSheet);
  var textCol = headers.indexOf('text');
  if (textCol === -1) return;
  feedSheet.getRange(rowNum, textCol + 1).setValue(text);
  if (sourceText !== undefined) {
    var sourceCol = headers.indexOf('source_text');
    if (sourceCol !== -1) feedSheet.getRange(rowNum, sourceCol + 1).setValue(sourceText || '');
  }
}

function removeFeedPost_(feedSheet, rowNum) {
  // Blanks the row rather than deleting it, so no other Tips row's stored
  // feed_row (an absolute row number) gets invalidated by a shift. doGet()
  // already skips fully-blank rows when building the public feed.
  if (rowNum >= 1 && rowNum <= feedSheet.getLastRow()) {
    feedSheet.getRange(rowNum, 1, 1, feedSheet.getLastColumn()).clearContent();
  }
}

/**
 * Pulls recent real NFL headlines from Google News RSS, filtered to
 * offseason-drama topics (contract disputes, injuries, suspensions,
 * holdouts, locker-room friction) - the real-world material the
 * off-season report riffs on. Chosen over Gemini's native Google
 * Search grounding tool because that tool returns 429
 * RESOURCE_EXHAUSTED on this API key even though plain generateContent
 * calls succeed (confirmed by direct A/B test - not a general quota
 * issue, the grounding tool specifically is not entitled on this key).
 * Returns [] (never throws) if the fetch or parse fails, which the
 * caller treats as "no real news available - do not post."
 */
function fetchOffseasonHeadlines_() {
  try {
    var query = encodeURIComponent(
      'NFL (injury OR injured OR holdout OR "contract dispute" OR ' +
      'suspended OR suspension OR arrested OR fight OR fined OR ' +
      'grievance OR "trade request" OR "wants out") when:4d'
    );
    var url = 'https://news.google.com/rss/search?q=' + query + '&hl=en-US&gl=US&ceid=US:en';
    var resp = UrlFetchApp.fetch(url, { muteHttpExceptions: true });
    if (resp.getResponseCode() !== 200) return [];

    var doc = XmlService.parse(resp.getContentText());
    var items = doc.getRootElement().getChild('channel').getChildren('item');
    var out = [];
    for (var i = 0; i < items.length && out.length < 8; i++) {
      var it = items[i];
      var title = (it.getChildText('title') || '').trim();
      var link = (it.getChildText('link') || '').trim();
      if (!title || !link) continue;
      out.push({ title: title, link: link });
    }
    return out;
  } catch (err) {
    console.error('fetchOffseasonHeadlines_ failed: ' + err);
    return [];
  }
}

/**
 * Builds the twice-weekly "Off-Season Report" - a Gelly post grounded
 * in real, current NFL headlines, angled to make keeper-league owners
 * second-guess players they're rostering. Fails closed: if no real
 * headlines can be fetched, or no API key is configured, or Gemini
 * returns nothing usable, this posts NOTHING rather than let Gemini
 * invent offseason news about real players. Returns true if a post was
 * published, false otherwise.
 */
function generateOffseasonReportPost_() {
  var headlines = fetchOffseasonHeadlines_();
  if (!headlines.length) {
    console.error('generateOffseasonReportPost_: no real headlines available, skipping post.');
    return false;
  }

  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) {
    console.error('generateOffseasonReportPost_: no GEMINI_API_KEY configured, skipping post.');
    return false;
  }

  // Titles only. The links stay server-side and are appended by this function
  // after the model has answered - see the SOURCE marker below.
  var headlineBlock = headlines.map(function (h, i) {
    return (i + 1) + '. ' + h.title;
  }).join('\n');

  var systemPrompt = GELLY_PERSONA_ + '\n\n' +
    'You are writing a recurring "Off-Season Report" post - not a tip ' +
    'rewrite. Below is a numbered list of real, current NFL headlines. ' +
    'Pick 2-4 of the most keeper-league-relevant ones (contract ' +
    'disputes, injuries, suspensions, holdouts, locker-room or coaching ' +
    'friction, trade rumblings) and write one Gelly-voiced post that ' +
    'connects them to WPIAL All Stars keeper decisions. The editorial ' +
    'angle is to sow doubt: make owners who are keeping the players ' +
    'involved second-guess themselves. You can speculate, editorialize, ' +
    'and needle - that is the voice - but every real-world claim ' +
    '(injury, dispute, suspension, etc.) must come from the headlines ' +
    'given. Do not invent facts, stats, or events beyond what the ' +
    'headlines say. Do not invent player names beyond who is named in ' +
    'the headlines. Keep it under 500 characters. Do NOT include any ' +
    'URLs - the link is added for you. End with a final line of exactly ' +
    '"SOURCE: N", where N is the number of the headline you leaned on ' +
    'most, and write nothing after it. No hashtags, no ' +
    'surrounding quotation marks, no markdown.\n\n' +
    GELLY_CONDUCT_POLICY_ + '\n\n' +
    'Output ONLY the finished post text - no preamble, no explanation, no labels.';

  var payload = {
    contents: [{ parts: [{ text: 'Real current NFL headlines:\n\n' + headlineBlock }] }],
    systemInstruction: { parts: [{ text: systemPrompt }] },
    generationConfig: { temperature: 0.9, maxOutputTokens: 3000 }
  };

  var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
    ':generateContent?key=' + apiKey;
  var resp;
  try {
    resp = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
  } catch (err) {
    console.error('generateOffseasonReportPost_ fetch failed: ' + err);
    return false;
  }

  console.log('Offseason report Gemini response [' + resp.getResponseCode() + ']: ' + resp.getContentText());

  if (resp.getResponseCode() !== 200) {
    console.error('generateOffseasonReportPost_: Gemini API error ' + resp.getResponseCode() + ': ' + resp.getContentText());
    return false;
  }

  var data = JSON.parse(resp.getContentText());
  var text = gellyText_(data);

  // The model names its lead headline as a trailing "SOURCE: N" line. Strip the
  // marker, gate the prose, then append the real link from the server-side list.
  var pick = -1;
  var mark = text.match(/\s*SOURCE:\s*(\d{1,2})\s*$/i);
  if (mark) {
    pick = parseInt(mark[1], 10) - 1;
    text = text.slice(0, mark.index).replace(/^\s+|\s+$/g, '');
  }

  // Fails closed, exactly as this function's contract already promised: posting
  // nothing is always better than posting the model's scratchpad.
  if (!gellySane_(text)) {
    console.error('generateOffseasonReportPost_: unusable Gemini response, skipping post.');
    return false;
  }

  if (pick >= 0 && pick < headlines.length) text += '\n\n' + headlines[pick].link;

  var feedSheet = getTab_(FEED_SHEET);
  appendFeedPost_(feedSheet, text);
  console.log('Offseason report published: ' + text);
  return true;
}

/**
 * Time-driven trigger handler - installed twice a week (see
 * installOffseasonReportTriggers_). Kept as a thin wrapper with a
 * plain (non-underscore) name so it is a valid trigger target.
 */
function runOffseasonReport() {
  generateOffseasonReportPost_();
}

/**
 * Installs the twice-weekly off-season report trigger: Tuesday and
 * Friday mornings at 9am, project timezone (America/Denver). Deletes
 * any pre-existing triggers for runOffseasonReport first, so re-running
 * this is idempotent and never stacks duplicate triggers.
 */
function installOffseasonReportTriggers_() {
  var triggers = ScriptApp.getProjectTriggers();
  for (var i = 0; i < triggers.length; i++) {
    if (triggers[i].getHandlerFunction() === 'runOffseasonReport') {
      ScriptApp.deleteTrigger(triggers[i]);
    }
  }
  ScriptApp.newTrigger('runOffseasonReport').timeBased().onWeekDay(ScriptApp.WeekDay.TUESDAY).atHour(9).create();
  ScriptApp.newTrigger('runOffseasonReport').timeBased().onWeekDay(ScriptApp.WeekDay.FRIDAY).atHour(9).create();
  console.log('Installed Tue/Fri 9am off-season report triggers.');
}

// ============================================================
// INSIDER REPORT (Wednesday/Sunday official wire)
// Writes require the INSIDER_SECRET Script Property; reads are
// public like the feed. Only touches the "InsiderReports" tab.
// ============================================================

var INSIDER_SHEET = 'InsiderReports';

function insiderSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(INSIDER_SHEET);
  if (!sh) {
    sh = ss.insertSheet(INSIDER_SHEET);
    sh.appendRow(['posted_at', 'report_date', 'edition', 'title', 'body_md']);
  }
  return sh;
}

function insiderJson_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}

function handleInsiderPost_(e) {
  var p = e.parameter;
  var secret = PropertiesService.getScriptProperties().getProperty('INSIDER_SECRET');
  if (!secret || p.secret !== secret) return insiderJson_({ ok: false, error: 'unauthorized' });
  if (!p.report_date || !p.body_md) return insiderJson_({ ok: false, error: 'missing report_date or body_md' });
  insiderSheet_().appendRow([
    new Date().toISOString(),
    String(p.report_date),
    String(p.edition || ''),
    String(p.title || ''),
    String(p.body_md)
  ]);
  return insiderJson_({ ok: true });
}

function listInsiderReports_(e) {
  var rows = insiderSheet_().getDataRange().getValues();
  var reports = [];
  for (var i = 1; i < rows.length; i++) {
    reports.push({
      posted_at: rows[i][0],
      report_date: rows[i][1],
      edition: rows[i][2],
      title: rows[i][3],
      body_md: rows[i][4]
    });
  }
  reports.reverse();
  var limit = Number((e && e.parameter && e.parameter.limit) || 0);
  if (limit > 0) reports = reports.slice(0, limit);
  return insiderJson_({ ok: true, reports: reports });
}

// setInsiderSecret was removed 2026-08-16. It hardcoded the INSIDER_SECRET value, and this file is committed to a PUBLIC repo, so that secret was readable on the internet from 2026-08-04 until today. The value has been rotated and the property is now set by hand in Project Settings > Script properties. Never put a secret in this file.

// ============================================================
// PLAYER INTEREST (anonymous "signal interest" clicks from the
// Rosters tab). No identity is collected - just team + player.
// Only touches the "Interest" tab.
// ============================================================

var INTEREST_SHEET = 'Interest';

function interestSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(INTEREST_SHEET);
  if (!sh) {
    sh = ss.insertSheet(INTEREST_SHEET);
    sh.appendRow(['timestamp', 'team', 'player']);
  }
  return sh;
}

function handleInterest_(e) {
  var p = e.parameter;
  if (!p.team || !p.player) return insiderJson_({ ok: false, error: 'missing team or player' });
  interestSheet_().appendRow([
    new Date().toISOString(),
    String(p.team).slice(0, 60),
    String(p.player).slice(0, 60)
  ]);
  return insiderJson_({ ok: true });
}

function listInterestCounts_(e) {
  var rows = interestSheet_().getDataRange().getValues();
  var now = Date.now();
  var week = 7 * 86400000;
  var map = {};
  for (var i = 1; i < rows.length; i++) {
    var key = rows[i][1] + '|' + rows[i][2];
    if (!map[key]) map[key] = { team: rows[i][1], player: rows[i][2], total: 0, last7days: 0 };
    map[key].total++;
    var t = new Date(rows[i][0]).getTime();
    if (t && (now - t) < week) map[key].last7days++;
  }
  var out = Object.keys(map).map(function (k) { return map[k]; });
  out.sort(function (a, b) { return b.last7days - a.last7days || b.total - a.total; });
  return insiderJson_({ ok: true, interest: out });
}


// ============================================================
// DECLARED KEEPERS ("Keepers" tab: team | player). Public read
// for the site's gold-star badges; writes require the same
// secret as insider reports (commissioner only). The tab can
// also be edited directly in the Sheet at any time.
// ============================================================

var KEEPERS_SHEET = 'Keepers';

function keepersSheet_() {
  var ss = SpreadsheetApp.openById(SHEET_ID);
  var sh = ss.getSheetByName(KEEPERS_SHEET);
  if (!sh) {
    sh = ss.insertSheet(KEEPERS_SHEET);
    sh.appendRow(['team', 'player']);
  }
  return sh;
}

function handleKeeperAdd_(e) {
  var p = e.parameter;
  var secret = PropertiesService.getScriptProperties().getProperty('INSIDER_SECRET');
  if (!secret || p.secret !== secret) return insiderJson_({ ok: false, error: 'unauthorized' });
  if (!p.team || !p.player) return insiderJson_({ ok: false, error: 'missing team or player' });
  keepersSheet_().appendRow([String(p.team).slice(0, 60), String(p.player).slice(0, 60)]);
  return insiderJson_({ ok: true });
}

function listKeepers_(e) {
  var rows = keepersSheet_().getDataRange().getValues();
  var out = [];
  for (var i = 1; i < rows.length; i++) {
    if (rows[i][0] && rows[i][1]) out.push({ team: rows[i][0], player: rows[i][1] });
  }
  return insiderJson_({ ok: true, keepers: out });
}


// ============================================================
// ESPN SCHEDULE / SCOREBOARD PROXY (read-only). Fetches the
// league schedule + scores from ESPN's fantasy API server-side
// and caches for 2 minutes. If the league requires auth, set
// Script Properties ESPN_S2 and ESPN_SWID (cookie values from
// an owner's espn.com session). Never exposes those values.
// ============================================================

var ESPN_LEAGUE_ID = '11564022';
var ESPN_SEASON = '2026';

function espnFetch_(view) {
  var url = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + ESPN_SEASON + '/segments/0/leagues/' + ESPN_LEAGUE_ID + '?view=' + view;
  var props = PropertiesService.getScriptProperties();
  var s2 = props.getProperty('ESPN_S2');
  var swid = props.getProperty('ESPN_SWID');
  var options = { muteHttpExceptions: true, headers: {} };
  if (s2 && swid) options.headers.Cookie = 'espn_s2=' + s2 + '; SWID=' + swid;
  var resp = UrlFetchApp.fetch(url, options);
  if (resp.getResponseCode() !== 200) return null;
  try { return JSON.parse(resp.getContentText()); } catch (err) { return null; }
}

function listEspnSchedule_(e) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('espn_schedule_v1');
  if (cached) return insiderJson_(JSON.parse(cached));
  var teamsData = espnFetch_('mTeam');
  var schedData = espnFetch_('mMatchupScore');
  if (!teamsData || !schedData || !schedData.schedule) {
    return insiderJson_({ ok: false, error: 'espn fetch failed - if the league is private, set ESPN_S2 and ESPN_SWID script properties' });
  }
  var names = {};
  (teamsData.teams || []).forEach(function (t) { names[t.id] = t.name; });
  var weeks = {};
  schedData.schedule.forEach(function (mu) {
    var w = mu.matchupPeriodId;
    if (!weeks[w]) weeks[w] = [];
    weeks[w].push({
      away: names[(mu.away || {}).teamId] || 'TBD',
      home: names[(mu.home || {}).teamId] || 'TBD',
      awayScore: (mu.away || {}).totalPoints || 0,
      homeScore: (mu.home || {}).totalPoints || 0,
      winner: mu.winner || 'UNDECIDED',
      awayTopScorer: topScorerFieldFor_(w, (mu.away||{}).totalPoints||0, (mu.home||{}).totalPoints||0, (mu.away||{}).teamId),
      homeTopScorer: topScorerFieldFor_(w, (mu.away||{}).totalPoints||0, (mu.home||{}).totalPoints||0, (mu.home||{}).teamId)
    });
  });
  var out = {
    ok: true,
    updated: new Date().toISOString(),
    currentWeek: (schedData.status || {}).currentMatchupPeriod || 1,
    weeks: weeks
  };
  cache.put('espn_schedule_v1', JSON.stringify(out), 120);
  return insiderJson_(out);
}


/**
 * GELLY'S WEEK PICKS
 * ------------------
 * Current-week-only Corso-style picker. For every matchup in the live
 * ESPN schedule's current week, computes a real power score per
 * franchise (career wins + championships*5 + runnerUps*2 + thirds*1,
 * all pulled from the same league-history data that powers the
 * Career wins by franchise card - never invented), picks the
 * favorite, and derives a spread from the real gap between the two
 * scores. Gelly then writes the pick blurbs in his voice, but the
 * winner + spread numbers are computed here, not by the model, so
 * the picks stay grounded in real data ('on the better line').
 * Caches per week for 6 hours. Falls back to the computed picks with
 * plain blurbs if Gemini or the API key is unavailable - this
 * feature can never break the schedule page.
 */
function getEspnScheduleRaw_() {
  var cache = CacheService.getScriptCache();
  var cached = cache.get('espn_schedule_v1');
  if (cached) return JSON.parse(cached);
  var teamsData = espnFetch_('mTeam');
  var schedData = espnFetch_('mMatchupScore');
  if (!teamsData || !schedData || !schedData.schedule) return null;
  var names = {};
  teamsData.teams.forEach(function (t) { names[t.id] = t.name; });
  var weeks = {};
  schedData.schedule.forEach(function (mu) {
    var w = mu.matchupPeriodId;
    if (!weeks[w]) weeks[w] = [];
    weeks[w].push({
      away: (names[mu.away.teamId] || 'TBD'),
      home: (names[mu.home.teamId] || 'TBD'),
      awayScore: mu.away.totalPoints || 0,
      homeScore: mu.home.totalPoints || 0,
      winner: mu.winner || 'UNDECIDED'
    });
  });
  var out = {
    ok: true,
    updated: new Date().toISOString(),
    currentWeek: (schedData.status && schedData.status.currentMatchupPeriod) || 1,
    weeks: weeks
  };
  cache.put('espn_schedule_v1', JSON.stringify(out), 120);
  return out;
}

function computeFranchisePowerScores_() {
  // Real numbers pulled live from LEAGUE_HISTORY_JSON (career record, PPG,
  // win%, total points, championships) - replaces the old hardcoded STATS
  // snapshot. Update LEAGUE_HISTORY_JSON (via the history rebuild script)
  // after a season finishes; this function picks the new numbers up
  // automatically.
  var history = getLeagueHistory_();
  var scores = {};
  if (!history) return scores;
  Object.keys(history).forEach(function (guid) {
    var f = history[guid];
    var seasons = f.ps || [];
    var numSeasons = seasons.length || 1;
    var avgWins = f.w / numSeasons;
    var finishes = seasons.map(function (s) { return s[6]; }).filter(function (x) { return typeof x === 'number'; });
    var avgFinish = finishes.length ? (finishes.reduce(function (a, b) { return a + b; }, 0) / finishes.length) : 5;
    var power = (f.wp * 100) + (f.ppg * 0.5) + (f.ch * 10);
    scores[normalizeTeamName_(f.fr)] = {
      name: f.fr,
      power: power,
      wins: f.w,
      championships: f.ch,
      avgWins: avgWins,
      avgFinish: avgFinish,
      winPct: f.wp,
      ppg: f.ppg,
      pointsFor: f.pf,
      guid: guid
    };
  });
  return scores;
}

function buildWeekPickPlan_(matchups, powerScores) {
  var plan = matchups.map(function (mu) {
    var a = powerScores[normalizeTeamName_(mu.away)];
    var h = powerScores[normalizeTeamName_(mu.home)];
    var aPower = a ? a.power : 0;
    var hPower = h ? h.power : 0;
    var gap = Math.abs(aPower - hPower);
    var favorite = aPower === hPower ? mu.away : (aPower > hPower ? mu.away : mu.home);
    var spread = Math.max(0.5, Math.min(14, Math.round((gap / 4) * 2) / 2));
    return {
      away: mu.away, home: mu.home,
      awayPower: aPower, homePower: hPower,
      awayRecord: a ? (a.wins + ' career wins, ' + a.championships + ' titles') : 'no history on file',
      homeRecord: h ? (h.wins + ' career wins, ' + h.championships + ' titles') : 'no history on file',
      pick: favorite,
      spread: spread,
      gap: gap
    };
  });
  var motw = plan.slice().sort(function (x, y) { return x.gap - y.gap; })[0];
  return { plan: plan, matchupOfWeek: motw };
}

var GELLY_SWAMI_PERSONA_ =
  'For weekly picks specifically, Gelly channels \'The Swami\' - a turban-and-crystal-ball ' +
  'fortune-teller bit layered on top of his usual voice. Same ego, same guy, but leaning ' +
  'hard into mystic-prophet showmanship: frame picks as visions from the crystal ball, ham ' +
  'up the fortune-teller routine, stay boastfully confident on every call. Still exactly ' +
  'one punchy sentence per pick as instructed - the bit does not break format.';

function gellyGatePassed_() {
  var override = PropertiesService.getScriptProperties().getProperty('GAMBLER_UNLOCK');
  if (override === 'true') return true;
  var draftTime = new Date('2026-08-30T17:30:00-06:00');
  return new Date() >= draftTime;
}

function generateGellyPicksPost_() {
  if (!gellyGatePassed_()) {
    return { ok: false, gated: true, unlockAt: '2026-08-30T17:30:00-06:00', message: "The Gelly Line is locked until the 2026 draft (Aug 30, 5:30 PM MT) sets real rosters. The Swami's crystal ball needs an actual roster to work with — check back after the draft." };
  }

  var sched = getEspnScheduleRaw_();
  if (!sched) return { ok: false, error: 'ESPN schedule unavailable' };
  var week = sched.currentWeek;
  var matchups = sched.weeks[week] || [];
  if (!matchups.length) return { ok: false, error: 'No matchups found for week ' + week };

  var cache = CacheService.getScriptCache();
  var cacheKey = 'gelly_picks_week_' + week;
  var cached = cache.get(cacheKey);
  if (cached) { var cr = JSON.parse(cached); cr.seasonRecord = computeGellySeasonRecord_(); return cr; }

  var power = computeFranchisePowerScores_();
  var built = buildWeekPickPlan_(matchups, power);
  var plan = built.plan;
  var motw = built.matchupOfWeek;

  var result = {
    ok: true,
    week: week,
    matchupOfWeek: { away: motw.away, home: motw.home },
    intro: '',
    picks: plan.map(function (p) {
      return { away: p.away, home: p.home, pick: p.pick, spread: p.spread, blurb: p.pick + ' by ' + p.spread };
    })
  };

  try {
    var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
    if (!apiKey) { recordGellyPicksIfNeeded_(week, result.picks); cache.put(cacheKey, JSON.stringify(result), 21600); result.seasonRecord = computeGellySeasonRecord_(); return result; }

    var lines = plan.map(function (p) {
      return '- ' + p.away + ' (' + p.awayRecord + ') at ' + p.home + ' (' + p.homeRecord + '). Real computed line: ' +
        p.pick + ' favored by ' + p.spread + ' (based on career wins + titles, not made up).';
    });
    var userMessage = 'Week ' + week + ' matchups, with the REAL computed favorite and spread already given for ' +
      'each game (do not change these numbers or picks, just write them up in your voice):\n' + lines.join('\n') +
      '\n\nThe closest game, and this week\'s Matchup of the Week, is ' + motw.away + ' vs ' + motw.home + '.\n\n' +
      'Write JSON only, no markdown fences, matching exactly this shape: {"intro": "one hype sentence naming the ' +
      'Matchup of the Week", "picks": [{"away": "...", "home": "...", "blurb": "one punchy sentence with your pick ' +
      'and the given spread, in your voice"}]} - one picks entry per matchup listed above, same order, same team names.';

    var payload = {
      contents: [{ parts: [{ text: userMessage }] }],
      systemInstruction: { parts: [{ text: GELLY_PERSONA_ + ' ' + GELLY_SWAMI_PERSONA_ + ' ' + GELLY_CONDUCT_POLICY_ }] },
      generationConfig: { temperature: 1.0, maxOutputTokens: 2500, topP: 0.95 }
    };
    var url = 'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL + ':generateContent?key=' + apiKey;
    var resp = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json', payload: JSON.stringify(payload), muteHttpExceptions: true
    });
    if (resp.getResponseCode() === 200) {
      var data = JSON.parse(resp.getContentText());
      var t = gellyText_(data);
      if (t) {
        t = t.trim().replace(/^```json/i, '').replace(/^```/, '').replace(/```$/, '').trim();
        var parsed = JSON.parse(t);
        if (parsed && parsed.picks && parsed.picks.length === plan.length) {
          result.intro = parsed.intro || '';
          result.picks = plan.map(function (p, idx) {
            var b = parsed.picks[idx] && parsed.picks[idx].blurb;
            return { away: p.away, home: p.home, pick: p.pick, spread: p.spread, blurb: b || (p.pick + ' by ' + p.spread) };
          });
        }
      }
    } else {
      console.error('Gelly picks Gemini error ' + resp.getResponseCode() + ': ' + resp.getContentText());
    }
  } catch (err) {
    console.error('generateGellyPicksPost_ Gemini step failed: ' + err);
  }

  recordGellyPicksIfNeeded_(week, result.picks);
  cache.put(cacheKey, JSON.stringify(result), 21600);
  result.seasonRecord = computeGellySeasonRecord_();
  return result;
}

function listGellyPicks_(e) {
  return insiderJson_(generateGellyPicksPost_());
}





function getWeekTopScorers_(week) {
  var cache = CacheService.getScriptCache();
  var cacheKey = 'espn_topscorers_wk' + week;
  var cached = cache.get(cacheKey);
  if (cached) return JSON.parse(cached);
  var url = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + ESPN_SEASON + '/segments/0/leagues/' + ESPN_LEAGUE_ID + '?view=mBoxscore&view=mMatchupScore&scoringPeriodId=' + week;
  var props = PropertiesService.getScriptProperties();
  var s2 = props.getProperty('ESPN_S2');
  var swid = props.getProperty('ESPN_SWID');
  var options = { muteHttpExceptions: true, headers: {} };
  if (s2 && swid) options.headers.Cookie = 'espn_s2=' + s2 + '; SWID=' + swid;
  var resp = UrlFetchApp.fetch(url, options);
  if (resp.getResponseCode() !== 200) return null;
  var data;
  try { data = JSON.parse(resp.getContentText()); } catch (err) { return null; }
  var out = {};
  (data.schedule || []).forEach(function (mu) {
    if (mu.matchupPeriodId !== Number(week)) return;
    ['home', 'away'].forEach(function (side) {
      var team = mu[side];
      if (!team || !team.rosterForCurrentScoringPeriod) return;
      var entries = team.rosterForCurrentScoringPeriod.entries || [];
      var best = null;
      entries.forEach(function (en) {
        if (en.lineupSlotId === 20 || en.lineupSlotId === 21) return;
        var pe = en.playerPoolEntry || {};
        var pts = pe.appliedStatTotal || 0;
        var nm = (pe.player && pe.player.fullName) || 'Unknown';
        if (!best || pts > best.points) best = { name: nm, points: Math.round(pts * 10) / 10 };
      });
      if (best) out[team.teamId] = best;
    });
  });
  cache.put(cacheKey, JSON.stringify(out), 1800);
  return out;
}

var _topScorerMemo_ = {};
function topScorerFieldFor_(week, awayScore, homeScore, teamId) {
  if (!(awayScore > 0 || homeScore > 0)) return null;
  if (!(week in _topScorerMemo_)) {
    try { _topScorerMemo_[week] = getWeekTopScorers_(week); } catch (err) { _topScorerMemo_[week] = null; }
  }
  var ts = _topScorerMemo_[week];
  if (!ts) return null;
  return ts[teamId] || null;
}

function recordGellyPicksIfNeeded_(week, picks) {
  var props = PropertiesService.getScriptProperties();
  var key = 'gelly_locked_picks_wk' + week;
  if (props.getProperty(key)) return;
  var slim = picks.map(function (p) { return { away: p.away, home: p.home, pick: p.pick }; });
  props.setProperty(key, JSON.stringify(slim));
}

function computeGellySeasonRecord_() {
  var props = PropertiesService.getScriptProperties();
  var sched = getEspnScheduleRaw_();
  var wins = 0, losses = 0, pending = 0;
  for (var w = 1; w <= 17; w++) {
    var raw = props.getProperty('gelly_locked_picks_wk' + w);
    if (!raw) continue;
    var picks;
    try { picks = JSON.parse(raw); } catch (e) { continue; }
    var weekMatchups = (sched && sched.weeks) ? (sched.weeks[w] || []) : [];
    picks.forEach(function (p) {
      var match = null;
      for (var i = 0; i < weekMatchups.length; i++) {
        if (weekMatchups[i].away === p.away && weekMatchups[i].home === p.home) { match = weekMatchups[i]; break; }
      }
      if (!match || !match.winner || match.winner === 'UNDECIDED') { pending++; return; }
      var actualWinner = match.winner === 'HOME' ? match.home : (match.winner === 'AWAY' ? match.away : null);
      if (!actualWinner) { pending++; return; }
      if (actualWinner === p.pick) wins++; else losses++;
    });
  }
  return { wins: wins, losses: losses, pending: pending };
}

function __debugClearGellyCache__() {
  var cache = CacheService.getScriptCache();
  for (var w = 1; w <= 17; w++) cache.remove('gelly_picks_week_' + w);
  return 'cleared';
}
