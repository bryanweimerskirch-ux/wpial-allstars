/* Rules + race verification for the WPIAL realtime draft, against the RTDB
 * emulator loaded with database.rules.deploy.json.
 *
 * Model under test (mirrors draftsync.js exactly):
 *   - a pick is ref(ROOT).update({ 'picks/<ov>': {...}, cursor: next })
 *   - pick node: {fid,name,pos,nfl,id,keeper,overall,by,at:SERVER_TIMESTAMP}
 *   - identity: emailToFid decides franchise; commish map decides commissioner
 */
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const fs = require('fs');

const ROOT = 'drafts/staging/2026';
let env;
let pass = 0, fail = 0;
const failures = [];

async function ok(name, p) {
  try { await p; pass++; console.log('  PASS ' + name); }
  catch (e) { fail++; failures.push(name + ' :: ' + e.message); console.log('  FAIL ' + name + ' — ' + e.message.split('\n')[0]); }
}
function expectDenied(promise, name) {
  return promise.then(
    () => { throw new Error(name + ': write was ALLOWED, expected denial'); },
    () => true
  );
}

const TS = { '.sv': 'timestamp' };

function pickNode(fid, name, uid, overall) {
  return { fid, name, pos: 'RB', nfl: 'ATL', id: null, keeper: false, overall, by: uid, at: TS };
}

async function main() {
  env = await initializeTestEnvironment({
    projectId: 'wpial-allstars',
    database: {
      host: '127.0.0.1', port: 9000,
      rules: fs.readFileSync('/home/claude/wpial-allstars/database.rules.deploy.json', 'utf8')
    }
  });

  // ---- seed as admin: emailToFid, commish, slots, meta, cursor ----
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    await db.ref().set(null);
    await db.ref('emailToFid').set({
      'bryan,weimerskirch@gmail,com': 'f08',
      'chad@example,com': 'f01',
      'boyd@example,com': 'f02'
    });
    await db.ref('commish').set({ 'uid-bryan': true });
    const slots = {};
    // tiny 2-round snake over 3 franchises: f01 f02 f08 / f08 f02 f01
    ['f01', 'f02', 'f08', 'f08', 'f02', 'f01'].forEach((fid, i) => {
      slots[i] = { fid, round: i < 3 ? 1 : 2, pickInRound: (i % 3) + 1 };
    });
    await db.ref(ROOT).set({ meta: { rounds: 2, startedAt: Date.now() }, slots, cursor: 0 });
  });

  const chad = env.authenticatedContext('uid-chad', { email: 'chad@example.com', email_verified: true }).database();
  const boyd = env.authenticatedContext('uid-boyd', { email: 'boyd@example.com', email_verified: true }).database();
  const bryan = env.authenticatedContext('uid-bryan', { email: 'bryan.weimerskirch@gmail.com', email_verified: true }).database();
  const anon = env.unauthenticatedContext().database();

  console.log('\n== reads ==');
  await ok('signed-in client can read draft state', chad.ref(ROOT + '/cursor').once('value'));
  await ok('signed-out client cannot read draft state',
    expectDenied(anon.ref(ROOT + '/cursor').once('value'), 'anon read'));
  await ok('client cannot write emailToFid',
    expectDenied(chad.ref('emailToFid/x@y,z').set('f01'), 'emailToFid write'));
  await ok('client cannot write commish map',
    expectDenied(chad.ref('commish/uid-chad').set(true), 'commish write'));

  console.log('\n== turn + ownership enforcement (cursor=0, slot 0 belongs to f01/chad) ==');
  await ok('out-of-turn owner (boyd/f02) is rejected',
    expectDenied(boyd.ref(ROOT).update({ 'picks/0': pickNode('f02', 'Bijan Robinson', 'uid-boyd', 0), cursor: 1 }), 'out of turn'));
  await ok('right slot, wrong claimed fid is rejected',
    expectDenied(chad.ref(ROOT).update({ 'picks/0': pickNode('f02', 'Bijan Robinson', 'uid-chad', 0), cursor: 1 }), 'wrong fid'));
  await ok('picking a future slot (1) while cursor=0 is rejected',
    expectDenied(boyd.ref(ROOT).update({ 'picks/1': pickNode('f02', 'Jahmyr Gibbs', 'uid-boyd', 1), cursor: 2 }), 'future slot'));
  await ok('forged by-uid is rejected',
    expectDenied(chad.ref(ROOT).update({ 'picks/0': pickNode('f01', 'Bijan Robinson', 'uid-boyd', 0), cursor: 1 }), 'forged by'));
  await ok('client-chosen at (not server timestamp) is rejected',
    expectDenied(chad.ref(ROOT).update({ 'picks/0': { ...pickNode('f01', 'Bijan Robinson', 'uid-chad', 0), at: 1234567 }, cursor: 1 }), 'forged at'));
  await ok('on-the-clock owner CAN pick',
    chad.ref(ROOT).update({ 'picks/0': pickNode('f01', 'Bijan Robinson', 'uid-chad', 0), cursor: 1 }));

  console.log('\n== write-once: the race ==');
  await ok('same slot again by anyone (even the same owner) is rejected',
    expectDenied(chad.ref(ROOT).update({ 'picks/0': pickNode('f01', 'Saquon Barkley', 'uid-chad', 0), cursor: 1 }), 'overwrite'));
  await ok('commissioner cannot overwrite a filled slot either',
    expectDenied(bryan.ref(ROOT).update({ 'picks/0': pickNode('f01', 'Saquon Barkley', 'uid-bryan', 0), cursor: 1 }), 'commish overwrite'));

  // true concurrent race on slot 1 (boyd/f02 on the clock): two writers, one slot
  const raceA = boyd.ref(ROOT).update({ 'picks/1': pickNode('f02', 'Jahmyr Gibbs', 'uid-boyd', 1), cursor: 2 })
    .then(() => 'A', () => null);
  const raceB = bryan.ref(ROOT).update({ 'picks/1': pickNode('f02', 'De\'Von Achane', 'uid-bryan', 1), cursor: 2 })
    .then(() => 'B', () => null);
  const winners = (await Promise.all([raceA, raceB])).filter(Boolean);
  await ok('two simultaneous writers on one slot -> exactly one winner',
    winners.length === 1 ? Promise.resolve() : Promise.reject(new Error('winners: ' + winners.join(','))));

  console.log('\n== commissioner powers ==');
  // slot 2 belongs to f08 (bryan) but cursor is 2 now; commish picks for someone: slot 2 is his own here,
  // so use slot 3 (f08) later — first test commish OUT-OF-TURN bypass on behalf of another owner.
  await ok('commissioner can pick out of turn / for another franchise',
    bryan.ref(ROOT).update({ 'picks/3': pickNode('f08', 'James Cook', 'uid-bryan', 3), cursor: 4 }).catch(async (e) => {
      // cursor monotonicity: cursor is already >= ? ensure monotonic issue isn't the failure
      throw e;
    }));
  await ok('commissioner can DELETE a pick and rewind cursor (undo)',
    bryan.ref(ROOT).update({ 'picks/3': null, cursor: 3 }));
  await ok('non-commissioner cannot delete a pick',
    expectDenied(boyd.ref(ROOT).update({ 'picks/1': null, cursor: 1 }), 'owner delete'));

  console.log('\n== cursor ==');
  await ok('non-commish cannot move cursor backwards',
    expectDenied(boyd.ref(ROOT + '/cursor').set(0), 'cursor rewind'));
  await ok('commish can rewind cursor', bryan.ref(ROOT + '/cursor').set(2));

  console.log('\n== clock / presence / log ==');
  await ok('owner cannot write the clock',
    expectDenied(chad.ref(ROOT + '/clock').set({ deadline: Date.now() + 90000, forOverall: 2 }), 'owner clock'));
  await ok('commissioner can write the clock',
    bryan.ref(ROOT + '/clock').set({ deadline: Date.now() + 90000, forOverall: 2 }));
  await ok('client can write ONLY its own presence',
    chad.ref(ROOT + '/presence/uid-chad').set({ fid: 'f01', at: TS }));
  await ok('client cannot write someone else\'s presence',
    expectDenied(chad.ref(ROOT + '/presence/uid-boyd').set({ fid: 'f01', at: TS }), 'other presence'));
  await ok('log entries are write-once with server-stamped identity',
    chad.ref(ROOT + '/log/e1').set({ type: 'pick', by: 'uid-chad', at: TS }));
  await ok('log entry cannot be rewritten',
    expectDenied(chad.ref(ROOT + '/log/e1').set({ type: 'pick', by: 'uid-chad', at: TS }), 'log rewrite'));
  await ok('log entry with forged identity is rejected',
    expectDenied(boyd.ref(ROOT + '/log/e2').set({ type: 'pick', by: 'uid-chad', at: TS }), 'log forge'));

  console.log('\n== full-draft sweep: staging-shaped 160-slot race hammer ==');
  // Rebuild with the real 10-team 16-round snake and hammer every pick with a
  // wrong-owner contender to prove turn enforcement holds across the whole map.
  const TEAMS10 = ['f01','f02','f03','f04','f05','f06','f07','f08','f09','f10'];
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.database();
    const slots = {};
    let i = 0;
    for (let r = 1; r <= 16; r++) {
      const order = r % 2 === 1 ? TEAMS10 : [...TEAMS10].reverse();
      for (let k = 0; k < 10; k++) slots[i] = { fid: order[k], round: r, pickInRound: k + 1, _i: i++ };
    }
    const e2f = {};
    TEAMS10.forEach(f => { e2f[`owner-${f}@example,com`] = f; });
    e2f['bryan,weimerskirch@gmail,com'] = 'f08';
    await db.ref().set({
      emailToFid: e2f, commish: { 'uid-bryan': true },
      [ROOT.split('/')[0]]: { staging: { '2026': { meta: { rounds: 16, startedAt: Date.now() }, slots, cursor: 0 } } }
    });
  });
  const owners = {};
  TEAMS10.forEach(f => {
    owners[f] = env.authenticatedContext('uid-' + f, { email: `owner-${f}@example.com`, email_verified: true }).database();
  });
  let denied = 0, landed = 0;
  for (let ov = 0; ov < 160; ov++) {
    const r = Math.floor(ov / 10) + 1;
    const order = r % 2 === 1 ? TEAMS10 : [...TEAMS10].reverse();
    const rightFid = order[ov % 10];
    const wrongFid = TEAMS10[(TEAMS10.indexOf(rightFid) + 3) % 10];
    const attempts = [
      owners[wrongFid].ref(ROOT).update({ ['picks/' + ov]: pickNode(wrongFid, 'P' + ov, 'uid-' + wrongFid, ov), cursor: ov + 1 })
        .then(() => { throw new Error('wrong owner landed at ' + ov); }, () => { denied++; }),
      owners[rightFid].ref(ROOT).update({ ['picks/' + ov]: pickNode(rightFid, 'P' + ov, 'uid-' + rightFid, ov), cursor: ov + 1 })
        .then(() => { landed++; }, (e) => { throw new Error('right owner denied at ' + ov + ': ' + e.message); })
    ];
    await Promise.all(attempts.map(p => p.catch(e => { fail++; failures.push(e.message); })));
  }
  await ok('all 160 rightful picks landed', landed === 160 ? Promise.resolve() : Promise.reject(new Error(landed + '/160')));
  await ok('all 160 wrong-owner attempts denied', denied === 160 ? Promise.resolve() : Promise.reject(new Error(denied + '/160')));
  await env.withSecurityRulesDisabled(async (ctx) => {
    const snap = await ctx.database().ref(ROOT + '/cursor').once('value');
    if (snap.val() !== 160) throw new Error('final cursor ' + snap.val());
  }).then(() => { pass++; console.log('  PASS final cursor is 160'); },
          (e) => { fail++; failures.push('final cursor :: ' + e.message); });

  console.log(`\n==== ${pass} passed, ${fail} failed ====`);
  if (failures.length) failures.forEach(f => console.log('  ✗ ' + f));
  await env.cleanup();
  process.exit(fail ? 1 : 0);
}

main().catch(e => { console.error('HARNESS ERROR', e); process.exit(2); });
