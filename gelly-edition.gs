/* ============================================================================
 * gelly-edition.gs — Gelly files the paper, Sunday and Wednesday.
 *
 * WHAT THIS REPLACES
 * `runOffseasonReport` (Tue/Fri 9am) wrote a <=500-character post to the FEED.
 * It never touched InsiderReports, which is the tab the newspaper reads — so
 * every edition of the paper has been hand-filed with INSIDER_SECRET. This job
 * writes the paper itself. installGellyEditionTriggers() removes the Tue/Fri
 * triggers as part of installing the new ones; the old function is left in the
 * file, untriggered, because deleting a working generator to change a schedule is
 * how you lose a working generator.
 *
 * TWO PIECES PER EDITION
 * The paper runs a front-page lead and a separate bylined column on page 4. One
 * row per run meant page 4 reprinted the PREVIOUS edition's lead. Each run now
 * writes two rows and marks the column one, so an edition is self-contained.
 *
 * The mark rides in `edition`, which is documented-unvalidated free text
 * (Code.gs:1131) and already overrides the derived Sunday/Midweek chip. That is a
 * real use of an existing field, not a hack around a missing one — but it is a
 * CONTRACT: press.js reads `edition === 'Column'` and nothing else may write that
 * string into an InsiderReports row.
 *
 * GROUNDING
 * In-season the edition is written from the league's own numbers — scores,
 * standings, top scorers, bench points, waiver moves — all of which this backend
 * already has. Off-season there are no games, so it falls back to the NFL
 * headlines the old job used. Gelly speculates and needles; he does not invent
 * scores.
 *
 * FAILING CLOSED
 * No API key, no grounding, a non-STOP finishReason, unparseable JSON, or prose
 * that trips gellySane_ all publish NOTHING. This is the contract
 * generateOffseasonReportPost_ already promised and it is inherited here on
 * purpose: an empty front page is recoverable, a front page carrying the model's
 * scratchpad is what claude/gelly-thought-leak-bug.md is about.
 *
 * REUSE, NOT A FOURTH COPY
 * gellyText_ (finishReason + thought-part filter) and gellySane_ (the pattern
 * gate) are the whole reason that incident cannot recur. Three call sites had
 * drifted apart and a fourth had never been fixed at all. This is a fifth caller
 * of the shared pair, not a fifth parser.
 * ==========================================================================*/

var GE_COLUMN_SLOT = 'Column';        // the contract press.js reads. Do not reuse.
var GE_MAX_TOKENS = 8192;             // thinking tokens count against this. A paper is not a tweet.
var GE_LEAD_WORDS = '320 to 450';
var GE_COL_WORDS = '200 to 320';
var GE_PROMO_PREFIX = '📰 New edition of the Dispatch is up — ';

/* ------------------------------------------------------------------ state */

/** The schedule object, through the production code path and its cache. */
function geSchedule_() {
  try {
    var out = listEspnSchedule_({ parameter: {} });
    return JSON.parse(out.getContent());
  } catch (err) {
    console.error('geSchedule_ failed: ' + err);
    return { ok: false };
  }
}

/**
 * Compact standings from the schedule.
 *
 * THIS IS THE THIRD COPY of this arithmetic — index.html:2374-2446 computes it
 * inline for the site and press.js restates it for the paper. There is still no
 * standings action. index.html REMAINS THE SOURCE OF TRUTH: if any two of the
 * three disagree, that one is right. Extracting it is a real backlog item; doing
 * it inside a Gemini job would be the wrong place to start.
 */
function geStandings_(sched) {
  if (!sched || !sched.ok || !sched.weeks) return { rows: [], week: 0 };
  var rec = {}, played = 0;
  function bump(n) { if (!rec[n]) rec[n] = { w: 0, l: 0, t: 0, pf: 0, pa: 0, last: '' }; return rec[n]; }

  Object.keys(sched.weeks).sort(function (a, b) { return a - b; }).forEach(function (wk) {
    (sched.weeks[wk] || []).forEach(function (mu) {
      if (mu.away === 'TBD' || mu.home === 'TBD') return;
      var a = bump(mu.away), h = bump(mu.home);
      var as = Number(mu.awayScore) || 0, hs = Number(mu.homeScore) || 0;
      if (!(as > 0 || hs > 0 || mu.winner !== 'UNDECIDED')) return;
      played = Math.max(played, Number(wk) || 0);
      a.pf += as; a.pa += hs; h.pf += hs; h.pa += as;
      if (mu.winner === 'AWAY') { a.w++; h.l++; a.last = 'W'; h.last = 'L'; }
      else if (mu.winner === 'HOME') { h.w++; a.l++; h.last = 'W'; a.last = 'L'; }
      else { a.t++; h.t++; a.last = 'T'; h.last = 'T'; }
    });
  });

  var rows = Object.keys(rec).map(function (n) {
    var r = rec[n], g = r.w + r.l + r.t;
    return { team: n, w: r.w, l: r.l, t: r.t,
             pf: Math.round(r.pf * 10) / 10, pa: Math.round(r.pa * 10) / 10,
             pct: g ? (r.w + 0.5 * r.t) / g : 0, last: r.last };
  }).sort(function (a, b) { return (b.pct - a.pct) || (b.pf - a.pf); });

  return { rows: rows, week: played };
}

/** Everything the writer is allowed to know. Never throws. */
function geLeagueState_() {
  var sched = geSchedule_();
  var st = geStandings_(sched);
  var state = {
    phase: st.week ? 'inseason' : 'offseason',
    week: st.week,
    standings: st.rows,
    games: [],
    bench: null,
    wire: []
  };
  if (!st.week) return state;

  state.games = (sched.weeks[String(st.week)] || []).map(function (g) {
    var awayWon = g.winner === 'AWAY';
    return {
      winner: awayWon ? g.away : g.home,
      loser: awayWon ? g.home : g.away,
      winScore: Math.round((awayWon ? g.awayScore : g.homeScore) * 10) / 10,
      loseScore: Math.round((awayWon ? g.homeScore : g.awayScore) * 10) / 10,
      winTop: awayWon ? g.awayTopScorer : g.homeTopScorer,
      loseTop: awayWon ? g.homeTopScorer : g.awayTopScorer
    };
  });

  try {
    var b = waBenchSeason_(false);
    if (b && b.ok && b.weeks_counted) state.bench = b.teams;
  } catch (err) { console.error('geLeagueState_ bench: ' + err); }

  try {
    if (typeof waTxBuild_ === 'function') {
      var tx = waTxBuild_(12);
      if (tx && tx.ok) state.wire = tx.transactions || [];
    }
  } catch (err) { console.error('geLeagueState_ wire: ' + err); }

  return state;
}

/* ------------------------------------------------------------------ brief */

/** The grounding block. Plain text, real numbers, no URLs, no opaque strings. */
/**
 * Keeper declarations, through the production handler so there is one reader.
 * Never throws — the brief degrades, it does not fail the edition.
 */
function geKeepers_() {
  try {
    return JSON.parse(waKeepersV2_().getContent());
  } catch (err) {
    console.error('geKeepers_ failed: ' + err);
    return null;
  }
}

/**
 * OWNER FIRST NAMES, so the paper can call a manager by name.
 *
 * Bryan, 2026-08-16: "when I say Nick has yet to select his keepers, Gelly should call him
 * out on that." The brief only ever carried franchise names, so a tip phrased in first
 * names — which is how the league actually talks — had nothing to bind to.
 *
 * Reads ONLY first_name and team_name out of Profiles. `email` sits between them in
 * WA_PROFILE_HEADERS and is deliberately not read: geKeeperCards_ exists precisely so no
 * address reaches a prompt, and that promise is not being weakened to add a nickname. A
 * first name is already public — it is printed on the owner's own profile card.
 */
function geOwnerNames_() {
  var out = {};
  try {
    var sh = waProfSS_().getSheetByName(WA_PROFILE_TAB);
    if (!sh) return out;
    var last = sh.getLastRow();
    if (last < 2) return out;
    var idx = {};
    WA_PROFILE_HEADERS.forEach(function (h, i) { idx[h] = i; });
    sh.getRange(2, 1, last - 1, WA_PROFILE_HEADERS.length).getValues().forEach(function (v) {
      var team = String(v[idx.team_name] || '').replace(/^\s+|\s+$/g, '');
      var first = String(v[idx.first_name] || '').replace(/^\s+|\s+$/g, '');
      if (team && first) out[team] = first;
    });
  } catch (err) {
    console.error('geOwnerNames_ failed: ' + err);
  }
  return out;
}

/**
 * LAST SEASON'S FINAL STANDINGS, rebuilt from the meeting log.
 *
 * Playoff games are excluded: the worm is a regular-season punishment, and a club can
 * lose in the bracket without finishing last. Same arithmetic press.js runs for Worm
 * Watch — and the same reason it had to be written at all, which is that before Week 1
 * the CURRENT table is ten clubs at 0-0 and sorting it names whoever sorts last.
 */
function geLastSeason_() {
  var log;
  try { log = JSON.parse(waH2hLog_({ parameter: {} }).getContent()); }
  catch (err) { console.error('geLastSeason_ failed: ' + err); return null; }
  if (!log || !log.ok || !log.pairs || !log.pairs.length) return null;

  var season = 0;
  log.pairs.forEach(function (p) {
    (p.meetings || []).forEach(function (m) { if (m && m.season > season) season = m.season; });
  });
  if (!season) return null;

  var rec = {};
  function bump(n) { if (!rec[n]) rec[n] = { team: n, w: 0, l: 0 }; return rec[n]; }
  log.pairs.forEach(function (p) {
    (p.meetings || []).forEach(function (m) {
      if (!m || m.season !== season || m.playoff) return;
      var win = m.winner === 'A' ? p.teamA : p.teamB;
      var lose = m.winner === 'A' ? p.teamB : p.teamA;
      if (!win || !lose) return;
      bump(win).w++; bump(lose).l++;
    });
  });
  var rows = Object.keys(rec).map(function (k) { return rec[k]; });
  if (rows.length < 2) return null;
  rows.sort(function (a, b) { return (b.w - a.w) || (a.l - b.l); });
  return { season: season, rows: rows };
}

/**
 * KEEPER CARDS, WITH PROVENANCE.
 *
 * waKeepersV2_ deliberately does not carry this: that feed is public and the only
 * columns that answer "who filed this" are email addresses. This reads the tab
 * server-side and emits a BOOLEAN, so no address ever reaches a prompt.
 *
 * It matters because five of the nine cards on file were entered by the commissioner
 * rather than by the owner. Without the distinction, "nine clubs have declared" reads
 * as owner engagement when it is partly Bryan's data entry, and a club with no card
 * gets called lazy for work nobody has done for them.
 */
function geKeeperCards_() {
  try {
    var ownerOf = {}, teams = [];
    var osh = waOwnersTab_(), olast = osh.getLastRow();
    if (olast >= 2) {
      osh.getRange(2, 1, olast - 1, WA_OWNER_HEADERS.length).getValues().forEach(function (v) {
        var team = String(v[2] || '').trim();
        if (!team) return;
        ownerOf[team] = waNormEmail_(v[0]);
        if (teams.indexOf(team) === -1) teams.push(team);
      });
    }

    var cards = [];
    var psh = waPicksTab_(), plast = psh.getLastRow();
    if (plast >= 2) {
      psh.getRange(2, 1, plast - 1, WA_PICK_HEADERS.length).getValues().forEach(function (v) {
        var team = String(v[0] || '').trim();
        if (!team) return;
        var players = [];
        try { players = JSON.parse(v[2]) || []; } catch (err) { players = []; }
        var by = waNormEmail_(v[5] || '');
        cards.push({
          team: team,
          players: players,
          count: players.length,
          /* When the card was last written. waWritePicks_ OVERWRITES the row, so the
             previous selection is gone the moment it is saved — this timestamp is the
             only trace that a card changed at all, which is why the paper can say
             "re-cut today" but cannot say what came off it. */
          updated: v[4] || null,
          byOwner: !!(by && ownerOf[team] && by === ownerOf[team])
        });
      });
    }
    return { cards: cards, teams: teams };
  } catch (err) {
    console.error('geKeeperCards_ failed: ' + err);
    return null;
  }
}

function geBrief_(state) {
  var L = [];
  L.push('LEAGUE: WPIAL All Stars, 10 teams, keeper league, established 2019.');

  if (state.phase === 'offseason') {
    /* THE OFF-SEASON BRIEF USED TO BE TWO LINES — the league name and "no games have
       been played." That is not enough to write a column from, and on 2026-08-07 the
       dry run proved it: told to pick one owner and go after one decision, and handed
       no facts about any owner, Gelly took a quarterback out of the NFL headlines and
       invented a keeper tag for Drake that did not exist. The prompt forbids inventing
       a transaction; the brief left no grounded move available. Facts are the fix.

       Everything below is real and already in this backend. Keeper declarations are
       the whole story in August, including the clubs that have declared NOTHING —
       which is a decision, and a different one from not having declared yet. */
    L.push('PHASE: off-season, pre-draft. No games have been played yet this season.');

    var last = geLastSeason_();
    if (last) {
      L.push('');
      L.push('LAST SEASON (' + last.season + ') FINAL REGULAR-SEASON STANDINGS:');
      last.rows.forEach(function (r, i) {
        L.push('  ' + (i + 1) + '. ' + r.team + '  ' + r.w + '-' + r.l);
      });
      var basement = last.rows[last.rows.length - 1];
      L.push('EATS THE WORM for ' + last.season + ': ' + basement.team +
             ' (' + basement.w + '-' + basement.l + ', last). League tradition, still outstanding.');
    }

    var kp = geKeepers_();
    var prov = geKeeperCards_();
    if (prov && prov.cards) {
      L.push('');
      L.push('KEEPER DECLARATIONS. Every keeper costs that round\'s draft pick. A club that keeps ' +
             'nobody holds all of its picks.');
      if (kp && kp.lock_at) L.push('KEEPERS LOCK: ' + kp.lock_at + (kp.locked ? ' (LOCKED)' : ' (still open)'));

      var byOwner = 0, byCommish = 0, empties = [], filed = {};
      prov.cards.slice().sort(function (a, b) { return a.team < b.team ? -1 : (a.team > b.team ? 1 : 0); })
      .forEach(function (c) {
        filed[c.team] = true;
        if (c.byOwner) byOwner++; else byCommish++;
        var who = c.byOwner ? 'filed by the owner' : 'entered by the commissioner, not the owner';
        if (!c.count) {
          empties.push(c.team);
          L.push('  ' + c.team + ': NOT DECLARED. A card exists with no players on it (' + who + ').');
          return;
        }
        /* By round, not by entry order. The sheet stores them however they were
           clicked, and a card read out of order invites the writer to mistake a
           late-round flier for a first-round commitment. */
        L.push('  ' + c.team + ' (' + c.count + '): ' + c.players.slice().sort(function (a, b) {
          return (Number(a.round) || 99) - (Number(b.round) || 99);
        }).map(function (p) {
          return 'R' + p.round + ' ' + p.name;
        }).join(', ') + '  [' + who + '; card last saved ' + geWhen_(c.updated) + ']');
      });

      var missing = (prov.teams || []).filter(function (t) { return !filed[t]; });
      /* AN EMPTY CARD IS NOT A DECLARATION. Counting it as one overstates how much of
         the league is finished — the paper printed "9 of 10 declared" while two clubs
         had named nobody. Bryan confirmed 2026-08-07 that the empty card was simply
         unfinished. Declared means at least one player named. */
      var declared = prov.cards.length - empties.length;
      L.push('  DECLARED (at least one keeper named): ' + declared + ' of ' + (prov.teams.length || 10) + ' clubs — ' +
             byOwner + ' of the cards were filed by the owner, ' + byCommish + ' entered by the commissioner.');
      var outstanding = missing.concat(empties);
      if (outstanding.length) {
        L.push('  STILL OUTSTANDING: ' + outstanding.join(', ') + '.');
      }

      /* THE TWO GUARDS. Both exist because the data cannot support what a columnist
         would most like to say about it, and the 2026-08-07 dry run tried to say it
         anyway. See claude/keeper-declaration-provenance.md. */
      if (empties.length) {
        L.push('');
        L.push('AN EMPTY CARD IS NOT A DECISION AND MAY NOT BE WRITTEN AS ONE. The save accepts an ' +
               'empty selection with no confirmation step, so "chose to keep nobody" and "opened the ' +
               'page and never finished" are recorded identically — and the one club currently in ' +
               'that state had simply not got to it yet. Treat it as OUTSTANDING, the same as a club ' +
               'with no card. You may say the keepers are not in. You may NOT say the club chose to ' +
               'keep nobody, call it deliberate, strategic, a rebuild, bold, brave, arrogant or ' +
               'dramatic, or build a column on the motive.');
      }
      if (missing.length || byCommish) {
        L.push('DO NOT CALL A MISSING CARD LAZY, AND DO NOT READ ENGAGEMENT OFF WHO TYPED A CARD. ' +
               byCommish + ' of the cards above were entered by the commissioner rather than the ' +
               'owner, so what is on file measures data entry as much as owner engagement. A club ' +
               'with no card may simply be one nobody has entered yet, and a card entered by the ' +
               'commissioner does NOT mean its owner could not be bothered — you may not say, or ' +
               'imply, that they failed to file it themselves, did not care, or had to be chased. ' +
               'This is not hypothetical: on 2026-08-16 the paper ran exactly that line about a ' +
               'manager who had in fact been trying to file, and could not, because a stale build ' +
               'of the app on his phone never showed him the keeper button. He reached out; the ' +
               'commissioner entered the card for him. Commissioner entry is as likely to mean an ' +
               'owner asked for help as anything else, and asking for help is engagement.');
      }

      /* WHAT A CHANGED CARD CAN AND CANNOT SUPPORT. Bryan asked that re-cut cards get
         called out. The save time supports that; the sheet does not support more.
         waWritePicks_ overwrites the row, so a dropped keeper leaves no trace anywhere —
         inviting the writer to name one is inviting him to invent one, which is the
         failure this whole brief exists to prevent. */
      L.push('');
      L.push('EACH CARD ABOVE CARRIES WHEN IT WAS LAST SAVED. A card saved TODAY or ' +
             'yesterday is fresh news and is worth a line — a manager re-cutting his keepers ' +
             'this close to the lock is a story. But the sheet keeps only the CURRENT card: ' +
             'the previous version is overwritten and gone. You may say a club changed its ' +
             'card and when. You may NOT say which player came off, what it was before, how ' +
             'many times it has changed, or that anyone was dropped — none of that is ' +
             'recorded and you would be inventing it.');

      /* WHO RUNS WHAT. Bryan, 2026-08-16: a tip that says "Nick has yet to select his
         keepers" or "Tyler is sweating the worm" has to land on a franchise, and until
         now the brief carried no way to make that jump. First names only — see
         geOwnerNames_ for why the email column is not read. */
      var names = geOwnerNames_();
      var runs = (prov.teams || []).filter(function (t) { return names[t]; })
        .map(function (t) { return names[t] + ' runs ' + t; });
      if (runs.length) {
        L.push('');
        L.push('WHO RUNS WHAT: ' + runs.join('; ') + '.');
        L.push('You may call a manager by first name — the league does, and a tip that names a ' +
               'person means the club listed beside it. First names only: never print a surname, ' +
               'an email address or any other contact detail.');
      }
    }
    return L.join('\n');
  }

  L.push('PHASE: in-season, week ' + state.week + ' is complete.');
  L.push('');
  L.push('WEEK ' + state.week + ' RESULTS (winner first):');
  state.games.forEach(function (g) {
    L.push('- ' + g.winner + ' ' + g.winScore + ' def. ' + g.loser + ' ' + g.loseScore +
      (g.winTop ? '  [top scorer ' + g.winTop.name + ' ' + g.winTop.points + ']' : '') +
      (g.loseTop ? '  [' + g.loser + ' best: ' + g.loseTop.name + ' ' + g.loseTop.points + ']' : ''));
  });

  L.push('');
  L.push('STANDINGS (W-L, points for, points against):');
  state.standings.forEach(function (s, i) {
    L.push('  ' + (i + 1) + '. ' + s.team + '  ' + s.w + '-' + s.l + (s.t ? '-' + s.t : '') +
      '  PF ' + s.pf + '  PA ' + s.pa);
  });
  if (state.standings.length) {
    L.push('LAST PLACE (eats the worm): ' + state.standings[state.standings.length - 1].team);
  }

  if (state.bench) {
    var names = Object.keys(state.bench).sort(function (a, b) { return state.bench[b] - state.bench[a]; });
    L.push('');
    L.push('POINTS LEFT ON THE BENCH THIS SEASON (a decision the owner made, not bad luck):');
    names.slice(0, 5).forEach(function (n) { L.push('  ' + n + ': ' + state.bench[n]); });
  }

  if (state.wire.length) {
    L.push('');
    L.push('RECENT WAIVER MOVES (this league does not use a budget; there are no bids):');
    state.wire.slice(0, 8).forEach(function (t) {
      L.push('  team ' + t.teamId + ': ' +
        (t.add ? 'added ' + t.add.name + ' (' + t.add.pos + ')' : '') +
        (t.add && t.drop ? ', ' : '') +
        (t.drop ? 'dropped ' + t.drop.name + ' (' + t.drop.pos + ')' : ''));
    });
  }
  return L.join('\n');
}

/* ------------------------------------------------------------------ writer */

function geEditionLabel_(d) {
  return d.getDay() === 0 ? 'Sunday Edition' : 'Midweek Wire';
}

/**
 * Ask for both pieces in one call, as JSON.
 *
 * One call, not two: the column is supposed to argue with the lead, and two
 * independent calls produce two pieces that have never met. The model is never
 * asked to reproduce a URL or any opaque string — that instruction is precisely
 * what put a base64 fragment on the league feed once already.
 */
function geGenerate_(state) {
  var apiKey = PropertiesService.getScriptProperties().getProperty('GEMINI_API_KEY');
  if (!apiKey) { console.error('geGenerate_: no GEMINI_API_KEY, publishing nothing.'); return null; }

  var brief;
  if (state.phase === 'offseason') {
    var heads = fetchOffseasonHeadlines_();
    if (!heads.length) { console.error('geGenerate_: no headlines in the off-season, publishing nothing.'); return null; }
    brief = geBrief_(state) + '\n\nREAL CURRENT NFL HEADLINES (titles only):\n' +
      heads.map(function (h, i) { return (i + 1) + '. ' + h.title; }).join('\n');
  } else {
    brief = geBrief_(state);
  }

  var sys = GELLY_PERSONA_ + '\n\n' +
    'You are writing one full edition of The Rocky Mountain Valley Dispatch, the ' +
    'league newspaper. You write TWO separate pieces:\n\n' +
    '1. THE LEAD — the front-page story. ' + GE_LEAD_WORDS + ' words. Report what ' +
    'actually happened, in Gelly\'s voice. It needs a real newspaper headline.\n' +
    '2. THE COLUMN — your bylined opinion piece on an inside page. ' + GE_COL_WORDS +
    ' words. Pick ONE owner, one decision or one argument and go after it. The ' +
    'column must NOT retell the lead; it takes a position the lead only reports.\n\n' +
    'Every factual claim — scores, records, player names, waiver moves — must come ' +
    'from the brief you are given. Opinions, needling, predictions and dumb hot ' +
    'takes are yours and are the point. Do not invent a score, a record, a player, ' +
    'or a transaction.\n\n' +
    'FORMAT: each body is plain prose in light markdown. Separate paragraphs with a ' +
    'blank line. You may use "## A short subhead" once or twice per piece to break ' +
    'a section; the paper prints those as crossheads. No lists, no tables, no ' +
    'headers above the first paragraph, no hashtags, no URLs or links of any kind, ' +
    'no quotation marks around the whole piece.\n\n' +
    'This league plays for pride, not money. There is no buy-in, no prize pool and ' +
    'no waiver budget. Never mention money, bids, FAAB or payouts.\n\n' +
    GELLY_CONDUCT_POLICY_ + '\n\n' +
    'Return ONLY the JSON object described by the schema.';

  var payload = {
    contents: [{ parts: [{ text: brief }] }],
    systemInstruction: { parts: [{ text: sys }] },
    generationConfig: {
      temperature: 0.9,
      maxOutputTokens: GE_MAX_TOKENS,
      responseMimeType: 'application/json',
      responseSchema: {
        type: 'OBJECT',
        properties: {
          lead_headline: { type: 'STRING' },
          lead_body: { type: 'STRING' },
          column_headline: { type: 'STRING' },
          column_body: { type: 'STRING' }
        },
        required: ['lead_headline', 'lead_body', 'column_headline', 'column_body']
      }
    }
  };

  var resp;
  try {
    resp = UrlFetchApp.fetch(
      'https://generativelanguage.googleapis.com/v1beta/models/' + GEMINI_MODEL +
      ':generateContent?key=' + apiKey,
      { method: 'post', contentType: 'application/json',
        payload: JSON.stringify(payload), muteHttpExceptions: true });
  } catch (err) {
    console.error('geGenerate_ fetch failed: ' + err);
    return null;
  }
  if (resp.getResponseCode() !== 200) {
    console.error('geGenerate_: Gemini ' + resp.getResponseCode() + ': ' + resp.getContentText().slice(0, 400));
    return null;
  }

  /* gellyText_ is the ONLY parser: it rejects finishReason !== 'STOP' (a
     generation cut off mid-thought comes back WITHOUT thought:true and would
     otherwise sail through) and drops reasoning parts. */
  var raw = gellyText_(JSON.parse(resp.getContentText()));
  if (!raw) { console.error('geGenerate_: empty or rejected response, publishing nothing.'); return null; }

  var out;
  try { out = JSON.parse(raw); }
  catch (err) {
    console.error('geGenerate_: response was not JSON, publishing nothing: ' + raw.slice(0, 200));
    return null;
  }

  var pieces = {
    lead: { title: geTrim_(out.lead_headline), body: geTrim_(out.lead_body) },
    column: { title: geTrim_(out.column_headline), body: geTrim_(out.column_body) }
  };

  /* The gate runs on every field that reaches a member, headlines included — a
     leaked reasoning trace can land in a title as easily as in a body. */
  var fields = [pieces.lead.title, pieces.lead.body, pieces.column.title, pieces.column.body];
  for (var i = 0; i < fields.length; i++) {
    if (!gellySane_(fields[i])) {
      console.error('geGenerate_: field ' + i + ' failed the sanity gate, publishing nothing.');
      return null;
    }
  }
  if (pieces.lead.body.length < 400 || pieces.column.body.length < 250) {
    console.error('geGenerate_: bodies too short to be an edition, publishing nothing.');
    return null;
  }
  return pieces;
}

function geTrim_(s) { return String(s == null ? '' : s).replace(/^\s+|\s+$/g, ''); }

/**
 * A keeper card's save time, as something a columnist can use.
 *
 * Relative, not absolute, because "today" is the only version of this fact worth a
 * sentence — "re-cut his card this morning" is a story, "saved 2026-08-16T19:04Z" is not.
 * Degrades to '' rather than guessing when the cell is blank or unparseable, and the
 * caller prints nothing in that case.
 */
function geWhen_(v) {
  if (!v) return 'unknown';
  var d = (v instanceof Date) ? v : new Date(v);
  if (isNaN(d.getTime())) return 'unknown';
  var days = Math.floor((Date.now() - d.getTime()) / 86400000);
  if (days <= 0) return 'TODAY';
  if (days === 1) return 'yesterday';
  if (days <= 7) return days + ' days ago';
  return Utilities.formatDate(d, Session.getScriptTimeZone(), 'MMM d');
}

/* ------------------------------------------------------------------ publish */

/** Has an edition already been filed for this date? Triggers do retry. */
function geAlreadyFiled_(dateStr) {
  var rows = insiderSheet_().getDataRange().getValues();
  for (var i = rows.length - 1; i > 0 && i > rows.length - 6; i--) {
    if (String(rows[i][1]) === dateStr && String(rows[i][2]) !== GE_COLUMN_SLOT) return true;
  }
  return false;
}

/**
 * Two rows, column FIRST.
 *
 * listInsiderReports_ reverses the sheet, so the LAST row appended is reports[0].
 * The lead has to be that row. Order here is load-bearing; the `edition` mark is
 * what makes the paper correct even if it ever stops being.
 */
function geWriteEdition_(state, pieces) {
  var now = new Date();
  var dateStr = Utilities.formatDate(now, Session.getScriptTimeZone(), 'yyyy-MM-dd');
  if (geAlreadyFiled_(dateStr)) {
    console.log('geWriteEdition_: an edition is already filed for ' + dateStr + '. Nothing published.');
    return false;
  }
  var sh = insiderSheet_();
  sh.appendRow([new Date().toISOString(), dateStr, GE_COLUMN_SLOT, pieces.column.title, pieces.column.body]);
  sh.appendRow([new Date().toISOString(), dateStr, geEditionLabel_(now), pieces.lead.title, pieces.lead.body]);

  /* The Tue/Fri feed post is retired with this job, so the rail would otherwise go
     quiet between editions. A paper promotes its own front page; this is that, and
     it is the only thing this job writes to the feed. */
  try {
    appendFeedPost_(getTab_(FEED_SHEET), GE_PROMO_PREFIX + pieces.lead.title);
  } catch (err) { console.error('geWriteEdition_ promo: ' + err); }

  console.log('Edition filed for ' + dateStr + ': "' + pieces.lead.title + '" + column "' +
              pieces.column.title + '"');
  return true;
}

/* ------------------------------------------------------------------ entry */

/** Trigger target. Plain name, thin wrapper — same shape as runOffseasonReport. */
function runGellyEdition() {
  var state = geLeagueState_();
  var pieces = geGenerate_(state);
  if (!pieces) return;
  geWriteEdition_(state, pieces);
}

/**
 * Sunday and Wednesday, 9am, project timezone (America/Denver).
 * Idempotent, and it removes the Tue/Fri off-season triggers this job replaces.
 * Run it once from the editor.
 */
function installGellyEditionTriggers() {
  var killed = 0;
  ScriptApp.getProjectTriggers().forEach(function (t) {
    var fn = t.getHandlerFunction();
    if (fn === 'runGellyEdition' || fn === 'runOffseasonReport') {
      ScriptApp.deleteTrigger(t); killed++;
    }
  });
  ScriptApp.newTrigger('runGellyEdition').timeBased().onWeekDay(ScriptApp.WeekDay.SUNDAY).atHour(9).create();
  ScriptApp.newTrigger('runGellyEdition').timeBased().onWeekDay(ScriptApp.WeekDay.WEDNESDAY).atHour(9).create();
  var msg = 'Installed Sun/Wed 9am edition triggers. Removed ' + killed + ' old trigger(s), ' +
            'including the Tue/Fri off-season feed post this replaces.';
  console.log(msg);
  return msg;
}

/* ---------------------------------------------------------------- ops */

/**
 * DRY RUN. Generates a full edition and logs it. WRITES NOTHING — no sheet row,
 * no feed post, nothing in front of ten people. Run this first, and run it again
 * after any prompt change.
 */
function previewGellyEdition() {
  var state = geLeagueState_();
  console.log('--- GROUNDING (' + state.phase + ', week ' + state.week + ') ---\n' + geBrief_(state));
  var pieces = geGenerate_(state);
  if (!pieces) { console.log('--- NOTHING WOULD BE PUBLISHED (failed closed; see errors above) ---'); return; }
  console.log('--- LEAD: ' + pieces.lead.title + ' ---\n' + pieces.lead.body);
  console.log('--- COLUMN: ' + pieces.column.title + ' ---\n' + pieces.column.body);
  console.log('--- Nothing was written. Use runGellyEdition() to publish for real. ---');
}

/** What is actually scheduled right now. Read-only. */
function listGellyTriggers() {
  var out = ScriptApp.getProjectTriggers().map(function (t) {
    return t.getHandlerFunction() + '  ' + t.getEventType() + '  ' + t.getTriggerSourceId();
  });
  console.log(out.length ? out.join('\n') : 'No project triggers installed.');
  return out;
}
