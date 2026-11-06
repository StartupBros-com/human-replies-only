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

test('muteCandidates: front queue first, then the list; never @grok, the allowlist, unlisted or settled accounts', () => {
  const rec = {
    ...lib.emptyMutes(),
    front: ['slop_c', 'human'],
    handles: { done_a: { status: 'muted' }, gone: { status: 'no-post' }, flaky: { status: 'error', attempts: 1 } },
  };
  const list = ['done_a', 'flaky', 'friend', 'gone', 'grok', 'slop_b', 'slop_c'];
  // showGrok only governs hiding; @grok is never muted either way.
  for (const showGrok of [false, true]) {
    assert.deepEqual(lib.muteCandidates(list, { allowlist: '@Friend', showGrok }, rec), ['slop_c', 'flaky', 'slop_b']);
  }
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

test('recordOutcome: already/followed/no-post settle without a mute; refused stops the day but is retried later', () => {
  let r = lib.emptyMutes();
  for (const status of ['already', 'followed', 'no-post']) r = lib.recordOutcome(r, status.replace('-', '_'), { status }, NOW);
  assert.equal(r.days[DAY].mutes, 0);
  assert.equal(r.days[DAY].stopped, null);
  r = lib.recordOutcome(r, 'odd', { status: 'refused', reason: '0 exact Mute items' }, NOW);
  assert.equal(r.days[DAY].stopped, '@odd: refused (0 exact Mute items)');
  assert.deepEqual(lib.muteCandidates(['already', 'followed', 'no_post', 'odd'], {}, r), ['odd']);
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
