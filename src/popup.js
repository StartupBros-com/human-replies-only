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

  function renderMuting(s, m) {
    $('mute').checked = !!(s.muteEnabled && s.muteAccount);
    if (!$('mute').checked) {
      $('muteState').textContent = 'Off.';
      $('muteStop').hidden = true;
    } else {
      const now = Date.now();
      const b = L.muteBudget(m, L.utcDay(now));
      const t = L.muteSummary(m);
      const next = m.nextAt && m.nextAt > now ? ` · next visit in ${Math.ceil((m.nextAt - now) / 60000)} min` : '';
      $('muteState').textContent =
        `Muting as @${s.muteAccount}. Today (UTC): ${b.mutes} of ${L.DEFAULTS.muteDailyCap} mutes, ` +
        `${b.visits} of ${L.DEFAULTS.muteVisitCap} visits${next}. ` +
        `So far: ${t.muted} muted (${t.confirmed} seen on your muted list, ${t.notFound} not found there), ` +
        `${t.already} already muted, ${t.followed} you follow, ${t.skipped} skipped.`;
      $('muteStop').hidden = !b.stopped;
      $('muteStop').textContent = b.stopped ? `Stopped for today: ${b.stopped}` : '';
    }
  }

  async function render() {
    const o = await chrome.storage.local.get([K.list, K.settings, K.mutes]);
    const rec = o[K.list] || { handles: [] };
    const s = o[K.settings] || {};
    renderMuting(s, o[K.mutes] || L.emptyMutes());
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

  // Turning muting on binds it to the account logged in on this tab's x.com;
  // the worker then refuses to mute from any other account.
  $('mute').addEventListener('change', async () => {
    const box = $('mute'); // not e.target: read again after an await, it can be gone
    $('muteErr').hidden = true;
    if (!box.checked) {
      await saveSettings({ muteEnabled: false, muteAccount: null });
      return render();
    }
    let me = null;
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      const st = tab && tab.id != null ? await chrome.tabs.sendMessage(tab.id, { type: 'xsh:stats' }) : null;
      me = st && st.me;
    } catch (_) {
      me = null;
    }
    if (!me) {
      box.checked = false;
      $('muteErr').hidden = false;
      $('muteErr').textContent = 'Open x.com in this tab, logged in as the account to mute from, then turn this on.';
      return;
    }
    await saveSettings({ muteEnabled: true, muteAccount: me });
    render();
  });

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
