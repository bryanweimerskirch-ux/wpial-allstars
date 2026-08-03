/* ============================================================================
 * sitenav.js — one shared navigation strip for wadi.solutions
 * ----------------------------------------------------------------------------
 * Problem this solves: draftboard.html was a dead end. You could get TO it from
 * the homepage nav, but there was no way back to The Gelly / Rosters / History /
 * Schedule without editing the URL.
 *
 * Design constraints (same ones keepers.js and draftkeep.js live under):
 *   - Do NOT edit either page's own render code or its existing event bindings.
 *     index.html binds its tab switcher to `nav button[data-tab]` in an inline
 *     script; rebuilding that nav from here would silently unbind it.
 *   - Be additive. On index.html the nav already exists and is correct, so all
 *     we add there is hash routing (so an inbound link can select a tab) and,
 *     for the commissioner only, the dashboard link.
 *     On every other page we inject the matching strip.
 *   - Match each page's own CSS variables so it inherits all three draftboard
 *     themes (broadcast / chalk / light) for free.
 *
 * IMPORTANT: the injected strip is a <div role="navigation">, NOT a <nav>.
 * auth.js parks the sign-out chip in `document.querySelector('nav') ||
 * .hdr-right`, so injecting a real <nav> would race it — on a slow auth_me the
 * chip would land in this strip instead of the page's own control row.
 *
 * Loaded from <head>, so everything waits for DOMContentLoaded.
 * ==========================================================================*/
(function () {
  'use strict';

  // Single source of truth for the nav, shared by every page.
  // `tab` is the section id on index.html; `page` is where the link points.
  var NAV = [
    { tab: 'board',    page: 'index.html',      label: 'The Gelly' },
    { tab: 'rosters',  page: 'index.html',      label: 'Rosters &amp; Round Values' },
    { tab: 'history',  page: 'index.html',      label: 'League History' },
    { tab: 'schedule', page: 'index.html',      label: '2026 NFL Schedule' },
    { tab: 'scoreboard', page: 'index.html',     label: 'Scoreboard' },
    { tab: 'standings', page: 'index.html',      label: 'Standings' },
    { tab: null,       page: 'draftboard.html', label: '🏈 Draftboard',
      title: 'Interactive keeper draftboard — mock drafts, keeper decisions, and a full season simulator' },
    { tab: null,       page: 'profile.html',    label: '👤 My Profile',
    title: 'Your franchise — first name, colors, logo and jersey' },
  { tab: null,       page: 'dashboard.html',  label: '📊 Commish', commishOnly: true,
      title: 'League engagement — who has logged in and who still owes keepers' }
  ];

  var VALID_TABS = ['board', 'rosters', 'history', 'schedule', 'scoreboard', 'standings'];

  /* GOTCHA 33 (matchup-detail build notes): this falls through to index.html for any page
     it does not recognise, and wireIndex() then binds hash routing to a
     `nav button[data-tab]` that does not exist there — so the page gets NO nav strip and
     becomes the exact dead end sitenav was written to prevent. Every new standalone page
     must be added here on the day it is created.

     matchup.html and roster.html are deliberately absent from NAV itself: you arrive at
     them from a scoreboard card or a standings row, not from the nav. They still need the
     strip so there is a way back. */
  function currentPage() {
    var p = (location.pathname || '').toLowerCase();
    if (p.indexOf('draftboard') !== -1) return 'draftboard.html';
    if (p.indexOf('dashboard') !== -1) return 'dashboard.html';
    if (p.indexOf('profile') !== -1) return 'profile.html';
    if (p.indexOf('matchup') !== -1) return 'matchup.html';
    if (p.indexOf('roster') !== -1) return 'roster.html';
    return 'index.html';
  }

  function isCommish() {
    try {
      var u = window.WPIAL_USER || (window.WPIAL_AUTH && window.WPIAL_AUTH.user && window.WPIAL_AUTH.user());
      return !!(u && (u.is_commish === true || String(u.is_commish).toLowerCase() === 'true'));
    } catch (e) { return false; }
  }

  function visibleItems() {
    var commish = isCommish();
    return NAV.filter(function (it) { return !it.commishOnly || commish; });
  }

  /* ---------------------------------------------------------------------
   * index.html — hash routing, plus the commissioner's dashboard link.
   * The nav markup and its click handlers are the page's own.
   * ------------------------------------------------------------------ */
  function wireIndex() {
    var navEl = document.querySelector('nav');
    var buttons = document.querySelectorAll('nav button[data-tab]');
    if (!buttons.length) return;

    function selectTab(tab, scroll) {
      if (VALID_TABS.indexOf(tab) === -1) return false;
      var target = null;
      for (var i = 0; i < buttons.length; i++) {
        if (buttons[i].dataset.tab === tab) { target = buttons[i]; break; }
      }
      if (!target) return false;
      // Fire the page's own handler rather than duplicating its logic, so the
      // two can never drift apart.
      target.click();
      // The section ids double as anchor targets, so the browser performs its
      // own jump to #rosters after we've activated the tab — which lands you
      // mid-page with the nav scrolled off. Undo it, more than once, because
      // that jump can land a frame or two later.
      if (scroll) {
        var top = function () { window.scrollTo(0, 0); };
        top();
        requestAnimationFrame(top);
        setTimeout(top, 80);
      }
      return true;
    }

    var incoming = (location.hash || '').replace(/^#/, '');
    if (incoming) selectTab(incoming, true);

    // Keep the hash in step with manual tab clicks so the address bar is always
    // a shareable link to what you're looking at. replaceState avoids stuffing
    // the back button with one entry per tab click.
    for (var j = 0; j < buttons.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var t = btn.dataset.tab;
          if (VALID_TABS.indexOf(t) === -1) return;
          try { history.replaceState(null, '', '#' + t); } catch (e) { /* file:// */ }
        });
      })(buttons[j]);
    }

    window.addEventListener('hashchange', function () {
      selectTab((location.hash || '').replace(/^#/, ''), false);
    });

    /* index.html's <nav> is hardcoded HTML, so anything added to NAV shows up on every
       OTHER page for free and is invisible here. That is exactly how the profile link
       went missing from the homepage — the one page most people open first.
       So: append every NAV entry that points at another page and is not already in the
       markup. Draftboard is skipped because it is hand-written above; Profile and Commish
       get injected. No data-tab, so the page's own tab handler ignores them entirely.
       Identity arrives async, hence the event. */
    function addExtraLinks() {
      if (!navEl) return;
      visibleItems().forEach(function (item) {
        if (item.page === 'index.html') return;
        var id = 'sn-' + item.page.replace(/[^a-z0-9]/gi, '');
        if (document.getElementById(id)) return;
        if (navEl.innerHTML.indexOf(item.page) !== -1) return;   // already hand-written
        var b = document.createElement('button');
        b.id = id;
        b.type = 'button';
        b.innerHTML = item.label;
        b.title = item.title || '';
        b.style.borderColor = 'var(--accent)';
        b.style.color = 'var(--accent)';
        b.onclick = function () { window.location.href = item.page; };
        // Before the sign-out chip if it's already there, otherwise at the end.
        var chip = document.getElementById('wpial-chip');
        if (chip && chip.parentNode === navEl) navEl.insertBefore(b, chip);
        else navEl.appendChild(b);
      });
    }
    addExtraLinks();
    document.addEventListener('wpial-auth', addExtraLinks);
    document.addEventListener('wpial-profiles', addExtraLinks);
  }

  /* ---------------------------------------------------------------------
   * Every other page — inject the strip.
   * On the draftboard it goes INSIDE <header>, which is position:sticky, so
   * the way back stays on screen no matter how far down the board you scroll.
   * ------------------------------------------------------------------ */
  function injectStyles() {
    if (document.getElementById('siteNavCss')) return;
    var css = document.createElement('style');
    css.id = 'siteNavCss';
    css.textContent = [
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
      '  color:#14110a;font-weight:700;cursor:default;}',
      '#siteNav a.here:hover{color:#14110a;}',
      '#siteNav .snhome{font-weight:600;}',
      '@media (max-width:900px){',
      '  #siteNav{padding-top:6px;margin-top:4px;}',
      '  #siteNav a{padding:5px 10px;font-size:12px;}',
      '}'
    ].join('');
    document.head.appendChild(css);
  }

  function renderStrip() {
    var header = document.querySelector('header');
    if (!header) return;
    injectStyles();

    var here = currentPage();
    var strip = document.getElementById('siteNav');
    if (!strip) {
      // A div, not a <nav> — see the note at the top of this file.
      strip = document.createElement('div');
      strip.id = 'siteNav';
      strip.setAttribute('role', 'navigation');
      strip.setAttribute('aria-label', 'Site navigation');
      header.appendChild(strip);
    }

    var items = visibleItems();
    var html = '';
    for (var i = 0; i < items.length; i++) {
      var item = items[i];
      var isHere = (item.page === here);
      var href = isHere ? '#' : (item.page + (item.tab ? '#' + item.tab : ''));
      // First item doubles as the "get me out of here" affordance.
      var label = (i === 0) ? '← ' + item.label : item.label;
      html += '<a href="' + href + '"' +
              (isHere ? ' class="here" aria-current="page"' : (i === 0 ? ' class="snhome"' : '')) +
              (item.title ? ' title="' + item.title + '"' : '') +
              (isHere ? ' onclick="return false;"' : '') +
              '>' + label + '</a>';
    }
    strip.innerHTML = html;
  }

  /* ---------------------------------------------------------------------
   * Publish the header's real height as --hdr-h.
   * The draftboard sizes its board pane and sticks its sidebar against the
   * header, and used to do it with a hardcoded 96px. Adding this nav strip —
   * and later the draft clock — made the header taller, so the sidebar stuck
   * underneath it and both panes ran past the bottom of the window. Anything
   * that changes header height (a wrapped toolbar, a mode switch, a rotated
   * phone) now updates the variable instead.
   * ------------------------------------------------------------------ */
  function trackHeaderHeight() {
    var header = document.querySelector('header');
    if (!header) return;
    var apply = function () {
      var h = Math.round(header.getBoundingClientRect().height);
      if (h > 0) document.documentElement.style.setProperty('--hdr-h', h + 'px');
    };
    apply();
    if (window.ResizeObserver) {
      try { new ResizeObserver(apply).observe(header); } catch (e) {}
    }
    window.addEventListener('resize', apply);
    window.addEventListener('orientationchange', apply);
    // Fonts land after first paint and change the header's height with them.
    if (document.fonts && document.fonts.ready) document.fonts.ready.then(apply).catch(function () {});
    document.addEventListener('wpial-auth', function () { setTimeout(apply, 50); });
  }

  function init() {
    if (currentPage() === 'index.html') {
      wireIndex();
    } else {
      renderStrip();
      // is_commish arrives after auth_me resolves; re-render to reveal 📊.
      document.addEventListener('wpial-auth', renderStrip);
    }
    trackHeaderHeight();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
