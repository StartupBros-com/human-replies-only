// The export and import page (the extension's options page). Export saves a
// settings file or Also hide as a list; import reads one file the user
// picks, shows what it would change, and writes only after Confirm. Every
// write goes through lib.importPlan, which touches only the account boxes,
// the bot choices and the tag setting.
(function () {
  'use strict';
  const L = globalThis.XSlopHide;
  const K = L.STORAGE_KEYS;
  const $ = (id) => document.getElementById(id);

  const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
  const LABELS = { show: 'Show', hide: 'Hide here', mute: 'Mute on X' };
  const botName = (h) => (L.BOTS.find((b) => b.handle === h) || { name: h }).name;
  // Handles in a preview line: the first few by name, then a count. A line
  // with more than that also lists every handle under Show all, so a long
  // shared list can be read in full before it is imported.
  const NAMED = 12;
  function names(hs) {
    const shown = hs.slice(0, NAMED).map((h) => `@${h}`);
    const more = hs.length - shown.length;
    return more > 0 ? `${shown.join(', ')} and ${more} more` : shown.join(', ');
  }
  function fill(el, text, hs) {
    el.textContent = text;
    if (!hs || hs.length <= NAMED) return;
    const all = document.createElement('details');
    const summary = document.createElement('summary');
    summary.textContent = `Show all ${plural(hs.length, 'account', 'accounts')}`;
    const list = document.createElement('p');
    list.textContent = hs.map((h) => `@${h}`).join(', ');
    all.append(summary, list);
    el.append(all);
  }

  async function current() {
    const o = await chrome.storage.local.get([K.list, K.settings]);
    const rec = o[K.list];
    return { settings: o[K.settings] || {}, handles: (rec && Array.isArray(rec.handles) && rec.handles) || [] };
  }

  function note(el, text, bad) {
    el.hidden = !text;
    el.textContent = text || '';
    if (bad) el.classList.add('bad');
    else el.classList.remove('bad');
  }

  async function render() {
    const { settings: s } = await current();
    const hide = L.parseAllowlist(s.extraList).size;
    const bots = Object.keys(L.settingsExport(s, Date.now()).bots).length;
    $('have').textContent =
      `Now: Always show ${L.parseAllowlist(s.allowlist).size} · Also hide ${hide} · ` +
      `${plural(bots, 'bot choice', 'bot choices')} saved`;
    $('exportList').disabled = hide === 0;
  }

  // ------------------------------------------------------------------ export

  // The previous file's URL is freed before the next one is made.
  let fileUrl = null;
  function download(text, type, name) {
    if (fileUrl) URL.revokeObjectURL(fileUrl);
    fileUrl = URL.createObjectURL(new Blob([text], { type }));
    const a = document.createElement('a');
    a.setAttribute('href', fileUrl);
    a.setAttribute('download', name);
    document.body.append(a);
    a.click();
    a.remove();
  }

  $('exportSettings').addEventListener('click', async () => {
    const { settings } = await current();
    const now = Date.now();
    const out = L.settingsExport(settings, now);
    download(`${JSON.stringify(out, null, 2)}\n`, 'application/json', `ai-anti-slop-settings-${L.utcDay(now)}.json`);
    note(
      $('exportMsg'),
      `Exported settings: Always show ${out.alwaysShow.length}, Also hide ${out.alsoHide.length}, ` +
        `${plural(Object.keys(out.bots).length, 'bot choice', 'bot choices')}.`,
    );
  });

  $('exportList').addEventListener('click', async () => {
    const { settings } = await current();
    const text = L.alsoHideText(settings);
    if (!text) return note($('exportMsg'), 'Also hide is empty, so there is no list to export.');
    download(text, 'text/plain', `ai-anti-slop-also-hide-${L.utcDay(Date.now())}.txt`);
    note($('exportMsg'), `Exported Also hide as a list of ${plural(L.parseAllowlist(settings.extraList).size, 'account', 'accounts')}.`);
  });

  // ------------------------------------------------------------------ import

  // The file read and checked, and the plan the preview shows, as JSON: at
  // Confirm the plan is made again from storage, and a different plan is
  // shown again instead of written.
  let pending = null;

  function reset() {
    pending = null;
    $('preview').hidden = true;
    $('stale').hidden = true;
    $('changes').textContent = '';
    $('file').value = '';
  }

  function line(text, hs) {
    const li = document.createElement('li');
    fill(li, text, hs);
    $('changes').append(li);
  }

  function showPlan(plan, stale) {
    $('changes').textContent = '';
    note($('msg'), '');
    if (plan.empty) {
      reset();
      return note($('msg'), 'Nothing to import: your settings already have everything in this file.');
    }
    const p = plan;
    if (p.addShow.length) line(`Always show gains ${plural(p.addShow.length, 'account', 'accounts')}: ${names(p.addShow)}.`, p.addShow);
    if (p.addHide.length) line(`Also hide gains ${plural(p.addHide.length, 'account', 'accounts')}: ${names(p.addHide)}.`, p.addHide);
    if (p.staysShown.length)
      line(`${names(p.staysShown)} will stay shown, because Always show has ${p.staysShown.length === 1 ? 'it' : 'them'}.`, p.staysShown);
    if (p.staysShownBots.length)
      line(`${names(p.staysShownBots.map(botName))} will stay shown, because ${p.staysShownBots.length === 1 ? 'it is' : 'they are'} set to Show.`);
    for (const c of p.botChanges) line(`@${botName(c.handle)}: ${c.from ? LABELS[c.from] : 'follows the list'} → ${LABELS[c.to]}.`);
    if (p.mentions !== null) line(`${p.mentions ? 'Turns on' : 'Turns off'} hiding posts that tag a bot set to Hide here or Mute on X.`);

    const t = p.muteTargets;
    const bots = p.muteBots.length ? ` Bots among them: ${p.muteBots.map((h) => `@${botName(h)}`).join(', ')}.` : '';
    const mute = $('muteNote');
    mute.hidden = !t.length;
    mute.className = p.muting ? 'warn' : 'hint';
    fill(
      mute,
      !t.length
        ? ''
        : p.muting
          ? `Muting is on as @${p.muteAccount}. After this import it can also mute ${plural(t.length, 'more account', 'more accounts')}: ` +
            `${names(t)}.${bots} It mutes up to ${p.muteCap} a day, skips accounts you follow, and never unmutes.`
          : `Muting is off. If you turn it on, it can also mute ${plural(t.length, 'account', 'accounts')} from this file: ${names(t)}.${bots}`,
      t,
    );
    $('stale').hidden = !stale;
    $('preview').hidden = false;
  }

  $('file').addEventListener('change', async () => {
    const input = $('file');
    const f = input.files && input.files[0];
    pending = null;
    $('preview').hidden = true;
    note($('msg'), '');
    if (!f) return;
    let r;
    if (f.size > L.DEFAULTS.maxBytes) {
      r = { ok: false, reason: `the file is larger than ${L.DEFAULTS.maxBytes / 1000000} MB` };
    } else {
      try {
        r = L.readSettingsFile(await f.text());
      } catch (_) {
        r = { ok: false, reason: 'the file could not be read' };
      }
    }
    if (!r.ok) {
      reset();
      return note($('msg'), `Not imported: ${r.reason}.`, true);
    }
    const { settings, handles } = await current();
    const plan = L.importPlan(settings, r, handles);
    pending = { file: r, key: JSON.stringify(plan) };
    $('fileKind').textContent =
      r.kind === 'list' ? `${f.name}: a list of ${plural(r.alsoHide.length, 'handle', 'handles')}, for Also hide` : `${f.name}: a settings file`;
    showPlan(plan, false);
  });

  // One Confirm at a time. Cancel, or another file picked, while it reads
  // settings stops it before it writes.
  let confirming = false;
  $('confirm').addEventListener('click', async () => {
    const was = pending;
    if (!was || confirming) return;
    confirming = true;
    try {
      const { settings, handles } = await current();
      if (pending !== was) return;
      const plan = L.importPlan(settings, was.file, handles);
      const key = JSON.stringify(plan);
      if (key !== was.key) {
        was.key = key;
        return showPlan(plan, true);
      }
      await chrome.storage.local.set({ [K.settings]: Object.assign({}, settings, plan.patch) });
      const done = [];
      if (plan.addShow.length) done.push(`Always show gained ${plan.addShow.length}`);
      if (plan.addHide.length) done.push(`Also hide gained ${plan.addHide.length}`);
      if (plan.botChanges.length) done.push(plural(plan.botChanges.length, 'bot choice changed', 'bot choices changed'));
      if (plan.mentions !== null) done.push(`tag hiding turned ${plan.mentions ? 'on' : 'off'}`);
      reset();
      note($('msg'), `Imported: ${done.join(', ')}.`);
      render();
    } finally {
      confirming = false;
    }
  });

  $('cancel').addEventListener('click', () => {
    reset();
    note($('msg'), 'Nothing imported.');
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes[K.settings]) render();
  });
  render();
})();
