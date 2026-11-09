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
    // Muting (off unless the user turns it on). Per UTC day: at most this many
    // mutes, and this many profile visits (an already-muted account costs a
    // visit, not a mute). These are the default; muteCaps lists every daily
    // cap the user may pick, and visits are always capped at twice the mutes.
    muteDailyCap: 25,
    muteVisitCap: 50,
    // The only daily caps muteCap() returns. 100 is the ceiling: a stored
    // value outside this list reads as muteDailyCap.
    muteCaps: Object.freeze([25, 50, 100]),
    // Minutes between visits, picked at random in this range. The alarm that
    // drives muting fires once a minute (the floor at Chrome 116).
    muteGapMinutes: [1, 3],
    // A mute tab still open after this long is closed and counted as a failure.
    muteTabTimeoutMs: 90000,
    // Mutes made since the last check of settings/muted/all. A background tab
    // renders only its first 9 rows (seen 2026-11-06), so check well before that.
    muteCheckEvery: 5,
    // Attempts at one account that end in a timeout or error before it is left alone.
    muteMaxAttempts: 2,
    // Accounts seen while browsing, muted ahead of the rest of the list.
    muteFrontMax: 50,
    // Labels (extension only, off unless the user turns them on): at most
    // this many saved, each keeping at most this many characters of reply text.
    labelMax: 2000,
    labelTextMax: 1000,
  });

  const STORAGE_KEYS = Object.freeze({
    list: 'xsh:list',
    settings: 'xsh:settings',
    mutes: 'xsh:mutes',
    // How many labels are saved; each label is its own key, LABEL_PREFIX + post id.
    labelCount: 'xsh:labelCount',
  });

  const LABEL_PREFIX = 'xsh:label:';
  const LABELS = Object.freeze(['slop', 'not_slop']);

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

  // ------------------------------------------------------------------ bots
  //
  // Accounts that answer when a post tags them. People who tag one in a
  // thread may want its answer, so each has its own row in the popup: Show,
  // Hide here, or Mute on X. A bot with no choice saved follows the list:
  // hidden when the list (or the user's extra accounts) has it, shown when
  // not, and never muted. clankwall listed only @grok on 2026-11-06.
  const GROK = 'grok';
  const BOTS = Object.freeze(
    [
      { handle: 'grok', name: 'grok', note: "X's assistant" },
      { handle: 'askperplexity', name: 'AskPerplexity', note: "Perplexity's answer bot" },
      { handle: 'pangram', name: 'pangram', note: 'AI-text detector' },
      { handle: 'bot', name: 'bot', note: "xAI's Grok Bot" },
      { handle: 'threadreaderapp', name: 'threadreaderapp', note: 'thread unroller' },
      { handle: 'unrollhelper', name: 'UnrollHelper', note: 'thread unroller' },
    ].map((b) => Object.freeze(b)),
  );
  const BOT_HANDLES = new Set(BOTS.map((b) => b.handle));
  const BOT_MODES = Object.freeze(['show', 'hide', 'mute']);

  // The choice saved for one bot, or null. 0.3.0's showGrok switch counts as
  // choosing Show for @grok until its row is changed. Read only: nothing
  // here rewrites stored settings.
  function botChoice(settings, handle) {
    const s = settings || {};
    const saved = s.bots && typeof s.bots === 'object' ? s.bots[handle] : undefined;
    if (BOT_MODES.includes(saved)) return saved;
    if (handle === GROK && s.showGrok === true) return 'show';
    return null;
  }

  // Each bot's mode as it applies now, keyed by handle: the saved choice,
  // else what the list says. An Always-show entry wins over both.
  function botModes(settings, listHandles) {
    const s = settings || {};
    const listed = new Set(listHandles || []);
    for (const h of parseAllowlist(s.extraList)) listed.add(h);
    const allow = parseAllowlist(s.allowlist);
    const out = {};
    for (const { handle } of BOTS) {
      out[handle] = allow.has(handle) ? 'show' : botChoice(s, handle) || (listed.has(handle) ? 'hide' : 'show');
    }
    return out;
  }

  // Handles that are never hidden: the user's allowlist, plus each bot whose
  // row is set to Show. A bot row adds only that bot, never a wider allow.
  function effectiveAllow(settings) {
    const out = parseAllowlist(settings && settings.allowlist);
    for (const { handle } of BOTS) if (botChoice(settings, handle) === 'show') out.add(handle);
    return out;
  }

  // Handles whose posts are hidden: the list, the user's extra accounts,
  // and each bot whose row is set to Hide or Mute. effectiveAllow still wins.
  function effectiveList(listHandles, settings) {
    const out = new Set(listHandles || []);
    for (const h of parseAllowlist(settings && settings.extraList)) out.add(h);
    for (const { handle } of BOTS) {
      const c = botChoice(settings, handle);
      if (c === 'hide' || c === 'mute') out.add(handle);
    }
    return out;
  }

  // Bots whose tags hide a post: those hidden or muted now, when the user
  // has turned on hiding posts that tag them. Empty otherwise.
  function mentionTargets(settings, listHandles) {
    const out = new Set();
    if (!(settings && settings.hideBotMentions === true)) return out;
    const modes = botModes(settings, listHandles);
    for (const h of Object.keys(modes)) if (modes[h] !== 'show') out.add(h);
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

  // The first bot in `targets` that this post tags in its own text, or null.
  // A tag is an @-link in the post's own tweetText; text inside a quoted post
  // and the "Replying to" line (which X draws outside tweetText) do not count.
  function mentionIn(article, targets) {
    if (!article || !article.querySelectorAll || !targets || targets.size === 0) return null;
    for (const t of article.querySelectorAll('[data-testid="tweetText"]')) {
      if (insideQuoteCard(t, article)) continue;
      for (const a of t.querySelectorAll('a[href]')) {
        const m = PROFILE_HREF_RE.exec(a.getAttribute('href') || '');
        if (m && targets.has(m[1].toLowerCase())) return m[1].toLowerCase();
      }
    }
    return null;
  }

  // Whether a post by `author` that tags the bot `mentioned` is hidden. Never
  // the user's own posts, an Always-show author's, or anything on the page of
  // the author or of a tagged bot, since that page was opened on purpose.
  function shouldHideMention(author, mentioned, ctx) {
    if (!mentioned || !author || ctx.paused) return false;
    if (ctx.allow && ctx.allow.has(author)) return false;
    if (ctx.me && ctx.me === author) return false;
    if (ctx.owner && (ctx.owner === author || (ctx.mentions && ctx.mentions.has(ctx.owner)))) return false;
    return true;
  }

  // ---------------------------------------------------------------- muting

  function utcDay(ms) {
    return new Date(ms).toISOString().slice(0, 10);
  }

  const norm = (s) => String(s || '').replace(/\s+/g, ' ').trim().toLowerCase();

  // Which item of a post's ⋯ menu to click, from the item labels X showed
  // (2026-11-06): "mute" on a listed account's post, "unmute" once muted,
  // "unfollow @h" when the user follows it, and a separate "mute this
  // conversation" that must never match. Returns
  //   { action: 'click', index }                 the one exact Mute item
  //   { action: 'done', status: 'already' }      already muted: nothing to click
  //   { action: 'refuse', status, reason, stopDay }
  function chooseMuteItem(items, handle) {
    const labels = (items || []).map(norm);
    const h = String(handle || '').toLowerCase();
    if (labels.some((l) => l === 'unmute' || l === `unmute @${h}`)) return { action: 'done', status: 'already' };
    if (labels.some((l) => l === `unfollow @${h}`)) {
      return { action: 'refuse', status: 'followed', reason: `you follow @${h}`, stopDay: false };
    }
    const hits = labels.map((l, i) => (l === 'mute' || l === `mute @${h}` ? i : -1)).filter((i) => i >= 0);
    if (hits.length !== 1) {
      return {
        action: 'refuse',
        status: 'refused',
        reason: `${hits.length} exact Mute items in the menu [${labels.join(' | ')}]`,
        stopDay: true,
      };
    }
    return { action: 'click', index: hits[0] };
  }

  // A fresh record of what muting has done: per account and per UTC day.
  function emptyMutes() {
    return { handles: {}, days: {}, front: [], nextAt: 0, sinceCheck: [] };
  }

  // The record is keyed by handle, and '__proto__' and 'constructor' pass
  // HANDLE_RE, so entries are read and written as own properties only.
  function entryOf(r, h) {
    return r.handles && Object.prototype.hasOwnProperty.call(r.handles, h) ? r.handles[h] : undefined;
  }

  function setEntry(r, h, e) {
    Object.defineProperty(r.handles, h, { value: e, enumerable: true, writable: true, configurable: true });
  }

  // Statuses that end work on an account. 'error' does not, until it has
  // happened muteMaxAttempts times, and neither does a first 'no-post': on
  // 2026-11-06, 3 of 4 profiles showed their first post before its ⋯ button.
  const SETTLED = new Set(['muted', 'already', 'followed', 'no-post', 'failed']);

  function isSettled(st) {
    if (!st || !SETTLED.has(st.status)) return false;
    if (st.status === 'no-post') return (st.attempts || 1) >= DEFAULTS.muteMaxAttempts;
    return true;
  }

  // Accounts muting may visit, in order: the list, then the user's extra
  // accounts, then bots whose row is set to Mute on X. Never an Always-show
  // account, and never a bot whose row says anything else: muting one
  // account-wide is a much bigger step than hiding its replies, so a bot is
  // muted only when the user picked that for it.
  function muteEligible(listHandles, settings) {
    const allow = parseAllowlist(settings && settings.allowlist);
    const extra = [...parseAllowlist(settings && settings.extraList)].sort();
    const bots = BOTS.map((b) => b.handle).filter((h) => botChoice(settings, h) === 'mute');
    const out = [];
    const seen = new Set();
    for (const h of [...(listHandles || []), ...extra, ...bots]) {
      if (seen.has(h)) continue;
      seen.add(h);
      if (allow.has(h)) continue;
      if (BOT_HANDLES.has(h) && botChoice(settings, h) !== 'mute') continue;
      out.push(h);
    }
    return out;
  }

  // Accounts to visit, in order: those seen while browsing first, then the
  // rest of muteEligible, then accounts being tried again. Never an account
  // already settled.
  function muteCandidates(listHandles, settings, rec) {
    const r = rec || emptyMutes();
    const eligible = muteEligible(listHandles, settings);
    const ok = new Set(eligible);
    const fresh = [];
    const retry = [];
    const seen = new Set();
    for (const h of [...(r.front || []), ...eligible]) {
      if (seen.has(h)) continue;
      seen.add(h);
      if (!ok.has(h)) continue;
      const st = entryOf(r, h);
      if (isSettled(st)) continue;
      (st ? retry : fresh).push(h);
    }
    return [...fresh, ...retry];
  }

  function dayOf(rec, today) {
    return (rec.days && rec.days[today]) || { mutes: 0, visits: 0, stopped: null };
  }

  // The daily mute cap the user picked: 25, 50 or 100. Anything else,
  // including a missing setting, reads as 25, so no stored value can raise
  // the cap past 100.
  function muteCap(settings) {
    const v = settings && settings.muteCap;
    return DEFAULTS.muteCaps.includes(v) ? v : DEFAULTS.muteDailyCap;
  }

  // A cap above the default mutes only while the user has an x.com tab of
  // their own open.
  function capNeedsXOpen(cap) {
    return cap > DEFAULTS.muteDailyCap;
  }

  // What today's caps leave at the given daily cap (the default when cap is
  // not one of muteCaps). Visits are capped at twice the mutes. `stopped` is
  // set when muting stopped itself for the day (an unexpected menu, a wrong
  // account, a mute not on the list).
  function muteBudget(rec, today, cap) {
    const c = DEFAULTS.muteCaps.includes(cap) ? cap : DEFAULTS.muteDailyCap;
    const d = dayOf(rec || emptyMutes(), today);
    return {
      mutesLeft: Math.max(0, c - d.mutes),
      visitsLeft: Math.max(0, 2 * c - d.visits),
      stopped: d.stopped || null,
      mutes: d.mutes,
      visits: d.visits,
      cap: c,
      visitCap: 2 * c,
    };
  }

  // Fold one visit's outcome into the record (a new object). The visit was
  // already counted when its tab opened. Outcomes:
  //   muted        clicked the Mute item (toast text kept; confirmed later)
  //   already      the menu offered Unmute
  //   followed     the user follows the account: left alone
  //   no-post      no post by the account with a ⋯ button on its profile:
  //                tried once more, then left alone
  //   refused      the menu was not one we act on: stops muting for the day
  //   wrong-account, login   the tab is not logged in as the bound account: stops the day
  //   error        timeout, closed tab, a menu that did not open: retried, up to muteMaxAttempts
  function recordOutcome(rec, handle, outcome, now) {
    const r = structuredCloneish(rec || emptyMutes());
    const today = utcDay(now);
    const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
    const prev = entryOf(r, handle) || {};
    const status = outcome.status;
    const entry = { status, at: now };
    if (outcome.reason) entry.reason = String(outcome.reason).slice(0, 200);
    if (status === 'muted') {
      d.mutes += 1;
      entry.toast = outcome.toast ? String(outcome.toast).slice(0, 120) : null;
      entry.confirmed = null;
      r.sinceCheck = [...(r.sinceCheck || []), handle];
    }
    if (status === 'error') {
      entry.attempts = (prev.attempts || 0) + 1;
      if (entry.attempts >= DEFAULTS.muteMaxAttempts) entry.status = 'failed';
    }
    if (status === 'no-post') entry.attempts = (prev.status === 'no-post' ? prev.attempts || 1 : 0) + 1;
    if (['refused', 'wrong-account', 'login'].includes(status)) {
      d.stopped = `@${handle}: ${status}${outcome.reason ? ` (${String(outcome.reason).slice(0, 160)})` : ''}`;
      // Not settled: the account is tried again on a later day.
      if (status !== 'refused') delete entry.status;
    }
    if (entry.status) setEntry(r, handle, entry);
    r.front = (r.front || []).filter((h) => h !== handle);
    r.days[today] = d;
    return r;
  }

  // Fold a read of settings/muted/all's top rows into the record. Every mute
  // since the last check should be there; one that is not stops muting for
  // the day, because something is not as it looked.
  function recordCheck(rec, rows, now) {
    const r = structuredCloneish(rec || emptyMutes());
    const seen = new Set((rows || []).map((h) => String(h).toLowerCase()));
    const missing = [];
    for (const h of r.sinceCheck || []) {
      const e = entryOf(r, h);
      if (!e || e.status !== 'muted') continue;
      e.confirmed = seen.has(h);
      e.checkedAt = now;
      if (!e.confirmed) missing.push(h);
    }
    r.sinceCheck = [];
    if (missing.length) {
      const today = utcDay(now);
      const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
      d.stopped = `not on settings/muted/all after muting: @${missing.join(', @')}`;
      r.days[today] = d;
    }
    return { rec: r, missing };
  }

  // A profile tab was opened: it counts against today's visit cap whatever it finds.
  function countVisit(rec, now) {
    const r = structuredCloneish(rec || emptyMutes());
    const today = utcDay(now);
    const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
    d.visits += 1;
    r.days[today] = d;
    return r;
  }

  // Stop muting until the next UTC day, with the reason the popup shows.
  function stopDay(rec, now, reason) {
    const r = structuredCloneish(rec || emptyMutes());
    const today = utcDay(now);
    const d = Object.assign({ mutes: 0, visits: 0, stopped: null }, r.days[today]);
    d.stopped = String(reason).slice(0, 200);
    r.days[today] = d;
    return r;
  }

  // Put an account seen while browsing at the front of the queue.
  function noteSighting(rec, handle) {
    const r = structuredCloneish(rec || emptyMutes());
    const front = (r.front || []).filter((h) => h !== handle);
    front.unshift(handle);
    r.front = front.slice(0, DEFAULTS.muteFrontMax);
    return r;
  }

  function structuredCloneish(o) {
    return JSON.parse(JSON.stringify(o));
  }

  // Totals for the popup.
  function muteSummary(rec) {
    const r = rec || emptyMutes();
    const vals = Object.values(r.handles || {});
    return {
      muted: vals.filter((e) => e.status === 'muted').length,
      confirmed: vals.filter((e) => e.status === 'muted' && e.confirmed === true).length,
      notFound: vals.filter((e) => e.status === 'muted' && e.confirmed === false).length,
      already: vals.filter((e) => e.status === 'already').length,
      followed: vals.filter((e) => e.status === 'followed').length,
      skipped: vals.filter((e) => e.status === 'no-post' || e.status === 'failed').length,
    };
  }

  // ---------------------------------------------------------------- labels
  //
  // A label is the user's own call on one reply: slop or not slop. Each is
  // stored under its own key (LABEL_PREFIX + the post id) in the extension's
  // local storage and leaves the browser only in a file the user exports.

  const STATUS_PATH_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})(?:[/?#]|$)/;
  const X_ORIGIN_RE = /^https:\/\/(?:mobile\.)?(?:x|twitter)\.com(?=\/)/i;

  // The author handle and post id in a post's path or x.com URL
  // (/h/status/123, https://x.com/h/status/123/photo/1), or null.
  function statusOf(href) {
    const p = String(href || '').replace(X_ORIGIN_RE, '');
    const m = STATUS_PATH_RE.exec(p);
    return m ? { handle: m[1].toLowerCase(), id: m[2] } : null;
  }

  const STATUS_PAGE_RE = /^\/([A-Za-z0-9_]{1,15})\/status\/(\d{1,25})\/?$/;

  // The post a page is about, when the path is that post's own page
  // (/h/status/123), or null. Its quotes, likes and photo pages
  // (/h/status/123/quotes) are not the post's page.
  function statusPageOf(pathname) {
    const m = STATUS_PAGE_RE.exec(String(pathname || ''));
    return m ? { handle: m[1].toLowerCase(), id: m[2] } : null;
  }

  const statusUrl = (s) => `https://x.com/${s.handle}/status/${s.id}`;

  // Check and trim a label message from a content script. Returns
  // { ok: false, reason } when anything in it is not what a label looks like,
  // { ok: true, id, handle, label: null } for clearing one, else
  // { ok: true, id, handle, label, record } with the record to store. ctx is
  // what is stored now ({ handles, source } of the list, and settings); the
  // record says what the list and the two boxes held before this label.
  function labelRecord(msg, ctx, now) {
    const m = msg || {};
    const label = m.label === null ? null : LABELS.includes(m.label) ? m.label : undefined;
    if (label === undefined) return { ok: false, reason: 'unknown label' };
    const post = statusOf(m.url);
    if (!post) return { ok: false, reason: 'not a post URL' };
    const handle = normalizeHandle(m.handle);
    if (!handle) return { ok: false, reason: 'not a handle' };
    // The account that goes into a box must be the one the post's link names.
    if (handle !== post.handle) return { ok: false, reason: "not the post's author" };
    if (label === null) return { ok: true, id: post.id, handle, label: null };
    const c = ctx || {};
    const s = c.settings || {};
    const page = statusPageOf(m.page);
    let host = 'list';
    try {
      host = new URL(c.source || DEFAULTS.feedUrl).host || host;
    } catch (e) {
      // keep 'list'
    }
    const text = typeof m.text === 'string' ? Array.from(m.text).slice(0, DEFAULTS.labelTextMax).join('') : '';
    const record = {
      at: now,
      label,
      handle,
      url: statusUrl(post),
      text,
      page: page ? statusUrl(page) : null,
      list: new Set(c.handles || []).has(handle) ? host : null,
      extra: parseAllowlist(s.extraList).has(handle),
      allow: parseAllowlist(s.allowlist).has(handle),
      // Whether x-slop-hide hides this account's replies on that page, with
      // hiding not paused. Posts hidden for tagging a bot are not counted.
      hidden: shouldHide(handle, {
        list: effectiveList(c.handles, s),
        allow: effectiveAllow(s),
        owner: page ? page.handle : null,
        paused: false,
      }),
    };
    return { ok: true, id: post.id, handle, label, record };
  }

  // The settings change a label makes, or null for none: slop adds the
  // account to Also hide, not_slop adds it to Always show. Neither takes an
  // account out of a box, and clearing a label changes nothing.
  function labelPatch(settings, handle, label) {
    const field = label === 'slop' ? 'extraList' : label === 'not_slop' ? 'allowlist' : null;
    const h = normalizeHandle(handle);
    if (!field || !h) return null;
    const text = String((settings && settings[field]) || '');
    if (parseAllowlist(text).has(h)) return null;
    const kept = text.replace(/\s+$/, '');
    return { [field]: kept ? `${kept}\n${h}` : h };
  }

  // The label records in a storage snapshot (chrome.storage.local.get(null)),
  // oldest first.
  function labelsFrom(all) {
    const o = all || {};
    return Object.keys(o)
      .filter((k) => k.startsWith(LABEL_PREFIX))
      .map((k) => o[k])
      .filter((r) => r && typeof r === 'object' && LABELS.includes(r.label))
      .sort((a, b) => (a.at || 0) - (b.at || 0));
  }

  // One JSON object per line, ending in a newline when there is any.
  function labelsJsonl(records) {
    const rows = (records || []).map((r) => JSON.stringify(r));
    return rows.length ? `${rows.join('\n')}\n` : '';
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
    GROK,
    BOTS,
    BOT_MODES,
    botChoice,
    botModes,
    effectiveAllow,
    effectiveList,
    mentionTargets,
    insideQuoteCard,
    authorHandleOf,
    pageOwner,
    shouldHide,
    mentionIn,
    shouldHideMention,
    utcDay,
    chooseMuteItem,
    emptyMutes,
    muteEligible,
    muteCandidates,
    muteCap,
    capNeedsXOpen,
    muteBudget,
    recordOutcome,
    recordCheck,
    countVisit,
    stopDay,
    noteSighting,
    muteSummary,
    LABEL_PREFIX,
    LABELS,
    statusOf,
    statusPageOf,
    labelRecord,
    labelPatch,
    labelsFrom,
    labelsJsonl,
  };
  root.XSlopHide = api;
  if (typeof module === 'object' && module && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
