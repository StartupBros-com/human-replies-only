// Userscript adapter: supplies state to content.js through Greasemonkey APIs
// when the extension is not installed. Included only in dist/x-slop-hide.user.js.
/* global GM_getValue, GM_setValue, GM_xmlhttpRequest, GM_registerMenuCommand, GM_addValueChangeListener, setInterval */
(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  const K = L.STORAGE_KEYS;
  const subscribers = [];

  const read = () => ({ list: GM_getValue(K.list, null), settings: GM_getValue(K.settings, {}) });
  const notify = () => {
    const s = read();
    for (const cb of subscribers) cb(s);
  };

  // A fetch-shaped wrapper so lib.fetchList validates exactly as the extension does.
  function gmFetch(url) {
    return new Promise((resolve, reject) => {
      GM_xmlhttpRequest({
        method: 'GET',
        url,
        anonymous: true,
        timeout: L.DEFAULTS.timeoutMs,
        onload: (r) => {
          const ctype = /^content-type:\s*(.*)$/im.exec(r.responseHeaders || '');
          resolve({
            ok: r.status >= 200 && r.status < 300,
            status: r.status,
            headers: { get: (name) => (/^content-type$/i.test(name) && ctype ? ctype[1].trim() : null) },
            text: () => Promise.resolve(r.responseText || ''),
          });
        },
        onerror: () => reject(new Error('request failed')),
        ontimeout: () => reject(new Error('timed out')),
      });
    });
  }

  // One refresh at a time per tab. Tabs share GM storage, so the commit
  // re-reads the stored list and drops a result a newer refresh superseded.
  let inflight = null;
  function refresh(force) {
    if (inflight) return inflight;
    const s = read();
    const prev = s.list;
    if (!force && !L.isRefreshDue(prev, Date.now())) return Promise.resolve();
    const url = (s.settings && s.settings.feedUrl) || L.DEFAULTS.feedUrl;
    const startSeq = (prev && prev.seq) || 0;
    inflight = L.fetchList({ url, fetchImpl: gmFetch, prevHandles: prev && prev.handles })
      .then((result) => {
        const record = L.commitRecord(GM_getValue(K.list, null), result, url, startSeq, Date.now());
        if (record) GM_setValue(K.list, record);
        notify();
      })
      .finally(() => (inflight = null));
    return inflight;
  }

  function patchSettings(patch) {
    GM_setValue(K.settings, Object.assign({}, GM_getValue(K.settings, {}), patch));
    notify();
  }

  globalThis.XSlopHideAdapter = {
    load: () => Promise.resolve(read()),
    subscribe(cb) {
      subscribers.push(cb);
    },
  };

  if (typeof GM_addValueChangeListener === 'function') {
    GM_addValueChangeListener(K.list, (_n, _o, _v, remote) => remote && notify());
    GM_addValueChangeListener(K.settings, (_n, _o, _v, remote) => remote && notify());
  }
  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('Pause / resume hiding', () => patchSettings({ paused: !read().settings.paused }));
    GM_registerMenuCommand('Refresh list now', () => refresh(true));
    GM_registerMenuCommand('Edit always-show list', () => {
      const cur = read().settings.allowlist || '';
      const next = prompt('Accounts to always show (space or comma separated):', cur.replace(/\n/g, ' '));
      if (next != null) patchSettings({ allowlist: [...L.parseAllowlist(next)].sort().join('\n') });
    });
  }
  // A tab can stay open for days through in-app navigation: check whether
  // the list is due on a timer, and again when the tab comes back into view
  // (background tabs may throttle or suspend timers).
  refresh(false);
  setInterval(() => refresh(false), L.DEFAULTS.checkMinutes * 60 * 1000);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') refresh(false);
  });
})();
