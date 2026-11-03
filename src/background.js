// x-slop-hide background service worker: keeps the handle list fresh in
// chrome.storage.local. Its only network request is the feed URL.
importScripts('lib.js');

const L = self.XSlopHide;
const K = L.STORAGE_KEYS;
const ALARM = 'xsh-refresh';

async function settings() {
  const o = await chrome.storage.local.get(K.settings);
  return o[K.settings] || {};
}

async function refresh() {
  const s = await settings();
  const url = s.feedUrl || L.DEFAULTS.feedUrl;
  const prev = (await chrome.storage.local.get(K.list))[K.list];
  const result = await L.fetchList({ url, fetchImpl: fetch, prevHandles: prev && prev.handles });
  const record = L.nextRecord(prev, result, url, Date.now());
  await chrome.storage.local.set({ [K.list]: record });
  return { ok: result.ok, reason: result.reason || null, count: record.handles.length };
}

async function refreshIfDue() {
  const prev = (await chrome.storage.local.get(K.list))[K.list];
  if (L.isDue(prev && prev.fetchedAt, Date.now(), L.DEFAULTS.refreshMinutes)) await refresh();
}

function ensureAlarm() {
  chrome.alarms.get(ALARM).then((a) => {
    if (!a) chrome.alarms.create(ALARM, { periodInMinutes: L.DEFAULTS.refreshMinutes });
  });
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  refreshIfDue();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refresh();
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg && msg.type === 'xsh:refresh') {
    refresh().then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
    return true; // async response
  }
  return false;
});
