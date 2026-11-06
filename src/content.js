// x-slop-hide content script: hides x.com timeline cells whose post author is
// on the list. In the user's own tabs it never clicks anything.
//
// Muting, when the user has turned it on, happens only in a tab the background
// worker opened for one job (see runJob below): there it clicks a post's ⋯ and
// X's own Mute item, then reports back, and the worker closes the tab. It never
// calls X's API.
//
// State comes from an adapter: the extension adapter below (chrome.storage,
// filled by background.js), or globalThis.XSlopHideAdapter when the userscript
// build supplies one. The userscript adapter has no jobs, so it only hides.
(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  if (!L) return;

  const ATTR = 'data-xsh-hidden';
  const ARTICLE = 'article[data-testid="tweet"]';
  const CELL = '[data-testid="cellInnerDiv"]';

  let list = new Set();
  let allow = new Set();
  let paused = false;
  let muting = false;
  let lastPath = location.pathname;
  const hiddenPosts = new Set(); // distinct posts hidden in this tab
  const hiddenAuthors = new Set();

  function injectStyle() {
    if (document.getElementById('xsh-style')) return;
    const st = document.createElement('style');
    st.id = 'xsh-style';
    st.textContent = `[${ATTR}]{display:none!important}`;
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
    } else if (cell.hasAttribute(ATTR)) {
      cell.removeAttribute(ATTR);
    }
  }

  function rescanAll() {
    const owner = L.pageOwner(location.pathname);
    for (const art of document.querySelectorAll(ARTICLE)) evaluate(art, owner);
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
    for (const art of touched) if (document.contains(art)) evaluate(art, owner);
  }

  function applyState(s) {
    list = new Set((s.list && s.list.handles) || []);
    allow = L.effectiveAllow(s.settings);
    paused = !!(s.settings && s.settings.paused);
    muting = !!(s.settings && s.settings.muteEnabled);
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
    const art = await waitFor(() => [...document.querySelectorAll(ARTICLE)].find((a) => L.authorHandleOf(a) === h), waitMs(job));
    if (!art) return { status: 'no-post', reason: 'no post by the account on its profile' };
    const caret = art.querySelector('[data-testid="caret"]');
    if (!caret) return { status: 'no-post', reason: 'its post has no ⋯ button' };
    caret.click();
    const menu = await waitFor(() => document.querySelector('[role="menu"]'), 5000, 300);
    if (!menu) return { status: 'error', reason: 'the ⋯ menu did not open' };
    await sleep(300); // the items arrive just after the menu node
    const items = [...menu.querySelectorAll('[role="menuitem"]')];
    const pick = L.chooseMuteItem(items.map(textOf), h);
    if (pick.action === 'done') return { status: pick.status };
    if (pick.action === 'refuse') return { status: pick.status, reason: pick.reason };
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
    await sleep(1000); // let the first screen of rows finish arriving
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
      reportJob: (result) => chrome.runtime.sendMessage({ type: 'xsh:job-result', result }).catch(() => {}),
      noteSighting: (handle) => chrome.runtime.sendMessage({ type: 'xsh:sighting', handle }).catch(() => {}),
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
  if (adapter.serveStats) adapter.serveStats(stats);
  adapter.load().then(applyState);
  if (adapter.getJob && adapter.reportJob) adapter.getJob().then((job) => job && runJob(job));

  // Exposed for the userscript adapter and the live test harness only.
  globalThis.XSlopHideContent = { stats, rescanAll, applyState, runJob };
})();
