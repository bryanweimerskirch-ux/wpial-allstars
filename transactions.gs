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
 * 2026-09-03 — THE NAME LOOKUP MOVED. It used to ask the league-scoped
 * ?view=kona_player_info and it was resolving NOTHING: every row on the front page
 * printed "ADD unnamed". The public season player index answers the same ids, with no
 * cookies at all and with D/ST included, so it is now the primary and the league view
 * is only a fallback for an id the public index has never heard of. See waTxPlayers_.
 * A resolver that fails silently is worse than one that fails loudly, so the payload
 * now carries `resolved`/`requested` and, on any miss, a `diag` of what each call did.
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

/** One ESPN player object -> our shape. Tolerates a missing fullName. */
function waTxPlayerRow_(pl) {
  if (!pl || pl.id === undefined || pl.id === null) return null;
  var nm = pl.fullName || ((pl.firstName || '') + ' ' + (pl.lastName || '')).trim();
  return {
    id: String(pl.id),
    name: nm,
    pos: WA_TX_POS[pl.defaultPositionId] || '',
    nfl: WA_TX_PRO[pl.proTeamId] || ''
  };
}

/**
 * Read players out of EITHER response shape into `out`, and return how many landed.
 * The season index returns a BARE ARRAY; the league view returns
 * { players: [ { player: {...} } ] }. Accepting both is what lets the two sources be
 * swapped without the caller caring — and is the same "accept both shapes" discipline
 * waTxLedger_ already applies to the ledger itself.
 */
function waTxHarvest_(data, out) {
  var rows = Array.isArray(data) ? data : ((data && data.players) || []);
  var n = 0;
  for (var i = 0; i < rows.length; i++) {
    var raw = rows[i] && rows[i].player ? rows[i].player : rows[i];
    var r = waTxPlayerRow_(raw);
    if (!r) continue;
    out[r.id] = { name: r.name, pos: r.pos, nfl: r.nfl };
    n++;
  }
  return n;
}

/** One JSON GET. Returns the code alongside the body so a caller can say WHY it failed. */
function waTxFetchJson_(url, headers) {
  try {
    var res = UrlFetchApp.fetch(url, {
      muteHttpExceptions: true,
      followRedirects: true,
      headers: headers
    });
    var code = res.getResponseCode();
    if (code !== 200) return { code: code, data: null };
    return { code: 200, data: JSON.parse(res.getContentText()) };
  } catch (err) {
    return { code: 0, data: null };
  }
}

/**
 * playerId -> { name, pos, nfl } for exactly the ids this ledger mentions.
 *
 * PRIMARY IS THE PUBLIC SEASON PLAYER INDEX. Verified against the live ledger on
 * 2026-09-03: all 14 ids it mentions resolve there, D/ST included (the negative ids —
 * -16008 is "Lions D/ST"), over an unauthenticated request. The league-scoped
 * kona_player_info view it used to call was returning an empty map for every id, which
 * is what printed "ADD unnamed" across the whole column.
 *
 * Dropping the cookie requirement is the real win: ESPN_S2 / ESPN_SWID going stale now
 * takes out the ledger only, not the ledger AND the names.
 *
 * The league view survives as a fallback, because a player can sit in a league's own
 * universe without being in the public index. It costs a call only on an actual miss.
 *
 * Never fatal, and never silent: unresolved ids keep name '' so the wire prints what it
 * has, and `diag` records what every call did so the next "unnamed" is one log away.
 */
function waTxPlayers_(c, ids, diag) {
  var out = {};
  if (!diag) diag = {};
  diag.requested = ids.length;
  diag.sources = [];
  if (!ids.length) { diag.resolved = 0; return out; }

  /* Header-length ceiling, so the id list is chunked even though this league will
     never come close. 50 ids is ~400 characters of filter. */
  var CHUNK = 50;
  var i, slice, r, got;

  for (i = 0; i < ids.length; i += CHUNK) {
    slice = ids.slice(i, i + CHUNK).map(Number);
    r = waTxFetchJson_(
      'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + c.season +
        '/players?view=players_wl',
      { 'Accept': 'application/json',
        'X-Fantasy-Filter': JSON.stringify({ filterIds: { value: slice } }) }
    );
    got = r.data ? waTxHarvest_(r.data, out) : 0;
    diag.sources.push('season(' + slice.length + '): http ' + r.code + ' +' + got);
  }

  var missing = [];
  for (i = 0; i < ids.length; i++) if (!out[String(ids[i])]) missing.push(ids[i]);

  for (i = 0; i < missing.length; i += CHUNK) {
    slice = missing.slice(i, i + CHUNK).map(Number);
    r = waTxFetchJson_(
      'https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/' + c.season +
        '/segments/0/leagues/' + c.league + '?view=kona_player_info',
      waTxHeaders_(c, { players: { filterIds: { value: slice }, limit: CHUNK } })
    );
    got = r.data ? waTxHarvest_(r.data, out) : 0;
    diag.sources.push('league(' + slice.length + '): http ' + r.code + ' +' + got);
  }

  diag.resolved = Object.keys(out).length;
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
  var diag = {};
  var names = waTxPlayers_(c, Object.keys(idSet), diag);

  var rows = [];
  for (var i = 0; i < slice.length && rows.length < limit; i++) {
    var row = waTxRow_(slice[i], names);
    if (row) rows.push(row);
  }

  var out = {
    ok: true,
    dark: rows.length === 0,
    season: Number(c.season),
    updated: new Date().toISOString(),
    named: Object.keys(names).length > 0,
    resolved: diag.resolved || 0,
    requested: diag.requested || 0,
    transactions: rows
  };
  /* Only when something actually went unresolved, so the happy path stays small. This
     is the field that would have turned "why does it say unnamed" into a five-second
     answer instead of a bug report. */
  if ((diag.resolved || 0) < (diag.requested || 0)) out.diag = diag.sources || [];
  return out;
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
  var lines = [r.transactions.length + ' rows, names resolved: ' +
               r.resolved + '/' + r.requested +
               (r.diag ? '   MISSES — ' + r.diag.join(' ; ') : '')];
  r.transactions.forEach(function (t) {
    lines.push('  wk' + (t.week || '-') + '  team ' + t.teamId + '  ' + t.type +
               '   ADD ' + (t.add ? t.add.name + ' (' + t.add.pos + ')' : '—') +
               '  ·  DROP ' + (t.drop ? t.drop.name + ' (' + t.drop.pos + ')' : '—'));
  });
  Logger.log(lines.join('\n'));
}
