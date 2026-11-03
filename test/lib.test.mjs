import test from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const many = (n, prefix = 'h') => Array.from({ length: n }, (_, i) => `${prefix}${i}`);

test('normalizeHandle lowercases, strips @ and rejects non-handles', () => {
  assert.equal(lib.normalizeHandle(' @KaiBGR '), 'kaibgr');
  assert.equal(lib.normalizeHandle('votta7234'), 'votta7234');
  assert.equal(lib.normalizeHandle('a_b'), 'a_b');
  assert.equal(lib.normalizeHandle('sixteen_chars_xx'), null);
  assert.equal(lib.normalizeHandle('has space'), null);
  assert.equal(lib.normalizeHandle('<html>'), null);
  assert.equal(lib.normalizeHandle(''), null);
  assert.equal(lib.normalizeHandle(null), null);
});

test('parseList dedupes, sorts, skips comments and counts junk', () => {
  const r = lib.parseList('kaibgr\r\nKaiBGR\n\n# comment\n! filter header\n@grok\nnot a handle\nfrontmostai\n');
  assert.deepEqual(r.handles, ['frontmostai', 'grok', 'kaibgr']);
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
  const f = fakeFetch({ body: 'kaibgr\nfrontmostai\n' });
  const r = await lib.fetchList({ url: 'https://feed.example/u.txt', fetchImpl: f.impl });
  assert.deepEqual(r, { ok: true, handles: ['frontmostai', 'kaibgr'], rejected: 0 });
  assert.equal(f.calls[0].url, 'https://feed.example/u.txt');
  assert.equal(f.calls[0].init.credentials, 'omit');
  assert.equal(f.calls[0].init.cache, 'no-store');
});

test('fetchList defaults to the clankwall feed', async () => {
  const f = fakeFetch({ body: 'kaibgr\n' });
  await lib.fetchList({ fetchImpl: f.impl });
  assert.equal(f.calls[0].url, 'https://clankwall.vogel.dev/api/usernames.txt');
});

test('fetchList fails closed on HTTP, HTML, junk, size, network and shrink', async () => {
  const cases = [
    [{ status: 503 }, /HTTP 503/],
    [{ ctype: 'text/html', body: 'kaibgr' }, /content-type/],
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

test('parseAllowlist accepts newlines, commas, spaces and @', () => {
  assert.deepEqual([...lib.parseAllowlist('@Grok, kaibgr\n  bad handle!! x_y')].sort(), ['bad', 'grok', 'kaibgr', 'x_y']);
  assert.equal(lib.parseAllowlist(undefined).size, 0);
});

test('pageOwner reads the first path segment', () => {
  assert.equal(lib.pageOwner('/KaiBGR/with_replies'), 'kaibgr');
  assert.equal(lib.pageOwner('/kaibgr/status/123'), 'kaibgr');
  assert.equal(lib.pageOwner('/'), null);
  assert.equal(lib.pageOwner('/i/lists/1'), 'i');
});

test('shouldHide needs a listed, non-allowlisted author off their own page', () => {
  const list = new Set(['kaibgr', 'grok']);
  const base = { list, allow: new Set(), owner: null, paused: false };
  assert.equal(lib.shouldHide('kaibgr', base), true);
  assert.equal(lib.shouldHide('someone', base), false);
  assert.equal(lib.shouldHide(null, base), false);
  assert.equal(lib.shouldHide('kaibgr', { ...base, paused: true }), false);
  assert.equal(lib.shouldHide('grok', { ...base, allow: new Set(['grok']) }), false);
  assert.equal(lib.shouldHide('kaibgr', { ...base, owner: 'kaibgr' }), false);
  assert.equal(lib.shouldHide('grok', { ...base, owner: 'kaibgr' }), true);
});
