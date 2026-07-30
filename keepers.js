/**
 * WPIAL All Stars — owner keeper declaration on the Rosters board (keepers.js)
 * ---------------------------------------------------------------------------
 * Adds a Keep/Keeping pill to each player on the Rosters & round values board so an
 * owner can declare their 5 keepers. Requires auth.js (uses WPIAL_AUTH / WPIAL_USER).
 * Deliberately NOT a ⭐ — the site already uses ⭐ for "declared 2026 keeper".
 *
 * DESIGN RULE (important): the existing click-to-signal-interest behaviour on
 * `span.player` is left COMPLETELY alone. Interest is the whole point of the Gelly
 * feed. Keeper selection gets its OWN button, a separate click target, and calls
 * stopPropagation so the two can never be confused.
 *
 * PERMISSIONS: commish gets the pill on every team. A regular owner gets it only on
 * their own team; other teams render nothing (the site already flags their declared
 * keepers in gold). The server enforces this too — keeper_save ignores a `team` param
 * from a non-commish caller — so the UI is convenience, not the boundary.
 */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var MAX = 5;

  var picks = {};        // team -> [{name,pos,round}]
  var locked = false;
  var lockAt = null;
  var user = null;
  var rows = [];         // {team, round, name, pos, playerSpan, btn}

  /* ---------- styles ---------- */
  var css = document.createElement('style');
  css.textContent =
    // NOT a star: the site already uses ⭐ to mean "declared 2026 keeper" (see the
    // Team rosters legend). A second ⭐ meaning "you are keeping this" on the same
    // row was ambiguous, so this is a labelled pill instead.
    '.wk-star{background:none;border:1px solid var(--line);border-radius:10px;cursor:pointer;' +
      'font-size:10px;font-weight:600;letter-spacing:.3px;text-transform:uppercase;' +
      'line-height:1;padding:3px 7px;margin-right:5px;color:var(--muted);' +
      'vertical-align:middle;transition:all .12s;}' +
    '.wk-star:hover{color:var(--text);border-color:var(--muted);background:#22282f;}' +
    '.wk-star.on{color:#1a0e04;background:#ffd23f;border-color:#ffd23f;}' +
    '.wk-star.on:hover{background:#ffdd6b;}' +
    '.wk-star:disabled{cursor:not-allowed;opacity:.5;}' +
    '.wk-bar{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:12px;' +
      'margin:2px 0 10px;padding:6px 9px;border:1px solid var(--line);border-radius:8px;' +
      'background:#12171e;color:var(--muted);}' +
    '.wk-bar b{color:var(--text);}' +
    '.wk-bar.done b{color:#3fb950;}' +
    '.wk-bar .wk-msg{color:#ff9f4d;}' +
    '.wk-bar .wk-lock{color:#9aa4b2;}';
  document.head.appendChild(css);

  function post(params) {
    var body = new URLSearchParams();
    Object.keys(params).forEach(function (k) { body.append(k, params[k]); });
    return fetch(API, { method: 'POST', body: body }).then(function (r) { return r.json(); });
  }

  function canEdit(team) {
    if (!user) return false;
    return !!user.is_commish || user.team === team;
  }
  /* Commish may edit past the deadline; everyone else is done at lock. */
  function editableNow(team) {
    return canEdit(team) && (!locked || !!user.is_commish);
  }

  function teamPicks(team) { return picks[team] || (picks[team] = []); }
  function isPicked(team, name) {
    return teamPicks(team).some(function (p) { return p.name === name; });
  }
  function roundTaken(team, round, exceptName) {
    return teamPicks(team).some(function (p) {
      return Number(p.round) === Number(round) && p.name !== exceptName;
    });
  }

  /* ---------- read the existing board out of the DOM ---------- */
  function scanBoard() {
    rows = [];
    document.querySelectorAll('#rosters .card, .card').forEach(function (card) {
      var nameEl = card.querySelector('.team-name');
      if (!nameEl) return;
      var team = nameEl.textContent.trim();
      if (!team) return;
      card.querySelectorAll('.row').forEach(function (row) {
        var rEl = row.querySelector('.rnd');
        if (!rEl) return;
        var round = parseInt(String(rEl.textContent).replace(/[^0-9]/g, ''), 10);
        if (!round) return;
        row.querySelectorAll('.player').forEach(function (sp) {
          var txt = sp.textContent.trim();
          var m = txt.match(/^([A-Z/]+)\s*-\s*(.+)$/);
          if (!m) return;
          rows.push({ team: team, round: round, pos: m[1], name: m[2].trim(), playerSpan: sp, card: card });
        });
      });
    });
    return rows;
  }

  /* ---------- render ---------- */
  function bar(card, team) {
    var b = card.querySelector('.wk-bar');
    if (!b) {
      b = document.createElement('div');
      b.className = 'wk-bar';
      var h3 = card.querySelector('h3');
      if (h3 && h3.nextSibling) card.insertBefore(b, h3.nextSibling);
      else card.appendChild(b);
    }
    return b;
  }

  function paintBar(card, team) {
    if (!canEdit(team)) return;
    var b = bar(card, team);
    var n = teamPicks(team).length;
    b.className = 'wk-bar' + (n === MAX ? ' done' : '');
    b.textContent = '';
    var lbl = document.createElement('span');
    lbl.innerHTML = 'Keepers: <b>' + n + ' / ' + MAX + '</b>';
    b.appendChild(lbl);

    var note = document.createElement('span');
    note.className = 'wk-lock';
    if (locked && !user.is_commish) {
      note.textContent = '· locked';
    } else if (locked && user.is_commish) {
      note.textContent = '· locked for owners — commish override';
    } else if (lockAt) {
      note.textContent = '· edit until ' + new Date(lockAt).toLocaleString([], {
        month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit'
      });
    }
    b.appendChild(note);

    var msg = document.createElement('span');
    msg.className = 'wk-msg';
    msg.setAttribute('data-msg', team);
    b.appendChild(msg);
  }

  function say(team, text) {
    var el = document.querySelector('.wk-msg[data-msg="' + (window.CSS && CSS.escape ? CSS.escape(team) : team) + '"]');
    if (!el) {
      var all = document.querySelectorAll('.wk-msg');
      for (var i = 0; i < all.length; i++) {
        if (all[i].getAttribute('data-msg') === team) { el = all[i]; break; }
      }
    }
    if (!el) return;
    el.textContent = text ? '· ' + text : '';
    if (text) setTimeout(function () { if (el.textContent.indexOf(text) > -1) el.textContent = ''; }, 4200);
  }

  function paintStars() {
    rows.forEach(function (r) {
      var on = isPicked(r.team, r.name);
      var editable = editableNow(r.team);
      if (!r.btn) {
        if (!canEdit(r.team)) return;   // don't clutter other people's teams

        r.btn = document.createElement('button');
        r.btn.className = 'wk-star';
        r.btn.type = 'button';
        r.playerSpan.parentNode.insertBefore(r.btn, r.playerSpan);
        r.btn.addEventListener('click', function (ev) {
          ev.preventDefault();
          ev.stopPropagation();          // never trigger the interest ping
          toggle(r);
        });
      }
      r.btn.textContent = on ? 'Keeping' : 'Keep';
      r.btn.className = 'wk-star' + (on ? ' on' : '');
      r.btn.disabled = !editable;
      r.btn.title = on
        ? (editable ? 'Keeping ' + r.name + ' at your Round ' + r.round + ' pick — click to drop' : r.name + ' is a declared keeper')
        : (editable ? 'Keep ' + r.name + ' — costs your Round ' + r.round + ' pick' : 'Keeper selection is locked');
    });
  }

  function repaint() {
    var seen = {};
    rows.forEach(function (r) {
      if (seen[r.team]) return;
      seen[r.team] = 1;
      paintBar(r.card, r.team);
    });
    paintStars();
  }

  /* ---------- toggle + save ---------- */
  function toggle(r) {
    if (!editableNow(r.team)) return;
    var list = teamPicks(r.team).slice();
    var on = isPicked(r.team, r.name);

    if (on) {
      list = list.filter(function (p) { return p.name !== r.name; });
    } else {
      if (list.length >= MAX) { say(r.team, 'that is already ' + MAX + ' keepers — drop one first'); return; }
      if (roundTaken(r.team, r.round, r.name)) {
        var clash = teamPicks(r.team).filter(function (p) { return Number(p.round) === Number(r.round); })[0];
        say(r.team, 'Round ' + r.round + ' is already used by ' + (clash ? clash.name : 'another keeper'));
        return;
      }
      list.push({ name: r.name, pos: r.pos, round: r.round });
    }

    var before = teamPicks(r.team);
    picks[r.team] = list;               // optimistic
    repaint();
    say(r.team, 'saving…');

    var payload = { action: 'keeper_save', token: WPIAL_AUTH.token(), players: JSON.stringify(list) };
    if (user.is_commish && user.team !== r.team) payload.team = r.team;

    post(payload).then(function (res) {
      if (res && res.ok) {
        picks[r.team] = res.players || list;
        repaint();
        say(r.team, 'saved');
      } else {
        picks[r.team] = before;         // roll back
        repaint();
        say(r.team, (res && res.error) || 'could not save');
      }
    }).catch(function () {
      picks[r.team] = before;
      repaint();
      say(r.team, 'network error — not saved');
    });
  }

  /* ---------- boot ---------- */
  function load() {
    return fetch(API + '?action=keepers_v2').then(function (r) { return r.json(); })
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

  function start(u) {
    user = u;
    if (!scanBoard().length) return;      // not the rosters page
    load().then(function () { repaint(); });
  }

  if (window.WPIAL_AUTH && WPIAL_AUTH.ready) {
    WPIAL_AUTH.ready(start);
  } else {
    document.addEventListener('wpial-auth', function (e) { start(e.detail); });
  }
})();
