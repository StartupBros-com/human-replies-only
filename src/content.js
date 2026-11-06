// x-slop-hide content script: hides x.com timeline cells whose post author is
// on the list. Display-only: it never clicks, mutes, blocks or calls an API.
//
// State comes from an adapter: the extension adapter below (chrome.storage,
// filled by background.js), or globalThis.XSlopHideAdapter when the userscript
// build supplies one.
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
    rescanAll();
  }

  function stats() {
    return {
      listed: list.size,
      paused,
      hiddenNow: document.querySelectorAll(`[${ATTR}]`).length,
      hiddenPosts: hiddenPosts.size,
      hiddenAuthors: [...hiddenAuthors].sort(),
    };
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

  // Exposed for the userscript adapter and the live test harness only.
  globalThis.XSlopHideContent = { stats, rescanAll, applyState };
})();
