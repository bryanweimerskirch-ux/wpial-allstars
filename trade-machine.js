/* ============================================================================
   WPIAL All Stars — TRADE MACHINE  (shared bundle, v1.0)
   ----------------------------------------------------------------------------
   Drop-in. Add ONE line before </body> on any page that has rosters:

       <script src="trade-machine.js" defer></script>

   It mounts itself. No build step, no dependencies, no globals required.

   WHERE IT GETS ITS DATA
     Rosters : scraped live from the page (#teamGrid .card) on index.html, or
               from window.ROSTERS if the page already defines it (draftboard).
     Rankings: the league rankings feed, cached 12h in localStorage. If the feed
               is unreachable it degrades to "no grades, still lets you build and
               ask Gelly" rather than breaking the page.
     Keepers : the ⭐/.keeper class already rendered on the roster cards.

   THE MODEL (why the numbers are what they are)
     1. VALUE     half-PPR overall rank on an exponential decay curve:
                  #1=100  #12=77  #24=58  #36=44  #60=25  #100=10  #150=3
     2. PICKS     a pick is worth the player you expect at that slot, using the
                  team's real snake position: R1 from the 1st slot = 100,
                  from the 10th slot = 81, R16 = 3.
     3. SURPLUS   keeping a player costs you your pick in his round, so what he's
                  really worth is  value - pickValue(his round).  Trade him and
                  you get that pick back, so surplus is the true swing.
     4. BEST 5    you keep 5, one per round. Your 6th-best surplus is worth zero.
                  Team value = picks owned + best-legal-5 surplus.
                  A trade's grade = each side's change in that number.
   ========================================================================== */
(function () {
'use strict';

/* ------------------------------------------------------------------ CONFIG */
var CFG = {
  // Real 2026 Round-1 draft order. Snake position drives pick values, so this
  // matters — update it if the order changes.
  DRAFT_ORDER: ["Drake Draaaake?","Kweef Farts","Syd Sweeney's Denim Jeans","G. O. A. T.",
                "THE Vagitarians","Mud Dogs","Bindgamer3","Bijan Mustard","Mean Machine",
                "Return of The Mac"],
  ROUNDS: 16,
  MAX_KEEP: 5,
  API: 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec',
  VK: 42,            // decay constant of the value curve
  FUTURE_DISC: 0.70, // 2027 picks are worth 70% of the equivalent 2026 pick
  CACHE_KEY: 'wpial_tm_pool_v1',
  CACHE_HRS: 12,
  STATE_KEY: 'wpial_tm_state_v1'
};

/* -------------------------------------------------------------------- UTIL */
var $ = function (s, r) { return (r || document).querySelector(s); };
var $$ = function (s, r) { return [].slice.call((r || document).querySelectorAll(s)); };
var norm = function (s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '')
    .replace(/\b(jr|sr|ii|iii|iv|v)\b/g, '').replace(/\s+/g, ' ').trim();
};
var esc = function (s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;')
    .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
};
var r1 = function (v) { return Math.round(v * 10) / 10; };
var store = {
  get: function (k, d) { try { var v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
  set: function (k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} }
};

/* ------------------------------------------------------- ROSTER ACQUISITION */
/* Returns { teams:[name], rosters:{team:[{name,pos,round,declared}]} } */
function readRosters() {
  // Path A — the page already has the data (draftboard.html)
  if (window.ROSTERS && typeof window.ROSTERS === 'object') {
    var t = [], r = {};
    Object.keys(window.ROSTERS).forEach(function (team) {
      t.push(team); r[team] = [];
      (window.ROSTERS[team].rounds || []).forEach(function (rd) {
        (rd.players || []).forEach(function (p) {
          r[team].push({ name: p.name, pos: p.pos, round: rd.round, declared: false });
        });
      });
    });
    if (t.length) return { teams: t, rosters: r, source: 'window.ROSTERS' };
  }
  // Path B — scrape the rendered roster cards (index.html)
  var cards = $$('#teamGrid > .card');
  if (!cards.length) return null;
  var teams = [], rosters = {};
  cards.forEach(function (card) {
    var nameEl = $('.team-name', card);
    if (!nameEl) return;
    var team = nameEl.textContent.trim();
    teams.push(team); rosters[team] = [];
    $$('.row', card).forEach(function (row) {
      var rndEl = $('.rnd', row);
      if (!rndEl) return;
      var round = parseInt(String(rndEl.textContent).replace(/[^0-9]/g, ''), 10);
      if (!round) return;
      $$('.player', row).forEach(function (pl) {
        // text looks like "RB - Jonathan Taylor"
        var txt = pl.textContent.trim();
        var m = txt.match(/^([A-Za-z\/]+)\s*[-–]\s*(.+)$/);
        rosters[team].push({
          name: (m ? m[2] : txt).trim(),
          pos: (m ? m[1] : '?').trim().toUpperCase(),
          round: round,
          declared: pl.classList.contains('keeper')
        });
      });
    });
  });
  return teams.length ? { teams: teams, rosters: rosters, source: '#teamGrid' } : null;
}

/* ------------------------------------------------------------- RANKINGS */
var POOL = [], POOL_BY = {}, poolState = 'loading'; // loading | live | cache | none

function indexPool(list) {
  POOL = list || []; POOL_BY = {};
  POOL.forEach(function (p) { POOL_BY[norm(p.n)] = p; });
}
function loadPool() {
  // draftboard already has it in memory
  if (window.POOL && window.POOL.length) { indexPool(window.POOL); poolState = 'live'; return Promise.resolve(); }
  var cached = store.get(CFG.CACHE_KEY, null);
  if (cached && cached.at && (Date.now() - cached.at) < CFG.CACHE_HRS * 3600e3 && cached.pool) {
    indexPool(cached.pool); poolState = 'cache';
  }
  return fetch(CFG.API + '?action=rankings')
    .then(function (r) { return r.json(); })
    .then(function (j) {
      var list = j.players || j.pool || j;
      if (!list || !list.length) throw new Error('empty');
      indexPool(list); poolState = 'live';
      store.set(CFG.CACHE_KEY, { at: Date.now(), pool: list });
    })
    .catch(function () { if (poolState === 'loading') poolState = 'none'; });
}

/* -------------------------------------------------------------- VALUATION */
var D = null;                     // {teams, rosters}
var SLOT = {};                    // SLOT[round][team] = 1-based overall pick

function buildSlots(teams) {
  var order = CFG.DRAFT_ORDER.filter(function (t) { return teams.indexOf(t) >= 0; });
  teams.forEach(function (t) { if (order.indexOf(t) < 0) order.push(t); }); // any stragglers
  var n = order.length, ov = 0;
  SLOT = {};
  for (var r = 1; r <= CFG.ROUNDS; r++) {
    SLOT[r] = {};
    var seq = (r % 2 === 1) ? order : order.slice().reverse();
    seq.forEach(function (t) { SLOT[r][t] = ++ov; });
  }
}
function pv(rank) { if (!rank || rank < 1) return 0.5; return 100 * Math.exp(-(rank - 1) / CFG.VK) + 0.5; }
function pickOverall(round, team) { return (SLOT[round] && SLOT[round][team]) || (round - 1) * D.teams.length + Math.ceil(D.teams.length / 2); }
function pickVal(round, team, year) {
  if (year && year > 2026) {
    var s = 0; D.teams.forEach(function (t) { s += pv(pickOverall(round, t)); });
    return (s / D.teams.length) * Math.pow(CFG.FUTURE_DISC, year - 2026);
  }
  return pv(pickOverall(round, team));
}
function faBand(rank) { return Math.min(CFG.ROUNDS, Math.ceil(rank / 10)); }

var pKey = function (team, name) { return 'p|' + team + '|' + norm(name); };
var dKey = function (team, round, year) { return 'd|' + team + '|' + round + '|' + year; };

function playerRec(fromTeam, name) {
  var n = norm(name);
  var row = (D.rosters[fromTeam] || []).filter(function (p) { return norm(p.name) === n; })[0];
  var pool = POOL_BY[n];
  var rank = pool ? pool.r : null;
  return {
    kind: 'p', from: fromTeam, name: row ? row.name : name, key: pKey(fromTeam, name),
    pos: (row && row.pos) || (pool && pool.p) || '?', rank: rank, ranked: !!pool,
    val: pv(rank), declared: !!(row && row.declared), inj: pool ? pool.inj : null,
    keepRound: row ? row.round : (pool ? faBand(pool.r) : CFG.ROUNDS)
  };
}
function pickRec(fromTeam, round, year) {
  return {
    kind: 'd', from: fromTeam, round: round, year: year, key: dKey(fromTeam, round, year),
    val: pickVal(round, fromTeam, year),
    label: year + ' R' + round + (year === 2026 ? ' (#' + pickOverall(round, fromTeam) + ' ov)' : '')
  };
}
function baseState(team) {
  var players = (D.rosters[team] || []).map(function (p) { return playerRec(team, p.name); });
  var picks = [];
  for (var y = 2026; y <= 2027; y++) for (var r = 1; r <= CFG.ROUNDS; r++) picks.push(pickRec(team, r, y));
  return { players: players, picks: picks };
}
function applyTrade(base, sends, gets) {
  var out = {}; sends.forEach(function (a) { out[a.key] = 1; });
  return {
    players: base.players.filter(function (a) { return !out[a.key]; })
      .concat(gets.filter(function (a) { return a.kind === 'p'; })),
    picks: base.picks.filter(function (a) { return !out[a.key]; })
      .concat(gets.filter(function (a) { return a.kind === 'd'; }))
  };
}
function evaluate(team, st) {
  var byRound = {};
  st.picks.forEach(function (d) { if (d.year === 2026) (byRound[d.round] = byRound[d.round] || []).push(d.val); });
  Object.keys(byRound).forEach(function (r) { byRound[r].sort(function (a, b) { return a - b; }); });

  var scored = st.players.map(function (p) {
    var arr = byRound[p.keepRound];
    var cost = (arr && arr.length) ? arr[0] : null;   // spend the cheapest duplicate
    var o = {}; for (var k in p) o[k] = p[k];
    o.cost = cost; o.noPick = cost == null; o.surplus = cost == null ? 0 : p.val - cost;
    return o;
  });
  var eligible = scored.filter(function (p) { return !p.noPick && p.surplus > 0; })
    .sort(function (a, b) { return b.surplus - a.surplus; });
  var kept = [], used = {};
  eligible.forEach(function (p) {
    if (kept.length < CFG.MAX_KEEP && !used[p.keepRound]) { kept.push(p); used[p.keepRound] = 1; }
  });
  var benched = eligible.filter(function (p) { return kept.indexOf(p) < 0; });
  var keepVal = kept.reduce(function (a, p) { return a + p.surplus; }, 0);
  var pickTotal = st.picks.reduce(function (a, d) { return a + d.val; }, 0);
  return { scored: scored, kept: kept, benched: benched, keepVal: keepVal, pickTotal: pickTotal, total: keepVal + pickTotal };
}
function letter(e) {
  if (e >= 25) return ['A+', 'a']; if (e >= 15) return ['A', 'a'];
  if (e >= 8) return ['B+', 'b']; if (e >= 3) return ['B', 'b'];
  if (e > -3) return ['C+', 'c']; if (e > -8) return ['C', 'c'];
  if (e > -15) return ['C-', 'd']; if (e > -25) return ['D', 'd'];
  return ['F', 'f'];
}
function grade(A, B, aSends, bSends) {
  var bA = baseState(A), bB = baseState(B);
  var befA = evaluate(A, bA), befB = evaluate(B, bB);
  var aftA = evaluate(A, applyTrade(bA, aSends, bSends));
  var aftB = evaluate(B, applyTrade(bB, bSends, aSends));
  var dA = aftA.total - befA.total, dB = aftB.total - befB.total;
  var gross = (aSends.reduce(function (x, y) { return x + y.val; }, 0) +
               bSends.reduce(function (x, y) { return x + y.val; }, 0)) / 2;
  var basis = Math.max(gross, 6);
  var eA = dA / basis * 100, eB = dB / basis * 100;
  return { A: A, B: B, aSends: aSends, bSends: bSends, befA: befA, befB: befB, aftA: aftA, aftB: aftB,
           dA: dA, dB: dB, eA: eA, eB: eB, gross: gross, gA: letter(eA), gB: letter(eB) };
}

/* ------------------------------------------------------------------ STYLES */
var CSS = [
'.tm-launch{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin:0 0 14px;padding:12px 14px;border:1px solid var(--line,#2a3038);border-left:4px solid var(--accent,#ff6a1a);border-radius:10px;background:var(--card,var(--panel,#161b22));}',
'.tm-launch b{font-size:15px;}',
'.tm-launch .tm-sub{color:var(--muted,#9aa4b2);font-size:12.5px;flex:1;min-width:180px;}',
'.tm-btn{cursor:pointer;border-radius:7px;border:1px solid var(--line,#2a3038);background:var(--card,#161b22);color:var(--text,#e6edf3);padding:7px 13px;font:inherit;font-size:13px;}',
'.tm-btn:hover{border-color:var(--accent,#ff6a1a);}',
'.tm-btn.pri{background:var(--accent,#ff6a1a);border-color:var(--accent,#ff6a1a);color:#120802;font-weight:700;}',
'.tm-btn.sm{padding:3px 9px;font-size:11.5px;}',
/* the builder lives in the page flow, not an overlay */
'.tm-panel{display:none;margin:0 0 16px;border:1px solid var(--accent,#ff6a1a);border-top:none;border-radius:0 0 10px 10px;padding:14px 16px 16px;background:var(--bg,#0d1117);}',
'.tm-panel.on{display:block;}',
'.tm-launch.on{margin-bottom:0;border-radius:10px 10px 0 0;border-bottom-color:transparent;}',
'.tm-h{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:12px;}',
'.tm-h .sp{margin-left:auto;}',
'.tm-panel select{background:var(--card,#161b22);border:1px solid var(--line,#2a3038);color:var(--text,#e6edf3);border-radius:7px;padding:7px 10px;font:inherit;font-size:13px;font-weight:600;max-width:100%;}',
'.tm-cols{display:grid;grid-template-columns:1fr 1fr;gap:12px;}',
'.tm-side{border:1px solid var(--line,#2a3038);border-radius:10px;overflow:hidden;background:var(--card,#161b22);}',
'.tm-side h3{margin:0;padding:9px 11px;font-size:13px;letter-spacing:.8px;text-transform:uppercase;background:rgba(255,255,255,.04);border-bottom:1px solid var(--line,#2a3038);display:flex;align-items:center;gap:8px;}',
'.tm-side h3 .g{margin-left:auto;}',
'.tm-list{max-height:290px;overflow-y:auto;padding:6px 8px;}',
'.tm-grp{font-size:10px;letter-spacing:1.4px;text-transform:uppercase;color:var(--muted,#9aa4b2);margin:9px 0 3px;}',
'.tm-grp:first-child{margin-top:2px;}',
'.tm-head{display:flex;align-items:center;gap:7px;padding:0 5px 4px 5px;font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted,#9aa4b2);border-bottom:1px solid var(--line,#2a3038);margin-bottom:3px;}',
'.tm-head .nm{flex:1;padding-left:44px;}',
'.tm-head .vv{min-width:32px;text-align:right;}',
'.tm-head .pl{min-width:44px;text-align:right;cursor:help;}',
'.tm-head .rd,.tm-head .vv{cursor:help;}',
'.tm-decl{cursor:help;}',
'.tm-legend{font-size:11.5px;color:var(--muted,#9aa4b2);line-height:1.5;margin:0 0 10px;padding:8px 11px;border-radius:8px;background:rgba(255,255,255,.035);border-left:3px solid var(--accent2,#2ea6ff);}',
'.tm-legend b{color:var(--text,#e6edf3);}',
'.tm-a{display:flex;align-items:center;gap:7px;padding:5px;border-radius:6px;cursor:pointer;font-size:12.5px;}',
'.tm-a:hover{background:rgba(255,255,255,.05);}',
'.tm-a.on{background:rgba(255,106,26,.15);outline:1px solid var(--accent,#ff6a1a);}',
'.tm-a input{margin:0;flex:none;accent-color:var(--accent,#ff6a1a);}',
'.tm-a .nm{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
'.tm-a .rd{font-size:10.5px;color:var(--muted,#9aa4b2);white-space:nowrap;}',
'.tm-a .vv{font-size:11.5px;color:var(--accent2,#2ea6ff);min-width:32px;text-align:right;}',
'.tm-pill{font-size:10px;padding:1px 6px;border-radius:99px;white-space:nowrap;}',
'.tm-pill.p{background:rgba(46,166,255,.18);color:var(--accent2,#2ea6ff);}',
'.tm-pill.n{background:rgba(255,106,26,.15);color:var(--accent,#ff6a1a);}',
'.tm-chip{font-size:9.5px;font-weight:700;padding:1px 5px;border-radius:3px;background:var(--line,#2a3038);flex:none;}',
'.tm-out{margin-top:12px;border:1px solid var(--line,#2a3038);border-radius:10px;padding:13px 15px;background:var(--card,#161b22);}',
'.tm-verdict{font-size:18px;font-weight:700;margin-bottom:2px;}',
'.tm-subline{font-size:12px;color:var(--muted,#9aa4b2);margin-bottom:10px;}',
'.tm-meter{height:15px;border-radius:99px;background:rgba(255,255,255,.06);position:relative;overflow:hidden;border:1px solid var(--line,#2a3038);}',
'.tm-meter i{position:absolute;top:0;bottom:0;background:var(--accent,#ff6a1a);opacity:.8;}',
'.tm-meter b{position:absolute;top:0;bottom:0;left:50%;width:2px;background:var(--muted,#9aa4b2);}',
'.tm-mlab{display:flex;justify-content:space-between;font-size:10.5px;color:var(--muted,#9aa4b2);margin-top:3px;}',
'.tm-g{font-size:19px;font-weight:700;padding:1px 10px;border-radius:7px;}',
'.tm-g.a{background:#2f9e5c;color:#05170c;} .tm-g.b{background:#7cb342;color:#0b1505;}',
'.tm-g.c{background:#e0a531;color:#180f01;} .tm-g.d{background:#e07a2f;color:#180a01;}',
'.tm-g.f{background:#e0503f;color:#1a0603;}',
'.tm-led{display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:12px;font-size:12px;}',
'.tm-led table{width:100%;border-collapse:collapse;}',
'.tm-led td{padding:2px 0;border-bottom:1px dotted var(--line,#2a3038);}',
'.tm-led td:last-child{text-align:right;color:var(--accent2,#2ea6ff);}',
'.tm-led tr.t td{border-bottom:none;border-top:1px solid var(--line,#2a3038);font-weight:700;padding-top:5px;}',
'.tm-led h4{margin:0 0 4px;font-size:12px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted,#9aa4b2);}',
'.tm-k5{font-size:11.5px;color:var(--muted,#9aa4b2);margin-top:7px;line-height:1.5;}',
'.tm-k5 b{color:var(--text,#e6edf3);}',
'.tm-w{font-size:12px;padding:6px 10px;border-radius:6px;border-left:3px solid var(--muted,#9aa4b2);background:rgba(255,255,255,.04);margin-top:5px;}',
'.tm-w.bad{border-left-color:#e0503f;} .tm-w.good{border-left-color:#2f9e5c;} .tm-w.warn{border-left-color:var(--conflict-line,#ff9f4d);}',
'.tm-acts{display:flex;gap:8px;flex-wrap:wrap;margin-top:13px;align-items:center;}',
'.tm-msg{font-size:11.5px;color:var(--muted,#9aa4b2);}',
'.tm-note{font-size:11px;color:var(--muted,#9aa4b2);margin-top:9px;line-height:1.45;}',
'.tm-empty{color:var(--muted,#9aa4b2);font-size:12.5px;padding:18px 4px;text-align:center;}',
/* --- Gelly --- */
'.tm-gelly{margin-top:12px;border:1px solid var(--conflict-line,#ff9f4d);background:var(--conflict,#3a2410);border-radius:10px;padding:12px 14px;}',
'.tm-gelly .hd{display:flex;align-items:center;gap:8px;font-weight:700;font-size:13px;margin-bottom:6px;}',
'.tm-gelly .hd .at{color:var(--muted,#9aa4b2);font-weight:400;font-size:11.5px;}',
'.tm-gelly .say{font-size:14px;line-height:1.55;white-space:pre-wrap;}',
'.tm-gelly .say.think{opacity:.65;font-style:italic;}',
'.tm-gelly .pub{margin-top:9px;display:flex;gap:8px;align-items:center;flex-wrap:wrap;}',
'.tm-gelly .warnpub{font-size:11.5px;color:var(--muted,#9aa4b2);}',
'.tm-posted{font-size:12px;color:var(--accent2,#2ea6ff);font-weight:600;}',
'@media (max-width:820px){',
'  .tm-panel{padding:12px;}',
'  .tm-h select{flex:1;min-width:0;}',
'  .tm-cols,.tm-led{grid-template-columns:1fr;}',
'  .tm-list{max-height:210px;}',
'  .tm-a{padding:7px 5px;font-size:13px;}',
'  .tm-verdict{font-size:16px;}',
'}'
].join('\n');

/* ---------------------------------------------------------------- MARKUP */
var PANEL = [
'<div class="tm-panel" id="tmPanel">',
'  <div class="tm-h">',
'    <select id="tmA" aria-label="First team"></select>',
'    <button class="tm-btn sm" id="tmSwap" title="Swap sides">⇄</button>',
'    <select id="tmB" aria-label="Second team"></select>',
'    <span class="sp"></span>',
'    <button class="tm-btn sm" id="tmBal" title="Add one asset from the winning side to even it up">⚖️ Balance</button>',
'    <button class="tm-btn sm" id="tmClr">Clear</button>',
'  </div>',
'  <div class="tm-legend">',
'    <b>value</b> = trade value on a scale where the #1 overall player is ~100 (#12 ≈ 77, #24 ≈ 58, #60 ≈ 25, #100 ≈ 10). ',
'    <b>keep</b> = what he is worth <i>after</i> paying his round cost — value minus the pick you burn to keep him. ',
'    A star player who costs a 1st can be worth almost nothing to keep; a good one who costs a 12th can be worth a fortune. ',
'    <b>The grade uses “keep”, not “value.”</b> Hover any row to see the arithmetic. 🔒 = officially declared keeper.',
'  </div>',
'  <div class="tm-cols">',
'    <div class="tm-side"><h3><span id="tmAN"></span>&nbsp;sends<span class="tm-g c g" id="tmGA">–</span></h3><div class="tm-list" id="tmLA"></div></div>',
'    <div class="tm-side"><h3><span id="tmBN"></span>&nbsp;sends<span class="tm-g c g" id="tmGB">–</span></h3><div class="tm-list" id="tmLB"></div></div>',
'  </div>',
'  <div class="tm-out" id="tmOut"></div>',
'</div>'
].join('\n');

/* ------------------------------------------------------------------- STATE */
var TA = null, TB = null, sel = {}, show27 = {}, msg = '', gelly = null, gellyBusy = false;
var pubStage = 'idle';   // idle | confirm | sending | posted | failed

function assetsOf(team) { var b = baseState(team); return b.players.concat(b.picks); }
function lookup(team, key) { return assetsOf(team).filter(function (a) { return a.key === key; })[0] || null; }
function picked(team) { return (sel[team] || []).map(function (k) { return lookup(team, k); }).filter(Boolean); }
function saveState() { store.set(CFG.STATE_KEY, { a: TA, b: TB, sel: sel }); }

/* ------------------------------------------------------------------ RENDER */
function renderList(team, elId) {
  var el = $('#' + elId); if (!el) return;
  var on = {}; (sel[team] || []).forEach(function (k) { on[k] = 1; });
  var st = baseState(team), ev = evaluate(team, st), smap = {};
  ev.scored.forEach(function (p) { smap[p.key] = p; });

  var plist = st.players.slice().sort(function (a, b) {
    return (a.keepRound - b.keepRound) || ((a.rank || 999) - (b.rank || 999));
  });
  var h = '<div class="tm-grp">Roster · keeper round value</div>';
  if (poolState !== 'none' && plist.length) {
    h += '<div class="tm-head"><span class="nm">Player</span>' +
      '<span class="rd" title="The round it costs to keep him, and his half-PPR overall rank">cost · rank</span>' +
      '<span class="vv" title="Trade value. #1 overall is about 100, #12 about 77, #24 about 58, #60 about 25, #100 about 10.">value</span>' +
      '<span class="pl" title="Value minus the pick you burn to keep him. THIS is what he is worth as a keeper.">keep</span></div>';
  }
  if (!plist.length) h += '<div class="tm-empty">No players on file.</div>';
  plist.forEach(function (p) {
    var s = smap[p.key], pill = '', vTitle = '', why = '';
    if (poolState !== 'none') {
      var ovPick = pickOverall(p.keepRound, team);
      vTitle = p.name + (p.rank ? ' is #' + p.rank + ' overall in half-PPR, worth ' + r1(p.val) + ' trade points.'
                                : ' is not in the current rankings, so he sits at the value floor.');
      if (s && s.noPick) {
        why = vTitle + '\n\n' + team + ' has no R' + p.keepRound + ' pick left, so he cannot be kept at all.';
        pill = '<span class="tm-pill n" title="' + esc(why) + '">no pick</span>';
      } else if (s) {
        why = vTitle + '\n\nKeeping him costs ' + team + "'s R" + p.keepRound + ' pick (#' + ovPick +
          ' overall), worth ' + r1(s.cost) + '.\n' + r1(p.val) + ' − ' + r1(s.cost) + ' = ' +
          (s.surplus > 0 ? '+' : '') + r1(s.surplus) + ' keeper value.\n\n' +
          (s.surplus > 12 ? 'Bargain — he costs far less than he is worth.'
           : s.surplus > 0 ? 'Slightly worth keeping, but not a steal.'
           : 'Not worth a keeper slot — you would give up more than you get.');
        pill = '<span class="tm-pill ' + (s.surplus > 0 ? 'p' : 'n') + '" title="' + esc(why) + '">' +
          (s.surplus > 0 ? '+' : '') + r1(s.surplus) + '</span>';
      }
    }
    h += '<label class="tm-a' + (on[p.key] ? ' on' : '') + '" data-k="' + esc(p.key) + '" data-t="' + esc(team) + '"' +
      (why ? ' title="' + esc(why) + '"' : '') + '>' +
      '<input type="checkbox"' + (on[p.key] ? ' checked' : '') + '>' +
      '<span class="tm-chip">' + esc(p.pos) + '</span>' +
      '<span class="nm">' + (p.declared ? '<span class="tm-decl" title="Officially declared as a 2026 keeper">🔒</span> ' : '') + esc(p.name) + '</span>' +
      '<span class="rd">R' + p.keepRound + (p.rank ? ' · #' + p.rank : '') + '</span>' +
      (poolState === 'none' ? '' : '<span class="vv">' + r1(p.val) + '</span>' + pill) +
      '</label>';
  });
  h += '<div class="tm-grp">2026 draft picks</div>';
  st.picks.filter(function (d) { return d.year === 2026; }).forEach(function (d) {
    h += '<label class="tm-a' + (on[d.key] ? ' on' : '') + '" data-k="' + esc(d.key) + '" data-t="' + esc(team) + '">' +
      '<input type="checkbox"' + (on[d.key] ? ' checked' : '') + '>' +
      '<span class="nm">🎟️ ' + esc(d.label) + '</span>' +
      (poolState === 'none' ? '' : '<span class="vv">' + r1(d.val) + '</span>') + '</label>';
  });
  if (show27[team]) {
    h += '<div class="tm-grp">2027 picks · ×0.70 future discount</div>';
    st.picks.filter(function (d) { return d.year === 2027; }).forEach(function (d) {
      h += '<label class="tm-a' + (on[d.key] ? ' on' : '') + '" data-k="' + esc(d.key) + '" data-t="' + esc(team) + '">' +
        '<input type="checkbox"' + (on[d.key] ? ' checked' : '') + '>' +
        '<span class="nm">🗓️ ' + esc(d.label) + '</span>' +
        (poolState === 'none' ? '' : '<span class="vv">' + r1(d.val) + '</span>') + '</label>';
    });
  } else {
    h += '<button class="tm-btn sm" style="width:100%;margin-top:6px;" data-s27="' + esc(team) + '">+ add 2027 picks</button>';
  }
  el.innerHTML = h;
}

function warnings(g) {
  var w = [];
  function side(t, sends, gets, bef, aft) {
    var declRound = {}, declName = {};
    (D.rosters[t] || []).forEach(function (p) { if (p.declared) { declName[norm(p.name)] = p; declRound[p.round] = p; } });
    sends.forEach(function (a) {
      if (a.kind === 'p' && declName[norm(a.name)])
        w.push(['bad', '<b>' + esc(a.name) + '</b> is a <b>declared keeper</b> for ' + esc(t) + '. Trading him voids that declaration — the commish has to reopen ' + esc(t) + "'s keeper slate."]);
    });
    gets.forEach(function (a) {
      if (a.kind !== 'p') return;
      var s = aft.scored.filter(function (x) { return x.key === a.key; })[0];
      if (s && s.noPick)
        w.push(['bad', esc(t) + ' would own <b>' + esc(a.name) + '</b> at R' + a.keepRound + ' but has no R' + a.keepRound + ' pick left to spend — he can\'t be kept.']);
      else if (s && s.surplus <= 0 && poolState !== 'none')
        w.push(['warn', 'Keeping <b>' + esc(a.name) + '</b> costs ' + esc(t) + " their R" + a.keepRound + ' pick (#' + pickOverall(a.keepRound, t) + ' overall), and he only grades #' + (a.rank || '—') + ' — they\'d give up more than they get. One-year rental, not a keeper.']);
      var clash = declRound[a.keepRound];
      if (clash && norm(clash.name) !== norm(a.name))
        w.push(['warn', 'Round clash: ' + esc(t) + ' already declared <b>' + esc(clash.name) + '</b> at R' + a.keepRound + ', and <b>' + esc(a.name) + '</b> costs R' + a.keepRound + '. One keeper per round — only one stays.']);
    });
    var nb = aft.benched.length - bef.benched.length;
    if (nb > 0)
      w.push(['warn', esc(t) + ' would strand ' + aft.benched.length + ' surplus keeper' + (aft.benched.length > 1 ? 's' : '') + ' on the bench (5 max, one per round). Best left over: <b>' + esc(aft.benched[0].name) + '</b> (+' + r1(aft.benched[0].surplus) + ' wasted).']);
  }
  side(g.A, g.aSends, g.bSends, g.befA, g.aftA);
  side(g.B, g.bSends, g.aSends, g.befB, g.aftB);
  if (g.dA > 0.5 && g.dB > 0.5)
    w.push(['good', 'Both sides gain. Different round costs and different snake slots mean a keeper trade really can be win-win — this one is.']);
  if (g.gross > 4 && Math.abs(g.dA) < 1 && Math.abs(g.dB) < 1)
    w.push(['warn', "Nothing here is worth a keeper slot at its round cost, so this moves zero offseason value — everyone involved goes back in the draft pool either way."]);
  var na = g.aSends.length, nb2 = g.bSends.length;
  if (Math.abs(na - nb2) >= 2)
    w.push(['warn', (na > nb2 ? esc(g.A) : esc(g.B)) + ' is sending ' + Math.max(na, nb2) + ' pieces for ' + Math.min(na, nb2) + '. Quantity-for-quality flatters the quantity side on paper — the best player in the deal usually wins it.']);
  var unr = g.aSends.concat(g.bSends).filter(function (a) { return a.kind === 'p' && !a.ranked; });
  if (unr.length && poolState !== 'none')
    w.push(['warn', 'Not in the current half-PPR rankings, valued at the floor: ' + unr.map(function (a) { return esc(a.name); }).join(', ') + '.']);
  return w;
}

function renderOut() {
  var a = picked(TA), b = picked(TB), out = $('#tmOut');
  $('#tmAN').textContent = TA; $('#tmBN').textContent = TB;
  if (!a.length && !b.length) {
    $('#tmGA').textContent = '–'; $('#tmGA').className = 'tm-g c g';
    $('#tmGB').textContent = '–'; $('#tmGB').className = 'tm-g c g';
    out.innerHTML = '<div class="tm-empty">Tick what each side sends.' +
      (poolState === 'none' ? ' <b>Rankings feed is offline</b>, so grades are unavailable — you can still build a proposal and ask Gelly.' :
       ' The grade is each team\'s change in <b>keeper surplus + picks owned</b>, not raw name value.') + '</div>';
    return;
  }
  if (poolState === 'none') {
    out.innerHTML = '<div class="tm-empty">Rankings feed is offline, so no grade. The proposal still copies and Gelly will still weigh in.</div>' + actsHTML();
    wireActs(null); return;
  }
  var g = grade(TA, TB, a, b);
  $('#tmGA').textContent = g.gA[0]; $('#tmGA').className = 'tm-g ' + g.gA[1] + ' g';
  $('#tmGB').textContent = g.gB[0]; $('#tmGB').className = 'tm-g ' + g.gB[1] + ' g';

  var spread = Math.abs(g.eA - g.eB), verdict;
  if (g.gross > 4 && Math.abs(g.dA) < 1 && Math.abs(g.dB) < 1) verdict = '😴 No-op — no keeper value changes hands';
  else if (g.dA > 0.5 && g.dB > 0.5 && spread < 12) verdict = '✅ Win-win — both rosters get better';
  else if (spread < 6) verdict = '🤝 Fair deal';
  else if (spread < 16) verdict = '↔️ Slight edge: ' + (g.eA > g.eB ? g.A : g.B);
  else if (spread < 32) verdict = '⚠️ ' + (g.eA > g.eB ? g.A : g.B) + ' wins this one';
  else verdict = '🚨 Lopsided — ' + (g.eA > g.eB ? g.A : g.B) + ' is fleecing ' + (g.eA > g.eB ? g.B : g.A);

  var tilt = Math.max(-40, Math.min(40, (g.eA - g.eB) / 2));
  var mw = Math.abs(tilt) / 40 * 50, ml = tilt >= 0 ? 50 : 50 - mw;

  function ledger(t, sends, gets, bef, aft, d) {
    var h = '<div><h4>' + esc(t) + '</h4><table>';
    h += '<tr><td>Sends</td><td>' + (sends.length ? '−' + r1(sends.reduce(function (x, y) { return x + y.val; }, 0)) : '—') + '</td></tr>';
    sends.forEach(function (s) { h += '<tr><td style="padding-left:10px;opacity:.7;">' + esc(s.kind === 'p' ? s.name + ' (R' + s.keepRound + ')' : s.label) + '</td><td>' + r1(s.val) + '</td></tr>'; });
    h += '<tr><td>Gets</td><td>' + (gets.length ? '+' + r1(gets.reduce(function (x, y) { return x + y.val; }, 0)) : '—') + '</td></tr>';
    gets.forEach(function (s) { h += '<tr><td style="padding-left:10px;opacity:.7;">' + esc(s.kind === 'p' ? s.name + ' (R' + s.keepRound + ')' : s.label) + '</td><td>' + r1(s.val) + '</td></tr>'; });
    h += '<tr><td>Best-5 keeper surplus</td><td>' + r1(bef.keepVal) + ' → ' + r1(aft.keepVal) + '</td></tr>';
    h += '<tr><td>Picks owned</td><td>' + r1(bef.pickTotal) + ' → ' + r1(aft.pickTotal) + '</td></tr>';
    h += '<tr class="t"><td>Net</td><td>' + (d >= 0 ? '+' : '') + r1(d) + '</td></tr></table>';
    h += '<div class="tm-k5">Keeper 5 after: ' + (aft.kept.length
      ? aft.kept.map(function (p) { return '<b>' + esc(p.name) + '</b> R' + p.keepRound + ' +' + r1(p.surplus); }).join(' · ')
      : '<i>nothing worth keeping</i>') + '</div></div>';
    return h;
  }

  var h = '<div class="tm-verdict">' + verdict + '</div>';
  h += '<div class="tm-subline">' + esc(g.A) + ' ' + (g.dA >= 0 ? '+' : '') + r1(g.dA) + ' · ' + esc(g.B) + ' ' + (g.dB >= 0 ? '+' : '') + r1(g.dB) + ' keeper-value points</div>';
  h += '<div class="tm-meter"><i style="left:' + ml + '%;width:' + mw + '%"></i><b></b></div>';
  h += '<div class="tm-mlab"><span>' + esc(g.B) + ' wins</span><span>even</span><span>' + esc(g.A) + ' wins</span></div>';
  h += '<div class="tm-led">' + ledger(g.A, a, b, g.befA, g.aftA, g.dA) + ledger(g.B, b, a, g.befB, g.aftB, g.dB) + '</div>';
  warnings(g).forEach(function (x) { h += '<div class="tm-w ' + x[0] + '">' + x[1] + '</div>'; });
  h += gellyHTML();
  h += actsHTML();
  h += '<div class="tm-note">The model prices the round a player costs you, not just the name. Proposals are unofficial — the commissioner still approves every trade and re-declares keepers.</div>';
  out.innerHTML = h;
  wireActs(g);
}

function gellyHTML() {
  if (!gelly && !gellyBusy) return '';
  var h = '<div class="tm-gelly"><div class="hd">🎤 Gelly <span class="at">@YinzerMessiah · self-appointed WPIAL insider</span></div>' +
    '<div class="say' + (gellyBusy ? ' think' : '') + '">' +
    (gellyBusy ? 'Gelly is doin\' the research…' : esc(gelly)) + '</div>';
  if (gelly && !gellyBusy) {
    h += '<div class="pub">';
    if (pubStage === 'posted') {
      h += '<span class="tm-posted">📢 Posted to the league feed — everyone can see it now.</span>';
    } else if (pubStage === 'sending') {
      h += '<span class="warnpub">Sending to the feed…</span>';
    } else if (pubStage === 'confirm') {
      h += '<span class="warnpub"><b>This posts to the league feed where every owner sees it.</b> Sure?</span>' +
           '<button class="tm-btn pri sm" id="tmPubYes">Yes, post it</button>' +
           '<button class="tm-btn sm" id="tmPubNo">Never mind</button>';
    } else {
      h += '<button class="tm-btn sm" id="tmPub">📢 Let Gelly go public</button>' +
           '<span class="warnpub">Posts this take to the league feed for everyone to see.</span>';
      if (pubStage === 'failed') h += '<span class="warnpub">— couldn\'t reach the feed, try again.</span>';
    }
    h += '</div>';
  }
  return h + '</div>';
}
function wireGelly() {
  var y = $('#tmPubYes'), n = $('#tmPubNo'), p = $('#tmPub');
  if (p) p.onclick = function () { pubStage = 'confirm'; renderOut(); };
  if (n) n.onclick = function () { pubStage = 'idle'; renderOut(); };
  if (y) y.onclick = publishGelly;
}
function publishGelly() {
  if (pubStage === 'sending' || !gelly) return;
  pubStage = 'sending'; renderOut();
  var a = picked(TA), b = picked(TB);
  fetch(CFG.API + '?action=gelly_publish', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },
    body: JSON.stringify({
      teamA: TA, teamB: TB,
      aSends: a.map(assetLine), bSends: b.map(assetLine),
      text: gelly, link: shareLink()
    })
  })
    .then(function (r) { return r.json(); })
    .then(function (j) { pubStage = (j && j.ok) ? 'posted' : 'failed'; })
    .catch(function () { pubStage = 'failed'; })
    .then(function () { renderOut(); });
}
function actsHTML() {
  return '<div class="tm-acts">' +
    '<button class="tm-btn pri" id="tmGelly">🎤 Ask Gelly to grade it</button>' +
    '<button class="tm-btn" id="tmCopy">📋 Copy proposal</button>' +
    '<button class="tm-btn" id="tmLink">🔗 Copy share link</button>' +
    '<span class="tm-msg" id="tmMsg">' + esc(msg) + '</span></div>';
}
function wireActs(g) {
  msg = '';
  var c = $('#tmCopy'), l = $('#tmLink'), G = $('#tmGelly');
  if (c) c.onclick = function () { copy(summaryText(g), 'Copied — paste it in the group chat.'); };
  if (l) l.onclick = function () { copy(shareLink(), 'Link copied — it opens this exact trade.'); };
  if (G) G.onclick = function () { askGelly(g); };
  wireGelly();
}

/* ------------------------------------------------------------------- GELLY */
function askGelly(g) {
  if (gellyBusy) return;
  var a = picked(TA), b = picked(TB);
  if (!a.length && !b.length) { msg = 'Put something in the trade first.'; renderOut(); return; }
  gellyBusy = true; gelly = null; pubStage = 'idle'; renderOut();

  var payload = {
    teamA: TA, teamB: TB,
    aSends: a.map(assetLine), bSends: b.map(assetLine),
    grades: g ? { A: g.gA[0], B: g.gB[0] } : null,
    net: g ? { A: r1(g.dA), B: r1(g.dB) } : null,
    verdict: $('.tm-verdict') ? $('.tm-verdict').textContent : ''
  };
  fetch(CFG.API + '?action=gelly_trade', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain;charset=utf-8' },  // avoids CORS preflight on Apps Script
    body: JSON.stringify(payload)
  })
    .then(function (r) { return r.json(); })
    .then(function (j) {
      gelly = (j && (j.text || j.say)) || null;
      if (!gelly) throw new Error('no text');
    })
    .catch(function () { gelly = fallbackGelly(g); })
    .then(function () { gellyBusy = false; renderOut(); });
}
function assetLine(a) {
  return a.kind === 'p'
    ? a.name + ' (' + a.pos + ', keeps at R' + a.keepRound + (a.rank ? ', #' + a.rank + ' overall' : '') + ')'
    : a.label;
}
/* If the endpoint isn't deployed yet (or the network is down), Gelly still talks. */
function fallbackGelly(g) {
  if (!g) return "Gelly's phone is in the Mon River again. Numbers are down — but I've done the research, and I'd still hang up on this one.";
  var sp = Math.abs(g.eA - g.eB), win = g.eA > g.eB ? g.A : g.B, lose = g.eA > g.eB ? g.B : g.A;
  if (g.gross > 4 && Math.abs(g.dA) < 1 && Math.abs(g.dB) < 1)
    return "Nobody's keepin' either of these guys, so this trade is two fellas swappin' seats on the same bus. I've done the research. 🖤💛";
  if (g.dA > 0.5 && g.dB > 0.5 && sp < 12)
    return "Now THIS is a Pittsburgh trade — both sides walk away happy and nobody's mother gets called. Rare. Pay the debt. 🖤💛🪱";
  if (sp < 6) return "Dead even. Boring. Do it, don't do it, I've got insider reports to write. 🖤💛";
  if (sp < 16) return win + " comes out a hair ahead here. Not a robbery, just a nudge — but " + lose + " should ask for a 2027 pick to sleep better.";
  if (sp < 32) return win + " is winnin' this one and they know it. " + lose + ", read the round values before you hit send. I've done the research. 🖤💛";
  return "🚨 SIREN. " + win + " is takin' " + lose + "'s lunch money and the lunch box. Veto it. Burn it. HERE WE GO 🖤💛🪱";
}

/* ------------------------------------------------------------------- SHARE */
function summaryText(g) {
  var a = picked(TA), b = picked(TB), L = [];
  L.push('🔄 TRADE PROPOSAL — WPIAL All Stars', '');
  L.push(TA + ' sends:'); a.length ? a.forEach(function (x) { L.push('  • ' + assetLine(x)); }) : L.push('  • (nothing)');
  L.push(TB + ' sends:'); b.length ? b.forEach(function (x) { L.push('  • ' + assetLine(x)); }) : L.push('  • (nothing)');
  L.push('');
  if (g) {
    L.push('Grade — ' + TA + ': ' + g.gA[0] + '   ' + TB + ': ' + g.gB[0]);
    L.push('Keeper value: ' + TA + ' ' + (g.dA >= 0 ? '+' : '') + r1(g.dA) + ', ' + TB + ' ' + (g.dB >= 0 ? '+' : '') + r1(g.dB));
  }
  if (gelly) { L.push('', 'Gelly says: ' + gelly); }
  L.push('', 'See it / counter it: ' + shareLink());
  return L.join('\n');
}
function b64u(s) { return btoa(unescape(encodeURIComponent(s))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function unb64u(s) { s = s.replace(/-/g, '+').replace(/_/g, '/'); while (s.length % 4) s += '='; return decodeURIComponent(escape(atob(s))); }
function enc(a) { return a.kind === 'p' ? ['p', D.teams.indexOf(a.from), a.name] : ['d', D.teams.indexOf(a.from), a.round, a.year]; }
function dec(x) {
  var t = D.teams[x[1]]; if (!t) return null;
  return x[0] === 'p' ? playerRec(t, x[2]) : pickRec(t, +x[2], +x[3]);
}
function shareLink() {
  var p = { a: D.teams.indexOf(TA), b: D.teams.indexOf(TB), s: picked(TA).map(enc), r: picked(TB).map(enc) };
  return location.origin + location.pathname + '?trade=' + b64u(JSON.stringify(p));
}
function copy(txt, ok) {
  function done() { msg = ok; var m = $('#tmMsg'); if (m) { m.textContent = ok; setTimeout(function () { if ($('#tmMsg')) $('#tmMsg').textContent = ''; }, 3500); } }
  if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(done, function () { fb(txt, done); });
  else fb(txt, done);
}
function fb(txt, done) {
  var ta = document.createElement('textarea');
  ta.value = txt; ta.style.cssText = 'position:fixed;top:-1000px;left:0;';
  document.body.appendChild(ta); ta.select();
  try { document.execCommand('copy'); done(); } catch (e) { prompt('Copy this:', txt); }
  ta.parentNode.removeChild(ta);
}

/* ----------------------------------------------------------------- BALANCE */
function balance() {
  var a = picked(TA), b = picked(TB);
  if ((!a.length && !b.length) || poolState === 'none') return;
  var g = grade(TA, TB, a, b);
  var win = g.eA > g.eB ? TA : TB, cur = win === TA ? a : b, have = {};
  cur.forEach(function (x) { have[x.key] = 1; });
  var best = null, gap = Math.abs(g.eA - g.eB);
  assetsOf(win).filter(function (x) { return !have[x.key]; }).forEach(function (x) {
    var t = grade(TA, TB, win === TA ? a.concat([x]) : a, win === TB ? b.concat([x]) : b);
    var ng = Math.abs(t.eA - t.eB);
    if (ng < gap - 0.01) { gap = ng; best = x; }
  });
  if (!best) { msg = "Nothing on " + win + "'s side gets this closer to even."; renderOut(); return; }
  msg = 'Added ' + (best.kind === 'p' ? best.name : best.label) + ' from ' + win + '.';
  sel[win] = (sel[win] || []).concat([best.key]);
  saveState(); renderAll();
}

/* -------------------------------------------------------------------- WIRE */
function renderAll() { renderList(TA, 'tmLA'); renderList(TB, 'tmLB'); renderOut(); }
function setTeams(a, b) {
  if (a === b) b = D.teams.filter(function (t) { return t !== a; })[0];
  TA = a; TB = b; $('#tmA').value = TA; $('#tmB').value = TB;
}
function isOpen() { var p = $('#tmPanel'); return !!(p && p.classList.contains('on')); }
function setOpen(on, scroll) {
  var p = $('#tmPanel'), bar = $('#tmLaunch'), btn = $('#tmOpen');
  if (!p) return;
  p.classList.toggle('on', !!on);
  if (bar) bar.classList.toggle('on', !!on);
  if (btn) btn.textContent = on ? 'Hide the Trade Machine' : 'Open the Trade Machine';
  if (on) { renderAll(); if (scroll && bar && bar.scrollIntoView) bar.scrollIntoView({ behavior: 'smooth', block: 'start' }); }
}
function open() { setOpen(true, true); }
function close() { setOpen(false); }

function mount() {
  D = readRosters();
  if (!D || !D.teams.length) return;                 // nothing to trade — stay invisible
  buildSlots(D.teams);

  var style = document.createElement('style');
  style.textContent = CSS; document.head.appendChild(style);

  // Launch bar + panel, both in the page flow at the top of the roster section.
  var host = $('#rosters') || $('#teamGrid');
  if (!host) return;
  var bar = document.createElement('div');
  bar.className = 'tm-launch'; bar.id = 'tmLaunch';
  bar.innerHTML = '<b>🔄 Mock Trade</b>' +
    '<span class="tm-sub">Build a what-if deal off these round values, see what it does to both keeper slates, and let Gelly tell you who won.</span>' +
    '<button class="tm-btn pri" id="tmOpen">Open the Trade Machine</button>';
  var panelWrap = document.createElement('div');
  panelWrap.innerHTML = PANEL;
  var panel = panelWrap.firstChild;

  var grid = $('#teamGrid');
  var anchor = (grid && grid.parentNode === host) ? grid : host.firstChild;
  host.insertBefore(bar, anchor);
  host.insertBefore(panel, anchor);
  $('#tmOpen').onclick = function () { setOpen(!isOpen(), false); };

  var opts = D.teams.map(function (t) { return '<option value="' + esc(t) + '">' + esc(t) + '</option>'; }).join('');
  $('#tmA').innerHTML = opts; $('#tmB').innerHTML = opts;

  var saved = store.get(CFG.STATE_KEY, null);
  TA = (saved && D.teams.indexOf(saved.a) >= 0) ? saved.a : D.teams[0];
  TB = (saved && D.teams.indexOf(saved.b) >= 0 && saved.b !== TA) ? saved.b : D.teams.filter(function (t) { return t !== TA; })[0];
  sel = (saved && saved.sel) || {};
  $('#tmA').value = TA; $('#tmB').value = TB;

  /* any change to the deal invalidates Gelly's take and its publish state */
  function dirty() { gelly = null; pubStage = 'idle'; }

  $('#tmA').onchange = function () { setTeams(this.value, TB); dirty(); saveState(); renderAll(); };
  $('#tmB').onchange = function () { setTeams(TA, this.value); dirty(); saveState(); renderAll(); };
  $('#tmSwap').onclick = function () { var t = TA; setTeams(TB, t); dirty(); saveState(); renderAll(); };
  $('#tmClr').onclick = function () { sel = {}; dirty(); saveState(); renderAll(); };
  $('#tmBal').onclick = balance;

  panel.addEventListener('change', function (e) {
    var lab = e.target.closest && e.target.closest('.tm-a'); if (!lab) return;
    var t = lab.getAttribute('data-t'), k = lab.getAttribute('data-k');
    var cur = (sel[t] || []).filter(function (x) { return x !== k; });
    if (e.target.checked) cur.push(k);
    sel[t] = cur; dirty(); saveState(); renderAll();
  });
  panel.addEventListener('click', function (e) {
    var t = e.target.getAttribute && e.target.getAttribute('data-s27');
    if (t) { show27[t] = true; renderAll(); }
  });

  loadPool().then(function () {
    if (isOpen()) renderAll();
    fromLink();
  });
}

function fromLink() {
  var m = /[?&]trade=([^&#]+)/.exec(location.search);
  if (!m) return;
  try {
    var p = JSON.parse(unb64u(m[1]));
    setTeams(D.teams[p.a] || D.teams[0], D.teams[p.b] || D.teams[1]);
    sel = {};
    sel[TA] = (p.s || []).map(dec).filter(Boolean).map(function (a) { return a.key; });
    sel[TB] = (p.r || []).map(dec).filter(Boolean).map(function (a) { return a.key; });
    saveState(); open();
  } catch (e) {}
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
else mount();

window.WPIALTrade = { grade: grade, pv: pv, pickVal: pickVal, baseState: baseState, evaluate: evaluate,
                      playerRec: playerRec, pickRec: pickRec, open: open, data: function () { return D; },
                      poolState: function () { return poolState; } };
})();
