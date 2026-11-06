// x-slop-hide background service worker: keeps the handle list fresh in
// chrome.storage.local, and, when the user has turned muting on, mutes listed
// accounts one at a time in background tabs it opens and closes itself. Its
// only network request is the feed URL; muting goes through X's own page.
importScripts('lib.js');

const L = self.XSlopHide;
const K = L.STORAGE_KEYS;
const ALARM = 'xsh-refresh';
const MUTE_ALARM = 'xsh-mute';
const JOB_ALARM = 'xsh-job-timeout';
const JOB_KEY = 'xsh:job'; // chrome.storage.session: the one job in flight

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

// ------------------------------------------------------------------ muting

const mutesRec = async () => (await chrome.storage.local.get(K.mutes))[K.mutes] || L.emptyMutes();
const saveMutes = (rec) => chrome.storage.local.set({ [K.mutes]: rec });
const getJob = async () => (await chrome.storage.session.get(JOB_KEY))[JOB_KEY] || null;
const setJob = (job) => chrome.storage.session.set({ [JOB_KEY]: job });
const clearJob = () => chrome.storage.session.remove(JOB_KEY);

// Every read-modify-write of the mute record and the job goes through this
// chain, so an alarm, a tab's report and a sighting never interleave.
let chain = Promise.resolve();
function serial(fn) {
  const p = chain.then(fn, fn);
  chain = p.catch(() => {});
  return p;
}

const muting = (s) => !!(s.muteEnabled && s.muteAccount);

async function ensureMuteAlarm() {
  const s = await settings();
  const a = await chrome.alarms.get(MUTE_ALARM);
  if (muting(s) && !a) chrome.alarms.create(MUTE_ALARM, { periodInMinutes: 1 });
  if (!muting(s) && a) chrome.alarms.clear(MUTE_ALARM);
}

function gapMs() {
  const [lo, hi] = L.DEFAULTS.muteGapMinutes;
  return Math.round((lo + Math.random() * (hi - lo)) * 60000);
}

// Open one job's tab in the background. The tab is never made active.
async function startJob(kind, handle, account, now) {
  const url = kind === 'mute' ? `https://x.com/${handle}` : 'https://x.com/settings/muted/all';
  const tab = await chrome.tabs.create({ url, active: false });
  const job = {
    id: `${now}-${Math.random().toString(36).slice(2, 8)}`,
    kind,
    handle: handle || null,
    account,
    tabId: tab.id,
    startedAt: now,
    claimed: false,
    pageTimeoutMs: L.DEFAULTS.muteTabTimeoutMs - 20000,
  };
  await setJob(job);
  chrome.alarms.create(JOB_ALARM, { when: now + L.DEFAULTS.muteTabTimeoutMs });
  return job;
}

// Fold a job's result into the record, close its tab and set the next visit.
async function finishJob(job, result) {
  const now = Date.now();
  let rec = await mutesRec();
  if (job.kind === 'mute') {
    rec = L.recordOutcome(rec, job.handle, result, now);
  } else if (result.status === 'checked') {
    rec = L.recordCheck(rec, result.rows, now).rec;
  } else {
    // An unreadable muted list means mutes cannot be confirmed: stop for the day.
    rec = L.stopDay(rec, now, `settings/muted/all check: ${result.status}${result.reason ? ` (${result.reason})` : ''}`);
  }
  rec.nextAt = now + gapMs();
  await saveMutes(rec);
  await clearJob(); // before closing, so onRemoved does not see this job
  chrome.alarms.clear(JOB_ALARM);
  await chrome.tabs.remove(job.tabId).catch(() => {});
}

// One step of the mute loop, run by the alarm once a minute: finish a job
// that ran out of time, or start the next one if today's caps allow.
async function tick() {
  const s = await settings();
  const job = await getJob();
  const now = Date.now();
  if (job) {
    if (!muting(s)) {
      // Turned off mid-job: drop it unrecorded.
      await clearJob();
      await chrome.tabs.remove(job.tabId).catch(() => {});
      return;
    }
    if (now - job.startedAt >= L.DEFAULTS.muteTabTimeoutMs) {
      await finishJob(job, { status: 'error', reason: `no answer from the tab in ${L.DEFAULTS.muteTabTimeoutMs / 1000} s` });
    }
    return;
  }
  if (!muting(s)) return;
  let rec = await mutesRec();
  if (now < (rec.nextAt || 0)) return;
  const b = L.muteBudget(rec, L.utcDay(now));
  if (b.stopped) return;
  const list = await stored();
  const candidates = L.muteCandidates(list && list.handles, s, rec);
  const pending = (rec.sinceCheck || []).length;
  const canVisit = b.mutesLeft > 0 && b.visitsLeft > 0 && candidates.length > 0;
  if (pending && (pending >= L.DEFAULTS.muteCheckEvery || !canVisit)) {
    await startJob('check', null, s.muteAccount, now);
    return;
  }
  if (!canVisit) return;
  await startJob('mute', candidates[0], s.muteAccount, now);
  rec = L.countVisit(rec, now);
  await saveMutes(rec);
}

chrome.runtime.onInstalled.addListener(() => {
  ensureAlarm();
  ensureMuteAlarm();
  refresh();
});

chrome.runtime.onStartup.addListener(() => {
  ensureAlarm();
  ensureMuteAlarm();
  refreshIfDue();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && changes[K.settings]) ensureMuteAlarm();
});

chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) refresh();
  if (a.name === MUTE_ALARM || a.name === JOB_ALARM) serial(tick);
});

// The user closed a job's tab before it reported: count it as an error.
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const job = await getJob();
    if (job && job.tabId === tabId) await finishJob(job, { status: 'error', reason: 'the tab was closed before it finished' });
  });
});

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg) return false;
  if (msg.type === 'xsh:refresh') {
    refresh().then(sendResponse, (e) => sendResponse({ ok: false, reason: String(e) }));
    return true; // async response
  }
  const tabId = sender && sender.tab ? sender.tab.id : null;
  if (msg.type === 'xsh:job') {
    // Only the tab opened for the job gets it, and only once (a reload of
    // that tab must not click again).
    serial(async () => {
      const job = await getJob();
      if (!job || job.tabId !== tabId || job.claimed) return null;
      await setJob(Object.assign({}, job, { claimed: true }));
      return job;
    }).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === 'xsh:job-result') {
    serial(async () => {
      const job = await getJob();
      const r = msg.result || {};
      if (job && job.tabId === tabId && r.id === job.id) await finishJob(job, r);
    }).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if (msg.type === 'xsh:sighting') {
    serial(async () => {
      const s = await settings();
      const h = L.normalizeHandle(msg.handle);
      const list = await stored();
      if (!muting(s) || !h || !(list && list.handles.includes(h))) return;
      await saveMutes(L.noteSighting(await mutesRec(), h));
    }).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  return false;
});
