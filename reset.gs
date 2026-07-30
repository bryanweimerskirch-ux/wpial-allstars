/* ============================================================================
 * reset.gs — self-service password reset by emailed code
 *
 *   ⚠⚠ NOT DEPLOYED. NOT WIRED. DEAD CODE, KEPT ON PURPOSE. ⚠⚠
 *   This file does not exist in the Apps Script project and nothing calls it.
 *   It was written 2026-07-30 and shelved the same hour, because the league
 *   moved to Firebase email-link sign-in — passwordless, so there is no
 *   password left to reset. See claude/firebase-auth-migration.md.
 *   Resurrect this ONLY if the Firebase migration is abandoned: paste it in as
 *   a new .gs file, add the two doPost lines below, and re-authorise the new
 *   MailApp scope.
 *
 * ----------------------------------------------------------------------------
 * Replaces "text the commish for a reset" as the recovery path. Six-digit code
 * to the owner's league email, 15-minute expiry, 5 guesses, then they choose a
 * new password and are signed straight in.
 *
 * Wiring: two lines in doPost (Code.gs)
 *   if (e && e.parameter && e.parameter.action === 'auth_reset_request') return waResetRequest_(e);
 *   if (e && e.parameter && e.parameter.action === 'auth_reset_confirm') return waResetConfirm_(e);
 *
 * ⚠ NEW OAUTH SCOPE. MailApp pulls in script.send_mail, so the deployment must be
 * re-authorised once (run any function from the editor, accept the prompt) before
 * this works. Consumer accounts get 100 email recipients/day — a 10-owner league
 * will never see that.
 *
 * The code is never stored, in the sheet or anywhere else. What's cached is an
 * HMAC of it under AUTH_SECRET (the same pepper the passwords use), so reading
 * the cache doesn't hand anyone a working code. CacheService also expires on its
 * own, which is why the deadline isn't tracked in the sheet.
 *
 * `resetOwnerPassword('email')` in auth.gs stays as the manual backstop for the
 * case where someone has lost access to the email account itself.
 * ==========================================================================*/

var WA_RESET_TTL = 900;      // seconds the code stays valid — 15 minutes
var WA_RESET_TRIES = 5;      // wrong guesses before the code dies
var WA_RESET_MAX_REQ = 3;    // codes per email per TTL window, so nobody gets mail-bombed

function waResetKey_(email) {
  return 'wareset_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, waNormEmail_(email))).slice(0, 20);
}
function waResetReqKey_(email) { return waResetKey_(email) + '_n'; }

/** HMAC of the code under the script pepper — never the code itself. */
function waResetHash_(email, code) {
  return waSign_(waNormEmail_(email) + '|' + String(code));
}

/**
 * Six digits. waRandomBytes_ mixes a UUID with Math.random because Apps Script
 * has no CSPRNG; that is weak for a key but fine for a value that lives 15
 * minutes, allows 5 guesses, and is rate limited to 3 issues per window.
 */
function waResetCode_() {
  var b = waRandomBytes_(4);
  var n = 0;
  for (var i = 0; i < 4; i++) n = (n * 256 + (b[i] & 0xff)) % 1000000;
  return String(n).padStart(6, '0');
}

/* -------------------------------------------------------------------------
 * POST action=auth_reset_request { email }
 * ---------------------------------------------------------------------- */
function waResetRequest_(e) {
  var email = waNormEmail_((e.parameter || {}).email);
  if (!email) return waErr_('Email required.', 'no_email');

  var found = waFindOwner_(email);
  // No enumeration hedging here on purpose: auth_status already tells the caller
  // whether an email is on the league list, so pretending otherwise would only
  // strand a real owner waiting on mail that never arrives.
  if (!found) return waErr_('That email is not on the league list. Text the commish.', 'not_member');
  if (!String(found.rec.pass_hash || '').trim()) {
    return waErr_('You have not set a password yet — go back and create one.', 'no_password');
  }

  var cache = CacheService.getScriptCache();
  var reqKey = waResetReqKey_(email);
  var n = Number(cache.get(reqKey) || 0);
  if (n >= WA_RESET_MAX_REQ) {
    return waErr_('Too many reset codes requested. Wait 15 minutes and try again.', 'throttled');
  }
  cache.put(reqKey, String(n + 1), WA_RESET_TTL);

  var code = waResetCode_();
  cache.put(waResetKey_(email), JSON.stringify({ h: waResetHash_(email, code), tries: 0 }), WA_RESET_TTL);

  var team = String(found.rec.team || '').trim();
  MailApp.sendEmail({
    to: email,
    subject: 'WPIAL All Stars — your password reset code: ' + code,
    body: [
      'Your password reset code is: ' + code,
      '',
      'It works for the next 15 minutes. Enter it on wadi.solutions along with the',
      'new password you want' + (team ? ' for ' + team : '') + '.',
      '',
      'If you did not ask for this, you can ignore this email — nothing has changed',
      'on your account, and whoever asked cannot get in without this code.',
      '',
      '— WPIAL All Stars'
    ].join('\n')
  });

  return waJson_({ ok: true, sent: true, expires_in: WA_RESET_TTL });
}

/* -------------------------------------------------------------------------
 * POST action=auth_reset_confirm { email, code, password }
 * On success the caller is signed in, so they never touch the login form.
 * ---------------------------------------------------------------------- */
function waResetConfirm_(e) {
  var p = e.parameter || {};
  var email = waNormEmail_(p.email);
  var code = String(p.code || '').replace(/\D/g, '');
  var pw = String(p.password || '');

  if (!email) return waErr_('Email required.', 'no_email');
  if (code.length !== 6) return waErr_('Enter the 6-digit code from your email.', 'bad_code');
  if (pw.length < 6) return waErr_('Password must be at least 6 characters.', 'weak');

  var cache = CacheService.getScriptCache();
  var key = waResetKey_(email);
  var raw = cache.get(key);
  if (!raw) return waErr_('That code has expired. Request a new one.', 'expired');

  var rec;
  try { rec = JSON.parse(raw); } catch (err) { return waErr_('That code has expired. Request a new one.', 'expired'); }

  if (!waSafeEq_(rec.h, waResetHash_(email, code))) {
    rec.tries = (rec.tries || 0) + 1;
    if (rec.tries >= WA_RESET_TRIES) {
      cache.remove(key);
      return waErr_('Too many wrong codes. Request a new one.', 'burned');
    }
    // Re-put rather than leave it: a wrong guess must not extend the deadline,
    // but CacheService has no "update without touching TTL", so the small TTL
    // refresh here is accepted in exchange for a working attempt counter.
    cache.put(key, JSON.stringify(rec), WA_RESET_TTL);
    return waErr_('That code is not right. ' + (WA_RESET_TRIES - rec.tries) + ' tries left.', 'bad_code');
  }

  var found = waFindOwner_(email);
  if (!found) return waErr_('Account not found.', 'not_member');

  var lock = LockService.getScriptLock();
  try { lock.waitLock(20000); } catch (err) { return waErr_('Busy — try again.', 'locked'); }
  try {
    var salt = Utilities.base64Encode(waRandomBytes_(16));
    var hash = waHash_(pw, salt);
    var sh = waOwnersTab_();
    var now = waNow_();
    sh.getRange(found.row, 5).setValue(hash);   // pass_hash
    sh.getRange(found.row, 6).setValue(salt);   // pass_salt
    sh.getRange(found.row, 8).setValue(now);    // last_login — they're signed in below
    sh.getRange(found.row, 9).setValue((Number(found.rec.login_count) || 0) + 1);
  } finally {
    try { lock.releaseLock(); } catch (err) {}
  }

  // Burn the code and clear both throttles — they've proved control of the inbox.
  cache.remove(key);
  cache.remove(waResetReqKey_(email));
  try { waClearFail_(email); } catch (err) {}

  var fresh = waFindOwner_(email);
  var who = fresh ? fresh.rec : found.rec;
  return waJson_({ ok: true, token: waMakeToken_(who), user: waPublicUser_(who) });
}

/**
 * Ops helper — confirms the new mail scope is granted without touching anyone's
 * password. Run once from the editor after deploying to trigger the consent
 * prompt, then check your inbox.
 */
function testResetMail() {
  var me = Session.getEffectiveUser().getEmail();
  MailApp.sendEmail({
    to: me,
    subject: 'WPIAL All Stars — mail scope test',
    body: 'If you are reading this, MailApp is authorised and password reset will work.'
  });
  Logger.log('Sent to ' + me + '. Remaining quota today: ' + MailApp.getRemainingDailyQuota());
}
