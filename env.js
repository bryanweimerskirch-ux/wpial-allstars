/**
 * env.js — which environment is this page running as.
 *
 * WHY THIS EXISTS
 * The realtime draft is the first thing on this site that cannot be tested by
 * "load it and look at it". Ten clients, a shared clock and a transactional pick
 * cursor need somewhere to be exercised that is NOT the draft ten people are
 * counting on. This is that switch.
 *
 * The isolation that matters is the Firebase subtree. Everything else — the site
 * files, the Apps Script backend, the sheet — is shared, deliberately: staging that
 * runs different code is staging that proves nothing. What staging gets is its own
 * draft state, so a simulated draft can be reset, replayed and hammered without
 * touching a single real pick.
 *
 *   prod     drafts/prod/2026
 *   staging  drafts/staging/2026
 *
 * HOW TO SWITCH
 *   ?env=staging   turn it on  (sticks for the tab via sessionStorage)
 *   ?env=prod      turn it off
 *   localhost      staging automatically — you cannot accidentally point a local
 *                  dev page at the real draft
 *
 * sessionStorage, not localStorage, on purpose: staging must not survive into a new
 * tab opened on draft night. Close the tab, it is gone.
 *
 * Load order: FIRST, before franchise.js and auth.js.
 */
(function () {
  'use strict';

  var KEY = 'wpial_env';
  var SEASON = '2026';

  function qs(name) {
    var m = new RegExp('[?&]' + name + '=([^&#]*)').exec(window.location.search);
    return m ? decodeURIComponent(m[1]) : null;
  }
  function ssGet(k) { try { return window.sessionStorage.getItem(k); } catch (e) { return null; } }
  function ssSet(k, v) { try { window.sessionStorage.setItem(k, v); } catch (e) {} }
  function ssDel(k) { try { window.sessionStorage.removeItem(k); } catch (e) {} }

  function resolve() {
    var asked = (qs('env') || '').toLowerCase();
    if (asked === 'staging') { ssSet(KEY, 'staging'); return 'staging'; }
    if (asked === 'prod' || asked === 'production') { ssDel(KEY); return 'prod'; }

    var host = String(window.location.hostname || '').toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '' || host === '0.0.0.0') return 'staging';

    return ssGet(KEY) === 'staging' ? 'staging' : 'prod';
  }

  var name = resolve();
  var isStaging = name === 'staging';

  /* A staging page must be unmistakable. The one failure mode that would make this
     whole thing worse than not having it is running a test against prod because
     nobody noticed which one they were looking at. */
  function banner() {
    if (!isStaging) return;
    if (document.getElementById('wpial-env-banner')) return;
    var css = document.createElement('style');
    css.textContent =
      '#wpial-env-banner{position:fixed;left:0;right:0;bottom:0;z-index:2147483000;' +
      'background:repeating-linear-gradient(45deg,#7a3b12,#7a3b12 12px,#5c2c0d 12px,#5c2c0d 24px);' +
      'color:#ffe9c9;font:600 12px/1.4 system-ui,sans-serif;letter-spacing:.6px;' +
      'text-align:center;padding:5px 10px;text-transform:uppercase;}' +
      '#wpial-env-banner a{color:#fff;text-decoration:underline;}' +
      'body{padding-bottom:26px;}';
    document.head.appendChild(css);
    var b = document.createElement('div');
    b.id = 'wpial-env-banner';
    b.setAttribute('role', 'status');
    b.innerHTML = 'Staging &middot; draft state is <b>' + 'drafts/staging/' + SEASON + '</b> &middot; ' +
      'nothing here touches the real draft &middot; ' +
      '<a href="' + window.location.pathname + '?env=prod">switch to production</a>';
    (document.body || document.documentElement).appendChild(b);
  }

  if (isStaging) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', banner);
    else banner();
  }

  window.WPIAL_ENV = {
    name: name,
    season: SEASON,
    isStaging: isStaging,
    isProd: !isStaging,
    /** Root path for all shared draft state. Everything realtime hangs off this. */
    draftRoot: 'drafts/' + name + '/' + SEASON,
    /** Namespaced localStorage key, so a staging session cannot poison the real cache. */
    key: function (k) { return isStaging ? k + '__staging' : k; }
  };
})();
