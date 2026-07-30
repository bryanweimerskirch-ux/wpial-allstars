/* ============================================================================
 * watchlist.js — per-owner draft watchlist for the draftboard
 * ----------------------------------------------------------------------------
 * Two jobs:
 *   1. Let an owner build a ranked shortlist before the draft.
 *   2. Put that list on the server so the commissioner's board can read it when
 *      the clock expires (see draftclock.js). A list that only lives in its
 *      owner's browser is invisible to the board on draft night.
 *
 * Additive by construction — draftboard.html gains one <script> tag and nothing
 * else. The panel, the 👁 buttons on Best Available, and the styles are all
 * injected from here.
 *
 * Reaches into the draftboard's own top-level bindings by bare name
 * (`POOL`, `picks`, `norm`, `isKept`, `available`) — top-level let/const in a
 * classic script share one global lexical scope, and function declarations land
 * on globalThis. Everything is called after DOMContentLoaded, by which point
 * the inline script at the bottom of <body> has run.
 *
 * Exposes window.WPIAL_WATCH = { list, reload, ready }.
 * ==========================================================================*/
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var MAX = 50;
  var SAVE_DELAY = 900;

  var L = [];              // the list, in priority order: {id, n, p, t}
  var myTeamName = null;
  var saveTimer = null;
  var status = '';         // '', 'saving', 'saved', or an error string
  var resetSearch = function () {};
  var readyFns = [];

  /* ---------- tiny helpers (the page's own esc/norm may not exist yet) ---- */
  function q(s) { return document.querySelector(s); }
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
  function post(params) {
    var b = new URLSearchParams();
    Object.keys(params).forEach(function (k) { b.append(k, params[k]); });
    return fetch(API, { method: 'POST', body: b }).then(function (r) { return r.json(); });
  }
  function cacheKey() { return 'wpial_watch_v1_' + (myTeamName || 'anon'); }

  /* ---------- is this player already off the board? ---------------------- */
  function playerState(entry) {
    var n = nm(entry.n);
    try {
      for (var k in picks) { if (nm(picks[k].name) === n) return 'drafted'; }
      if (isKept(entry.n)) return 'kept';
    } catch (e) {}
    return 'open';
  }

  /* ---------- styles ----------------------------------------------------- */
  function injectCss() {
    if (document.getElementById('wlCss')) return;
    var s = document.createElement('style');
    s.id = 'wlCss';
    s.textContent = [
      '#wlSection .wlhead{display:flex;align-items:baseline;gap:8px;flex-wrap:wrap;}',
      '#wlSection .wlcount{font-size:10.5px;color:var(--muted);font-weight:400;}',
      '#wlSection .wlstat{margin-left:auto;font-size:10.5px;color:var(--muted);}',
      '#wlSection .wlstat.err{color:var(--danger);}',
      '#wlSection .wlstat.ok{color:var(--ok);}',
      '#wlAdd{width:100%;margin:7px 0 4px;}',
      '#wlSuggest{position:relative;}',
      '#wlSuggest .sg{position:absolute;left:0;right:0;top:0;z-index:30;background:var(--panel);',
      '  border:1px solid var(--line);border-radius:8px;max-height:230px;overflow:auto;}',
      '#wlSuggest .sg div{padding:6px 9px;cursor:pointer;font-size:12.5px;display:flex;gap:7px;align-items:baseline;}',
      '#wlSuggest .sg div:hover,#wlSuggest .sg div.on{background:var(--cellfill);}',
      '#wlList{margin-top:4px;}',
      '#wlList .wl{display:flex;gap:6px;align-items:center;padding:4px 5px;border-radius:6px;',
      '  border:1px solid transparent;font-size:12.5px;}',
      '#wlList .wl:hover{border-color:var(--line);background:var(--cellfill);}',
      '#wlList .wln{color:var(--muted);font-family:"Oswald";font-size:10.5px;min-width:17px;}',
      '#wlList .nm{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}',
      '#wlList .wltm{color:var(--muted);font-size:10px;}',
      '#wlList .wlacts{margin-left:auto;display:flex;gap:3px;flex:0 0 auto;}',
      '#wlList .wlacts button{padding:0 5px;font-size:11px;line-height:18px;border-radius:5px;}',
      '#wlList .wl.gone .nm{text-decoration:line-through;opacity:.55;}',
      '#wlList .wl.gone{opacity:.75;}',
      '#wlList .tag{font-size:9px;letter-spacing:.5px;text-transform:uppercase;color:var(--muted);}',
      '#balist .wlbtn{margin-left:5px;flex:0 0 auto;padding:0 6px;font-size:11px;line-height:17px;',
      '  border-radius:9px;border:1px solid var(--line);background:transparent;color:var(--muted);}',
      '#balist .wlbtn:hover{border-color:var(--accent);color:var(--accent);}',
      '#balist .wlbtn.on{border-color:var(--accent);color:var(--accent);}'
    ].join('');
    document.head.appendChild(s);
  }

  /* ---------- panel ------------------------------------------------------ */
  function buildPanel() {
    if (document.getElementById('wlSection')) return;
    var ba = q('#balist');
    if (!ba) return;
    var host = ba.closest('.side-section');
    if (!host || !host.parentNode) return;

    // Static shell. Only #wlList and #wlFoot are ever re-rendered, so the search
    // box keeps its value and focus while the board re-renders around it.
    var sec = document.createElement('div');
    sec.className = 'side-section';
    sec.id = 'wlSection';
    sec.innerHTML =
      '<h3 class="wlhead">👁 My Watchlist <span class="wlcount" id="wlCount"></span>' +
      '<span class="wlstat" id="wlStat"></span></h3>' +
      '<div id="wlGate" class="hint" hidden>Sign in to build a watchlist.</div>' +
      '<div id="wlBody" hidden>' +
        '<input id="wlAdd" placeholder="Add a player… (3+ letters)" autocomplete="off">' +
        '<div id="wlSuggest"></div>' +
        '<div id="wlList"></div>' +
        '<div id="wlFoot"></div>' +
      '</div>';
    // Above Best Available, not below it: Best Available is 18 rows deep, and
    // burying an owner's own shortlist under it makes it feel secondary.
    host.parentNode.insertBefore(sec, host);
    wireAdd();
    wirePanel();
    renderPanel();
  }

  function renderPanel() {
    var body = document.getElementById('wlBody');
    var gate = document.getElementById('wlGate');
    if (!body || !gate) return;
    var cnt = document.getElementById('wlCount');
    var st = document.getElementById('wlStat');

    var user = window.WPIAL_USER || null;
    if (!user || !myTeamName) {
      if (cnt) cnt.textContent = '';
      if (st) { st.textContent = ''; st.className = 'wlstat'; }
      body.hidden = true; gate.hidden = false;
      return;
    }
    body.hidden = false; gate.hidden = true;

    if (cnt) cnt.textContent = L.length + '/' + MAX + ' · ' + myTeamName;
    if (st) {
      st.textContent = status === 'saving' ? 'saving…' : (status === 'saved' ? 'saved' : (status || ''));
      st.className = 'wlstat' + (status === 'saved' ? ' ok' : (status && status !== 'saving' ? ' err' : ''));
    }

    var rows = L.map(function (e, i) {
      var state = playerState(e);
      var gone = state !== 'open';
      return '<div class="wl' + (gone ? ' gone' : '') + '" data-i="' + i + '">' +
        '<span class="wln">' + (i + 1) + '</span>' +
        '<span class="poschip ' + h(e.p) + '">' + h(e.p) + '</span>' +
        '<span class="nm">' + h(e.n) + '</span>' +
        '<span class="wltm">' + h(e.t) + '</span>' +
        (gone ? '<span class="tag">' + state + '</span>' : '') +
        '<span class="wlacts">' +
          '<button data-up="' + i + '" title="Move up"' + (i === 0 ? ' disabled' : '') + '>▲</button>' +
          '<button data-down="' + i + '" title="Move down"' + (i === L.length - 1 ? ' disabled' : '') + '>▼</button>' +
          '<button data-rm="' + i + '" title="Remove">✕</button>' +
        '</span></div>';
    }).join('');

    var goneCount = L.filter(function (e) { return playerState(e) !== 'open'; }).length;

    document.getElementById('wlList').innerHTML = rows ||
      '<div class="hint">Nothing on your list yet. Add players here or hit 👁 in Best Available. ' +
      'Order matters — top of the list gets taken first.</div>';

    document.getElementById('wlFoot').innerHTML = L.length
      ? '<div class="hint" style="margin-top:7px;">If your clock runs out, the board takes the ' +
        'highest name here that\'s still on the board. If they\'re all gone it takes the top of ' +
        'Best Available.' + (goneCount ? ' <button id="wlClean" style="font-size:10.5px;padding:1px 7px;">Clear ' +
        goneCount + ' gone</button>' : '') + '</div>'
      : '';
  }

  /* ---------- add-player search (self-contained, no interception) -------- */
  function wireAdd() {
    var inp = document.getElementById('wlAdd');
    var box = document.getElementById('wlSuggest');
    if (!inp || !box) return;
    var cur = -1, hits = [];

    function close() { box.innerHTML = ''; cur = -1; hits = []; }
    // add() clears the search after a successful add; the input is part of the
    // static shell now, so it has to be reset explicitly.
    resetSearch = function () { inp.value = ''; close(); };

    function open() {
      var t = nm(inp.value);
      if (t.length < 3) return close();
      var have = {};
      L.forEach(function (e) { have[nm(e.n)] = true; });
      hits = POOL.filter(function (p) { return nm(p.n).indexOf(t) !== -1 && !have[nm(p.n)]; }).slice(0, 10);
      if (!hits.length) return close();
      box.innerHTML = '<div class="sg">' + hits.map(function (p, i) {
        var gone = playerState(p) !== 'open';
        return '<div data-i="' + i + '"' + (i === cur ? ' class="on"' : '') + '>' +
          '<span class="poschip ' + h(p.p) + '">' + h(p.p) + '</span>' +
          '<span style="font-weight:600' + (gone ? ';text-decoration:line-through;opacity:.6' : '') + '">' +
          h(p.n) + '</span>' +
          '<span style="color:var(--muted);font-size:10px;">' + h(p.t) + ' · rank ' + p.r + '</span></div>';
      }).join('') + '</div>';
    }

    inp.addEventListener('input', open);
    inp.addEventListener('keydown', function (e) {
      if (!hits.length) return;
      if (e.key === 'ArrowDown') { e.preventDefault(); cur = Math.min(cur + 1, hits.length - 1); open(); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); cur = Math.max(cur - 1, 0); open(); }
      else if (e.key === 'Enter') { e.preventDefault(); add(hits[cur < 0 ? 0 : cur]); }
      else if (e.key === 'Escape') { close(); }
    });
    box.addEventListener('mousedown', function (e) {
      var d = e.target.closest('[data-i]');
      if (d) { e.preventDefault(); add(hits[+d.dataset.i]); }
    });
    document.addEventListener('click', function (e) {
      if (box && !box.contains(e.target) && e.target !== inp) close();
    });
  }

  /* ---------- mutations -------------------------------------------------- */
  function add(p) {
    if (!p || !myTeamName) return;
    if (L.length >= MAX) { status = 'list is full (' + MAX + ')'; renderPanel(); return; }
    var n = nm(p.n);
    if (L.some(function (e) { return nm(e.n) === n; })) return;
    L.push({ id: String(p.id || ''), n: p.n, p: p.p, t: p.t || '' });
    resetSearch();
    changed();
  }
  function removeAt(i) { L.splice(i, 1); changed(); }
  function move(i, d) {
    var j = i + d;
    if (j < 0 || j >= L.length) return;
    var tmp = L[i]; L[i] = L[j]; L[j] = tmp;
    changed();
  }
  function clearGone() {
    L = L.filter(function (e) { return playerState(e) === 'open'; });
    changed();
  }

  function changed() {
    try { localStorage.setItem(cacheKey(), JSON.stringify(L)); } catch (e) {}
    status = 'saving';
    renderPanel();
    decorateBA();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, SAVE_DELAY);
  }

  function save() {
    var tok = token();
    if (!tok) { status = 'not signed in'; renderPanel(); return; }
    post({ action: 'watchlist_save', token: tok, players_json: JSON.stringify(L) })
      .then(function (r) {
        status = (r && r.ok) ? 'saved' : ((r && r.error) || 'save failed');
        renderPanel();
        if (r && r.ok) setTimeout(function () {
          if (status === 'saved') { status = ''; renderPanel(); }
        }, 2500);
      })
      .catch(function () { status = 'offline — kept locally'; renderPanel(); });
  }

  /* ---------- 👁 buttons on Best Available ------------------------------- */
  function decorateBA() {
    var list = document.getElementById('balist');
    if (!list || !myTeamName) return;
    var on = {};
    L.forEach(function (e) { on[nm(e.n)] = true; });
    var rows = list.querySelectorAll('.ba[data-id]');
    for (var i = 0; i < rows.length; i++) {
      var row = rows[i];
      var id = row.dataset.id;
      var p = null;
      try { p = POOL.find(function (x) { return String(x.id) === id; }); } catch (e) {}
      if (!p) continue;
      var b = row.querySelector('.wlbtn');
      if (!b) {
        b = document.createElement('button');
        b.className = 'wlbtn';
        b.type = 'button';
        row.appendChild(b);
      }
      var have = !!on[nm(p.n)];
      b.dataset.wl = id;
      b.textContent = have ? '👁 on' : '👁';
      b.title = have ? 'Remove from your watchlist' : 'Add to your watchlist';
      b.className = 'wlbtn' + (have ? ' on' : '');
    }
  }

  function wireBA() {
    var list = document.getElementById('balist');
    if (!list || list.__wlWired) return;
    list.__wlWired = true;
    // Capture phase: the page's own handler drafts the player on any click
    // inside .ba, and it was bound first. Stopping propagation here is what
    // keeps 👁 from also opening the draft confirm box.
    list.addEventListener('click', function (e) {
      var b = e.target.closest('.wlbtn');
      if (!b) return;
      e.stopPropagation();
      e.preventDefault();
      var id = b.dataset.wl;
      var idx = -1;
      for (var i = 0; i < L.length; i++) {
        if (String(L[i].id) === String(id)) { idx = i; break; }
      }
      if (idx >= 0) { removeAt(idx); return; }
      var p = null;
      try { p = POOL.find(function (x) { return String(x.id) === String(id); }); } catch (err) {}
      if (p) add(p);
    }, true);
  }

  function wirePanel() {
    var body = document.getElementById('wlSection');
    if (!body || body.__wlWired) return;
    body.__wlWired = true;
    body.addEventListener('click', function (e) {
      var t = e.target;
      if (t.id === 'wlClean') return clearGone();
      if (t.dataset.rm != null) return removeAt(+t.dataset.rm);
      if (t.dataset.up != null) return move(+t.dataset.up, -1);
      if (t.dataset.down != null) return move(+t.dataset.down, 1);
    });
  }

  /* ---------- load ------------------------------------------------------- */
  function load() {
    var user = window.WPIAL_USER || null;
    myTeamName = (user && user.team) || null;
    if (!myTeamName) { renderPanel(); return; }

    // Paint from cache first so the panel is never empty while the round trip runs.
    try {
      var c = JSON.parse(localStorage.getItem(cacheKey()) || 'null');
      if (c && c.length) { L = c; renderPanel(); decorateBA(); }
    } catch (e) {}

    var tok = token();
    if (!tok) { renderPanel(); return; }
    post({ action: 'watchlist_get', token: tok })
      .then(function (r) {
        if (r && r.ok) {
          L = r.players || [];
          MAX = r.max || MAX;
          try { localStorage.setItem(cacheKey(), JSON.stringify(L)); } catch (e) {}
          status = '';
        } else if (r && r.error) {
          status = r.error;
        }
        renderPanel(); decorateBA();
        readyFns.splice(0).forEach(function (f) { try { f(L); } catch (e) {} });
      })
      .catch(function () { status = 'offline — using local copy'; renderPanel(); });
  }

  /* ---------- keep the 👁 buttons alive across re-renders ---------------- */
  function patchRender() {
    if (typeof window.render !== 'function' || window.render.__wlPatched) return;
    var orig = window.render;
    var patched = function () {
      var out = orig.apply(this, arguments);
      try { decorateBA(); renderPanel(); } catch (e) {}
      return out;
    };
    patched.__wlPatched = true;
    window.render = patched;
  }

  function init() {
    injectCss();
    buildPanel();
    wireBA();
    patchRender();
    load();
    document.addEventListener('wpial-auth', function () { load(); });
    document.addEventListener('wpial-auth-refresh', function () { load(); });
  }

  window.WPIAL_WATCH = {
    list: function () { return L.slice(); },
    reload: load,
    ready: function (fn) { if (typeof fn === 'function') { if (L.length) fn(L); else readyFns.push(fn); } }
  };

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
