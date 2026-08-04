/**
 * matchrow.js — the player-row grammar, and the projection math, in ONE place.
 *
 * WHY THIS EXISTS
 * `claude/matchup-detail-build.md` gotcha 35 recorded that `projectWin`/`seasonForm` had
 * been copied into a second page because index.html's script is inline and cannot be
 * imported, and the backlog carries that as debt: "If one changes, change both." The
 * rosters-view handoff then asked for a THIRD consumer — "reuse the matchup-detail row
 * grammar single-column" — which is the point where copying stops being a shortcut and
 * starts being the bug. So the row grammar and the math live here, and index.html,
 * matchup.html and roster.html all read from this file.
 *
 * WHAT IS IN HERE
 *   WPIAL_ROW.teamKey/seasonForm/projectWin/kitWidth   the shared math (moved from index.html)
 *   WPIAL_ROW.normalizeWeek(payload)                   tolerant reader for ?action=matchup_detail
 *   WPIAL_ROW.faceoffRow(left, right, opts)            matchup.html — two players duelling
 *   WPIAL_ROW.soloRow(player, opts)                    roster.html — one player, one column
 *   WPIAL_ROW.totalsBar(...)                           starter / bench totals
 *
 * DESIGN RULES THIS FILE ENFORCES (from both handoffs)
 * - Every status is glyph + WORD. A dot never appears without FINAL / a clock / a kickoff
 *   beside it, so the page reads in greyscale and to a screen reader.
 * - Owner colors are identity only. Nothing in here paints state with a franchise color;
 *   the team-color spine is a 3px rule and that is all it ever is.
 * - Injury chips are glyph + border, never a fill.
 * - Rows are >= 44px on touch.
 *
 * Plain ES5, no build step, no CDN, same as every other file here.
 */
(function () {
  'use strict';

  /* ---------- small helpers ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function num(v) { var n = Number(v); return isFinite(n) ? n : 0; }
  function has(v) { return v !== null && v !== undefined && v !== ''; }
  /* One decimal, or an em-dash. "0.0" and "hasn't happened yet" are different claims —
     the same rule bench.gs applies to weeks_counted in the standings. */
  function pts(v) { return has(v) && isFinite(Number(v)) ? Number(v).toFixed(1) : '—'; }

  /* The stable key for a team name that arrived from OUTSIDE this page. Identical to the
     copy index.html has always had; names drift the moment somebody renames in ESPN. */
  function teamKey(name) {
    return (window.WPIAL_FX && window.WPIAL_FX.canon(name)) ||
           String(name == null ? '' : name).trim();
  }

  function seasonForm(weeks) {
    var f = {};
    var touch = function (k) { return f[k] || (f[k] = { g: 0, pf: 0, pa: 0, w: 0, l: 0 }); };
    Object.keys(weeks || {}).forEach(function (w) {
      (weeks[w] || []).forEach(function (mu) {
        var scored = (mu.awayScore > 0 || mu.homeScore > 0 || mu.winner !== 'UNDECIDED');
        if (!scored) return;
        var a = touch(teamKey(mu.away)), h = touch(teamKey(mu.home));
        var as = num(mu.awayScore), hs = num(mu.homeScore);
        a.g++; h.g++; a.pf += as; a.pa += hs; h.pf += hs; h.pa += as;
        if (mu.winner === 'AWAY') { a.w++; h.l++; } else if (mu.winner === 'HOME') { h.w++; a.l++; }
      });
    });
    return f;
  }

  /* Win probability for the away side.

     PRIORITY, and this order is the whole point: PROJECTED POINTS first, scoring form
     second, even money last. All-time head-to-head is never the basis of anything — at most
     it nudges a number that already came from somewhere real.

     It used to be the other way round in the preseason, and it produced a page that argued
     with itself: Bijan Mustard 95.0 proj vs Drake 99.6 proj, with the ball sitting on
     Mustard's side at 53% because Mustard led the all-time series 6-5. Two numbers on the
     same screen saying opposite things. Bryan: "you have the wrong formula... this should
     not flag off of all time h2h matchup percentage."

     SCALE. A fantasy team scores ~110 a week with a standard deviation around 25, so the
     MARGIN between two of them has an SD near 35. Converting that to a logistic scale is
     sd * sqrt(3)/pi, about 19. The old value was 11, which treated an 11-point projected
     edge as a 73% lock when it is closer to 62%. 19 is used for both point-margin paths. */
  var MARGIN_SCALE = 19;

  function logistic(margin) { return 1 / (1 + Math.exp(-margin / MARGIN_SCALE)); }

  function projectWin(awayName, homeName, form, h2hRec, projAway, projHome) {
    var p = 0.5, basis = 'even money — no projections yet', real = false;

    /* 1. What the two lineups are actually projected to score. This is the number the page
          prints six inches away, so it had better be the number the ball agrees with. */
    if (has(projAway) && has(projHome) && (num(projAway) > 0 || num(projHome) > 0)) {
      p = logistic(num(projAway) - num(projHome));
      basis = 'on projected points';
      real = true;
    } else {
      /* 2. Scoring form: what each side usually scores, blended with what the other usually
            gives up. Only once there is enough of a season to mean anything. */
      var a = form[teamKey(awayName)], h = form[teamKey(homeName)];
      if (a && h && a.g >= 2 && h.g >= 2) {
        var margin = ((a.pf / a.g) + (h.pa / h.g)) / 2 - ((h.pf / h.g) + (a.pa / a.g)) / 2;
        p = logistic(margin);
        basis = 'projected on scoring form';
        real = true;
      }
    }

    /* 3. History is lore, not signal. It may lean a real number by a few points; it may
          never BE the number. With nothing real to lean on, the honest answer is even. */
    if (real && h2hRec && (h2hRec.winsA || h2hRec.winsB)) {
      var awayIsA = teamKey(h2hRec.teamA) === teamKey(awayName);
      var wAway = awayIsA ? h2hRec.winsA : h2hRec.winsB;
      var wHome = awayIsA ? h2hRec.winsB : h2hRec.winsA;
      var tot = wAway + wHome;
      if (tot) {
        var edge = (wAway / tot) - 0.5;
        p = Math.max(0.02, Math.min(0.98, p + edge * 0.12));
        basis += ' + head-to-head';
      }
    }
    return { p: Math.max(0.05, Math.min(0.95, p)), basis: basis };
  }

  function kitWidth(p) { return Math.round(28 + 48 * Math.max(0, Math.min(1, p))); }

  /* ---------- reading ?action=matchup_detail ----------------------------------------
     matchup.gs is saved inside the Apps Script project and has never been committed to
     this repo, so the exact spelling of its response keys cannot be read from here. Rather
     than guess one spelling and render a blank page if it is wrong, this accepts the
     plausible set and normalizes. The cost is a few `||` chains; the benefit is that a key
     mismatch degrades to the page's existing "feed absent" state instead of a crash.
     VERIFY THIS ONCE AFTER THE BACKEND IS DEPLOYED — see the build notes. */
  var BENCH_SLOTS = { BE: 1, BN: 1, IR: 1, BENCH: 1 };

  function pick(o, names, dflt) {
    for (var i = 0; i < names.length; i++) {
      if (o && has(o[names[i]])) return o[names[i]];
    }
    return dflt;
  }

  function normalizePlayer(p) {
    if (!p) return null;
    var slot = String(pick(p, ['slot', 'lineupSlot', 'lineupSlotName', 'pos_slot'], '') || '').toUpperCase();
    var starter = pick(p, ['starter', 'isStarter'], null);
    if (starter === null) starter = !BENCH_SLOTS[slot];
    return {
      slot: slot || '—',
      pos: String(pick(p, ['pos', 'position', 'defaultPosition'], slot) || '').toUpperCase(),
      name: String(pick(p, ['name', 'player', 'fullName'], '') || ''),
      nfl: String(pick(p, ['nfl', 'nflTeam', 'proTeam', 'team'], '') || '').toUpperCase(),
      opp: String(pick(p, ['opp', 'opponent'], '') || ''),
      clock: String(pick(p, ['clock', 'gameClock', 'status_text'], '') || ''),
      kickoff: String(pick(p, ['kickoff', 'gameDate', 'start'], '') || ''),
      line: String(pick(p, ['line', 'statLine', 'stats'], '') || ''),
      /* `inj` is what matchup.gs actually ships (verified against the live Version 50
         payload: {inj, name, nfl, pos, proj, pts, slot, starter}); the longer spellings are
         kept for anything else that ever feeds this. 'ACTIVE' maps to no chip, correctly. */
      injury: String(pick(p, ['inj', 'injury', 'injuryStatus', 'status'], '') || '').toUpperCase(),
      proj: pick(p, ['proj', 'projected', 'projectedPoints'], null),
      actual: pick(p, ['pts', 'points', 'actual', 'appliedTotal'], null),
      /* 'live' | 'final' | 'pre'. Absent from the feed is not the same as pre — an
         undeployed backend must not claim every player is yet to play. */
      state: String(pick(p, ['state', 'gameState'], '') || '').toLowerCase(),
      starter: !!starter
    };
  }

  function normalizeSide(s) {
    if (!s) return null;
    var raw = pick(s, ['players', 'entries', 'roster', 'lineup'], []) || [];
    var players = [];
    for (var i = 0; i < raw.length; i++) {
      var n = normalizePlayer(raw[i]);
      if (n) players.push(n);
    }
    return {
      name: String(pick(s, ['name', 'team', 'teamName'], '') || ''),
      espnId: pick(s, ['espnId', 'teamId', 'id'], null),
      score: pick(s, ['score', 'total', 'points'], null),
      proj: pick(s, ['proj', 'projected', 'projectedTotal'], null),
      bench: pick(s, ['bench', 'benchPoints', 'benchTotal'], null),
      players: players
    };
  }

  /* Returns { ok, hasRosters, matchups:[{away,home}], error } — always an object, never
     a throw, so a caller's .catch is for the network and nothing else. */
  function normalizeWeek(payload) {
    if (!payload || payload.ok === false) {
      return { ok: false, hasRosters: false, matchups: [],
               error: (payload && (payload.error || payload.message)) || '' };
    }
    var list = pick(payload, ['matchups', 'games', 'pairs'], []) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var m = list[i] || {};
      var away = normalizeSide(pick(m, ['away', 'a', 'teamA'], null));
      var home = normalizeSide(pick(m, ['home', 'h', 'teamB'], null));
      if (away && home) out.push({ away: away, home: home });
    }
    var hasRosters = pick(payload, ['hasRosters', 'rosters'], null);
    if (hasRosters === null) {
      hasRosters = out.some(function (m) { return m.away.players.length || m.home.players.length; });
    }
    return { ok: true, hasRosters: !!hasRosters, matchups: out, error: '' };
  }

  /* ---------- row pieces ---------- */

  /* Position tag — ALWAYS a solid fill, on the bench as much as in the lineup.
     The H2H handoff asked for outlined tags on bench rows, but Law 1 (ratified verbatim in
     the UX decisions memo, and stated in draftboard.html's own colorblind block: "positions
     are only ever solid fills, statuses only ever outlines, so no glance compares like with
     like") says a position is never an outline. §5.1 of that memo settles exactly this kind
     of collision — the spec loses, the law wins — so an outlined RB tag, which would read as
     a status chip, is out.

     The bench is separated instead by the two channels §5.2 endorses: dimming, and the word
     BENCH above the group. */
  function posTag(pos) {
    var p = String(pos || '—').toUpperCase();
    var key = p.replace('/', '').toLowerCase();
    return '<span class="mr-pos mr-' + esc(key) + '">' + esc(p) + '</span>';
  }

  /* Status dot ALWAYS ships with the word or clock that explains it (see metaText).
     ● pulsing accent = in progress · ● dim filled = final · ○ outline = yet to play. */
  function statusDot(state) {
    var s = state === 'live' || state === 'final' ? state : 'pre';
    var label = s === 'live' ? 'In progress' : (s === 'final' ? 'Final' : 'Yet to play');
    return '<span class="mr-dot mr-dot-' + s + '" role="img" aria-label="' + esc(label) + '"></span>';
  }

  /* Q / D / O / IR — glyph plus border, never a fill, with the word spelled out for
     assistive tech. Anything else the feed sends is ignored rather than rendered raw. */
  var INJ = { Q: 'Questionable', D: 'Doubtful', O: 'Out', IR: 'Injured reserve' };
  function injuryChip(injury) {
    var i = String(injury || '').toUpperCase();
    if (i === 'QUESTIONABLE') i = 'Q';
    if (i === 'DOUBTFUL') i = 'D';
    if (i === 'OUT') i = 'O';
    if (i === 'INJURY_RESERVE' || i === 'INJURED_RESERVE') i = 'IR';
    if (!INJ[i]) return '';
    var danger = (i === 'O' || i === 'IR');
    return '<span class="mr-inj' + (danger ? ' danger' : '') + '" title="' + esc(INJ[i]) +
           '" aria-label="' + esc(INJ[i]) + '">' + esc(i) + '</span>';
  }

  /* The meta line carries the words that make the dot legible:
       live      vs DAL · Q3 4:12 · 212 yds, 2 TD
       pre       @KC · Mon 6:15
       final     vs DAL · Final · 212 yds, 2 TD
       out       OUT — did not play        (danger, and it wins over everything else) */
  function metaText(p) {
    var out = String(p.injury || '').toUpperCase();
    if ((out === 'O' || out === 'OUT' || out === 'IR') && p.state === 'final' && !has(p.actual)) {
      return { html: '<span class="mr-out">OUT — did not play</span>', plain: 'OUT — did not play' };
    }
    var bits = [];
    if (p.opp) bits.push(p.opp);
    else if (p.nfl) bits.push(p.nfl);
    if (p.state === 'live' && p.clock) bits.push(p.clock);
    else if (p.state === 'final') bits.push('Final');
    else if (p.kickoff) bits.push(p.kickoff);
    if (p.line) bits.push(p.line);
    var plain = bits.join(' · ');
    return { html: esc(plain), plain: plain };
  }

  /* Points block: actual over "X.X proj". Pre-game the projection is the number that
     matters, so it is promoted rather than shown as a footnote to an em-dash. */
  function ptsBlock(p, state) {
    if (state === 'pre' || !has(p.actual)) {
      return '<span class="mr-pts"><b class="mr-proj-big">' + pts(p.proj) + '</b>' +
             '<i>proj</i></span>';
    }
    var beat = has(p.proj) && Number(p.actual) >= Number(p.proj);
    return '<span class="mr-pts"><b>' + pts(p.actual) +
           '<span class="mr-arrow" aria-label="' + (beat ? 'beat projection' : 'under projection') + '">' +
           (beat ? '▲' : '▼') + '</span></b>' +
           '<i>' + pts(p.proj) + ' proj</i></span>';
  }

  function nameBlock(p) {
    return '<span class="mr-who">' +
             '<span class="mr-nm">' + esc(p.name || '—') + '</span>' +
             injuryChip(p.injury) +
           '</span>';
  }

  function sideCell(p, state, side) {
    if (!p) return '<div class="mr-side mr-' + side + ' mr-empty">—</div>';
    var meta = metaText(p);
    return '<div class="mr-side mr-' + side + '">' +
             '<div class="mr-top">' + statusDot(p.state || state) + nameBlock(p) + '</div>' +
             '<div class="mr-meta">' + meta.html + '</div>' +
           '</div>';
  }

  /* One starting slot, both teams, duelling across a centered position tag. */
  function faceoffRow(left, right, opts) {
    opts = opts || {};
    var state = opts.state || 'pre';
    var slot = opts.slot || (left && left.slot) || (right && right.slot) || '—';
    return '<div class="mr-row' + (opts.bench ? ' mr-bench' : '') + '">' +
             '<span class="mr-spine mr-spine-l" style="background:' + esc(opts.colorLeft || 'var(--line)') + '"></span>' +
             sideCell(left, state, 'l') +
             '<div class="mr-mid">' +
               (left ? ptsBlock(left, state) : '<span class="mr-pts">—</span>') +
               posTag(slot) +
               (right ? ptsBlock(right, state) : '<span class="mr-pts">—</span>') +
             '</div>' +
             sideCell(right, state, 'r') +
             '<span class="mr-spine mr-spine-r" style="background:' + esc(opts.colorRight || 'var(--line)') + '"></span>' +
           '</div>';
  }

  /* The same grammar, one column — this is the whole of what the rosters-view handoff
     asked for ("reuse the matchup-detail row grammar single-column"). Same dots, same
     chips, same points block, so the two pages cannot drift apart. */
  function soloRow(p, opts) {
    opts = opts || {};
    var state = opts.state || 'pre';
    var meta = metaText(p);
    return '<div class="mr-solo' + (opts.bench ? ' mr-bench' : '') + '">' +
             posTag(p.slot) +
             '<div class="mr-solo-who">' +
               '<div class="mr-top">' + statusDot(p.state || state) + nameBlock(p) + '</div>' +
               '<div class="mr-meta">' + meta.html + '</div>' +
             '</div>' +
             ptsBlock(p, state) +
           '</div>';
  }

  function totalValue(actual, proj, state) {
    return (state === 'pre' ? pts(proj) : pts(actual)) +
           '<i>' + (state === 'pre' ? 'proj' : pts(proj) + ' proj') + '</i>';
  }

  /* One side. Deliberately its own function rather than an arity check on totalsBar():
     the arity version rendered roster.html's fourth argument (the game state) as a second
     team's score and printed a phantom em-dash column down the right of every totals bar. */
  function totalsBarOne(label, actual, proj, state) {
    return '<div class="mr-tot"><span class="mr-tot-lab">' + esc(label) + '</span>' +
           '<span class="mr-tot-v r">' + totalValue(actual, proj, state) + '</span></div>';
  }

  function totalsBar(label, leftActual, leftProj, rightActual, rightProj, state) {
    return '<div class="mr-tot mr-tot-2">' +
             '<span class="mr-tot-v l">' + (state === 'pre' ? pts(leftProj) : pts(leftActual)) +
               '<i>' + (state === 'pre' ? 'proj' : pts(leftProj) + ' proj') + '</i></span>' +
             '<span class="mr-tot-lab">' + esc(label) + '</span>' +
             '<span class="mr-tot-v r">' + (state === 'pre' ? pts(rightProj) : pts(rightActual)) +
               '<i>' + (state === 'pre' ? 'proj' : pts(rightProj) + ' proj') + '</i></span>' +
           '</div>';
  }

  /* Starters in ESPN's own slot order, bench after. Sorting by slot name would put FLEX
     before QB and read as a bug to anyone who has ever opened the ESPN app. */
  var SLOT_ORDER = ['QB', 'RB', 'WR', 'TE', 'FLEX', 'RB/WR/TE', 'OP', 'D/ST', 'DST', 'K'];
  function slotRank(s) {
    var i = SLOT_ORDER.indexOf(String(s || '').toUpperCase());
    return i === -1 ? SLOT_ORDER.length : i;
  }
  function splitLineup(players) {
    var st = [], bn = [];
    (players || []).forEach(function (p) { (p.starter ? st : bn).push(p); });
    st.sort(function (a, b) { return slotRank(a.slot) - slotRank(b.slot); });
    return { starters: st, bench: bn };
  }

  /* Pair two lineups slot-by-slot for the face-off view. Uneven lineups (an IR slot on one
     side only) pad with null rather than shifting every row below out of alignment. */
  function pairLineups(a, b) {
    var sa = splitLineup(a), sb = splitLineup(b);
    var rows = [], i;
    var n = Math.max(sa.starters.length, sb.starters.length);
    for (i = 0; i < n; i++) rows.push({ l: sa.starters[i] || null, r: sb.starters[i] || null, bench: false });
    var m = Math.max(sa.bench.length, sb.bench.length);
    var bench = [];
    for (i = 0; i < m; i++) bench.push({ l: sa.bench[i] || null, r: sb.bench[i] || null, bench: true });
    return { starters: rows, bench: bench };
  }

  function sum(players, field) {
    var t = 0, any = false;
    (players || []).forEach(function (p) { if (has(p[field])) { t += num(p[field]); any = true; } });
    return any ? t : null;
  }

  /* ---------- the stylesheet, injected once ----------
     Kept with the markup on purpose: a row grammar whose CSS lives in two page files is a
     row grammar that will look different on the two pages within a month. Every value is
     a site variable, so this inherits whatever palette the host page defines. */
  var CSS = [
    '.mr-row{display:flex;align-items:stretch;gap:6px;min-height:46px;padding:6px 0;',
      'border-bottom:1px solid var(--line);position:relative;}',
    '.mr-row:last-child{border-bottom:none;}',
    '.mr-spine{width:3px;border-radius:2px;flex:0 0 3px;}',
    '.mr-side{flex:1 1 0;min-width:0;overflow:hidden;display:flex;flex-direction:column;justify-content:center;gap:2px;}',
    /* NOT align-items:flex-end. .mr-side is a COLUMN flex container, so align-items is its
       cross axis — i.e. width — and flex-end sizes each child to its own content instead of
       to the column. That is what let a long right-hand name grow past the column and get
       clipped from the left ("a Hubbard") rather than ellipsed on the right. Stretch the
       children to the column and let text-align do the alignment. */
    '.mr-side.mr-r{text-align:right;}',
    '.mr-side.mr-r .mr-top{flex-direction:row-reverse;justify-content:flex-start;}',
        '.mr-empty{color:var(--muted);align-items:center;justify-content:center;}',
    '.mr-top{display:flex;align-items:center;gap:6px;min-width:0;}',
    '.mr-who{display:flex;align-items:center;gap:5px;min-width:0;flex:0 1 auto;overflow:hidden;}',
    /* min-width:0 is load-bearing, not defensive. A flex item defaults to min-width:auto and
       so refuses to shrink below its own text, which let a long name on the right-hand side
       spill left across the center column at 390px instead of ellipsing. */
    '.mr-nm{font-weight:600;font-size:13.5px;white-space:nowrap;overflow:hidden;',
      'text-overflow:ellipsis;min-width:0;flex:0 1 auto;}',
    '.mr-meta{font-size:11px;color:var(--muted);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:100%;}',
    '.mr-out{color:var(--danger,#e0644f);font-weight:600;}',
    /* dots: fill and outline differ, so greyscale still separates the three states */
    '.mr-dot{width:8px;height:8px;border-radius:50%;flex:0 0 8px;display:inline-block;}',
    '.mr-dot-live{background:var(--accent);box-shadow:0 0 0 3px rgba(216,180,92,.18);animation:mrpulse 1.6s ease-in-out infinite;}',
    '.mr-dot-final{background:var(--muted);}',
    '.mr-dot-pre{background:transparent;border:1.5px solid var(--muted);}',
    '@keyframes mrpulse{0%,100%{opacity:1}50%{opacity:.45}}',
    '@media (prefers-reduced-motion:reduce){.mr-dot-live{animation:none;}}',
    /* injury chips: border + glyph, never a fill */
    '.mr-inj{flex:0 0 auto;font-size:9.5px;font-weight:700;line-height:1;padding:2px 4px;border-radius:3px;',
      'border:1px solid var(--accent);color:var(--accent);letter-spacing:.4px;}',
    '.mr-inj.danger{border-color:var(--danger,#e0644f);color:var(--danger,#e0644f);}',
    /* center column */
    '.mr-mid{flex:0 0 auto;display:flex;align-items:center;gap:7px;}',
    '.mr-pos{font-family:Oswald,sans-serif;font-size:10px;font-weight:600;letter-spacing:.6px;',
      'padding:3px 5px;border-radius:4px;min-width:38px;text-align:center;color:#0b0e13;background:var(--muted);}',
    '.mr-qb{background:var(--qb,#e0644f);} .mr-rb{background:var(--rb,#57b26a);}',
    '.mr-wr{background:var(--wr,#5b9bd5);} .mr-te{background:var(--te,#e39b3b);}',
    '.mr-k{background:var(--k,#a97fd1);} .mr-dst{background:var(--def,#8a93a0);}',
    '.mr-flex,.mr-rbwrte,.mr-op{background:var(--accent2,#f0d488);}',
    '.mr-pts{display:flex;flex-direction:column;align-items:center;min-width:46px;line-height:1.1;}',
    '.mr-pts b{font-family:Oswald,sans-serif;font-size:17px;font-variant-numeric:tabular-nums;',
      'display:flex;align-items:baseline;gap:2px;}',
    '.mr-pts b.mr-proj-big{color:var(--muted);}',
    '.mr-pts i{font-style:normal;font-size:9.5px;color:var(--muted);white-space:nowrap;}',
    '.mr-arrow{font-size:8px;color:var(--muted);}',
    /* bench: dimming + the BENCH heading above the group. NOT an outlined position tag —
       see posTag(). */
    '.mr-bench{opacity:.72;}',
    /* totals */
    '.mr-tot{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:8px 10px;',
      'margin:6px 0;border-radius:8px;background:var(--panel2,rgba(255,255,255,.03));border:1px solid var(--line);}',
    '.mr-tot-lab{font-family:Oswald,sans-serif;font-size:10.5px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted);}',
    '.mr-tot-v{font-family:Oswald,sans-serif;font-size:19px;font-variant-numeric:tabular-nums;display:flex;',
      'flex-direction:column;line-height:1.05;}',
    '.mr-tot-v i{font-style:normal;font-size:9.5px;color:var(--muted);}',
    '.mr-tot-2 .mr-tot-v.r{align-items:flex-end;}',
    /* single column */
    '.mr-solo{display:flex;align-items:center;gap:10px;min-height:46px;padding:7px 0;border-bottom:1px solid var(--line);}',
    '.mr-solo:last-child{border-bottom:none;}',
    '.mr-solo-who{flex:1 1 auto;min-width:0;display:flex;flex-direction:column;gap:2px;}',
    /* At 390px the center column is competing with two names for the same row. Give the
       names the space back: tighter numbers, a narrower slot tag, smaller gaps. */
    '@media (max-width:430px){',
      /* UX decisions memo 5.6: on a phone player names floor at 13px and chips at 9px.
         11.5-12.5px was explicitly called out as desktop-only. */
      '.mr-nm{font-size:13px;}',
      '.mr-pts{min-width:38px;} .mr-pts b{font-size:15px;} .mr-pts i{font-size:9px;}',
      '.mr-pos{min-width:30px;padding:3px 3px;font-size:9px;}',
      '.mr-inj{font-size:9px;}',
      '.mr-mid{gap:4px;} .mr-row{gap:4px;}',
      '.mr-meta{font-size:10px;}',
    '}'
  ].join('');

  function injectCSS() {
    if (document.getElementById('mr-css')) return;
    var st = document.createElement('style');
    st.id = 'mr-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.head) injectCSS();
  else document.addEventListener('DOMContentLoaded', injectCSS);

  window.WPIAL_ROW = {
    esc: esc, pts: pts, has: has,
    teamKey: teamKey, seasonForm: seasonForm, projectWin: projectWin, kitWidth: kitWidth,
    normalizeWeek: normalizeWeek, normalizePlayer: normalizePlayer,
    posTag: posTag, statusDot: statusDot, injuryChip: injuryChip, metaText: metaText,
    faceoffRow: faceoffRow, soloRow: soloRow, totalsBar: totalsBar, totalsBarOne: totalsBarOne,
    splitLineup: splitLineup, pairLineups: pairLineups, sum: sum,
    injectCSS: injectCSS
  };
})();
