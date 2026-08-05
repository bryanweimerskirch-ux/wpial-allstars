/* ============================================================================
 * draftsync.js — the realtime draft. Firebase RTDB shared state for LIVE mode.
 * ----------------------------------------------------------------------------
 * Before this file, every owner's LIVE board was a private copy in their own
 * localStorage, synced to nothing. This file makes LIVE mode shared:
 *
 *   - a pick is a SINGLE multi-path update() writing picks/<overall> and cursor
 *     together. Firebase applies it atomically and the security rules evaluate
 *     against pre-write state, so "picks/<overall> must not already exist" IS
 *     the transaction. Ten clients racing one slot: one lands, nine get
 *     PERMISSION_DENIED. That denial is NORMAL ("he got there first"), not an
 *     error, and is rendered as such.
 *   - turn order is enforced SERVER-SIDE against /slots (160 entries written
 *     once at setup). The UI hiding the draft button proves nothing; the rules
 *     are what stop an out-of-turn pick.
 *   - the clock stores an ABSOLUTE deadline. Every client corrects local clock
 *     skew with .info/serverTimeOffset and counts down to the same epoch ms.
 *   - presence via onDisconnect(), so the room can see who is actually here.
 *
 * SCOPE RULES
 *   - LIVE mode only. MOCK mode is a simulator and is deliberately untouched.
 *   - Auto-pick stays COMMISSIONER-ONLY (draftclock.js), so there is no
 *     multi-client auto-pick race to elect a winner for. The /firing node
 *     exists in the rules for the day that changes.
 *   - This file is the ONLY place client-side that knows Firebase exists.
 *
 * IDENTITY
 *   Firebase Auth (email link) proves control of an inbox. /emailToFid — seeded
 *   once by the commissioner, read-only to every client — decides which
 *   franchise that inbox owns. Site login (auth.js) and this are separate
 *   sessions on purpose: the Apps Script token cannot write to Firebase and the
 *   Firebase session cannot call keeper_save.
 *
 * WIRING (draftboard.html, in order, all classic script tags):
 *   vendor/firebase-app-compat.js
 *   vendor/firebase-auth-compat.js
 *   vendor/firebase-database-compat.js
 *   firebase-config.js
 *   env.js  (before this file — draft state hangs off WPIAL_ENV.draftRoot)
 *   ...existing scripts...
 *   draftsync.js  (after draftclock.js; it patches window.commitPick/undo)
 *
 * Uses the draftboard's own top-level bindings by bare name at runtime
 * (SLOTS, cursor, picks, POOL, TEAMS, ROUNDS) plus its global functions
 * (render, keeperMap, confirmBox). Patches window.commitPick, window.undo and
 * window.advanceThroughKeepers while synced. All reads are guarded — if the
 * board isn't this page, the file does nothing.
 * ==========================================================================*/
(function () {
  'use strict';

  /* SDK/config didn't load: do nothing, loudly. (These script tags live in
     <head>, so DOM elements can't be probed here — init() handles that.) */
  if (!window.firebase || !window.WPIAL_FIREBASE || !window.WPIAL_ENV) {
    if (window.console && console.warn) console.warn('[draftsync] firebase SDK/config/env missing — live sync disabled');
    return;
  }

  var ROOT = WPIAL_ENV.draftRoot;              /* drafts/<env>/<season> */
  var K_EMAIL = WPIAL_ENV.key('wpial_fb_email'); /* email pending link sign-in */

  var app = firebase.initializeApp(WPIAL_FIREBASE);
  var db = firebase.database();
  var fbauth = firebase.auth();

  /* Local testing hook: set window.WPIAL_FIREBASE_EMULATOR = {dbHost,dbPort,authUrl}
     BEFORE this script. Never set in committed HTML. */
  if (window.WPIAL_FIREBASE_EMULATOR) {
    try {
      db.useEmulator(WPIAL_FIREBASE_EMULATOR.dbHost, WPIAL_FIREBASE_EMULATOR.dbPort);
      if (WPIAL_FIREBASE_EMULATOR.authUrl) fbauth.useEmulator(WPIAL_FIREBASE_EMULATOR.authUrl);
    } catch (e) {}
  }

  /* ---------------- state ---------------- */
  var uid = null;            /* firebase uid once signed in */
  var myEmail = null;
  var myFid = null;          /* franchise this inbox owns, from /emailToFid */
  var commishMap = {};       /* uid -> true, from /commish */
  var synced = false;        /* signed in + listeners attached + meta exists */
  var metaExists = false;
  var serverOffset = 0;      /* .info/serverTimeOffset */
  var connected = false;
  var remoteCursor = null;
  var remotePicks = {};      /* overall -> server pick node */
  var presence = {};         /* uid -> {fid,at} */
  var activations = {};      /* uid -> {fid,email,at} — who has EVER connected */
  var clockNode = null;      /* {deadline, forOverall} in SERVER time */
  var origCommit = null;
  var origUndo = null;
  var origAdvance = null;
  var origSetMode = null;
  var lastPickLine = '';     /* "3.04 Mud Dogs → Puka Nacua" for the strip */
  var listenersOn = false;
  var clockPushTimer = null;
  var lastPushedClock = '';

  function amCommish() { return !!(uid && commishMap[uid] === true); }

  /* ---------------- tiny utils ---------------- */
  function h(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }
  function emailKey(e) { return String(e || '').toLowerCase().split('.').join(','); }
  function isLive() {
    var el = document.getElementById('modeLive');
    if (el) return el.classList.contains('active');
    try { return (localStorage.getItem('wpial_mode') || 'live').indexOf('mock') < 0; }
    catch (e) { return true; }
  }
  function slots() { try { return SLOTS; } catch (e) { return []; } }
  function teams() { try { return TEAMS; } catch (e) { return []; } }
  function rounds() { try { return ROUNDS; } catch (e) { return 16; } }
  function rerender() { try { render(); } catch (e) {} }

  /* fid <-> team name. franchise.js is the registry; the TEAMS array order is
     the registry order (f01..f10), which is the documented fallback. */
  function fidOf(team) {
    try { if (window.WPIAL_FX) { var r = WPIAL_FX.resolve(team); if (r) return r; } } catch (e) {}
    var i = teams().indexOf(team);
    return i >= 0 ? 'f' + ('0' + (i + 1)).slice(-2) : null;
  }
  function teamOf(fid) {
    try {
      if (window.WPIAL_FX && WPIAL_FX.get) {
        var rec = WPIAL_FX.get(fid);
        if (rec && (rec.name || rec.canon)) return rec.name || rec.canon;
      }
    } catch (e) {}
    var n = parseInt(String(fid || '').replace(/[^0-9]/g, ''), 10);
    return (n >= 1 && n <= teams().length) ? teams()[n - 1] : String(fid || '?');
  }
  function slotLabel(s) { return s.round + '.' + ('0' + s.pickInRound).slice(-2); }

  /* ---------------- the status strip (Law 2: word + glyph, never hue alone) -- */
  function injectCss() {
    if (document.getElementById('dsCss')) return;
    var s = document.createElement('style');
    s.id = 'dsCss';
    s.textContent = [
      '#dsBar{width:100%;display:flex;gap:10px;align-items:center;flex-wrap:wrap;',
      '  padding:5px 0 3px;font-size:11.5px;color:var(--muted);border-top:1px solid var(--line);}',
      '#dsBar b{color:var(--text);font-weight:600;}',
      '#dsBar .dsdot{font-size:10px;}',
      '#dsBar .dsmsg{font-weight:600;}',
      '#dsBar .dsmsg.rej{color:var(--accent);}',   /* + word + glyph, so hue is redundant */
      '#dsBar button{font-size:11px;padding:3px 9px;}',
      '#dsBar input{font-size:11px;padding:3px 6px;background:transparent;',
      '  border:1px solid var(--line);border-radius:6px;color:var(--text);min-width:170px;}',
      '#dsBar .dsclock{font-family:"Oswald",sans-serif;font-variant-numeric:tabular-nums;',
      '  font-size:14px;color:var(--text);letter-spacing:.5px;}',
      '@media (max-width:760px){#dsBar{gap:7px;font-size:11px;}}'
    ].join('');
    document.head.appendChild(s);
  }
  function bar() {
    var el = document.getElementById('dsBar');
    if (el) return el;
    var header = document.querySelector('header');
    if (!header) return null;
    injectCss();
    el = document.createElement('div');
    el.id = 'dsBar';
    el.setAttribute('role', 'status');
    var nav = document.getElementById('siteNav');
    if (nav) header.insertBefore(el, nav); else header.appendChild(el);
    return el;
  }

  var msg = '', msgClass = '', msgTimer = null;
  function say(text, cls, ms) {
    msg = text || ''; msgClass = cls || '';
    if (msgTimer) clearTimeout(msgTimer);
    if (msg && ms !== 0) msgTimer = setTimeout(function () { msg = ''; paint(); }, ms || 6000);
    paint();
  }

  function onlineCount() {
    var seen = {};
    Object.keys(presence).forEach(function (u) { if (presence[u] && presence[u].fid) seen[presence[u].fid] = 1; });
    return Object.keys(seen).length;
  }

  function fmtClock(ms) {
    var t = Math.max(0, Math.ceil(ms / 1000));
    return Math.floor(t / 60) + ':' + ('0' + (t % 60)).slice(-2);
  }

  /* Commish-only: how many franchises have EVER completed Connect (per person,
     not per device — three devices on one inbox share a uid), and who hasn't. */
  function activationLine() {
    if (!amCommish()) return null;
    var have = {};
    Object.keys(activations).forEach(function (u) {
      var a = activations[u] || {};
      if (a.fid) have[a.fid] = 1;
    });
    var missing = [];
    teams().forEach(function (t) { if (!have[fidOf(t)]) missing.push(t); });
    var total = teams().length;
    if (!missing.length) return '<span>⚡ Activated: <b>all ' + total + ' owners</b> ✓</span>';
    return '<span>⚡ Activated: <b>' + (total - missing.length) + ' of ' + total +
      '</b> · waiting on ' + missing.map(h).join(', ') + '</span>';
  }

  function paint() {
    var el = bar();
    if (!el) return;
    if (!isLive()) { el.style.display = 'none'; return; }
    el.style.display = '';

    var parts = [];
    if (!uid) {
      parts.push('<span class="dsdot">○</span> Live draft: <b>not connected</b> — picks made here stay on this device');
      parts.push('<button id="dsConnect" class="primary" type="button">Connect</button>');
      if (pendingEmailUi) {
        parts.push('<input id="dsEmail" type="email" inputmode="email" autocomplete="email" placeholder="the email your invite went to">');
        parts.push('<button id="dsEmailGo" type="button">Send link</button>');
      }
    } else if (!metaExists) {
      parts.push('<span class="dsdot">●</span> Connected as <b>' + h(myEmail || '') + '</b> · live draft <b>not started</b>');
      if (amCommish()) parts.push('<button id="dsSetup" class="primary" type="button">⚡ Start live draft</button>');
    } else {
      var who = myFid ? teamOf(myFid) : null;
      parts.push('<span class="dsdot">●</span> <b>Live</b> · ' +
        (who ? ('you are <b>' + h(who) + '</b>' + (amCommish() ? ' (commish)' : '')) :
          (amCommish() ? '<b>commissioner</b>' : '<b>signed in — no franchise linked; tell the commish</b>')));
      parts.push('<span>' + onlineCount() + ' of ' + teams().length + ' owners online</span>');
      if (!connected) parts.push('<span class="dsmsg">⟳ reconnecting — board may be stale</span>');
      if (clockNode && clockNode.deadline) {
        var left = clockNode.deadline - (Date.now() + serverOffset);
        var s = slots()[clockNode.forOverall];
        if (s && left > -3000) {
          parts.push('<span class="dsclock">⏱ ' + fmtClock(left) + '</span><span>' + h(s.team) + ' on the clock</span>');
        }
      }
      if (lastPickLine) parts.push('<span>' + lastPickLine + '</span>');
    }
    if (uid) { var actLine = activationLine(); if (actLine) parts.push(actLine); }
    if (msg) parts.push('<span class="dsmsg ' + msgClass + '">' + msg + '</span>');
    el.innerHTML = parts.join(' ');

    var c = document.getElementById('dsConnect');
    if (c) c.onclick = connectClick;
    var g = document.getElementById('dsEmailGo');
    if (g) g.onclick = function () {
      var v = (document.getElementById('dsEmail') || {}).value || '';
      if (v.indexOf('@') > 0) sendLink(v.trim());
    };
    var st = document.getElementById('dsSetup');
    if (st) st.onclick = setupLive;
  }

  /* ---------------- email-link sign-in ---------------- */
  var pendingEmailUi = false;
  function connectClick() {
    var known = '';
    try { known = (window.WPIAL_USER && WPIAL_USER.email) || ''; } catch (e) {}
    if (known) sendLink(known);
    else { pendingEmailUi = true; paint(); }
  }
  function sendLink(email) {
    var url = window.location.origin + window.location.pathname +
      (WPIAL_ENV.isStaging ? '?env=staging' : '');
    fbauth.sendSignInLinkToEmail(email, { url: url, handleCodeInApp: true })
      .then(function () {
        try { localStorage.setItem(K_EMAIL, email); } catch (e) {}
        pendingEmailUi = false;
        say('✉ Link sent to ' + h(email) + ' — open it on THIS device', '', 0);
      })
      .catch(function (err) {
        say('⚠ Could not send link: ' + h((err && err.message) || err), 'rej', 12000);
      });
  }
  function completeLinkSignIn() {
    if (!fbauth.isSignInWithEmailLink(window.location.href)) return;
    var email = null;
    try { email = localStorage.getItem(K_EMAIL); } catch (e) {}
    if (!email) {
      /* Link opened on a different device than the one that requested it. */
      pendingEmailUi = true;
      say('Almost there — confirm the email this link was sent to, then tap Send link again', '', 0);
      return;
    }
    fbauth.signInWithEmailLink(email, window.location.href)
      .then(function () {
        try { localStorage.removeItem(K_EMAIL); } catch (e) {}
        /* Scrub the one-time code from the URL but keep the path + env. */
        try {
          var clean = window.location.pathname + (WPIAL_ENV.isStaging ? '?env=staging' : '');
          window.history.replaceState({}, document.title, clean);
        } catch (e) {}
      })
      .catch(function (err) {
        say('⚠ Sign-in link failed: ' + h((err && err.code) || err) + ' — request a new one', 'rej', 0);
      });
  }

  /* ---------------- listeners ---------------- */
  function ref(p) { return db.ref(ROOT + (p ? '/' + p : '')); }

  function attach() {
    if (listenersOn) return;
    listenersOn = true;

    db.ref('.info/serverTimeOffset').on('value', function (s) { serverOffset = s.val() || 0; });
    db.ref('.info/connected').on('value', function (s) {
      connected = s.val() === true;
      if (connected && uid && myFid) {
        var me = ref('presence/' + uid);
        me.onDisconnect().remove();
        me.set({ fid: myFid, at: firebase.database.ServerValue.TIMESTAMP });
      }
      paint();
    });

    ref('meta').on('value', function (s) { metaExists = !!s.val(); syncFlag(); paint(); });
    ref('cursor').on('value', function (s) { remoteCursor = s.val(); applyRemote(); });
    ref('picks').on('value', function (s) { remotePicks = s.val() || {}; applyRemote(); });
    ref('presence').on('value', function (s) { presence = s.val() || {}; paint(); });
    db.ref('activations').on('value', function (s) { activations = s.val() || {}; paint(); });
    ref('clock').on('value', function (s) { clockNode = s.val(); paint(); });
    db.ref('commish').on('value', function (s) { commishMap = s.val() || {}; paint(); });
  }

  function syncFlag() {
    synced = !!(uid && metaExists);
    if (synced && !origCommit) patchBoard();     /* idempotent */
    if (!synced && origCommit) unpatchBoard();
  }

  /* Server state -> the board's own local bindings, then one render. */
  var applying = false;
  function applyRemote() {
    if (!synced) { syncFlag(); if (!synced) return; }
    if (remoteCursor == null) return;
    /* MOCK is a private simulator — never let shared state overwrite it. The
       mode-toggle listener re-applies when the user comes back to LIVE. */
    if (!isLive()) return;
    /* Listeners can fire before the board's inline script has evaluated its
       top-level bindings; init() re-applies once the DOM is ready. */
    if (document.readyState === 'loading') return;
    applying = true;
    try {
      var local = {};
      Object.keys(remotePicks).forEach(function (k) {
        var p = remotePicks[k] || {};
        local[k] = {
          name: p.name, pos: p.pos || '', team: p.nfl || '',
          keeper: p.keeper === true, id: p.id || undefined
        };
      });
      picks = local;                    /* board's top-level let, by bare name */
      cursor = nextOpen(remoteCursor);  /* trust but verify: skip filled slots */
      lastPickLast();
      rerender();
    } catch (e) {
      if (window.console && console.warn) console.warn('[draftsync] apply failed', e);
    }
    applying = false;
    paint();
  }
  function lastPickLast() {
    var ks = Object.keys(remotePicks).map(Number).sort(function (a, b) { return a - b; });
    var last = null;
    for (var i = ks.length - 1; i >= 0; i--) {
      if (remotePicks[ks[i]] && remotePicks[ks[i]].keeper !== true) { last = ks[i]; break; }
    }
    if (last == null) { lastPickLine = ''; return; }
    var p = remotePicks[last], s = slots()[last];
    if (!p || !s) { lastPickLine = ''; return; }
    lastPickLine = '✓ ' + slotLabel(s) + ' ' + h(s.team) + ' → <b>' + h(p.name) + '</b>' +
      (p.by && commishMap[p.by] === true && p.keeper !== true && myFid && fidOf(s.team) === myFid && p.by !== uid
        ? ' · <b>picked for you by the commissioner</b>' : '');
  }

  /* next open slot at or after i, per the server mirror */
  function nextOpen(i) {
    var S = slots();
    var k = Math.max(0, i | 0);
    while (k < S.length && remotePicks[k]) k++;
    return k;
  }

  /* ---------------- the pick ---------------- */
  function syncedCommit(player) {
    var S = slots();
    var ov = nextOpen(remoteCursor == null ? 0 : remoteCursor);
    if (ov >= S.length) return false;
    var s = S[ov];
    var slotFid = fidOf(s.team);

    if (!amCommish() && myFid !== slotFid) {
      say('✕ Not your pick — <b>' + h(s.team) + '</b> is on the clock', 'rej');
      return false;
    }
    if (!amCommish() && !myFid) {
      say('✕ This email isn’t linked to a franchise — tell the commissioner', 'rej', 0);
      return false;
    }

    var upd = {};
    upd['picks/' + ov] = {
      fid: slotFid, name: player.n, pos: player.p || '', nfl: player.t || '',
      id: player.id || null, keeper: false, overall: ov,
      by: uid, at: firebase.database.ServerValue.TIMESTAMP
    };
    var after = ov + 1;
    while (after < S.length && remotePicks[after]) after++;
    upd['cursor'] = after;

    ref().update(upd)
      .then(function () {
        var e = ref('log').push();
        e.set({ type: 'pick', overall: ov, fid: slotFid, name: player.n, by: uid, at: firebase.database.ServerValue.TIMESTAMP });
      })
      .catch(function () {
        /* The normal outcome of two people tapping at once. He got there first. */
        var taken = remotePicks[ov];
        say('✕ <b>' + h(s.team) + '</b>’s pick was already made' +
          (taken ? ' — ' + h(taken.name) + ' at ' + slotLabel(s) : '') +
          ' · the board has moved on, nothing was lost', 'rej', 9000);
        applyRemote();
      });
    /* Latency compensation shows the pick instantly; a server rejection rolls
       it back and the catch above explains it. Either way the board is right. */
    return true;
  }

  function syncedUndo() {
    if (!amCommish()) { say('✕ Only the commissioner can undo a live pick', 'rej'); return; }
    var ks = Object.keys(remotePicks).map(Number).sort(function (a, b) { return a - b; });
    var last = null;
    for (var i = ks.length - 1; i >= 0; i--) {
      if (remotePicks[ks[i]] && remotePicks[ks[i]].keeper !== true) { last = ks[i]; break; }
    }
    if (last == null) { say('Nothing to undo'); return; }
    var upd = {};
    upd['picks/' + last] = null;
    upd['cursor'] = last;
    ref().update(upd).then(function () {
      var e = ref('log').push();
      e.set({ type: 'undo', overall: last, by: uid, at: firebase.database.ServerValue.TIMESTAMP });
    }).catch(function (err) {
      say('⚠ Undo failed: ' + h((err && err.code) || err), 'rej');
    });
  }

  /* ---------------- patching the board ---------------- */
  function patchBoard() {
    if (origCommit) return;
    if (typeof window.commitPick !== 'function') {
      /* board script hasn't evaluated yet — try again once it has */
      document.addEventListener('DOMContentLoaded', function () { syncFlag(); });
      return;
    }
    origCommit = window.commitPick;
    origUndo = window.undo;
    origAdvance = window.advanceThroughKeepers;
    window.commitPick = function (player) {
      if (synced && isLive()) return syncedCommit(player);
      return origCommit.apply(this, arguments);
    };
    window.undo = function () {
      if (synced && isLive()) return syncedUndo();
      return origUndo.apply(this, arguments);
    };
    /* Keeper auto-fill is a SETUP-time server write now. Locally inventing
       keeper picks would fork the shared board the first time a keeper list
       and the seeded slots disagree. */
    window.advanceThroughKeepers = function () {
      if (synced && isLive()) return;
      return origAdvance.apply(this, arguments);
    };
    /* Coming back from MOCK, loadState() restores a stale localStorage copy of
       LIVE — immediately re-assert the shared board over it. */
    origSetMode = window.setMode;
    if (typeof origSetMode === 'function') {
      window.setMode = function (m) {
        var r = origSetMode.apply(this, arguments);
        if (synced && isLive()) applyRemote();
        paint();
        return r;
      };
    }
    applyRemote();
  }
  function unpatchBoard() {
    if (!origCommit) return;
    window.commitPick = origCommit; origCommit = null;
    window.undo = origUndo; origUndo = null;
    window.advanceThroughKeepers = origAdvance; origAdvance = null;
    if (origSetMode) { window.setMode = origSetMode; origSetMode = null; }
  }

  /* ---------------- commissioner: one-time setup ---------------- */
  function setupLive() {
    if (!amCommish()) return;
    var S = slots();
    var run = function () {
      var upd = {};
      upd['meta'] = { rounds: rounds(), startedAt: firebase.database.ServerValue.TIMESTAMP };
      S.forEach(function (s) {
        upd['slots/' + s.overall] = { fid: fidOf(s.team), round: s.round, pickInRound: s.pickInRound };
      });
      /* Seed keeper picks from the board's own keeper map so every client sees
         the same pre-filled slots and nobody's local list matters again. */
      var km = {};
      try { km = keeperMap(); } catch (e) {}
      var first = null;
      S.forEach(function (s) {
        var k = km[s.team] && km[s.team][s.round];
        if (k) {
          upd['picks/' + s.overall] = {
            fid: fidOf(s.team), name: k.player, pos: k.pos || '',
            nfl: '', id: k.poolRef || null, keeper: true, overall: s.overall,
            by: uid, at: firebase.database.ServerValue.TIMESTAMP
          };
        } else if (first == null) first = s.overall;
      });
      upd['cursor'] = first == null ? S.length : first;
      ref().update(upd)
        .then(function () { say('✓ Live draft is up — slots written, keepers seeded'); })
        .catch(function (err) { say('⚠ Setup failed: ' + h((err && err.code) || err), 'rej', 0); });
    };
    var kmCount = 0;
    try { Object.keys(keeperMap()).forEach(function (t) { kmCount += Object.keys(keeperMap()[t]).length; }); } catch (e) {}
    if (typeof window.confirmBox === 'function') {
      confirmBox('Start the live draft?',
        'Writes all ' + S.length + ' slots and seeds <b>' + kmCount + '</b> keeper picks to <b>' +
        h(ROOT) + '</b>. Every connected owner switches to the shared board.', run);
    } else if (window.confirm ? true : true) {
      /* no blocking modals is a site law — confirmBox exists on this page */
      run();
    }
  }

  /* ---------------- commissioner: share the local clock ---------------- */
  /* draftclock.js stays the single owner of clock policy. This just publishes
     its absolute deadline (corrected to server time) so nine other screens can
     count down to the same millisecond. */
  function pushClock() {
    if (!synced || !amCommish() || !window.WPIAL_CLOCK) return;
    var st = null;
    try { st = WPIAL_CLOCK.state(); } catch (e) { return; }
    var cur = remoteCursor == null ? null : nextOpen(remoteCursor);
    var node = (st && st.running && st.deadline && cur != null && cur < slots().length)
      ? { deadline: Math.round(st.deadline + serverOffset), forOverall: cur }
      : null;
    var sig = JSON.stringify(node);
    if (sig === lastPushedClock) return;
    lastPushedClock = sig;
    ref('clock').set(node)["catch"](function () { lastPushedClock = ''; });
  }

  /* ---------------- auth lifecycle ---------------- */
  fbauth.onAuthStateChanged(function (u) {
    uid = u ? u.uid : null;
    myEmail = u ? (u.email || '') : null;
    myFid = null;
    if (!uid) { syncFlag(); paint(); return; }
    db.ref('emailToFid/' + emailKey(myEmail)).once('value').then(function (s) {
      myFid = s.val() || null;
      /* Activation record: "this inbox has completed Connect at least once."
         Keyed by uid, so the same owner on three devices is still one person.
         Feeds the commissioner's activated-count in the strip. */
      var act = { email: myEmail, at: firebase.database.ServerValue.TIMESTAMP };
      if (myFid) act.fid = myFid;
      db.ref('activations/' + uid).set(act)["catch"](function () {});
      attach();
      syncFlag();
      if (connected && myFid) {
        var me = ref('presence/' + uid);
        me.onDisconnect().remove();
        me.set({ fid: myFid, at: firebase.database.ServerValue.TIMESTAMP });
      }
      paint();
    })["catch"](function () { attach(); syncFlag(); paint(); });
  });

  /* ---------------- boot ---------------- */
  function init() {
    if (!document.getElementById('board')) return;   /* not the draftboard */
    completeLinkSignIn();
    paint();
    /* strip follows the LIVE/MOCK toggle; returning to LIVE re-asserts the
       shared board over whatever loadState() just pulled from localStorage */
    ['modeLive', 'modeMock'].forEach(function (id) {
      var b = document.getElementById(id);
      if (b) b.addEventListener('click', function () { setTimeout(function () { applyRemote(); paint(); }, 60); });
    });
    if (synced) applyRemote();   /* listeners may have fired during parse */
    /* countdown repaint + commish clock publish */
    setInterval(function () {
      if (clockNode && clockNode.deadline) paint();
      pushClock();
    }, 1000);
  }

  window.WPIAL_SYNC = {
    state: function () {
      return { synced: synced, uid: uid, fid: myFid, commish: amCommish(),
        cursor: remoteCursor, picks: Object.keys(remotePicks).length,
        connected: connected, root: ROOT };
    },
    setup: setupLive,
    /* Console helper for the one manual seeding step: prints the JSON to paste
       into the Firebase console at /emailToFid. Fill in the emails. */
    emailMapTemplate: function () {
      var o = {};
      teams().forEach(function (t) { o['OWNER,EMAIL,HERE__' + fidOf(t)] = fidOf(t); });
      return JSON.stringify(o, null, 2)
        .split('OWNER,EMAIL,HERE__').join('their,email,with,commas,for,dots ← ');
    }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
