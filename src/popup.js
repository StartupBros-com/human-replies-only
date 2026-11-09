(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  const K = L.STORAGE_KEYS;
  const $ = (id) => document.getElementById(id);

  // render() runs again after every change; writing only what differs keeps
  // the live regions (role=status, role=alert) from announcing a message twice.
  function setText(el, text) {
    if (el.textContent !== text) el.textContent = text;
  }
  function setHidden(el, hidden) {
    if (el.hidden !== hidden) el.hidden = hidden;
  }

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
    setText(
      $('capWhy'),
      `No setting goes above ${top}: hiding already covers this browser, and muting only adds the X apps.` +
        (left ? ` At ${top} a day, muting the ${plural(left, 'account', 'accounts')} left takes ${plural(Math.ceil(left / top), 'day', 'days')}.` : ''),
    );
  }

  // Off: only the hint to fill Always show first. On: who it mutes as,
  // today's mutes as a bar and in words, and the totals so far. A stopped
  // day also says when muting starts again and where each reason is explained.
  function renderMuting(s, m) {
    const on = !!(s.muteEnabled && s.muteAccount);
    $('mute').checked = on;
    setHidden($('muteHint'), on);
    setHidden($('muteOn'), !on);
    if (!on) {
      setHidden($('muteStop'), true);
      setHidden($('muteNext'), true);
      return;
    }
    const now = Date.now();
    const b = L.muteBudget(m, L.utcDay(now), L.muteCap(s));
    const t = L.muteSummary(m);
    const next = m.nextAt && m.nextAt > now ? ` · next visit in ${Math.ceil((m.nextAt - now) / 60000)} min` : '';
    setText($('muteWho'), `Muting as @${s.muteAccount}`);
    $('muteBar').setAttribute('max', String(b.cap));
    $('muteBar').setAttribute('value', String(Math.min(b.mutes, b.cap)));
    setText($('muteToday'), `Today (UTC): ${b.mutes} of ${b.cap} mutes, ${b.visits} of ${b.visitCap} visits${next}`);
    setText(
      $('muteTotals'),
      `So far: ${t.muted} muted (${t.confirmed} seen on your muted list, ${t.notFound} not found there), ` +
        `${t.already} already muted, ${t.followed} you follow, ${t.skipped} skipped.`,
    );
    setHidden($('muteStop'), !b.stopped);
    setHidden($('muteNext'), !b.stopped);
    setText($('muteStop'), b.stopped ? `Stopped for today: ${b.stopped}` : '');
  }

  // Labels: on or off, how many are saved, export and a two-click delete.
  let deleteArmed = false;
  function renderLabels(s, n) {
    if (n === 0) deleteArmed = false;
    $('labeling').checked = s.labeling === true;
    setText($('labelsSum'), `${s.labeling === true ? 'On' : 'Off'} · ${n} saved`);
    setText($('export'), `Export labels (${n})`);
    // A button that is disabled while it has focus drops focus to the page;
    // hand it to the labels switch first.
    const active = document.activeElement;
    if (n === 0 && (active === $('export') || active === $('deleteLabels')) && typeof $('labeling').focus === 'function') {
      $('labeling').focus();
    }
    $('export').disabled = n === 0;
    $('deleteLabels').disabled = n === 0;
    $('deleteLabels').className = deleteArmed ? 'armed' : '';
    setText($('deleteLabels'), deleteArmed ? `Click again to delete ${plural(n, 'label', 'labels')}` : 'Delete all labels');
  }
  function labelsNote(text) {
    setHidden($('labelsMsg'), !text);
    setText($('labelsMsg'), text || '');
  }

  // The tab line: the number first, then where it came from.
  function renderTab(text, more, num) {
    const el = $('tab');
    el.className = num == null ? 'hero say' : 'hero';
    if (num == null) {
      setText(el, text);
    } else if (el.textContent !== `${num} ${text}`) {
      const big = document.createElement('span');
      big.className = 'num';
      big.textContent = String(num);
      const what = document.createElement('span');
      what.className = 'what';
      what.textContent = text;
      el.replaceChildren(big, ' ', what);
    }
    setHidden($('tabMore'), !more);
    setText($('tabMore'), more || '');
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
    setText($('list'), `${plural(rec.handles.length, 'account', 'accounts')} on the list`);
    setText($('listAge'), `From ${host}, ${rec.fetchedAt ? `updated ${ago(rec.fetchedAt)}` : 'not fetched yet'}`);
    setHidden($('err'), !rec.lastError);
    setText($('err'), rec.lastError ? `Last refresh failed (${ago(rec.lastAttemptAt)}): ${rec.lastError}.${rec.fetchedAt ? ' Still using the previous list.' : ''}` : '');
    $('paused').checked = !!s.paused;
    if (document.activeElement !== $('allow')) $('allow').value = s.allowlist || '';
    if (document.activeElement !== $('extra')) $('extra').value = s.extraList || '';
    const count = (text) => L.parseAllowlist(text).size;
    setText($('listsSum'), `Always show ${count(s.allowlist)} · Also hide ${count(s.extraList)}`);
    renderBots(s, rec.handles);
    $('mentions').checked = s.hideBotMentions === true;

    // Pause is one setting for every tab, so it reads the same on any tab.
    if (s.paused) return renderTab('Hiding is paused', 'Turn off Pause hiding to hide posts again.');
    let st = null;
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    if (tab && tab.id != null) {
      try {
        st = await chrome.tabs.sendMessage(tab.id, { type: 'xsh:stats' });
      } catch (_) {
        // No content script in this tab (not x.com).
      }
    }
    // No answer: another site, or an x.com tab opened before the extension
    // was installed or reloaded, which has no content script until it reloads.
    if (!st) return renderTab('Open x.com in this tab to see what was hidden.', 'If it is already open, reload the tab.');
    if (st.paused) return renderTab('Hiding is paused', 'Turn off Pause hiding to hide posts again.');
    // Tag hiding counts apart from the list; when it hid everything, its count leads.
    if (!st.hiddenPosts && st.hiddenMentions) {
      const one = st.hiddenMentions === 1;
      return renderTab(`${one ? 'post' : 'posts'} hidden on this tab`, `${one ? 'It tags a bot.' : 'Each one tags a bot.'} ${st.hiddenNow} on screen now.`, st.hiddenMentions);
    }
    const more = [];
    if (st.hiddenPosts) more.push(`From ${plural(st.hiddenAuthors.length, 'account', 'accounts')}.`);
    if (st.hiddenMentions) more.push(`Plus ${plural(st.hiddenMentions, 'post that tags', 'posts that tag')} a bot.`);
    // The page marks every hidden post the same way, so this counts both kinds.
    if (more.length) more.push(`${st.hiddenNow} on screen now.`);
    renderTab(`${st.hiddenPosts === 1 ? 'post' : 'posts'} hidden on this tab`, more.join(' '), st.hiddenPosts);
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
      // Shown, and read with the choice, only while Always show locks the row.
      const why = document.createElement('span');
      why.className = 'note muted';
      why.id = `bot-${b.handle}-why`;
      why.hidden = true;
      why.textContent = 'Locked to Show: it is in Always show.';
      who.append(a, note, why);
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

  // An Always show entry wins over a bot's row, so the row is locked to Show.
  // The section's summary line counts the rows, so it reads while folded.
  function renderBots(s, handles) {
    const modes = L.botModes(s, handles);
    const allow = L.parseAllowlist(s.allowlist);
    const n = { show: 0, hide: 0, mute: 0 };
    for (const b of L.BOTS) n[modes[b.handle]] += 1;
    setText($('botsSum'), L.BOT_MODES.map((m) => `${LABELS[m]} ${n[m]}`).join(' · '));
    for (const b of L.BOTS) {
      const sel = $(`bot-${b.handle}`);
      if (!sel || document.activeElement === sel) continue;
      setChoice(sel, modes[b.handle]);
      const locked = allow.has(b.handle);
      sel.disabled = locked;
      setHidden($(`bot-${b.handle}-why`), !locked);
      if (locked) sel.setAttribute('aria-describedby', `bot-${b.handle}-why`);
      else sel.removeAttribute('aria-describedby');
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
  // Export and import live on the options page: a file picker opened from
  // the popup can close the popup before the file is read.
  $('files').addEventListener('click', () => chrome.runtime.openOptionsPage());
  // aria-disabled, not disabled, while it refreshes: a disabled button drops
  // keyboard focus. aria-disabled does not stop clicks, so the flag does.
  let refreshing = false;
  $('refresh').addEventListener('click', async () => {
    if (refreshing) return;
    refreshing = true;
    const btn = $('refresh');
    btn.setAttribute('aria-disabled', 'true');
    btn.textContent = 'Refreshing…';
    try {
      await chrome.runtime.sendMessage({ type: 'xsh:refresh' });
    } finally {
      refreshing = false;
      btn.removeAttribute('aria-disabled');
      btn.textContent = 'Refresh list now';
      render();
    }
  });

  buildBots();
  render();
})();
