// Wiring tests: run the real background.js and the built userscript against
// in-memory fakes of chrome.* and GM_*. They check the glue, not the browser;
// the live check on x.com is described in the README.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildUserscript } from '../scripts/build-userscript.mjs';
import { src, post, page, tick, lib } from './helpers.mjs';
import { parseHTML } from 'linkedom';

const many = (n) => Array.from({ length: n }, (_, i) => `h${i}`);

function event() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.map((f) => f(...a)) };
}

function area(store, onChanged, name) {
  return {
    get: async (keys) => {
      const ks = Array.isArray(keys) ? keys : [keys];
      return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
    },
    set: async (o) => {
      const changes = Object.fromEntries(Object.keys(o).map((k) => [k, { newValue: structuredClone(o[k]) }]));
      Object.assign(store, structuredClone(o));
      if (onChanged) onChanged.fire(changes, name);
    },
    remove: async (k) => {
      delete store[k];
    },
  };
}

function fakeChrome() {
  const store = {};
  const session = {};
  const alarmTable = {};
  const onChanged = event();
  const tabs = { opened: [], removed: [], nextId: 100, onRemoved: event() };
  tabs.create = async (info) => {
    const tab = { id: tabs.nextId++, ...info };
    tabs.opened.push(tab);
    return tab;
  };
  tabs.remove = async (id) => {
    tabs.removed.push(id);
    tabs.onRemoved.fire(id, {});
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
    runtime: { onInstalled: event(), onStartup: event(), onMessage: event() },
  };
}

function loadBackground(responder) {
  const chrome = fakeChrome();
  const requests = [];
  const fetch = async (url, init) => {
    requests.push({ url, init });
    return responder(url);
  };
  const ctx = vm.createContext({ chrome, fetch, AbortSignal, console });
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
  const raw = 'https://raw.githubusercontent.com/StartupBros-com/x-slop-hide/main/dist/x-slop-hide.user.js';
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
    location: { pathname: '/home' },
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
function loadPopup(store) {
  const { window, document } = parseHTML(src('src/popup.html'));
  const chrome = fakeChrome();
  Object.assign(chrome.store, structuredClone(store));
  chrome.tabs = { query: async () => [], sendMessage: async () => null };
  chrome.runtime.sendMessage = async () => ({ ok: true });
  const ctx = vm.createContext({ window, document, chrome, console, URL });
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
    ['grok', 'AskPerplexity', 'pangramlabs', 'bot', 'threadreaderapp', 'UnrollHelper'].map((n) => `https://x.com/${n}`),
  );
  assert.deepEqual(
    lib.BOTS.map((b) => rowMode(p, b.handle)),
    ['show', 'hide', 'show', 'show', 'show', 'show'],
    'showGrok reads as Show; a listed bot hides; the rest follow the list',
  );
  assert.equal(p.document.getElementById('bot-bot').disabled, true, 'Always-show locks the row to Show');
  assert.equal(p.document.getElementById('bot-grok').disabled, false);
  assert.equal(p.document.getElementById('mentions').checked, false);
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
  assert.equal(p.document.getElementById('muteState').textContent, 'Off.');
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
  assert.match(p.document.getElementById('muteState').textContent, /^Muting as @startupbros\. Today \(UTC\): 0 of 25 mutes, 0 of 50 visits/);
  box.checked = false;
  box.dispatchEvent(new p.window.Event('change'));
  await settle();
  assert.deepEqual(p.chrome.store['xsh:settings'], { allowlist: 'friend', muteEnabled: false, muteAccount: null });
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
  assert.equal(
    p.document.getElementById('muteState').textContent,
    'Muting as @startupbros. Today (UTC): 2 of 25 mutes, 5 of 50 visits. ' +
      'So far: 2 muted (1 seen on your muted list, 1 not found there), 1 already muted, 1 you follow, 1 skipped.',
  );
  assert.equal(p.document.getElementById('muteStop').hidden, false);
  assert.equal(p.document.getElementById('muteStop').textContent, 'Stopped for today: not on settings/muted/all after muting: @b');
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
