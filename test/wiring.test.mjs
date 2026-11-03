// Wiring tests: run the real background.js and the built userscript against
// in-memory fakes of chrome.* and GM_*. They check the glue, not the browser;
// the live check on x.com is described in the README.
import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { buildUserscript } from '../scripts/build-userscript.mjs';
import { src, post, page, tick } from './helpers.mjs';
import { parseHTML } from 'linkedom';

const many = (n) => Array.from({ length: n }, (_, i) => `h${i}`);

function event() {
  const fns = [];
  return { addListener: (f) => fns.push(f), fire: (...a) => fns.map((f) => f(...a)) };
}

function fakeChrome() {
  const store = {};
  const alarmTable = {};
  return {
    store,
    alarmTable,
    storage: {
      local: {
        get: async (keys) => {
          const ks = Array.isArray(keys) ? keys : [keys];
          return Object.fromEntries(ks.filter((k) => k in store).map((k) => [k, structuredClone(store[k])]));
        },
        set: async (o) => Object.assign(store, structuredClone(o)),
      },
    },
    alarms: {
      get: async (name) => alarmTable[name],
      create: (name, info) => {
        alarmTable[name] = { name, ...info };
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
  const bg = loadBackground(() => ok('KaiBGR\nfrontmostai\n'));
  bg.chrome.runtime.onInstalled.fire({ reason: 'install' });
  await settle();
  assert.deepEqual(bg.requests.map((r) => r.url), ['https://clankwall.vogel.dev/api/usernames.txt']);
  const rec = bg.chrome.store['xsh:list'];
  assert.deepEqual(rec.handles, ['frontmostai', 'kaibgr']);
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
  const bg = loadBackground(() => ok('kaibgr\n'));
  bg.chrome.store['xsh:list'] = { handles: ['kaibgr'], fetchedAt: Date.now(), source: 's' };
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
  const bg = loadBackground(() => ok('kaibgr\n'));
  bg.chrome.store['xsh:settings'] = { feedUrl: 'https://mirror.example/list.txt' };
  bg.chrome.runtime.onInstalled.fire({});
  await settle();
  assert.equal(bg.requests[0].url, 'https://mirror.example/list.txt');
  assert.equal(bg.chrome.store['xsh:list'].source, 'https://mirror.example/list.txt');
});

test('userscript build: header grants and connects only what it uses', () => {
  const us = buildUserscript();
  assert.match(us, /^\/\/ ==UserScript==/);
  assert.match(us, /@connect {6}clankwall\.vogel\.dev/);
  assert.doesNotMatch(us, /@grant\s+none/);
  assert.doesNotMatch(us, /unsafeWindow/);
});

// Run the built userscript in a VM with in-memory GM_* storage. Tabs that
// share `values` share storage, as they do under a userscript manager.
function loadUserscript({ values = {}, respond }) {
  const { window, document, MutationObserver } = parseHTML(
    page([post({ author: 'kaibgr', status: '1' }), post({ author: 'realhuman', status: '2' })]),
  );
  const requests = [];
  const menu = {};
  const intervals = [];
  const ctx = vm.createContext({
    window,
    document,
    MutationObserver,
    location: { pathname: '/home' },
    console,
    prompt: () => null,
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
  return { window, document, values, requests, menu, intervals };
}

const gmOk = (body) => (req) =>
  setTimeout(() => req.onload({ status: 200, responseHeaders: 'content-type: text/plain\r\n', responseText: body }), 0);

test('userscript: fetches via GM_xmlhttpRequest, caches, and hides listed authors', async () => {
  const us = loadUserscript({ respond: gmOk('kaibgr\n') });
  await settle();
  assert.equal(us.requests.length, 1);
  assert.equal(us.requests[0].url, 'https://clankwall.vogel.dev/api/usernames.txt');
  assert.equal(us.requests[0].anonymous, true);
  assert.deepEqual(us.values['xsh:list'].handles, ['kaibgr']);
  const hidden = (s) => us.document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual([hidden('1'), hidden('2')], [true, false]);
  assert.deepEqual(Object.keys(us.menu), ['Pause / resume hiding', 'Refresh list now', 'Edit always-show list']);
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
  const values = { 'xsh:list': { handles: ['kaibgr'], fetchedAt: now, lastAttemptAt: now, source: 's', lastError: null, seq: 1 } };
  let body = 'kaibgr\nnewbot\n';
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
  assert.deepEqual(values['xsh:list'].handles, ['kaibgr', 'newbot']);
  // Timers were suspended in the background; the tab comes back into view.
  values['xsh:list'].fetchedAt -= 7 * hour;
  values['xsh:list'].lastAttemptAt -= 7 * hour;
  body = 'kaibgr\nnewbot\nthird\n';
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
    respond: (req) => (fail ? setTimeout(() => req.onerror(), 0) : gmOk('kaibgr\n')(req)),
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
  assert.deepEqual(values['xsh:list'].handles, ['kaibgr']);
});

test('userscript: committed dist file matches the sources', () => {
  assert.equal(src('dist/x-slop-hide.user.js'), buildUserscript());
});
