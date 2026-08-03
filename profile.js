/**
 * profile.js — the owner profile editor.
 *
 * WHAT AN OWNER CONTROLS: first name, motto, three team colours, their logo (builder,
 * upload or AI) and their jersey. NOT the team name — that comes from ESPN, hourly, so
 * there is no field for it and no way for the site and ESPN to disagree.
 *
 * SAVING is ambient: 900ms after the last change, one PATCH of only the fields that
 * actually changed. Optimistic, with snapshot-and-rollback on failure, preferring the
 * server's echo over the local copy — the same shape keepers.js uses.
 *
 * CONTRAST is warn, never block. Telling somebody their team colours are illegal is the
 * wrong product. The rule is on text PLACEMENT: --fx-ink is whichever of dark/light
 * actually wins, and where even the winner loses we stop putting text on that colour.
 *
 * Everything renders through WPIAL_FX so the logo and colours an owner picks here show
 * up identically on the roster grid, the draft board and every chip on the site.
 */
(function () {
  'use strict';

  var API = 'https://script.google.com/macros/s/AKfycbxX-UpCAd7oeWug1KcnMZrSnMJyVuob_qHtSv0z1C7im7MpUMgHYMOtdvOKl98VXy37eA/exec';
  var SAVE_DELAY = 900;
  var DRAFT_KEY = 'wpial_profile_draft_v1';
  var UPLOAD_PX = 256;
  var TARGET_CHARS = 20000;     // aim under this
  var HARD_CHARS = 32000;       // server refuses above this

  var $ = function (s) { return document.querySelector(s); };
  var FX = null, me = null, fid = null;
  var st = null;                 // working copy
  var saved = null;              // last known server copy
  var saveTimer = null, pending = {}, busy = false;

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

  /* ---------- save state: glyph AND word, never colour alone ---------- */
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
        ':1, under the 4.5:1 bar. Your colour is kept; the site just stops putting text on ' +
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

    $('#bPreview').innerHTML = FX.logoSVG(logoSpec());
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
    $('#cPrompt').textContent = ($('#fPrompt').value || '').length + ' / 200';

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
  function touch(patch) {
    Object.keys(patch).forEach(function (k) { pending[k] = patch[k]; });
    try { localStorage.setItem(DRAFT_KEY, JSON.stringify(st)); } catch (e) {}
    paint();
    setSave('saving');
    clearTimeout(saveTimer);
    saveTimer = setTimeout(flush, SAVE_DELAY);
  }

  function flush() {
    if (busy) { clearTimeout(saveTimer); saveTimer = setTimeout(flush, 250); return; }
    var body = pending; pending = {};
    if (!Object.keys(body).length) { setSave('saved'); return; }
    var snapshot = JSON.parse(JSON.stringify(saved));
    busy = true;
    body.action = 'profile_save';
    body.token = token();
    if (me && me.is_commish && fid !== (me.fid || '')) body.fid = fid;

    post(body).then(function (r) {
      busy = false;
      if (r && r.ok && r.profile) {
        saved = r.profile;                       // prefer the server's echo
        /* ...but only let it drive the UI when nothing newer is already queued. A fast
           second edit must not be reverted by the echo of the first one. */
        if (!Object.keys(pending).length) adopt(saved, true);
        setSave('saved');
        try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
      } else {
        /* Server prose, rendered raw — name_taken, throttled, bad_payload, forbidden,
           read_only, too_big all arrive as sentences written for a human. */
        if (r && r.code === 'bad_token') { setSave('error', 'Session expired — reloading.'); setTimeout(function () { location.reload(); }, 1200); return; }
        saved = snapshot; adopt(saved, true);
        setSave('error', (r && r.error) || 'Could not save.');
      }
    }).catch(function () {
      busy = false;
      setSave('offline');                        // kept locally; the draft key survives
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
    paint();
  }

  function syncInputs() {
    $('#fFirst').value = st.first_name;
    $('#fMotto').value = st.motto;
    $('#cP').value = st.colors.primary;
    $('#cS').value = st.colors.secondary;
    $('#cA').value = st.colors.accent;
    $('#fMono').value = st.mono;
    $('#fNum').value = st.jersey.number;
    $('#fWord').value = st.jersey.wordmark;
    $('#fSleeve').value = st.jersey.sleeves;
  }

  function saveLogo() {
    if (st.logo_kind === 'builder') {
      touch({ logo_kind: 'builder', logo_data: JSON.stringify({
        shape: st.shape, icon: st.icon, mono: st.mono, useMono: st.useMono }) });
    }
  }
  function saveJersey() { touch({ jersey_json: JSON.stringify(st.jersey) }); }

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
  function buildChips() {
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
      st.icon = b.dataset.id; st.useMono = false; st.logo_kind = 'builder'; saveLogo();
    };

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
      touch({ color_primary: p.p, color_secondary: p.s, color_accent: p.a });
    };

    $('#fillRow').innerHTML =
      '<button type="button" disabled><i style="background:var(--fx-primary)"></i>Fill = primary</button>' +
      '<button type="button" disabled><i style="background:var(--fx-secondary)"></i>Ink = secondary</button>' +
      '<button type="button" disabled><i style="background:var(--fx-accent)"></i>Ring = accent</button>';

    $('#jerseys').innerHTML = [['classic','Classic'],['throwback','Throwback'],['colorrush','Color Rush'],['pinstripe','Pinstripe']]
      .map(function (t) { return '<button type="button" data-id="' + t[0] + '"><span class="j"></span>' + t[1] + '</button>'; }).join('');
    $('#jerseys').onclick = function (e) {
      var b = e.target.closest('button[data-id]'); if (!b) return;
      st.jersey.template = b.dataset.id; saveJersey();
    };
  }

  function wire() {
    $('#fFirst').oninput = function () { st.first_name = this.value; touch({ first_name: this.value }); };
    $('#fMotto').oninput = function () { st.motto = this.value; touch({ motto: this.value }); };
    ['P', 'S', 'A'].forEach(function (k) {
      var key = k === 'P' ? 'primary' : (k === 'S' ? 'secondary' : 'accent');
      $('#c' + k).oninput = function () {
        st.colors[key] = this.value;
        var patch = {}; patch['color_' + key] = this.value;
        touch(patch);
      };
    });
    $('#fMono').oninput = function () {
      st.mono = this.value.toUpperCase();
      st.useMono = !!st.mono;
      st.logo_kind = 'builder';
      saveLogo();
    };
    $('#fMono').onfocus = function () { if (st.mono) { st.useMono = true; saveLogo(); } };
    $('#fNum').oninput = function () {
      st.jersey.number = this.value.replace(/[^0-9]/g, '').slice(0, 2); saveJersey();
    };
    $('#fWord').oninput = function () { st.jersey.wordmark = this.value.toUpperCase(); saveJersey(); };
    $('#fSleeve').onchange = function () { st.jersey.sleeves = this.value; saveJersey(); };

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
        touch({ logo_kind: 'upload', logo_data: durl });
      }).catch(function (err) {
        $('#uNote').textContent = err.message;
        setSave('error', err.message);
      });
    };

    /* AI stays visibly disabled until the endpoint is confirmed live, rather than
       pretending to work. Design drew this state on purpose. */
    var aiTab = document.querySelector('#logoTabs button[data-pane="ai"]');
    aiTab.disabled = true;
    $('#genBtn').disabled = true;
    $('#aiNote').textContent = 'The logo generator is warming up — the builder and upload both work today.';
    $('#aiGrid').innerHTML = '<div class="slot">soon</div><div class="slot">soon</div><div class="slot">soon</div><div class="slot">soon</div>';
    $('#fPrompt').oninput = function () { $('#cPrompt').textContent = this.value.length + ' / 200'; };
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

      /* An unsaved edit that never reached the server survives a refresh. */
      try {
        var d = JSON.parse(localStorage.getItem(DRAFT_KEY) || 'null');
        if (d && d.fid === fid) { st = d; syncInputs(); paint(); setSave('offline'); }
      } catch (e) {}

      buildChips(); wire(); paint();
      $('#gate').hidden = true;
      $('#app').hidden = false;
      setSave('saved');
    });
  }

  if (window.WPIAL_AUTH && WPIAL_AUTH.ready) WPIAL_AUTH.ready(start);
  else document.addEventListener('wpial-auth', function (e) { start(e.detail); });
  /** FX.ready() fires as soon as the registry is USABLE — baked-in defaults plus cache.
   *  The token-gated profiles_all response lands later, and it is the one carrying first
   *  names, saved colours and logos. So the real data arrives on 'wpial-profiles', not on
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
