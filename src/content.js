// AI Anti-Slop content script: hides x.com timeline cells whose post author is
// on the list. In the user's own tabs it never clicks anything.
//
// Muting, when the user has turned it on, happens only in a tab the background
// worker opened for one job (see runJob below): there it clicks a post's ⋯ and
// X's own Mute item, then reports back, and the worker closes the tab. It never
// calls X's API.
//
// Labels, when the user has turned them on (extension only): on a post's
// own page, each post below it gets a small Slop / Not slop pair. A click
// there is the only thing this script acts on in the user's own tabs, and
// only a click the browser marks as the user's own.
//
// State comes from an adapter: the extension adapter below (chrome.storage,
// filled by background.js), or globalThis.XSlopHideAdapter when the userscript
// build supplies one. The userscript adapter has no jobs and no labels, so it
// only hides.
(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  if (!L) return;

  const ATTR = 'data-xsh-hidden';
  const ARTICLE = 'article[data-testid="tweet"]';
  const CELL = '[data-testid="cellInnerDiv"]';

  let list = new Set();
  let allow = new Set();
  let mentions = new Set(); // bots whose tags hide a post
  let paused = false;
  let muting = false;
  let lastPath = location.pathname;
  let meUnknown = false; // a tagged post was left visible before whoAmI() answered
  const hiddenPosts = new Set(); // distinct posts hidden in this tab
  const hiddenAuthors = new Set();
  const hiddenMentions = new Set(); // distinct posts hidden for tagging a bot

  // Labels (see the header). BAR marks the pair, its value the post id.
  const BAR = 'data-xsh-bar';
  let labeling = false;
  let listed = new Set(); // the list itself, for the note beside the pair
  let allowBox = new Set(); // Always show, as typed
  let extraBox = new Set(); // Also hide, as typed
  const labels = new Map(); // post id -> 'slop' | 'not_slop' | null, once read
  const asked = new Set(); // post ids whose label was read or is being read
  const toRead = new Set();
  const notes = new Map(); // post id -> why the last click was not saved
  // Ids of the posts above the one the page is about (the posts it replies
  // to), for the page at ancestorsPath. Kept by id, since X reuses a post's
  // nodes, and for as long as the page is open, since X unmounts posts
  // scrolled far away: deep in the replies the page's post may be gone.
  let ancestors = new Set();
  let ancestorsPath = null;

  function injectStyle() {
    if (document.getElementById('xsh-style')) return;
    const st = document.createElement('style');
    st.id = 'xsh-style';
    st.textContent = `[${ATTR}]{display:none!important}`;
    (document.head || document.documentElement).appendChild(st);
  }

  // The label bar's look, added only once labelling is turned on, so a page
  // with labelling off gets nothing beyond the hide rule.
  function injectBarStyle() {
    if (document.getElementById('xsh-bar-style')) return;
    const st = document.createElement('style');
    st.id = 'xsh-bar-style';
    st.textContent =
      `[${BAR}]{display:flex;flex-wrap:wrap;gap:6px;align-items:center;margin:2px 0 8px 56px;font:13px/1.3 system-ui,sans-serif;color:rgb(113,118,123)}` +
      `[${BAR}] button{font:inherit;color:inherit;background:transparent;border:1px solid rgba(113,118,123,.6);border-radius:999px;padding:2px 10px;cursor:pointer}` +
      `[${BAR}] button[aria-pressed="true"][data-xsh-label="slop"]{color:#fff;background:rgb(244,33,46);border-color:rgb(244,33,46)}` +
      `[${BAR}] button[aria-pressed="true"][data-xsh-label="not_slop"]{color:#fff;background:rgb(0,150,100);border-color:rgb(0,150,100)}`;
    (document.head || document.documentElement).appendChild(st);
  }

  function postKey(article) {
    const t = article.querySelector('a[href*="/status/"] time');
    const a = t && t.closest('a');
    return (a && a.getAttribute('href')) || null;
  }

  function evaluate(article, owner) {
    const author = L.authorHandleOf(article);
    const cell = article.closest(CELL) || article;
    const hide = L.shouldHide(author, { list, allow, owner, paused });
    if (hide) {
      if (cell.getAttribute(ATTR) !== author) cell.setAttribute(ATTR, author);
      // Seen while browsing: muted ahead of the rest of the list.
      if (muting && !hiddenAuthors.has(author) && adapter.noteSighting) adapter.noteSighting(author);
      hiddenAuthors.add(author);
      const k = postKey(article);
      if (k) hiddenPosts.add(k);
      return;
    }
    // A post that tags a hidden bot. Not a sighting: its author is not listed.
    const tagged = mentions.size ? L.mentionIn(article, mentions) : null;
    // Until the sidebar shows who is logged in, the user's own posts cannot be
    // told apart, so a tagged post stays visible; onMutations looks again then.
    const who = tagged ? whoAmI() : null;
    if (tagged && !who) meUnknown = true;
    if (who && L.shouldHideMention(author, tagged, { allow, owner, paused, me: who.me, mentions })) {
      const v = `mention:${tagged}`;
      if (cell.getAttribute(ATTR) !== v) cell.setAttribute(ATTR, v);
      const k = postKey(article);
      if (k) hiddenMentions.add(k);
    } else if (cell.hasAttribute(ATTR)) {
      cell.removeAttribute(ATTR);
    }
  }

  // ---------------------------------------------------------------- labels

  function ancestorIds() {
    if (ancestorsPath !== location.pathname) {
      ancestorsPath = location.pathname;
      ancestors = new Set();
    }
    return ancestors;
  }

  // While the page's post is mounted, remember every post above it in the
  // document. Returns true when that adds one, which may already have a pair.
  // A post above it that is first mounted after the page's post has been
  // unmounted (a long chain scrolled far up) is not caught.
  function noteAncestors(focal) {
    const known = ancestorIds();
    const above = [];
    for (const art of document.querySelectorAll(ARTICLE)) {
      const url = postKey(art);
      const post = url && L.statusOf(url);
      if (!post) continue;
      if (post.id === focal.id) {
        let grew = false;
        for (const id of above) {
          if (!known.has(id)) {
            known.add(id);
            grew = true;
          }
        }
        return grew;
      }
      above.push(post.id);
    }
    return false;
  }

  // The post a pair would label, or null: on a post's own page (not its
  // quotes, likes or a photo), a post below the page's post with its own link
  // and author. The page's post and the posts above it get none.
  function labelTarget(article) {
    const focal = L.statusPageOf(location.pathname);
    if (!focal) return null;
    const url = postKey(article);
    const post = url && L.statusOf(url);
    if (!post || post.id === focal.id || ancestorIds().has(post.id)) return null;
    const author = L.authorHandleOf(article);
    return author ? { id: post.id, url, author } : null;
  }

  // The post's own text (not a quoted post's), with emoji, which X draws as
  // images, read from their alt text.
  function postText(article) {
    const el = [...article.querySelectorAll('[data-testid="tweetText"]')].find((t) => !L.insideQuoteCard(t, article));
    if (!el) return '';
    const parts = [];
    const walk = (n) => {
      for (const c of n.childNodes) {
        if (c.nodeType === 3) parts.push(c.data);
        else if (c.nodeType === 1 && c.tagName === 'IMG') parts.push(c.getAttribute('alt') || '');
        else if (c.nodeType === 1) walk(c);
      }
    };
    walk(el);
    return parts.join('').trim();
  }

  function barOf(article) {
    for (const c of article.children) if (c.hasAttribute(BAR)) return c;
    return null;
  }

  function makeBar() {
    const bar = document.createElement('div');
    bar.setAttribute(BAR, '');
    bar.setAttribute('role', 'group');
    bar.setAttribute('aria-label', 'AI Anti-Slop label');
    for (const [label, text] of [
      ['slop', 'Slop'],
      ['not_slop', 'Not slop'],
    ]) {
      const b = document.createElement('button');
      b.setAttribute('type', 'button');
      b.setAttribute('data-xsh-label', label);
      b.setAttribute('aria-pressed', 'false');
      b.textContent = text;
      bar.appendChild(b);
    }
    const note = document.createElement('span');
    note.setAttribute('data-xsh-note', '');
    bar.appendChild(note);
    // X opens a post on a click anywhere in it, and has keyboard shortcuts:
    // nothing done in the pair reaches its handlers.
    for (const type of ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup']) {
      bar.addEventListener(type, (e) => onBarEvent(e, bar));
    }
    return bar;
  }

  // Why an account shows despite a Slop label, or what already covers it.
  function boxNote(author) {
    if (allowBox.has(author)) return 'in Always show';
    if (extraBox.has(author)) return 'in Also hide';
    if (listed.has(author)) return 'on the list';
    return '';
  }

  // Bring a pair up to date. Writes only what differs, so its own mutations
  // settle on the next pass.
  function renderBar(bar, id, author) {
    const cur = labels.get(id) || null;
    for (const b of bar.querySelectorAll('[data-xsh-label]')) {
      const v = String(b.getAttribute('data-xsh-label') === cur);
      if (b.getAttribute('aria-pressed') !== v) b.setAttribute('aria-pressed', v);
    }
    const note = bar.querySelector('[data-xsh-note]');
    const text = notes.get(id) || boxNote(author);
    if (note && note.textContent !== text) note.textContent = text;
  }

  // Add, update or remove the pair on one post. X reuses a post's nodes for
  // another post, so the pair is re-keyed whenever the post's link changes.
  function syncBar(article) {
    if (!labeling) return;
    const t = labelTarget(article);
    let bar = barOf(article);
    if (!t) {
      if (bar) bar.remove();
      return;
    }
    if (!bar) {
      bar = makeBar();
      article.appendChild(bar);
    }
    if (bar.getAttribute(BAR) !== t.id) bar.setAttribute(BAR, t.id);
    if (bar.getAttribute('data-xsh-author') !== t.author) bar.setAttribute('data-xsh-author', t.author);
    renderBar(bar, t.id, t.author);
    if (!asked.has(t.id)) readLabel(t.id);
  }

  // Bring the pairs on these posts up to date, or on every post when a post
  // above the page's post has just been found: it may already have a pair.
  function syncBars(arts) {
    if (!labeling) return;
    const focal = L.statusPageOf(location.pathname);
    const grew = focal ? noteAncestors(focal) : false;
    for (const art of grew ? document.querySelectorAll(ARTICLE) : arts) syncBar(art);
  }

  function renderId(id) {
    for (const bar of document.querySelectorAll(`[${BAR}]`)) {
      if (bar.getAttribute(BAR) === id) renderBar(bar, id, bar.getAttribute('data-xsh-author') || '');
    }
  }

  // Read stored labels for posts as their pairs appear, a batch at a time.
  function readLabel(id) {
    asked.add(id);
    toRead.add(id);
    if (toRead.size > 1) return;
    setTimeout(() => {
      const ids = [...toRead];
      toRead.clear();
      Promise.resolve(adapter.getLabels ? adapter.getLabels(ids) : {})
        .then((got) => {
          for (const id of ids) if (!labels.has(id)) labels.set(id, (got && got[id]) || null);
          for (const id of ids) renderId(id);
        })
        .catch(() => {});
    }, 0);
  }

  function onBarEvent(e, bar) {
    e.stopPropagation();
    if (e.type !== 'click') return;
    e.preventDefault();
    // A click made by the page's own script, not the user: ignored.
    if (e.isTrusted === false) return;
    const btn = e.target && e.target.closest ? e.target.closest('[data-xsh-label]') : null;
    const article = bar.closest(ARTICLE);
    if (btn && article) saveLabel(article, btn.getAttribute('data-xsh-label'));
  }

  // Clicking the label a post already has clears it.
  async function saveLabel(article, which) {
    const t = labelTarget(article);
    if (!t || !labeling) return;
    const label = labels.get(t.id) === which ? null : which;
    let res;
    try {
      res = await adapter.saveLabel({ label, handle: t.author, url: t.url, page: location.pathname, text: postText(article) });
    } catch (e) {
      res = { ok: false, reason: String((e && e.message) || e) };
    }
    if (res && res.ok) {
      notes.delete(t.id);
      labels.set(t.id, label);
    } else {
      notes.set(t.id, `not saved: ${(res && res.reason) || 'no answer'}`);
    }
    renderId(t.id);
  }

  function onLabelChange(id, label) {
    labels.set(id, label || null);
    asked.add(id);
    renderId(id);
  }

  function rescanAll() {
    const owner = L.pageOwner(location.pathname);
    const arts = document.querySelectorAll(ARTICLE);
    for (const art of arts) evaluate(art, owner);
    syncBars(arts);
    // Cells hidden earlier whose post has since been replaced or unlisted.
    for (const cell of document.querySelectorAll(`[${ATTR}]`)) {
      const art = cell.matches(ARTICLE) ? cell : cell.querySelector(ARTICLE);
      if (!art) cell.removeAttribute(ATTR);
    }
  }

  function onMutations(records) {
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      rescanAll();
      return;
    }
    // The sidebar's profile link arrived after some tagged posts: look at them again.
    if (meUnknown && whoAmI()) {
      meUnknown = false;
      rescanAll();
      return;
    }
    const owner = L.pageOwner(lastPath);
    const touched = new Set();
    const dirtyCells = new Set();
    for (const r of records) {
      if (r.type === 'attributes') {
        // An href rewritten in place, as when a recycled node gets a new post.
        const host = r.target && r.target.nodeType === 1 ? r.target.closest(ARTICLE) : null;
        if (host) touched.add(host);
        continue;
      }
      // Removed nodes no longer have a useful parent. Revisit their surviving
      // target article or hidden cell after the whole mutation batch settles.
      if (r.removedNodes && r.removedNodes.length && r.target && r.target.nodeType === 1) {
        const host = r.target.closest(ARTICLE);
        if (host) touched.add(host);
        const cell = r.target.closest(CELL);
        if (cell && cell.hasAttribute(ATTR)) dirtyCells.add(cell);
      }
      for (const n of r.addedNodes || []) {
        if (n.nodeType !== 1) continue;
        // n is a post, sits inside one (X fills the author block in late), or holds some.
        const host = n.closest(ARTICLE);
        if (host) touched.add(host);
        // One subtree walk finds posts and previously hidden, reinserted cells.
        if (n.hasAttribute(ATTR)) dirtyCells.add(n);
        for (const element of n.querySelectorAll(`${ARTICLE}, [${ATTR}]`)) {
          if (!host && element.matches(ARTICLE)) touched.add(element);
          if (element.hasAttribute(ATTR)) dirtyCells.add(element);
        }
      }
    }
    for (const cell of dirtyCells) {
      if (!document.contains(cell)) continue;
      const articles = cell.matches(ARTICLE) ? [cell] : cell.querySelectorAll(ARTICLE);
      if (!articles.length) cell.removeAttribute(ATTR);
      else for (const art of articles) touched.add(art);
    }
    // A node added then removed in the same batch must not affect live state or stats.
    const live = [];
    for (const art of touched) {
      if (!document.contains(art)) continue;
      evaluate(art, owner);
      live.push(art);
    }
    syncBars(live);
  }

  function applyState(s) {
    const handles = (s.list && s.list.handles) || [];
    const st = s.settings || {};
    list = L.effectiveList(handles, s.settings);
    allow = L.effectiveAllow(s.settings);
    mentions = L.mentionTargets(s.settings, handles);
    paused = !!st.paused;
    muting = !!st.muteEnabled;
    listed = new Set(handles);
    allowBox = L.parseAllowlist(st.allowlist);
    extraBox = L.parseAllowlist(st.extraList);
    labeling = !!(st.labeling === true && adapter.saveLabel);
    if (labeling) injectBarStyle();
    else for (const bar of document.querySelectorAll(`[${BAR}]`)) bar.remove();
    rescanAll();
  }

  // Who this tab is logged in as: { me } from the sidebar's profile link,
  // { login: true } when x.com shows a login button, null while still loading.
  function whoAmI() {
    if (document.querySelector('[data-testid="loginButton"]')) return { login: true };
    const a = document.querySelector('[data-testid="AppTabBar_Profile_Link"]');
    const m = a && /^\/([A-Za-z0-9_]{1,15})$/.exec(a.getAttribute('href') || '');
    return m ? { me: m[1].toLowerCase() } : null;
  }

  function stats() {
    const who = whoAmI();
    return {
      listed: list.size,
      paused,
      me: (who && who.me) || null,
      hiddenNow: document.querySelectorAll(`[${ATTR}]`).length,
      hiddenPosts: hiddenPosts.size,
      hiddenAuthors: [...hiddenAuthors].sort(),
      hiddenMentions: hiddenMentions.size,
    };
  }

  // ------------------------------------------------------------ mute jobs

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const textOf = (el) => (el.textContent || '').replace(/\s+/g, ' ').trim();

  async function waitFor(fn, ms, step) {
    const end = Date.now() + ms;
    for (;;) {
      const v = fn();
      if (v) return v;
      if (Date.now() >= end) return null;
      await sleep(step || 500);
    }
  }

  // How long to wait for the page to show who is logged in, a post, or rows.
  const waitMs = (job) => job.waitMs || 20000;

  // The job's tab must be logged in as the account muting was turned on for.
  async function wrongAccount(job) {
    const who = await waitFor(whoAmI, waitMs(job));
    if (!who) return { status: 'error', reason: 'the page never showed who is logged in' };
    if (who.login) return { status: 'login', reason: 'x.com shows a login button' };
    if (who.me !== job.account) return { status: 'wrong-account', reason: `logged in as @${who.me}, not @${job.account}` };
    return null;
  }

  // On x.com/<handle>: open the ⋯ menu of a post the account wrote (reposts
  // and quoted posts do not count) and click X's own Mute item. Tested with
  // synthetic clicks on 2026-11-06, including in a background tab that drew no
  // frames. A menu we decline stays open: the worker closes the tab.
  async function muteJob(job) {
    const h = job.handle;
    const bad = await wrongAccount(job);
    if (bad) return bad;
    // A post appears a few seconds before its ⋯ button does (seen on 3 of 4
    // profiles on 2026-11-06), so wait for one that has the button.
    const own = () => [...document.querySelectorAll(ARTICLE)].filter((a) => L.authorHandleOf(a) === h);
    const caret = await waitFor(() => {
      for (const a of own()) {
        const c = a.querySelector('[data-testid="caret"]');
        if (c) return c;
      }
      return null;
    }, waitMs(job));
    if (!caret) {
      return { status: 'no-post', reason: own().length ? 'its posts have no ⋯ button' : 'no post by the account on its profile' };
    }
    caret.click();
    const menu = await waitFor(() => document.querySelector('[role="menu"]'), 5000, 300);
    if (!menu) return { status: 'error', reason: 'the ⋯ menu did not open' };
    await sleep(300); // the items arrive just after the menu node
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const pick = L.chooseMuteItem(items.map(textOf), h);
    if (pick.action === 'done') return { status: pick.status };
    if (pick.action === 'refuse') return { status: pick.status, reason: pick.reason };
    // Settings may have changed since this tab claimed the job; the worker
    // answers no (and closes this tab) if the account is no longer to be muted.
    if (!adapter.confirmJob || !(await adapter.confirmJob(job))) {
      return { status: 'error', reason: 'the worker did not confirm the mute' };
    }
    items[pick.index].click();
    const sheet = () => document.querySelector('[data-testid="confirmationSheetDialog"]');
    const toast = () => {
      const t = document.querySelector('[data-testid="toast"]');
      return t && textOf(t) ? t : null;
    };
    await waitFor(() => sheet() || toast(), 4000, 250);
    if (sheet()) return { status: 'refused', reason: 'X asked for a confirmation; left it unanswered' };
    const t = toast();
    return { status: 'muted', toast: t ? textOf(t) : null };
  }

  function mutedRows() {
    const out = [];
    for (const cell of document.querySelectorAll('[data-testid="UserCell"]')) {
      const a = cell.querySelector('a[href]');
      const m = a && /^\/([A-Za-z0-9_]{1,15})$/.exec(a.getAttribute('href') || '');
      if (m) out.push(m[1].toLowerCase());
    }
    return out;
  }

  // On x.com/settings/muted/all: the rows it renders, newest mute first. A
  // background tab renders only the first 9 or so and loads no more on scroll
  // (seen 2026-11-06), which is why the worker checks every few mutes.
  async function checkJob(job) {
    const bad = await wrongAccount(job);
    if (bad) return bad;
    const any = await waitFor(() => mutedRows().length || document.querySelector('[data-testid="emptyState"]'), waitMs(job));
    if (!any) return { status: 'error', reason: 'settings/muted/all showed no rows' };
    // Rows arrive in batches: read them once the count has held for a second.
    let n = mutedRows().length;
    for (let i = 0; i < 5; i++) {
      await sleep(1000);
      const m = mutedRows().length;
      if (m === n) break;
      n = m;
    }
    return { status: 'checked', rows: mutedRows() };
  }

  async function runJob(job) {
    const work = job.kind === 'mute' ? muteJob(job) : job.kind === 'check' ? checkJob(job) : null;
    if (!work) return;
    let timer = null;
    const timeout = new Promise((r) => {
      timer = setTimeout(() => r({ status: 'error', reason: 'timed out in the page' }), job.pageTimeoutMs || 60000);
    });
    let result;
    try {
      result = await Promise.race([work, timeout]);
    } catch (e) {
      result = { status: 'error', reason: String((e && e.message) || e) };
    } finally {
      clearTimeout(timer);
    }
    return adapter.reportJob(Object.assign({ id: job.id }, result));
  }

  function extensionAdapter() {
    const K = L.STORAGE_KEYS;
    const read = () =>
      chrome.storage.local.get([K.list, K.settings]).then((o) => ({ list: o[K.list], settings: o[K.settings] }));
    return {
      load: read,
      subscribe(cb) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area === 'local' && (changes[K.list] || changes[K.settings])) read().then(cb);
        });
      },
      serveStats(fn) {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
          if (msg && msg.type === 'xsh:stats') sendResponse(fn());
        });
      },
      // The worker answers with a job only for a tab it opened for one.
      getJob: () => chrome.runtime.sendMessage({ type: 'xsh:job' }).catch(() => null),
      confirmJob: (job) =>
        chrome.runtime.sendMessage({ type: 'xsh:job-go', id: job.id }).then((ok) => ok === true, () => false),
      reportJob: (result) => chrome.runtime.sendMessage({ type: 'xsh:job-result', result }).catch(() => {}),
      noteSighting: (handle) => chrome.runtime.sendMessage({ type: 'xsh:sighting', handle }).catch(() => {}),
      // Asked by the worker before a mute visit at 50 or 100 a day: is an
      // x.com tab of the user's own open? fn answers no in a job's tab.
      answerPresent(fn) {
        chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
          if (!msg || msg.type !== 'xsh:present') return false;
          Promise.resolve()
            .then(fn)
            .then((v) => sendResponse(v === true), () => sendResponse(false));
          return true;
        });
      },
      // The worker checks and stores a label; it answers { ok } or { ok: false, reason }.
      saveLabel: (m) =>
        chrome.runtime
          .sendMessage(Object.assign({}, m, { type: 'xsh:label' }))
          .catch((e) => ({ ok: false, reason: String((e && e.message) || e) })),
      getLabels(ids) {
        const keys = ids.map((id) => L.LABEL_PREFIX + id);
        return chrome.storage.local.get(keys).then((o) => {
          const out = {};
          for (const id of ids) {
            const r = o[L.LABEL_PREFIX + id];
            out[id] = r && L.LABELS.includes(r.label) ? r.label : null;
          }
          return out;
        });
      },
      subscribeLabels(cb) {
        chrome.storage.onChanged.addListener((changes, area) => {
          if (area !== 'local') return;
          for (const k of Object.keys(changes)) {
            if (!k.startsWith(L.LABEL_PREFIX)) continue;
            const v = changes[k].newValue;
            cb(k.slice(L.LABEL_PREFIX.length), v && L.LABELS.includes(v.label) ? v.label : null);
          }
        });
      },
    };
  }

  const adapter =
    globalThis.XSlopHideAdapter ||
    (typeof chrome !== 'undefined' && chrome.storage && chrome.runtime && chrome.runtime.id ? extensionAdapter() : null);
  if (!adapter) return;

  injectStyle();
  new MutationObserver(onMutations).observe(document, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['href'],
  });
  adapter.subscribe(applyState);
  if (adapter.subscribeLabels) adapter.subscribeLabels(onLabelChange);
  if (adapter.serveStats) adapter.serveStats(stats);
  adapter.load().then(applyState);
  // A tab the worker opened for a job gets the job; every other tab gets null.
  let jobAsk = Promise.resolve(null);
  if (adapter.getJob && adapter.reportJob) {
    jobAsk = Promise.resolve(adapter.getJob()).catch(() => null);
    jobAsk.then((job) => job && runJob(job));
  }
  if (adapter.answerPresent) adapter.answerPresent(() => jobAsk.then((job) => !job, () => false));

  // Exposed for the userscript adapter and the live test harness only.
  globalThis.XSlopHideContent = { stats, rescanAll, applyState, runJob };
})();
