/**
 * profile.js — the owner profile editor.
 *
 * WHAT AN OWNER CONTROLS: first name, motto, three team colors, their logo (builder or
 * upload) and their jersey. NOT the team name — that comes from ESPN, hourly, so
 * there is no field for it and no way for the site and ESPN to disagree.
 *
 * SAVING IS AUTOMATIC, and the safety net is UNDO rather than a Save button.
 *
 * The explicit-Save version shipped first and was wrong on a phone: the sticky action bar
 * got clipped by the browser chrome, so the Save button was unreachable and all you could
 * see were two labels disagreeing with each other. A save affordance you cannot reach is
 * worse than no save affordance at all.
 *
 * So: changes save themselves 900ms after you stop, and the real answer to "I made a
 * mistake" is UNDO — multi-level, not one-deep, because people notice a mistake three
 * clicks after they make it, not immediately. RESET returns the franchise to league
 * defaults, and because reset is itself pushed onto the undo stack, even that is
 * recoverable.
 *
 * One status indicator, never two. The previous build could show "Saved" and "Unsaved
 * changes" at the same time.
 *
 * CONTRAST is warn, never block. Telling somebody their team colors are illegal is the
 * wrong product. The rule is on text PLACEMENT: --fx-ink is whichever of dark/light
 * actually wins, and where even the winner loses we stop putting text on that color.
 *
 * Everything renders through WPIAL_FX so the logo and colors an owner picks here show
 * up identically on the roster grid, the draft board and every chip on the site.
 */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var SAVE_DELAY = 900;
  var UPLOAD_PX = 256;
  var TARGET_CHARS = 20000;     // aim under this
  var HARD_CHARS = 32000;       // server refuses above this

  var $ = function (s) { return document.querySelector(s); };
  var FX = null, me = null, fid = null;
  var st = null;                 // working copy
  var saved = null;              // last known server copy
  var pending = {}, busy = false;
  var saveTimer = null;
  var undoStack = [];            // snapshots of `st`, newest last
  var baseline = null;           // st as of the last recorded undo point
  var lastKey = null, lastPush = 0;
  var UNDO_MAX = 30;
  var COALESCE_MS = 1200;        // typing in one field is one undo step, not twenty

  function post(params) {
    var b = new URLSearchParams();
    Object.keys(params).forEach(function (k) { b.append(k, params[k]); });
    return fetch(API, { method: 'POST', body: b }).then(function (r) { return r.json(); });
  }
  function token() {
    try { return (window.WPIAL_AUTH && WPIAL_AUTH.token && WPIAL_AUTH.token()) || ''; } catch (e) { return ''; }
  }
  function esc(t) {
    return String(t == null ? '' : t).replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- save state: glyph AND word, never color alone ---------- */
  var SAVE_UI = {
    saved:   ['✓', 'Saved'],
    saving:  ['↻', 'Saving…'],
    offline: ['⌁', 'Offline — kept on this device'],
    error:   ['!', '']
  };
  function setSave(kind, msg) {
    var el = $('#saveState');
    if (!el) return;
    var u = SAVE_UI[kind] || SAVE_UI.saved;
    el.className = 'save ' + kind;
    el.innerHTML = '<span class="g">' + u[0] + '</span> ' + esc(msg || u[1]);
  }

  /* ---------- contrast ---------- */
  function ratio(a, b) { return FX.contrast.ratio(a, b); }
  function ink(hex) { return FX.contrast.ink(hex); }

  function paintContrast() {
    var p = st.colors.primary;
    var i = ink(p), r = ratio(p, i);
    document.documentElement.style.setProperty('--fx-primary', p);
    document.documentElement.style.setProperty('--fx-secondary', st.colors.secondary);
    document.documentElement.style.setProperty('--fx-accent', st.colors.accent);
    document.documentElement.style.setProperty('--fx-ink', i);
    var box = $('#contrast'), txt = $('#contrastText');
    var dark = i === '#0d1117';
    if (r >= 4.5) {
      box.className = 'contrast';
      txt.innerHTML = '<b>Passes</b> — ' + (dark ? 'dark' : 'light') + ' ink on your primary, ' +
        r.toFixed(1) + ':1. Picked for you automatically.';
    } else {
      box.className = 'contrast warn';
      txt.innerHTML = '<b>Low contrast</b> — best available is ' + r.toFixed(1) +
        ':1, under the 4.5:1 bar. Your color is kept; the site just stops putting text on ' +
        'it and uses it as a bar and a ring instead.';
    }
  }

  /* ---------- the working spec ---------- */
  function logoSpec() {
    return {
      shape: st.shape, icon: st.icon, mono: st.mono, useMono: st.useMono,
      bg: st.colors.primary, fg: st.colors.secondary, ring: st.colors.accent
    };
  }
  function jerseySpec() {
    return {
      template: st.jersey.template, number: st.jersey.number, wordmark: st.jersey.wordmark,
      sleeves: st.jersey.sleeves,
      primary: st.colors.primary, secondary: st.colors.secondary, accent: st.colors.accent
    };
  }
  /** What the rest of the site would render for this franchise right now. */
  function liveLogoHTML(px) {
    if ((st.logo_kind === 'upload' || st.logo_kind === 'ai') && st.logo_data &&
        /^data:image\/(png|jpeg|webp);base64,/.test(st.logo_data)) {
      return '<img alt="" src="' + st.logo_data + '" style="width:' + px + 'px;height:' + px +
        'px;display:block;border-radius:50%">';
    }
    if (st.logo_kind === 'builder') {
      return '<span style="display:inline-block;width:' + px + 'px;height:' + px + 'px">' +
        FX.logoSVG(logoSpec()) + '</span>';
    }
    return FX.logoHTML(fid, px);
  }

  /* ---------- render ---------- */
  function paint() {
    paintContrast();

    $('#heroLogo').innerHTML = liveLogoHTML(104);
    $('#heroName').textContent = st.team_name;
    var bits = [];
    if (st.first_name) bits.push(st.first_name);
    if (me && me.is_commish) bits.push('Commissioner');
    $('#heroMeta').textContent = bits.join(' · ');
    $('#heroMotto').textContent = st.motto ? '“' + st.motto + '”' : '';

    var fw = $('#heroFormerly');
    if (st.prior_names && st.prior_names.length) {
      fw.hidden = false;
      fw.innerHTML = '<b>Formerly</b> ' + esc(st.prior_names.slice().reverse().join(' ← '));
    } else { fw.hidden = true; }

    $('#fTeam').textContent = st.team_name;

    var ol = $('#lineage'), chain = (st.prior_names || []).slice();
    ol.innerHTML = '<li class="now">' + esc(st.team_name) + '</li>' +
      chain.reverse().map(function (n) { return '<li>' + esc(n) + '</li>'; }).join('');
    $('#lineageWrap').hidden = !chain.length;

    $('#hP').textContent = st.colors.primary.toUpperCase();
    $('#hS').textContent = st.colors.secondary.toUpperCase();
    $('#hA').textContent = st.colors.accent.toUpperCase();

    if (HAS_LOGO_UI) $('#bPreview').innerHTML = FX.logoSVG(logoSpec());
    document.querySelectorAll('#shapeChips button').forEach(function (b) {
      b.classList.toggle('on', !st.useMono && b.dataset.id === st.shape);
    });
    document.querySelectorAll('#iconChips button').forEach(function (b) {
      b.classList.toggle('on', !st.useMono && b.dataset.id === st.icon);
    });

    document.querySelectorAll('#jerseys button').forEach(function (b) {
      b.classList.toggle('on', b.dataset.id === st.jersey.template);
      b.querySelector('.j').innerHTML = FX.jerseySVG(
        { template: b.dataset.id, number: st.jersey.number, wordmark: st.jersey.wordmark,
          sleeves: st.jersey.sleeves, primary: st.colors.primary,
          secondary: st.colors.secondary, accent: st.colors.accent });
    });

    $('#cMotto').textContent = (st.motto || '').length + ' / 60';
    $('#cWord').textContent = (st.jersey.wordmark || '').length + ' / 10';

    paintSeen();
  }

  /** The preview rail. Every element must look right with a first name ABSENT and must
      not move when it appears — that is the whole point of showing it here. */
  function paintSeen() {
    var chip = st.first_name ? '<span class="ownerChip">' + esc(st.first_name) + '</span>' : '';
    $('#seen').innerHTML =
      '<div class="seenItem"><span class="chipLogo" style="width:24px;height:24px">' + liveLogoHTML(24) +
        '</span><span class="chipName">' + esc(st.team_name) + '</span>' +
        (st.first_name ? '<span class="sub" style="margin:0">· ' + esc(st.first_name) + '</span>' : '') +
        '<span class="cap">chip</span></div>' +
      '<div class="seenItem" style="border-left:3px solid var(--fx-primary)">' +
        '<span class="chipLogo" style="width:30px;height:30px">' + liveLogoHTML(30) +
        '</span><span class="chipName">' + esc(st.team_name) + '</span>' + chip +
        '<span class="cap">roster</span></div>' +
      '<div class="seenItem"><span class="dbHead"><b>' + esc(st.team_name) + '</b>' +
        '<span>' + esc(st.first_name || '') + '</span></span><span class="cap">draft board</span></div>';
  }

  /* ---------- change plumbing ---------- */
  function isDirty() { return !!Object.keys(pending).length; }

  function snap() { return JSON.parse(JSON.stringify(st)); }

  /** Push the state as it was BEFORE this change.
   *
   *  Deliberately uses `baseline` rather than the live `st`: most handlers mutate `st`
   *  first and then call mark(), so snapshotting `st` here captured the change we were
   *  trying to be able to undo — undo came out one step behind. `baseline` is only
   *  advanced once a change has been recorded, so it is always the previous state.
   *
   *  Consecutive edits to the same field inside COALESCE_MS collapse into one step,
   *  otherwise typing a seven-letter wordmark would cost seven undos. */
  function pushUndo(key) {
    var now = Date.now();
    if (key && key === lastKey && (now - lastPush) < COALESCE_MS) { lastPush = now; return; }
    if (baseline) {
      undoStack.push(baseline);
      if (undoStack.length > UNDO_MAX) undoStack.shift();
    }
    lastKey = key; lastPush = now;
  }

  /** Record a change and queue the autosave. */
  function mark(patch) {
    var keys = Object.keys(patch);
    pushUndo(keys.join(','));
    baseline = snap();
    keys.forEach(function (k) { pending[k] = patch[k]; });
    paint();
    setSave('saving');
    paintActions();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  /** Apply a whole state object and persist every field it covers. Used by undo and
   *  reset, which both move more than one field at a time. */
  function applyState(next, label) {
    st = JSON.parse(JSON.stringify(next));
    syncInputs();
    paint();
    pending = {
      first_name: st.first_name,
      motto: st.motto,
      color_primary: st.colors.primary,
      color_secondary: st.colors.secondary,
      color_accent: st.colors.accent,
      logo_kind: st.logo_kind,
      logo_data: st.logo_kind === 'builder'
        ? JSON.stringify({ shape: st.shape, icon: st.icon, mono: st.mono, useMono: st.useMono })
        : st.logo_data,
      jersey_json: JSON.stringify(st.jersey)
    };
    lastKey = null;
    setSave('saving', label);
    paintActions();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, 250);
  }

  function undo() {
    if (!undoStack.length) return;
    applyState(undoStack.pop(), 'Undoing…');
    baseline = snap();
    lastKey = null;
    paintActions();
  }

  /** Back to what the league gave you: default logo, franchise colors, no motto,
   *  stock jersey. Pushed onto the undo stack first, so it is not a one-way door. */
  function resetToDefaults() {
    if (!FX) return;
    var base = FX.byId(fid);
    undoStack.push(snap());
    if (undoStack.length > UNDO_MAX) undoStack.shift();
    applyState({
      fid: st.fid, team_name: st.team_name, prior_names: st.prior_names,
      first_name: st.first_name,                 // a person's name is not decoration
      motto: '',
      colors: {
        primary: base.colors.primary, secondary: base.colors.secondary, accent: base.colors.accent
      },
      logo_kind: 'default', logo_data: '',
      shape: 'shield', icon: 'football', mono: '', useMono: false,
      /* f01 -> 1, not 01: the number field is a jersey number, not a franchise id. */
      jersey: { template: 'classic', number: fid.replace(/[^0-9]/g, '').replace(/^0+(?=\d)/, ''), wordmark: '', sleeves: 'stripe' }
    }, 'Reset…');
    baseline = snap();
    lastKey = null;
  }

  function paintActions() {
    var u = $('#undoBtn');
    if (u) { u.disabled = !undoStack.length; u.hidden = false; }
    var r = $('#resetBtn');
    if (r) r.hidden = false;
  }

  function flush() {
    if (busy) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250); return; }
    var keys = Object.keys(pending);
    if (!keys.length) { setSave('saved'); return; }
    var body = {};
    keys.forEach(function (k) { body[k] = pending[k]; });
    busy = true;
    setSave('saving');
    body.action = 'profile_save';
    body.token = token();
    if (me && me.is_commish && fid !== (me.fid || '')) body.fid = fid;

    post(body).then(function (r) {
      busy = false;
      if (r && r.ok && r.profile) {
        keys.forEach(function (k) { delete pending[k]; });
        saved = r.profile;
        if (!isDirty()) setSave('saved');
      } else {
        if (r && r.code === 'bad_token') {
          setSave('error', 'Session expired — reloading.');
          setTimeout(function () { location.reload(); }, 1400);
          return;
        }
        /* Keep the change on screen and in `pending`. Undo is how you back out of a
           rejected edit — silently reverting it would be the surprising thing. */
        setSave('error', (r && r.error) || 'Could not save — press undo to back it out.');
      }
      paintActions();
    }).catch(function () {
      busy = false;
      setSave('offline');
      paintActions();
    });
  }

  /** Load a server profile into the working copy. */
  function adopt(p, keepFocus) {
    var j = p.jersey || {};
    var spec = {};
    if (p.logo_kind === 'builder' && p.logo_data) { try { spec = JSON.parse(p.logo_data); } catch (e) { spec = {}; } }
    st = {
      fid: p.fid, team_name: p.team_name, prior_names: p.prior_names || [],
      first_name: p.first_name || '', motto: p.motto || '',
      colors: {
        primary: p.colors.primary, secondary: p.colors.secondary, accent: p.colors.accent
      },
      logo_kind: p.logo_kind || 'default',
      logo_data: p.logo_data || '',
      shape: spec.shape || 'shield',
      icon: spec.icon || 'football',
      mono: spec.mono || '',
      useMono: !!spec.useMono,
      jersey: {
        template: j.template || 'classic',
        number: j.number || '00',
        wordmark: j.wordmark || '',
        sleeves: j.sleeves || 'stripe'
      }
    };
    if (!keepFocus) syncInputs();
    baseline = snap();
    paint();
  }

  function syncInputs() {
    $('#fFirst').value = st.first_name;
    $('#fMotto').value = st.motto;
    $('#cP').value = st.colors.primary;
    $('#cS').value = st.colors.secondary;
    $('#cA').value = st.colors.accent;
    if (HAS_LOGO_UI) $('#fMono').value = st.mono;
    $('#fNum').value = st.jersey.number;
    $('#fWord').value = st.jersey.wordmark;
    $('#fSleeve').value = st.jersey.sleeves;
  }

  /** Touching ANY builder control switches you to the builder. Previously this bailed
   *  out unless logo_kind was already 'builder', and only the icon handler set that — so
   *  clicking a shape first did nothing at all, and you had to click around before the
   *  logo would move. That was the "took a few clicks" bug. */
  function saveLogo() {
    st.logo_kind = 'builder';
    mark({ logo_kind: 'builder', logo_data: JSON.stringify({
      shape: st.shape, icon: st.icon, mono: st.mono, useMono: st.useMono }) });
  }
  function saveJersey() { mark({ jersey_json: JSON.stringify(st.jersey) }); }

  /* ---------- upload: raster only, downscaled in the browser ---------- */
  function shrink(file) {
    return new Promise(function (resolve, reject) {
      if (!/^image\/(png|jpeg|webp)$/.test(file.type)) return reject(new Error('PNG, JPEG or WebP only.'));
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        URL.revokeObjectURL(url);
        var side = Math.min(img.width, img.height);
        var cv = document.createElement('canvas');
        cv.width = cv.height = UPLOAD_PX;
        var cx = cv.getContext('2d');
        cx.drawImage(img, (img.width - side) / 2, (img.height - side) / 2, side, side, 0, 0, UPLOAD_PX, UPLOAD_PX);
        var attempts = [['image/webp', 0.8], ['image/webp', 0.65], ['image/webp', 0.5], ['image/png', 0.8]];
        for (var i = 0; i < attempts.length; i++) {
          var out = cv.toDataURL(attempts[i][0], attempts[i][1]);
          if (out.indexOf('data:image/') === 0 && out.length <= TARGET_CHARS) return resolve(out);
        }
        var last = cv.toDataURL('image/webp', 0.5);
        if (last.length <= HARD_CHARS) return resolve(last);
        reject(new Error('That image will not compress small enough — try a simpler one, or use the builder.'));
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error('That file is not an image we can read.')); };
      img.src = url;
    });
  }

  /* ---------- build the controls ---------- */
  /* The logo builder was removed from profile.html on 2026-08-06 (Bryan: "remove
     logos from profile section"). Everything about the logo MODEL is untouched —
     logo_kind / logo_data still round-trip to the sheet, and franchise.js still
     renders whatever is stored — so restoring the feature is purely putting the
     markup back.

     This flag guards the ~10 places that assume the editor's elements exist.
     Without it, one null deref takes the WHOLE profile page down with it: colors,
     jersey, motto and save state are all in the same script. */
  var HAS_LOGO_UI = !!document.getElementById('logoTabs');

  function buildChips() {
    if (HAS_LOGO_UI) {
    $('#shapeChips').innerHTML = FX.shapes().map(function (s) {
      return '<button type="button" data-id="' + s.id + '" title="' + s.id + '" aria-label="' + s.id + '">' +
        '<svg viewBox="0 0 64 64"><path d="' + s.d64 + '" fill="none" stroke="currentColor" stroke-width="4"/></svg></button>';
    }).join('');
    $('#iconChips').innerHTML = FX.icons().map(function (ic) {
      var paths = ic.ps.map(function (p) {
        return '<path d="' + p.d + '"' + (p.t ? ' transform="' + p.t + '"' : '') + ' fill="currentColor"/>';
      }).join('');
      return '<button type="button" data-id="' + ic.id + '" title="' + ic.id + '" aria-label="' + ic.id + '">' +
        '<svg viewBox="0 0 24 24">' + paths + '</svg></button>';
    }).join('');

    $('#shapeChips').onclick = function (e) {
      var b = e.target.closest('button[data-id]'); if (!b) return;
      st.shape = b.dataset.id; saveLogo();
    };
    $('#iconChips').onclick = function (e) {
      var b = e.target.closest('button[data-id]'); if (!b) return;
      st.icon = b.dataset.id; st.useMono = false; saveLogo();
    };
    }

    $('#presets').innerHTML = FX.presets().map(function (p, i) {
      return '<button type="button" data-i="' + i + '"><span class="sw">' +
        '<i style="background:' + p.p + '"></i><i style="background:' + p.s + '"></i><i style="background:' + p.a + '"></i>' +
        '</span>' + esc(p.name) + '</button>';
    }).join('');
    $('#presets').onclick = function (e) {
      var b = e.target.closest('button[data-i]'); if (!b) return;
      var p = FX.presets()[+b.dataset.i];
      st.colors = { primary: p.p, secondary: p.s, accent: p.a };
      syncInputs();
      mark({ color_primary: p.p, color_secondary: p.s, color_accent: p.a });
    };

    if (HAS_LOGO_UI) {
      $('#fillRow').innerHTML =
        '<button type="button" disabled><i style="background:var(--fx-primary)"></i>Fill = primary</button>' +
        '<button type="button" disabled><i style="background:var(--fx-secondary)"></i>Ink = secondary</button>' +
        '<button type="button" disabled><i style="background:var(--fx-accent)"></i>Ring = accent</button>';
    }

    $('#jerseys').innerHTML = [['classic','Classic'],['throwback','Throwback'],['colorrush','Color Rush'],['pinstripe','Pinstripe']]
      .map(function (t) { return '<button type="button" data-id="' + t[0] + '"><span class="j"></span>' + t[1] + '</button>'; }).join('');
    $('#jerseys').onclick = function (e) {
      var b = e.target.closest('button[data-id]'); if (!b) return;
      st.jersey.template = b.dataset.id; saveJersey();
    };
  }

  function wire() {
    $('#fFirst').oninput = function () { st.first_name = this.value; mark({ first_name: this.value }); };
    $('#fMotto').oninput = function () { st.motto = this.value; mark({ motto: this.value }); };
    ['P', 'S', 'A'].forEach(function (k) {
      var key = k === 'P' ? 'primary' : (k === 'S' ? 'secondary' : 'accent');
      $('#c' + k).oninput = function () {
        st.colors[key] = this.value;
        var patch = {}; patch['color_' + key] = this.value;
        mark(patch);
      };
    });
    if (HAS_LOGO_UI) {
      $('#fMono').oninput = function () {
        st.mono = this.value.toUpperCase();
        st.useMono = !!st.mono;
        saveLogo();
      };
      $('#fMono').onfocus = function () { if (st.mono) { st.useMono = true; saveLogo(); } };
    }
    $('#fNum').oninput = function () {
      st.jersey.number = this.value.replace(/[^0-9]/g, '').slice(0, 2); saveJersey();
    };
    $('#fWord').oninput = function () { st.jersey.wordmark = this.value.toUpperCase(); saveJersey(); };
    $('#fSleeve').onchange = function () { st.jersey.sleeves = this.value; saveJersey(); };

    $('#undoBtn').onclick = undo;
    $('#resetBtn').onclick = resetToDefaults;

    if (HAS_LOGO_UI) {
    $('#logoTabs').onclick = function (e) {
      var b = e.target.closest('button[data-pane]'); if (!b || b.disabled) return;
      document.querySelectorAll('#logoTabs button').forEach(function (x) { x.classList.toggle('on', x === b); });
      document.querySelectorAll('.pane').forEach(function (p) { p.classList.toggle('on', p.dataset.pane === b.dataset.pane); });
    };

    $('#fFile').onchange = function () {
      var f = this.files && this.files[0]; if (!f) return;
      $('#uNote').textContent = 'Resizing…';
      shrink(f).then(function (durl) {
        st.logo_kind = 'upload'; st.logo_data = durl;
        $('#uPreview').innerHTML = '<img alt="" src="' + durl + '" style="width:64px;height:64px;border-radius:50%;display:block">';
        $('#uNote').textContent = 'Resized to ' + UPLOAD_PX + '×' + UPLOAD_PX + ' — ' + Math.round(durl.length / 1024) + ' KB.';
        mark({ logo_kind: 'upload', logo_data: durl });
      }).catch(function (err) {
        $('#uNote').textContent = err.message;
        setSave('error', err.message);
      });
    };
    }

  }

  /* ---------- boot ---------- */
  function start(user) {
    me = user || window.WPIAL_USER || null;
    FX = window.WPIAL_FX;
    if (!FX) { $('#gate').textContent = 'Franchise registry did not load — refresh the page.'; return; }

    FX.ready(function () {
      fid = (me && me.fid) || FX.resolve(me && me.team) || null;
      if (!fid) {
        $('#gate').innerHTML = 'We could not work out which franchise you own. Text the commish.';
        return;
      }
      var p = FX.byId(fid);
      if (!p) { $('#gate').textContent = 'Franchise not found.'; return; }

      saved = {
        fid: p.fid, team_name: p.name, prior_names: p.priors, first_name: p.first,
        motto: p.motto || '', colors: p.colors, logo_kind: p.logo_kind,
        logo_data: p.logo_data, jersey: p.jersey
      };
      adopt(saved, false);

      buildChips(); wire(); paint();
      $('#gate').hidden = true;
      $('#app').hidden = false;
      setSave('saved');
      paintActions();
    });
  }

  if (window.WPIAL_AUTH && WPIAL_AUTH.ready) WPIAL_AUTH.ready(start);
  else document.addEventListener('wpial-auth', function (e) { start(e.detail); });
  /** FX.ready() fires as soon as the registry is USABLE — baked-in defaults plus cache.
   *  The token-gated profiles_all response lands later, and it is the one carrying first
   *  names, saved colors and logos. So the real data arrives on 'wpial-profiles', not on
   *  ready(), and this is where the page picks it up. */
  document.addEventListener('wpial-profiles', function () {
    if (!st || !FX || !fid) return;
    var p = FX.byId(fid);
    if (!p) return;
    var fresh = {
      fid: p.fid, team_name: p.name, prior_names: p.priors, first_name: p.first,
      motto: p.motto || '', colors: p.colors, logo_kind: p.logo_kind,
      logo_data: p.logo_data, jersey: p.jersey
    };
    saved = fresh;
    /* Never stomp an edit in flight or an unsaved local draft. When the owner is idle
       we take the server's word for everything; when they are typing we take only the
       name and lineage, which they cannot edit anyway. */
    var dirty = Object.keys(pending).length || busy;
    if (!dirty) { adopt(fresh, false); return; }
    if (p.name !== st.team_name) { st.team_name = p.name; st.prior_names = p.priors; paint(); }
  });
})();
