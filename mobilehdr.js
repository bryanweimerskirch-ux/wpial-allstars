/**
 * mobilehdr.js — make the draftboard header survive a phone.
 *
 * THE PROBLEM (measured, 390x844)
 *   header 446px of an 844px viewport = 53% of the screen, leaving 398px of board.
 *   Every row wraps to a second or third line at that width:
 *     logo 32 · countdown 18 · hdr-right 69 · statusbar 112 · dcBar 70 · siteNav 33
 *   The same header is 215px on desktop, so this is purely a wrap problem.
 *
 * THE FIX, two parts
 *   1. Stop wrapping. On phones the control rows become single-line horizontal
 *      scrollers instead of stacking. Nothing is removed — it slides.
 *   2. Collapse on scroll. Once you scroll the board, the header drops to a compact
 *      bar: who is on the clock, the clock itself, and a chevron to bring it all back.
 *      Scroll back to the top and it restores itself.
 *
 * WHY NO HARDCODED HEIGHTS
 *   sitenav.js publishes --hdr-h from the header's *measured* height via ResizeObserver,
 *   and #boardwrap / #sidebar size off calc(100vh - var(--hdr-h)). So the panes follow
 *   this automatically. Do not reintroduce a pixel constant here — that landmine has
 *   already gone off twice on this page.
 *
 * Scope: draftboard.html only, and only at <=700px. Desktop is untouched.
 */
(function () {
  'use strict';

  var MAX_W = 700;          // phone breakpoint, matches the rest of the site
  var COLLAPSE_AT = 48;     // px of board scroll before the header shrinks
  var EXPAND_AT = 8;        // and where it comes back — hysteresis, so it can't flap
  var CSS_ID = 'wpial-mhdr-css';
  var BTN_ID = 'wpial-mhdr-toggle';

  function injectCss() {
    if (document.getElementById(CSS_ID)) return;
    var s = document.createElement('style');
    s.id = CSS_ID;
    s.textContent = [
      /* the chevron only exists on phones */
      '#' + BTN_ID + '{display:none;margin-left:auto;background:transparent;border:1px solid var(--line);',
      '  color:var(--muted);border-radius:14px;padding:3px 10px;font-size:12px;line-height:1.2;',
      '  cursor:pointer;flex:0 0 auto;}',
      '#' + BTN_ID + ':active{border-color:var(--accent);color:var(--accent);}',

      '@media (max-width:' + MAX_W + 'px){',
      '  #' + BTN_ID + '{display:inline-flex;align-items:center;gap:5px;}',
      '  header{gap:8px;padding:8px 12px;}',
      '  header .logo b{font-size:15px;}',
      '  header .logo span{display:none;}',
      '  #countdown{font-size:11px;width:100%;}',

      /* one line each, slide instead of wrap */
      '  .hdr-right{width:100%;margin-left:0;flex-wrap:nowrap;overflow-x:auto;',
      '    -webkit-overflow-scrolling:touch;scrollbar-width:none;}',
      '  .hdr-right::-webkit-scrollbar{display:none;}',
      '  #statusbar{flex-wrap:nowrap;overflow-x:auto;gap:10px;padding-top:4px;',
      '    -webkit-overflow-scrolling:touch;scrollbar-width:none;}',
      '  #statusbar::-webkit-scrollbar{display:none;}',
      /* nowrap on the ROW is not enough — each item still wraps its own text and the
         bar grows to three lines. Pin the children to one line as well. */
      '  #statusbar > *{white-space:nowrap;flex:0 0 auto;}',
      '  .hdr-right > *{flex:0 0 auto;}',
      '  #dcBar .dcwho b,#dcBar .dcwho span{white-space:nowrap;}',
      '  #dcBar > *{flex:0 0 auto;}',
      '  #dcBar{flex-wrap:nowrap;overflow-x:auto;gap:8px;',
      '    -webkit-overflow-scrolling:touch;scrollbar-width:none;}',
      '  #dcBar::-webkit-scrollbar{display:none;}',
      '  #dcBar .dcclock{font-size:22px;}',

      /* collapsed: keep identity + who is on the clock + the clock, hide the rest */
      '  body.mhdr-min header{padding:6px 12px;gap:6px;}',
      '  body.mhdr-min #countdown,',
      '  body.mhdr-min .hdr-right,',
      '  body.mhdr-min #siteNav,',
      '  body.mhdr-min #statusbar #pickLabel,',
      '  body.mhdr-min #statusbar .pill,',
      '  body.mhdr-min #dcBar .dcbtns,',
      '  body.mhdr-min #dcBar select,',
      '  body.mhdr-min #dcBar .dctog,',
      '  body.mhdr-min #dcLog{display:none !important;}',
      '  body.mhdr-min #statusbar{padding-top:0;}',
      '  body.mhdr-min #dcBar .dcclock{font-size:19px;}',
      '  body.mhdr-min .logo b{font-size:13px;}',
      '}'
    ].join('\n');
    document.head.appendChild(s);
  }

  var collapsed = false;
  var userExpanded = false;   // a manual expand outranks scrolling until you return to the top

  function isPhone() {
    return window.matchMedia && window.matchMedia('(max-width:' + MAX_W + 'px)').matches;
  }

  function apply(next) {
    if (next === collapsed) return;
    collapsed = next;
    document.body.classList.toggle('mhdr-min', collapsed);
    var b = document.getElementById(BTN_ID);
    if (b) {
      b.innerHTML = collapsed ? '▾ Show' : '▴ Hide';
      b.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
  }

  function addToggle() {
    if (document.getElementById(BTN_ID)) return;
    var header = document.querySelector('header');
    var logo = header && header.querySelector('.logo');
    if (!logo) return;
    var b = document.createElement('button');
    b.id = BTN_ID;
    b.type = 'button';
    b.innerHTML = '▴ Hide';
    b.title = 'Collapse the header to give the board more room';
    b.setAttribute('aria-controls', 'statusbar');
    b.setAttribute('aria-expanded', 'true');
    b.onclick = function () {
      userExpanded = collapsed;      // expanding by hand pins it open
      apply(!collapsed);
    };
    /* Directly after the logo so it sits on the first line, not in .hdr-right —
       auth.js parks the sign-out chip in .hdr-right and we must not crowd it. */
    if (logo.nextSibling) header.insertBefore(b, logo.nextSibling);
    else header.appendChild(b);
  }

  var ticking = false;
  function onScroll(el) {
    if (ticking) return;
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      if (!isPhone()) { apply(false); return; }
      var y = el.scrollTop;
      if (y <= EXPAND_AT) { userExpanded = false; apply(false); }
      else if (y >= COLLAPSE_AT && !userExpanded) { apply(true); }
    });
  }

  function init() {
    injectCss();
    addToggle();
    var wrap = document.getElementById('boardwrap');
    if (wrap) wrap.addEventListener('scroll', function () { onScroll(wrap); }, { passive: true });
    /* the page itself can scroll on narrow screens too */
    window.addEventListener('scroll', function () {
      if (!isPhone()) { apply(false); return; }
      var y = window.pageYOffset || document.documentElement.scrollTop || 0;
      if (y <= EXPAND_AT) { userExpanded = false; apply(false); }
      else if (y >= COLLAPSE_AT && !userExpanded) apply(true);
    }, { passive: true });
    /* rotating a phone to landscape should give the full header back */
    window.addEventListener('resize', function () { if (!isPhone()) apply(false); });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
