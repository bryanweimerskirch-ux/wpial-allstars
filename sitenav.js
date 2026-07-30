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
 *     we add there is hash routing so an inbound link can select a tab.
 *     On draftboard.html we inject the matching strip.
 *   - Match each page's own CSS variables so it inherits all three draftboard
 *     themes (broadcast / chalk / light) for free.
 *
 * Loaded from <head> on both pages, so everything waits for DOMContentLoaded.
 * ==========================================================================*/
(function () {
  'use strict';

  // The single source of truth for what's in the nav, used by both pages.
  // `tab` is the section id on index.html; `page` is where the link points.
  var NAV = [
    { tab: 'board',    page: 'index.html', label: 'The Gelly' },
    { tab: 'rosters',  page: 'index.html', label: 'Rosters &amp; round values' },
    { tab: 'history',  page: 'index.html', label: 'League history' },
    { tab: 'schedule', page: 'index.html', label: '2026 Schedule' },
    { tab: null,       page: 'draftboard.html', label: '🏈 Draftboard',
      title: 'Interactive keeper draftboard — mock drafts, keeper decisions, and a full season simulator' }
  ];

  var VALID_TABS = ['board', 'rosters', 'history', 'schedule'];

  function page() {
    var p = (location.pathname || '').toLowerCase();
    if (p.indexOf('draftboard') !== -1) return 'draftboard';
    return 'index';
  }

  /* ---------------------------------------------------------------------
   * index.html — hash routing only. The nav markup and its click handlers
   * are the page's own; we don't touch them.
   * ------------------------------------------------------------------ */
  function wireIndex() {
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
      if (scroll) window.scrollTo(0, 0);
      return true;
    }

    // Inbound deep link: draftboard.html -> index.html#rosters
    var incoming = (location.hash || '').replace(/^#/, '');
    if (incoming) selectTab(incoming, true);

    // Keep the hash in step with manual tab clicks, so the address bar is
    // always a shareable link to what you're looking at. replaceState avoids
    // stuffing the back button with one entry per tab click.
    for (var j = 0; j < buttons.length; j++) {
      (function (btn) {
        btn.addEventListener('click', function () {
          var t = btn.dataset.tab;
          if (VALID_TABS.indexOf(t) === -1) return;
          try { history.replaceState(null, '', '#' + t); } catch (e) { /* file:// */ }
        });
      })(buttons[j]);
    }

    // Back/forward between tabs.
    window.addEventListener('hashchange', function () {
      selectTab((location.hash || '').replace(/^#/, ''), false);
    });
  }

  /* ---------------------------------------------------------------------
   * draftboard.html — inject the strip.
   * It goes INSIDE <header>, which is position:sticky, so the way back stays
   * on screen no matter how far down the board you've scrolled.
   * ------------------------------------------------------------------ */
  function buildDraftboardNav() {
    if (document.getElementById('siteNav')) return;
    var header = document.querySelector('header');
    if (!header) return;

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
      '#siteNav a:hover{border-color:var(--accent);color:var(--accent2);}',
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

    var nav = document.createElement('nav');
    nav.id = 'siteNav';
    nav.setAttribute('aria-label', 'Site navigation');

    var html = '';
    for (var i = 0; i < NAV.length; i++) {
      var item = NAV[i];
      var here = (item.page === 'draftboard.html');
      var href = here ? '#' : (item.page + (item.tab ? '#' + item.tab : ''));
      // First item doubles as the "get me out of here" affordance.
      var label = (i === 0) ? '← ' + item.label : item.label;
      html += '<a href="' + href + '"' +
              (here ? ' class="here" aria-current="page"' : (i === 0 ? ' class="snhome"' : '')) +
              (item.title ? ' title="' + item.title + '"' : '') +
              (here ? ' onclick="return false;"' : '') +
              '>' + label + '</a>';
    }
    nav.innerHTML = html;

    // Place it as the last row of the header. #statusbar is width:100% so the
    // flex container already wraps; appending puts us on our own line beneath it.
    header.appendChild(nav);
  }

  function init() {
    if (page() === 'draftboard') buildDraftboardNav();
    else wireIndex();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
