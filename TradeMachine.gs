/**
 * Trade Machine — Gelly grades (and optionally publishes) mock keeper trades.
 * Routed from doPost:  ?action=gelly_trade   ?action=gelly_publish
 * Reuses generateGellyPost_() so Gelly keeps ONE voice and one set of guardrails,
 * and appendFeedPost_() so a published take is an ordinary league feed post.
 */
var TM_PUB_MAX = 12;    // trade posts pushed to the feed per hour, league-wide
var TM_CACHE_MIN = 30;  // identical trade re-asked inside this window is cached

function tmClip_(s) { return String(s == null ? '' : s).replace(/[\r\n]+/g, ' ').slice(0, 160); }
function tmList_(a) { return (a || []).slice(0, 12).map(tmClip_).join('; ') || 'nothing'; }

/** True when generateGellyPost_ handed back the raw prompt instead of a Gelly take. */
function tmDegraded_(s) {
  s = String(s || '');
  return !s || s.indexOf(TIP_PREFIX) === 0 || s.indexOf('PROPOSED KEEPER TRADE') >= 0;
}

function tmFacts_(b) {
  var A = tmClip_(b.teamA || 'Team A'), B = tmClip_(b.teamB || 'Team B');
  var L = [A + ' sends: ' + tmList_(b.aSends), B + ' sends: ' + tmList_(b.bSends)];
  if (b.verdict) L.push('Calculator verdict: ' + tmClip_(b.verdict));
  if (b.grades) L.push('Grades - ' + A + ': ' + tmClip_(b.grades.A) + ', ' + B + ': ' + tmClip_(b.grades.B));
  if (b.net) L.push('Net keeper-value change - ' + A + ': ' + b.net.A + ', ' + B + ': ' + b.net.B);
  if (b.fix && b.fix.add) L.push('To make it fair, ' + tmClip_(b.fix.from) + ' would need to add: ' + tmClip_(b.fix.add));
  return L.join('\n');
}

function gellyTrade_(e) {
  try {
    var b = JSON.parse(e.postData.contents || '{}');
    if (!(b.aSends || []).length && !(b.bSends || []).length) {
      return jsonOut_({ text: "There's nothin' in this trade. I've done the research." });
    }
    var facts = tmFacts_(b);
    var cache = CacheService.getScriptCache();
    var ck = 'tm_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, facts));
    var hit = cache.get(ck);
    if (hit && !tmDegraded_(hit)) return jsonOut_({ text: hit, cached: true });

    var raw =
      'PROPOSED KEEPER TRADE - react to it like the insider you are.\n' + facts + '\n\n' +
      "Context you need: this is a KEEPER league. Each team keeps up to 5 players, one per round, " +
      "and keeping a player costs that team its draft pick in that player's round value. A stud who " +
      "costs a late round is a steal; a good-not-great player who costs a 1st is a trap. Judge the " +
      "deal on round cost, not name value. Name a specific player or pick and say why the round " +
      "makes it good or bad. If a fairness fix is listed above, END with a concrete counter-offer naming " +
      "that exact piece (e.g. \"throw in the 2027 3rd and I'd sign it\"). 2-3 sentences, under 70 words. " +
      "No headers, no bullet points.";

    var out = String(generateGellyPost_(raw) || '').replace(/\s+/g, ' ').trim();
    // generateGellyPost_ returns TIP_PREFIX + the raw prompt whenever Gemini is
    // unavailable. Never let that leak to a member - fall back to Gelly's own lines.
    if (tmDegraded_(out)) return jsonOut_({ text: tmFallback_(b), degraded: true });
    out = out.slice(0, 600);
    cache.put(ck, out, TM_CACHE_MIN * 60);
    return jsonOut_({ text: out });
  } catch (err) {
    return jsonOut_({ text: "Gelly dropped his phone in the Mon. Try again in a minute.", error: String(err) });
  }
}

function gellyPublish_(e) {
  try {
    var b = JSON.parse(e.postData.contents || '{}');
    var take = tmClip_(b.text).slice(0, 600);
    if (!take) return jsonOut_({ ok: false, error: 'nothing to post' });

    var cache = CacheService.getScriptCache();
    var n = Number(cache.get('tm_pub_count') || 0);
    if (n >= TM_PUB_MAX) return jsonOut_({ ok: false, error: 'rate limited' });

    var dk = 'tm_pub_' + Utilities.base64EncodeWebSafe(
      Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, take));
    if (cache.get(dk)) return jsonOut_({ ok: true, duplicate: true });

    var A = tmClip_(b.teamA || 'Team A'), B = tmClip_(b.teamB || 'Team B');
    var post = 'TRADE BUZZ - ' + A + ' vs ' + B + '\n\n' + take + '\n\n' +
      A + ' sends: ' + tmList_(b.aSends) + '\n' +
      B + ' sends: ' + tmList_(b.bSends);

    appendFeedPost_(getTab_(FEED_SHEET), post, 'Trade Machine');
    cache.put(dk, '1', 600);
    cache.put('tm_pub_count', String(n + 1), 3600);
    return jsonOut_({ ok: true });
  } catch (err) {
    return jsonOut_({ ok: false, error: String(err) });
  }
}

/** Used only if the Gemini call comes back empty. */
function tmFallback_(b) {
  var a = (b && b.net && Number(b.net.A)) || 0, x = (b && b.net && Number(b.net.B)) || 0;
  var A = (b && b.teamA) || 'Team A', B = (b && b.teamB) || 'Team B';
  if (Math.abs(a - x) < 2) return "Dead even. Nobody wins, nobody cries, I've got reports to write.";
  var w = a > x ? A : B, l = a > x ? B : A;
  if (Math.abs(a - x) > 30) return "SIREN. " + w + " is takin' " + l + "'s lunch money AND the lunch box. Veto it.";
  return w + " comes out ahead here. " + l + ", read the round values before you hit send. I've done the research.";
}
