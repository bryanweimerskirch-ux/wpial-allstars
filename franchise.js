/**
 * franchise.js — the WPIAL franchise registry.
 *
 * WHY THIS EXISTS
 * Until now the team-name STRING was the primary key of the whole league: rosters,
 * keeper picks, watchlists, h2h, the draft order, the trade machine and the session
 * token all joined on it. That made "let an owner rename their team" a change that
 * fails silently and, worse, fails SOFT — a renamed team gets a plausible-but-wrong
 * keeper round and plausible-but-wrong trade values instead of an error.
 *
 * The fix is to split the one string that was doing two jobs:
 *
 *   fid    'f01'..'f10'  immutable forever. The real identity.
 *   canon  the team name as of 2026-08-01, frozen. Still the join key for every
 *          existing code path, the Owners sheet, KeeperPicks, Watchlist and tokens.
 *          NEVER CHANGES, so none of that code had to change.
 *   name   the display name. Owner-editable, anytime. NEVER A KEY.
 *
 * Rule for anyone touching this: anything persisted, compared, sorted, indexed or put
 * in a URL uses fid or canon. Anything a human reads is resolved through here.
 *
 * PRIVACY — READ BEFORE EDITING
 * This file ships in a PUBLIC repo. It carries fids, frozen team names, colors and the
 * default logos, and nothing else. NO FIRST NAMES, NO EMAILS, EVER. Personal data
 * arrives only in the token-gated `profiles_all` response at runtime. Every render site
 * must look correct with a first name absent.
 *
 * Load order: FIRST on every page, before auth.js.
 *
 * Exposes window.WPIAL_FX and fires a 'wpial-profiles' event on document whenever the
 * registry changes. Identity arrives async, so anything that renders a team name or a
 * logo must re-render on that event.
 */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var K_CACHE = 'wpial_profiles_v1';

  /* ---------- storage, never bare (matches auth.js:81-83) ---------- */
  function lsGet(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function lsSet(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }

  /* ---------- baked-in defaults ----------
     Frozen names + the placeholder logos that shipped before owners could customize.
     `priors` are the historical names already public in the franchise-lineage ribbons
     on index.html, so resolve() answers correctly for them from the very first paint.
     Deliberately absent: the name Bindgamer3 played under before the July privacy wipe. */
  var BASE = [
    { fid: 'f01', canon: "Drake Draaaake?",
      priors: ["Najee Germany", "Sutton My Face", "Team Balzer"],
      colors: { primary: '#F4C430', secondary: '#E8862E', accent: '#FFDE59' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#F4C430"/><circle cx="48" cy="48" r="26" fill="#FFDE59"/><path d="M66 52 Q84 54 82 62 Q78 66 64 60 Z" fill="#E8862E"/><rect x="30" y="40" width="34" height="9" rx="4" fill="#222"/><path d="M32 26 Q42 16 52 24" fill="#FFDE59"/></svg>' },
    { fid: 'f02', canon: "Kweef Farts",
      priors: ["Injured Reserve", "My Dick hERTZ", "Under The InfluWENTZ"],
      colors: { primary: '#9FB8C7', secondary: '#6E8B9A', accent: '#F2F7FA' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#9FB8C7"/><ellipse cx="42" cy="52" rx="18" ry="14" fill="#F2F7FA"/><ellipse cx="60" cy="48" rx="14" ry="12" fill="#F2F7FA"/><ellipse cx="52" cy="60" rx="20" ry="12" fill="#F2F7FA"/><path d="M22 50 Q14 50 16 58" stroke="#6E8B9A" stroke-width="3" fill="none" stroke-linecap="round"/><path d="M80 46 Q90 44 88 54" stroke="#6E8B9A" stroke-width="3" fill="none" stroke-linecap="round"/><circle cx="44" cy="54" r="3" fill="#333"/><circle cx="58" cy="54" r="3" fill="#333"/><path d="M46 62 Q52 66 58 62" stroke="#333" stroke-width="2" fill="none" stroke-linecap="round"/></svg>' },
    { fid: 'f03', canon: "Syd Sweeney's Denim Jeans",
      priors: ["Sydney Sweeney's Fat T!ts", "Wet Chops"],
      colors: { primary: '#3B5F8A', secondary: '#28405E', accent: '#D9C24A' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#3B5F8A"/><rect x="30" y="24" width="40" height="54" rx="6" fill="#5B84B5"/><path d="M38 40 Q50 46 62 40" stroke="#28405E" stroke-width="2.5" fill="none"/><circle cx="50" cy="34" r="2.5" fill="#D9C24A"/><rect x="38" y="52" width="24" height="18" rx="3" fill="#4A729E" stroke="#28405E" stroke-width="1.5"/></svg>' },
    { fid: 'f04', canon: "G. O. A. T.",
      priors: [],
      colors: { primary: '#C9A24B', secondary: '#222222', accent: '#F3EEDD' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#C9A24B"/><path d="M34 30 Q28 14 40 20" stroke="#EDEDED" stroke-width="7" fill="none" stroke-linecap="round"/><path d="M66 30 Q72 14 60 20" stroke="#EDEDED" stroke-width="7" fill="none" stroke-linecap="round"/><ellipse cx="50" cy="52" rx="24" ry="22" fill="#F3EEDD"/><rect x="34" y="46" width="32" height="9" rx="4" fill="#222"/><path d="M50 60 L46 68 L54 68 Z" fill="#EEE"/><path d="M42 76 L58 76 L54 84 L46 84 Z" fill="#DDD"/></svg>' },
    { fid: 'f05', canon: "THE Vagitarians",
      priors: [],
      colors: { primary: '#3E9F5C', secondary: '#1B3B12', accent: '#8FE07A' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#3E9F5C"/><polygon points="30,42 70,42 50,78" fill="#B23A2E"/><circle cx="50" cy="46" r="22" fill="#8FE07A"/><path d="M32 40 Q50 20 68 40" fill="#5FC94A"/><circle cx="43" cy="48" r="3" fill="#1B3B12"/><circle cx="57" cy="48" r="3" fill="#1B3B12"/><path d="M42 56 Q50 62 58 56" stroke="#1B3B12" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>' },
    { fid: 'f06', canon: "Mud Dogs",
      priors: [],
      colors: { primary: '#7A5230', secondary: '#5C3A1E', accent: '#F2E2C4' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#7A5230"/><ellipse cx="28" cy="46" rx="10" ry="16" fill="#5C3A1E"/><ellipse cx="72" cy="46" rx="10" ry="16" fill="#5C3A1E"/><circle cx="50" cy="52" r="26" fill="#D6A868"/><ellipse cx="50" cy="60" rx="12" ry="8" fill="#F2E2C4"/><circle cx="41" cy="46" r="3.5" fill="#1a1a1a"/><circle cx="59" cy="46" r="3.5" fill="#1a1a1a"/><circle cx="50" cy="58" r="3" fill="#1a1a1a"/><ellipse cx="35" cy="64" rx="6" ry="4" fill="#4d3319" opacity="0.6"/></svg>' },
    { fid: 'f07', canon: "Bindgamer3",
      priors: [],
      colors: { primary: '#4C4C6D', secondary: '#D64545', accent: '#E4E4EC' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#4C4C6D"/><rect x="20" y="40" width="60" height="30" rx="15" fill="#E4E4EC"/><rect x="30" y="52" width="8" height="6" fill="#333"/><rect x="32" y="50" width="4" height="10" fill="#333"/><circle cx="66" cy="50" r="4" fill="#D64545"/><circle cx="72" cy="56" r="4" fill="#3E8ED0"/><circle cx="42" cy="47" r="2.5" fill="#111"/><circle cx="58" cy="47" r="2.5" fill="#111"/></svg>' },
    { fid: 'f08', canon: "Bijan Mustard",
      priors: ["Bench Taylor Swift", "Mr. Necksock"],
      colors: { primary: '#E8A93C', secondary: '#7A3B12', accent: '#FFF8E1' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#E8A93C"/><rect x="38" y="34" width="24" height="42" rx="8" fill="#FFF8E1"/><rect x="43" y="20" width="14" height="16" rx="3" fill="#7A3B12"/><rect x="47" y="12" width="6" height="10" rx="2" fill="#7A3B12"/><circle cx="45" cy="58" r="3" fill="#333"/><circle cx="55" cy="58" r="3" fill="#333"/><path d="M43 66 Q50 72 57 66" stroke="#333" stroke-width="2.5" fill="none" stroke-linecap="round"/></svg>' },
    { fid: 'f09', canon: "Mean Machine",
      priors: [],
      colors: { primary: '#5A5A5A', secondary: '#E63946', accent: '#CFCFCF' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#5A5A5A"/><rect x="30" y="34" width="40" height="36" rx="8" fill="#CFCFCF"/><rect x="46" y="18" width="8" height="14" fill="#8A8A8A"/><circle cx="50" cy="18" r="4" fill="#E63946"/><rect x="36" y="44" width="10" height="10" rx="2" fill="#2EC4F5"/><rect x="54" y="44" width="10" height="10" rx="2" fill="#2EC4F5"/><rect x="38" y="60" width="24" height="5" rx="2" fill="#8A8A8A"/><rect x="38" y="52" width="24" height="4" rx="2" fill="#8A8A8A"/></svg>' },
    { fid: 'f10', canon: "Return of The Mac",
      priors: [],
      colors: { primary: '#2E5C8A', secondary: '#F4C430', accent: '#EAF1F8' },
      logo: '<svg viewBox="0 0 100 100"><circle cx="50" cy="50" r="48" fill="#2E5C8A"/><path d="M50 18 L76 28 L76 52 Q76 74 50 84 Q24 74 24 52 L24 28 Z" fill="#EAF1F8"/><path d="M36 54 Q50 34 64 54 Q56 50 50 58 Q44 50 36 54 Z" fill="#2E5C8A"/><polygon points="50,60 53,67 61,67 54,71 57,78 50,73 43,78 46,71 39,67 47,67" fill="#F4C430"/></svg>' }
  ];

  /* ---------- name normalization ----------
     loose: casefold + collapse whitespace + drop punctuation. Handles casing and
            spacing drift, which is what ESPN and hand-typed sheet cells actually do.
     tight: additionally drop every space, so "GOAT" finds "G. O. A. T.". Only consulted
            when loose misses, and only for tight keys that are unique across the league —
            a collision must never silently resolve to the wrong franchise. */
  function normLoose(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }
  function normTight(s) { return normLoose(s).replace(/\s/g, ''); }

  /* ---------- live state ---------- */
  var byFid = {};       // fid -> record
  var looseIx = {};     // normalized name -> fid
  var tightIx = {};     // tight name -> fid | false (false = ambiguous, refuse)
  var order = [];       // fids in registry order
  var version = null;   // server profiles version, for the cheap ETag
  var hydrated = false;
  var readyFns = [];

  function addAlias(ix, key, fid, tight) {
    if (!key) return;
    if (Object.prototype.hasOwnProperty.call(ix, key) && ix[key] !== fid) {
      if (tight) { ix[key] = false; return; }   // ambiguous: refuse rather than guess
      return;                                   // loose collision: first registration wins
    }
    ix[key] = fid;
  }

  function reindex() {
    looseIx = {};
    tightIx = {};
    order.forEach(function (fid) {
      var r = byFid[fid];
      var names = [r.canon, r.name].concat(r.priors || []);
      addAlias(looseIx, normLoose(fid), fid, false);
      names.forEach(function (n) {
        addAlias(looseIx, normLoose(n), fid, false);
        addAlias(tightIx, normTight(n), fid, true);
      });
    });
  }

  function seed() {
    BASE.forEach(function (b) {
      byFid[b.fid] = {
        fid: b.fid,
        canon: b.canon,
        name: b.canon,            // display name defaults to the frozen name; ESPN overrides
        espn_id: '',              // bound once server-side; ESPN's own stable team id
        first: '',                // never baked in — arrives with profiles_all
        priors: (b.priors || []).slice(),
        colors: { primary: b.colors.primary, secondary: b.colors.secondary, accent: b.colors.accent },
        logo_kind: 'default',
        logo_data: '',
        jersey: null,
        motto: ''
      };
      order.push(b.fid);
    });
    reindex();
  }

  /* ---------- resolution ---------- */
  function resolve(x) {
    if (x == null) return null;
    if (typeof x === 'object') x = x.fid || x.canon || x.team || '';
    var s = String(x).trim();
    if (byFid[s]) return s;
    var l = looseIx[normLoose(s)];
    if (l) return l;
    var t = tightIx[normTight(s)];
    return t || null;                       // false (ambiguous) also lands here as null
  }
  function rec(x) {
    var fid = resolve(x);
    return fid ? byFid[fid] : null;
  }

  /* ---------- contrast: best ink wins, never a threshold ---------- */
  function lum(hex) {
    var c = String(hex || '').replace('#', '');
    if (c.length === 3) c = c.split('').map(function (x) { return x + x; }).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(c)) return 0;
    var f = function (u) { u = u / 255; return u <= 0.03928 ? u / 12.92 : Math.pow((u + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(parseInt(c.substr(0, 2), 16)) +
           0.7152 * f(parseInt(c.substr(2, 2), 16)) +
           0.0722 * f(parseInt(c.substr(4, 2), 16));
  }
  function ratio(a, b) {
    var x = lum(a), y = lum(b);
    return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
  }
  function ink(hex) { return ratio(hex, '#0d1117') >= ratio(hex, '#ffffff') ? '#0d1117' : '#ffffff'; }

  /* ---------- logo ----------
     30px emits byte-identical markup to the old teamLogoHTML(), so the standings,
     scoreboard and roster grid render exactly as before until an owner customizes. */
  function logoHTML(x, px) {
    var r = rec(x);
    if (!r) return '';
    var size = px && px !== 30 ? ' style="width:' + px + 'px;height:' + px + 'px"' : '';
    var inner;
    if ((r.logo_kind === 'upload' || r.logo_kind === 'ai') && isSafeDataUrl(r.logo_data)) {
      inner = '<img alt="" src="' + r.logo_data + '" style="width:100%;height:100%;display:block;border-radius:50%">';
    } else {
      inner = defaultLogo(r.fid);
    }
    return '<span class="team-logo-badge"' + size + '>' + inner + '</span>';
  }
  function isSafeDataUrl(s) {
    return typeof s === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(s);
  }
  function defaultLogo(fid) {
    for (var i = 0; i < BASE.length; i++) if (BASE[i].fid === fid) return BASE[i].logo;
    return '';
  }

  /* ---------- hydration ----------
     Same shape as auth.js boot(): paint from cache, verify in the background, and stay
     quiet when offline. profiles_all does not exist server-side yet; an unknown action
     just leaves the defaults in place, which is the correct behaviour either way. */
  function applyProfiles(list) {
    if (!list || !list.length) return false;
    var touched = false;
    list.forEach(function (p) {
      var fid = p && p.fid && byFid[p.fid] ? p.fid : resolve(p && (p.canon || p.team));
      if (!fid) return;
      var r = byFid[fid];
      /* Display name is whatever ESPN last reported for this franchise. There is no
         rename field anywhere on the site — owners rename in the ESPN app and this
         follows. canon never moves, so nothing keyed on it notices. */
      if (p.team_name) r.name = String(p.team_name);
      if (p.espn_id != null) r.espn_id = String(p.espn_id);
      if (p.first_name != null) r.first = String(p.first_name);
      if (p.prior_names && p.prior_names.length) r.priors = p.prior_names.slice();
      if (p.colors) {
        if (p.colors.primary) r.colors.primary = p.colors.primary;
        if (p.colors.secondary) r.colors.secondary = p.colors.secondary;
        if (p.colors.accent) r.colors.accent = p.colors.accent;
      }
      if (p.logo_kind) r.logo_kind = p.logo_kind;
      if (p.logo_data != null) r.logo_data = p.logo_data;
      if (p.jersey) r.jersey = p.jersey;
      if (p.motto != null) r.motto = p.motto;
      touched = true;
    });
    if (touched) reindex();
    return touched;
  }

  function announce() {
    try {
      document.dispatchEvent(new CustomEvent('wpial-profiles', { detail: publicApi }));
    } catch (e) {
      var ev = document.createEvent('CustomEvent');
      ev.initCustomEvent('wpial-profiles', false, false, publicApi);
      document.dispatchEvent(ev);
    }
    if (!hydrated) {
      hydrated = true;
      var fns = readyFns; readyFns = [];
      fns.forEach(function (fn) { try { fn(publicApi); } catch (e) {} });
    }
  }

  function fromCache() {
    try {
      var c = JSON.parse(lsGet(K_CACHE) || 'null');
      if (c && c.profiles && applyProfiles(c.profiles)) { version = c.v; return true; }
    } catch (e) {}
    return false;
  }

  function refresh() {
    var token = '';
    try { token = (window.WPIAL_AUTH && WPIAL_AUTH.token && WPIAL_AUTH.token()) || ''; } catch (e) {}
    if (!token) { announce(); return; }
    var body = new URLSearchParams();
    body.append('action', 'profiles_all');
    body.append('token', token);
    if (version != null) body.append('v', version);
    fetch(API, { method: 'POST', body: body })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) { announce(); return; }        // not deployed yet, or refused
        if (d.unchanged) { announce(); return; }
        if (applyProfiles(d.profiles)) {
          version = d.v != null ? d.v : version;
          lsSet(K_CACHE, JSON.stringify({ v: version, profiles: d.profiles }));
        }
        announce();
      })
      .catch(function () { announce(); });               // offline: keep what we have
  }

  /* ---------- public surface ---------- */
  var publicApi = {
    resolve: resolve,
    byId: function (x) { return rec(x); },
    canon: function (x) { var r = rec(x); return r ? r.canon : (x == null ? '' : String(x)); },
    name: function (x) { var r = rec(x); return r ? r.name : (x == null ? '' : String(x)); },
    first: function (x) { var r = rec(x); return r ? r.first : ''; },
    priorNames: function (x) { var r = rec(x); return r ? r.priors.slice() : []; },
    colors: function (x) {
      var r = rec(x);
      var c = r ? r.colors : { primary: '#d8b45c', secondary: '#12161d', accent: '#e8eaee' };
      return { primary: c.primary, secondary: c.secondary, accent: c.accent, ink: ink(c.primary) };
    },
    logoHTML: logoHTML,
    all: function () { return order.map(function (f) { return byFid[f]; }); },
    contrast: { lum: lum, ratio: ratio, ink: ink },
    hydrated: function () { return hydrated; },
    ready: function (fn) {
      if (typeof fn !== 'function') return;
      if (hydrated) fn(publicApi); else readyFns.push(fn);
    }
  };

  seed();
  fromCache();
  window.WPIAL_FX = publicApi;

  /* The registry is USABLE immediately — defaults plus whatever was cached. ready()
     fires on that, not on the network, so a logged-out or offline page still renders.
     Anything that must reflect later edits listens for 'wpial-profiles', which fires
     again every time real profile data lands. */
  setTimeout(announce, 0);

  /* auth.js may not have unlocked yet; refresh once identity exists. */
  if (window.WPIAL_AUTH && WPIAL_AUTH.ready) WPIAL_AUTH.ready(refresh);
  else document.addEventListener('wpial-auth', function () { refresh(); });
  /* and once more when the background auth_me revalidation lands */
  document.addEventListener('wpial-auth-refresh', function () { refresh(); });
})();
