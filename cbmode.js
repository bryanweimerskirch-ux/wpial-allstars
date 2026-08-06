/* ============================================================================
 * cbmode.js — colorblind mode, once, for the whole site.
 * ----------------------------------------------------------------------------
 * WHAT WAS WRONG
 *
 * Colorblind mode was implemented twice (index.html, draftboard.html) and not at
 * all on the other four pages. So the reported symptom — "it's not there on the
 * H2H detail page, and then it's gone on the draft board too, but going back to
 * other tabs it sometimes works" — was three separate facts wearing one coat:
 *
 *   1. matchup / roster / dashboard / profile had NO colorblind code. Not
 *      broken: absent. Every page you navigated to from there looked untouched
 *      because it WAS untouched.
 *   2. Both implementations wrote '0' to localStorage on load for anybody who
 *      had never toggled, which destroys the difference between "off" and
 *      "never chose". That is exactly the signal a per-owner default needs.
 *   3. The draft board applied the class inside its init IIFE, after a long
 *      inline script. Anything that throws earlier in that script takes the
 *      colorblind restore down with it, silently, and it looks intermittent.
 *
 * HOW THIS FIXES IT
 *
 * One file, loaded in <head> on every page, NOT deferred. It sets the class on
 * <html> before <body> exists, so the palette is correct at first paint and no
 * page can forget to restore it. Pages no longer own any of this.
 *
 * STORAGE — three keys, and the distinction between them is the whole design
 *
 *   wpial-cb-choice  '1' | '0'   Written ONLY when a human clicks the toggle.
 *                                Absent means "never chose", which is a
 *                                different thing from "chose off". Nothing else
 *                                may ever write this key.
 *   wpial-cb-mode    '1' | '0'   The applied state. Legacy key, kept in sync so
 *                                anything still reading it stays correct, and
 *                                read at startup so owners who turned the mode
 *                                on under the old code keep it on.
 *   wpial-cb-fid     'fNN'       Last known signed-in franchise. Cached purely
 *                                so a defaulted owner's second visit is right at
 *                                first paint instead of flipping when auth
 *                                lands ~400ms later.
 *
 * RESOLUTION ORDER (first hit wins)
 *
 *   1. An explicit human choice.                      <- always wins, forever
 *   2. This franchise is in DEFAULT_ON.
 *   3. The legacy key says on.
 *   4. Off.
 *
 * Because of rule 1, a defaulted owner can turn it off and it stays off. That is
 * the whole point of separating the two keys.
 *
 * ES5 ONLY. Standalone .js files on this site are deliberately ES5.
 * ==========================================================================*/
(function () {
  'use strict';

  var CHOICE_KEY = 'wpial-cb-choice';
  var MODE_KEY   = 'wpial-cb-mode';
  var FID_KEY    = 'wpial-cb-fid';

  /* Franchises that get colorblind mode ON by default.
   * f01 Drake Draaaake?  ·  f09 Mean Machine
   * Franchise ids, never names or emails: names come from ESPN and drift hourly,
   * and no personal data goes in the public repo. Add or remove an fid here and
   * nothing else needs to change. */
  var DEFAULT_ON = ['f01', 'f09'];

  /* ---- storage, defensively (Safari private mode throws on setItem) ---- */
  function get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }

  function isDefaultFid(fid) {
    if (!fid) return false;
    for (var i = 0; i < DEFAULT_ON.length; i++) if (DEFAULT_ON[i] === fid) return true;
    return false;
  }

  /* The signed-in franchise, if we know it yet. auth.js publishes WPIAL_USER and
     fires `wpial-auth`; before that lands we fall back to the cached fid. */
  function currentFid() {
    var u = window.WPIAL_USER;
    if (u && u.fid) return u.fid;
    return get(FID_KEY);
  }

  function resolve() {
    var choice = get(CHOICE_KEY);
    if (choice === '1') return true;
    if (choice === '0') return false;
    if (isDefaultFid(currentFid())) return true;
    return get(MODE_KEY) === '1';
  }

  /* ---- applying it ------------------------------------------------------ */
  var state = false;

  function paint(on) {
    var d = document.documentElement;
    if (d.classList) d.classList.toggle('colorblind', on);
    /* <body> does not exist yet when this file runs from <head>. That is fine
       and intended — html.colorblind already carries the tokens (see theme.css
       §3), so first paint is correct. syncBody() catches up the moment the body
       is parsed, before any page rule keyed on body.colorblind can matter. */
    if (document.body) document.body.classList.toggle('colorblind', on);
  }

  function labelToggles(on) {
    var btns = document.querySelectorAll('.cb-toggle, #cbToggle');
    for (var i = 0; i < btns.length; i++) {
      var b = btns[i];
      b.classList.toggle('on', on);
      b.setAttribute('aria-pressed', on ? 'true' : 'false');
      /* The draft board's header is dense, so its label is shorter. The state is
         in the WORD "ON", never in the colour alone. */
      var terse = b.getAttribute('data-cb-terse') === '1';
      b.textContent = terse
        ? (on ? '👓 Colorblind: ON' : '👓 Colorblind')
        : (on ? '👓 Colorblind mode: ON' : '👓 Colorblind mode');
    }
  }

  /* apply(on, opts)
     opts.remember  — write MODE_KEY (the applied state). Default true.
     opts.choice    — this came from a human. Writes CHOICE_KEY. Default false.
                      NOTHING ELSE may pass this. */
  function apply(on, opts) {
    opts = opts || {};
    state = !!on;
    paint(state);
    labelToggles(state);
    if (opts.remember !== false) set(MODE_KEY, state ? '1' : '0');
    if (opts.choice) set(CHOICE_KEY, state ? '1' : '0');
    /* The identity chip carries a 👓 marker when the mode is on. Refresh it here
       rather than from each call site, so a change from ANY source — the menu,
       the gate, another tab, the per-owner default — keeps the chip honest. */
    try { if (window.WPIAL_NAV) window.WPIAL_NAV.refresh(); } catch (e) {}
  }

  /* ---- first paint, from <head> ----------------------------------------- */
  apply(resolve(), { remember: false });

  /* ---- the toggle ------------------------------------------------------- */
  /* Every human-initiated change goes through here — the identity menu row, the
     gate toggle, any page's hand-written button. It has to be ONE function: when
     the menu called apply() directly it bypassed the ceremony, and turning the
     mode on from the menu silently skipped the gag on the one page that has it. */
  function requestSet(on, opts) {
    opts = opts || {};
    var turningOn = !!on;
    if (!turningOn) { apply(false, { choice: true }); return; }
    /* index.html owns a ceremony for turning it ON. Any page may register one;
       no page has to. It is handed a callback rather than a promise because
       everything here is ES5.

       The toggle on the SIGN-IN GATE skips it. The ceremony's overlay is a
       `body > *`, and the gate hides every one of those, so playing it there
       would wait forever on a callback from an element nobody can see — the mode
       would simply never come on. */
    var ceremony = opts.plain ? null : window.WPIAL_CB_CEREMONY;
    if (typeof ceremony === 'function') {
      ceremony(function () { apply(true, { choice: true }); });
    } else {
      apply(true, { choice: true });
    }
  }

  function onToggleClick() {
    var plain = this && this.getAttribute && this.getAttribute('data-cb-plain') === '1';
    requestSet(!state, { plain: plain });
  }

  function wireToggle(btn) {
    if (!btn || btn.getAttribute('data-cb-wired') === '1') return;
    btn.setAttribute('data-cb-wired', '1');
    btn.setAttribute('type', 'button');
    btn.onclick = onToggleClick;
  }

  /* THE TOGGLE IS NO LONGER IN THE HEADER.

     It used to be a bright yellow pill sitting in the nav bar, where it was the
     loudest element on the page despite being a set-once preference — it visually
     outranked the Draftboard three weeks before the draft. It now lives in the
     identity menu under "View options" (sitenav.js), with a 👓 marker on the chip
     so the state is still visible from the outside.

     This function only adopts a toggle a page hand-wrote. It no longer creates
     one, because there is exactly one place to look for it now. */
  function ensureToggle() {
    var existing = document.getElementById('cbToggle');
    if (existing) wireToggle(existing);
  }

  /* The sign-in gate hides the entire page (`.wpial-gated body > * {display:none}`),
     so the header toggle is unreachable until you are signed in. That is the wrong
     way round for an accessibility control: an owner who needs the colorblind
     palette needs it to read the login form, not after it. The gate is built
     asynchronously by auth.js once auth_status answers, so watch for it. */
  function ensureGateToggle() {
    var card = document.querySelector('#wpial-gate .wg-card');
    if (!card) return false;                                  // not built yet — go watch
    if (card.querySelector('.cb-toggle')) return true;         // already done
    var b = document.createElement('button');
    b.className = 'cb-toggle';
    b.setAttribute('type', 'button');
    b.setAttribute('aria-pressed', state ? 'true' : 'false');
    b.setAttribute('data-cb-terse', '1');
    b.setAttribute('data-cb-plain', '1');
    b.textContent = state ? '👓 Colorblind: ON' : '👓 Colorblind';
    card.appendChild(b);
    wireToggle(b);
    labelToggles(state);   // it was born after the last paint — give it the .on class
    return true;
  }

  function watchForGate() {
    if (ensureGateToggle()) return;
    if (!window.MutationObserver || !document.body) return;
    var mo = new MutationObserver(function () {
      if (document.querySelector('#wpial-gate .wg-card')) { ensureGateToggle(); mo.disconnect(); }
    });
    try { mo.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    /* Never leave an observer running on a live draft board. */
    document.addEventListener('wpial-auth', function () { try { mo.disconnect(); } catch (e) {} });
  }

  function syncBody() {
    paint(state);
    ensureToggle();
    watchForGate();
    labelToggles(state);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', syncBody);
  } else {
    syncBody();
  }

  /* ---- identity arrives late -------------------------------------------- */
  /* auth_me is a network round trip, so the franchise is unknown at first paint
     on a first visit. When it lands, re-resolve — but only if the owner has
     never made an explicit choice. An explicit choice is never overridden by a
     default, on any visit, on any device. */
  document.addEventListener('wpial-auth', function () {
    var u = window.WPIAL_USER;
    if (u && u.fid) set(FID_KEY, u.fid);
    if (get(CHOICE_KEY) !== null) return;
    var want = resolve();
    if (want !== state) apply(want);
  });

  /* ---- another tab changed it ------------------------------------------- */
  window.addEventListener('storage', function (e) {
    if (!e) return;
    if (e.key === CHOICE_KEY || e.key === MODE_KEY) {
      var want = resolve();
      if (want !== state) apply(want, { remember: false });
    }
  });

  /* ---- small public surface --------------------------------------------- */
  window.WPIAL_CB = {
    isOn:   function () { return state; },
    /* Goes through requestSet, so the menu row gets the ceremony exactly like a
       button click does. Nothing outside this file should call apply(). */
    set:    function (on) { requestSet(!!on, {}); },
    /* Exposed so the draft board can re-assert the class after it does
       `document.body.className = 'theme-' + v`, which wipes every other class.
       That exact line silently turned colorblind mode off once already. */
    reassert: function () { paint(state); labelToggles(state); },
    defaults: DEFAULT_ON.slice()
  };
})();
