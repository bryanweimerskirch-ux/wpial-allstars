/**
 * WPIAL All Stars — real keeper declaration inside the draftboard (draftkeep.js)
 * -----------------------------------------------------------------------------
 * The draftboard's ⭐ Keep pool filter used to be display-only in LIVE mode: it
 * listed your keeper-eligible roster but there was nothing to click, and in MOCK
 * mode its button called the local-only mockKeep(). So the board looked functional
 * but never saved. This adds a real KEEP / KEEPING pill to that list, writing
 * through the same keeper_save endpoint the Rosters board uses.
 *
 * SCOPE RULES
 *  - LIVE mode only. MOCK mode is a simulator; its existing per-box ⭐ Keep / ✕
 *    buttons and mockKeep() are deliberately left completely alone.
 *  - Only on teams the viewer may edit (own team, or any team for the commish).
 *  - Server still enforces the 5 cap, one-per-round, and the lock deadline.
 *
 * Requires auth.js. Reads the page's own globals (keepViewTeam, mode, keepers,
 * loadKeepersFromList, render, renderPool) rather than duplicating their logic.
 */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var MAX = 5;

  var picks = {};      // team -> [{name,pos,round}]
  var locked = false;
  var lockAt = null;
  var user = null;
  var busy = false;    // guards the MutationObserver against our own writes

  var css = document.createElement('style');
  css.textContent =
    '.dk-pill{background:none;border:1px solid var(--line,#2a3038);border-radius:10px;' +
      'cursor:pointer;font-size:10px;font-weight:700;letter-spacing:.3px;' +
      'text-transform:uppercase;line-height:1;padding:3px 7px;color:var(--muted,#9aa4b2);' +
      'margin-left:6px;white-space:nowrap;transition:all .12s;}' +
    '.dk-pill:hover{color:var(--text,#e6edf3);border-color:var(--muted,#9aa4b2);}' +
    '.dk-pill.on{color:#1a0e04;background:#ffd23f;border-color:#ffd23f;}' +
    '.dk-pill:disabled{cursor:not-allowed;opacity:.5;}' +
    '.dk-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;' +
      'margin:0 0 7px;padding:6px 9px;border:1px solid var(--line,#2a3038);' +
      'border-radius:8px;background:rgba(255,255,255,.03);color:var(--muted,#9aa4b2);}' +
    '.dk-bar b{color:var(--text,#e6edf3);}' +
    '.dk-bar.done b{color:#3fb950;}' +
    '.dk-bar .dk-msg{color:#ff9f4d;}' +
    '.dk-bar .dk-cap{color:#9aa4b2;font-weight:400;}' +
    /* our pill states it — don't also show the list's own "⭐ kept" chip */
    '.ba.dk-done .pill.ok{display:none !important;}';
  document.head.appendChild(css);

  function post(params) {
    var body = new URLSearchParams();
    Object.keys(params).forEach(function (k) { body.append(k, params[k]); });
    return fetch(API, { method: 'POST', body: body }).then(function (r) { return r.json(); });
  }

  /* See keepers.js — compare franchises, not strings, so a rename can never lock an
     owner out of their own keepers. Degrades to the old comparison when the registry
     is unavailable. */
  function sameFranchise(a, b) {
    if (window.WPIAL_FX) {
      var ra = WPIAL_FX.resolve(a), rb = WPIAL_FX.resolve(b);
      if (ra && rb) return ra === rb;
    }
    return String(a == null ? '' : a).trim() === String(b == null ? '' : b).trim();
  }

  function canEdit(team) {
    if (!user || !team) return false;
    if (user.is_commish) return true;
    return sameFranchise(user.fid || user.team, team);
  }
  function editableNow(team) { return canEdit(team) && (!locked || !!user.is_commish); }
  function teamPicks(t) { return picks[t] || (picks[t] = []); }
  function isPicked(t, n) {
    return teamPicks(t).some(function (p) { return String(p.name) === String(n); });
  }
  function roundOwner(t, rd, exceptName) {
    var hit = teamPicks(t).filter(function (p) {
      return Number(p.round) === Number(rd) && p.name !== exceptName;
    })[0];
    return hit ? hit.name : null;
  }

  function loadState() {
    return fetch(API + '?action=keepers_v2&cb=' + Date.now())
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (!d || !d.ok) return;
        locked = !!d.locked;
        lockAt = d.lock_at || null;
        picks = {};
        Object.keys(d.teams || {}).forEach(function (t) {
          picks[t] = (d.teams[t].players || []).map(function (p) {
            return { name: p.name, pos: p.pos, round: p.round };
          });
        });
      }).catch(function () {});
  }

  /* The page keeps its keeper list in a script-scoped `let keepers`, which a separate
     file cannot reach, and loadKeepersFromList() only ever appends — so it cannot
     represent a drop. Rather than half-sync (adds live-updating, drops not), leave the
     rest of the board alone and say plainly that it catches up on refresh. The saved
     declaration is authoritative either way. */
  var changed = false;

  /** LIVE vs MOCK, read from the toggle since `mode` is not a window global. */
  function isLive() {
    var el = document.getElementById('modeLive');
    if (el) return el.classList.contains('active');
    try { return (localStorage.getItem('wpial_mode') || 'live').indexOf('mock') < 0; }
    catch (e) { return true; }
  }

  function currentTeam() {
    try {
      if (typeof window.keepViewTeam === 'function') return window.keepViewTeam();
    } catch (e) {}
    return (user && user.team) || null;
  }

  var msgText = '';
  var msgTimer = null;
  function say(text) {
    msgText = text || '';
    var el = document.querySelector('.dk-msg');
    if (el) el.textContent = msgText ? '· ' + msgText : '';
    if (msgTimer) clearTimeout(msgTimer);
    if (msgText) {
      msgTimer = setTimeout(function () {
        msgText = '';
        var e2 = document.querySelector('.dk-msg');
        if (e2) e2.textContent = '';
      }, 5000);
    }
  }

  function decorate() {
    var list = document.getElementById('balist');
    if (!list || busy) return;
    // The ⭐ Keep list is the only pool view that renders round chips (.kpr)
    var rows = list.querySelectorAll('.ba');
    var isKeepList = list.querySelector('.ba .kpr');
    if (!rows.length || !isKeepList) return;
    if (!isLive()) return;                        // MOCK keeps its own behavior

    var team = currentTeam();
    if (!canEdit(team)) return;

    busy = true;
    try {
      var n = teamPicks(team).length;

      var bar = list.querySelector('.dk-bar');
      if (!bar) {
        bar = document.createElement('div');
        bar.className = 'dk-bar';
        list.insertBefore(bar, list.firstChild);
      }
      /* Ceiling, not a quota: three keepers is a finished decision. */
      bar.className = 'dk-bar' + (n ? ' done' : '');
      bar.innerHTML = '';
      var lbl = document.createElement('span');
      lbl.innerHTML = 'Keepers for <b>' + team + '</b>: <b>' + n + '</b> <span class="dk-cap">(up to ' + MAX + ')</span>';
      bar.appendChild(lbl);
      var note = document.createElement('span');
      if (locked && !user.is_commish) note.textContent = '· locked';
      else if (locked) note.textContent = '· locked for owners — commish override';
      else if (lockAt) note.textContent = '· edit until ' + new Date(lockAt)
        .toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
      bar.appendChild(note);
      var msg = document.createElement('span');
      msg.className = 'dk-msg';
      msg.textContent = msgText ? '· ' + msgText : '';
      bar.appendChild(msg);
      if (changed) {
        var hint = document.createElement('span');
        hint.style.color = '#6b7480';
        hint.textContent = '· saved — refresh to update the rest of the board';
        bar.appendChild(hint);
      }

      Array.prototype.forEach.call(rows, function (row) {
        var nmEl = row.querySelector('.nm');
        var rdEl = row.querySelector('.kpr');
        if (!nmEl || !rdEl) return;
        var name = nmEl.textContent.trim();
        var round = parseInt(String(rdEl.textContent).replace(/[^0-9]/g, ''), 10);
        if (!name || !round) return;

        var on = isPicked(team, name);
        row.classList.toggle('dk-done', on);

        var btn = row.querySelector('.dk-pill');
        if (!btn) {
          btn = document.createElement('button');
          btn.className = 'dk-pill';
          btn.type = 'button';
          row.appendChild(btn);
          btn.addEventListener('click', function (ev) {
            ev.preventDefault();
            ev.stopPropagation();          // never trigger the row's draft-player click
            toggle(team, name, round, (row.querySelector('.poschip') || {}).textContent || '');
          });
        }
        btn.textContent = on ? 'Keeping' : 'Keep';
        btn.className = 'dk-pill' + (on ? ' on' : '');
        btn.disabled = !editableNow(team);
        btn.title = on
          ? 'Keeping ' + name + ' at Round ' + round + ' — click to drop'
          : 'Keep ' + name + ' — costs the Round ' + round + ' pick';
      });
    } finally {
      busy = false;
    }
  }

  function toggle(team, name, round, pos) {
    if (!editableNow(team)) return;
    var list = teamPicks(team).slice();
    var on = isPicked(team, name);

    if (on) {
      list = list.filter(function (p) { return p.name !== name; });
    } else {
      if (list.length >= MAX) { say('already ' + MAX + ' keepers — drop one first'); return; }
      var clash = roundOwner(team, round, name);
      if (clash) { say('Round ' + round + ' is already used by ' + clash); return; }
      list.push({ name: name, pos: String(pos).trim(), round: round });
    }

    var before = teamPicks(team);
    picks[team] = list;
    decorate();
    say('saving…');

    var payload = { action: 'keeper_save', token: WPIAL_AUTH.token(), players: JSON.stringify(list) };
    if (user.is_commish && user.team !== team) payload.team = team;

    post(payload).then(function (res) {
      if (res && res.ok) {
        picks[team] = res.players || list;
        changed = true;
        decorate();
        say('saved');
      } else {
        picks[team] = before;
        decorate();
        say((res && res.error) || 'could not save');
      }
    }).catch(function () {
      picks[team] = before;
      decorate();
      say('network error — not saved');
    });
  }

  function start(u) {
    user = u;
    var list = document.getElementById('balist');
    if (!list) return;                       // not the draftboard
    loadState().then(function () {
      decorate();
      new MutationObserver(function () { decorate(); })
        .observe(list, { childList: true, subtree: false });
      // re-decorate when the mode toggle or commish team picker changes things
      document.addEventListener('click', function () { setTimeout(decorate, 250); }, true);
    });
  }

  if (window.WPIAL_AUTH && WPIAL_AUTH.ready) WPIAL_AUTH.ready(start);
  else document.addEventListener('wpial-auth', function (e) { start(e.detail); });
})();
