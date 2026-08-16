/* ============================================================================
 * transactions.gs — the waiver ledger, for The Transaction Wire.
 *
 * WHY IT EXISTS
 * The League Gazette gives the Wire a permanent column. Until now nothing in this
 * backend could fill it: every ESPN call in the repo uses mTeam, mMatchupScore or
 * mBoxscore, none of which carry a transaction. This is the missing read.
 *
 * NO MONEY. This league does not use FAAB and does not use budgets, so this file
 * deliberately does NOT emit `bidAmount`, and never will. ESPN sends it; we drop it
 * on the floor in waTxRow_(). If a future column wants to show a bid, that is a
 * product decision to be argued first, not a field to quietly start passing through.
 *
 * WHY IT IS A SEPARATE FILE
 * Same reason bench.gs is (bench.gs:9-15): its own fetch, its own cache, one new
 * read-only action, and it touches nothing the live scoreboard depends on.
 *
 * Wiring: ONE line in doGet (Code.gs), guarded form —
 *   if (e && e.parameter && e.parameter.action === 'transactions') return waJson_(waTransactions_(e));
 *
 * TWO FETCHES, NOT ONE. mTransactions2 returns playerIds and nothing else — no name,
 * no position, no pro team. Resolving them needs a second call against the player
 * index, filtered to exactly the ids this ledger mentions. That call is the reason
 * for the 900s cache: it is the expensive half.
 *
 * Team identity is reported as the ESPN teamId, never the name — the standing
 * contract in matchup.gs:17-28 and bench.gs:23-25. The client canons it through
 * WPIAL_FX.resolve().
 * ==========================================================================*/

var WA_TX_CACHE_KEY = 'wa_transactions_v1';
var WA_TX_TTL = 900;              // 15 min — the wire is not a live ticker
var WA_TX_MAX_BYTES = 90000;      // CacheService throws over ~100KB (matchup.gs:40)
var WA_TX_DEFAULT_LIMIT = 40;
var WA_TX_HARD_LIMIT = 200;

/* Only the two things this league actually does. TRADE lives in TradeMachine.gs and
   has its own surface; ROSTER (a lineup change) is not news. */
var WA_TX_TYPES = { WAIVER: 'WAIVER', FREEAGENT: 'FREEAGENT' };

/* Reused rather than re-declared — same tables as matchup.gs:52-59 / espn-rankings.gs:12-13.
   Declared here only as a fallback so this file still answers if loaded alone. */
var WA_TX_POS = { 1: 'QB', 2: 'RB', 3: 'WR', 4: 'TE', 5: 'K', 16: 'D/ST' };
var WA_TX_PRO = { 0:'FA',1:'ATL',2:'BUF',3:'CHI',4:'CIN',5:'CLE',6:'DAL',7:'DEN',8:'DET',9:'GB',10:'TEN',11:'IND',12:'KC',13:'LV',14:'LAR',15:'MIA',16:'MIN',17:'NE',18:'NO',19:'NYG',20:'NYJ',21:'PHI',22:'ARI',23:'PIT',24:'LAC',25:'SF',26:'SEA',27:'TB',28:'WSH',29:'CAR',30:'JAX',33:'BAL',34:'HOU' };

function waTxCreds_() {
  var props = PropertiesService.getScriptProperties();
  var league = props.getProperty('ESPN_LEAGUE_ID') ||
               (typeof ESPN_LEAGUE_ID !== 'undefined' ? ESPN_LEAGUE_ID : '11564022');
  var season = props.getProperty('ESPN_SEASON') ||
               (typeof ESPN_SEASON !== 'undefined' ? ESPN_SEASON : 2026);
  return {
    s2: props.getProperty('ESPN_S2'),
    swid: props.getProperty('ESPN_SWID'),
    league: String(league),
    season: String(season)
  };
}

function waTxHeaders_(c, filter) {
  var h = { 'Accept': 'application/json' };
  if (c.s2 && c.swid) h['Cookie'] = 'espn_s2=' + c.s2 + '; SWID=' + c.swid;
  if (filter) h['X-Fantasy-Filter'] = JSON.stringify(filter);
  return h;
}

/**
 * The ledger itself. Returns the raw ESPN transactions array, or null.
 *
 * espnFetch_ (Code.gs:1266) cannot be used here: it builds headers with only a Cookie
 * and has no way to send X-Fantasy-Filter, which is what makes ESPN return the list
 * rather than an empty array. Modelled on waMuFetch_ (matchup.gs:79-104) instead.
 */
function waTxLedger_(c) {
  var filter = { transactions: { filterType: { value: ['WAIVER', 'FREEAGENT'] } } };
  var url = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + c.season +
            '/segments/0/leagues/' + c.league + '?view=mTransactions2';
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: waTxHeaders_(c, filter)
    });
    if (res.getResponseCode() !== 200) return null;
    var data = JSON.parse(res.getContentText());
    /* ESPN has shipped this under two shapes over the years. Accept both rather than
       discover the other one on a Sunday. */
    var list = (data && data.transactions) || (data && data.settings && data.settings.transactions) || null;
    return Array.isArray(list) ? list : [];
  } catch (err) {
    return null;
  }
}

/**
 * playerId -> { name, pos, nfl } for exactly the ids this ledger mentions.
 * Chunked, because X-Fantasy-Filter is a header and headers have a length ceiling.
 * A failure here is not fatal: the wire still prints, with ids resolved to ''.
 */
function waTxPlayers_(c, ids) {
  var out = {};
  if (!ids.length) return out;
  var CHUNK = 60;
  for (var i = 0; i < ids.length; i += CHUNK) {
    var slice = ids.slice(i, i + CHUNK);
    var filter = { players: { filterIds: { value: slice.map(Number) }, limit: CHUNK } };
    var url = 'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + c.season +
              '/segments/0/leagues/' + c.league + '?view=kona_player_info';
    try {
      var res = UrlFetchApp.fetch(url, {
        muteHttpExceptions: true,
        followRedirects: true,
        headers: waTxHeaders_(c, filter)
      });
      if (res.getResponseCode() !== 200) continue;
      var data = JSON.parse(res.getContentText());
      var rows = (data && data.players) || [];
      for (var r = 0; r < rows.length; r++) {
        var pl = rows[r].player || rows[r];
        if (!pl || pl.id === undefined) continue;
        out[String(pl.id)] = {
          name: pl.fullName || '',
          pos: WA_TX_POS[pl.defaultPositionId] || '',
          nfl: WA_TX_PRO[pl.proTeamId] || ''
        };
      }
    } catch (err) { /* one bad chunk must not lose the other chunks */ }
  }
  return out;
}

/**
 * One ESPN transaction -> one wire row, or null if there is nothing to print.
 *
 * ESPN models an add-and-drop as ONE transaction with TWO items. A newspaper prints
 * that as one line ("ADD x · DROP y"), so the pairing happens here rather than being
 * left for the client to guess at.
 */
function waTxRow_(tx, names) {
  if (!tx) return null;
  var type = WA_TX_TYPES[String(tx.type || '')];
  if (!type) return null;
  /* PENDING waiver claims are not news — half of them lose. */
  if (tx.status && String(tx.status).toUpperCase() !== 'EXECUTED') return null;

  var items = tx.items || [];
  var add = null, drop = null, teamId = tx.teamId;

  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var kind = String(it.type || '').toUpperCase();
    var pid = String(it.playerId);
    var who = names[pid] || { name: '', pos: '', nfl: '' };
    var row = { id: pid, name: who.name, pos: who.pos, nfl: who.nfl };
    if (kind === 'ADD') { add = row; if (it.toTeamId) teamId = it.toTeamId; }
    else if (kind === 'DROP') { drop = row; if (!add && it.fromTeamId) teamId = it.fromTeamId; }
  }
  if (!add && !drop) return null;

  /* NOTE: tx.bidAmount is deliberately not read. See the file header. */
  return {
    id: String(tx.id || ''),
    date: tx.proposedDate ? new Date(tx.proposedDate).toISOString() : null,
    week: tx.scoringPeriodId || null,
    teamId: teamId === undefined || teamId === null ? null : Number(teamId),
    type: type,
    add: add,
    drop: drop
  };
}

/** Build the whole payload. Never throws. */
function waTxBuild_(limit) {
  var c = waTxCreds_();
  if (!c.s2 || !c.swid) {
    return { ok: false, dark: true, reason: 'no-espn-credentials',
             error: 'ESPN_S2 / ESPN_SWID script properties are not set', transactions: [] };
  }

  var ledger = waTxLedger_(c);
  if (ledger === null) {
    return { ok: false, dark: true, reason: 'espn-unavailable',
             error: 'espn transaction fetch failed', transactions: [] };
  }

  /* Newest first, then trim BEFORE resolving names — no point paying for a player
     lookup on a row that will not be printed. */
  ledger.sort(function (a, b) { return (b.proposedDate || 0) - (a.proposedDate || 0); });
  var slice = ledger.slice(0, Math.min(limit * 2, WA_TX_HARD_LIMIT * 2));

  var idSet = {};
  slice.forEach(function (tx) {
    (tx.items || []).forEach(function (it) {
      if (it && it.playerId !== undefined) idSet[String(it.playerId)] = true;
    });
  });
  var names = waTxPlayers_(c, Object.keys(idSet));

  var rows = [];
  for (var i = 0; i < slice.length && rows.length < limit; i++) {
    var row = waTxRow_(slice[i], names);
    if (row) rows.push(row);
  }

  return {
    ok: true,
    dark: rows.length === 0,
    season: Number(c.season),
    updated: new Date().toISOString(),
    named: Object.keys(names).length > 0,
    transactions: rows
  };
}

/** GET action=transactions[&limit=N][&refresh=1] — public, read-only, like the rest. */
function waTransactions_(e) {
  var p = (e && e.parameter) || {};
  var limit = Math.max(1, Math.min(WA_TX_HARD_LIMIT, Number(p.limit) || WA_TX_DEFAULT_LIMIT));
  var force = String(p.refresh || '') === '1';
  var cache = CacheService.getScriptCache();
  var ckey = WA_TX_CACHE_KEY + '_' + limit;

  if (!force) {
    var hit = cache.get(ckey);
    if (hit) { try { return JSON.parse(hit); } catch (err) {} }
  }

  var out = waTxBuild_(limit);
  var body = JSON.stringify(out);
  /* Serve it either way; only skip the cache write. Same guard as matchup.gs:249. */
  if (body.length < WA_TX_MAX_BYTES) { try { cache.put(ckey, body, WA_TX_TTL); } catch (err) {} }
  return out;
}

/* ---------------------------------------------------------------- ops */

/** Run from the editor. Prints the wire as it would print on the page. */
function previewTransactions() {
  var r = waTxBuild_(WA_TX_DEFAULT_LIMIT);
  if (!r.ok) { Logger.log('DARK (' + r.reason + '): ' + r.error); return; }
  if (!r.transactions.length) { Logger.log('ok, but the wire is empty — no waiver activity yet this season.'); return; }
  var lines = [r.transactions.length + ' rows, names resolved: ' + r.named];
  r.transactions.forEach(function (t) {
    lines.push('  wk' + (t.week || '-') + '  team ' + t.teamId + '  ' + t.type +
               '   ADD ' + (t.add ? t.add.name + ' (' + t.add.pos + ')' : '—') +
               '  ·  DROP ' + (t.drop ? t.drop.name + ' (' + t.drop.pos + ')' : '—'));
  });
  Logger.log(lines.join('\n'));
}
