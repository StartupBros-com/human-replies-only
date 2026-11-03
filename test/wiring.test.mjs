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

test('userscript: fetches via GM_xmlhttpRequest, caches, and hides listed authors', async () => {
  const { window, document, MutationObserver } = parseHTML(
    page([post({ author: 'kaibgr', status: '1' }), post({ author: 'realhuman', status: '2' })]),
  );
  const values = {};
  const requests = [];
  const menu = [];
  const ctx = vm.createContext({
    window,
    document,
    MutationObserver,
    location: { pathname: '/home' },
    console,
    prompt: () => null,
    GM_getValue: (k, d) => (k in values ? structuredClone(values[k]) : d),
    GM_setValue: (k, v) => {
      values[k] = structuredClone(v);
    },
    GM_registerMenuCommand: (name) => menu.push(name),
    GM_addValueChangeListener: () => {},
    GM_xmlhttpRequest: (req) => {
      requests.push(req);
      setTimeout(() => req.onload({ status: 200, responseHeaders: 'content-type: text/plain\r\n', responseText: 'kaibgr\n' }), 0);
    },
  });
  vm.runInContext(buildUserscript(), ctx, { filename: 'dist/x-slop-hide.user.js' });
  await settle();
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://clankwall.vogel.dev/api/usernames.txt');
  assert.equal(requests[0].anonymous, true);
  assert.deepEqual(values['xsh:list'].handles, ['kaibgr']);
  const hidden = (s) => document.querySelector(`[data-fixture="${s}"]`).hasAttribute('data-xsh-hidden');
  assert.deepEqual([hidden('1'), hidden('2')], [true, false]);
  assert.deepEqual(menu, ['Pause / resume hiding', 'Refresh list now', 'Edit always-show list']);
});

test('userscript: committed dist file matches the sources', () => {
  assert.equal(src('dist/x-slop-hide.user.js'), buildUserscript());
});
