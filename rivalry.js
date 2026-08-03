/**
 * rivalry.js — the Series panel for matchup.html (H2H phase 2).
 *
 * Implements the "Rivalry / Series panel" design handoff. The panel is ADDITIVE: nothing
 * in it is load-bearing, it carries its own catch, and a missing or broken feed can never
 * take the header, the odds or the box score down with it.
 *
 * WHAT IT READS, IN ORDER OF PREFERENCE
 *   1. ?action=h2h_log  — the per-meeting game log (contract in the infra doc). Everything
 *      on screen is client-side arithmetic over `meetings[]`: headline, streak, series
 *      shape, extremes, playoff split, averages. One reduce each. No server fields added.
 *   2. ?action=h2h      — the hand-maintained aggregate. The documented fallback for
 *      "h2h_log does not answer", which today is ALWAYS: h2hlog.gs is not built.
 *   3. ?action=history  — the career resumes. Live today.
 *
 * ABOUT THE FALLBACK, AND WHY IT SAYS SO ON SCREEN
 * The infrastructure doc proves the two hand-maintained history feeds contradict each other
 * (D = S - 2A = -23, arithmetically impossible) and that the aggregate series line is wrong
 * for at least nine of ten franchises. This design makes the tally the biggest number on
 * the page — the object people screenshot into the group text. Rendering a known-bad number
 * at 54px in silence is worse than rendering it small. So in fallback mode the panel shows
 * the number AND names its provenance in one line. When the log lands, that line goes away
 * on its own, because the derived tally does not need the caveat.
 *
 * Public surface:
 *   WPIAL_SERIES.skeleton(mount)                 loading state
 *   WPIAL_SERIES.render(mount, opts)             opts: {fidA,fidB,nameA,nameB,log,h2h,history,onRetry}
 */
(function () {
  'use strict';

  var R = window.WPIAL_ROW || {};
  function esc(s) {
    return (R.esc ? R.esc(s) : String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;'));
  }
  function n1(v) { return isFinite(Number(v)) ? Number(v).toFixed(1) : '—'; }
  function nm(x) { return (window.WPIAL_FX && window.WPIAL_FX.name(x)) || String(x || ''); }
  /* Short label for the tight spaces — the log line and the streak chip. An owner reads
     "Mustard", not "Bijan Mustard", in a sentence about who won. */
  function shortName(x) {
    var full = String(nm(x) || '').trim();
    var parts = full.split(/\s+/);
    return parts.length > 1 ? parts[parts.length - 1] : full;
  }
  function pairKey(a, b) { return [a, b].sort().join('|'); }

  /* ---------- arithmetic over meetings[] (all of it, in one pass each) ---------- */

  /* meetings[] arrive newest-first and are oriented to the SORTED pair (fid_a < fid_b),
     which is not necessarily the orientation this page is displaying. Re-orient once,
     here, so nothing downstream has to think about it again. */
  function orient(meetings, fidA, fidB) {
    var lowFirst = pairKey(fidA, fidB).split('|')[0] === fidA;
    return (meetings || []).map(function (m) {
      return {
        season: m.season, week: m.week, playoff: !!m.playoff,
        a: Number(lowFirst ? m.a : m.b),
        b: Number(lowFirst ? m.b : m.a),
        winner: m.winner || null
      };
    });
  }

  function tally(ms, fidA, fidB) {
    var w = { a: 0, b: 0, t: 0 };
    ms.forEach(function (m) {
      if (m.winner === fidA) w.a++;
      else if (m.winner === fidB) w.b++;
      else if (m.winner) { /* a fid that is neither side: not this rivalry, skip */ }
      else if (m.a === m.b) w.t++;
      else if (m.a > m.b) w.a++;
      else w.b++;
    });
    return w;
  }

  /* Current streak, from the newest end. */
  function streak(ms, fidA, fidB) {
    if (!ms.length) return null;
    var winnerOf = function (m) {
      if (m.winner === fidA) return fidA;
      if (m.winner === fidB) return fidB;
      if (m.a === m.b) return null;
      return m.a > m.b ? fidA : fidB;
    };
    var first = winnerOf(ms[0]);
    if (!first) return null;
    var n = 0;
    for (var i = 0; i < ms.length; i++) { if (winnerOf(ms[i]) === first) n++; else break; }
    return { fid: first, n: n };
  }

  function extremes(ms) {
    if (!ms.length) return null;
    var blow = null, close = null, high = null;
    ms.forEach(function (m) {
      var margin = Math.abs(m.a - m.b), combined = m.a + m.b;
      if (!blow || margin > Math.abs(blow.a - blow.b)) blow = m;
      if (!close || margin < Math.abs(close.a - close.b)) close = m;
      if (!high || combined > (high.a + high.b)) high = m;
    });
    return { blowout: blow, closest: close, highest: high };
  }

  function derived(ms, fidA, fidB) {
    var po = ms.filter(function (m) { return m.playoff; });
    var margins = 0, combined = 0;
    ms.forEach(function (m) { margins += Math.abs(m.a - m.b); combined += m.a + m.b; });
    return {
      playoffs: po.length,
      playoffTally: tally(po, fidA, fidB),
      avgMargin: ms.length ? margins / ms.length : null,
      avgCombined: ms.length ? combined / ms.length : null
    };
  }

  /* ---------- pieces ---------- */

  function headline(w, fidA, fidB, big) {
    var lead = w.a === w.b ? null : (w.a > w.b ? fidA : fidB);
    var hi = Math.max(w.a, w.b), lo = Math.min(w.a, w.b);
    var eyebrow = lead ? (nm(lead) + ' LEAD') : 'SERIES TIED';
    var tie = w.t ? '–' + w.t : '';
    return '<div class="sr-head' + (big ? '' : ' sm') + '">' +
             '<div class="sr-eyebrow">' + esc(eyebrow) + '</div>' +
             '<div class="sr-tally">' + esc(hi + '–' + lo + tie) + '</div>' +
           '</div>';
  }

  function streakChip(st) {
    if (!st || st.n < 1) return '';
    /* Letter + count + sentence. The green outline is the third channel, never the only
       one — the design handoff is explicit that it must be redundant. */
    return '<div class="sr-streak"><b>W' + st.n + '</b>' +
           '<span>' + esc(shortName(st.fid)) + ' has won the last ' + st.n + '</span></div>';
  }

  /* Oldest -> newest. Filled = team A win, outline = team B win, a small P under playoff
     meetings. Fill vs outline, not color, is what separates them, so this survives
     greyscale and a colorblind reader. */
  function shape(ms, fidA, fidB) {
    if (!ms.length) return '';
    var old = ms.slice().reverse();
    var marks = old.map(function (m) {
      var aWon = m.winner ? m.winner === fidA : m.a > m.b;
      var tied = !m.winner && m.a === m.b;
      var cls = tied ? 'tie' : (aWon ? 'fill' : 'out');
      var lbl = m.season + ' week ' + m.week + ' — ' +
        (tied ? 'tied' : shortName(aWon ? fidA : fidB) + ' won') + (m.playoff ? ', playoff' : '');
      return '<span class="sr-mark ' + cls + '" title="' + esc(lbl) + '" aria-label="' + esc(lbl) + '">' +
             (m.playoff ? '<i>P</i>' : '') + '</span>';
    }).join('');
    return '<div class="sr-shape-wrap">' +
             '<div class="sr-shape" role="img" aria-label="Series result by meeting, oldest to newest">' + marks + '</div>' +
             '<div class="sr-legend"><span class="sr-mark fill"></span> ' + esc(nm(fidA)) +
               ' &nbsp;<span class="sr-mark out"></span> ' + esc(nm(fidB)) +
               ' &nbsp;<i>P</i> playoff</div>' +
           '</div>';
  }

  function extremeCards(ex, fidA, fidB) {
    if (!ex) return '';
    var card = function (label, m, valueText) {
      var aWon = m.winner ? m.winner === fidA : m.a > m.b;
      var who = m.a === m.b && !m.winner ? 'tied' : shortName(aWon ? fidA : fidB);
      return '<div class="sr-ex">' +
               '<div class="sr-ex-lab">' + esc(label) + '</div>' +
               '<div class="sr-ex-val">' + esc(valueText) + '</div>' +
               '<div class="sr-ex-att">' + esc(who) + ' · ' + m.season + ' wk ' + m.week + '</div>' +
             '</div>';
    };
    return '<div class="sr-ex-row">' +
      card('Biggest blowout', ex.blowout, n1(Math.abs(ex.blowout.a - ex.blowout.b)) + ' pts') +
      card('Closest game', ex.closest, n1(Math.abs(ex.closest.a - ex.closest.b)) + ' pts') +
      card('Highest combined', ex.highest, n1(ex.highest.a + ex.highest.b)) +
    '</div>';
  }

  function logLines(ms, fidA, fidB, limit) {
    return ms.slice(0, limit).map(function (m) {
      var aWon = m.winner ? m.winner === fidA : m.a > m.b;
      var tied = !m.winner && m.a === m.b;
      var margin = Math.abs(m.a - m.b);
      var verdict = tied ? 'tied' : ('✓ ' + shortName(aWon ? fidA : fidB) + ' by ' + n1(margin));
      return '<div class="sr-log-row">' +
               '<span class="sr-when">' + m.season + ' · WK ' + m.week +
                 (m.playoff ? '<span class="sr-po">PLAYOFF</span>' : '') + '</span>' +
               '<span class="sr-score">' + n1(m.a) + ' – ' + n1(m.b) + '</span>' +
               '<span class="sr-verdict">' + esc(verdict) + '</span>' +
             '</div>';
    }).join('');
  }

  /* Resume for one franchise, out of ?action=history. Numbers are whatever the feed has;
     anything missing renders as an em-dash rather than a zero. */
  function resume(rec, fid) {
    var colors = (window.WPIAL_FX && window.WPIAL_FX.colors(fid)) || {};
    var rule = colors.primary || 'var(--line)';
    if (!rec) {
      return '<div class="sr-res"><div class="sr-res-nm">' + esc(nm(fid)) +
             '<span class="sr-rule" style="background:' + esc(rule) + '"></span></div>' +
             '<div class="sr-res-none">Career record unavailable.</div></div>';
    }
    var seasons = rec.seasons != null ? rec.seasons : (rec.seasonCount != null ? rec.seasonCount : null);
    var titles = rec.championships || 0;
    var years = rec.championshipYears || rec.titleYears || null;
    var yearTxt = (years && years.length) ? ' (' + years.join(', ') + ')' : '';
    var pick = rec.bestPick
      ? rec.bestPick.player + ' — Rd ' + rec.bestPick.round + ", '" + String(rec.bestPick.year).slice(-2)
      : '—';
    var row = function (k, v) {
      return '<div class="sr-res-row"><span>' + esc(k) + '</span><b>' + esc(v) + '</b></div>';
    };
    return '<div class="sr-res">' +
             '<div class="sr-res-nm">' + esc(nm(fid)) +
               '<span class="sr-rule" style="background:' + esc(rule) + '"></span></div>' +
             row('All-time', rec.wins + '-' + rec.losses + (rec.ties ? '-' + rec.ties : '') +
                 (seasons != null ? ' · ' + seasons + ' seasons' : '')) +
             row('Titles', String(titles) + yearTxt) +
             row('Avg finish', rec.avgFinish != null ? Number(rec.avgFinish).toFixed(1) : '—') +
             row('Best pick', pick) +
           '</div>';
  }

  function findHistory(history, fid) {
    if (!history || !history.franchises) return null;
    var out = null;
    history.franchises.forEach(function (f) {
      var key = (window.WPIAL_FX && window.WPIAL_FX.resolve(String(f.name || '').trim())) || null;
      if (key && key === fid) out = f;
    });
    return out;
  }

  /* ---------- states ---------- */

  function shell(inner, opts, noRule) {
    return '<section class="sr' + (noRule ? ' sr-norule' : '') + '" aria-labelledby="sr-t">' + inner + '</section>';
  }

  function header(meta) {
    return '<div class="sr-top">' +
             '<span class="sr-title" id="sr-t">THE SERIES</span>' +
             '<span class="sr-meta">' + meta + '</span>' +
           '</div>';
  }

  function skeleton(mount) {
    if (!mount) return;
    mount.innerHTML = shell(header('<span class="sr-sk sr-sk-s"></span>') +
      '<div class="sr-sk sr-sk-xl"></div><div class="sr-sk sr-sk-m"></div>' +
      '<div class="sr-sk sr-sk-l"></div><div class="sr-sk sr-sk-l"></div>');
  }

  function down(mount, onRetry) {
    /* Gold rule dropped, no red, nothing else on the page moves. */
    mount.innerHTML = shell(
      '<div class="sr-quiet">' +
        '<div>The series history isn\'t loading right now.</div>' +
        '<div>Everything above is live.</div>' +
        '<button type="button" class="sr-retry">Try again</button>' +
      '</div>', null, true);
    var b = mount.querySelector('.sr-retry');
    if (b && onRetry) b.addEventListener('click', onRetry);
  }

  function neverMet(mount, fidA, fidB, history) {
    mount.innerHTML = shell(
      header('<span>FIRST MEETING</span>') +
      '<div class="sr-first">' +
        '<div class="sr-first-1">First meeting — history starts here.</div>' +
        '<div class="sr-first-2">' + esc(nm(fidA)) + ' and ' + esc(nm(fidB)) +
          ' have never played each other.</div>' +
      '</div>' +
      '<div class="sr-res-row-wrap">' + resume(findHistory(history, fidA), fidA) +
        resume(findHistory(history, fidB), fidB) + '</div>');
  }

  /* ---------- main render ---------- */

  function render(mount, opts) {
    if (!mount) return;
    opts = opts || {};
    var fidA = opts.fidA, fidB = opts.fidB;
    if (!fidA || !fidB) { mount.innerHTML = ''; return; }

    var log = opts.log, h2h = opts.h2h, history = opts.history;
    var logFailed = log && log.ok === false;
    var pair = (log && log.ok && log.pairs) ? log.pairs[pairKey(fidA, fidB)] : null;
    var meetings = pair ? orient(pair.meetings || [], fidA, fidB) : null;

    /* Both feeds gone is the only true "feed down". A missing log with a working aggregate
       is a DIFFERENT claim and gets its own render — collapsing them is how a page tells an
       owner two teams have never met when the backfill simply was never run. */
    if ((!meetings || !meetings.length) && !h2hRecord(h2h, fidA, fidB)) {
      if (logFailed || (h2h && h2h.ok === false)) return down(mount, opts.onRetry);
      if (log && log.ok) return neverMet(mount, fidA, fidB, history);
      return down(mount, opts.onRetry);
    }

    if (meetings && meetings.length) return renderFull(mount, opts, pair, meetings);
    return renderAggregate(mount, opts);
  }

  function h2hRecord(h2h, fidA, fidB) {
    if (!h2h || !h2h.ok || !h2h.matchups) return null;
    var found = null;
    h2h.matchups.forEach(function (m) {
      var ra = window.WPIAL_FX ? window.WPIAL_FX.resolve(m.teamA) : null;
      var rb = window.WPIAL_FX ? window.WPIAL_FX.resolve(m.teamB) : null;
      if (!ra || !rb) return;
      if (pairKey(ra, rb) === pairKey(fidA, fidB)) {
        var flip = ra !== fidA;
        found = {
          a: flip ? m.winsB : m.winsA,
          b: flip ? m.winsA : m.winsB,
          t: m.ties || 0
        };
      }
    });
    return found;
  }

  /* The h2h_log is not built. Show the tally, name where it came from, keep the resumes —
     and do not draw a shape, a streak or a log out of numbers that cannot support them. */
  function renderAggregate(mount, opts) {
    var fidA = opts.fidA, fidB = opts.fidB;
    var rec = h2hRecord(opts.h2h, fidA, fidB);
    if (!rec) return neverMet(mount, fidA, fidB, opts.history);
    var total = rec.a + rec.b + rec.t;
    mount.innerHTML = shell(
      header('<span>' + total + ' meeting' + (total === 1 ? '' : 's') + '</span>') +
      headline({ a: rec.a, b: rec.b, t: rec.t }, fidA, fidB, true) +
      '<div class="sr-note">' +
        'From the league\'s hand-kept tally. The per-meeting game log — scores, streaks, ' +
        'blowouts, playoff meetings — hasn\'t been built yet, so this total can\'t be ' +
        'checked against the games it came from.' +
      '</div>' +
      '<div class="sr-res-row-wrap">' + resume(findHistory(opts.history, fidA), fidA) +
        resume(findHistory(opts.history, fidB), fidB) + '</div>');
  }

  function renderFull(mount, opts, pair, ms) {
    var fidA = opts.fidA, fidB = opts.fidB;
    var w = tally(ms, fidA, fidB);
    var st = streak(ms, fidA, fidB);
    var ex = extremes(ms);
    var d = derived(ms, fidA, fidB);
    var first = pair.firstSeason || (ms.length ? ms[ms.length - 1].season : null);
    var complete = !(opts.log && opts.log.complete === false);
    var thin = ms.length <= 3;

    var meta = (first ? 'SINCE ' + first + ' · ' : '') + ms.length + ' meetings' +
               (d.playoffs ? ' · ' + d.playoffs + ' playoff' : '');

    var partial = complete ? '' :
      '<div class="sr-info" role="note">Seasons before ' + esc(first) +
      ' couldn\'t be reached — totals cover ' + esc(first) + '–' +
      esc((opts.log && opts.log.seasons && opts.log.seasons[1]) || ms[0].season) +
      ' only, not all-time.</div>';

    /* Lean in rather than hide: three meetings is a real series, and saying so out loud is
       funnier and more honest than suppressing the panel. */
    var thinNote = thin ?
      '<div class="sr-note">Career records, from a robust sample of ' +
      (ms.length === 3 ? 'three' : String(ms.length)) + '.</div>' : '';

    var showAll = ms.length <= 5;
    var expand = ms.length <= 5 ? '' :
      '<button type="button" class="sr-more" aria-expanded="false">Show all ' + ms.length + ' meetings ▾</button>';

    var strip =
      '<div class="sr-strip">' +
        '<div><span>Playoff</span><b>' + d.playoffTally.a + '–' + d.playoffTally.b + '</b></div>' +
        '<div><span>Avg margin</span><b>' + n1(d.avgMargin) + '</b></div>' +
        '<div><span>Avg combined</span><b>' + n1(d.avgCombined) + '</b></div>' +
      '</div>';

    mount.innerHTML = shell(
      header('<span>' + esc(meta) + '</span>') +
      partial +
      '<div class="sr-grid">' +
        '<div class="sr-left">' +
          headline(w, fidA, fidB, true) +
          streakChip(st) +
          shape(ms, fidA, fidB) +
          extremeCards(ex, fidA, fidB) +
          strip +
        '</div>' +
        '<div class="sr-right">' +
          '<div class="sr-log-t">MEETINGS</div>' +
          '<div class="sr-log">' + logLines(ms, fidA, fidB, showAll ? ms.length : 5) + '</div>' +
          expand +
        '</div>' +
      '</div>' +
      thinNote +
      '<div class="sr-res-row-wrap">' + resume(findHistory(opts.history, fidA), fidA) +
        resume(findHistory(opts.history, fidB), fidB) + '</div>');

    var btn = mount.querySelector('.sr-more');
    if (btn) {
      var open = false;
      btn.addEventListener('click', function () {
        open = !open;
        mount.querySelector('.sr-log').innerHTML = logLines(ms, fidA, fidB, open ? ms.length : 5);
        btn.textContent = open ? 'Show last 5 only ▴' : ('Show all ' + ms.length + ' meetings ▾');
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
  }

  /* ---------- styles ---------- */
  var CSS = [
    '.sr{border-top:2px solid var(--accent);background:var(--panel);border-radius:0 0 12px 12px;',
      'padding:14px 14px 18px;margin-top:18px;}',
    '.sr-norule{border-top:1px solid var(--line);}',
    '.sr-top{display:flex;align-items:baseline;justify-content:space-between;gap:10px;flex-wrap:wrap;margin-bottom:12px;}',
    '.sr-title{font-family:Oswald,sans-serif;font-size:11.5px;letter-spacing:2.4px;color:var(--accent);}',
    '.sr-meta{font-size:10.5px;letter-spacing:1.2px;text-transform:uppercase;color:var(--muted);}',
    '.sr-head{text-align:center;margin:6px 0 10px;}',
    '.sr-eyebrow{font-family:Oswald,sans-serif;font-size:11px;letter-spacing:2px;color:var(--muted);}',
    '.sr-tally{font-family:Oswald,sans-serif;font-size:54px;line-height:1;font-variant-numeric:tabular-nums;}',
    '.sr-head.sm .sr-tally{font-size:34px;}',
    '.sr-streak{display:inline-flex;align-items:center;gap:8px;border:1px solid var(--ok,#57b26a);',
      'border-radius:999px;padding:4px 12px;margin:0 auto 12px;font-size:12px;}',
    '.sr-streak{display:flex;width:fit-content;}',
    '.sr-streak b{font-family:Oswald,sans-serif;letter-spacing:1px;}',
    '.sr-shape-wrap{margin:4px 0 14px;}',
    '.sr-shape{display:flex;flex-wrap:wrap;gap:6px;justify-content:center;}',
    '.sr-mark{width:14px;height:14px;border-radius:3px;border:1.5px solid var(--text);position:relative;',
      'display:inline-block;flex:0 0 14px;}',
    '.sr-mark.fill{background:var(--text);}',
    '.sr-mark.out{background:transparent;}',
    '.sr-mark.tie{background:repeating-linear-gradient(45deg,var(--text),var(--text) 2px,transparent 2px,transparent 4px);}',
    '.sr-mark i{position:absolute;left:0;right:0;top:15px;font-style:normal;font-size:8px;',
      'text-align:center;color:var(--muted);}',
    '.sr-legend{margin-top:16px;text-align:center;font-size:10.5px;color:var(--muted);}',
    '.sr-legend .sr-mark{width:9px;height:9px;flex:0 0 9px;vertical-align:middle;}',
    '.sr-legend i{font-style:normal;}',
    '.sr-ex-row{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:12px;}',
    '.sr-ex{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:8px;text-align:center;}',
    '.sr-ex-lab{font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);}',
    '.sr-ex-val{font-family:Oswald,sans-serif;font-size:19px;margin:3px 0 2px;font-variant-numeric:tabular-nums;}',
    '.sr-ex-att{font-size:10px;color:var(--muted);}',
    '.sr-strip{display:grid;grid-template-columns:repeat(3,1fr);gap:8px;margin-bottom:6px;}',
    '.sr-strip div{text-align:center;}',
    '.sr-strip span{display:block;font-size:9.5px;letter-spacing:.8px;text-transform:uppercase;color:var(--muted);}',
    '.sr-strip b{font-family:Oswald,sans-serif;font-size:16px;font-variant-numeric:tabular-nums;}',
    '.sr-log-t{font-family:Oswald,sans-serif;font-size:10.5px;letter-spacing:2px;color:var(--muted);margin:10px 0 4px;}',
    '.sr-log-row{display:flex;align-items:center;gap:8px;justify-content:space-between;flex-wrap:wrap;',
      'padding:7px 0;border-bottom:1px solid var(--line);font-size:12.5px;}',
    '.sr-log-row:last-child{border-bottom:none;}',
    '.sr-when{color:var(--muted);font-size:11px;letter-spacing:.5px;display:flex;align-items:center;gap:6px;}',
    '.sr-po{border:1px solid var(--accent);color:var(--accent);border-radius:3px;padding:1px 4px;font-size:8.5px;letter-spacing:.6px;}',
    '.sr-score{font-family:Oswald,sans-serif;font-variant-numeric:tabular-nums;}',
    '.sr-verdict{color:var(--ok,#57b26a);font-size:11.5px;}',
    '.sr-more{width:100%;margin-top:10px;padding:9px;background:var(--panel2);border:1px solid var(--line);',
      'border-radius:8px;color:var(--text);font-size:12px;}',
    '.sr-more:hover{border-color:var(--accent);}',
    '.sr-more:focus-visible{outline:2px solid var(--accent2);outline-offset:2px;}',
    '.sr-note,.sr-info{font-size:11.5px;color:var(--muted);line-height:1.5;margin:10px 0 0;',
      'padding:8px 10px;border-radius:8px;background:var(--panel2);border:1px solid var(--line);}',
    '.sr-info{border-color:var(--accent);}',
    '.sr-first{text-align:center;padding:14px 0 4px;}',
    '.sr-first-1{font-family:Oswald,sans-serif;font-size:20px;}',
    '.sr-first-2{color:var(--muted);font-size:12px;margin-top:5px;}',
    '.sr-quiet{color:var(--muted);font-size:12.5px;line-height:1.7;}',
    '.sr-retry{margin-top:8px;background:none;border:1px solid var(--line);border-radius:6px;',
      'color:var(--text);padding:5px 12px;font-size:12px;}',
    '.sr-res-row-wrap{display:grid;grid-template-columns:1fr;gap:10px;margin-top:14px;}',
    '.sr-res{background:var(--panel2);border:1px solid var(--line);border-radius:8px;padding:10px 12px;}',
    '.sr-res-nm{font-family:Oswald,sans-serif;font-size:14px;margin-bottom:8px;}',
    '.sr-rule{display:block;width:56px;height:3px;border-radius:2px;margin-top:5px;}',
    '.sr-res-row{display:flex;justify-content:space-between;gap:10px;font-size:11.5px;padding:3px 0;color:var(--muted);}',
    '.sr-res-row b{color:var(--text);font-weight:600;text-align:right;}',
    '.sr-res-none{font-size:11.5px;color:var(--muted);}',
    '.sr-sk{display:block;background:linear-gradient(90deg,var(--panel2),var(--line),var(--panel2));',
      'border-radius:6px;height:14px;margin:8px 0;animation:srsk 1.4s ease-in-out infinite;}',
    '.sr-sk-xl{height:48px;} .sr-sk-l{height:30px;} .sr-sk-m{height:20px;} .sr-sk-s{height:10px;width:120px;margin:0;}',
    '@keyframes srsk{0%,100%{opacity:.55}50%{opacity:.95}}',
    '@media (prefers-reduced-motion:reduce){.sr-sk{animation:none;}}',
    '@media (min-width:900px){',
      '.sr-grid{display:grid;grid-template-columns:1.05fr .95fr;gap:22px;align-items:start;}',
      '.sr-res-row-wrap{grid-template-columns:1fr 1fr;}',
      '.sr-log-t{margin-top:0;}',
    '}'
  ].join('');

  function injectCSS() {
    if (document.getElementById('sr-css')) return;
    var st = document.createElement('style');
    st.id = 'sr-css';
    st.textContent = CSS;
    (document.head || document.documentElement).appendChild(st);
  }
  if (document.head) injectCSS();
  else document.addEventListener('DOMContentLoaded', injectCSS);

  window.WPIAL_SERIES = {
    render: render, skeleton: skeleton, down: down,
    /* exported for the test harness — the arithmetic is the part worth asserting */
    _calc: { orient: orient, tally: tally, streak: streak, extremes: extremes, derived: derived,
             pairKey: pairKey, h2hRecord: h2hRecord }
  };
})();
