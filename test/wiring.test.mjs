// Wiring tests: run the real background.js and the built userscript against
// in-memory fakes of chrome.* and GM_*. They check the glue, not the browser;
// the live check on x.com is described in the README.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildUserscript } from '../scripts/build-userscript.mjs';
import { src, root, post, page, tick, lib, meLink } from './helpers.mjs';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { parseHTML } from 'linkedom';

const many = (n) => Array.from({ length: n }, (_, i) => `h${i}`);

function event() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.map((f) => f(...a)) };
}

function area(store, onChanged, name) {
  return {
    get: async (keys) => {
      if (keys === null || keys === undefined) return structuredClone(store);
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
    },
    set: async (o) => {
      const changes = Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: structuredClone(o[k]) }]));
      Object.assign(store, structuredClone(o));
      if (onChanged) onChanged.fire(changes, name);
    },
    remove: async (keys) => {
      const ks = (Array.isArray(keys) ? keys : [keys]).filter((k) => k in store);
      const changes = Object.fromEntries(ks.map((k) => [k, { oldValue: structuredClone(store[k]) }]));
      for (const k of ks) delete store[k];
      if (onChanged && ks.length) onChanged.fire(changes, name);
    },
  };
}

const EXT_ID = 'xshtestextensionid';

function fakeChrome() {
  const store = {};
  const session = {};
  const alarmTable = {};
  const onChanged = event();
  // `list` holds the user's own tabs: tabs.query returns them and every tab
  // opened for a job that is still open, without URLs (there is no "tabs"
  // permission). `answer(id, msg)` is a tab's reply to tabs.sendMessage; by
  // default no content script is there. A tab in `failRemove` will not close.
  const tabs = { opened: [], removed: [], nextId: 100, onRemoved: event(), list: [], queries: 0, asked: [], failRemove: new Set() };
  tabs.answer = () => Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
  tabs.create = async (info) => {
    const tab = { id: tabs.nextId++, ...info };
    tabs.opened.push(tab);
    return tab;
  };
  tabs.remove = async (id) => {
    if (tabs.failRemove.has(id)) throw new Error(`No tab with id: ${id}.`);
    tabs.removed.push(id);
    tabs.onRemoved.fire(id, {});
  };
  tabs.query = async () => {
    tabs.queries += 1;
    const jobTabs = tabs.opened.filter((t) => !tabs.removed.includes(t.id)).map((t) => ({ id: t.id }));
    return structuredClone([...tabs.list, ...jobTabs]);
  };
  tabs.sendMessage = async (id, msg) => {
    tabs.asked.push(id);
    return tabs.answer(id, msg);
  };
  return {
    store,
    session,
    alarmTable,
    tabs,
    storage: { local: area(store, onChanged, 'local'), session: area(session, null, 'session'), onChanged },
    alarms: {
      get: async (name) => alarmTable[name],
      create: (name, info) => {
        alarmTable[name] = { name, ...info };
      },
      clear: async (name) => {
        delete alarmTable[name];
        return true;
      },
      onAlarm: event(),
    },
    runtime: {
      id: EXT_ID,
      getURL: (path) => `chrome-extension://${EXT_ID}/${path}`,
      onInstalled: event(),
      onStartup: event(),
      onMessage: event(),
    },
  };
}

function loadBackground(responder) {
  const chrome = fakeChrome();
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return responder(url);
  };
  const ctx = vm.createContext({ chrome, fetch, AbortSignal, console, setTimeout, clearTimeout, URL });
  ctx.self = ctx;
  ctx.importScripts = (p) => {
    assert.equal(p, 'lib.js');
    vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  };
  vm.runInContext(src('src/background.js'), ctx, { filename: 'src/background.js' });
  return { chrome, requests };
}

const ok = (body) => ({ ok: true, status: 200, headers: { get: () => 'text/plain' }, text: async () => body });
const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

test('background: install fetches the feed, stores it and schedules a 6-hour alarm', async () => {
  const bg = loadBackground(() => ok('Known_Slop\nfake_slop\n'));
  bg.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.deepEqual(bg.requests.map((r) => r.url), ['https://clankwall.vogel.dev/api/usernames.txt']);
  const rec = bg.chrome.store['xsh:list'];
  assert.deepEqual(rec.handles, ['fake_slop', 'known_slop']);
  assert.equal(rec.lastError, null);
  assert.equal(bg.chrome.alarmTable['xsh-refresh'].periodInMinutes, 360);
});

test('background: a failed or shrunken refresh keeps the stored list', async () => {
  let body = many(369).join('\n');
  let status = 200;
  const bg = loadBackground(() => (status === 200 ? ok(body) : { ok: false, status, headers: { get: () => null }, text: async () => '' }));
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  const fetchedAt = bg.chrome.store['xsh:list'].fetchedAt;
  status = 503;
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(bg.chrome.store['xsh:list'].lastError, 'HTTP 503');
  assert.equal(bg.chrome.store['xsh:list'].fetchedAt, fetchedAt);
  status = 200;
  body = many(10).join('\n');
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.match(bg.chrome.store['xsh:list'].lastError, /shrank from 369 to 10/);
});

test('background: startup refreshes only when due; the popup message forces it', async () => {
  const bg = loadBackground(() => ok('known_slop\n'));
  bg.chrome.store['xsh:list'] = { handles: ['known_slop'], fetchedAt: Date.now(), source: 's' };
  bg.chrome.runtime.onStartup.fire();
  await settle();
  assert.equal(bg.requests.length, 0);
  let reply;
  const keepOpen = bg.chrome.runtime.onMessage.fire({ type: 'xsh:refresh' }, {}, (r) => {
    reply = r;
  });
  assert.deepEqual(keepOpen, [true]);
  await settle();
  assert.equal(bg.requests.length, 1);
  assert.deepEqual({ ...reply }, { ok: true, reason: null, count: 1 });
});

test('background: overlapping triggers share one fetch; a later failure keeps the list', async () => {
  const pending = [];
  const bg = loadBackground(() => new Promise((resolve) => pending.push(resolve)));
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  let reply;
  bg.chrome.runtime.onMessage.fire({ type: 'xsh:refresh' }, {}, (r) => {
    reply = r;
  });
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.requests.length, 1);
  pending[0](ok(many(369).join('\n')));
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(reply.count, 369);
  // Once settled, the next trigger fetches again; its failure keeps the list.
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-refresh' });
  await settle();
  assert.equal(bg.requests.length, 2);
  pending[1]({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(bg.chrome.store['xsh:list'].lastError, 'HTTP 503');
});

test('background: a refresh commits against the list stored now, not the one it started from', async () => {
  const pending = [];
  const bg = loadBackground(() => new Promise((resolve) => pending.push(resolve)));
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  // Another writer stores a newer list while this fetch is in flight.
  bg.chrome.store['xsh:list'] = { handles: many(369), fetchedAt: Date.now(), source: 's', lastAttemptAt: Date.now(), lastError: null, seq: 1 };
  pending[0]({ ok: false, status: 503, headers: { get: () => null }, text: async () => '' });
  await settle();
  assert.equal(bg.chrome.store['xsh:list'].handles.length, 369);
  assert.equal(bg.chrome.store['xsh:list'].lastError, null);
});

test('background: a custom feed URL in settings is used', async () => {
  const bg = loadBackground(() => ok('known_slop\n'));
  bg.chrome.store['xsh:settings'] = { feedUrl: 'https://mirror.example/list.txt' };
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  assert.equal(bg.requests[0].url, 'https://mirror.example/list.txt');
  assert.equal(bg.chrome.store['xsh:list'].source, 'https://mirror.example/list.txt');
});

// ------------------------------------------------------------ muting

const ME = 'startupbros';
const today = () => lib.utcDay(Date.now());

// A worker with a stored list and the given settings, already installed.
async function muteBackground({ handles = ['slop_a', 'slop_b'], settings = { muteEnabled: true, muteAccount: ME }, mutes = null } = {}) {
  const bg = loadBackground(() => ok(handles.join('\n')));
  bg.chrome.store['xsh:list'] = { handles, fetchedAt: Date.now(), source: 's' };
  bg.chrome.store['xsh:settings'] = settings;
  if (mutes) bg.chrome.store['xsh:mutes'] = mutes;
  bg.chrome.runtime.onStartup.fire();
  await settle();
  return bg;
}

const alarm = async (bg, name = 'xsh-mute') => {
  bg.chrome.alarms.onAlarm.fire({ name });
  await settle();
};

function send(bg, msg, tabId) {
  return new Promise((resolve) => {
    const keep = bg.chrome.runtime.onMessage.fire(msg, { tab: { id: tabId } }, resolve);
    if (!keep.includes(true)) resolve(undefined);
  });
}

// Let the next visit happen now instead of 1-3 minutes on.
const due = (bg) => {
  bg.chrome.store['xsh:mutes'].nextAt = 0;
};

const lastTab = (bg) => bg.chrome.tabs.opened.at(-1);

test('background: muting is off by default; no alarm, no tab', async () => {
  const bg = await muteBackground({ settings: {} });
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  assert.equal(bg.chrome.alarmTable['xsh-mute'], undefined);
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
});

test('background: turning muting on sets a 1-minute alarm; turning it off clears it', async () => {
  const bg = await muteBackground({ settings: {} });
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: true, muteAccount: ME } });
  await settle();
  assert.equal(bg.chrome.alarmTable['xsh-mute'].periodInMinutes, 1);
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: false, muteAccount: null } });
  await settle();
  assert.equal(bg.chrome.alarmTable['xsh-mute'], undefined);
});

test('background: one visit opens a background tab, gives it the job once, records the mute and closes the tab', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1);
  const tab = lastTab(bg);
  assert.equal(tab.url, 'https://x.com/slop_a');
  assert.equal(tab.active, false);
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 1);
  assert.ok(bg.chrome.alarmTable['xsh-job-timeout'], 'a timeout alarm backs the job');
  // Another alarm while the job runs opens nothing more.
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1);

  assert.equal(await send(bg, { type: 'xsh:job' }, 999), null, 'any other tab gets no job');
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.equal(job.kind, 'mute');
  assert.equal(job.handle, 'slop_a');
  assert.equal(job.account, ME);
  assert.equal(await send(bg, { type: 'xsh:job' }, tab.id), null, 'a reload of the job tab does not get it again');

  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'muted', toast: '@slop_a has been muted.Undo' } }, tab.id);
  const m = bg.chrome.store['xsh:mutes'];
  assert.equal(m.handles.slop_a.status, 'muted');
  assert.equal(m.handles.slop_a.toast, '@slop_a has been muted.Undo');
  assert.equal(m.handles.slop_a.confirmed, null);
  assert.equal(m.days[today()].mutes, 1);
  assert.deepEqual(m.sinceCheck, ['slop_a']);
  assert.deepEqual(bg.chrome.tabs.removed, [tab.id]);
  assert.deepEqual(bg.chrome.session, {});
  assert.equal(bg.chrome.alarmTable['xsh-job-timeout'], undefined);
  const gap = m.nextAt - Date.now();
  assert.ok(gap > 50000 && gap <= 180000, `next visit 1-3 min away, got ${gap} ms`);
  // The gap holds the next visit back.
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1);
  due(bg);
  await alarm(bg);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_b');
});

test('background: a report from another tab or with a stale id changes nothing', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  const tab = lastTab(bg);
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'muted' } }, 999);
  await send(bg, { type: 'xsh:job-result', result: { id: 'stale', status: 'muted' } }, tab.id);
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a, undefined);
  assert.deepEqual(bg.chrome.tabs.removed, []);
});

test('background: never visits @grok, the allowlist or settled accounts; accounts seen while browsing go first', async () => {
  const bg = await muteBackground({
    handles: ['done_a', 'friend', 'grok', 'slop_b', 'slop_c'],
    settings: { muteEnabled: true, muteAccount: ME, allowlist: 'Friend', showGrok: false },
    mutes: { ...lib.emptyMutes(), handles: { done_a: { status: 'muted', confirmed: true } } },
  });
  await send(bg, { type: 'xsh:sighting', handle: 'human' }, 5); // not listed: ignored
  await send(bg, { type: 'xsh:sighting', handle: 'slop_c' }, 5);
  assert.deepEqual(bg.chrome.store['xsh:mutes'].front, ['slop_c']);
  const visited = [];
  for (let i = 0; i < 4; i++) {
    await alarm(bg);
    const tab = lastTab(bg);
    if (!tab || visited.includes(tab.url)) break;
    visited.push(tab.url);
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'no-post' } }, tab.id);
    due(bg);
  }
  assert.deepEqual(visited, ['https://x.com/slop_c', 'https://x.com/slop_b']);
});

// Planted negative: @grok at its default never enters the queue, by sighting or by list.
test('background: visits a bot only when its row says Mute on X, and extra accounts like listed ones', async () => {
  const bg = await muteBackground({
    handles: ['grok', 'slop_a'],
    settings: { muteEnabled: true, muteAccount: ME, extraList: 'extra_a\nfriend', allowlist: 'friend', bots: { askperplexity: 'mute', bot: 'hide' } },
  });
  for (const h of ['grok', 'bot', 'friend', 'extra_a']) await send(bg, { type: 'xsh:sighting', handle: h }, 5);
  assert.deepEqual(bg.chrome.store['xsh:mutes'].front, ['extra_a']);
  const visited = [];
  for (let i = 0; i < 6; i++) {
    await alarm(bg);
    const tab = lastTab(bg);
    if (!tab || visited.includes(tab.url)) break;
    visited.push(tab.url);
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'no-post' } }, tab.id);
    due(bg);
  }
  assert.deepEqual(visited, ['https://x.com/extra_a', 'https://x.com/slop_a', 'https://x.com/askperplexity']);
});

test('background: after 5 mutes it checks settings/muted/all; a mute missing there stops the day', async () => {
  const five = ['m1', 'm2', 'm3', 'm4', 'm5'];
  const handles = Object.fromEntries(five.map((h) => [h, { status: 'muted', confirmed: null }]));
  const bg = await muteBackground({
    handles: [...five, 'slop_z'],
    mutes: { ...lib.emptyMutes(), handles, sinceCheck: five, days: { [today()]: { mutes: 5, visits: 5, stopped: null } } },
  });
  await alarm(bg);
  const tab = lastTab(bg);
  assert.equal(tab.url, 'https://x.com/settings/muted/all');
  assert.equal(tab.active, false);
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 5, 'a check is not a profile visit');
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.equal(job.kind, 'check');
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'checked', rows: ['m5', 'm4', 'm2', 'm1', 'older'] } }, tab.id);
  const m = bg.chrome.store['xsh:mutes'];
  assert.deepEqual(five.map((h) => m.handles[h].confirmed), [true, true, false, true, true]);
  assert.deepEqual(m.sinceCheck, []);
  assert.match(m.days[today()].stopped, /@m3/);
  due(bg);
  await alarm(bg);
  assert.equal(bg.chrome.tabs.opened.length, 1, 'stopped for the day: slop_z waits');
});

test('background: at the daily caps it only finishes a pending check', async () => {
  let bg = await muteBackground({ mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 25, visits: 25, stopped: null } } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
  bg = await muteBackground({ mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 3, visits: 50, stopped: null } } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
  bg = await muteBackground({
    mutes: {
      ...lib.emptyMutes(),
      handles: { m1: { status: 'muted', confirmed: null } },
      sinceCheck: ['m1'],
      days: { [today()]: { mutes: 25, visits: 30, stopped: null } },
    },
  });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened.map((t) => t.url), ['https://x.com/settings/muted/all']);
});

test('background: a tab that never answers is closed after 90 s, retried after the untried accounts, and left alone after a second failure', async () => {
  const bg = await muteBackground();
  const timeOut = async (attempt) => {
    await alarm(bg);
    const tab = lastTab(bg);
    assert.equal(tab.url, 'https://x.com/slop_a');
    bg.chrome.session['xsh:job'].startedAt -= 91000;
    await alarm(bg, 'xsh-job-timeout');
    assert.ok(bg.chrome.tabs.removed.includes(tab.id));
    const e = bg.chrome.store['xsh:mutes'].handles.slop_a;
    assert.equal(e.attempts, attempt);
    assert.equal(e.status, attempt === 1 ? 'error' : 'failed');
    due(bg);
  };
  await timeOut(1);
  // slop_b has not been tried yet, so it goes before slop_a's retry.
  await alarm(bg);
  const b = lastTab(bg);
  assert.equal(b.url, 'https://x.com/slop_b');
  const job = await send(bg, { type: 'xsh:job' }, b.id);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'already' } }, b.id);
  due(bg);
  await timeOut(2);
  await alarm(bg);
  // No fourth tab: slop_a failed twice and slop_b answered, so nothing is left to visit.
  assert.equal(bg.chrome.tabs.opened.length, 3, 'no new tab: nothing is left to visit');
  assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].mutes, 0);
});

test('background: closing the job tab counts as an error; turning muting off mid-job drops the job', async () => {
  let bg = await muteBackground();
  await alarm(bg);
  await bg.chrome.tabs.remove(lastTab(bg).id);
  await settle();
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a.status, 'error');
  assert.match(bg.chrome.store['xsh:mutes'].handles.slop_a.reason, /closed/);

  bg = await muteBackground();
  await alarm(bg);
  const tab = lastTab(bg);
  await bg.chrome.storage.local.set({ 'xsh:settings': { muteEnabled: false, muteAccount: null } });
  await alarm(bg, 'xsh-job-timeout');
  assert.ok(bg.chrome.tabs.removed.includes(tab.id));
  assert.deepEqual(bg.chrome.session, {});
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a, undefined);
});

// Planted negatives: a settings change while the job's tab loads (before it
// claims the job) or waits for a post (after) stops the click.
test('background: a job whose account stops being eligible is dropped at the claim or just before the click', async () => {
  const base = { muteEnabled: true, muteAccount: ME, bots: { askperplexity: 'mute' } };
  const changes = [
    { ...base, bots: { askperplexity: 'show' } },
    { ...base, bots: { askperplexity: 'hide' } },
    { ...base, allowlist: 'AskPerplexity' },
    { ...base, muteAccount: 'someone_else' },
  ];
  for (const when of ['claim', 'click']) {
    for (const next of changes) {
      const bg = await muteBackground({ handles: [], settings: base });
      await alarm(bg);
      const tab = lastTab(bg);
      assert.equal(tab.url, 'https://x.com/askperplexity');
      let job = null;
      if (when === 'click') {
        job = await send(bg, { type: 'xsh:job' }, tab.id);
        assert.equal(job.handle, 'askperplexity');
        assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, 999), false, 'another tab is told no');
        assert.equal(await send(bg, { type: 'xsh:job-go', id: 'stale' }, tab.id), false, 'a stale id is told no');
        assert.deepEqual(bg.chrome.tabs.removed, [], 'neither drops the job');
      }
      await bg.chrome.storage.local.set({ 'xsh:settings': next });
      await settle();
      if (when === 'claim') assert.equal(await send(bg, { type: 'xsh:job' }, tab.id), null, JSON.stringify(next));
      else assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), false, JSON.stringify(next));
      assert.deepEqual(bg.chrome.tabs.removed, [tab.id]);
      assert.deepEqual(bg.chrome.session, {});
      assert.equal(bg.chrome.alarmTable['xsh-job-timeout'], undefined);
      const m = bg.chrome.store['xsh:mutes'];
      assert.equal(m.handles.askperplexity, undefined, 'dropped unrecorded');
      assert.equal(m.days[today()].visits, 1, 'the visit stays counted');
    }
  }
});

test('background: the click is confirmed while nothing has changed, once the job is claimed', async () => {
  const bg = await muteBackground();
  await alarm(bg);
  const tab = lastTab(bg);
  assert.equal(await send(bg, { type: 'xsh:job-go', id: 'any' }, tab.id), false, 'not before the claim');
  const job = await send(bg, { type: 'xsh:job' }, tab.id);
  assert.equal(await send(bg, { type: 'xsh:job-go', id: job.id }, tab.id), true);
  assert.deepEqual(bg.chrome.tabs.removed, []);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'muted' } }, tab.id);
  assert.equal(bg.chrome.store['xsh:mutes'].handles.slop_a.status, 'muted');
});

test('background: a wrong-account or login report stops muting for the day', async () => {
  for (const status of ['wrong-account', 'login']) {
    const bg = await muteBackground();
    await alarm(bg);
    const tab = lastTab(bg);
    const job = await send(bg, { type: 'xsh:job' }, tab.id);
    await send(bg, { type: 'xsh:job-result', result: { id: job.id, status, reason: 'x' } }, tab.id);
    const m = bg.chrome.store['xsh:mutes'];
    assert.match(m.days[today()].stopped, new RegExp(status));
    assert.equal(m.handles.slop_a, undefined, 'the account is tried again another day');
    due(bg);
    await alarm(bg);
    assert.equal(bg.chrome.tabs.opened.length, 1);
  }
});

test('userscript build: header grants and connects only what it uses', () => {
  const us = buildUserscript();
  assert.match(us, /^\/\/ ==UserScript==/);
  assert.match(us, /@connect {6}clankwall\.vogel\.dev/);
  assert.doesNotMatch(us, /@grant\s+none/);
  assert.doesNotMatch(us, /unsafeWindow/);
});

// Managers install an update only when @version rises, and fetch it from @updateURL.
test('userscript build: carries the manifest version, MIT licence and update URLs', () => {
  const us = buildUserscript();
  const version = JSON.parse(src('manifest.json')).version;
  const raw = 'https://raw.githubusercontent.com/StartupBros-com/human-replies-only/main/dist/x-slop-hide.user.js';
  assert.match(us, new RegExp(`^// @version {6}${version.replace(/\./g, '\\.')}$`, 'm'));
  assert.equal(JSON.parse(src('package.json')).version, version);
  assert.match(us, /^\/\/ @license {6}MIT$/m);
  assert.ok(us.includes(`// @downloadURL  ${raw}\n`));
  assert.ok(us.includes(`// @updateURL    ${raw}\n`));
});

// Run the built userscript in a VM with in-memory GM_* storage. Tabs that
// share `values` share storage, as they do under a userscript manager.
function loadUserscript({
  values = {},
  respond,
  cells = [post({ author: 'known_slop', status: '1' }), post({ author: 'realhuman', status: '2' })],
  pathname = '/home',
}) {
  const { window, document, MutationObserver } = parseHTML(page(cells));
  const requests = [];
  const menu = {};
  const intervals = [];
  let answer = () => null;
  const ctx = vm.createContext({
    window,
    document,
    MutationObserver,
    location: { pathname },
    console,
    prompt: (q, d) => answer(q, d),
    setInterval: (fn, ms) => intervals.push({ fn, ms }),
    GM_getValue: (k, d) => (k in values ? structuredClone(values[k]) : d),
    GM_setValue: (k, v) => {
      values[k] = structuredClone(v);
    },
    GM_registerMenuCommand: (name, fn) => {
      menu[name] = fn;
    },
    GM_addValueChangeListener: () => {},
    GM_xmlhttpRequest: (req) => {
      requests.push(req);
      respond(req);
    },
  });
  vm.runInContext(buildUserscript(), ctx, { filename: 'dist/x-slop-hide.user.js' });
  // `prompt(fn)` sets how the page's prompt() answers.
  return { window, document, values, requests, menu, intervals, prompt: (fn) => (answer = fn) };
}

const gmOk = (body) => (req) =>
  setTimeout(() => req.onload({ status: 200, responseHeaders: 'content-type: text/plain\r\n', responseText: body }), 0);

test('userscript: fetches via GM_xmlhttpRequest, caches, and hides listed authors', async () => {
  const us = loadUserscript({ respond: gmOk('known_slop\n') });
  await settle();
  assert.equal(us.requests.length, 1);
  assert.equal(us.requests[0].url, 'https://clankwall.vogel.dev/api/usernames.txt');
  assert.equal(us.requests[0].anonymous, true);
  assert.deepEqual(us.values['xsh:list'].handles, ['known_slop']);
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual([hidden('1'), hidden('2')], [true, false]);
  assert.deepEqual(Object.keys(us.menu), [
    'Pause / resume hiding',
    'Show / hide @grok',
    'Refresh list now',
    'Edit always-show list',
    'Edit extra accounts to hide',
    'Show or hide a bot',
    'Hide / show posts that tag a hidden bot',
  ]);
});

test("userscript: the @grok menu item flips @grok's row and the page follows", async () => {
  const us = loadUserscript({
    respond: gmOk('known_slop\ngrok\n'),
    cells: [post({ author: 'grok', status: '1' }), post({ author: 'known_slop', status: '2' })],
  });
  await settle();
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual([hidden('1'), hidden('2')], [true, true]);
  us.menu['Show / hide @grok']();
  assert.equal(us.values['xsh:settings'].bots.grok, 'show');
  assert.deepEqual([hidden('1'), hidden('2')], [false, true]);
  us.menu['Show / hide @grok']();
  assert.equal(us.values['xsh:settings'].bots.grok, 'hide');
  assert.deepEqual([hidden('1'), hidden('2')], [true, true]);
});

test("userscript: a 0.3.0 user's showGrok is read as Show, and the menu flips it to Hide without deleting it", async () => {
  const us = loadUserscript({
    values: { 'xsh:settings': { showGrok: true } },
    respond: gmOk('known_slop\ngrok\n'),
    cells: [post({ author: 'grok', status: '1' })],
  });
  await settle();
  const hidden = () => us.document.querySelector('[data-fixture="1"]').hasAttribute('data-xsh-hidden');
  assert.equal(hidden(), false);
  us.menu['Show / hide @grok']();
  assert.deepEqual(us.values['xsh:settings'], { showGrok: true, bots: { grok: 'hide' } });
  assert.equal(hidden(), true);
});

test('userscript: the bot, extra-accounts and tag menus save what the popup saves', async () => {
  const answers = [];
  const us = loadUserscript({
    respond: gmOk('known_slop\n'),
    cells: [
      post({ author: 'askperplexity', status: '1' }),
      post({ author: 'extra_a', status: '2' }),
      post({ author: 'rando', mention: 'askperplexity', status: '3' }),
      meLink('StartupBros'), // tag hiding waits for the logged-in account
    ],
  });
  await settle();
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual(['1', '2', '3'].map(hidden), [false, false, false]);
  us.prompt((q) => {
    answers.push(q);
    return 'AskPerplexity hide';
  });
  us.menu['Show or hide a bot']();
  assert.match(answers[0], /Now: @grok show, @AskPerplexity show, /);
  assert.deepEqual(us.values['xsh:settings'].bots, { askperplexity: 'hide' });
  us.prompt(() => 'askperplexity mute'); // the userscript cannot mute: ignored
  us.menu['Show or hide a bot']();
  us.prompt(() => 'someone hide'); // not a roster bot: ignored
  us.menu['Show or hide a bot']();
  assert.deepEqual(us.values['xsh:settings'].bots, { askperplexity: 'hide' });
  us.prompt(() => '@Extra_A, bad handle!!');
  us.menu['Edit extra accounts to hide']();
  assert.equal(us.values['xsh:settings'].extraList, 'bad\nextra_a');
  assert.deepEqual(['1', '2', '3'].map(hidden), [true, true, false]);
  us.menu['Hide / show posts that tag a hidden bot']();
  assert.equal(us.values['xsh:settings'].hideBotMentions, true);
  assert.deepEqual(['1', '2', '3'].map(hidden), [true, true, true]);
});

// Run the real popup.js against popup.html with an in-memory chrome.storage.
// `globals` adds to or replaces what the page sees (URL, Blob).
function loadPopup(store, globals = {}, tabs = null) {
  const { window, document } = parseHTML(src('src/popup.html'));
  const chrome = fakeChrome();
  Object.assign(chrome.store, structuredClone(store));
  chrome.tabs = tabs || { query: async () => [], sendMessage: async () => null };
  chrome.runtime.sendMessage = async () => ({ ok: true });
  const ctx = vm.createContext({ window, document, chrome, console, URL, ...globals });
  vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  vm.runInContext(src('src/popup.js'), ctx, { filename: 'src/popup.js' });
  return { window, document, chrome };
}

// The option a bot's row shows, read the way popup.js sets it.
const rowMode = (p, h) => [...p.document.getElementById(`bot-${h}`).querySelectorAll('option')].find((o) => o.selected)?.value;
function pick(p, h, mode) {
  const sel = p.document.getElementById(`bot-${h}`);
  const opts = [...sel.querySelectorAll('option')];
  for (const o of opts) o.selected = false; // clear first: see setChoice in popup.js
  opts.find((o) => o.value === mode).selected = true;
  sel.dispatchEvent(new p.window.Event('change'));
}

test('popup: one row per bot, showing what applies now, without writing anything', async () => {
  const settings = { allowlist: 'friend\nbot', showGrok: true };
  const p = loadPopup({
    'xsh:list': { handles: ['grok', 'askperplexity'], fetchedAt: Date.now(), source: 'https://clankwall.vogel.dev/api/usernames.txt' },
    'xsh:settings': settings,
  });
  await settle();
  const rows = [...p.document.querySelectorAll('#bots .bot')];
  assert.deepEqual(
    rows.map((r) => r.querySelector('a').getAttribute('href')),
    ['grok', 'AskPerplexity', 'pangram', 'bot', 'threadreaderapp', 'UnrollHelper'].map((n) => `https://x.com/${n}`),
  );
  assert.deepEqual(
    lib.BOTS.map((b) => rowMode(p, b.handle)),
    ['show', 'hide', 'show', 'show', 'show', 'show'],
    'showGrok reads as Show; a listed bot hides; the rest follow the list',
  );
  assert.equal(p.document.getElementById('bot-bot').disabled, true, 'Always-show locks the row to Show');
  assert.equal(p.document.getElementById('bot-bot-why').hidden, false, 'a locked row says why in text, not only in a tooltip');
  assert.equal(p.document.getElementById('bot-bot-why').textContent, 'Locked to Show: it is in Always show.');
  assert.equal(p.document.getElementById('bot-bot').getAttribute('aria-describedby'), 'bot-bot-why');
  assert.equal(p.document.getElementById('bot-grok-why').hidden, true);
  assert.equal(p.document.getElementById('bot-grok').hasAttribute('aria-describedby'), false);
  assert.equal(p.document.getElementById('bot-grok').disabled, false);
  assert.equal(p.document.getElementById('mentions').checked, false);
  assert.equal(p.document.getElementById('botsSum').textContent, 'Show 5 · Hide here 1 · Mute on X 0', 'the folded section counts its rows');
  assert.equal(p.document.getElementById('listsSum').textContent, 'Always show 2 · Also hide 0');
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'rendering saves nothing');
});

test("popup: changing a bot's row saves only that bot, keeping other settings and bots", async () => {
  const p = loadPopup({
    'xsh:list': { handles: ['grok'], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { allowlist: 'friend', muteEnabled: true, muteAccount: 'startupbros', showGrok: true, bots: { bot: 'hide' } },
  });
  await settle();
  pick(p, 'askperplexity', 'mute');
  await settle();
  pick(p, 'grok', 'hide');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], {
    allowlist: 'friend',
    muteEnabled: true,
    muteAccount: 'startupbros',
    showGrok: true,
    bots: { bot: 'hide', askperplexity: 'mute', grok: 'hide' },
  });
  assert.equal(rowMode(p, 'grok'), 'hide', 'a saved row wins over showGrok');
  assert.equal(rowMode(p, 'askperplexity'), 'mute');
  assert.equal(p.document.getElementById('botsSum').textContent, 'Show 3 · Hide here 2 · Mute on X 1');
});

test('popup: Save writes both boxes in one write; the tag box saves hideBotMentions', async () => {
  const p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': { paused: false } });
  await settle();
  const writes = [];
  const set = p.chrome.storage.local.set;
  p.chrome.storage.local.set = (o) => {
    writes.push(structuredClone(o));
    return set(o);
  };
  p.document.getElementById('allow').value = 'Friend, @pal';
  p.document.getElementById('extra').value = '@Extra_B extra_a not!valid';
  p.document.getElementById('save').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(writes.length, 1);
  assert.deepEqual(p.chrome.store['xsh:settings'], { paused: false, allowlist: 'friend\npal', extraList: 'extra_a\nextra_b' });
  assert.equal(p.document.getElementById('extra').value, 'extra_a\nextra_b');
  assert.equal(p.document.getElementById('listsSum').textContent, 'Always show 2 · Also hide 2');
  const box = p.document.getElementById('mentions');
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.equal(p.chrome.store['xsh:settings'].hideBotMentions, true);
  assert.equal(box.checked, true);
});

test('popup: muting binds to the account logged in on this tab, and refuses without one', async () => {
  const p = loadPopup({ 'xsh:list': { handles: ['slop_a'], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': { allowlist: 'friend' } });
  await settle();
  const box = p.document.getElementById('mute');
  assert.equal(box.checked, false);
  assert.equal(p.document.getElementById('muteHint').hidden, false, 'off: the Always-show hint');
  assert.equal(p.document.getElementById('muteOn').hidden, true);
  // No x.com tab: stays off and says why.
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.equal(box.checked, false);
  assert.equal(p.document.getElementById('muteErr').hidden, false);
  assert.equal(p.chrome.store['xsh:settings'].muteEnabled, undefined);
  // An x.com tab logged in as @startupbros.
  p.chrome.tabs.query = async () => [{ id: 7 }];
  p.chrome.tabs.sendMessage = async () => ({ me: 'startupbros', paused: false, hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 0 });
  box.checked = true;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { allowlist: 'friend', muteEnabled: true, muteAccount: 'startupbros' });
  assert.equal(p.document.getElementById('muteHint').hidden, true);
  assert.equal(p.document.getElementById('muteOn').hidden, false);
  assert.equal(p.document.getElementById('muteWho').textContent, 'Muting as @startupbros');
  assert.equal(p.document.getElementById('muteToday').textContent, 'Today (UTC): 0 of 25 mutes, 0 of 50 visits');
  box.checked = false;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { allowlist: 'friend', muteEnabled: false, muteAccount: null });
  assert.equal(p.document.getElementById('muteHint').hidden, false);
  assert.equal(p.document.getElementById('muteOn').hidden, true);
});

test("popup: shows today's counts, the totals and why muting stopped", async () => {
  const p = loadPopup({
    'xsh:list': { handles: ['a'], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' },
    'xsh:mutes': {
      ...lib.emptyMutes(),
      handles: {
        a: { status: 'muted', confirmed: true },
        b: { status: 'muted', confirmed: false },
        c: { status: 'already' },
        d: { status: 'followed' },
        e: { status: 'no-post' },
      },
      days: { [lib.utcDay(Date.now())]: { mutes: 2, visits: 5, stopped: 'not on settings/muted/all after muting: @b' } },
    },
  });
  await settle();
  assert.equal(p.document.getElementById('mute').checked, true);
  assert.equal(p.document.getElementById('muteWho').textContent, 'Muting as @startupbros');
  assert.equal(p.document.getElementById('muteToday').textContent, 'Today (UTC): 2 of 25 mutes, 5 of 50 visits');
  assert.equal(p.document.getElementById('muteBar').getAttribute('value'), '2');
  assert.equal(p.document.getElementById('muteBar').getAttribute('max'), '25');
  assert.equal(
    p.document.getElementById('muteTotals').textContent,
    'So far: 2 muted (1 seen on your muted list, 1 not found there), 1 already muted, 1 you follow, 1 skipped.',
  );
  assert.equal(p.document.getElementById('muteStop').hidden, false);
  assert.equal(p.document.getElementById('muteStop').textContent, 'Stopped for today: not on settings/muted/all after muting: @b');
  assert.equal(p.document.getElementById('muteNext').hidden, false, 'a stopped day says when muting starts again');
  assert.match(p.document.getElementById('muteNext').textContent, /^Muting starts again on the next UTC day\. What each reason means$/);
  assert.equal(p.document.querySelector('#muteNext a').getAttribute('href'), 'https://github.com/StartupBros-com/human-replies-only#muting-stopped-for-today');
});

test('popup: the bar stops at the cap, and a stop line from today hides while muting is off', async () => {
  const day = lib.utcDay(Date.now());
  const over = loadPopup({
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' },
    'xsh:mutes': { ...lib.emptyMutes(), days: { [day]: { mutes: 26, visits: 30 } } },
  });
  await settle();
  assert.equal(over.document.getElementById('muteBar').getAttribute('value'), '25');
  assert.equal(over.document.getElementById('muteToday').textContent, 'Today (UTC): 26 of 25 mutes, 30 of 50 visits');
  const off = loadPopup({
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: false },
    'xsh:mutes': { ...lib.emptyMutes(), days: { [day]: { mutes: 25, visits: 31, stopped: 'daily mute cap reached' } } },
  });
  await settle();
  assert.equal(off.document.getElementById('muteStop').hidden, true);
  assert.equal(off.document.getElementById('muteNext').hidden, true);
  assert.equal(off.document.getElementById('muteOn').hidden, true);
  assert.equal(off.document.getElementById('muteHint').hidden, false);
});

test('popup and manifest: every icon file they name exists', () => {
  const m = JSON.parse(src('manifest.json'));
  const paths = [...Object.values(m.icons), ...Object.values(m.action.default_icon)];
  assert.ok(paths.length >= 4);
  for (const p of paths) assert.ok(existsSync(join(root, p)), p);
  const { document } = parseHTML(src('src/popup.html'));
  const img = document.querySelector('header img').getAttribute('src');
  assert.ok(existsSync(join(root, 'src', img)), img);
});

// The muting warning as the popup must show it whenever it shows the muting switch.
const WARNING =
  `X's rules forbid "scripting the X website" and say: "The use of these techniques may result in the permanent suspension of your account." Muting scripts x.com. A lower daily number lowers the risk; no number makes it allowed.`;
// Nothing between the element and the page hides it: no hidden ancestor, no closed fold.
const shownInDom = (el) => {
  for (let e = el; e; e = e.parentElement) if (e.hidden || (e.tagName === 'DETAILS' && !e.hasAttribute('open'))) return false;
  return true;
};

test('popup: the X rules warning is shown in full, outside every fold, beside the muting switch, on or off', async () => {
  const day = lib.utcDay(Date.now());
  const states = {
    off: { 'xsh:settings': {} },
    on: { 'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' } },
    stopped: {
      'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros' },
      'xsh:mutes': { ...lib.emptyMutes(), days: { [day]: { mutes: 1, visits: 2, stopped: '@a: login (x.com shows a login button)' } } },
    },
  };
  for (const [name, seed] of Object.entries(states)) {
    const p = loadPopup({ 'xsh:list': { handles: ['a'], fetchedAt: Date.now(), source: 's' }, ...seed });
    await settle();
    const w = p.document.getElementById('muteWarn');
    assert.ok(w, `${name}: the warning is there`);
    assert.equal(w.textContent.replace(/\s+/g, ' ').trim(), WARNING, `${name}: every word of it`);
    // A boolean, not the element: a failed assert carrying a DOM node hangs the runner.
    assert.equal(Boolean(w.closest('details')), false, `${name}: not inside a fold`);
    assert.ok(shownInDom(w), `${name}: nothing hides it`);
    assert.ok(shownInDom(p.document.getElementById('mute')), `${name}: the switch shows`);
    assert.equal(p.document.getElementById('mute').getAttribute('aria-describedby'), 'muteWarn', `${name}: read out with the switch`);
  }
});

test('popup: every control has a name a screen reader reads, and the page has one h1', async () => {
  const p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': {} });
  await settle();
  const d = p.document;
  const nameOf = (el) => {
    const aria = el.getAttribute('aria-label');
    if (aria) return aria;
    const wrap = el.closest('label');
    if (wrap) return wrap.textContent;
    const lab = el.id && d.querySelector(`label[for="${el.id}"]`);
    if (lab) return lab.textContent;
    return ['INPUT', 'SELECT', 'TEXTAREA'].includes(el.tagName) ? '' : el.textContent;
  };
  const controls = [...d.querySelectorAll('a[href], button, input, select, textarea, summary')];
  assert.ok(controls.length >= 30, `found ${controls.length} controls`);
  for (const el of controls) assert.ok(nameOf(el).replace(/\s+/g, ' ').trim(), `${el.tagName.toLowerCase()}#${el.id} has no name`);
  assert.equal(d.querySelectorAll('h1').length, 1);
});

test('popup: each message it writes later sits in a live region', () => {
  const { document } = parseHTML(src('src/popup.html'));
  const region = (id) => document.getElementById(id).parentElement.closest('[role]')?.getAttribute('role');
  assert.deepEqual(
    ['err', 'muteErr', 'muteStop', 'muteNext', 'labelsMsg'].map(region),
    ['status', 'alert', 'status', 'status', 'status'],
  );
});

test('popup: the tab line leads with the count, says when hiding is paused, and points at x.com elsewhere', async () => {
  const list = { handles: ['a', 'b'], fetchedAt: Date.now(), source: 'https://clankwall.vogel.dev/api/usernames.txt' };
  const tab = (o) => ({
    query: async () => [{ id: 3 }],
    sendMessage: async () => ({ me: 'm', paused: false, hiddenPosts: 14, hiddenAuthors: [...'abcdefghi'], hiddenNow: 3, hiddenMentions: 2, ...o }),
  });
  const read = (p) => ({
    tab: p.document.getElementById('tab').textContent,
    more: p.document.getElementById('tabMore').hidden ? null : p.document.getElementById('tabMore').textContent,
  });
  let p = loadPopup({ 'xsh:list': list, 'xsh:settings': {} }, {}, tab({}));
  await settle();
  assert.deepEqual(read(p), { tab: '14 posts hidden on this tab', more: 'From 9 accounts. Plus 2 posts that tag a bot. 3 on screen now.' });
  assert.equal(p.document.querySelector('#tab .num').textContent, '14', 'the count is its own element, drawn large');
  assert.equal(p.document.getElementById('list').textContent, '2 accounts on the list');
  assert.equal(p.document.getElementById('listAge').textContent, 'From clankwall.vogel.dev, updated just now');
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': {} }, {}, tab({ hiddenPosts: 1, hiddenAuthors: ['a'], hiddenNow: 1, hiddenMentions: 1 }));
  await settle();
  assert.deepEqual(read(p), { tab: '1 post hidden on this tab', more: 'From 1 account. Plus 1 post that tags a bot. 1 on screen now.' });
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': {} }, {}, tab({ hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 0, hiddenMentions: 0 }));
  await settle();
  assert.deepEqual(read(p), { tab: '0 posts hidden on this tab', more: null });
  // Only tag hiding hid anything: its count leads, not a 0.
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': {} }, {}, tab({ hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 2, hiddenMentions: 2 }));
  await settle();
  assert.deepEqual(read(p), { tab: '2 posts hidden on this tab', more: 'Each one tags a bot. 2 on screen now.' });
  assert.equal(p.document.querySelector('#tab .num').textContent, '2');
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': {} }, {}, tab({ hiddenPosts: 0, hiddenAuthors: [], hiddenNow: 1, hiddenMentions: 1 }));
  await settle();
  assert.deepEqual(read(p), { tab: '1 post hidden on this tab', more: 'It tags a bot. 1 on screen now.' });
  // An x.com tab reports pause; another tab still points at x.com, as in 0.6.1.
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { paused: true } }, {}, tab({ paused: true }));
  await settle();
  assert.deepEqual(read(p), { tab: 'Hiding is paused', more: 'Turn off Pause hiding to hide posts again.' });
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': { paused: true } });
  await settle();
  assert.deepEqual(read(p), { tab: 'Open x.com in this tab to see what was hidden.', more: 'If it is already open, reload the tab.' });
  p = loadPopup({ 'xsh:list': list, 'xsh:settings': {} });
  await settle();
  // No answer from the tab: another site, or an x.com tab opened before install.
  assert.deepEqual(read(p), { tab: 'Open x.com in this tab to see what was hidden.', more: 'If it is already open, reload the tab.' });
  p = loadPopup({ 'xsh:list': { handles: [] }, 'xsh:settings': {} });
  await settle();
  assert.equal(p.document.getElementById('listAge').textContent, 'From clankwall.vogel.dev, not fetched yet');
});

test('popup: a failed refresh says the previous list is still in use only when there is one', async () => {
  const at = Date.now();
  let p = loadPopup({ 'xsh:list': { handles: ['a'], fetchedAt: at - 3600e3, lastAttemptAt: at, lastError: 'HTTP 503', source: 's' }, 'xsh:settings': {} });
  await settle();
  assert.equal(p.document.getElementById('err').hidden, false);
  assert.equal(p.document.getElementById('err').textContent, 'Last refresh failed (just now): HTTP 503. Still using the previous list.');
  // The first fetch failed: there is no previous list to fall back on.
  p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: 0, lastAttemptAt: at, lastError: 'HTTP 503', source: 's' }, 'xsh:settings': {} });
  await settle();
  assert.equal(p.document.getElementById('err').textContent, 'Last refresh failed (just now): HTTP 503.');
  assert.equal(p.document.getElementById('list').textContent, '0 accounts on the list');
});

test('popup: Refresh list now stays enabled (aria-disabled, not disabled) while it works, and two clicks send one refresh', async () => {
  const p = loadPopup({ 'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' }, 'xsh:settings': {} });
  await settle();
  const sent = [];
  let release = null;
  p.chrome.runtime.sendMessage = (m) => {
    sent.push(m.type);
    return new Promise((r) => {
      release = () => r({ ok: true });
    });
  };
  const btn = p.document.getElementById('refresh');
  btn.dispatchEvent(new p.window.Event('click'));
  btn.dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, ['xsh:refresh']);
  assert.equal(btn.getAttribute('aria-disabled'), 'true');
  assert.equal(btn.disabled, false, 'a disabled button would drop keyboard focus');
  assert.equal(btn.textContent, 'Refreshing…');
  release();
  await settle();
  assert.equal(btn.hasAttribute('aria-disabled'), false);
  assert.equal(btn.textContent, 'Refresh list now');
  btn.dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, ['xsh:refresh', 'xsh:refresh'], 'it can refresh again once the first is done');
  release();
  await settle();
});

test('userscript: has no job channel, so it only hides', async () => {
  const built = buildUserscript();
  assert.match(built, /@description {2}Hides x\.com posts .* Hides only; muting is in the browser extension\./);
  assert.doesNotMatch(src('src/userscript-adapter.js'), /getJob|reportJob/);
});

test('userscript: an older refresh in another tab cannot overwrite a newer list', async () => {
  const values = {};
  const pendingA = [];
  const tabA = loadUserscript({ values, respond: (req) => pendingA.push(req) });
  await settle();
  assert.equal(tabA.requests.length, 1);
  // Tab B opens while A's request is still out, fetches and commits 369 handles.
  loadUserscript({ values, respond: gmOk(many(369).join('\n')) });
  await settle();
  assert.equal(values['xsh:list'].handles.length, 369);
  // A's older request then fails: the newer list stays, with no stale error.
  pendingA[0].onerror();
  await settle();
  assert.equal(values['xsh:list'].handles.length, 369);
  assert.equal(values['xsh:list'].lastError, null);
  // An older success is dropped as well.
  const pendingD = [];
  const shared = { 'xsh:list': { handles: ['a'], fetchedAt: 0, source: 's', seq: 3 } };
  loadUserscript({ values: shared, respond: (req) => pendingD.push(req) });
  await settle();
  shared['xsh:list'] = { handles: many(369), fetchedAt: Date.now(), source: 's', lastAttemptAt: Date.now(), lastError: null, seq: 4 };
  pendingD[0].onload({ status: 200, responseHeaders: 'content-type: text/plain\r\n', responseText: 'onlyone\n' });
  await settle();
  assert.equal(shared['xsh:list'].handles.length, 369);
});

test('userscript: an open tab re-checks on a timer and when it becomes visible', async () => {
  const hour = 60 * 60 * 1000;
  const now = Date.now();
  const values = { 'xsh:list': { handles: ['known_slop'], fetchedAt: now, lastAttemptAt: now, source: 's', lastError: null, seq: 1 } };
  let body = 'known_slop\nnewbot\n';
  const us = loadUserscript({ values, respond: (req) => gmOk(body)(req) });
  await settle();
  assert.equal(us.requests.length, 0);
  assert.equal(us.intervals.length, 1);
  assert.equal(us.intervals[0].ms, 15 * 60 * 1000);
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 0);
  // Seven hours pass with the tab open.
  values['xsh:list'].fetchedAt -= 7 * hour;
  values['xsh:list'].lastAttemptAt -= 7 * hour;
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 1);
  assert.deepEqual(values['xsh:list'].handles, ['known_slop', 'newbot']);
  // Timers were suspended in the background; the tab comes back into view.
  values['xsh:list'].fetchedAt -= 7 * hour;
  values['xsh:list'].lastAttemptAt -= 7 * hour;
  body = 'known_slop\nnewbot\nthird\n';
  Object.defineProperty(us.document, 'visibilityState', { value: 'visible', configurable: true });
  us.document.dispatchEvent(new us.window.Event('visibilitychange'));
  await settle();
  assert.equal(us.requests.length, 2);
  assert.equal(values['xsh:list'].handles.length, 3);
});

test('userscript: a failed refresh is retried after the retry gap, not on every check', async () => {
  const values = {};
  let fail = true;
  const us = loadUserscript({
    values,
    respond: (req) => (fail ? setTimeout(() => req.onerror(), 0) : gmOk('known_slop\n')(req)),
  });
  await settle();
  assert.equal(us.requests.length, 1);
  assert.match(values['xsh:list'].lastError, /network error/);
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 1);
  values['xsh:list'].lastAttemptAt -= 30 * 60 * 1000;
  fail = false;
  us.intervals[0].fn();
  await settle();
  assert.equal(us.requests.length, 2);
  assert.deepEqual(values['xsh:list'].handles, ['known_slop']);
});

test('userscript: committed dist file matches the sources', () => {
  assert.equal(src('dist/x-slop-hide.user.js'), buildUserscript());
});

// ------------------------------------------------------------ daily number

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const muteAt = (muteCap, over = {}) => muteBackground({ settings: { muteEnabled: true, muteAccount: ME, muteCap }, ...over });

test('background: at 25 a day muting never looks for an x.com tab, and a stored number other than 25, 50 or 100 reads as 25', async () => {
  for (const muteCap of [25, undefined, 1000, '100', 0, -1]) {
    const bg = await muteAt(muteCap);
    await alarm(bg);
    assert.equal(bg.chrome.tabs.opened.length, 1, `${muteCap}: visits with no x.com tab open`);
    assert.equal(bg.chrome.tabs.queries, 0, `${muteCap}: never asks the tabs`);
  }
  // 25 mutes done today: a stored 1000 stops there, as 25 does.
  const bg = await muteAt(1000, { mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 25, visits: 25 } } } });
  await alarm(bg);
  assert.deepEqual(bg.chrome.tabs.opened, []);
});

test("background: at 50 or 100 a day, a mute visit waits for an x.com tab of the user's own, and only a true answer counts", async () => {
  for (const cap of [50, 100]) {
    const bg = await muteAt(cap, { mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 30, visits: 40 } } } });
    const t = bg.chrome.tabs;
    await alarm(bg);
    assert.deepEqual(t.opened, [], `${cap}: no tab of the user's own, no visit`);
    assert.equal(t.queries, 1);
    t.list = [{ id: 7 }, { id: 8 }];
    for (const reply of ['true', 1, { present: true }, null, false]) {
      t.answer = (id) => (id === 7 ? reply : Promise.reject(new Error('no content script')));
      await alarm(bg);
      assert.deepEqual(t.opened, [], `${cap}: a reply of ${JSON.stringify(reply)} is not a yes`);
    }
    t.answer = (id) => (id === 8 ? true : Promise.reject(new Error('no content script')));
    t.asked.length = 0;
    await alarm(bg);
    assert.equal(t.opened.length, 1, `${cap}: one tab says yes, so the visit goes ahead past 25 today`);
    assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
    assert.deepEqual([...t.asked].sort(), [7, 8], 'both tabs were asked');
    assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 41);
  }
  // At today's cap there is nothing to ask about.
  const full = await muteAt(50, { mutes: { ...lib.emptyMutes(), days: { [today()]: { mutes: 50, visits: 60 } } } });
  full.chrome.tabs.list = [{ id: 7 }];
  full.chrome.tabs.answer = () => true;
  await alarm(full);
  assert.equal(full.chrome.tabs.queries, 0);
  assert.deepEqual(full.chrome.tabs.opened, []);
});

test('background: the x.com check never counts a job tab, even one that failed to close, skips discarded tabs, and waits 1.5 s for an answer', async () => {
  const bg = await muteAt(50);
  const t = bg.chrome.tabs;
  // Every tab says yes, as a job tab whose page reloaded after its job would.
  t.list = [{ id: 7 }];
  t.answer = () => true;
  t.failRemove.add(100);
  await alarm(bg);
  assert.equal(lastTab(bg).id, 100);
  assert.deepEqual(bg.chrome.session['xsh:jobTabs'], [100]);
  const job = await send(bg, { type: 'xsh:job' }, 100);
  await send(bg, { type: 'xsh:job-result', result: { id: job.id, status: 'already' } }, 100);
  assert.deepEqual(t.removed, [], 'the close failed');
  assert.deepEqual(bg.chrome.session['xsh:jobTabs'], [100], 'so the tab stays on the job-tab list');
  // The user's tab is gone; a discarded one is left, and job tab 100 is still open.
  t.list = [{ id: 8, discarded: true }];
  t.asked.length = 0;
  due(bg);
  await alarm(bg);
  assert.equal(t.opened.length, 1, 'no visit');
  assert.deepEqual(t.asked, [], 'neither the job tab nor the discarded tab is asked');
  // A tab that answers after 2 s is past the wait: checked after its late yes.
  t.list = [{ id: 9 }];
  t.answer = (id) => (id === 9 ? sleep(2000).then(() => true) : true);
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
  await sleep(2300);
  await settle();
  assert.equal(t.opened.length, 1, 'no answer within 1.5 s counts as no, and a later yes is ignored');
  // One that answers after 0.8 s is in time.
  t.answer = (id) => (id === 9 ? sleep(800).then(() => true) : true);
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
  await sleep(1000);
  await settle();
  assert.equal(t.opened.length, 2);
  assert.equal(lastTab(bg).url, 'https://x.com/slop_b');
  assert.deepEqual(t.asked, [9, 9], 'only tab 9 was ever asked');
  assert.deepEqual(bg.chrome.session['xsh:jobTabs'], [100, 101]);
});

test("background: the x.com check is asked outside the worker's queue, so a tab that just loaded can ask for its job first", async () => {
  // As content.js does: a tab answers xsh:present only after the worker has
  // answered its xsh:job question, which goes through the worker's queue.
  const bg = await muteAt(100);
  const t = bg.chrome.tabs;
  t.list = [{ id: 7 }];
  t.answer = (id, msg) => (id === 7 && msg.type === 'xsh:present' ? send(bg, { type: 'xsh:job' }, 7).then((job) => !job) : Promise.reject(new Error('no content script')));
  const started = Date.now();
  bg.chrome.alarms.onAlarm.fire({ name: 'xsh-mute' });
  while (!t.opened.length && Date.now() - started < 1400) await sleep(20);
  assert.equal(t.opened.length, 1, 'the visit starts without waiting out the 1.5 s');
  assert.equal(lastTab(bg).url, 'https://x.com/slop_a');
  assert.equal(t.queries, 1);
  assert.equal(bg.chrome.store['xsh:mutes'].days[today()].visits, 1);
});

test('background: at 50 a day with no x.com tab open, a pending check of the muted list still runs', async () => {
  const bg = await muteAt(50, { mutes: { ...lib.emptyMutes(), handles: { slop_a: { status: 'muted', confirmed: null } }, sinceCheck: ['slop_a'] } });
  await alarm(bg);
  assert.equal(bg.chrome.tabs.queries, 1);
  assert.equal(bg.chrome.tabs.opened.length, 1);
  assert.equal(lastTab(bg).url, 'https://x.com/settings/muted/all');
});

// ------------------------------------------------------------ labels

const LABEL_MSG = { type: 'xsh:label', label: 'slop', handle: '@Reply_A', url: '/reply_a/status/2', page: '/op/status/1', text: 'hello' };
const labelKeys = (bg) => Object.keys(bg.chrome.store).filter((k) => k.startsWith('xsh:label:')).sort();
const reply = async (p) => ({ ...(await p) });

function labelBackground({ settings = { labeling: true }, handles = [], source = 's', store = {} } = {}) {
  const bg = loadBackground(() => ok(handles.join('\n')));
  bg.chrome.store['xsh:list'] = { handles, fetchedAt: Date.now(), source };
  bg.chrome.store['xsh:settings'] = settings;
  Object.assign(bg.chrome.store, store);
  return bg;
}

// A message from the popup. Chrome gives it the popup's own address and,
// unless the popup was opened in a tab, no sender.tab.
const POPUP_URL = `chrome-extension://${EXT_ID}/src/popup.html`;
function fromPopup(bg, msg, sender = { id: EXT_ID, url: POPUP_URL }) {
  return new Promise((resolve) => {
    const keep = bg.chrome.runtime.onMessage.fire(msg, sender, resolve);
    if (!keep.includes(true)) resolve(undefined);
  });
}

test('background: a label is refused while labelling is off, and nothing is written', async () => {
  for (const settings of [{}, { labeling: 'true' }, { labeling: false }]) {
    const bg = labelBackground({ settings });
    const before = structuredClone(bg.chrome.store);
    assert.deepEqual(await reply(send(bg, LABEL_MSG, 7)), { ok: false, reason: 'labels are off' });
    assert.deepEqual(bg.chrome.store, before);
  }
});

test('background: Slop saves the record and adds the account to Also hide once; Not slop adds it to Always show; clearing changes neither box', async () => {
  const bg = labelBackground({ settings: { labeling: true, allowlist: 'friend' } });
  const before = Date.now();
  assert.deepEqual(await reply(send(bg, LABEL_MSG, 7)), { ok: true, label: 'slop', added: 'extraList' });
  const rec = bg.chrome.store['xsh:label:2'];
  assert.ok(rec.at >= before && rec.at <= Date.now());
  assert.deepEqual(
    { ...rec, at: 0 },
    {
      at: 0,
      label: 'slop',
      handle: 'reply_a',
      url: 'https://x.com/reply_a/status/2',
      text: 'hello',
      page: 'https://x.com/op/status/1',
      list: null,
      extra: false,
      allow: false,
      hidden: false,
    },
  );
  assert.equal(bg.chrome.store['xsh:labelCount'], 1);
  assert.deepEqual(bg.chrome.store['xsh:settings'], { labeling: true, allowlist: 'friend', extraList: 'reply_a' });
  // The same label from another tab adds and counts nothing more.
  assert.deepEqual(await reply(send(bg, LABEL_MSG, 8)), { ok: true, label: 'slop', added: null });
  assert.equal(bg.chrome.store['xsh:labelCount'], 1);
  assert.equal(bg.chrome.store['xsh:settings'].extraList, 'reply_a');
  // Not slop: into Always show, and still in Also hide.
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, label: 'not_slop' }, 7)), { ok: true, label: 'not_slop', added: 'allowlist' });
  assert.deepEqual(bg.chrome.store['xsh:settings'], { labeling: true, allowlist: 'friend\nreply_a', extraList: 'reply_a' });
  const changed = bg.chrome.store['xsh:label:2'];
  assert.deepEqual([changed.label, changed.extra, changed.allow, changed.hidden], ['not_slop', true, false, true], 'what the boxes held before this label');
  assert.equal(bg.chrome.store['xsh:labelCount'], 1);
  // Clearing deletes the record and leaves both boxes.
  const settings = structuredClone(bg.chrome.store['xsh:settings']);
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, label: null }, 7)), { ok: true, label: null });
  assert.deepEqual(labelKeys(bg), []);
  assert.equal(bg.chrome.store['xsh:labelCount'], 0);
  assert.deepEqual(bg.chrome.store['xsh:settings'], settings);
  // Clearing a label that was never saved changes nothing.
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, label: null, url: '/reply_a/status/3' }, 7)), { ok: true, label: null });
  assert.equal(bg.chrome.store['xsh:labelCount'], 0);
});

test('background: a label records which list had the account and whether its replies hide on that page, and keeps 1,000 characters of text', async () => {
  const bg = labelBackground({ handles: ['slop_x'], source: 'https://clankwall.vogel.dev/api/usernames.txt' });
  await send(bg, { ...LABEL_MSG, handle: 'slop_x', url: '/slop_x/status/5', text: '🚀'.repeat(1200) }, 7);
  const r = bg.chrome.store['xsh:label:5'];
  assert.deepEqual([r.list, r.extra, r.allow, r.hidden], ['clankwall.vogel.dev', false, false, true]);
  assert.equal(Array.from(r.text).length, 1000);
  // On the account's own post page its replies show.
  await send(bg, { ...LABEL_MSG, handle: 'slop_x', url: '/slop_x/status/6', page: '/slop_x/status/4' }, 7);
  assert.equal(bg.chrome.store['xsh:label:6'].hidden, false);
  // A page that is not a post is recorded as none.
  await send(bg, { ...LABEL_MSG, url: '/reply_a/status/7', page: '/home' }, 7);
  assert.equal(bg.chrome.store['xsh:label:7'].page, null);
});

test("background: a label with a bad link, another account's handle or an unknown label is refused and writes nothing", async () => {
  const bg = labelBackground();
  const before = structuredClone(bg.chrome.store);
  const cases = [
    [{ url: '/reply_a' }, 'not a post URL'],
    [{ url: 'https://evil.example/reply_a/status/2' }, 'not a post URL'],
    [{ url: 42 }, 'not a post URL'],
    [{ handle: 'reply_b' }, "not the post's author"],
    [{ handle: 'not a handle!' }, 'not a handle'],
    [{ label: 'maybe' }, 'unknown label'],
    [{ label: undefined }, 'unknown label'],
  ];
  for (const [over, reason] of cases) {
    assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, ...over }, 7)), { ok: false, reason }, JSON.stringify(over));
  }
  assert.deepEqual(bg.chrome.store, before);
});

test('background: at 2,000 labels a new one is refused and a saved one can still change; a count that drifted is recounted', async () => {
  const store = { 'xsh:labelCount': 2000 };
  for (let i = 1; i <= 2000; i++) store[`xsh:label:${i}`] = { at: i, label: 'slop', handle: 'reply_a', url: `https://x.com/reply_a/status/${i}` };
  const bg = labelBackground({ store });
  assert.deepEqual(await reply(send(bg, { ...LABEL_MSG, url: '/reply_a/status/2001' }, 7)), {
    ok: false,
    reason: '2000 labels saved: export and delete them to add more',
  });
  assert.equal(bg.chrome.store['xsh:label:2001'], undefined);
  assert.equal(bg.chrome.store['xsh:settings'].extraList, undefined, 'a refused label adds no one to a box');
  assert.equal((await send(bg, { ...LABEL_MSG, label: 'not_slop', url: '/reply_a/status/5' }, 7)).ok, true);
  assert.equal(bg.chrome.store['xsh:label:5'].label, 'not_slop');
  assert.equal(bg.chrome.store['xsh:labelCount'], 2000);
  // The count says 2,000 but only 3 are stored: the recount lets a new one in.
  for (let i = 4; i <= 2000; i++) delete bg.chrome.store[`xsh:label:${i}`];
  assert.equal((await send(bg, { ...LABEL_MSG, url: '/reply_a/status/2001' }, 7)).ok, true);
  assert.equal(bg.chrome.store['xsh:labelCount'], 4);
  assert.equal(labelKeys(bg).length, 4);
});

test('background: deleting every label works only from the popup and leaves Also hide and Always show as they are', async () => {
  const settings = { labeling: true, extraList: 'slop_x', allowlist: 'friend' };
  const store = { 'xsh:labelCount': 3, 'xsh:mutes': lib.emptyMutes() };
  for (const i of [1, 2, 3]) store[`xsh:label:${i}`] = { at: i, label: 'slop', handle: 'slop_x', url: `https://x.com/slop_x/status/${i}` };
  const bg = labelBackground({ settings, store });
  assert.equal(await send(bg, { type: 'xsh:labels-clear' }, 7), undefined, 'a tab gets no answer');
  const refused = [
    { id: EXT_ID, tab: { id: 7 }, url: 'https://x.com/e2e_op/status/100' },
    { id: EXT_ID, url: 'https://x.com/home' },
    { id: EXT_ID, url: 'chrome-extension://another_extension/src/popup.html' },
    { id: EXT_ID, url: `chrome-extension://${EXT_ID}.evil.example/` },
    { id: EXT_ID },
  ];
  for (const sender of refused) {
    assert.equal(await fromPopup(bg, { type: 'xsh:labels-clear' }, sender), undefined, `refused: ${JSON.stringify(sender)}`);
  }
  assert.equal(labelKeys(bg).length, 3);
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:labels-clear' })), { ok: true, removed: 3 });
  assert.deepEqual(labelKeys(bg), []);
  assert.equal('xsh:labelCount' in bg.chrome.store, false);
  assert.deepEqual(bg.chrome.store['xsh:settings'], settings);
  assert.ok(bg.chrome.store['xsh:mutes'] && bg.chrome.store['xsh:list'], 'nothing else is deleted');
});

test('background: the popup opened in a tab of its own can still delete every label', async () => {
  const store = { 'xsh:labelCount': 2 };
  for (const i of [1, 2]) store[`xsh:label:${i}`] = { at: i, label: 'slop', handle: 'slop_x', url: `https://x.com/slop_x/status/${i}` };
  const bg = labelBackground({ store });
  const sender = { id: EXT_ID, tab: { id: 9 }, url: POPUP_URL };
  assert.deepEqual(await reply(fromPopup(bg, { type: 'xsh:labels-clear' }, sender)), { ok: true, removed: 2 });
  assert.deepEqual(labelKeys(bg), []);
});

// ------------------------------------------------------------ popup: number and labels

const choice = (p, id) => [...p.document.getElementById(id).querySelectorAll('option')].find((o) => o.selected)?.value;
function choose(p, id, value) {
  const sel = p.document.getElementById(id);
  const opts = [...sel.querySelectorAll('option')];
  for (const o of opts) o.selected = false;
  opts.find((o) => o.value === value).selected = true;
  sel.dispatchEvent(new p.window.Event('change'));
}

test('popup: the daily number offers 25, 50 and 100, saves the one picked, and says why none goes higher', async () => {
  const day = lib.utcDay(Date.now());
  const p = loadPopup({
    'xsh:list': { handles: many(250), fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros', muteCap: 100 },
    'xsh:mutes': { ...lib.emptyMutes(), handles: { h0: { status: 'muted', confirmed: true } }, days: { [day]: { mutes: 2, visits: 5 } } },
  });
  await settle();
  const $ = (id) => p.document.getElementById(id);
  assert.deepEqual([...p.document.querySelectorAll('#muteCap option')].map((o) => o.value), ['25', '50', '100']);
  assert.equal(choice(p, 'muteCap'), '100');
  assert.equal($('muteToday').textContent, 'Today (UTC): 2 of 100 mutes, 5 of 200 visits');
  assert.equal($('muteBar').getAttribute('max'), '100');
  assert.equal(
    $('capWhy').textContent,
    'No setting goes above 100: hiding already covers this browser, and muting only adds the X apps. At 100 a day, muting the 249 accounts left takes 3 days.',
  );
  // A boolean, not the element: a failed assert carrying a DOM node hangs the runner.
  assert.equal(Boolean($('capWhy').closest('details')), false, 'the cap note is in view, not inside a fold');
  choose(p, 'muteCap', '50');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { muteEnabled: true, muteAccount: 'startupbros', muteCap: 50 });
  assert.equal(choice(p, 'muteCap'), '50');
  assert.equal($('muteToday').textContent, 'Today (UTC): 2 of 50 mutes, 5 of 100 visits');
  // A stored number that is not offered reads as 25; with nothing left to mute, one sentence.
  const odd = loadPopup({
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { muteEnabled: true, muteAccount: 'startupbros', muteCap: 1000 },
  });
  await settle();
  assert.equal(choice(odd, 'muteCap'), '25');
  assert.equal(odd.document.getElementById('muteToday').textContent, 'Today (UTC): 0 of 25 mutes, 0 of 50 visits');
  assert.equal(odd.document.getElementById('capWhy').textContent, 'No setting goes above 100: hiding already covers this browser, and muting only adds the X apps.');
  assert.equal(odd.chrome.store['xsh:settings'].muteCap, 1000, 'rendering does not rewrite it');
});

test('popup: labels switch on and off, export as JSON lines oldest first, and delete only on a second click', async () => {
  const recs = [3, 1, 2].map((at) => ({
    at,
    label: at === 2 ? 'not_slop' : 'slop',
    handle: `h${at}`,
    url: `https://x.com/h${at}/status/${at}`,
    text: `reply ${at} 🚀`,
  }));
  const store = {
    'xsh:list': { handles: [], fetchedAt: Date.now(), source: 's' },
    'xsh:settings': { extraList: 'h1' },
    'xsh:labelCount': 3,
    'xsh:mutes': lib.emptyMutes(),
  };
  for (const r of recs) store[`xsh:label:${r.at}`] = r;
  const made = [];
  const revoked = [];
  class TestURL extends URL {
    static createObjectURL(blob) {
      made.push(blob);
      return `blob:test/${made.length}`;
    }
    static revokeObjectURL(u) {
      revoked.push(u);
    }
  }
  const p = loadPopup(store, { URL: TestURL, Blob });
  const $ = (id) => p.document.getElementById(id);
  const downloads = [];
  p.document.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && e.target.hasAttribute('download')) downloads.push({ href: e.target.getAttribute('href'), name: e.target.getAttribute('download') });
  });
  const sent = [];
  p.chrome.runtime.sendMessage = async (m) => {
    sent.push(structuredClone(m));
    // What the worker does: delete the labels and the count.
    for (const k of Object.keys(p.chrome.store)) if (k.startsWith('xsh:label:') || k === 'xsh:labelCount') delete p.chrome.store[k];
    return { ok: true, removed: 3 };
  };
  await settle();
  assert.equal($('labelsSum').textContent, 'Off · 3 saved');
  assert.equal($('labeling').checked, false);
  assert.equal($('export').textContent, 'Export labels (3)');
  assert.equal($('export').disabled, false);
  assert.equal($('deleteLabels').textContent, 'Delete all labels');
  assert.equal($('labelsMsg').hidden, true);
  $('labeling').checked = true;
  $('labeling').dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { extraList: 'h1', labeling: true });
  assert.equal($('labelsSum').textContent, 'On · 3 saved');
  // Export.
  $('export').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(made.length, 1);
  assert.equal(made[0].type, 'application/x-ndjson');
  const oldestFirst = [...recs].sort((a, b) => a.at - b.at);
  assert.equal(await made[0].text(), `${oldestFirst.map((r) => JSON.stringify(r)).join('\n')}\n`);
  assert.deepEqual(downloads, [{ href: 'blob:test/1', name: `human-replies-only-labels-${lib.utcDay(Date.now())}.jsonl` }]);
  assert.equal(p.document.querySelectorAll('a[download]').length, 0, 'the link is removed after the click');
  assert.equal($('labelsMsg').hidden, false);
  assert.equal($('labelsMsg').textContent, 'Exported 3 labels.');
  $('export').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(revoked, ['blob:test/1'], "a second export frees the first file's URL");
  // Delete: the first click only arms the button.
  $('deleteLabels').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, []);
  assert.equal($('deleteLabels').textContent, 'Click again to delete 3 labels');
  assert.equal($('deleteLabels').className, 'armed');
  $('deleteLabels').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.deepEqual(sent, [{ type: 'xsh:labels-clear' }]);
  assert.equal($('labelsMsg').textContent, 'Deleted 3 labels.');
  assert.equal($('labelsSum').textContent, 'On · 0 saved');
  assert.equal($('export').disabled, true);
  assert.equal($('deleteLabels').disabled, true);
  assert.equal($('deleteLabels').textContent, 'Delete all labels');
  assert.equal($('deleteLabels').className, '');
  assert.deepEqual(p.chrome.store['xsh:settings'], { extraList: 'h1', labeling: true }, 'the boxes stay');
  // A count with no labels behind it exports nothing; a refused delete says why.
  const q = loadPopup({ 'xsh:list': store['xsh:list'], 'xsh:settings': { labeling: true }, 'xsh:labelCount': 1 }, { URL: TestURL, Blob });
  q.chrome.runtime.sendMessage = async () => ({ ok: false, reason: 'busy' });
  await settle();
  q.document.getElementById('export').dispatchEvent(new q.window.Event('click'));
  await settle();
  assert.equal(q.document.getElementById('labelsMsg').textContent, 'No labels saved yet.');
  assert.equal(made.length, 2, 'no new file');
  q.document.getElementById('deleteLabels').dispatchEvent(new q.window.Event('click'));
  await settle();
  assert.equal(q.document.getElementById('deleteLabels').textContent, 'Click again to delete 1 label');
  q.document.getElementById('deleteLabels').dispatchEvent(new q.window.Event('click'));
  await settle();
  assert.equal(q.document.getElementById('labelsMsg').textContent, 'Not deleted: busy');
  assert.equal(q.document.getElementById('deleteLabels').textContent, 'Delete all labels');
});

test('userscript: never shows label buttons, even with labelling saved as on', async () => {
  const now = Date.now();
  const values = {
    'xsh:list': { handles: ['known_slop'], fetchedAt: now, lastAttemptAt: now, source: 's', lastError: null, seq: 1 },
    'xsh:settings': { labeling: true },
  };
  const cells = [post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2' }), post({ author: 'known_slop', status: '3' })];
  const us = loadUserscript({ values, respond: gmOk('known_slop\n'), cells, pathname: '/op/status/1' });
  await settle();
  assert.ok(us.document.querySelector('[data-fixture="3"]').hasAttribute('data-xsh-hidden'), 'the userscript is running');
  assert.equal(us.document.querySelectorAll('[data-xsh-bar]').length, 0);
  assert.equal(us.document.getElementById('xsh-bar-style') === null, true, 'compared as a boolean: printing a node hangs the run');
  assert.doesNotMatch(src('src/userscript-adapter.js'), /saveLabel|getLabels|subscribeLabels|answerPresent/);
});

// ------------------------------------------------------------------ export and import page

// Run the real settings.js against settings.html. Downloads are recorded
// from the <a download> click, and a picked file is set on the input.
function loadSettings(store) {
  const { window, document } = parseHTML(src('src/settings.html'));
  const chrome = fakeChrome();
  Object.assign(chrome.store, structuredClone(store));
  const made = [];
  class TestURL extends URL {
    static createObjectURL(blob) {
      made.push(blob);
      return `blob:test/${made.length}`;
    }
    static revokeObjectURL() {}
  }
  const downloads = [];
  document.addEventListener('click', (e) => {
    if (e.target.tagName === 'A' && e.target.hasAttribute('download')) downloads.push(e.target.getAttribute('download'));
  });
  const ctx = vm.createContext({ window, document, chrome, console, URL: TestURL, Blob });
  vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  vm.runInContext(src('src/settings.js'), ctx, { filename: 'src/settings.js' });
  const $ = (id) => document.getElementById(id);
  const click = (id) => $(id).dispatchEvent(new window.Event('click'));
  // A `text` of null fails the test if the page reads the file at all.
  const pickFile = (name, text, size) => {
    const f = {
      name,
      size: size === undefined ? Buffer.byteLength(text) : size,
      text: async () => (text === null ? assert.fail('file was read') : text),
    };
    Object.defineProperty($('file'), 'files', { configurable: true, value: [f] });
    $('file').dispatchEvent(new window.Event('change'));
  };
  const changes = () => [...document.querySelectorAll('#changes li')].map((li) => li.textContent);
  return { chrome, document, $, click, pickFile, changes, made, downloads };
}

const LIST = { handles: ['listed', 'grok'], fetchedAt: 1, source: 's' };
const settingsFile = (o) => JSON.stringify({ format: 'x-slop-hide-settings', version: 1, ...o });

test('settings page: export saves only the account boxes, bot choices and tag setting', async () => {
  const settings = {
    allowlist: 'pal',
    extraList: 'spam_b\nspam_a',
    bots: { grok: 'mute' },
    hideBotMentions: true,
    muteEnabled: true,
    muteAccount: 'me_here',
    muteCap: 100,
    feedUrl: 'https://example.com/list.txt',
    paused: true,
    labeling: true,
  };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': settings });
  await settle();
  assert.equal(p.$('have').textContent, 'Now: Always show 1 · Also hide 2 · 1 bot choice saved');
  p.click('exportSettings');
  await settle();
  assert.deepEqual(p.downloads, [`human-replies-only-settings-${lib.utcDay(Date.now())}.json`]);
  assert.equal(p.made[0].type, 'application/json');
  const out = JSON.parse(await p.made[0].text());
  assert.deepEqual(Object.keys(out).sort(), ['alsoHide', 'alwaysShow', 'bots', 'exported', 'format', 'hideBotMentions', 'version']);
  assert.deepEqual([out.alwaysShow, out.alsoHide, out.bots, out.hideBotMentions], [['pal'], ['spam_a', 'spam_b'], { grok: 'mute' }, true]);
  assert.equal(p.$('exportMsg').textContent, 'Exported settings: Always show 1, Also hide 2, 1 bot choice.');
  p.click('exportList');
  await settle();
  assert.equal(p.downloads[1], `human-replies-only-also-hide-${lib.utcDay(Date.now())}.txt`);
  assert.equal(await p.made[1].text(), 'spam_a\nspam_b\n');
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'export writes nothing');
});

test('settings page: Export Also hide as a list is off while Also hide is empty', async () => {
  const p = loadSettings({ 'xsh:settings': { allowlist: 'pal' } });
  await settle();
  assert.equal(p.$('exportList').disabled, true);
  assert.equal(p.$('have').textContent, 'Now: Always show 1 · Also hide 0 · 0 bot choices saved');
});

test('settings page: importing a list previews, writes nothing until Confirm, then adds to Also hide', async () => {
  const settings = { allowlist: 'pal', extraList: 'spam_a', paused: false };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': settings });
  await settle();
  p.pickFile('shared.txt', '# from a friend\n@spam_a\nspam_b\nPal\n');
  await settle();
  assert.equal(p.$('preview').hidden, false);
  assert.equal(p.$('fileKind').textContent, 'shared.txt: a list of 3 handles, for Also hide');
  assert.deepEqual(p.changes(), ['Also hide gains 2 accounts: @pal, @spam_b.', '@pal will stay shown, because Always show has it.']);
  assert.equal(p.$('muteNote').textContent, 'Muting is off. If you turn it on, it can also mute 1 account from this file: @spam_b.');
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'the preview writes nothing');
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { allowlist: 'pal', extraList: 'spam_a\npal\nspam_b', paused: false });
  assert.equal(p.$('preview').hidden, true);
  assert.equal(p.$('msg').textContent, 'Imported: Also hide gained 2.');
  assert.equal(p.$('have').textContent, 'Now: Always show 1 · Also hide 3 · 0 bot choices saved');
});

// Planted negative (issue #27), through the page.
test('settings page: a file naming muting, its cap, its account or the list URL changes none of them', async () => {
  const settings = { muteEnabled: false, muteCap: 25, muteAccount: null, feedUrl: '', paused: false, labeling: false };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': settings });
  await settle();
  p.pickFile(
    'evil.json',
    settingsFile({
      alsoHide: ['spam'],
      muteEnabled: true,
      muteCap: 100,
      muteAccount: 'someone',
      feedUrl: 'https://evil.example/list.txt',
      paused: true,
      labeling: true,
    }),
  );
  await settle();
  assert.deepEqual(p.changes(), ['Also hide gains 1 account: @spam.']);
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { ...settings, extraList: 'spam' });
});

test('settings page: Cancel writes nothing', async () => {
  const settings = { extraList: 'spam_a' };
  const p = loadSettings({ 'xsh:settings': settings });
  await settle();
  p.pickFile('s.json', settingsFile({ alwaysShow: ['pal'], bots: { grok: 'show' }, hideBotMentions: true }));
  await settle();
  assert.deepEqual(p.changes(), [
    'Always show gains 1 account: @pal.',
    '@grok: follows the list → Show.',
    'Turns on hiding posts that tag a bot set to Hide here or Mute on X.',
  ]);
  p.click('cancel');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], settings);
  assert.equal(p.$('preview').hidden, true);
  assert.equal(p.$('msg').textContent, 'Nothing imported.');
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], settings, 'Confirm after Cancel does nothing');
});

test('settings page: a bad file is refused whole, and an oversize one is not read', async () => {
  const settings = { extraList: 'spam_a' };
  const p = loadSettings({ 'xsh:settings': settings });
  await settle();
  p.pickFile('list.txt', 'spam_b\nnot a handle\n');
  await settle();
  assert.equal(p.$('msg').textContent, 'Not imported: line 2 is not an X handle.');
  assert.ok(p.$('msg').classList.contains('bad'));
  assert.equal(p.$('preview').hidden, true);
  p.pickFile('big.txt', null, lib.DEFAULTS.maxBytes + 1);
  await settle();
  assert.equal(p.$('msg').textContent, 'Not imported: the file is larger than 1 MB.');
  p.pickFile('s.json', settingsFile({ bots: { grok: 'block' } }));
  await settle();
  assert.equal(p.$('msg').textContent, 'Not imported: "bots" has a choice other than show, hide or mute.');
  assert.deepEqual(p.chrome.store['xsh:settings'], settings);
});

test('settings page: settings that change after the preview are shown again, not written', async () => {
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { extraList: '' } });
  await settle();
  p.pickFile('shared.txt', 'spam_a\nspam_b\n');
  await settle();
  assert.equal(p.$('stale').hidden, true);
  assert.deepEqual(p.changes(), ['Also hide gains 2 accounts: @spam_a, @spam_b.']);
  // Meanwhile, in the popup: muting turned on, and spam_a saved to Also hide.
  const changed = { extraList: 'spam_a', muteEnabled: true, muteAccount: 'me_here', muteCap: 50 };
  p.chrome.store['xsh:settings'] = structuredClone(changed);
  p.click('confirm');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], changed, 'nothing written');
  assert.equal(p.$('stale').hidden, false);
  assert.deepEqual(p.changes(), ['Also hide gains 1 account: @spam_b.']);
  assert.equal(p.$('muteNote').className, 'warn');
  assert.equal(
    p.$('muteNote').textContent,
    'Muting is on as @me_here. After this import it can also mute 1 more account: @spam_b. It mutes up to 50 a day, skips accounts you follow, and never unmutes.',
  );
  p.click('confirm');
  await settle();
  assert.equal(p.chrome.store['xsh:settings'].extraList, 'spam_a\nspam_b');
  assert.equal(p.$('msg').textContent, 'Imported: Also hide gained 1.');
});

test('settings page: a bot set to Mute on X is named in the muting note', async () => {
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { muteEnabled: true, muteAccount: 'me_here' } });
  await settle();
  p.pickFile('s.json', settingsFile({ bots: { askperplexity: 'mute' } }));
  await settle();
  assert.deepEqual(p.changes(), ['@AskPerplexity: follows the list → Mute on X.']);
  assert.equal(
    p.$('muteNote').textContent,
    'Muting is on as @me_here. After this import it can also mute 1 more account: @askperplexity. Bots among them: @AskPerplexity. ' +
      'It mutes up to 25 a day, skips accounts you follow, and never unmutes.',
  );
});

// A shared list can hold hundreds of handles. Each preview line names the
// first 12, and every one of them is under Show all, muting note included.
test('settings page: a line with more than 12 accounts lists all of them under Show all', async () => {
  const hs = Array.from({ length: 14 }, (_, i) => `spam_${String(i).padStart(2, '0')}`);
  const at = (xs) => xs.map((h) => `@${h}`).join(', ');
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { muteEnabled: true, muteAccount: 'me_here' } });
  await settle();
  p.pickFile('shared.txt', `${hs.join('\n')}\n`);
  await settle();
  const li = p.document.querySelectorAll('#changes li');
  assert.equal(li.length, 1);
  assert.equal(li[0].firstChild.textContent, `Also hide gains 14 accounts: ${at(hs.slice(0, 12))} and 2 more.`);
  assert.equal(li[0].querySelector('details summary').textContent, 'Show all 14 accounts');
  assert.equal(li[0].querySelector('details p').textContent, at(hs));
  const mute = p.$('muteNote');
  assert.equal(
    mute.firstChild.textContent,
    `Muting is on as @me_here. After this import it can also mute 14 more accounts: ${at(hs.slice(0, 12))} and 2 more. ` +
      'It mutes up to 25 a day, skips accounts you follow, and never unmutes.',
  );
  assert.equal(mute.querySelector('details summary').textContent, 'Show all 14 accounts');
  assert.equal(mute.querySelector('details p').textContent, at(hs));

  const twelve = loadSettings({ 'xsh:settings': { muteEnabled: true, muteAccount: 'me_here' } });
  await settle();
  twelve.pickFile('shared.txt', `${hs.slice(0, 12).join('\n')}\n`);
  await settle();
  assert.deepEqual(twelve.changes(), [`Also hide gains 12 accounts: ${at(hs.slice(0, 12))}.`]);
  assert.equal(twelve.document.querySelectorAll('#preview details').length, 0, 'no Show all at 12');
});

test('settings page: a second click on Confirm writes once', async () => {
  const p = loadSettings({ 'xsh:settings': { extraList: 'spam_a' } });
  let writes = 0;
  const set = p.chrome.storage.local.set;
  p.chrome.storage.local.set = async (o) => {
    writes += 1;
    return set(o);
  };
  await settle();
  p.pickFile('shared.txt', 'spam_b\n');
  await settle();
  p.click('confirm');
  p.click('confirm');
  await settle();
  assert.equal(writes, 1);
  assert.equal(p.chrome.store['xsh:settings'].extraList, 'spam_a\nspam_b');
  assert.equal(p.$('msg').textContent, 'Imported: Also hide gained 1.');
});

test('settings page: Cancel while Confirm reads settings stops the write', async () => {
  const settings = { extraList: 'spam_a' };
  const p = loadSettings({ 'xsh:settings': settings });
  await settle();
  p.pickFile('shared.txt', 'spam_b\n');
  await settle();
  p.click('confirm');
  p.click('cancel');
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], settings);
  assert.equal(p.$('msg').textContent, 'Nothing imported.');
});

test('settings page: a bot set to Show stays shown for that reason, not because of Always show', async () => {
  const bots = { grok: 'show', pangram: 'show', askperplexity: 'show' };
  const p = loadSettings({ 'xsh:list': LIST, 'xsh:settings': { allowlist: 'pal', bots } });
  await settle();
  p.pickFile('shared.txt', 'grok\npangram\npal\nspam_b\n');
  await settle();
  assert.deepEqual(p.changes(), [
    'Also hide gains 4 accounts: @grok, @pal, @pangram, @spam_b.',
    '@pal will stay shown, because Always show has it.',
    '@grok, @pangram will stay shown, because they are set to Show.',
  ]);
  p.pickFile('one.txt', 'AskPerplexity\n');
  await settle();
  assert.deepEqual(p.changes(), ['Also hide gains 1 account: @askperplexity.', '@AskPerplexity will stay shown, because it is set to Show.']);
});

test('settings page: a file with nothing new says so and offers no Confirm', async () => {
  const p = loadSettings({ 'xsh:settings': { extraList: 'spam_a' } });
  await settle();
  p.pickFile('shared.txt', 'spam_a\n');
  await settle();
  assert.equal(p.$('preview').hidden, true);
  assert.equal(p.$('msg').textContent, 'Nothing to import: your settings already have everything in this file.');
});

test('popup: Export or import opens the options page', async () => {
  const p = loadPopup({ 'xsh:settings': {} });
  let opened = 0;
  p.chrome.runtime.openOptionsPage = async () => {
    opened += 1;
  };
  await settle();
  p.document.getElementById('files').dispatchEvent(new p.window.Event('click'));
  await settle();
  assert.equal(opened, 1);
});
