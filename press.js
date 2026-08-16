/* ============================================================================
 * press.js — The Press Room, and the paper inside it.
 *
 * THE PAPER IS PAGINATED. Five sheets in one scroll flow, with a sticky index
 * that tracks which sheet you are on:
 *
 *   1 Front Page   nameplate · the lead · standings agate · Worm Watch
 *   2 The Numbers  top fantasy players · biggest losers · bench ledger · finals
 *   3 Around the League  one brief per franchise, drawn with the owner's own kit
 *   4 The Column   Gelly's column · The Gelly Line · The Transaction Wire
 *   5 Back Page    the full colour Dispatch plate
 *
 * Every page is always in the document. The pager is an index, not a tab strip:
 * hiding pages would break Ctrl-F, print and every screen reader, and the whole
 * point of a newspaper is that you can flip back.
 *
 * WRITES. This page can like, view and tip, and all three go through postWrite().
 * On staging postWrite resolves without a request, because a hosted staging copy
 * that inflated real view counts or published a test tip to ten people would be
 * worse than no staging at all. env.js isolates the draft subtree; this extends
 * that promise on this page from "touches no draft" to "writes nothing".
 *
 * MEASUREMENT. The paper is transform:scale()d. getBoundingClientRect() therefore
 * reports scaled pixels and will quietly lie to you about column measures and
 * heights. Everything here measures with offsetWidth / offsetHeight, which are
 * layout and unaffected by the transform.
 * ==========================================================================*/
(function () {
  'use strict';

  /* Same deployment as index.html:1577 and franchise.js:37. If one moves, all move. */
  var WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';

  var PAPER_W = 1210;
  var EST_YEAR = 2019;
  var MOBILE = 700, TWOCOL = 900;
  var RAIL_KEY = 'wpial_pressroom_rail';
  var FEED_POLL = 30000;

  var ENV = window.WPIAL_ENV || { isStaging: false, key: function (k) { return k; } };
  var READ_ONLY = !!ENV.isStaging;

  var $ = function (id) { return document.getElementById(id); };
  var el = function (t, cls) { var n = document.createElement(t); if (cls) n.className = cls; return n; };

  /* ------------------------------------------------------------------ net */
  /* Same contract as index.html:1589 — four concurrent, three tries, and the slot
     is held across retries on purpose. The homepage already fans out ~10 calls to
     this one deployment; a measured stampede is documented at index.html:1579. */
  var WA_MAXCONC = 4, WA_TRIES = 3, waLive = 0, waWaiting = [];
  function waPump() {
    while (waLive < WA_MAXCONC && waWaiting.length) { waLive++; waWaiting.shift()(); }
  }
  function waJSON(url) {
    return new Promise(function (resolve, reject) {
      waWaiting.push(function () {
        var n = 0;
        (function go() {
          n++;
          fetch(url).then(function (r) { return r.text(); }).then(function (t) {
            var j;
            try { j = JSON.parse(t); }
            catch (e) { throw new Error('not JSON: ' + t.slice(0, 60)); }
            waLive--; waPump(); resolve(j);
          }).catch(function (err) {
            if (n < WA_TRIES) { setTimeout(go, 500 * n * n); return; }
            waLive--; waPump(); reject(err);
          });
        })();
      });
      waPump();
    });
  }
  function get(action) { return waJSON(WEB_APP_URL + '?action=' + action); }
  function soft(action, fallback) {
    return get(action).catch(function () { return fallback; });
  }

  /** Every write on this page. On staging it never leaves the browser. */
  function postWrite(params) {
    if (READ_ONLY) return Promise.resolve({ ok: true, staged: true });
    return fetch(WEB_APP_URL, { method: 'POST', body: new URLSearchParams(params) })
      .then(function (r) { return r.json(); });
  }

  /* ------------------------------------------------------------------ text */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /* escapeHtml does not escape quotes — index.html:1643 exists because of exactly
     that bug, and its lesson was applied to linkify() and missed in insiderMd().
     Anything going into an attribute comes through here. */
  function escAttr(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  /** https? only, and no unencoded whitespace or quoting that could break the attribute. */
  function safeUrl(u) {
    var s = String(u || '').trim();
    if (!/^https?:\/\//i.test(s)) return null;
    if (/[\s<>"']/.test(s)) return null;
    return s;
  }
  function fmt(n, d) {
    var v = Number(n);
    if (!isFinite(v)) return '—';
    return v.toFixed(d === undefined ? 1 : d);
  }
  function roman(n) {
    var map = [[1000,'M'],[900,'CM'],[500,'D'],[400,'CD'],[100,'C'],[90,'XC'],[50,'L'],
               [40,'XL'],[10,'X'],[9,'IX'],[5,'V'],[4,'IV'],[1,'I']], out = '';
    map.forEach(function (p) { while (n >= p[0]) { out += p[1]; n -= p[0]; } });
    return out || 'I';
  }

  /* Markdown, newspaper dialect. An H1 is the article title (the hed owns it) and a
     leading ### is the edition line (the dateline owns it); anything else is a
     subhead someone wrote on purpose, so it prints as a crosshead — which is what a
     broadsheet does with a section break. Deleting them loses content silently. */
  /* A sentinel no author can type by accident. The first attempt marked crossheads
     with a plain ' CROSS ' prefix and an off-by-one slice, which silently ate the
     first letter of every subhead — 'The part where...' printed as 'he part where'.
     Length is taken from the constant now, not counted by hand. */
  var CROSS = '\u0001CROSSHEAD\u0001';

  function md(src) {
    var body = esc(String(src || '').trim());
    body = body.replace(/^\s*#\s+.*$/m, '');
    var seenBody = false;
    var lines = body.split('\n').map(function (ln) {
      var h = /^\s*(#{2,4})\s+(.*)$/.exec(ln);
      if (h) {
        if (!seenBody && h[1].length >= 3) return '';          // edition line
        return CROSS + h[2].trim();
      }
      if (ln.trim()) seenBody = true;
      return ln;
    });
    body = lines.join('\n');
    body = body.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, function (m0, label, url) {
      var u = safeUrl(url);
      if (!u) return label;                                     // degrade to its own text
      return '<a href="' + escAttr(u) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    body = body.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
               .replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
    return body.split(/\n{2,}/).map(function (para) {
      var p = para.trim();
      if (!p) return '';
      if (p.indexOf(CROSS) === 0) {
        return '<div class="crosshead">' + p.slice(CROSS.length).trim() + '</div>';
      }
      if (/^-{3,}$/.test(p)) return '<hr>';
      return '<p>' + p.replace(/\n/g, '<br>') + '</p>';
    }).join('');
  }

  function linkify(s) {
    return String(s || '').split(/(https?:\/\/[^\s<]+)/g).map(function (part, i) {
      if (i % 2 === 0) return esc(part);
      var u = safeUrl(part);
      return u ? '<a href="' + escAttr(u) + '" target="_blank" rel="noopener noreferrer">' + esc(u) + '</a>' : esc(part);
    }).join('');
  }

  function relTime(ts) {
    var t = new Date(ts).getTime();
    if (!isFinite(t)) return '';
    var s = Math.floor((Date.now() - t) / 1000);
    if (s < 60) return 'now';
    if (s < 3600) return Math.floor(s / 60) + 'm';
    if (s < 86400) return Math.floor(s / 3600) + 'h';
    if (s < 604800) return Math.floor(s / 86400) + 'd';
    return new Date(t).toLocaleDateString();
  }

  /* ------------------------------------------------------------------ owner art */
  /* R-Q2: the cut is the owner's own logoSVG builder emblem, re-inked to the print
     palette. The BASE[].logo fallbacks have hardcoded fills and take no parameters
     (franchise.js:49-91) — they are never touched, they are re-drawn as a monogram
     instead. inkCut() is the single swap point for the day the mascot registry lands. */
  var INK = { fill: '#ded5bf', shade: '#b9b09a', light: '#f5f1e6', outline: '#1c2333' };

  function FX() { return window.WPIAL_FX || null; }
  function frec(x) { var f = FX(); return f ? f.byId(x) : null; }
  function fname(x) { var f = FX(); return f ? f.name(x) : String(x || ''); }
  function fcolors(x) {
    var f = FX(), c = f && f.colors(x);
    return c || { primary: '#8a8266', secondary: '#1c2333', accent: '#f5f1e6', ink: '#ffffff' };
  }
  /* ESPN team id -> fid. franchise.js resolve() indexes names and fids, not espn_id,
     so a transaction row (which reports teamId, never a name — matchup.gs:17-28)
     resolved to nothing and the Wire printed "Team 6". */
  function byEspn(id) {
    var f = FX(); if (!f || id == null) return null;
    var want = String(id), hit = null;
    f.all().forEach(function (r) { if (r.espn_id && String(r.espn_id) === want) hit = r.fid; });
    return hit;
  }
  function builderSpec(r) {
    if (!r || r.logo_kind !== 'builder' || !r.logo_data) return null;
    try { return JSON.parse(r.logo_data); } catch (e) { return null; }
  }

  /** Print cut: monochrome, engraved. Used inside the paper's body. */
  function inkCut(x) {
    var f = FX(); if (!f) return '';
    var r = frec(x), spec = builderSpec(r);
    if (spec) {
      return f.logoSVG({
        shape: spec.shape, bg: INK.fill, fg: INK.outline, ring: INK.outline,
        useMono: spec.useMono, mono: spec.mono, icon: spec.icon
      });
    }
    var mono = String(fname(x) || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase();
    return f.logoSVG({ shape: 'shield', bg: INK.fill, fg: INK.outline, ring: INK.outline,
                       useMono: true, mono: mono });
  }

  /** Spot-colour kit: the owner's real colours, for the club briefs and the roll. */
  function kitJersey(x) {
    var f = FX(); if (!f) return '';
    var c = fcolors(x), j = (f.jersey && f.jersey(x)) || null;
    return f.jerseySVG({
      template: (j && j.template) || 'classic',
      primary: c.primary, secondary: c.secondary, accent: c.accent,
      number: (j && j.number) || '', wordmark: (j && j.wordmark) || '',
      sleeves: (j && j.sleeves) || 'stripe'
    });
  }
  function kitLogo(x) {
    var f = FX(); if (!f) return '';
    var r = frec(x), spec = builderSpec(r), c = fcolors(x);
    if (spec) return f.logoSVG(spec);
    return f.logoSVG({ shape: 'shield', bg: c.primary, fg: c.ink, ring: c.secondary,
                       useMono: true, mono: String(fname(x) || '?').replace(/[^A-Za-z0-9]/g, '').slice(0, 3).toUpperCase() });
  }

  /* ------------------------------------------------------------------ state */
  var S = {
    schedule: null, bench: null, reports: [], line: null, wire: null,
    weeks: {}, currentWeek: 1, standings: [], playedWeek: null, posts: [], lastSig: '',
    leads: [], columns: [], rankings: null, keepers: null,
    /* reportsOk distinguishes "the desk filed nothing" from "the wire did not answer".
       soft() returns its fallback on failure, and the fallback for insider_reports is
       an empty array — so without this flag a dropped request renders as an empty
       newspaper, which is a lie about the newsroom rather than about the network. */
    reportsOk: true,
    h2h: null
  };

  /* An edition is TWO InsiderReports rows: the front-page lead, and the bylined
     column that runs inside. The column row is marked `edition === 'Column'` —
     free text by design (Code.gs:1131), written by gelly-edition.gs, and read
     here and nowhere else. Splitting once, at load, is what stops page 4 from
     reprinting the previous edition's lead as though it were today's column. */
  var COLUMN_SLOT = 'column';
  function splitReports(list) {
    var leads = [], cols = [];
    (list || []).forEach(function (r) {
      if (String((r && r.edition) || '').trim().toLowerCase() === COLUMN_SLOT) cols.push(r);
      else leads.push(r);
    });
    return { leads: leads, columns: cols };
  }

  /* ================================================================ NAMEPLATE */
  /* THE FRONT PAGE HAS NO PLATE. The engraving used to run at 54% of the paper
     above the band; Bryan cut it. The nameplate is now type — set once in the
     markup, no probe, no load-order swap, no "collapse the tagline because the art
     already says it" branch. The engraved plate still appears as the house ad, and
     the colour plate is the whole back page, so neither owner asset is lost; the
     front page just opens on the story instead of on a picture.

     Deleted rather than hidden: an element that is never shown is a lie to anything
     reading the markup rather than the pixels. */
  function loadNameplate() {
    placeKitPlate();

    var bp = new Image();
    bp.onload = function () { $('bpArt').src = bp.src; $('bpArt').hidden = false; $('bpFallback').hidden = true; };
    bp.onerror = function () { $('bpFallback').textContent = 'Colour plate not available — uploads/1000038066.jpg'; };
    bp.src = 'uploads/1000038066.jpg';
  }

  function setDateline(report) {
    var d = report && report.report_date ? new Date(
      /T/.test(report.report_date) ? report.report_date : report.report_date + 'T12:00:00') : new Date();
    if (isNaN(d.getTime())) d = new Date();
    var vol = roman(d.getFullYear() - EST_YEAR + 1);
    var no = Math.max(1, S.leads.length);
    $('dlVol').textContent = 'Vol. ' + vol + ' · No. ' + no;
    var seasons = new Date().getFullYear() - EST_YEAR;
    $('earEst').textContent = 'Est. 2019 · ' + seasons + ' seasons on record';
    $('dlDate').textContent = d.toLocaleDateString(undefined,
      { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
    $('bpDate').textContent = d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
    /* R-Q8: derived from the day of week, free-text `edition` still wins. Nothing
       server-side schedules a Sunday vs Wednesday edition, so the masthead does not
       promise one. */
    var label = (report && report.edition) ? String(report.edition) :
                (d.getDay() === 0 ? 'Sunday Edition' : 'Midweek Wire');
    $('dlChip').textContent = label.toUpperCase();

    var fresh = (Date.now() - d.getTime()) < 3 * 86400000;
    $('newChip').hidden = !fresh;

    $('edTitle').textContent = (report && report.title) || 'The Rocky Mountain Valley Dispatch';
    $('edMeta').textContent = d.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
      ' · Edition No. ' + no + ' · ' + label;
    $('stEd').textContent = S.leads.length || '—';
  }

  /* ================================================================ PAGE 1 */
  function renderLead() {
    var r = S.leads[0];
    if (!r) {
      /* Two different failures used to print the same sentence. An empty desk is a
         newsroom fact; a dropped request is a network fact, and telling a reader the
         paper has never been written because their phone lost a packet is the worse
         of the two lies. */
      if (!S.reportsOk) {
        $('leadHed').textContent = 'The wire is down, not the newsroom';
        $('leadDeck').textContent = 'The edition could not be fetched just now. Editions already filed are ' +
          'unaffected — this is the connection, not the copy.';
        $('leadFlow').innerHTML = '<p class="empty">Reload the page. If it keeps happening the feed service ' +
          'is not answering, and nothing you do on this page will change that.</p>';
        return;
      }
      $('leadHed').textContent = 'The presses are warm, the desk is empty';
      $('leadDeck').textContent = 'No edition has been filed yet. Gelly is reportedly "doing the research."';
      $('leadFlow').innerHTML = '<p class="empty">When an insider report is published it lands here as the ' +
        'lead — headline, deck and all — and the rest of the paper fills in around it.</p>';
      return;
    }
    $('leadHed').textContent = r.title || 'Untitled';
    var body = md(r.body_md || '');
    /* No report carries a deck field, and a broadsheet lead without one reads as
       broken. So the copy desk does what a copy desk does: it PROMOTES the opening
       sentence to the deck and takes it out of the body. Printing it in both places
       — which the first cut did — reads as a stutter, not as a deck. */
    var deck = '';
    var firstP = /<p>([\s\S]*?)<\/p>/.exec(body);
    /* Only when the opening paragraph is plain text. A paragraph carrying a link or
       bold would have to be re-serialised to split it, and re-serialising an
       author's markup to win a typographic flourish is how you lose their markup. */
    if (firstP && !/<(?!br\s*\/?>)/i.test(firstP[1])) {
      var plain = firstP[1].replace(/<br\s*\/?>/gi, ' ').replace(/\s+/g, ' ').trim();
      var m = /^(.{40,190}?[.!?])(\s|$)/.exec(plain + ' ');
      if (m && plain.length > m[1].length + 20) {
        deck = m[1];
        body = body.replace(firstP[0], '<p>' + plain.slice(m[1].length).trim() + '</p>');
      } else if (plain.length >= 40 && plain.length <= 240 &&
                 (body.match(/<p>/g) || []).length >= 3) {
        /* The opening graf IS one sentence — a lede-in. The whole paragraph becomes
           the deck. Guarded on there being three more paragraphs, so a two-line
           edition does not get its entire body promoted into the italic line. */
        deck = plain;
        body = body.replace(firstP[0], '');
      }
    }
    $('leadDeck').textContent = deck;
    $('leadKicker').textContent = S.playedWeek ? ('Week ' + S.playedWeek + ' · The Lead') : 'The Lead';

    var flow = $('leadFlow');
    flow.innerHTML = body || '<p class="empty">This edition filed a headline and no body.</p>';

    /* Square wrap: the cut goes INSIDE the flow so the copy runs around it from the
       opening paragraph, rather than sitting above the columns. */
    var lead = guessLeadTeam(r);
    if (lead) {
      var fig = el('figure', 'cut');
      var plate = el('div', 'plate');
      plate.innerHTML = inkCut(lead);
      var cap = el('figcaption');
      cap.innerHTML = esc(fname(lead)) + ' <i>(Staff engraving)</i>';
      fig.appendChild(plate); fig.appendChild(cap);
      flow.insertBefore(fig, flow.firstChild);
      /* A float in a multicol container fragments when the columns are shorter than
         it is — a short edition renders a 150px cut as a box split across both
         columns. Measured, not guessed: a fragmented float reports an offsetWidth
         far wider than its declared width, because the value is the union of the
         fragments. If it did not fit, it becomes a centred block instead. */
      if (fig.offsetWidth > 200) fig.classList.add('block');
    }
    $('stLineWrap').hidden = true;
  }

  /* Longest canon-name match in the headline, else the standings leader. When the
     insider composer gains a lead_team field, prefer that. */
  function guessLeadTeam(r) {
    var f = FX(); if (!f) return null;
    var hay = ((r && r.title) || '') + ' ' + ((r && r.body_md) || '').slice(0, 400);
    var best = null, bestLen = 0;
    f.all().forEach(function (rec) {
      [rec.canon, rec.name].concat(rec.priors || []).forEach(function (nm) {
        if (!nm || nm.length <= bestLen) return;
        if (hay.toLowerCase().indexOf(String(nm).toLowerCase()) >= 0) { best = rec.fid; bestLen = nm.length; }
      });
    });
    if (best) return best;
    return S.standings.length ? S.standings[0].fid : null;
  }

  /* ---- standings: restated, not imported. index.html:2374-2446 computes this
     inline and cannot be imported across pages. index.html remains the source of
     truth — if the two ever disagree, that one is right. */
  function computeStandings() {
    var d = S.schedule;
    if (!d || !d.ok || !d.weeks) { S.standings = []; return; }
    var key = function (n) { var f = FX(); return f ? f.canon(n) : String(n || ''); };
    var rec = {}, played = 0;
    function bump(n) { if (!rec[n]) rec[n] = { w: 0, l: 0, t: 0, pf: 0, pa: 0, games: [] }; return rec[n]; }

    Object.keys(d.weeks).forEach(function (wk) {
      (d.weeks[wk] || []).forEach(function (mu) {
        var an = key(mu.away), hn = key(mu.home);
        if (an === 'TBD' || hn === 'TBD') return;
        var a = bump(an), h = bump(hn);
        var as = Number(mu.awayScore) || 0, hs = Number(mu.homeScore) || 0;
        var scored = (as > 0 || hs > 0 || mu.winner !== 'UNDECIDED');
        if (!scored) return;
        played = Math.max(played, Number(wk) || 0);
        a.pf += as; a.pa += hs; h.pf += hs; h.pa += as;
        if (mu.winner === 'AWAY') { a.w++; h.l++; a.games.push({ wk: +wk, res: 'W' }); h.games.push({ wk: +wk, res: 'L' }); }
        else if (mu.winner === 'HOME') { h.w++; a.l++; h.games.push({ wk: +wk, res: 'W' }); a.games.push({ wk: +wk, res: 'L' }); }
        else { a.t++; h.t++; a.games.push({ wk: +wk, res: 'T' }); h.games.push({ wk: +wk, res: 'T' }); }
      });
    });
    S.playedWeek = played || null;

    var bench = {};
    if (S.bench && S.bench.ok) {
      Object.keys(S.bench.teams || {}).forEach(function (n) { bench[key(n)] = Number(S.bench.teams[n]) || 0; });
    }

    S.standings = Object.keys(rec).map(function (n) {
      var r = rec[n], g = r.w + r.l + r.t;
      var gs = r.games.slice().sort(function (a, b) { return a.wk - b.wk; });
      var streak = '—';
      if (gs.length) {
        var last = gs[gs.length - 1].res, run = 0;
        for (var i = gs.length - 1; i >= 0 && gs[i].res === last; i--) run++;
        streak = last + run;
      }
      var f = FX();
      return {
        name: n, fid: f ? f.resolve(n) : null, label: f ? f.name(n) : n,
        w: r.w, l: r.l, t: r.t, pf: r.pf, pa: r.pa, g: g,
        pct: g ? (r.w + 0.5 * r.t) / g : 0, streak: streak, bench: bench[n] || 0
      };
    }).sort(function (a, b) {
      return (b.pct - a.pct) || (b.pf - a.pf) || ((b.pf - b.pa) - (a.pf - a.pa)) ||
             String(a.label).localeCompare(String(b.label));
    });
  }

  function renderStandings() {
    var box = $('standings');
    if (!S.standings.length) {
      box.innerHTML = '<div class="empty">No games played yet. The table opens with Week 1.</div>';
      return;
    }
    var h = '<div class="agate-head"><span>Team</span><span>W</span><span>L</span>' +
            '<span>PF</span><span>PA</span><span>Strk</span></div>';
    S.standings.forEach(function (s, i) {
      var c = fcolors(s.fid || s.name);
      h += '<div class="agate-row' + (i < 6 ? ' top4' : '') + '">' +
        '<span class="tm"><i class="chip" style="background:' + escAttr(c.primary) + '"></i>' +
        '<span>' + esc(s.label) + '</span></span>' +
        '<span>' + s.w + '</span><span>' + s.l + '</span>' +
        '<span>' + fmt(s.pf) + '</span><span>' + fmt(s.pa) + '</span>' +
        '<span class="' + (s.streak.charAt(0) === 'W' ? 'sW' : 'sL') + '">' + esc(s.streak) + '</span></div>';
    });
    h += '<div class="foot-note">Top 6 make the postseason. Last place eats the worm. These are the rules.</div>';
    box.innerHTML = h;
  }

  /* LAST SEASON'S BASEMENT, rebuilt from the meeting log.
     h2h_log carries every meeting the league has ever played, so the finish order for
     a completed season is derivable rather than stored. Playoff games are excluded —
     the worm is a regular-season punishment and a team can lose in the bracket
     without finishing last. Returns null if the log is missing or a season cannot be
     reconstructed, and the caller falls back to saying nothing. */
  function lastSeasonBasement() {
    var pairs = S.h2h && S.h2h.pairs;
    if (!pairs || !pairs.length) return null;
    var season = 0;
    pairs.forEach(function (p) {
      (p.meetings || []).forEach(function (m) { if (m && m.season > season) season = m.season; });
    });
    if (!season) return null;

    var rec = {};
    function bump(n) { if (!rec[n]) rec[n] = { team: n, w: 0, l: 0 }; return rec[n]; }
    pairs.forEach(function (p) {
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
    /* Fewest wins, then most losses — a team that played fewer games should not
       inherit the basement on win count alone. */
    rows.sort(function (a, b) { return (a.w - b.w) || (b.l - a.l); });
    return { season: season, team: rows[0].team, w: rows[0].w, l: rows[0].l, runnerUp: rows[1] };
  }

  function renderWorm() {
    var box = $('worm');

    /* BEFORE WEEK 1 THERE IS NO BASEMENT. Every club is 0-0, so sorting the table
       returns whoever happens to sort last and prints their name under a red rule as
       though they had earned it — which is how THE Vagitarians got named for a worm
       Drake owes. The same all-zero sort already had to be taken out of page 3.
       Until a game is played, the only true answer is last season's. */
    if (!S.playedWeek) {
      var b = lastSeasonBasement();
      if (!b) {
        box.innerHTML = '<div class="empty">The worm is undefeated in the preseason. Standings open with Week 1.</div>';
        return;
      }
      box.innerHTML = '<p style="margin:0 0 7px"><b>' + esc(b.team) + '</b> owes the worm, ' +
        b.w + '–' + b.l + ' and last in ' + b.season + '.</p>' +
        '<p style="margin:0">Nobody has played a down in ' + (b.season + 1) + ', so the debt still stands ' +
        'from ' + b.season + '. The ' + (b.season + 1) + ' basement opens for business in Week 1.</p>';
      return;
    }

    if (!S.standings.length) {
      box.innerHTML = '<div class="empty">The worm is undefeated in the preseason. Standings open with Week 1.</div>';
      return;
    }
    var last = S.standings[S.standings.length - 1];
    var second = S.standings[S.standings.length - 2];
    var gap = second ? (second.pct - last.pct) : 0;
    box.innerHTML = '<p style="margin:0 0 7px"><b>' + esc(last.label) + '</b> holds the basement at ' +
      last.w + '–' + last.l + (last.t ? '–' + last.t : '') + ', ' + fmt(last.pf) + ' for and ' +
      fmt(last.pa) + ' against.</p>' +
      '<p style="margin:0">' + (gap > 0
        ? 'Nearest escape route is ' + esc(second.label) + ', ' + (gap * 100).toFixed(0) + ' points of win percentage up the ladder.'
        : 'Tied at the bottom, which is not the tiebreaker anyone wants to win.') + '</p>';
  }

  /* ================================================================ PAGE 2 */
  function allPlayers() {
    var wk = S.weeks[S.playedWeek];
    if (!wk || !wk.matchups) return [];
    var out = [];
    wk.matchups.forEach(function (mu) {
      ['away', 'home'].forEach(function (side) {
        var s = mu[side]; if (!s) return;
        (s.players || []).forEach(function (p) {
          out.push({
            name: p.name, pos: p.pos, slot: p.slot, nfl: p.nfl,
            pts: p.pts, proj: p.proj, starter: !!p.starter,
            team: s.team, teamId: s.teamId
          });
        });
      });
    });
    return out;
  }

  /* ESPN owns the lineup. The Honor Roll and the Boneyard are both derived from who
     STARTED and who sat, and that is a decision an owner makes in ESPN — not here,
     and not on any page of this site. Printing the judgement without printing where
     to act on it invites somebody to argue with the newspaper instead of fixing
     their lineup. */
  var SRC_LINEUP = '<div class="pt-srcnote"><b>Source: ESPN</b> — starters, box scores and ' +
    'transactions on this page are pulled from the league\'s ESPN feed. <b>ESPN is the ' +
    'source of truth for setting your lineup.</b> Change it there; the Dispatch only ' +
    'reports what it finds.</div>';
  var SRC_PROJ = '<div class="pt-srcnote"><b>Source: ESPN</b> — projections, average draft ' +
    'position and rookie flags are pulled from ESPN\'s player index. Keeper declarations ' +
    'come from the league\'s own sheet, not from ESPN.</div>';

  function rollTable(rows, opts) {
    if (!rows.length) return '<div class="empty">' + esc(opts.empty) + '</div>';
    var h = '<table class="roll"><thead><tr><th></th><th></th><th>Player</th>' +
            '<th>Franchise</th><th class="n">' + esc(opts.col) + '</th></tr></thead><tbody>';
    rows.forEach(function (r, i) {
      var fid = FX() ? FX().resolve(r.team) : null;
      h += '<tr><td class="rk">' + (i + 1) + '</td>' +
        '<td class="kit">' + (fid ? kitJersey(fid) : '') + '</td>' +
        '<td class="who"><b>' + esc(r.name || '—') + '</b> <i>' + esc(r.pos || '') +
        (r.nfl ? ' · ' + esc(r.nfl) : '') + (opts.slot && r.slot ? ' · ' + esc(r.slot) : '') + '</i></td>' +
        '<td>' + esc(fname(r.team) || '—') + '</td>' +
        '<td class="n pts">' + opts.val(r) + '</td></tr>';
    });
    return h + '</tbody></table>';
  }

  /* ---- pre-season page 2: the board, not the box score --------------------
     Rookie Watch is every rk:1 player the rankings feed flags, best projection
     first. The Value Board is where ADP disagrees with projection — a player the
     room is letting slide later than his own numbers say he should. Both are
     straight off `rankings`; nothing here is invented and nothing is a placeholder. */
  function rankRows(list, opts) {
    if (!list.length) return '<div class="empty">' + esc(opts.empty) + '</div>';
    var h = '<table class="roll"><thead><tr><th></th><th>Player</th><th>Pos</th>' +
            '<th class="n">ADP</th><th class="n">' + esc(opts.col) + '</th></tr></thead><tbody>';
    list.forEach(function (p, i) {
      h += '<tr><td class="rk">' + (i + 1) + '</td>' +
        '<td class="who"><b>' + esc(p.n) + '</b> <i>' + esc(p.t || '') + '</i></td>' +
        '<td>' + esc(p.p || '') + '</td>' +
        '<td class="n">' + (p.adp ? fmt(p.adp) : '—') + '</td>' +
        '<td class="n pts">' + opts.val(p) + '</td></tr>';
    });
    return h + '</tbody></table>';
  }

  function renderPreseasonNumbers() {
    $('numHed').textContent = 'The Rookie Board';
    $('numByline').textContent = 'Nobody has played a down · Projections and draft position, ' +
      'straight off the wire';
    $('numKicker').textContent = 'Pre-season · The Board';
    $('folioWk').textContent = 'Pre-season';
    $('honorH').textContent = '🌱 Rookie Watch';
    $('losersH').textContent = '📉 The Value Board';
    $('benchH').firstChild.nodeValue = 'Deepest Projections ';

    var d = S.rankings;
    if (!d || !d.players) {
      $('honor').innerHTML = '<div class="empty">The rankings wire is not answering.</div>';
      $('losers').innerHTML = '';
      $('benchBox').innerHTML = '<div class="empty">No projections available.</div>';
      $('benchWks').textContent = '';
      renderFinals();
      return;
    }
    var players = d.players;
    var rookies = players.filter(function (p) { return p.rk; })
      .sort(function (a, b) { return b.pts - a.pts; }).slice(0, 8);
    $('honor').innerHTML = rankRows(rookies, {
      col: 'Proj', val: function (p) { return fmt(p.pts); },
      empty: 'No rookies flagged in this year\'s rankings.' });

    /* Value = projected rank materially better than where the room is drafting him. */
    var value = players.filter(function (p) { return p.adp && p.r; })
      .map(function (p) { return { p: p, gap: p.adp - p.r }; })
      .filter(function (x) { return x.gap >= 8; })
      .sort(function (a, b) { return b.gap - a.gap; }).slice(0, 6);
    $('losers').innerHTML =
      '<div class="sect-h" style="font-size:10px;letter-spacing:1.5px;color:var(--pt-tan)">' +
      'Going later than the numbers say</div>' +
      rankRows(value.map(function (x) { return x.p; }), {
        col: 'Rk', val: function (p) { return '#' + p.r; },
        empty: 'ADP and the projections agree this year, which never lasts.' }) +
      SRC_PROJ;

    var deep = players.slice(0, 6);
    $('benchWks').textContent = players.length + ' rated';
    var h = '<div class="agate-head" style="grid-template-columns:1fr 44px"><span>Player</span>' +
            '<span>Proj</span></div>';
    deep.forEach(function (p, i) {
      h += '<div class="agate-row" style="grid-template-columns:1fr 44px' +
        (i === 0 ? ';font-weight:700' : '') + '"><span class="tm"><span>' + esc(p.n) +
        '</span></span><span>' + fmt(p.pts) + '</span></div>';
    });
    h += '<div class="foot-note">Half-PPR projections. Draft night is the only thing ' +
         'that turns these into points.</div>';
    $('benchBox').innerHTML = h;
    renderFinals();
  }

  function renderNumbers() {
    if (!S.playedWeek) return renderPreseasonNumbers();
    var players = allPlayers();
    $('numKicker').textContent = S.playedWeek ? ('Week ' + S.playedWeek + ' · The Numbers') : 'The Numbers';
    $('folioWk').textContent = S.playedWeek ? ('Week ' + S.playedWeek) : 'Preseason';
    $('finalsH').textContent = S.playedWeek ? ('Week ' + S.playedWeek + ' Finals') : 'Week Finals';

    var starters = players.filter(function (p) { return p.starter && p.pts != null; });

    $('honor').innerHTML = rollTable(
      starters.slice().sort(function (a, b) { return b.pts - a.pts; }).slice(0, 8),
      { col: 'Pts', slot: true, val: function (r) { return fmt(r.pts); },
        empty: 'No box scores yet. The honor roll opens the first Sunday of the season.' });

    /* Two ways to lose, and they are different sins. A starter who scored nothing is
       bad luck; a bench player who outscored your starter is a decision you made. */
    var busts = starters.filter(function (p) { return p.proj != null && p.pos !== 'D/ST' && p.pos !== 'K'; })
      .sort(function (a, b) { return (a.pts - a.proj) - (b.pts - b.proj); }).slice(0, 5);
    var benched = players.filter(function (p) { return !p.starter && p.slot === 'BE' && p.pts != null; })
      .sort(function (a, b) { return b.pts - a.pts; }).slice(0, 5);

    var h = '';
    h += '<div class="sect-h" style="font-size:10px;letter-spacing:1.5px;color:var(--pt-tan)">Started, and regretted it</div>';
    h += rollTable(busts, { col: 'vs Proj', slot: true,
      val: function (r) { var d = r.pts - r.proj; return (d >= 0 ? '+' : '') + fmt(d); },
      empty: 'Nobody has underperformed yet, because nobody has performed yet.' });
    h += '<div class="sect-h" style="font-size:10px;letter-spacing:1.5px;color:var(--pt-tan);margin-top:10px">' +
         'Left on the bench</div>';
    h += rollTable(benched, { col: 'Pts', slot: false, val: function (r) { return fmt(r.pts); },
      empty: 'No benchings to report. Give it a week.' });
    h += SRC_LINEUP;
    $('losers').innerHTML = h;

    renderBenchLedger();
    renderFinals();
  }

  function renderBenchLedger() {
    var box = $('benchBox'), wks = $('benchWks');
    if (!S.bench || !S.bench.ok || !S.bench.weeks_counted) {
      wks.textContent = '';
      box.innerHTML = '<div class="empty">Bench points open with the season. Nothing has been left on a bench yet.</div>';
      return;
    }
    wks.textContent = S.bench.weeks_counted + ' wk';
    var rows = S.standings.slice().sort(function (a, b) { return b.bench - a.bench; }).slice(0, 6);
    var h = '<div class="agate-head" style="grid-template-columns:1fr 60px"><span>Team</span><span>Pts left</span></div>';
    rows.forEach(function (s, i) {
      var c = fcolors(s.fid || s.name);
      h += '<div class="agate-row" style="grid-template-columns:1fr 60px' +
        (i === 0 ? ';font-weight:700' : '') + '">' +
        '<span class="tm"><i class="chip" style="background:' + escAttr(c.primary) + '"></i>' +
        '<span>' + esc(s.label) + '</span></span><span>' + fmt(s.bench) + '</span></div>';
    });
    h += '<div class="foot-note">Points-for measures your roster. This measures your judgement.</div>';
    box.innerHTML = h;
  }

  function renderFinals() {
    var box = $('finals');
    var d = S.schedule;
    /* No slate has been played, so there is no strip. An empty ruled box under a
       "Week Finals" head reads as broken rather than as pending. */
    var wrap = $('finalsWrap');
    if (wrap) wrap.hidden = !S.playedWeek;
    if (!S.playedWeek) { box.innerHTML = ''; return; }
    if (!d || !d.ok || !S.playedWeek || !d.weeks[S.playedWeek]) {
      box.innerHTML = '<div class="final" style="grid-column:1/-1;border-right:none">' +
        '<div class="empty">No finals yet — the first slate has not been played.</div></div>';
      return;
    }
    var h = '';
    (d.weeks[S.playedWeek] || []).forEach(function (g) {
      var as = Number(g.awayScore) || 0, hs = Number(g.homeScore) || 0;
      var awayWon = g.winner === 'AWAY';
      var w = awayWon ? { n: g.away, s: as, t: g.awayTopScorer } : { n: g.home, s: hs, t: g.homeTopScorer };
      var l = awayWon ? { n: g.home, s: hs, t: g.homeTopScorer } : { n: g.away, s: as, t: g.awayTopScorer };
      h += '<div class="final"><div class="fl">Final</div>' +
        '<div class="fr"><span>' + esc(fname(w.n)) + ' ✓</span><span>' + fmt(w.s) + '</span></div>' +
        '<div class="fr lose"><span>' + esc(fname(l.n)) + '</span><span>' + fmt(l.s) + '</span></div>' +
        (w.t ? '<div class="fn">' + esc(w.t.name) + ' ' + fmt(w.t.points) + '</div>' : '') +
        '</div>';
    });
    box.innerHTML = h;
  }

  /* ================================================================ PAGE 3 */
  /* keepers land as {team, player} rows keyed on a NAME, so they go through the
     registry like everything else — franchise.js's rule is that anything a human
     typed resolves through canon, never matches raw. */
  function keepersFor(fid) {
    var f = FX(), d = S.keepers;
    if (!f || !d || !d.teams || !fid) return null;
    var hit = null;
    Object.keys(d.teams).forEach(function (name) {
      if (f.resolve(name) === fid) hit = d.teams[name];
    });
    if (!hit) return null;
    return {
      players: (hit.players || []).slice().sort(function (a, b) {
        return (Number(a.round) || 99) - (Number(b.round) || 99);
      }),
      count: hit.count || (hit.players || []).length,
      updated: hit.updated_at || null
    };
  }
  function declaredCount() {
    var d = S.keepers;
    if (!d || !d.teams) return 0;
    return Object.keys(d.teams).filter(function (k) { var t = d.teams[k] || {}; return !!t.updated_at && (t.players || []).some(function (p) { return p && String(p.name || '').trim(); }); }).length; /* An empty card is a SAVE, not a DECISION. waKeeperSave_ accepts players:[] with no confirmation, so "I thought about it and I am keeping nobody" and "I opened the page, did not finish, and hit save" are recorded identically. Counting updated_at alone called Mean Machine declared and printed a compliment about a card Bianco never filled in. See claude/keeper-declaration-provenance.md. */
  }

  function renderAroundLeague() {
    var box = $('atl'), f = FX();
    if (!S.playedWeek) {
      $('atlHed').textContent = 'Ten Rosters, Frozen';
      var dec = declaredCount(), total = 10;
      var lock = S.keepers && S.keepers.lock_at ? new Date(S.keepers.lock_at) : null;
      var lockTxt = (lock && !isNaN(lock.getTime()))
        ? ' · Lock ' + lock.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' }) +
          ', ' + lock.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' })
        : '';
      $('atlByline').textContent = S.keepers
        ? dec + ' of ' + total + ' clubs have declared' +
          (dec < total ? ' · ' + (total - dec) + ' outstanding' : ' · all in') + lockTxt
        : 'Keeper declarations are still open';
    }
    if (!f) { box.innerHTML = '<div class="empty">Franchise registry unavailable.</div>'; return; }
    var order = S.standings.length ? S.standings : f.all().map(function (r) {
      return { fid: r.fid, label: r.name || r.canon, w: 0, l: 0, t: 0, pf: 0, pa: 0, streak: '—', bench: 0, g: 0 };
    });
    var wk = S.weeks[S.playedWeek];
    var byTeam = {};
    if (wk && wk.matchups) {
      wk.matchups.forEach(function (mu) {
        ['away', 'home'].forEach(function (side) {
          var s = mu[side], o = mu[side === 'away' ? 'home' : 'away'];
          if (!s) return;
          var fid = f.resolve(s.team);
          if (fid) byTeam[fid] = { side: side, me: s, them: o, winner: mu.winner, played: mu.played };
        });
      });
    }
    var h = '';
    order.forEach(function (s, i) {
      var fid = s.fid || f.resolve(s.name || s.label);
      var g = byTeam[fid];
      var note;
      if (g && g.played) {
        var won = (g.side === 'away' && g.winner === 'AWAY') || (g.side === 'home' && g.winner === 'HOME');
        var top = (g.me.players || []).filter(function (p) { return p.starter && p.pts != null; })
          .sort(function (a, b) { return b.pts - a.pts; })[0];
        note = (won ? 'Beat ' : 'Lost to ') + esc(fname(g.them && g.them.team)) + ' ' +
          fmt(g.me.score) + '–' + fmt(g.them ? g.them.score : 0) + '. ' +
          (top ? esc(top.name) + ' led with ' + fmt(top.pts) + '. ' : '') +
          (g.me.bench ? fmt(g.me.bench) + ' left on the bench.' : '');
      } else if (s.g) {
        note = 'Idle this week. ' + fmt(s.pf) + ' for, ' + fmt(s.pa) + ' against on the season.';
      } else {
        /* Pre-season. "Yet to play a snap" printed ten times is not a page — the
           keeper list is the only real news a club has in August, and it is the
           thing owners actually argue about. */
        var kept = keepersFor(fid);
        if (kept && kept.players.length) {
          note = '<b>Keeping:</b> ' + kept.players.map(function (k) {
            return (k.round ? '<span class="rd">R' + esc(k.round) + '</span> ' : '') + esc(k.name);
          }).join(' · ');
        } else if (kept && kept.updated) {
          note = 'Card started, nobody on it. Whether that is a choice or an unfinished job, the card reads the same — and the clock does not care which.';
        } else {
          /* Not the same as keeping nobody, and the paper must not conflate them.
             This is the line the commissioner actually wants printed. */
          note = '<b>Has not declared.</b> The sheet is blank and the clock is not.';
        }
      }
      var brief = '<div class="brief">' +
        '<div class="kit">' + kitLogo(fid) + '</div>' +
        '<div class="txt"><h4>' + esc(s.label || fname(fid)) + '</h4>' +
        '<div class="rec">' + (S.playedWeek
          ? (i + 1) + (i === 0 ? 'st' : i === 1 ? 'nd' : i === 2 ? 'rd' : 'th') + ' · ' +
            s.w + '–' + s.l + (s.t ? '–' + s.t : '') + ' · ' + esc(s.streak)
          /* Every club is 0-0 in August, so the sort falls through to team name and
             the standing is alphabetical order wearing a medal. Print what is
             actually true instead. */
          : (function () {
              var k = keepersFor(fid);
              if (!k || !k.updated) return 'Outstanding';
              var when = new Date(k.updated);
              return k.count + ' keeper' + (k.count === 1 ? '' : 's') +
                (isNaN(when.getTime()) ? '' : ' · ' +
                  when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }));
            })()) + '</div>' +
        '<p>' + note + '</p></div></div>';
      h += brief;
    });
    box.innerHTML = h;
  }

  /* ================================================================ PAGE 4 */
  function renderColumn() {
    /* The column is the newest row marked as one. Legacy editions filed before
       gelly-edition.gs have no column row at all, so those fall back to the
       previous lead — but only when it is genuinely a different day's piece.
       Reprinting today's lead on page 4 under a column byline is worse than
       running the empty state. */
    var c = S.columns[0];
    if (!c && S.leads.length > 1 && S.leads[1].report_date !== (S.leads[0] || {}).report_date) {
      c = S.leads[1];
    }
    var cut = $('colCut').querySelector('.plate');
    var subject = S.standings.length ? S.standings[S.standings.length - 1].fid : null;
    cut.innerHTML = subject ? inkCut(subject) : '';

    if (!c) {
      $('colHed').textContent = 'Notes From a Man With No Credentials';
      $('colFlow').innerHTML = '<p class="empty">The column runs when a second edition is filed. ' +
        'Until then Gelly is, in his own words, doing the research.</p>';
      return;
    }
    $('colHed').textContent = c.title || 'The Gelly Column';
    var body = md(c.body_md || '');
    var flow = $('colFlow');
    flow.innerHTML = body;
    /* Drop cap on the first paragraph, and only if it starts with a letter. */
    var p = flow.querySelector('p');
    if (p && p.firstChild && p.firstChild.nodeType === 3) {
      var txt = p.firstChild.nodeValue;
      var m = /^\s*([A-Za-z])/.exec(txt);
      if (m) {
        p.firstChild.nodeValue = txt.replace(/^\s*[A-Za-z]/, '');
        var cap = el('span', 'dropcap');
        cap.textContent = m[1];
        p.insertBefore(cap, p.firstChild);
      }
    }
  }

  function renderLine() {
    var box = $('lineBox'), rec = $('lineRec'), d = S.line;
    if (!d) { box.innerHTML = '<div class="empty">The Gelly Line is not answering.</div>'; return; }
    if (d.gated) {
      /* R-Q5: teaser, not hidden. Same ruled box, copy straight off the gated response. */
      var when = d.unlockAt ? new Date(d.unlockAt) : null;
      box.innerHTML = '<p style="margin:0 0 7px"><span class="lock">Lock</span></p>' +
        '<p style="margin:0">' + esc(d.message || 'The Gelly Line opens with the season.') + '</p>' +
        (when && !isNaN(when.getTime())
          ? '<p style="margin:7px 0 0;color:var(--pt-tan);font-size:11.5px">Unlocks ' +
            esc(when.toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })) +
            '</p>' : '');
      rec.textContent = '';
      $('stLineWrap').hidden = true;
      return;
    }
    if (!d.ok) { box.innerHTML = '<div class="empty">' + esc(d.error || 'The Line is unavailable.') + '</div>'; return; }
    var sr = d.seasonRecord;
    if (sr) {
      rec.textContent = sr.wins + '–' + sr.losses + ' season';
      $('stLine').textContent = sr.wins + '–' + sr.losses;
      $('stLineWrap').hidden = false;
    }
    var h = d.intro ? '<p style="margin:0 0 7px">' + linkify(d.intro) + '</p>' : '';
    (d.picks || []).slice(0, 6).forEach(function (p) {
      /* Name the pick once. "Mud Dogs −8.5 · Mud Dogs at Drake" is how a betting
         line reads when nobody edited it. */
      var pickName = fname(p.pick);
      var other = (fname(p.away) === pickName) ? fname(p.home) : fname(p.away);
      h += '<p style="margin:0 0 7px"><b>' + esc(pickName) + '</b> ' +
        (p.spread != null ? '−' + fmt(p.spread) : '') +
        ' <span style="color:var(--pt-tan)">over ' + esc(other) + '</span>' +
        (p.blurb ? '<br>' + linkify(p.blurb) : '') + '</p>';
    });
    box.innerHTML = h || '<div class="empty">No picks filed for this week.</div>';
  }

  function renderWire() {
    var box = $('wire'), d = S.wire;
    if (!d || !d.ok) {
      /* The column does not go dark and it does not print fictional rows. It says
         what is wrong, because a permanently empty ruled box reads as broken. */
      box.innerHTML = '<div class="empty">The wire is dark — ' +
        esc((d && d.reason === 'no-espn-credentials') ? 'the league feed is not connected yet.'
            : 'ESPN is not answering the transaction ledger.') + '</div>';
      return;
    }
    if (!d.transactions.length) {
      box.innerHTML = '<div class="empty">No waiver movement to report. Ten owners, zero regrets, allegedly.</div>' +
        '<div class="wire-kicker">The wire runs adds and drops only. This league has never used a budget ' +
        'and the Dispatch does not print numbers it does not have.</div>';
      return;
    }
    var h = '';
    d.transactions.slice(0, 12).forEach(function (t) {
      var fid = byEspn(t.teamId);
      var team = fid ? fname(fid) : (t.teamId != null ? 'Club No. ' + t.teamId : 'Unknown club');
      var when = t.date ? new Date(t.date) : null;
      h += '<div class="wire-row"><div class="wt"><span>' + esc(team) + '</span>' +
        '<em>' + esc(t.type === 'WAIVER' ? 'waiver' : 'free agent') +
        (when && !isNaN(when.getTime()) ? ' · ' + when.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) : '') +
        '</em></div>' +
        '<div>' +
        (t.add ? '<span class="wa">ADD ' + esc(t.add.name || 'unnamed') +
                 (t.add.pos ? ' (' + esc(t.add.pos) + ')' : '') + '</span>' : '') +
        (t.add && t.drop ? ' · ' : '') +
        (t.drop ? '<span class="wd">DROP ' + esc(t.drop.name || 'unnamed') +
                  (t.drop.pos ? ' (' + esc(t.drop.pos) + ')' : '') + '</span>' : '') +
        '</div></div>';
    });
    h += '<div class="wire-kicker">Adds and drops only — no bids, no budgets. This league has never ' +
         'played for money and the Wire is not about to start.</div>' +
         '<div class="pt-srcnote"><b>Source: ESPN</b> — the waiver ledger is read from ESPN. ' +
         'Add and drop there.</div>';
    box.innerHTML = h;
  }

  /* ============================================================ the kit plate */
  /* A newspaper never leaves a column short, so something has to fill it. The first
     version dropped in the Dispatch plate as a house ad — which is what a real paper
     does, but here it was the same stock engraving printed twice, carrying no
     information about the league. Bryan cut it: page 2 runs short rather than run
     filler, and page 4 gets a FRANCHISE KIT PLATE instead — the front-runner's own
     jersey and emblem, drawn live from their profile in their own colours.

     It is a cut, not an advert: it says something about the league, and it changes
     week to week because the team at the top does.

     The node is held by reference because renderers assign innerHTML, which would
     detach it — after that getElementById returns null and it is gone for good. */
  var kitPlate = null;
  function contentH(node) {
    var kids = node.children, top = null, bot = 0;
    for (var i = 0; i < kids.length; i++) {
      var k = kids[i];
      if (k.offsetParent === null && !k.offsetHeight) continue;
      if (top === null) top = k.offsetTop;
      bot = Math.max(bot, k.offsetTop + k.offsetHeight);
    }
    return top === null ? 0 : bot - top;
  }

  /** Which franchise the plate features. Deliberately NOT the column's subject —
      the portrait cut beside the column is already that team, and printing the same
      emblem twice on one page is the filler problem again in a different costume. */
  function plateSubject() {
    if (!S.standings.length) return null;
    var colSubject = S.standings[S.standings.length - 1];
    var lead = S.standings[0];
    return (lead && lead.fid && lead.fid !== colSubject.fid) ? lead : null;
  }

  function makeKitPlate() {
    var d = el('figure', 'kitplate');
    d.hidden = true;
    return d;
  }

  function fillKitPlate(node) {
    var s = plateSubject();
    if (!s || !FX()) { node.hidden = true; return false; }
    var rec = S.standings.indexOf(s) === 0 ? 'Top of the table' : 'Franchise plate';
    node.innerHTML =
      '<div class="kp-h">' + esc(rec) + '</div>' +
      '<div class="kp-art">' +
        '<div class="kp-j">' + kitJersey(s.fid) + '</div>' +
        '<div class="kp-l">' + kitLogo(s.fid) + '</div>' +
      '</div>' +
      '<figcaption><b>' + esc(s.label) + '</b>' +
      '<span>' + s.w + '–' + s.l + (s.t ? '–' + s.t : '') + ' · ' + fmt(s.pf) + ' for · ' +
      esc(s.streak) + '</span></figcaption>';
    node.hidden = !node.querySelector('svg');
    return !node.hidden;
  }

  /* Placement is MEASURED, and it picks the column that leaves the two closest in
     height — not simply the shorter one. Dropping a 230px block into a column that
     is 16px short does not fill a gap, it opens a bigger one opposite.
     It detaches first, unconditionally: the first version of this measured the
     columns while the plate was still in one of them, so it kept re-choosing the
     column it was already in — reading its own output as input. */
  function placeKitPlate() {
    var page = $('pg4'); if (!page) return;
    if (!kitPlate) kitPlate = makeKitPlate();
    var ad = kitPlate;
    if (ad.parentNode) ad.parentNode.removeChild(ad);
    if (!fillKitPlate(ad)) return;

    var gcol = page.querySelector('.gcol'), grail = page.querySelector('.grail');
    var slot = $('kitSlot4');
    if (!gcol || !grail) { if (slot) slot.appendChild(ad); return; }

    /* CONTENT height, not the cell. Both columns are grid items in the same row,
       so offsetHeight reports the stretched row height and the two are always
       identical — which made the first version put it in the rail every time,
       beside a body column that was half empty. */
    var a = contentH(gcol), b = contentH(grail);
    /* Measured in EACH candidate, because the plate is a different height in a 280px
       body slot than in the 292px rail — one measurement would be a guess about
       the other. */
    grail.appendChild(ad); var hRail = ad.offsetHeight; grail.removeChild(ad);
    gcol.appendChild(ad);  var hBody = ad.offsetHeight; gcol.removeChild(ad);
    if (!hRail && !hBody) { grail.appendChild(ad); return; }

    var intoRail = Math.abs(a - (b + hRail));
    var intoBody = Math.abs((a + hBody) - b);
    (intoRail <= intoBody ? grail : gcol).appendChild(ad);
  }

  /* ================================================================ pager */
  function buildPager() {
    var nav = $('pager');
    var sheets = Array.prototype.slice.call(document.querySelectorAll('.sheet'));
    sheets.forEach(function (sh) {
      var b = el('button', 'pg-btn');
      b.type = 'button';
      b.innerHTML = sh.dataset.page + '<small>' + esc(sh.dataset.title) + '</small>';
      b.setAttribute('aria-label', 'Page ' + sh.dataset.page + ' — ' + sh.dataset.title);
      b.onclick = function () {
        /* getBoundingClientRect is the RIGHT tool here and the wrong one everywhere
           else in this file: scrolling is a visual operation, so scaled pixels are
           exactly what we want. Layout measurements (column measure, paper height)
           must still use offsetWidth/offsetHeight — the transform lies to them. */
        var deskScroll = window.innerWidth >= TWOCOL;
        var pad = $('pager').offsetHeight + 10;
        if (deskScroll) {
          var host = $('main');
          var y = host.scrollTop + (sh.getBoundingClientRect().top - host.getBoundingClientRect().top) - 12;
          host.scrollTo({ top: Math.max(0, y), behavior: 'smooth' });
        } else {
          var wy = window.pageYOffset + sh.getBoundingClientRect().top - pad;
          window.scrollTo({ top: Math.max(0, wy), behavior: 'smooth' });
        }
      };
      nav.appendChild(b);
    });
    var btns = nav.querySelectorAll('.pg-btn');
    if (!('IntersectionObserver' in window)) { if (btns[0]) btns[0].setAttribute('aria-current', 'true'); return; }
    var io = new IntersectionObserver(function (entries) {
      entries.forEach(function (e) {
        if (!e.isIntersecting) return;
        var n = Number(e.target.dataset.page);
        for (var i = 0; i < btns.length; i++) {
          if (i === n - 1) btns[i].setAttribute('aria-current', 'true');
          else btns[i].removeAttribute('aria-current');
        }
      });
    }, { root: window.innerWidth >= TWOCOL ? $('main') : null, rootMargin: '-30% 0px -60% 0px', threshold: 0 });
    sheets.forEach(function (sh) { io.observe(sh); });
    if (btns[0]) btns[0].setAttribute('aria-current', 'true');
  }

  /* ================================================================ scaling */
  function currentScale() {
    if (window.innerWidth < MOBILE) return 1;
    var avail = $('scaler').clientWidth;
    return Math.min(1, avail / PAPER_W);
  }
  function rescale() {
    var paper = $('paper'), scaler = $('scaler');
    if (window.innerWidth < MOBILE) {
      paper.style.transform = ''; scaler.style.height = ''; return;
    }
    var s = Math.min(1, scaler.clientWidth / PAPER_W);
    paper.style.transform = s < 1 ? 'scale(' + s + ')' : '';
    /* Measured, never a constant. mobilehdr.js:17-21 — "never reintroduce a pixel
       constant, that landmine has already gone off twice" — applies to a paper
       height exactly as it applies to a header height. */
    scaler.style.height = (paper.offsetHeight * s) + 'px';
  }

  function measureBars() {
    var banner = document.getElementById('wpial-env-banner');
    var h = banner ? banner.offsetHeight : 0;
    document.documentElement.style.setProperty('--env-bar-h', h + 'px');
    var bar = $('mobilebar');
    var bh = (bar && getComputedStyle(bar).display !== 'none') ? bar.offsetHeight : 0;
    document.documentElement.style.setProperty('--bar-h', bh + 'px');
    var hdr = document.querySelector('header');
    if (hdr) document.documentElement.style.setProperty('--hdr-h', hdr.offsetHeight + 'px');
  }

  /* ================================================================ rail */
  function railSet(open) {
    $('rail').hidden = !open;
    $('strip').hidden = open;
    try { localStorage.setItem(ENV.key(RAIL_KEY), open ? 'open' : 'hidden'); } catch (e) {}
    rescale();
  }
  function initRail() {
    var pref = 'open';
    try { pref = localStorage.getItem(ENV.key(RAIL_KEY)) || 'open'; } catch (e) {}
    railSet(pref !== 'hidden');
    $('railHide').onclick = function () { railSet(false); };
    $('railShow').onclick = function () { railSet(true); };
    $('railPop').onclick = function () { openPop($('railPop')); };
    $('mobFeed').onclick = function () { openPop($('mobFeed')); };
    $('popClose').onclick = closePop;
    $('popScrim').onclick = closePop;
    /* The Yuengling tip bar was removed 2026-08-16 (index.html). openTip() is still reached from the tip FAB; this line wired the button that no longer exists, and left unguarded it threw inside initRail() and took boot() down with it. */
  }

  var popOpener = null, popTrap = null;
  function openPop(opener) {
    popOpener = opener || null;
    $('popScrim').hidden = false;
    $('popout').hidden = false;
    $('tipFab').hidden = true;                       // never float an action over a dialog
    $('popBody').appendChild($('feedList'));         // ONE feed node, moved — never two lists
    $('popout').classList.add('popout');
    renderPosts(true);
    popTrap = function (e) {
      if (e.key === 'Escape') { closePop(); return; }
      if (e.key !== 'Tab') return;
      var f = $('popout').querySelectorAll('button,a[href],textarea,[tabindex]:not([tabindex="-1"])');
      if (!f.length) return;
      var first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', popTrap);
    $('popClose').focus();
  }
  function closePop() {
    $('popScrim').hidden = true;
    $('popout').hidden = true;
    $('tipFab').hidden = false;
    $('rail').appendChild($('feedList'));
    renderPosts(true);
    if (popTrap) { document.removeEventListener('keydown', popTrap); popTrap = null; }
    if (popOpener && popOpener.offsetParent !== null) popOpener.focus();
    popOpener = null;
  }
  function inPop() { return !$('popout').hidden; }

  /* ================================================================ feed */
  function feedSig(posts) {
    return posts.map(function (p) { return p.row + ':' + (p.likes || 0) + ':' + (p.views || 0); }).join('|');
  }
  function structureSig(posts) { return posts.map(function (p) { return p.row; }).join('|'); }

  var lastStruct = '', lastMode = null;
  function renderPosts(force) {
    var list = $('feedList'), posts = S.posts, mode = inPop() ? 'pop' : 'rail';
    var sig = feedSig(posts), struct = structureSig(posts);
    if (!force && sig === S.lastSig && mode === lastMode) return;
    if (!force && struct === lastStruct && mode === lastMode) { patchCounts(posts); S.lastSig = sig; return; }
    S.lastSig = sig; lastStruct = struct; lastMode = mode;

    if (!posts.length) {
      list.innerHTML = '<div class="empty" style="color:var(--muted)">The feed is quiet. Send a tip.</div>';
      return;
    }
    var h = '';
    posts.forEach(function (p) {
      var liked = false;
      try { liked = !!localStorage.getItem('wpial_liked_' + p.row); } catch (e) {}
      h += '<div class="post" data-row="' + escAttr(p.row) + '">' +
        '<div class="av" aria-hidden="true">🖤</div><div class="bd">' +
        '<div class="nm"><b>' + esc(p.author || 'Gelly') + '</b> ' +
        '<span>' + (mode === 'pop' ? '@YinzerMessiah · ' : '') + esc(relTime(p.timestamp)) + '</span></div>' +
        '<div class="tx">' + linkify(p.text) + '</div>' +
        (p.source_text ? '<div class="src">📨 ' + linkify(p.source_text) + '</div>' : '') +
        '<div class="mx">' +
        '<button class="like" data-row="' + escAttr(p.row) + '"' + (liked ? ' disabled' : '') +
        ' aria-label="Like this post">❤️ <span class="lk">' + (Number(p.likes) || 0) + '</span></button>' +
        '<span>👀 <span class="vw">' + (Number(p.views) || 0) + '</span></span>' +
        '</div></div></div>';
    });
    list.innerHTML = h;
    list.querySelectorAll('button.like').forEach(function (b) { b.onclick = onLike; });
    markViews(posts);
  }
  function patchCounts(posts) {
    posts.forEach(function (p) {
      var node = $('feedList').querySelector('.post[data-row="' + p.row + '"]');
      if (!node) return;
      var lk = node.querySelector('.lk'), vw = node.querySelector('.vw');
      if (lk) lk.textContent = Number(p.likes) || 0;
      if (vw) vw.textContent = Number(p.views) || 0;
    });
  }
  function onLike(e) {
    var b = e.currentTarget, row = b.dataset.row;
    var key = 'wpial_liked_' + row;
    try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (err) {}
    b.disabled = true;
    var span = b.querySelector('.lk');
    span.textContent = (Number(span.textContent) || 0) + 1;
    postWrite({ action: 'like', row: row }).catch(function () {});
  }
  function markViews(posts) {
    posts.forEach(function (p) {
      var key = 'wpial_viewed_' + p.row;
      try { if (localStorage.getItem(key)) return; localStorage.setItem(key, '1'); } catch (e) { return; }
      postWrite({ action: 'view', row: p.row }).catch(function () {});
    });
  }
  function loadFeed() {
    return get('feed').then(function (d) {
      S.posts = (d && d.posts) || [];
      renderPosts(false);
    }).catch(function () {});
  }

  /* ================================================================ tip */
  function openTip() {
    $('tipNote').textContent = READ_ONLY
      ? 'Staging — nothing will be sent. On production this publishes straight to the league feed.'
      : 'Tips publish straight to the league feed — there is no review step. Write accordingly.';
    $('tipModal').hidden = false;
    $('tipText').focus();
  }
  function closeTip() { $('tipModal').hidden = true; }
  function initTip() {
    $('tipFab').onclick = openTip;
    $('tipCancel').onclick = closeTip;
    $('tipSend').onclick = function () {
      var t = $('tipText').value.trim();
      if (!t) { closeTip(); return; }
      $('tipSend').disabled = true;
      postWrite({ action: 'tip', tip_text: t }).then(function (r) {
        $('tipSend').disabled = false;
        $('tipText').value = '';
        closeTip();
        if (r && r.staged) alert('Staging — nothing was sent. On production this publishes.');
        else if (r && r.ok) { loadFeed(); }
        else alert((r && r.error) || 'That did not go through.');
      }).catch(function () { $('tipSend').disabled = false; alert('That did not go through.'); });
    };
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && !$('tipModal').hidden) closeTip();
    });
  }

  /* ================================================================ past editions */
  function renderPast() {
    var box = $('past');
    var rest = S.leads.slice(1, 4);
    if (!rest.length) { box.innerHTML = '<div class="empty" style="color:var(--muted)">No back issues yet.</div>'; return; }
    box.innerHTML = rest.map(function (r) {
      var d = r.report_date ? new Date(/T/.test(r.report_date) ? r.report_date : r.report_date + 'T12:00:00') : null;
      return '<button class="pcard"><div class="pthumb">' +
        '<div class="pn">The Rocky Mountain Valley Dispatch</div>' +
        '<div class="ph">' + esc(r.title || 'Untitled') + '</div></div>' +
        '<div class="pf"><b>' + esc(r.title || 'Untitled') + '</b>' +
        '<span>' + (d && !isNaN(d.getTime()) ? esc(d.toLocaleDateString()) : '') +
        (r.edition ? ' · ' + esc(r.edition) : '') + '</span></div></button>';
    }).join('');
  }

  /* ================================================================ boot */
  function paint() {
    computeStandings();
    setDateline(S.leads[0]);
    renderLead();
    renderStandings();
    renderWorm();
    renderNumbers();
    renderAroundLeague();
    renderColumn();
    renderLine();
    renderWire();
    renderPast();
    placeKitPlate();
    rescale();
  }

  function boot() {
    measureBars();
    loadNameplate();
    buildPager();
    initRail();
    initTip();

    /* Five reads, ≤4 concurrent per waJSON's own contract — under the stampede
       ceiling documented at index.html:1579. matchup_detail is fetched only after
       the schedule tells us which week actually has a box score in it. */
    Promise.all([
      soft('espn_schedule', { ok: false }),
      soft('bench_points', { ok: false, teams: {} }),
      soft('insider_reports', { ok: false, reports: [] }),
      soft('gelly_picks', null),
      soft('transactions', { ok: false, reason: 'espn-unavailable' }),
      /* Only Worm Watch needs this, and only before Week 1 — but it has to be in the
         same batch or the front page paints a wrong basement first and corrects
         itself in front of the reader. */
      soft('h2h_log', null)
    ]).then(function (r) {
      S.schedule = r[0]; S.bench = r[1];
      S.reportsOk = !!(r[2] && r[2].ok);
      S.h2h = r[5] && r[5].ok ? r[5] : null;
      S.reports = (r[2] && r[2].reports) || [];
      var split = splitReports(S.reports);
      S.leads = split.leads; S.columns = split.columns;
      S.line = r[3]; S.wire = r[4];
      computeStandings();
      paint();
      if (S.playedWeek) {
        return soft('matchup_detail&week=' + S.playedWeek, null).then(function (wk) {
          if (wk && wk.ok) { S.weeks[S.playedWeek] = wk; renderNumbers(); renderAroundLeague(); rescale(); }
        });
      }
      /* Pre-season. There are no box scores, so pages 2 and 3 would be four empty
         states and ten identical "yet to play a snap" lines — for the whole month
         between now and the draft, which is exactly when people are reading.
         These two feeds already exist and nothing was asking for them: `rankings`
         carries ESPN projections, ADP and a rookie flag, and `keepers` is who is
         being kept. Fetched only in the pre-season, so the in-season page does not
         pay for them. */
      /* keepers_v2, NOT keepers. The flat `keepers` sheet is a mirror kept in step by
         waMirrorToLegacy_, and it is a list of names with no rounds and no per-team
         timestamp — so a club that declared nothing and a club that has not declared
         at all are the same row count: zero. That distinction IS the August story.
         v2 carries {name, round} per player, `updated_at` per team, and the lock. */
      return Promise.all([
        soft('rankings', null),
        soft('keepers_v2', null)
      ]).then(function (pre) {
        S.rankings = (pre[0] && pre[0].ok) ? pre[0] : null;
        S.keepers = (pre[1] && pre[1].ok) ? pre[1] : null;
        renderNumbers(); renderAroundLeague(); rescale();
      });
    }).then(function () {
      placeKitPlate();
      rescale();
    });

    loadFeed();
    setInterval(loadFeed, FEED_POLL);

    var t;
    window.addEventListener('resize', function () {
      clearTimeout(t);
      t = setTimeout(function () { measureBars(); rescale(); }, 120);
    });
    document.addEventListener('wpial-profiles', function () { paint(); });
    /* env.js draws its banner on DOMContentLoaded and never says how tall it is —
       and it is not a constant, it wraps to three lines at 360px. */
    setTimeout(measureBars, 0);
    setTimeout(function () { measureBars(); rescale(); }, 400);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();

  window.__PRESS = { state: S, paint: paint, rescale: rescale, md: md, safeUrl: safeUrl };
})();
