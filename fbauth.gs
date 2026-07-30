/* ============================================================================
 * fbauth.gs — exchange a Firebase ID token for a WPIAL session token
 * ----------------------------------------------------------------------------
 * The whole point of this file is to be the ONLY place that knows Firebase
 * exists. An owner signs in with a Firebase email link, hands us the resulting
 * ID token once, and we hand back the same HMAC session token the site has
 * always used. `keeper_save`, `watchlist_save`, `watchlist_all`, `admin_stats`
 * and `auth_me` are completely unaware anything changed.
 *
 * Wiring: one line in doPost (Code.gs)
 *   if (e && e.parameter && e.parameter.action === 'auth_firebase') return waFbAuth_(e);
 *
 * No setup step required. The web API key is hardcoded below (it is not a
 * secret — it identifies the project, not the caller, and already ships in
 * firebase-config.js). setupFirebaseAuth() exists only to override it from
 * Script Properties if the key is ever rotated.
 *
 * WHY NOT VERIFY THE JWT HERE: a Firebase ID token is RS256, and Apps Script has
 * no RSA verification. Identity Toolkit's accounts:lookup does it for us and
 * returns the user record — one UrlFetchApp call, and only at sign-in, never on
 * subsequent requests. Do not "optimise" this into a local base64 decode: the
 * signature is the only thing making the token worth anything.
 *
 * THE TRUST BOUNDARY: Firebase proves control of an inbox. It does NOT decide
 * who is in the league or which team they own — the Owners tab does, exactly as
 * before. A Firebase account for an address that isn't on the Owners tab gets
 * nothing.
 * ==========================================================================*/

var WA_FB_LOOKUP = 'https://identitytoolkit.googleapis.com/v1/accounts:lookup';
var WA_FB_KEY_PROP = 'FIREBASE_API_KEY';

/* The same web API key that ships in firebase-config.js in the public repo. A
 * Firebase web apiKey identifies the project, not the caller, so it is not a
 * secret and hardcoding it here costs nothing. The Script Property is an
 * OPTIONAL override for rotating it without a redeploy — if it is absent this
 * still works, which is deliberate: sign-in must not depend on a setup step
 * somebody forgot to run. */
var WA_FB_KEY_FALLBACK = 'AIzaSyA-dHNnIHtzUwOWU1Dqa8G5qQ-67pDgg4Y';   // project wpial-allstars

function waFbKey_() {
  var k = '';
  try { k = waProps_().getProperty(WA_FB_KEY_PROP) || ''; } catch (err) { k = ''; }
  return k || WA_FB_KEY_FALLBACK;
}

/**
 * Ask Google whether this ID token is real. Returns the user record or null.
 * Never throws on a bad token — a forged or expired token is an expected input
 * here, not an exceptional one.
 */
function waFbVerify_(idToken) {
  if (!idToken || String(idToken).length < 40) return null;
  var res;
  try {
    res = UrlFetchApp.fetch(WA_FB_LOOKUP + '?key=' + encodeURIComponent(waFbKey_()), {
      method: 'post',
      contentType: 'application/json',
      payload: JSON.stringify({ idToken: String(idToken) }),
      muteHttpExceptions: true
    });
  } catch (err) {
    return null;   // network trouble — caller reports it as unavailable, not invalid
  }
  if (res.getResponseCode() !== 200) return null;

  var body;
  try { body = JSON.parse(res.getContentText()); } catch (err) { return null; }
  if (!body || !body.users || !body.users.length) return null;

  var u = body.users[0];
  if (!u.email) return null;

  // Email-link sign-in sets emailVerified, because tapping the link IS the
  // proof. Anything arriving here unverified did not come from our flow.
  if (u.emailVerified !== true && String(u.emailVerified) !== 'true') return null;

  return u;
}

/* -------------------------------------------------------------------------
 * POST action=auth_firebase { id_token }
 * Returns the same { ok, token, user } shape as auth_login, so the client's
 * success path is identical for both sign-in methods.
 * ---------------------------------------------------------------------- */
function waFbAuth_(e) {
  var idToken = (e.parameter || {}).id_token || (e.parameter || {}).idToken;
  if (!idToken) return waErr_('No sign-in token.', 'no_token');

  var u = waFbVerify_(idToken);
  if (!u) return waErr_('That sign-in link is no longer valid. Ask for a new one.', 'bad_token');

  var email = waNormEmail_(u.email);
  var found = waFindOwner_(email);
  if (!found) {
    // Deliberately specific: the league roster is fixed and known, so there is
    // nothing to leak, and a real owner who used the wrong address needs to be
    // told that's what happened.
    return waErr_('That email is not on the league list. Text the commish to get added.', 'not_member');
  }

  // Same bookkeeping waLogin_ does, so the commish dashboard's engagement
  // numbers keep meaning the same thing regardless of how someone signed in.
  var lock = LockService.getScriptLock();
  try { lock.waitLock(15000); } catch (err) { /* bookkeeping only — never block sign-in */ }
  try {
    var sh = waOwnersTab_();
    sh.getRange(found.row, 8).setValue(waNow_());                                   // last_login
    sh.getRange(found.row, 9).setValue((Number(found.rec.login_count) || 0) + 1);    // login_count
  } catch (err) {
    // A failed counter update must not cost someone their sign-in.
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }

  // Signing in by email link proves the inbox, which is the same thing a
  // password reset would prove — so clear any lockout from failed attempts.
  try { waClearFail_(email); } catch (err) {}

  return waJson_({
    ok: true,
    token: waMakeToken_(found.rec),
    user: waPublicUser_(found.rec),
    method: 'firebase'
  });
}

/* -------------------------------------------------------------------------
 * Ops
 * ---------------------------------------------------------------------- */

/**
 * OPTIONAL. Only needed to rotate the key without redeploying — sign-in works
 * without ever running this, using WA_FB_KEY_FALLBACK.
 */
function setupFirebaseAuth(newKey) {
  var key = newKey || WA_FB_KEY_FALLBACK;
  waProps_().setProperty(WA_FB_KEY_PROP, key);
  Logger.log('FIREBASE_API_KEY override stored (' + key.length + ' chars).');
}

/**
 * Read-only health check. Confirms the key is present and that Identity Toolkit
 * is reachable and answering — a deliberately invalid token should come back as
 * a clean rejection, not an exception.
 */
function testFirebaseAuth() {
  var haveKey = !!waFbKey_();
  var rejected = null;
  try {
    rejected = (waFbVerify_('not-a-real-token-' + new Array(60).join('x')) === null);
  } catch (err) {
    Logger.log('ERROR: ' + err);
  }
  Logger.log('key present: ' + haveKey + ' · bogus token rejected: ' + rejected);
}
