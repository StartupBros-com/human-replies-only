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
    if (document.activeElement !== $('allow')) $('allow').value = s.allowlist || '';
    if (document.activeElement !== $('extra')) $('extra').value = s.extraList || '';
    renderBots(s, rec.handles);
    $('mentions').checked = s.hideBotMentions === true;

    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    $('tab').textContent = 'Open x.com in this tab to see what was hidden.';
    if (tab && tab.id != null) {
      try {
        const st = await chrome.tabs.sendMessage(tab.id, { type: 'xsh:stats' });
        if (st) {
          const tags = st.hiddenMentions ? `, plus ${st.hiddenMentions} posts that tag a bot` : '';
          $('tab').textContent = st.paused
            ? 'Paused on this tab.'
            : `This tab: ${st.hiddenPosts} posts from ${st.hiddenAuthors.length} accounts hidden${tags} (${st.hiddenNow} on screen now).`;
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

  // One row per bot: a link to its profile (for a manual block) and a
  // Show / Hide here / Mute on X choice. Built once; render sets the values.
  const LABELS = { show: 'Show', hide: 'Hide here', mute: 'Mute on X' };
  // Through the options, not select.value, and clearing before selecting:
  // the test DOM (linkedom) has a read-only select.value and loses a
  // selection when a later option is set to false.
  const options = (sel) => [...sel.querySelectorAll('option')];
  const setChoice = (sel, v) => {
    for (const o of options(sel)) o.selected = false;
    const hit = options(sel).find((o) => o.value === v);
    if (hit) hit.selected = true;
  };
  const choiceOf = (sel) => (options(sel).find((o) => o.selected) || {}).value;
  function buildBots() {
    for (const b of L.BOTS) {
      const row = document.createElement('div');
      row.className = 'bot';
      const who = document.createElement('span');
      who.className = 'who';
      const a = document.createElement('a');
      a.href = `https://x.com/${b.name}`;
      a.target = '_blank';
      a.rel = 'noopener';
      a.textContent = `@${b.name}`;
      const note = document.createElement('span');
      note.className = 'note muted';
      note.textContent = b.note;
      who.append(a, note);
      const sel = document.createElement('select');
      sel.id = `bot-${b.handle}`;
      sel.setAttribute('aria-label', `@${b.name}`);
      for (const m of L.BOT_MODES) {
        const o = document.createElement('option');
        o.value = m;
        o.textContent = LABELS[m];
        sel.append(o);
      }
      sel.addEventListener('change', async () => {
        const mode = choiceOf(sel);
        if (!L.BOT_MODES.includes(mode)) return;
        const o = await chrome.storage.local.get(K.settings);
        const cur = o[K.settings] || {};
        await saveSettings({ bots: Object.assign({}, cur.bots || {}, { [b.handle]: mode }) });
        render();
      });
      row.append(who, sel);
      $('bots').append(row);
    }
  }

  // An Always-show entry wins over a bot's row, so the row is locked to Show.
  function renderBots(s, handles) {
    const modes = L.botModes(s, handles);
    const allow = L.parseAllowlist(s.allowlist);
    for (const b of L.BOTS) {
      const sel = $(`bot-${b.handle}`);
      if (!sel || document.activeElement === sel) continue;
      setChoice(sel, modes[b.handle]);
      sel.disabled = allow.has(b.handle);
      sel.title = sel.disabled ? 'In your Always-show list' : '';
    }
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
  $('mentions').addEventListener('change', (e) => saveSettings({ hideBotMentions: e.target.checked }).then(render));
  // One write for both boxes, so neither can overwrite the other with a stale value.
  $('save').addEventListener('click', () => {
    const clean = (id) => [...L.parseAllowlist($(id).value)].sort().join('\n');
    const allowlist = clean('allow');
    const extraList = clean('extra');
    $('allow').value = allowlist;
    $('extra').value = extraList;
    saveSettings({ allowlist, extraList }).then(render);
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

  buildBots();
  render();
})();
