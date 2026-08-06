/* ============================================================================
 * sitenav.js — the shared nav strip AND the identity menu, for every page.
 * ----------------------------------------------------------------------------
 * WHAT CHANGED (2026-08-06) AND WHY
 *
 * The bar used to mix four different kinds of thing, all wearing the same pill:
 *   1. league content tabs      2. destinations (Draftboard, Commish)
 *   3. account (team name, My Profile, log out — three separate pills)
 *   4. a preference (Colorblind mode) — which, filled bright yellow, was the
 *      LOUDEST element on the bar despite being a set-once toggle. It visually
 *      outranked the Draftboard three weeks before the draft.
 *
 * On a phone that was 11 pills wrapping into ~5 rows, on a page whose whole job
 * is to show you a board.
 *
 * Now: everything ABOUT THE SITE is in the nav. Everything ABOUT YOU is behind
 * one identity chip — the standard account-avatar pattern, so it needs no
 * explaining. Colorblind mode lives in that menu under "View options".
 *
 * On a phone the nav collapses into a sheet behind a ☰ button, so the header is
 * one row: brand + chip. That is the "maximize the screen" requirement.
 *
 * THE THREE CONSTRAINTS THIS FILE LIVES UNDER (all learned the hard way)
 *
 *   - index.html's <nav> is HARDCODED and its inline script binds
 *     `nav button[data-tab]`. Extend it; never rebuild it. (gotcha 33-B)
 *   - The injected strip is a `div role="navigation"`, NOT a <nav>. auth.js
 *     parks its sign-out chip in `querySelector('nav') || .hdr-right`, so a real
 *     <nav> races it. (gotcha 15)
 *   - Header height is published as --hdr-h from a MEASUREMENT. Never a pixel
 *     constant — the draft board sizes its board pane and sticky sidebar off it,
 *     and two hardcoded 96px constants broke silently last time. (gotcha 33-A)
 *
 * The identity chip ABSORBS auth.js's chip rather than layering over it: auth.js
 * still builds `#wpial-chip`, we hide it and read `WPIAL_USER` ourselves. Trying
 * to stop auth.js from building it would mean editing the auth flow, which is
 * the one thing that must not break on draft night.
 *
 * ES5 only.
 * ==========================================================================*/
(function () {
  'use strict';

  /* ---------------------------------------------------------------------
   * 1. The nav. One source of truth, shared by every page.
   *    `tab`  — section id on index.html (null for a standalone page)
   *    `page` — where the link points
   * ------------------------------------------------------------------ */
  /* Rosters and Round Values is a PRE-DRAFT surface. It shows 2026 keeper round
     values and it is where owners declare keepers; once the draft has run, both are
     history and the numbers on it are last season's. Bryan, 2026-08-06: it "will go
     away after the draft, just hide it" — it comes back populated with end-of-year
     ESPN rosters for the next keeper session, so this hides the tab rather than
     deleting the section or its data.

     Change this one constant to move the date. It is 6am Mountain the morning after
     the draft, deliberately NOT the draft start time: hiding the tab out from under
     someone mid-draft, while the board is live, is worse than a day of staleness.

     It hides BOTH the nav entry and the section — an orphaned #rosters link landing
     on stale round values is the failure this is meant to prevent, and a hidden nav
     item alone would leave every bookmark pointing at exactly that. */
  var ROSTERS_RETIRE_AT = Date.parse('2026-08-31T12:00:00Z');   // 6:00am MT, Mon Aug 31
  function rostersRetired() { return Date.now() >= ROSTERS_RETIRE_AT; }

  var NAV = [
    { tab: 'board',      page: 'index.html',      label: 'League News',
      title: 'The Gelly — league news, insider reports and the weekly gazette' },
    { tab: null,         page: 'draftboard.html', label: 'Draftboard',
      title: 'Interactive keeper draftboard — mock drafts, keeper decisions and a full season simulator' },
    { tab: 'rosters',    page: 'index.html',      label: 'Rosters and Round Values',
      title: 'Every roster with its 2026 keeper round values — declare your keepers here',
      retires: true },
    { tab: null,         page: 'roster.html',     label: 'Depth Chart',
      title: 'Your team by position after the draft — starters, flex and bench' },
    { tab: 'schedule',   page: 'index.html',      label: '2026 NFL Schedule' },
    { tab: 'scoreboard', page: 'index.html',      label: 'Scoreboard' },
    { tab: 'standings',  page: 'index.html',      label: 'Standings' },
    /* Reference, not week-to-week. Bryan, 2026-08-06: both go after Standings —
       they are the things you look up once, not the things you check on Sunday. */
    { tab: 'rules',      page: 'index.html',      label: 'Rules',
      title: 'Keeper rules and the league constitution' },
    { tab: 'history',    page: 'index.html',      label: 'League History' }
  ];

  /* Keepers is deliberately NOT a nav item. Keeper declaration lives inside
     Rosters and Round Values, on the roster card it belongs to — the decision
     and the data it depends on are the same screen. A separate Keepers tab
     would have shown the same cards twice. */

  function navItems() {
    return NAV.filter(function (it) { return !(it.retires && rostersRetired()); });
  }

  /* A retired tab leaves VALID_TABS too, so an old #rosters bookmark falls through
     to the default tab instead of activating a section that is no longer rendered. */
  function validTabs() {
    return navItems().filter(function (it) { return it.tab; }).map(function (it) { return it.tab; });
  }

  /* Commish and My Profile are NOT in NAV any more — they moved into the
     identity menu. matchup.html and roster.html were never in it: you arrive
     from a scoreboard card or a standings row. roster.html is now in it, as
     Depth Chart, because it finally has a name that means something to an owner. */

  function currentPage() {
    var p = (location.pathname || '').toLowerCase();
    if (p.indexOf('draftboard') !== -1) return 'draftboard.html';
    if (p.indexOf('dashboard') !== -1) return 'dashboard.html';
    if (p.indexOf('profile') !== -1) return 'profile.html';
    if (p.indexOf('matchup') !== -1) return 'matchup.html';
    if (p.indexOf('roster') !== -1) return 'roster.html';
    return 'index.html';
  }

  function user() {
    try {
      return window.WPIAL_USER ||
             (window.WPIAL_AUTH && window.WPIAL_AUTH.user && window.WPIAL_AUTH.user()) || null;
    } catch (e) { return null; }
  }

  function isCommish() {
    var u = user();
    return !!(u && (u.is_commish === true || String(u.is_commish).toLowerCase() === 'true'));
  }

  function teamName() {
    var u = user();
    if (!u) return '';
    /* Resolve through the franchise registry, never off a raw name: ESPN names
       drift hourly and one of them ships with a trailing space. */
    try {
      if (u.fid && window.WPIAL_FX && window.WPIAL_FX.canon) return window.WPIAL_FX.canon(u.fid);
    } catch (e) {}
    return u.team || u.canon || '';
  }

  /* Initials for the avatar. "THE Vagitarians" -> TV, "G. O. A. T." -> GO.
     Falls back to a glyph rather than rendering an empty circle — the chip has
     to look like something before identity lands. */
  function initials() {
    var n = teamName();
    if (!n) return '';
    var words = n.replace(/[^A-Za-z0-9 ]/g, ' ').split(/\s+/).filter(Boolean);
    if (!words.length) return '';
    if (words.length === 1) return words[0].slice(0, 2).toUpperCase();
    return (words[0][0] + words[1][0]).toUpperCase();
  }

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------------------------------------------------------------------
   * 2. Styles
   * ------------------------------------------------------------------ */
  function injectStyles() {
    if (document.getElementById('siteNavCss')) return;
    var css = document.createElement('style');
    css.id = 'siteNavCss';
    css.textContent = [
      /* ---- the strip ---- */
      '#siteNav{width:100%;display:flex;gap:6px;align-items:center;padding-top:8px;',
      '  margin-top:6px;border-top:1px solid var(--line);overflow-x:auto;',
      '  -webkit-overflow-scrolling:touch;scrollbar-width:none;}',
      '#siteNav::-webkit-scrollbar{display:none;}',
      '#siteNav a{flex:0 0 auto;background:none;border:1px solid var(--line);',
      '  color:var(--text);padding:5px 12px;border-radius:20px;font-size:12.5px;',
      '  text-decoration:none;white-space:nowrap;font-family:"Barlow",sans-serif;',
      '  transition:border-color .12s ease,color .12s ease;}',
      '#siteNav a:hover{border-color:var(--accent);color:var(--accent2,var(--accent));}',
      '#siteNav a.here{background:var(--accent);border-color:var(--accent);',
      '  color:var(--accent-ink,#14110a);font-weight:700;cursor:default;}',
      '#siteNav a.here:hover{color:var(--accent-ink,#14110a);}',

      /* ---- the identity chip ---- */
      /* The slot owns the alignment. #wpialId must NOT carry margin-left:auto —
         see the note on menuHost(). */
      '#snHdrSlot{display:flex;align-items:center;gap:7px;margin-left:auto;flex:0 0 auto;}',
      '#wpialId{position:relative;flex:0 0 auto;}',
      '#wpialIdBtn{display:inline-flex;align-items:center;gap:8px;background:none;',
      '  border:1px solid var(--line);border-radius:22px;padding:4px 10px 4px 4px;',
      '  color:var(--text);font:inherit;font-size:12.5px;cursor:pointer;max-width:230px;}',
      '#wpialIdBtn:hover{border-color:var(--accent);}',
      '#wpialIdBtn:focus-visible{outline:2px solid var(--accent);outline-offset:2px;}',
      '#wpialIdBtn .av{width:26px;height:26px;border-radius:50%;flex:0 0 auto;',
      '  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:10.5px;',
      '  letter-spacing:.5px;border:1.5px solid var(--accent);color:var(--accent);}',
      '#wpialIdBtn .nm{overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:600;}',
      /* The colorblind marker on the chip. It exists so that turning the mode on
         inside a menu does not feel like it vanished — the state stays visible
         from the outside. */
      '#wpialIdBtn .cb{flex:0 0 auto;font-size:11px;}',
      '#wpialIdBtn .ca{flex:0 0 auto;font-size:9px;color:var(--muted);}',

      /* ---- the dropdown ---- */
      '#wpialIdMenu{position:absolute;right:0;top:calc(100% + 6px);z-index:2147482000;',
      '  min-width:236px;background:var(--panel,var(--card));border:1px solid var(--line);',
      '  border-radius:12px;box-shadow:0 18px 44px rgba(0,0,0,.5);padding:6px;display:none;}',
      '#wpialIdMenu.open{display:block;}',
      '#wpialIdMenu .hd{display:flex;gap:9px;align-items:center;padding:8px 9px 10px;',
      '  border-bottom:1px solid var(--line);margin-bottom:5px;}',
      '#wpialIdMenu .hd .av{width:34px;height:34px;border-radius:50%;flex:0 0 auto;',
      '  display:flex;align-items:center;justify-content:center;font-weight:700;font-size:12px;',
      '  border:2px solid var(--accent);color:var(--accent);}',
      /* Both are spans inside one wrapper, so they need display:block or the team
         name and the owner line run together as "Bijan MustardBryan". */
      '#wpialIdMenu .hd .t{display:block;font-weight:700;font-size:13.5px;line-height:1.2;}',
      '#wpialIdMenu .hd .s{display:block;font-size:11.5px;color:var(--muted);margin-top:2px;}',
      '#wpialIdMenu .grp{font-size:9.5px;letter-spacing:1.3px;text-transform:uppercase;',
      '  color:var(--muted);padding:8px 10px 4px;}',
      '#wpialIdMenu a,#wpialIdMenu button.mi{display:flex;width:100%;align-items:center;gap:8px;',
      '  box-sizing:border-box;background:none;border:0;text-align:left;color:var(--text);',
      '  font:inherit;font-size:13px;padding:8px 10px;border-radius:7px;cursor:pointer;',
      '  text-decoration:none;}',
      '#wpialIdMenu a:hover,#wpialIdMenu button.mi:hover{background:rgba(255,255,255,.06);}',
      '#wpialIdMenu a:focus-visible,#wpialIdMenu button.mi:focus-visible{',
      '  outline:2px solid var(--accent);outline-offset:-2px;}',
      '#wpialIdMenu .sep{height:1px;background:var(--line);margin:5px 2px;}',
      '#wpialIdMenu .sw{margin-left:auto;width:32px;height:18px;border-radius:99px;',
      '  background:var(--line);position:relative;flex:0 0 auto;transition:background .15s;}',
      '#wpialIdMenu .sw i{position:absolute;top:2px;left:2px;width:14px;height:14px;border-radius:50%;',
      '  background:var(--muted);transition:transform .15s,background .15s;}',
      '#wpialIdMenu .mi.on .sw{background:var(--accent);}',
      '#wpialIdMenu .mi.on .sw i{transform:translateX(14px);background:var(--accent-ink,#14110a);}',
      /* The switch is never the only signal — the row carries ON/OFF as a word. */
      '#wpialIdMenu .st{margin-left:auto;font-size:10.5px;letter-spacing:.8px;color:var(--muted);}',
      '#wpialIdMenu .mi.on .st{color:var(--accent);font-weight:700;}',
      '#wpialIdMenu select{margin-left:auto;background:var(--panel2,var(--panel));',
      '  border:1px solid var(--line);color:var(--text);border-radius:6px;padding:3px 6px;',
      '  font:inherit;font-size:12px;max-width:120px;}',
      '#wpialIdMenu .danger{color:var(--muted);}',

      /* auth.js builds its own sign-out chip and parks it in `nav || .hdr-right`,
         and floats it to the top-left corner when it cannot find either. The
         identity menu says all of that now. Hide it in CSS rather than in JS:
         auth.js builds it on its own schedule, so a JS hide is a race we would
         lose intermittently — and did, in the first screenshot pass. */
      '#wpial-chip{display:none !important;}',

      /* ---- the host we create on index.html ----
         Absolutely positioned so the page's centred title is left exactly as it
         was on desktop. The header is the positioning context. */
      'body > header{position:relative;}',
      '#snHdrSlot.sn-float{position:absolute;right:14px;top:50%;transform:translateY(-50%);',
      '  margin-left:0;}',

      /* ---- the mobile menu button ---- */
      '#siteNavBurger{display:none;align-items:center;gap:7px;background:none;',
      '  border:1px solid var(--line);border-radius:20px;padding:5px 11px;color:var(--text);',
      '  font:inherit;font-size:12.5px;cursor:pointer;flex:0 0 auto;}',
      '#siteNavBurger:hover{border-color:var(--accent);}',

      /* ---- phones: header becomes one row, nav becomes a sheet ----
         This is the whole point of the change. Everything below reclaims
         vertical space on the surface where there is least of it. */
      '@media (max-width:760px){',
      '  #siteNavBurger{display:inline-flex;}',
      /* VISIBLE BY DEFAULT. This was collapsed-by-default for one commit and that was
         wrong: on a site people open a few times a year, a nav hidden behind a glyph
         is a confusion tax paid by everyone, every visit, to buy back header height
         that only matters on one screen on one day. Bryan, 2026-08-06: "on mobile,
         menu items should be displayed, ability to hide for draft, dont want people
         getting confused."
         The hide is now an opt-in the owner chooses — and it sticks, so someone who
         collapses it on draft morning stays collapsed. */
      '  #siteNav{display:flex;flex-wrap:wrap;overflow:visible;gap:7px;padding-top:9px;}',
      '  #siteNav.nav-collapsed{display:none;}',
      '  #siteNav a{padding:7px 12px;font-size:13px;}',       /* bigger tap targets */
      '  #wpialIdBtn{max-width:150px;}',
      '  #wpialIdBtn .nm{display:none;}',                      /* avatar carries it; the menu spells it out */
      '  #wpialIdMenu{min-width:0;width:min(84vw,300px);}',
      /* index.html's own header is a centred 28px title plus a subtitle and 28px
         of padding — about 100px of chrome before anything useful. Compress it
         rather than rebuilding the markup, which would risk its tab bindings. */
      /* Title goes left and the controls sit against the right edge, so the two
         never collide the way a centred title and a floated chip would. */
      '  body > header{padding:10px 132px 10px 13px !important;text-align:left !important;}',
      '  body > header h1{font-size:19px !important;}',
      '  body > header > p{display:none !important;}',
      '  #snHdrSlot.sn-float{right:9px;}',
      /* On the draft board the header is a wrapping flex row that already carries the
         mode toggle, the clock and a scrolling control strip. Let the slot take its
         own line rather than squeezing in beside them and forcing a scroll. */
      /* The header is a wrapping flex row, so the slot lands on its own line under
         the nav. `margin-left:auto` alone does not push it to the right edge there —
         give it the full line and align its contents, or the chip floats stranded in
         the middle of an empty row looking like a layout accident. */
      '  #snHdrSlot:not(.sn-float){width:100%;justify-content:flex-end;margin-left:0;}',
      '}'
    ].join('');
    document.head.appendChild(css);
  }

  /* ---------------------------------------------------------------------
   * 3. The identity menu
   * ------------------------------------------------------------------ */
  var menuBuilt = false;
  /* Held across renders. renderMenu() rebuilds the panel with innerHTML, which
     would DESTROY the theme <select> we moved into it — and then
     getElementById('themeSel') returns null forever and the control is simply
     gone. Detach it before the rebuild, re-attach after. */
  var themeSel = null;

  /* The chip and the ☰ button need a host that is NOT the nav.

     On index.html the nav IS the tab bar, and on a phone the tab bar becomes the
     collapsed sheet — so parking the chip there hides your own account behind the
     menu you need the chip to open. It also made the chip a `nav button`
     neighbour, which is the selector index's tab switcher binds.

     Every page except index already has `.hdr-right`. index gets one created for
     it, floated to the right of its centred title. */
  /* NEVER put the chip inside `.hdr-right`. On a phone mobilehdr.js turns that into
     a horizontal scroller (`width:100%; flex-wrap:nowrap; overflow-x:auto`), and a
     `margin-left:auto` child inside a scroll container pushes the LEADING content
     out of the scrollable area entirely — LIVE/MOCK, Undo, Reset and Commish became
     unreachable, with "Commish" rendering as "mmish" clipped at the left edge. That
     was a real reported bug on the live draft board.

     So the chip and the nav control live in their own slot, a direct child of
     <header>. It cannot be scrolled away, which is also what the nav spec asked for:
     "the identity chip pins at the right edge and never scrolls away." */
  function menuHost() {
    var made = document.getElementById('snHdrSlot');
    if (made) return made;
    var header = document.querySelector('header');
    if (!header) return null;
    made = document.createElement('div');
    made.id = 'snHdrSlot';
    /* index.html's header is a centred title with no control row, so the slot floats
       against the right edge there. Every other page has a real header flex row and
       the slot is just the last item in it. */
    if (!document.querySelector('.hdr-right')) made.className = 'sn-float';
    header.appendChild(made);
    return made;
  }

  function buildIdentity() {
    if (menuBuilt) return;
    var host = menuHost();
    if (!host) return;

    var wrap = document.createElement('div');
    wrap.id = 'wpialId';

    var btn = document.createElement('button');
    btn.id = 'wpialIdBtn';
    btn.type = 'button';
    btn.setAttribute('aria-haspopup', 'true');
    btn.setAttribute('aria-expanded', 'false');
    btn.setAttribute('aria-label', 'Your account and view options');

    var menu = document.createElement('div');
    menu.id = 'wpialIdMenu';
    menu.setAttribute('role', 'menu');

    wrap.appendChild(btn);
    wrap.appendChild(menu);
    host.appendChild(wrap);
    menuBuilt = true;

    btn.onclick = function (e) { e.stopPropagation(); toggleMenu(); };

    document.addEventListener('click', function (e) {
      if (!menu.classList.contains('open')) return;
      if (wrap.contains(e.target)) return;
      closeMenu();
    });
    document.addEventListener('keydown', function (e) {
      if (e.key === 'Escape' && menu.classList.contains('open')) { closeMenu(); btn.focus(); }
    });

    renderIdentity();
    /* Render the panel once while it is still closed. Two reasons: the theme
       <select> is adopted out of the draft board's header immediately rather than
       only when someone first opens the menu, and the panel is display:none so
       the select stays in the document — getElementById still finds it, which
       matters because draftboard.html's own init does
       `$('#themeSel').value = ...` and would throw on a detached node.
       (It runs first anyway — inline script beats DOMContentLoaded — but relying
       on that ordering is how draft-night bugs get written.) */
    renderMenu();
  }

  function toggleMenu() {
    var m = document.getElementById('wpialIdMenu');
    if (!m) return;
    if (m.classList.contains('open')) closeMenu(); else openMenu();
  }
  function openMenu() {
    var m = document.getElementById('wpialIdMenu'), b = document.getElementById('wpialIdBtn');
    if (!m) return;
    renderMenu();
    m.classList.add('open');
    if (b) b.setAttribute('aria-expanded', 'true');
    var first = m.querySelector('a,button.mi');
    if (first) first.focus();
  }
  function closeMenu() {
    var m = document.getElementById('wpialIdMenu'), b = document.getElementById('wpialIdBtn');
    if (!m) return;
    m.classList.remove('open');
    if (b) b.setAttribute('aria-expanded', 'false');
  }

  function cbOn() {
    try { return !!(window.WPIAL_CB && window.WPIAL_CB.isOn()); } catch (e) { return false; }
  }

  function renderIdentity() {
    var btn = document.getElementById('wpialIdBtn');
    if (!btn) return;
    var name = teamName();
    var ini = initials();
    /* Pre-hydration this reads "Account" with a neutral glyph. Every render site
       for identity has to look correct with the name ABSENT — it arrives from a
       network round trip and the layout must not jump when it lands. */
    btn.innerHTML =
      '<span class="av">' + (ini ? esc(ini) : '👤') + '</span>' +
      '<span class="nm">' + esc(name || 'Account') + '</span>' +
      (cbOn() ? '<span class="cb" title="Colorblind mode is on">👓</span>' : '') +
      '<span class="ca">▾</span>';
  }

  function renderMenu() {
    var m = document.getElementById('wpialIdMenu');
    if (!m) return;
    var u = user();
    var name = teamName();
    var ini = initials();
    var sub = [];
    if (u && u.first) sub.push(esc(u.first));
    if (u && u.slot) sub.push('Slot ' + esc(u.slot));
    if (isCommish()) sub.push('Commissioner');

    var h = '';
    h += '<div class="hd">' +
           '<span class="av">' + (ini ? esc(ini) : '👤') + '</span>' +
           '<span><span class="t">' + esc(name || 'Not signed in') + '</span>' +
           (sub.length ? '<span class="s">' + sub.join(' · ') + '</span>' : '') +
           '</span></div>';

    /* No "My Depth Chart" row — Depth Chart is a nav item and roster.html already
       defaults to the signed-in owner, so a menu row was a second door to the same
       screen. One destination, one entrance. */
    h += '<a href="profile.html" role="menuitem">👤 My Profile</a>';

    h += '<div class="grp">View options</div>';
    h += '<button class="mi' + (cbOn() ? ' on' : '') + '" id="wpialCbRow" type="button" role="menuitemcheckbox"' +
         ' aria-checked="' + (cbOn() ? 'true' : 'false') + '">' +
           '👓 Colorblind mode' +
           '<span class="st">' + (cbOn() ? 'ON' : 'OFF') + '</span>' +
           '<span class="sw" aria-hidden="true"><i></i></span>' +
         '</button>';

    /* The draft board's theme picker moves in here from the header bar. It is a
       set-once preference sitting in the most crowded header on the site, and
       "view options" is where someone looks for it. The <select> is MOVED, not
       cloned, so the page's own onchange handler comes with it and there is no
       second control to keep in sync. */
    if (!themeSel) themeSel = document.getElementById('themeSel');
    if (themeSel && themeSel.parentNode) themeSel.parentNode.removeChild(themeSel);  // rescue before innerHTML
    if (themeSel) {
      h += '<div class="mi" style="cursor:default">🎨 Theme<span id="wpialThemeSlot" style="margin-left:auto"></span></div>';
    }

    if (isCommish()) {
      h += '<div class="grp">Commish</div>';
      h += '<a href="dashboard.html" role="menuitem">📊 Commish Dashboard</a>';
    }

    h += '<div class="sep"></div>';
    h += '<button class="mi danger" id="wpialLogout" type="button" role="menuitem">Log out</button>';

    m.innerHTML = h;

    var slot = document.getElementById('wpialThemeSlot');
    if (slot && themeSel) slot.appendChild(themeSel);   // move, never clone: one control, one handler

    var cbRow = document.getElementById('wpialCbRow');
    if (cbRow) cbRow.onclick = function (e) {
      /* stopPropagation is not optional here. renderMenu() replaces the panel's
         innerHTML, so by the time this click bubbles to the document listener the
         row is no longer a descendant of #wpialId — `wrap.contains(e.target)` is
         false and the "clicked outside, close the menu" branch fires on a click
         that was very much inside it. The menu would slam shut on every toggle. */
      if (e && e.stopPropagation) e.stopPropagation();
      try { if (window.WPIAL_CB) window.WPIAL_CB.set(!cbOn()); } catch (e2) {}
      renderMenu(); renderIdentity();
    };

    var out = document.getElementById('wpialLogout');
    if (out) out.onclick = function () {
      try { if (window.WPIAL_AUTH && window.WPIAL_AUTH.logout) return window.WPIAL_AUTH.logout(); } catch (e) {}
      location.reload();
    };
  }

  /* auth.js still builds its own chip and parks it in `nav || .hdr-right`. We do
     not stop it — that would mean editing the auth flow. We hide it, because the
     identity menu now says the same things and says them once. */
  function hideAuthChip() {
    var c = document.getElementById('wpial-chip');
    if (c) c.style.display = 'none';
  }

  /* ---------------------------------------------------------------------
   * 4. index.html — hash routing + the page-links its hardcoded nav lacks
   * ------------------------------------------------------------------ */
  function wireIndex() {
    var navEl = document.querySelector('nav');
    var buttons = document.querySelectorAll('nav button[data-tab]');
    if (!buttons.length) return;

    function selectTab(tab, scroll) {
      if (validTabs().indexOf(tab) === -1) return false;
      var target = null;
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].dataset.tab === tab) { target = buttons[i]; break; }
      }
      if (!target) return false;
      target.click();      // fire the page's own handler; never duplicate its logic
      if (scroll) {
        var top = function () { window.scrollTo(0, 0); };
        top(); requestAnimationFrame(top); setTimeout(top, 80);
      }
      return true;
    }

    var incoming = (location.hash || '').replace(/^#/, '');
    if (incoming) selectTab(incoming, true);

    for (var j = 0; j < buttons.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var t = btn.dataset.tab;
          if (validTabs().indexOf(t) === -1) return;
          try { history.replaceState(null, '', '#' + t); } catch (e) {}
          closeSheet();
        });
      })(buttons[j]);
    }

    window.addEventListener('hashchange', function () {
      selectTab((location.hash || '').replace(/^#/, ''), false);
    });

    /* index's <nav> is hardcoded, so a new NAV entry is invisible here unless we
       add it — which is exactly how the profile link went missing from the page
       most people open first. Add every entry that points at another page, then
       REORDER the whole bar to NAV order, so Draftboard and Depth Chart land in
       their specified positions instead of being appended at the end. */
    function addExtraLinks() {
      if (!navEl) return;
      navItems().forEach(function (item) {
        if (item.page === 'index.html') return;
        var id = 'sn-' + item.page.replace(/[^a-z0-9]/gi, '');
        if (document.getElementById(id)) return;
        var b = document.createElement('button');
        b.id = id;
        b.type = 'button';
        b.innerHTML = item.label;
        b.title = item.title || '';
        b.style.borderColor = 'var(--accent)';
        b.style.color = 'var(--accent)';
        b.style.fontWeight = '700';
        b.onclick = function () { window.location.href = item.page; };
        navEl.appendChild(b);
      });
      reorder();
    }

    function reorder() {
      if (!navEl) return;
      var wanted = [];
      navItems().forEach(function (item) {
        var el = item.tab
          ? navEl.querySelector('button[data-tab="' + item.tab + '"]')
          : document.getElementById('sn-' + item.page.replace(/[^a-z0-9]/gi, ''));
        if (el) wanted.push(el);
      });
      wanted.forEach(function (el) { navEl.appendChild(el); });   // appendChild moves
    }

    /* index owns the tab button and the section, so hiding them is this file's job
       too — NAV filtering alone would leave the hardcoded button sitting there. */
    function retireRosters() {
      if (!rostersRetired()) return;
      var btn = navEl && navEl.querySelector('button[data-tab="rosters"]');
      var sec = document.getElementById('rosters');
      if (btn) btn.hidden = true;
      if (sec) {
        /* If it is the active tab when it retires, hand the page back to League News
           rather than leaving the reader on a blank screen. */
        if (sec.classList.contains('active')) {
          var home = navEl && navEl.querySelector('button[data-tab="board"]');
          if (home) home.click();
        }
        sec.hidden = true;
        sec.classList.remove('active');
      }
    }

    addExtraLinks();
    retireRosters();
    document.addEventListener('wpial-auth', addExtraLinks);
    document.addEventListener('wpial-profiles', addExtraLinks);
  }

  /* ---------------------------------------------------------------------
   * 5. Every other page — inject the strip
   * ------------------------------------------------------------------ */
  function renderStrip() {
    var header = document.querySelector('header');
    if (!header) return;

    var here = currentPage();
    var strip = document.getElementById('siteNav');
    if (!strip) {
      strip = document.createElement('div');       // a div, not a <nav> — gotcha 15
      strip.id = 'siteNav';
      strip.setAttribute('role', 'navigation');
      strip.setAttribute('aria-label', 'Site navigation');
      header.appendChild(strip);
    }

    var items = navItems();
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var isHere = (item.page === here);
      var href = isHere ? '#' : (item.page + (item.tab ? '#' + item.tab : ''));
      html += '<a href="' + href + '"' +
              (isHere ? ' class="here" aria-current="page"' : '') +
              (item.title ? ' title="' + esc(item.title) + '"' : '') +
              (isHere ? ' onclick="return false;"' : '') +
              '>' + item.label + '</a>';
    }
    strip.innerHTML = html;
  }

  /* ---------------------------------------------------------------------
   * 6. The phone nav — shown by default, hideable for draft day
   *
   * The control is a HIDE control, not a reveal. Its label says which way it
   * goes ("Hide menu" / "Show menu") rather than being a bare ☰, because a
   * hamburger next to an already-visible menu reads as decoration and a
   * hamburger next to a hidden one reads as "something is missing".
   *
   * The choice is remembered per device under `wpial-nav-collapsed`. That is the
   * whole point: an owner collapses it once on draft morning to get the board
   * back, and it stays collapsed for the rest of the draft without them
   * re-deciding on every page.
   * ------------------------------------------------------------------ */
  var NAV_COLLAPSE_KEY = 'wpial-nav-collapsed';

  function navCollapsed() {
    try { return localStorage.getItem(NAV_COLLAPSE_KEY) === '1'; } catch (e) { return false; }
  }

  function buildBurger() {
    if (document.getElementById('siteNavBurger')) return;
    /* The draft board already has a header-collapse control (mobilehdr.js's
       "▴ Hide"), and its collapsed rule ALREADY hides #siteNav along with everything
       else. Adding a second, differently-worded hide button next to it in the most
       crowded header on the site is the confusion, not the cure — so on that page we
       add nothing and let the existing control own it. */
    if (document.getElementById('wpial-mhdr-toggle') ||
        currentPage() === 'draftboard.html') return;
    var host = menuHost();
    if (!host) return;
    var b = document.createElement('button');
    b.id = 'siteNavBurger';
    b.type = 'button';
    b.setAttribute('aria-controls', 'siteNav');
    b.onclick = function (e) { e.stopPropagation(); toggleSheet(); };
    /* Before the identity chip, so the reading order is: brand · menu · you. */
    var id = document.getElementById('wpialId');
    if (id && id.parentNode === host) host.insertBefore(b, id); else host.appendChild(b);
    applyNavState(navCollapsed(), false);
  }

  function sheetEl() {
    return document.getElementById('siteNav') || document.querySelector('header nav') || document.querySelector('nav');
  }

  function applyNavState(collapsed, remember) {
    var s = sheetEl(), b = document.getElementById('siteNavBurger');
    if (s) s.classList.toggle('nav-collapsed', !!collapsed);
    if (b) {
      b.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      b.innerHTML = collapsed
        ? '<span aria-hidden="true">\u2630</span> Show menu'
        : '<span aria-hidden="true">\u2715</span> Hide menu';
      b.title = collapsed
        ? 'Show the navigation menu'
        : 'Hide the menu to give the board more room \u2014 stays hidden until you show it again';
    }
    if (remember) { try { localStorage.setItem(NAV_COLLAPSE_KEY, collapsed ? '1' : '0'); } catch (e) {} }
  }

  function toggleSheet() {
    var s = sheetEl();
    if (!s) return;
    applyNavState(!s.classList.contains('nav-collapsed'), true);
  }

  /* Tapping a tab on index used to close the menu. It does not any more — the menu
     is the page's own tab bar there, and collapsing it on every tap would fight the
     preference the owner just set. */
  function closeSheet() { /* intentionally a no-op; see above */ }

  /* Another tab collapsed or expanded it — follow, without re-writing the key. */
  window.addEventListener('storage', function (e) {
    if (e && e.key === NAV_COLLAPSE_KEY) applyNavState(e.newValue === '1', false);
  });

  /* ---------------------------------------------------------------------
   * 7. --hdr-h, published from a MEASUREMENT (gotcha 33-A)
   * ------------------------------------------------------------------ */
  function trackHeaderHeight() {
    var header = document.querySelector('header');
    if (!header) return;
    var apply = function () {
      var h = Math.round(header.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--hdr-h', h + 'px');
    };
    apply();
    if (window.ResizeObserver) { try { new ResizeObserver(apply).observe(header); } catch (e) {} }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(function () {});
    document.addEventListener('wpial-auth', function () { setTimeout(apply, 50); });
  }

  /* ---------------------------------------------------------------------
   * 8. Init
   * ------------------------------------------------------------------ */
  function init() {
    injectStyles();

    if (currentPage() === 'index.html') {
      wireIndex();
      /* index's nav IS the sheet on a phone — it is the page's own tab bar. */
      var n = document.querySelector('header nav') || document.querySelector('nav');
      if (n && !document.getElementById('siteNav')) n.id = n.id || 'siteNav';
    } else {
      renderStrip();
      document.addEventListener('wpial-auth', renderStrip);
    }

    buildIdentity();
    buildBurger();
    hideAuthChip();

    /* Identity arrives from a network round trip; so does the commish flag, which
       decides whether the menu has a Commish section at all. */
    document.addEventListener('wpial-auth', function () {
      hideAuthChip(); renderIdentity();
      if (document.getElementById('wpialIdMenu').classList.contains('open')) renderMenu();
    });
    document.addEventListener('wpial-profiles', renderIdentity);

    trackHeaderHeight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  /* Exposed so cbmode.js can keep the chip's 👓 marker honest when the mode is
     changed from somewhere else — another tab, or the gate toggle. */
  window.WPIAL_NAV = { refresh: function () { renderIdentity(); }, closeMenu: closeMenu };
})();
