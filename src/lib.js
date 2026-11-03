// Shared, side-effect-free logic for x-slop-hide.
//
// Loaded three ways, so it must not depend on any one environment:
//   - content script: listed before content.js in manifest.json (shares the isolated world)
//   - background service worker: importScripts('lib.js')
//   - node tests: require() via module.exports
(function (root) {
  'use strict';

  // X handles: 1-15 of [A-Za-z0-9_], matched case-insensitively. Stored lowercased.
  const HANDLE_RE = /^[a-z0-9_]{1,15}$/;
  const PROFILE_HREF_RE = /^\/([A-Za-z0-9_]{1,15})$/;

  const DEFAULTS = Object.freeze({
    feedUrl: 'https://clankwall.vogel.dev/api/usernames.txt',
    refreshMinutes: 360,
    // After a failed attempt, wait this long before trying again.
    retryMinutes: 30,
    // How often an open userscript tab checks whether the list is due.
    checkMinutes: 15,
    timeoutMs: 20000,
    maxBytes: 1000000,
    maxHandles: 50000,
    // Refuse an update that drops below this fraction of the stored list:
    // a broken or truncated fetch must never silently switch hiding off.
    minShrinkRatio: 0.5,
    // The shrink guard only applies once the stored list is big enough for a
    // ratio to mean something.
    shrinkGuardFloor: 20,
  });

  const STORAGE_KEYS = Object.freeze({
    list: 'xsh:list',
    settings: 'xsh:settings',
  });

  function normalizeHandle(raw) {
    if (raw == null) return null;
    let s = String(raw).trim();
    if (s.startsWith('@')) s = s.slice(1);
    s = s.toLowerCase();
    return HANDLE_RE.test(s) ? s : null;
  }

  // One handle per line. Blank lines and lines starting with '#' or '!' are
  // comments. Anything else that is not a valid handle counts as rejected.
  function parseList(text, opts) {
    const maxHandles = (opts && opts.maxHandles) || DEFAULTS.maxHandles;
    const seen = new Set();
    let rejected = 0;
    for (const line of String(text).split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#') || t.startsWith('!')) continue;
      const h = normalizeHandle(t);
      if (h) seen.add(h);
      else rejected++;
      if (seen.size > maxHandles) {
        return { handles: [], rejected, error: 'too many handles' };
      }
    }
    return { handles: [...seen].sort(), rejected, error: null };
  }

  function acceptUpdate(prevHandles, nextHandles, opts) {
    const ratio = (opts && opts.minShrinkRatio) || DEFAULTS.minShrinkRatio;
    const floor = (opts && opts.shrinkGuardFloor) || DEFAULTS.shrinkGuardFloor;
    if (!nextHandles || nextHandles.length === 0) return { ok: false, reason: 'empty list' };
    const prevCount = prevHandles ? prevHandles.length : 0;
    if (prevCount >= floor && nextHandles.length < prevCount * ratio) {
      return { ok: false, reason: `list shrank from ${prevCount} to ${nextHandles.length}` };
    }
    return { ok: true, reason: null };
  }

  function isDue(fetchedAt, now, refreshMinutes) {
    const minutes = refreshMinutes || DEFAULTS.refreshMinutes;
    if (!fetchedAt) return true;
    return now - fetchedAt >= minutes * 60 * 1000;
  }

  // Fetch and validate a feed. fetchImpl is the platform fetch (or a GM
  // wrapper). Never throws: returns { ok, handles, rejected } or { ok:false, reason }.
  async function fetchList(args) {
    const url = args.url || DEFAULTS.feedUrl;
    const fetchImpl = args.fetchImpl;
    const maxBytes = args.maxBytes || DEFAULTS.maxBytes;
    let res;
    try {
      const init = { cache: 'no-store', credentials: 'omit' };
      if (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) {
        init.signal = AbortSignal.timeout(args.timeoutMs || DEFAULTS.timeoutMs);
      }
      res = await fetchImpl(url, init);
    } catch (e) {
      return { ok: false, reason: `network error: ${(e && e.message) || e}` };
    }
    if (!res || !res.ok) return { ok: false, reason: `HTTP ${res ? res.status : '?'}` };
    const ctype = (res.headers && res.headers.get && res.headers.get('content-type')) || '';
    if (/html/i.test(ctype)) return { ok: false, reason: `unexpected content-type ${ctype}` };
    let text;
    try {
      text = await res.text();
    } catch (e) {
      return { ok: false, reason: `read error: ${(e && e.message) || e}` };
    }
    if (text.length > maxBytes) return { ok: false, reason: `feed larger than ${maxBytes} bytes` };
    const parsed = parseList(text, { maxHandles: args.maxHandles });
    if (parsed.error) return { ok: false, reason: parsed.error };
    if (parsed.rejected > parsed.handles.length) {
      return { ok: false, reason: `feed is mostly not handles (${parsed.rejected} invalid lines)` };
    }
    const verdict = acceptUpdate(args.prevHandles, parsed.handles, args);
    if (!verdict.ok) return { ok: false, reason: verdict.reason };
    return { ok: true, handles: parsed.handles, rejected: parsed.rejected };
  }

  // Merge a fetch result into the stored record. A failed fetch keeps the
  // previous handles and fetchedAt and records why it failed.
  function nextRecord(prev, result, url, now) {
    const base = prev || { handles: [], fetchedAt: 0, source: url };
    if (result.ok) {
      return { handles: result.handles, fetchedAt: now, source: url, lastAttemptAt: now, lastError: null };
    }
    return Object.assign({}, base, { lastAttemptAt: now, lastError: result.reason });
  }

  // Commit a refresh against the record stored right now, not the one read
  // before the fetch. `seq` counts successful commits; startSeq is the value
  // read when the refresh began. If a newer refresh succeeded meanwhile, this
  // result is stale and is dropped (null: write nothing), so an older failed
  // or older successful fetch can never overwrite a newer list.
  function commitRecord(latest, result, url, startSeq, now) {
    const seq = (latest && latest.seq) || 0;
    if (seq > (startSeq || 0)) return null;
    const rec = nextRecord(latest, result, url, now);
    rec.seq = result.ok ? seq + 1 : seq;
    return rec;
  }

  // Due for a refresh: the list is older than the refresh interval, and the
  // last attempt (a failure, if the list is old) is older than the retry gap.
  function isRefreshDue(rec, now) {
    if (!isDue(rec && rec.fetchedAt, now, DEFAULTS.refreshMinutes)) return false;
    const last = rec && rec.lastAttemptAt;
    return !last || now - last >= DEFAULTS.retryMinutes * 60 * 1000;
  }

  function parseAllowlist(text) {
    const out = new Set();
    for (const tok of String(text || '').split(/[\s,]+/)) {
      const h = normalizeHandle(tok);
      if (h) out.add(h);
    }
    return out;
  }

  // True when el sits inside a [role="link"] container below article, which is
  // how X renders a quoted post. Bounded at article so an ancestor outside the
  // post can never change the answer.
  function insideQuoteCard(el, article) {
    for (let n = el.parentElement; n && n !== article; n = n.parentElement) {
      if (n.getAttribute && n.getAttribute('role') === 'link') return true;
    }
    return false;
  }

  // The handle of the account that wrote this post, lowercased, or null.
  // It reads the first User-Name block that is not inside a quote card, so
  // quoted posts and @-mentions never count as the author.
  function authorHandleOf(article) {
    if (!article || !article.querySelectorAll) return null;
    for (const un of article.querySelectorAll('[data-testid="User-Name"]')) {
      if (insideQuoteCard(un, article)) continue;
      for (const a of un.querySelectorAll('a[href]')) {
        const m = PROFILE_HREF_RE.exec(a.getAttribute('href') || '');
        if (m) return m[1].toLowerCase();
      }
      return null;
    }
    return null;
  }

  // The handle whose profile or permalink this page is (/<handle>, /<handle>/status/…).
  function pageOwner(pathname) {
    const first = String(pathname || '').split('/')[1] || '';
    const h = first.toLowerCase();
    return HANDLE_RE.test(h) ? h : null;
  }

  function shouldHide(author, ctx) {
    if (!author || ctx.paused) return false;
    if (!ctx.list.has(author)) return false;
    if (ctx.allow && ctx.allow.has(author)) return false;
    // A listed account's own profile or post page was opened on purpose.
    if (ctx.owner && ctx.owner === author) return false;
    return true;
  }

  const api = {
    HANDLE_RE,
    DEFAULTS,
    STORAGE_KEYS,
    normalizeHandle,
    parseList,
    acceptUpdate,
    isDue,
    fetchList,
    nextRecord,
    commitRecord,
    isRefreshDue,
    parseAllowlist,
    insideQuoteCard,
    authorHandleOf,
    pageOwner,
    shouldHide,
  };
  root.XSlopHide = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
