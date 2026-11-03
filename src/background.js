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

const stored = async () => (await chrome.storage.local.get(K.list))[K.list];

// Install, alarm, startup and popup triggers can overlap. They share one
// in-flight refresh, so only one fetch and one write happen at a time.
let inflight = null;
function refresh() {
  if (!inflight) inflight = runRefresh().finally(() => (inflight = null));
  return inflight;
}

async function runRefresh() {
  const s = await settings();
  const url = s.feedUrl || L.DEFAULTS.feedUrl;
  const prev = await stored();
  const startSeq = (prev && prev.seq) || 0;
  const result = await L.fetchList({ url, fetchImpl: fetch, prevHandles: prev && prev.handles });
  const latest = await stored();
  const record = L.commitRecord(latest, result, url, startSeq, Date.now());
  if (record) await chrome.storage.local.set({ [K.list]: record });
  const kept = record || latest;
  return { ok: result.ok, reason: result.reason || null, count: kept ? kept.handles.length : 0 };
}

async function refreshIfDue() {
  const prev = await stored();
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
