/**
 * WPIAL All Stars — owner login gate (auth.js)
 * --------------------------------------------
 * Drop-in: put <script src="auth.js"></script> in <head> of any page that
 * should be gated. Nothing else on the page needs to change.
 *
 * WHAT THIS IS: a privacy screen, not a vault. Page content is static and the
 * repo is public, so a determined person can read it via view-source. What this
 * does do is keep the league from casually seeing each other's plans, keep
 * strangers out, and — the part that is real — give every page a trustworthy
 * `WPIAL_USER` so keeper writes can be authorised server-side.
 *
 * Exposes:
 *   window.WPIAL_USER            -> {email,name,team,is_commish} once unlocked
 *   window.WPIAL_AUTH.token()    -> session token for authorised POSTs
 *   window.WPIAL_AUTH.user()     -> same as WPIAL_USER
 *   window.WPIAL_AUTH.logout()
 *   window.WPIAL_AUTH.ready(fn)  -> run fn once unlocked (or immediately if already)
 *   event 'wpial-auth'           -> fired on document when unlocked
 */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var K_TOKEN = 'wpial_auth_token';
  var K_USER = 'wpial_auth_user';
  var GATE_ID = 'wpial-gate';

  var unlocked = false;
  var readyFns = [];

  /* ---------- 1. Hide the page on the very first paint ---------- */
  var html = document.documentElement;
  html.className += ' wpial-gated';

  var style = document.createElement('style');
  style.textContent =
    '.wpial-gated body > *{display:none !important;}' +
    '.wpial-gated body > #' + GATE_ID + '{display:flex !important;}' +
    '.wpial-gated body{overflow:hidden !important;}' +
    '#' + GATE_ID + '{position:fixed;inset:0;z-index:2147483647;background:#0d1117;' +
      'color:#e6edf3;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
      'align-items:center;justify-content:center;padding:20px;}' +
    '#' + GATE_ID + ' .wg-card{width:100%;max-width:380px;background:#161b22;' +
      'border:1px solid #2a3038;border-radius:14px;padding:26px 24px 22px;' +
      'box-shadow:0 18px 50px rgba(0,0,0,.55);}' +
    '#' + GATE_ID + ' h1{margin:0 0 4px;font-size:21px;letter-spacing:.3px;}' +
    '#' + GATE_ID + ' .wg-sub{margin:0 0 18px;color:#9aa4b2;font-size:13px;line-height:1.45;}' +
    '#' + GATE_ID + ' label{display:block;font-size:12px;color:#9aa4b2;margin:0 0 5px;}' +
    '#' + GATE_ID + ' input{width:100%;background:#0d1117;border:1px solid #2a3038;' +
      'color:#e6edf3;border-radius:8px;padding:11px 12px;font-size:16px;margin:0 0 12px;}' +
    '#' + GATE_ID + ' input:focus{outline:none;border-color:#2ea6ff;}' +
    '#' + GATE_ID + ' button.wg-go{width:100%;background:#ff6a1a;border:0;color:#1a0e04;' +
      'font-weight:700;font-size:15px;padding:12px;border-radius:8px;cursor:pointer;}' +
    '#' + GATE_ID + ' button.wg-go:disabled{opacity:.55;cursor:default;}' +
    '#' + GATE_ID + ' .wg-link{background:none;border:0;color:#2ea6ff;font-size:13px;' +
      'cursor:pointer;padding:10px 0 0;display:block;margin:0 auto;}' +
    '#' + GATE_ID + ' .wg-msg{font-size:13px;line-height:1.45;margin:0 0 12px;padding:9px 11px;' +
      'border-radius:8px;display:none;}' +
    '#' + GATE_ID + ' .wg-msg.err{display:block;background:#3a1414;border:1px solid #ff6b6b;color:#ffc9c9;}' +
    '#' + GATE_ID + ' .wg-msg.ok{display:block;background:#0f2a1a;border:1px solid #3fb950;color:#b7f0c6;}' +
    '#' + GATE_ID + ' .wg-who{font-size:13px;color:#9aa4b2;margin:0 0 14px;}' +
    '#' + GATE_ID + ' .wg-who b{color:#e6edf3;}' +
    '#' + GATE_ID + ' .wg-foot{margin:16px 0 0;font-size:11px;color:#6b7480;text-align:center;line-height:1.5;}' +
    // Sits inline in the page's own nav/header so it never collides with the
    // Gelly tip FAB (fixed bottom-right) or the draftboard's controls.
    '#wpial-chip{position:static;display:inline-flex;align-items:center;gap:7px;background:transparent;' +
      'border:1px solid #2a3038;border-radius:20px;padding:7px 13px;font-size:12px;color:#9aa4b2;' +
      'font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;' +
      'vertical-align:middle;margin:0 0 0 6px;white-space:nowrap;}' +
    '#wpial-chip b{color:#e6edf3;font-weight:600;}' +
    '#wpial-chip button{background:none;border:0;color:#2ea6ff;font-size:12px;cursor:pointer;' +
      'padding:0;text-decoration:underline;}' +
    '#wpial-chip.wpial-chip-float{position:fixed;top:8px;left:8px;z-index:2147483000;' +
      'background:#161b22;margin:0;}' +
    '@media (max-width:600px){#wpial-chip{font-size:11px;padding:6px 10px;}}' +
    // the board already shows which team is yours — save the space on phones
    '@media (max-width:900px){#wpial-chip .wpial-team{display:none;}}';
  (document.head || html).appendChild(style);

  /* ---------- 2. Storage + token helpers ---------- */
  function get(k) { try { return window.localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { window.localStorage.setItem(k, v); } catch (e) {} }
  function del(k) { try { window.localStorage.removeItem(k); } catch (e) {} }

  function readUser() {
    try { return JSON.parse(get(K_USER) || 'null'); } catch (e) { return null; }
  }

  /** Peek at the token's exp without trusting it — only to skip pointless calls. */
  function tokenLooksLive(tok) {
    if (!tok || tok.indexOf('.') < 0) return false;
    try {
      var p = tok.split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
      while (p.length % 4) p += '=';
      var claim = JSON.parse(atob(p));
      return !!claim.x && Date.now() < Number(claim.x);
    } catch (e) { return false; }
  }

  function post(params) {
    var body = new URLSearchParams();
    Object.keys(params).forEach(function (k) { body.append(k, params[k]); });
    return fetch(API, { method: 'POST', body: body }).then(function (r) { return r.json(); });
  }

  /* ---------- 3. Unlock / lock ---------- */
  function unlock(user) {
    window.WPIAL_USER = user;
    if (unlocked) return;
    unlocked = true;
    html.className = html.className.replace(/\bwpial-gated\b/g, '').trim();
    var g = document.getElementById(GATE_ID);
    if (g && g.parentNode) g.parentNode.removeChild(g);
    addChip(user);
    try { document.dispatchEvent(new CustomEvent('wpial-auth', { detail: user })); } catch (e) {}
    readyFns.splice(0).forEach(function (fn) { try { fn(user); } catch (e) {} });
  }

  function addChip(user) {
    if (document.getElementById('wpial-chip') || !document.body) return;

    var c = document.createElement('span');
    c.id = 'wpial-chip';
    var b = document.createElement('b');
    b.textContent = user.name || user.email;
    c.appendChild(b);
    if (user.team) {
      var t = document.createElement('span');
      t.className = 'wpial-team';
      t.textContent = '· ' + user.team;
      c.appendChild(t);
    }
    var out = document.createElement('button');
    out.textContent = 'log out';
    out.onclick = logout;
    c.appendChild(out);

    // Sit in whatever control row the page already has:
    //   index.html    -> <nav> (the tab pills)
    //   draftboard    -> .hdr-right (LIVE/MOCK, theme, Undo, Reset, Commish)
    // Appending to <header> directly is NOT ok on the draftboard — the header
    // spans the page and the chip ends up over the Best Available list.
    var host = document.querySelector('nav') || document.querySelector('.hdr-right');
    if (host) {
      host.appendChild(c);
    } else {
      c.className = 'wpial-chip-float';
      document.body.appendChild(c);
    }
  }

  function logout() {
    del(K_TOKEN); del(K_USER);
    window.location.reload();
  }

  /* ---------- 4. The gate UI ---------- */
  function buildGate() {
    if (document.getElementById(GATE_ID)) return;

    var wrap = document.createElement('div');
    wrap.id = GATE_ID;
    var card = document.createElement('div');
    card.className = 'wg-card';
    wrap.appendChild(card);

    var h = document.createElement('h1');
    h.textContent = '🏈 WPIAL All Stars';
    var sub = document.createElement('p');
    sub.className = 'wg-sub';
    sub.textContent = 'League members only. Sign in once and this device stays signed in.';
    card.appendChild(h); card.appendChild(sub);

    var msg = document.createElement('div');
    msg.className = 'wg-msg';
    card.appendChild(msg);

    // step 1 — email
    var who = document.createElement('div');
    who.className = 'wg-who';
    who.style.display = 'none';
    card.appendChild(who);

    var lblEmail = document.createElement('label');
    lblEmail.textContent = 'League email';
    var email = document.createElement('input');
    email.type = 'email'; email.autocomplete = 'username';
    email.placeholder = 'you@example.com';
    card.appendChild(lblEmail); card.appendChild(email);

    // step 2 — password (hidden until we know the email)
    var pwWrap = document.createElement('div');
    pwWrap.style.display = 'none';
    var lblPw = document.createElement('label');
    lblPw.textContent = 'Password';
    var pw = document.createElement('input');
    pw.type = 'password';
    pwWrap.appendChild(lblPw); pwWrap.appendChild(pw);

    var lblPw2 = document.createElement('label');
    lblPw2.textContent = 'Confirm password';
    var pw2 = document.createElement('input');
    pw2.type = 'password';
    var pw2Wrap = document.createElement('div');
    pw2Wrap.style.display = 'none';
    pw2Wrap.appendChild(lblPw2); pw2Wrap.appendChild(pw2);
    pwWrap.appendChild(pw2Wrap);
    card.appendChild(pwWrap);

    var go = document.createElement('button');
    go.className = 'wg-go';
    go.textContent = 'Continue';
    card.appendChild(go);

    var back = document.createElement('button');
    back.className = 'wg-link';
    back.textContent = 'Use a different email';
    back.style.display = 'none';
    card.appendChild(back);

    var foot = document.createElement('p');
    foot.className = 'wg-foot';
    foot.textContent = 'Forgot your password? Text the commish for a reset.';
    card.appendChild(foot);

    (document.body || html).appendChild(wrap);

    /* ----- state machine ----- */
    var mode = 'email';   // 'email' | 'login' | 'signup'
    var known = null;

    function say(text, kind) {
      msg.textContent = text || '';
      msg.className = 'wg-msg' + (text ? ' ' + (kind || 'err') : '');
    }
    function busy(on, label) {
      go.disabled = on;
      go.textContent = on ? (label || 'Working…') : (mode === 'signup' ? 'Create account'
        : mode === 'login' ? 'Log in' : 'Continue');
    }
    function toEmail() {
      mode = 'email'; known = null;
      pwWrap.style.display = 'none'; pw2Wrap.style.display = 'none';
      who.style.display = 'none'; back.style.display = 'none';
      pw.value = ''; pw2.value = '';
      say(''); busy(false); email.focus();
    }

    function checkEmail() {
      var v = (email.value || '').trim();
      if (!v || v.indexOf('@') < 0) { say('Enter your email address.'); return; }
      busy(true, 'Checking…');
      post({ action: 'auth_status', email: v }).then(function (r) {
        if (!r || !r.ok) { say((r && r.error) || 'Something went wrong. Try again.'); busy(false); return; }
        if (!r.known) {
          say('That email is not on the league list. Text the commish to get added.');
          busy(false); return;
        }
        known = r;
        who.style.display = '';
        who.textContent = '';
        who.appendChild(document.createTextNode('Signing in as '));
        var b = document.createElement('b');
        b.textContent = (r.name || v) + (r.team ? ' — ' + r.team : '');
        who.appendChild(b);
        pwWrap.style.display = '';
        back.style.display = '';
        if (r.has_password) {
          mode = 'login';
          pw2Wrap.style.display = 'none';
          lblPw.textContent = 'Password';
          say('');
        } else {
          mode = 'signup';
          pw2Wrap.style.display = '';
          lblPw.textContent = 'Create a password (6+ characters)';
          say('First time here — pick a password and you are set.', 'ok');
        }
        busy(false);
        pw.focus();
      }).catch(function () { say('Could not reach the league server. Check your connection.'); busy(false); });
    }

    function submitPassword() {
      var v = (email.value || '').trim();
      var p = pw.value || '';
      if (mode === 'signup') {
        if (p.length < 6) { say('Password needs to be at least 6 characters.'); return; }
        if (p !== pw2.value) { say('Those two passwords do not match.'); return; }
      } else if (!p) { say('Enter your password.'); return; }

      busy(true, mode === 'signup' ? 'Creating…' : 'Signing in…');
      var payload = mode === 'signup'
        ? { action: 'auth_signup', email: v, password: p }
        : { action: 'auth_login', email: v, password: p };

      post(payload).then(function (r) {
        if (!r || !r.ok) {
          say((r && r.error) || 'Could not sign you in.');
          busy(false);
          if (r && r.code === 'already') { mode = 'login'; pw2Wrap.style.display = 'none'; busy(false); }
          return;
        }
        set(K_TOKEN, r.token);
        set(K_USER, JSON.stringify(r.user));
        unlock(r.user);
      }).catch(function () { say('Could not reach the league server. Try again.'); busy(false); });
    }

    go.onclick = function () { if (mode === 'email') checkEmail(); else submitPassword(); };
    back.onclick = toEmail;
    email.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); if (mode === 'email') checkEmail(); } });
    pw.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitPassword(); } });
    pw2.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); submitPassword(); } });

    setTimeout(function () { email.focus(); }, 60);
  }

  /* ---------- 5. Boot ---------- */
  function boot() {
    var tok = get(K_TOKEN);
    var cached = readUser();

    // Fast path: trust the cached session for this paint, then verify in the
    // background. Saves a ~1s Apps Script round trip on every page load.
    if (tok && cached && tokenLooksLive(tok)) {
      unlock(cached);
      post({ action: 'auth_me', token: tok }).then(function (r) {
        if (r && r.ok) {
          set(K_USER, JSON.stringify(r.user));
          window.WPIAL_USER = r.user;
          window.WPIAL_KEEPER_STATE = { picks: r.picks, locked: r.locked, lock_at: r.lock_at };
          try { document.dispatchEvent(new CustomEvent('wpial-auth-refresh', { detail: r })); } catch (e) {}
        } else if (r && (r.code === 'bad_token' || r.code === 'not_member')) {
          del(K_TOKEN); del(K_USER);
          window.location.reload();
        }
      }).catch(function () { /* offline — keep them in */ });
      return;
    }

    if (tok) { del(K_TOKEN); del(K_USER); }
    buildGate();
  }

  window.WPIAL_AUTH = {
    token: function () { return get(K_TOKEN); },
    user: function () { return window.WPIAL_USER || null; },
    logout: logout,
    api: API,
    ready: function (fn) {
      if (typeof fn !== 'function') return;
      if (unlocked) fn(window.WPIAL_USER); else readyFns.push(fn);
    }
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
