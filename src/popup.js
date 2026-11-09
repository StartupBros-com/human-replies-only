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

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;

  // The daily number, and why none goes past the top one: hiding already
  // covers this browser, so muting only adds the X apps.
  function renderCap(s, m, handles) {
    const cap = L.muteCap(s);
    const sel = $('muteCap');
    if (document.activeElement !== sel) setChoice(sel, String(cap));
    const top = Math.max(...L.DEFAULTS.muteCaps);
    const left = L.muteCandidates(handles, s, m).length;
    $('capWhy').textContent =
      `No setting goes above ${top}: hiding already covers this browser, and muting only adds the X apps.` +
      (left ? ` At ${top} a day, muting the ${plural(left, 'account', 'accounts')} left takes ${plural(Math.ceil(left / top), 'day', 'days')}.` : '');
  }

  // Off: only the hint to fill Always show first. On: who it mutes as,
  // today's mutes as a bar and in words, and the totals so far.
  function renderMuting(s, m) {
    const on = !!(s.muteEnabled && s.muteAccount);
    $('mute').checked = on;
    $('muteHint').hidden = on;
    $('muteOn').hidden = !on;
    if (!on) {
      $('muteStop').hidden = true;
      return;
    }
    const now = Date.now();
    const b = L.muteBudget(m, L.utcDay(now), L.muteCap(s));
    const t = L.muteSummary(m);
    const next = m.nextAt && m.nextAt > now ? ` · next visit in ${Math.ceil((m.nextAt - now) / 60000)} min` : '';
    $('muteWho').textContent = `Muting as @${s.muteAccount}`;
    $('muteBar').setAttribute('max', String(b.cap));
    $('muteBar').setAttribute('value', String(Math.min(b.mutes, b.cap)));
    $('muteToday').textContent = `Today (UTC): ${b.mutes} of ${b.cap} mutes, ${b.visits} of ${b.visitCap} visits${next}`;
    $('muteTotals').textContent =
      `So far: ${t.muted} muted (${t.confirmed} seen on your muted list, ${t.notFound} not found there), ` +
      `${t.already} already muted, ${t.followed} you follow, ${t.skipped} skipped.`;
    $('muteStop').hidden = !b.stopped;
    $('muteStop').textContent = b.stopped ? `Stopped for today: ${b.stopped}` : '';
  }

  // Labels: on or off, how many are saved, export and a two-click delete.
  let deleteArmed = false;
  function renderLabels(s, n) {
    if (n === 0) deleteArmed = false;
    $('labeling').checked = s.labeling === true;
    $('labelsSum').textContent = `${s.labeling === true ? 'On' : 'Off'} · ${n} saved`;
    $('export').textContent = `Export labels (${n})`;
    $('export').disabled = n === 0;
    $('deleteLabels').disabled = n === 0;
    $('deleteLabels').textContent = deleteArmed ? `Click again to delete ${plural(n, 'label', 'labels')}` : 'Delete all labels';
  }
  function labelsNote(text) {
    $('labelsMsg').hidden = !text;
    $('labelsMsg').textContent = text || '';
  }

  async function render() {
    const o = await chrome.storage.local.get([K.list, K.settings, K.mutes, K.labelCount]);
    const rec = o[K.list] || { handles: [] };
    const s = o[K.settings] || {};
    const m = o[K.mutes] || L.emptyMutes();
    renderMuting(s, m);
    renderCap(s, m, rec.handles);
    const n = o[K.labelCount];
    renderLabels(s, Number.isInteger(n) && n > 0 ? n : 0);
    let host = '';
    try {
      host = new URL(rec.source || L.DEFAULTS.feedUrl).host;
    } catch (_) {
      host = String(rec.source || '');
    }
    $('list').textContent = `${rec.handles.length} listed accounts · ${host}`;
    $('listAge').textContent = rec.fetchedAt ? `Updated ${ago(rec.fetchedAt)}` : 'Not fetched yet';
    $('err').hidden = !rec.lastError;
    $('err').textContent = rec.lastError ? `Last refresh failed (${ago(rec.lastAttemptAt)}): ${rec.lastError}. Still using the previous list.` : '';
    $('paused').checked = !!s.paused;
    if (document.activeElement !== $('allow')) $('allow').value = s.allowlist || '';
    if (document.activeElement !== $('extra')) $('extra').value = s.extraList || '';
    const count = (text) => L.parseAllowlist(text).size;
    $('listsSum').textContent = `Always show ${count(s.allowlist)} · Also hide ${count(s.extraList)}`;
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
      sel.setAttribute('aria-label', `What to do with @${b.name}`);
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
  // The section's summary line counts the rows, so it reads while folded.
  function renderBots(s, handles) {
    const modes = L.botModes(s, handles);
    const allow = L.parseAllowlist(s.allowlist);
    const n = { show: 0, hide: 0, mute: 0 };
    for (const b of L.BOTS) n[modes[b.handle]] += 1;
    $('botsSum').textContent = L.BOT_MODES.map((m) => `${LABELS[m]} ${n[m]}`).join(' · ');
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

  $('muteCap').addEventListener('change', () => {
    const v = Number(choiceOf($('muteCap')));
    if (!L.DEFAULTS.muteCaps.includes(v)) return;
    saveSettings({ muteCap: v }).then(render);
  });
  $('labeling').addEventListener('change', (e) => saveSettings({ labeling: e.target.checked }).then(render));
  // A JSONL file of every saved label, built from the label keys themselves
  // (the count is only a cache). The previous file's URL is freed first.
  let exportUrl = null;
  $('export').addEventListener('click', async () => {
    const recs = L.labelsFrom(await chrome.storage.local.get(null));
    if (!recs.length) return labelsNote('No labels saved yet.');
    if (exportUrl) URL.revokeObjectURL(exportUrl);
    exportUrl = URL.createObjectURL(new Blob([L.labelsJsonl(recs)], { type: 'application/x-ndjson' }));
    const a = document.createElement('a');
    a.setAttribute('href', exportUrl);
    a.setAttribute('download', `x-slop-hide-labels-${L.utcDay(Date.now())}.jsonl`);
    document.body.append(a);
    a.click();
    a.remove();
    labelsNote(`Exported ${plural(recs.length, 'label', 'labels')}.`);
  });
  // The first click only arms the button; the second deletes. The worker
  // deletes the labels; Also hide and Always show stay as they are.
  $('deleteLabels').addEventListener('click', async () => {
    if (!deleteArmed) {
      deleteArmed = true;
      return render();
    }
    deleteArmed = false;
    let r = null;
    try {
      r = await chrome.runtime.sendMessage({ type: 'xsh:labels-clear' });
    } catch (e) {
      r = { ok: false, reason: String(e) };
    }
    labelsNote(r && r.ok ? `Deleted ${plural(r.removed, 'label', 'labels')}.` : `Not deleted: ${(r && r.reason) || 'no answer'}`);
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
