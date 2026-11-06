(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  const K = L.STORAGE_KEYS;
  const $ = (id) => document.getElementById(id);

  function ago(ms) {
    if (!ms) return 'never';
    const m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return `${m} min ago`;
    const h = Math.round(m / 60);
    return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} days ago`;
  }

  async function render() {
    const o = await chrome.storage.local.get([K.list, K.settings]);
    const rec = o[K.list] || { handles: [] };
    const s = o[K.settings] || {};
    let host = '';
    try {
      host = new URL(rec.source || L.DEFAULTS.feedUrl).host;
    } catch (_) {
      host = String(rec.source || '');
    }
    $('list').textContent = `${rec.handles.length} listed accounts · updated ${ago(rec.fetchedAt)} · ${host}`;
    $('err').hidden = !rec.lastError;
    $('err').textContent = rec.lastError ? `Last refresh failed (${ago(rec.lastAttemptAt)}): ${rec.lastError}. Still using the previous list.` : '';
    $('paused').checked = !!s.paused;
    $('grok').checked = s.showGrok === true;
    if (document.activeElement !== $('allow')) $('allow').value = s.allowlist || '';

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $('tab').textContent = 'Open x.com in this tab to see what was hidden.';
    if (tab && tab.id != null) {
      try {
        const st = await chrome.tabs.sendMessage(tab.id, { type: 'xsh:stats' });
        if (st) {
          $('tab').textContent = st.paused
            ? 'Paused on this tab.'
            : `This tab: ${st.hiddenPosts} posts from ${st.hiddenAuthors.length} accounts hidden (${st.hiddenNow} on screen now).`;
        }
      } catch (_) {
        // No content script in this tab (not x.com).
      }
    }
  }

  async function saveSettings(patch) {
    const o = await chrome.storage.local.get(K.settings);
    await chrome.storage.local.set({ [K.settings]: Object.assign({}, o[K.settings] || {}, patch) });
  }

  $('paused').addEventListener('change', (e) => saveSettings({ paused: e.target.checked }).then(render));
  $('grok').addEventListener('change', (e) => saveSettings({ showGrok: e.target.checked }).then(render));
  $('save').addEventListener('click', () => {
    const cleaned = [...L.parseAllowlist($('allow').value)].sort().join('\n');
    $('allow').value = cleaned;
    saveSettings({ allowlist: cleaned }).then(render);
  });
  $('refresh').addEventListener('click', async () => {
    $('refresh').disabled = true;
    $('refresh').textContent = 'Refreshing…';
    try {
      await chrome.runtime.sendMessage({ type: 'xsh:refresh' });
    } finally {
      $('refresh').disabled = false;
      $('refresh').textContent = 'Refresh list now';
      render();
    }
  });

  render();
})();
