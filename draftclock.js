/* ============================================================================
 * draftclock.js — draft-night pick clock with watchlist auto-pick
 * ----------------------------------------------------------------------------
 * When the clock hits zero the board makes the pick itself:
 *   1. the highest name on that team's watchlist that is still on the board
 *   2. failing that, the top of Best Available (ESPN half-PPR order)
 * then it advances to the next team and restarts the clock. No confirmation —
 * that's the point, it keeps a stalled room moving.
 *
 * COMMISSIONER ONLY, LIVE MODE ONLY, and that is a correctness constraint, not
 * a permission one. LIVE draft state lives in localStorage, so every owner's
 * board is their own private copy. A clock running on nine other machines would
 * auto-pick into nine boards that nobody is looking at. The commissioner's
 * browser is the board, so the clock lives there.
 *
 * Wiring: one <script> tag in draftboard.html. Everything else is injected.
 *
 * Uses the draftboard's own top-level bindings by bare name (`SLOTS`, `cursor`,
 * `picks`, `mode`, `POOL`) plus its global functions (`commitPick`,
 * `available`, `render`, `norm`, `isKept`).
 * ==========================================================================*/
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var KEY = 'wpial_clock_v1';
  var TICK = 250;

  var S = { running: false, deadline: 0, left: 120000, dur: 120000, auto: true, sound: true };
  var forOverall = -1;      // which pick the current clock belongs to
  var watch = {};           // team -> {players:[...]}
  var watchAt = null;       // when we last pulled them
  var log = [];             // recent auto-picks, newest first
  var timer = null;
  var beeped = {};
  var audio = null;

  function h(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function nm(s) {
    try { return norm(s); } catch (e) {
      return String(s || '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
    }
  }
  function token() {
    try { return (window.WPIAL_AUTH && WPIAL_AUTH.token && WPIAL_AUTH.token()) || ''; } catch (e) { return ''; }
  }
  function isCommish() {
    var u = window.WPIAL_USER || null;
    return !!(u && (u.is_commish === true || String(u.is_commish).toLowerCase() === 'true'));
  }
  function liveMode() { try { return mode === 'live'; } catch (e) { return false; } }

  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(S)); } catch (e) {}
  }
  function restore() {
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && typeof v === 'object') {
        S.dur = v.dur || S.dur;
        S.auto = v.auto !== false;
        S.sound = v.sound !== false;
        // A running clock survives a refresh; a deadline in the past does not
        // fire retroactively, it just shows 0:00 and waits for the commish.
        if (v.running && v.deadline) { S.running = true; S.deadline = v.deadline; }
        else { S.left = v.left != null ? v.left : S.dur; }
      }
    } catch (e) {}
  }

  function msLeft() {
    return S.running ? Math.max(0, S.deadline - Date.now()) : Math.max(0, S.left);
  }
  function fmt(ms) {
    var t = Math.ceil(ms / 1000);
    return Math.floor(t / 60) + ':' + String(t % 60).padStart(2, '0');
  }

  function beep(freq, ms) {
    if (!S.sound) return;
    try {
      audio = audio || new (window.AudioContext || window.webkitAudioContext)();
      var o = audio.createOscillator(), g = audio.createGain();
      o.frequency.value = freq; o.type = 'sine';
      g.gain.setValueAtTime(0.16, audio.currentTime);
      g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + ms / 1000);
      o.connect(g); g.connect(audio.destination);
      o.start(); o.stop(audio.currentTime + ms / 1000);
    } catch (e) {}
  }

  /* ---------- who's on the clock ---------------------------------------- */
  function currentSlot() {
    try { return cursor < SLOTS.length ? SLOTS[cursor] : null; } catch (e) { return null; }
  }

  /* ---------- the pick -------------------------------------------------- */
  function poolFor(entry) {
    var byId = null, n = nm(entry.n);
    try {
      if (entry.id) byId = POOL.find(function (p) { return String(p.id) === String(entry.id); });
      // Fall back to the name: ids can drift when the rankings feed refreshes,
      // the name is what the owner actually chose.
      return byId || POOL.find(function (p) { return nm(p.n) === n; }) || null;
    } catch (e) { return null; }
  }
  function stillOnBoard(p) {
    if (!p) return false;
    try {
      for (var k in picks) { if (nm(picks[k].name) === nm(p.n)) return false; }
      if (isKept(p.n)) return false;
    } catch (e) {}
    return true;
  }

  /**
   * Returns {player, via} — via is 'watchlist' or 'board'. Deliberately applies
   * no roster logic: the watchlist is an explicit instruction and Best Available
   * is the stated fallback rule.
   */
  function choose(team) {
    var wl = (watch[team] && watch[team].players) || [];
    for (var i = 0; i < wl.length; i++) {
      var p = poolFor(wl[i]);
      if (p && stillOnBoard(p)) return { player: p, via: 'watchlist', rank: i + 1 };
    }
    var open = [];
    try { open = available('ALL'); } catch (e) {}
    return open.length ? { player: open[0], via: 'board' } : null;
  }

  function fire() {
    var slot = currentSlot();
    if (!slot) { stop(); return; }
    var pickInfo = choose(slot.team);
    if (!pickInfo) { stop(); return; }

    try { commitPick(pickInfo.player); } catch (e) { stop(); return; }

    log.unshift({
      team: slot.team,
      label: slot.round + '.' + String(slot.pickInRound).padStart(2, '0'),
      name: pickInfo.player.n,
      pos: pickInfo.player.p,
      via: pickInfo.via,
      rank: pickInfo.rank || null
    });
    log = log.slice(0, 6);
    beep(760, 260);
    resetClock(true);
    paint();
  }

  /* ---------- clock control --------------------------------------------- */
  function resetClock(keepRunning) {
    var slot = currentSlot();
    forOverall = slot ? slot.overall : -1;
    beeped = {};
    S.left = S.dur;
    if (keepRunning && S.running && slot) S.deadline = Date.now() + S.dur;
    else if (!slot) { S.running = false; }
    save();
  }
  function start() {
    if (!currentSlot()) return;
    S.running = true;
    S.deadline = Date.now() + Math.max(1000, S.left || S.dur);
    // Owners keep editing their lists during the draft, so never start a clock
    // on a stale copy.
    loadWatchlists();
    save(); paint();
  }
  function pause() {
    if (!S.running) return;
    S.left = msLeft();
    S.running = false;
    save(); paint();
  }
  function stop() {
    S.running = false; S.left = S.dur; save(); paint();
  }
  function bump(ms) {
    if (S.running) S.deadline += ms; else S.left = Math.max(0, S.left + ms);
    save(); paint();
  }

  function tick() {
    if (!liveMode()) { paint(); return; }
    var slot = currentSlot();

    // A pick made by hand moves the cursor; the clock belongs to whoever is on
    // it now, so give the next team a full allotment.
    if (slot && slot.overall !== forOverall) resetClock(true);
    if (!slot && forOverall !== -1) { forOverall = -1; stop(); }

    if (S.running && slot) {
      var ms = msLeft();
      var secs = Math.ceil(ms / 1000);
      if (S.sound && !beeped[secs] && (secs === 30 || secs === 10 || secs === 5)) {
        beeped[secs] = true; beep(secs === 5 ? 620 : 480, 130);
      }
      if (ms <= 0) {
        if (S.auto) { fire(); return; }
        S.running = false; S.left = 0; save(); beep(340, 500);
      }
    }
    paint();
  }

  /* ---------- watchlists ------------------------------------------------- */
  function loadWatchlists() {
    var tok = token();
    if (!tok || !isCommish()) return Promise.resolve();
    var b = new URLSearchParams();
    b.append('action', 'watchlist_all'); b.append('token', tok);
    return fetch(API, { method: 'POST', body: b })
      .then(function (r) { return r.json(); })
      .then(function (r) {
        if (r && r.ok) { watch = r.teams || {}; watchAt = new Date(); }
        paint();
      })
      .catch(function () { paint(); });
  }

  /* ---------- UI --------------------------------------------------------- */
  function injectCss() {
    if (document.getElementById('dcCss')) return;
    var s = document.createElement('style');
    s.id = 'dcCss';
    s.textContent = [
      '#dcBar{width:100%;display:flex;gap:12px;align-items:center;flex-wrap:wrap;',
      '  padding:7px 0 2px;margin-top:6px;border-top:1px solid var(--line);}',
      '#dcBar .dcclock{font-family:"Oswald";font-size:30px;line-height:1;letter-spacing:1px;',
      '  min-width:92px;color:var(--accent2);font-variant-numeric:tabular-nums;}',
      '#dcBar .dcclock.warn{color:var(--accent);}',
      '#dcBar .dcclock.crit{color:var(--danger);}',
      '#dcBar .dcwho{display:flex;flex-direction:column;line-height:1.25;}',
      '#dcBar .dcwho b{font-family:"Oswald";font-size:14px;letter-spacing:.6px;text-transform:uppercase;}',
      '#dcBar .dcwho span{font-size:10.5px;color:var(--muted);}',
      '#dcBar .dcbtns{display:flex;gap:5px;align-items:center;flex-wrap:wrap;}',
      '#dcBar .dcbtns button{font-size:12px;padding:4px 10px;}',
      '#dcBar select{font-size:12px;padding:4px 6px;}',
      '#dcBar .dctog{display:inline-flex;align-items:center;gap:4px;font-size:11px;color:var(--muted);',
      '  border:1px solid var(--line);border-radius:14px;padding:3px 9px;cursor:pointer;user-select:none;}',
      '#dcBar .dctog.on{border-color:var(--accent);color:var(--accent);}',
      '#dcBar .dcmeta{margin-left:auto;font-size:10.5px;color:var(--muted);text-align:right;line-height:1.5;}',
      '#dcLog{width:100%;display:flex;gap:6px;flex-wrap:wrap;padding-bottom:4px;}',
      '#dcLog .lg{font-size:10.5px;color:var(--muted);border:1px solid var(--line);',
      '  border-radius:12px;padding:2px 9px;white-space:nowrap;}',
      '#dcLog .lg b{color:var(--text);font-weight:600;}',
      '#dcLog .lg.wl{border-color:var(--accent);}',
      '#dcMore{display:none;}',
      /* The header is already tall and sticky on a phone. Collapse everything
         except clock / team / start-stop behind ⋯ so the board still gets most
         of the screen; expanded state is remembered per device. */
      '@media (max-width:760px){',
      '  #dcBar{gap:8px;}',
      '  #dcBar .dcclock{font-size:24px;min-width:64px;}',
      '  #dcBar .dcwho b{font-size:12px;}',
      '  #dcBar .dcmeta{margin-left:0;text-align:left;width:100%;}',
      '  #dcMore{display:inline-flex;margin-left:auto;}',
      '  #dcBar.slim .dcextra,#dcBar.slim .dcmeta,#dcBar.slim #dcLog{display:none;}',
      '  #dcBar.slim .dcbtns{gap:4px;}',
      '  #dcBar .dcbtns button{padding:4px 8px;}',
      '}'
    ].join('');
    document.head.appendChild(s);
  }

  function build() {
    if (document.getElementById('dcBar')) return;
    var header = document.querySelector('header');
    if (!header) return;
    injectCss();

    var bar = document.createElement('div');
    bar.id = 'dcBar';
    bar.innerHTML =
      '<div class="dcclock" id="dcClock">2:00</div>' +
      '<div class="dcwho"><b id="dcTeam">—</b><span id="dcPick"></span></div>' +
      '<div class="dcbtns">' +
        '<button id="dcStart" class="primary">▶ Start</button>' +
        '<button id="dcPause">❚❚ Pause</button>' +
        '<button id="dcReset" class="dcextra">↻ Reset</button>' +
        '<button id="dcPlus" class="dcextra">+30s</button>' +
        '<select id="dcDur" class="dcextra" title="Time per pick">' +
          '<option value="60000">1:00</option>' +
          '<option value="90000">1:30</option>' +
          '<option value="120000" selected>2:00</option>' +
          '<option value="180000">3:00</option>' +
        '</select>' +
        '<span class="dctog dcextra" id="dcAuto" title="When the clock hits zero, make the pick automatically">⚡ Auto-pick</span>' +
        '<span class="dctog dcextra" id="dcSound" title="Warning beeps at 0:30, 0:10, 0:05">🔊</span>' +
      '</div>' +
      '<span class="dctog" id="dcMore" title="Show the rest of the clock controls">⋯</span>' +
      '<div class="dcmeta" id="dcMeta"></div>' +
      '<div id="dcLog"></div>';

    // Above the site nav strip, so the clock is the first thing in the sticky
    // header rather than the last.
    var nav = document.getElementById('siteNav');
    if (nav) header.insertBefore(bar, nav); else header.appendChild(bar);

    bar.querySelector('#dcStart').onclick = start;
    bar.querySelector('#dcPause').onclick = pause;
    bar.querySelector('#dcReset').onclick = function () { S.left = S.dur; if (S.running) S.deadline = Date.now() + S.dur; beeped = {}; save(); paint(); };
    bar.querySelector('#dcPlus').onclick = function () { bump(30000); };
    bar.querySelector('#dcDur').onchange = function () {
      S.dur = +this.value;
      if (!S.running) S.left = S.dur;
      save(); paint();
    };
    bar.querySelector('#dcAuto').onclick = function () { S.auto = !S.auto; save(); paint(); };
    bar.querySelector('#dcSound').onclick = function () { S.sound = !S.sound; save(); if (S.sound) beep(660, 90); paint(); };
    bar.querySelector('#dcMeta').addEventListener('click', function (e) {
      if (e.target.id === 'dcRefresh') { e.preventDefault(); loadWatchlists(); }
    });

    var slim = true;
    try { slim = localStorage.getItem('wpial_clock_slim') !== '0'; } catch (e) {}
    bar.classList.toggle('slim', slim);
    bar.querySelector('#dcMore').onclick = function () {
      var now = !bar.classList.contains('slim');
      bar.classList.toggle('slim', now);
      try { localStorage.setItem('wpial_clock_slim', now ? '1' : '0'); } catch (e) {}
      this.textContent = now ? '⋯' : '×';
    };
  }

  function paint() {
    var bar = document.getElementById('dcBar');
    if (!bar) return;
    var show = liveMode() && isCommish();
    bar.style.display = show ? '' : 'none';
    if (!show) return;

    var ms = msLeft();
    var el = bar.querySelector('#dcClock');
    el.textContent = fmt(ms);
    el.className = 'dcclock' + (ms <= 10000 ? ' crit' : (ms <= 30000 ? ' warn' : ''));

    var slot = currentSlot();
    bar.querySelector('#dcTeam').textContent = slot ? slot.team : 'Draft complete';
    bar.querySelector('#dcPick').textContent = slot
      ? ('Pick ' + slot.round + '.' + String(slot.pickInRound).padStart(2, '0') +
         (S.running ? '' : ' · clock stopped'))
      : '';

    bar.querySelector('#dcStart').style.display = S.running ? 'none' : '';
    bar.querySelector('#dcPause').style.display = S.running ? '' : 'none';
    bar.querySelector('#dcDur').value = String(S.dur);
    bar.querySelector('#dcAuto').className = 'dctog' + (S.auto ? ' on' : '');
    bar.querySelector('#dcAuto').textContent = S.auto ? '⚡ Auto-pick ON' : '⚡ Auto-pick OFF';
    bar.querySelector('#dcSound').className = 'dctog' + (S.sound ? ' on' : '');
    bar.querySelector('#dcSound').textContent = S.sound ? '🔊' : '🔇';

    var teams = Object.keys(watch).filter(function (t) {
      return watch[t] && watch[t].count > 0;
    }).length;
    var next = slot ? ((watch[slot.team] && watch[slot.team].count) || 0) : 0;
    bar.querySelector('#dcMeta').innerHTML =
      'Watchlists loaded: <b>' + teams + '</b> of ' + (function () {
        try { return TEAMS.length; } catch (e) { return 10; }
      })() + ' · on the clock has <b>' + next + '</b>' +
      ' <a href="#" id="dcRefresh" style="color:var(--accent2);">refresh</a>' +
      (watchAt ? '<br>as of ' + watchAt.toLocaleTimeString() : '');

    // The log is a width:100% flex item, so even when empty it forces a line
    // break and reserves a dead band across the header. The draftboard sizes
    // its panes off header height, so that band costs real screen.
    var logEl = document.getElementById('dcLog');
    logEl.style.display = log.length ? '' : 'none';
    logEl.innerHTML = log.map(function (l) {
      return '<span class="lg' + (l.via === 'watchlist' ? ' wl' : '') + '">⏱ ' + h(l.label) + ' ' +
        h(l.team) + ' → <b>' + h(l.name) + '</b> ' + h(l.pos) + ' · ' +
        (l.via === 'watchlist' ? 'watchlist #' + l.rank : 'best available') + '</span>';
    }).join('');
  }

  /* ---------- boot ------------------------------------------------------- */
  function init() {
    restore();
    build();
    resetClock(false);
    // If a running clock was restored from before a refresh, keep its deadline.
    try {
      var v = JSON.parse(localStorage.getItem(KEY) || 'null');
      if (v && v.running && v.deadline) { S.running = true; S.deadline = v.deadline; }
    } catch (e) {}
    paint();
    clearInterval(timer);
    timer = setInterval(tick, TICK);
    if (isCommish()) loadWatchlists();
    // An owner can add a name thirty seconds before their pick. Re-pull in the
    // background so an auto-pick never fires off a list that's minutes old.
    // Cheap: one small request a minute, and only while the board is in use.
    setInterval(function () {
      if (liveMode() && isCommish() && currentSlot()) loadWatchlists();
    }, 60000);
    document.addEventListener('wpial-auth', function () { paint(); loadWatchlists(); });
    document.addEventListener('wpial-auth-refresh', function () { paint(); });
    // Mode toggle lives in the page's own header buttons; repaint after a click
    // so the bar hides/shows with LIVE/MOCK.
    ['#modeLive', '#modeMock'].forEach(function (sel) {
      var b = document.querySelector(sel);
      if (b) b.addEventListener('click', function () { setTimeout(function () { resetClock(false); paint(); }, 30); });
    });
  }

  window.WPIAL_CLOCK = {
    state: function () { return JSON.parse(JSON.stringify(S)); },
    watchlists: function () { return watch; },
    reload: loadWatchlists,
    fire: fire,
    log: function () { return log.slice(); }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
