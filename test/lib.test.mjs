import test from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const many = (n, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('normalizeHandle lowercases, strips @ and rejects non-handles', () => {
  assert.equal(lib.normalizeHandle(' @Known_Slop '), 'known_slop');
  assert.equal(lib.normalizeHandle('user_7234'), 'user_7234');
  assert.equal(lib.normalizeHandle('a_b'), 'a_b');
  assert.equal(lib.normalizeHandle('sixteen_chars_xx'), null);
  assert.equal(lib.normalizeHandle('has space'), null);
  assert.equal(lib.normalizeHandle('<html>'), null);
  assert.equal(lib.normalizeHandle(''), null);
  assert.equal(lib.normalizeHandle(null), null);
});

test('parseList dedupes, sorts, skips comments and counts junk', () => {
  const r = lib.parseList('known_slop\r\nKnown_Slop\n\n# comment\n! filter header\n@grok\nnot a handle\nfake_slop\n');
  assert.deepEqual(r.handles, ['fake_slop', 'grok', 'known_slop']);
  assert.equal(r.rejected, 1);
  assert.equal(r.error, null);
});

test('parseList refuses a feed over maxHandles', () => {
  const r = lib.parseList(many(11).join('\n'), { maxHandles: 10 });
  assert.equal(r.error, 'too many handles');
  assert.deepEqual(r.handles, []);
});

test('acceptUpdate refuses an empty list', () => {
  assert.deepEqual(lib.acceptUpdate(['a'], []), { ok: false, reason: 'empty list' });
});

// Planted negative: a truncated feed must not replace a healthy stored list.
test('acceptUpdate refuses a feed that shrank from 369 to 10', () => {
  const v = lib.acceptUpdate(many(369), many(10));
  assert.equal(v.ok, false);
  assert.match(v.reason, /shrank from 369 to 10/);
});

test('acceptUpdate allows normal churn and first loads', () => {
  assert.equal(lib.acceptUpdate(many(369), many(300)).ok, true);
  assert.equal(lib.acceptUpdate(null, many(3)).ok, true);
  // Below the guard floor a ratio means nothing, so a small list may change freely.
  assert.equal(lib.acceptUpdate(many(10), many(2)).ok, true);
});

test('isDue honours the refresh interval', () => {
  const hour = 3600000;
  assert.equal(lib.isDue(0, 5, 360), true);
  assert.equal(lib.isDue(undefined, 5, 360), true);
  assert.equal(lib.isDue(10 * hour, 15 * hour, 360), false);
  assert.equal(lib.isDue(10 * hour, 16 * hour, 360), true);
});

function fakeFetch({ status = 200, body = '', ctype = 'text/plain; charset=utf-8', throws = null }) {
  const calls = [];
  const impl = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new Error(throws);
    return { ok: status >= 200 && status < 300, status, headers: { get: () => ctype }, text: async () => body };
  };
  return { impl, calls };
}

test('fetchList accepts a good feed and requests it without credentials', async () => {
  const f = fakeFetch({ body: 'known_slop\nfake_slop\n' });
  const r = await lib.fetchList({ url: 'https://feed.example/u.txt', fetchImpl: f.impl });
  assert.deepEqual(r, { ok: true, handles: ['fake_slop', 'known_slop'], rejected: 0 });
  assert.equal(f.calls[0].url, 'https://feed.example/u.txt');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.cache, 'no-store');
});

test('fetchList defaults to the clankwall feed', async () => {
  const f = fakeFetch({ body: 'known_slop\n' });
  await lib.fetchList({ fetchImpl: f.impl });
  assert.equal(f.calls[0].url, 'https://clankwall.vogel.dev/api/usernames.txt');
});

test('fetchList fails closed on HTTP, HTML, junk, size, network and shrink', async () => {
  const cases = [
    [{ status: 503 }, /HTTP 503/],
    [{ ctype: 'text/html', body: 'known_slop' }, /content-type/],
    [{ body: 'ok\n<!doctype html>\n<p>error page</p>\n<div>\n' }, /mostly not handles/],
    [{ body: 'x'.repeat(20) }, /larger than 10 bytes/, { maxBytes: 10 }],
    [{ throws: 'offline' }, /network error: offline/],
    [{ body: many(5).join('\n') }, /shrank/, { prevHandles: many(369) }],
  ];
  for (const [resp, re, extra] of cases) {
    const r = await lib.fetchList({ fetchImpl: fakeFetch(resp).impl, ...(extra || {}) });
    assert.equal(r.ok, false, `expected failure for ${JSON.stringify(resp)}`);
    assert.match(r.reason, re);
  }
});

test('nextRecord keeps the previous list and fetchedAt on failure', () => {
  const prev = { handles: ['a', 'b'], fetchedAt: 100, source: 's', lastAttemptAt: 100, lastError: null };
  const failed = lib.nextRecord(prev, { ok: false, reason: 'HTTP 503' }, 's', 200);
  assert.deepEqual(failed, { handles: ['a', 'b'], fetchedAt: 100, source: 's', lastAttemptAt: 200, lastError: 'HTTP 503' });
  const ok = lib.nextRecord(prev, { ok: true, handles: ['c'] }, 's2', 300);
  assert.deepEqual(ok, { handles: ['c'], fetchedAt: 300, source: 's2', lastAttemptAt: 300, lastError: null });
  const first = lib.nextRecord(undefined, { ok: false, reason: 'offline' }, 's', 5);
  assert.deepEqual(first.handles, []);
  assert.equal(first.lastError, 'offline');
});

test('commitRecord drops a result that a newer success superseded', () => {
  const latest = { handles: ['a', 'b'], fetchedAt: 300, source: 's', lastAttemptAt: 300, lastError: null, seq: 2 };
  // Started at seq 1, but seq 2 committed meanwhile: write nothing.
  assert.equal(lib.commitRecord(latest, { ok: false, reason: 'HTTP 503' }, 's', 1, 400), null);
  assert.equal(lib.commitRecord(latest, { ok: true, handles: ['z'] }, 's', 1, 400), null);
  // Nothing newer: a failure keeps the stored list, a success replaces it and bumps seq.
  const failed = lib.commitRecord(latest, { ok: false, reason: 'HTTP 503' }, 's', 2, 400);
  assert.deepEqual(failed, { ...latest, lastAttemptAt: 400, lastError: 'HTTP 503' });
  const ok = lib.commitRecord(latest, { ok: true, handles: ['c'] }, 's', 2, 400);
  assert.deepEqual(ok, { handles: ['c'], fetchedAt: 400, source: 's', lastAttemptAt: 400, lastError: null, seq: 3 });
  // A record stored by 0.1.0 has no seq; it counts as 0.
  assert.equal(lib.commitRecord({ handles: ['a'], fetchedAt: 1, source: 's' }, { ok: true, handles: ['b'] }, 's', 0, 5).seq, 1);
  assert.equal(lib.commitRecord(null, { ok: false, reason: 'offline' }, 's', 0, 5).seq, 0);
});

test('isRefreshDue waits out the retry gap after a failed attempt', () => {
  const min = 60 * 1000;
  const hour = 60 * min;
  assert.equal(lib.isRefreshDue(null, 5), true);
  assert.equal(lib.isRefreshDue({ fetchedAt: 10 * hour, lastAttemptAt: 10 * hour }, 15 * hour), false);
  assert.equal(lib.isRefreshDue({ fetchedAt: 10 * hour, lastAttemptAt: 10 * hour }, 16 * hour), true);
  // The list is stale and the last attempt failed: wait 30 minutes between tries.
  assert.equal(lib.isRefreshDue({ fetchedAt: 0, lastAttemptAt: 20 * hour }, 20 * hour + 29 * min), false);
  assert.equal(lib.isRefreshDue({ fetchedAt: 0, lastAttemptAt: 20 * hour }, 20 * hour + 30 * min), true);
});

test('parseAllowlist accepts newlines, commas, spaces and @', () => {
  assert.deepEqual([...lib.parseAllowlist('@Grok, known_slop\n  bad handle!! x_y')].sort(), ['bad', 'grok', 'known_slop', 'x_y']);
  assert.equal(lib.parseAllowlist(undefined).size, 0);
});

test('pageOwner reads the first path segment', () => {
  assert.equal(lib.pageOwner('/Known_Slop/with_replies'), 'known_slop');
  assert.equal(lib.pageOwner('/known_slop/status/123'), 'known_slop');
  assert.equal(lib.pageOwner('/'), null);
  assert.equal(lib.pageOwner('/i/lists/1'), 'i');
});

test('shouldHide needs a listed, non-allowlisted author off their own page', () => {
  const list = new Set(['known_slop', 'grok']);
  const base = { list, allow: new Set(), owner: null, paused: false };
  assert.equal(lib.shouldHide('known_slop', base), true);
  assert.equal(lib.shouldHide('someone', base), false);
  assert.equal(lib.shouldHide(null, base), false);
  assert.equal(lib.shouldHide('known_slop', { ...base, paused: true }), false);
  assert.equal(lib.shouldHide('grok', { ...base, allow: new Set(['grok']) }), false);
  assert.equal(lib.shouldHide('known_slop', { ...base, owner: 'known_slop' }), false);
  assert.equal(lib.shouldHide('grok', { ...base, owner: 'known_slop' }), true);
});

test('effectiveAllow adds @grok only when showGrok is on', () => {
  assert.deepEqual([...lib.effectiveAllow({ allowlist: 'friend' })].sort(), ['friend']);
  assert.deepEqual([...lib.effectiveAllow({ allowlist: 'friend', showGrok: true })].sort(), ['friend', 'grok']);
  assert.equal(lib.effectiveAllow(undefined).size, 0);
  assert.equal(lib.effectiveAllow({}).has('grok'), false);
  // Only a real true counts; a stray string from hand-edited storage does not.
  assert.equal(lib.effectiveAllow({ showGrok: 'false' }).has('grok'), false);
});

// Planted negative: the switch must not widen into a general allow.
test('showGrok unhides @grok and no other listed author', () => {
  const list = new Set(['known_slop', 'grok']);
  const allow = lib.effectiveAllow({ showGrok: true });
  assert.equal(lib.shouldHide('grok', { list, allow }), false);
  assert.equal(lib.shouldHide('known_slop', { list, allow }), true);
});

// ---------------------------------------------------------------- muting

const NOW = Date.UTC(2026, 10, 6, 12, 0, 0);
const DAY = '2026-11-06';

test('chooseMuteItem picks the one exact Mute item, matched without case or spacing', () => {
  assert.deepEqual(lib.chooseMuteItem(['Follow @Slop_A', ' Mute ', 'Block @slop_a'], 'slop_a'), { action: 'click', index: 1 });
  assert.deepEqual(lib.chooseMuteItem(['Mute @Slop_A'], 'slop_a'), { action: 'click', index: 0 });
  assert.deepEqual(lib.chooseMuteItem(['Unmute', 'Block @slop_a'], 'slop_a'), { action: 'done', status: 'already' });
  assert.deepEqual(lib.chooseMuteItem(['Unmute @slop_a'], 'slop_a'), { action: 'done', status: 'already' });
  const f = lib.chooseMuteItem(['Unfollow @slop_a', 'Mute'], 'slop_a');
  assert.equal(f.status, 'followed');
  assert.equal(f.stopDay, false);
});

// Planted negatives: never "Mute this conversation", never a guess between two.
test('chooseMuteItem refuses a menu without exactly one Mute item, and stops the day', () => {
  for (const items of [['Mute this conversation'], ['Mute @someone_else'], ['Mute', 'Mute @slop_a'], []]) {
    const r = lib.chooseMuteItem(items, 'slop_a');
    assert.equal(r.action, 'refuse');
    assert.equal(r.status, 'refused');
    assert.equal(r.stopDay, true);
  }
});

test('muteCandidates: front queue first, then the list, then retries; never @grok, the allowlist, unlisted or settled accounts', () => {
  const rec = {
    ...lib.emptyMutes(),
    front: ['slop_c', 'human'],
    handles: {
      done_a: { status: 'muted' },
      gone: { status: 'no-post', attempts: 2 },
      once: { status: 'no-post', attempts: 1 },
      flaky: { status: 'error', attempts: 1 },
    },
  };
  const list = ['done_a', 'flaky', 'friend', 'gone', 'grok', 'once', 'slop_b', 'slop_c'];
  // showGrok only governs hiding; @grok is never muted either way.
  for (const showGrok of [false, true]) {
    assert.deepEqual(lib.muteCandidates(list, { allowlist: '@Friend', showGrok }, rec), ['slop_c', 'slop_b', 'flaky', 'once']);
  }
  // A no-post recorded before attempts were counted is tried once more.
  assert.deepEqual(lib.muteCandidates(['old'], {}, { ...lib.emptyMutes(), handles: { old: { status: 'no-post' } } }), ['old']);
});

test('muteBudget counts down both caps for the UTC day', () => {
  const rec = { ...lib.emptyMutes(), days: { [DAY]: { mutes: 24, visits: 49, stopped: null } } };
  assert.deepEqual(lib.muteBudget(rec, DAY), { mutesLeft: 1, visitsLeft: 1, stopped: null, mutes: 24, visits: 49 });
  assert.deepEqual(lib.muteBudget(rec, '2026-11-07'), { mutesLeft: 25, visitsLeft: 50, stopped: null, mutes: 0, visits: 0 });
  assert.equal(lib.utcDay(Date.UTC(2026, 10, 6, 23, 59, 59)), DAY);
});

test('recordOutcome: a mute counts, waits for a check and leaves the front queue', () => {
  const start = lib.countVisit({ ...lib.emptyMutes(), front: ['slop_a', 'slop_b'] }, NOW);
  const r = lib.recordOutcome(start, 'slop_a', { status: 'muted', toast: '@slop_a has been muted.Undo' }, NOW);
  assert.deepEqual(r.days[DAY], { mutes: 1, visits: 1, stopped: null });
  assert.deepEqual(r.handles.slop_a, { status: 'muted', at: NOW, toast: '@slop_a has been muted.Undo', confirmed: null });
  assert.deepEqual(r.sinceCheck, ['slop_a']);
  assert.deepEqual(r.front, ['slop_b']);
  assert.equal(start.handles.slop_a, undefined, 'the input record is not changed');
});

test('recordOutcome: already/followed settle without a mute; no-post settles the second time; refused stops the day but is retried later', () => {
  let r = lib.emptyMutes();
  for (const status of ['already', 'followed', 'no-post']) r = lib.recordOutcome(r, status.replace('-', '_'), { status }, NOW);
  assert.equal(r.days[DAY].mutes, 0);
  assert.equal(r.days[DAY].stopped, null);
  assert.equal(r.handles.no_post.attempts, 1);
  r = lib.recordOutcome(r, 'odd', { status: 'refused', reason: '0 exact Mute items' }, NOW);
  assert.equal(r.days[DAY].stopped, '@odd: refused (0 exact Mute items)');
  const list = ['already', 'followed', 'no_post', 'odd'];
  // Both are being tried again, so they keep list order.
  assert.deepEqual(lib.muteCandidates(list, {}, r), ['no_post', 'odd']);
  r = lib.recordOutcome(r, 'no_post', { status: 'no-post' }, NOW);
  assert.equal(r.handles.no_post.attempts, 2);
  assert.deepEqual(lib.muteCandidates(list, {}, r), ['odd']);
});

test('recordOutcome: errors are retried once, then the account is left alone', () => {
  let r = lib.recordOutcome(lib.emptyMutes(), 'slop_a', { status: 'error', reason: 'timeout' }, NOW);
  assert.equal(r.handles.slop_a.status, 'error');
  assert.deepEqual(lib.muteCandidates(['slop_a'], {}, r), ['slop_a']);
  r = lib.recordOutcome(r, 'slop_a', { status: 'error', reason: 'timeout' }, NOW);
  assert.equal(r.handles.slop_a.status, 'failed');
  assert.deepEqual(lib.muteCandidates(['slop_a'], {}, r), []);
});

test('recordOutcome: a wrong account or a login page stops the day and records nothing per account', () => {
  for (const status of ['wrong-account', 'login']) {
    const r = lib.recordOutcome(lib.emptyMutes(), 'slop_a', { status }, NOW);
    assert.match(r.days[DAY].stopped, new RegExp(`^@slop_a: ${status}`));
    assert.equal(r.handles.slop_a, undefined);
  }
});

// Planted negative: '__proto__' and 'constructor' are valid handles; on a plain
// object they read as Object's own keys, so they were retried for ever.
test("handles named like Object's keys are kept as ordinary accounts", () => {
  const s = { extraList: '__proto__\nconstructor\nprototype' };
  const eligible = lib.muteEligible([], s);
  assert.deepEqual(eligible, ['__proto__', 'constructor', 'prototype']);
  let rec = lib.emptyMutes();
  assert.deepEqual(lib.muteCandidates([], s, rec), eligible, 'untried, so not retries');
  rec = lib.recordOutcome(rec, '__proto__', { status: 'muted' }, NOW);
  rec = lib.recordOutcome(rec, 'constructor', { status: 'already' }, NOW);
  rec = JSON.parse(JSON.stringify(rec)); // as storage keeps it
  assert.equal(Object.getPrototypeOf(rec.handles), Object.prototype);
  assert.deepEqual(Object.keys(rec.handles).sort(), ['__proto__', 'constructor']);
  assert.deepEqual(lib.muteCandidates([], s, rec), ['prototype']);
  const sum = lib.muteSummary(rec);
  assert.deepEqual([sum.muted, sum.already], [1, 1]);
  const checked = lib.recordCheck(rec, ['__proto__'], NOW + 1).rec;
  assert.equal(Object.getOwnPropertyDescriptor(checked.handles, '__proto__').value.confirmed, true);
});

test('recordCheck confirms mutes seen in the rows and stops the day for any missing', () => {
  let r = lib.emptyMutes();
  for (const h of ['m1', 'm2']) r = lib.recordOutcome(r, h, { status: 'muted' }, NOW);
  const ok = lib.recordCheck(r, ['M2', 'm1', 'older'], NOW + 1);
  assert.deepEqual(ok.missing, []);
  assert.equal(ok.rec.handles.m1.confirmed, true);
  assert.deepEqual(ok.rec.sinceCheck, []);
  assert.equal(ok.rec.days[DAY].stopped, null);
  const miss = lib.recordCheck(r, ['m1'], NOW + 1);
  assert.deepEqual(miss.missing, ['m2']);
  assert.equal(miss.rec.handles.m2.confirmed, false);
  assert.equal(miss.rec.days[DAY].stopped, 'not on settings/muted/all after muting: @m2');
  assert.deepEqual(lib.muteSummary(miss.rec), { muted: 2, confirmed: 1, notFound: 1, already: 0, followed: 0, skipped: 0 });
});

test('noteSighting moves an account to the front, once, capped at muteFrontMax', () => {
  let r = lib.emptyMutes();
  for (let i = 0; i < 60; i++) r = lib.noteSighting(r, `h${i}`);
  r = lib.noteSighting(r, 'h30');
  assert.equal(r.front.length, lib.DEFAULTS.muteFrontMax);
  assert.equal(r.front[0], 'h30');
  assert.equal(r.front.filter((h) => h === 'h30').length, 1);
});

// ------------------------------------------------------------------ bots

const ROSTER = ['grok', 'askperplexity', 'pangramlabs', 'bot', 'threadreaderapp', 'unrollhelper'];
// Plain objects: botModes builds its result in the test's own realm, but keep the
// comparison independent of key order.
const modesOf = (settings, list) => Object.fromEntries(Object.entries(lib.botModes(settings, list)).sort());
const expectModes = (pairs) => Object.fromEntries(Object.entries(pairs).sort());

test('the bot roster is the six bots the issue names, with lowercase handles', () => {
  assert.deepEqual(
    lib.BOTS.map((b) => b.handle),
    ROSTER,
  );
  for (const b of lib.BOTS) assert.equal(lib.normalizeHandle(b.name), b.handle);
  assert.deepEqual([...lib.BOT_MODES], ['show', 'hide', 'mute']);
});

test('a bot with no saved choice follows the list: hidden if listed, shown if not', () => {
  const all = (mode) => Object.fromEntries(ROSTER.map((h) => [h, mode]));
  // clankwall listed @grok on 2026-11-06, and none of the others.
  assert.deepEqual(modesOf({}, ['known_slop', 'grok']), expectModes({ ...all('show'), grok: 'hide' }));
  assert.deepEqual(modesOf({}, ['known_slop']), expectModes(all('show')));
  assert.deepEqual(modesOf(undefined, undefined), expectModes(all('show')));
  // A bot later added to the list, or to the user's extra accounts, flips to Hide.
  assert.deepEqual(modesOf({}, ['grok', 'askperplexity']), expectModes({ ...all('show'), grok: 'hide', askperplexity: 'hide' }));
  assert.deepEqual(modesOf({ extraList: '@PangramLabs' }, []), expectModes({ ...all('show'), pangramlabs: 'hide' }));
});

test('a saved choice wins over the list, an Always-show entry wins over both, and bad values are ignored', () => {
  const m = modesOf({ bots: { grok: 'show', askperplexity: 'mute', bot: 'hide', pangramlabs: 'loud' } }, ['grok']);
  assert.equal(m.grok, 'show');
  assert.equal(m.askperplexity, 'mute');
  assert.equal(m.bot, 'hide');
  assert.equal(m.pangramlabs, 'show', 'an unknown value falls back to the list');
  assert.equal(modesOf({ bots: { grok: 'mute' }, allowlist: 'grok' }, ['grok']).grok, 'show');
  assert.equal(lib.botChoice({ bots: 'grok' }, 'grok'), null);
  assert.equal(lib.botChoice({ bots: { grok: 'Show' } }, 'grok'), null, 'modes are exact');
});

test("0.3.0's showGrok means @grok is set to Show, until its row is changed", () => {
  assert.equal(lib.botChoice({ showGrok: true }, 'grok'), 'show');
  assert.equal(lib.botChoice({ showGrok: true }, 'askperplexity'), null, 'showGrok covers only @grok');
  assert.equal(lib.botChoice({ showGrok: 'true' }, 'grok'), null);
  assert.equal(lib.botChoice({ showGrok: false }, 'grok'), null);
  assert.equal(lib.botChoice({ showGrok: true, bots: { grok: 'hide' } }, 'grok'), 'hide');
  assert.equal(modesOf({ showGrok: true }, ['grok']).grok, 'show');
  // Reading never rewrites what is stored.
  const s = Object.freeze({ showGrok: true, bots: Object.freeze({}) });
  lib.botModes(s, ['grok']);
  lib.effectiveAllow(s);
  lib.effectiveList(['grok'], s);
  lib.muteEligible(['grok'], s);
});

test('effectiveAllow adds bots set to Show; effectiveList adds extra accounts and bots set to Hide or Mute', () => {
  const s = { allowlist: 'friend', extraList: 'Extra_A, extra_b', bots: { askperplexity: 'show', bot: 'hide', pangramlabs: 'mute' } };
  assert.deepEqual([...lib.effectiveAllow(s)].sort(), ['askperplexity', 'friend']);
  assert.deepEqual([...lib.effectiveList(['slop_a'], s)].sort(), ['bot', 'extra_a', 'extra_b', 'pangramlabs', 'slop_a']);
  // A bot at its default adds nothing: the list decides.
  assert.deepEqual([...lib.effectiveList(['grok'], {})], ['grok']);
  assert.deepEqual([...lib.effectiveAllow({})], []);
});

test('mentionTargets is empty until hideBotMentions is on, then holds the bots not shown', () => {
  assert.deepEqual([...lib.mentionTargets({}, ['grok'])], []);
  assert.deepEqual([...lib.mentionTargets({ hideBotMentions: 'true' }, ['grok'])], []);
  assert.deepEqual([...lib.mentionTargets({ hideBotMentions: true }, ['grok'])], ['grok']);
  const s = { hideBotMentions: true, bots: { grok: 'show', askperplexity: 'mute', bot: 'hide' } };
  assert.deepEqual([...lib.mentionTargets(s, ['grok'])].sort(), ['askperplexity', 'bot']);
});

test('shouldHideMention spares your own posts, Always-show authors and pages opened on purpose', () => {
  const mentions = new Set(['grok']);
  const base = { allow: new Set(['friend']), owner: null, paused: false, me: 'startupbros', mentions };
  assert.equal(lib.shouldHideMention('rando', 'grok', base), true);
  assert.equal(lib.shouldHideMention('rando', null, base), false);
  assert.equal(lib.shouldHideMention(null, 'grok', base), false);
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, paused: true }), false);
  assert.equal(lib.shouldHideMention('friend', 'grok', base), false);
  assert.equal(lib.shouldHideMention('startupbros', 'grok', base), false);
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, owner: 'rando' }), false, "on the author's page");
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, owner: 'grok' }), false, "on the bot's page");
  assert.equal(lib.shouldHideMention('rando', 'grok', { ...base, owner: 'someone_else' }), true);
});

// Planted negatives: @grok at its default (Hide) is never visited, and an
// extra account that is also on the allowlist is never muted.
test('muteEligible: the list, then sorted extra accounts, then bots set to Mute; never Always-show or other bots', () => {
  const list = ['grok', 'slop_a', 'slop_b'];
  assert.deepEqual(lib.muteEligible(list, {}), ['slop_a', 'slop_b']);
  assert.deepEqual(lib.muteEligible(list, { extraList: 'zed\nAlpha\nslop_a' }), ['slop_a', 'slop_b', 'alpha', 'zed']);
  assert.deepEqual(lib.muteEligible(list, { extraList: 'friend extra', allowlist: 'friend' }), ['slop_a', 'slop_b', 'extra']);
  for (const mode of ['show', 'hide']) {
    assert.deepEqual(lib.muteEligible(list, { bots: { grok: mode, askperplexity: mode } }), ['slop_a', 'slop_b']);
  }
  // A bot in the extra box is hidden but still muted only when its row says so.
  assert.deepEqual(lib.muteEligible([], { extraList: 'grok' }), []);
  assert.deepEqual(lib.muteEligible(list, { bots: { askperplexity: 'mute', grok: 'mute' } }), ['grok', 'slop_a', 'slop_b', 'askperplexity']);
  assert.deepEqual(lib.muteEligible(list, { bots: { grok: 'mute' }, allowlist: 'grok' }), ['slop_a', 'slop_b']);
  assert.deepEqual(lib.muteEligible(list, { showGrok: true, bots: {} }), ['slop_a', 'slop_b']);
});

test('muteCandidates follows muteEligible: a bot set to Mute and extra accounts enter the queue', () => {
  const rec = { ...lib.emptyMutes(), front: ['grok', 'extra_a'], handles: { slop_a: { status: 'muted' } } };
  const s = { extraList: 'extra_a', bots: { askperplexity: 'mute' } };
  assert.deepEqual(lib.muteCandidates(['grok', 'slop_a'], s, rec), ['extra_a', 'askperplexity']);
  assert.deepEqual(lib.muteCandidates(['grok', 'slop_a'], { ...s, bots: { askperplexity: 'hide' } }, rec), ['extra_a']);
});
