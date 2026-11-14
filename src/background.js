// AI Anti-Slop background service worker: keeps the handle list fresh in
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
const JOB_TABS_KEY = 'xsh:jobTabs'; // chrome.storage.session: tabs opened for jobs
const PRESENT_TIMEOUT_MS = 1500;

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

// Job tabs still open, newest last, so the x.com check below never counts
// one. An id leaves the list when its tab closes; one whose close failed
// stays, which is when the check needs it. At most 50 are kept.
const jobTabs = async () => (await chrome.storage.session.get(JOB_TABS_KEY))[JOB_TABS_KEY] || [];
async function noteJobTab(id) {
  const ids = (await jobTabs()).filter((t) => t !== id);
  ids.push(id);
  await chrome.storage.session.set({ [JOB_TABS_KEY]: ids.slice(-50) });
}
async function forgetJobTab(id) {
  const ids = await jobTabs();
  if (!ids.includes(id)) return;
  const rest = ids.filter((t) => t !== id);
  if (rest.length) await chrome.storage.session.set({ [JOB_TABS_KEY]: rest });
  else await chrome.storage.session.remove(JOB_TABS_KEY);
}

// One tab's answer to "is this an x.com tab of the user's own?": true only
// from an AI Anti-Slop content script that was not given a job. A tab with
// no content script (any other site) rejects, as does one slower than
// PRESENT_TIMEOUT_MS.
function askTab(tabId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('timeout')), PRESENT_TIMEOUT_MS);
    Promise.resolve()
      .then(() => chrome.tabs.sendMessage(tabId, { type: 'xsh:present' }))
      .then(
        (v) => {
          clearTimeout(timer);
          if (v === true) resolve(true);
          else reject(new Error('not a user tab'));
        },
        (e) => {
          clearTimeout(timer);
          reject(e);
        },
      );
  });
}

// Whether the user has an x.com tab of their own open: what a daily cap
// above 25 needs before each mute visit. Needs no permission: without
// "tabs", tabs.query returns tabs without their URLs, so every tab is asked
// except discarded ones and the ones opened for jobs.
async function userHasXOpen() {
  const skip = new Set(await jobTabs());
  let tabs = [];
  try {
    tabs = await chrome.tabs.query({});
  } catch (e) {
    return false;
  }
  const asks = (tabs || [])
    .filter((t) => t && Number.isInteger(t.id) && t.id >= 0 && !t.discarded && !skip.has(t.id))
    .map((t) => askTab(t.id));
  if (!asks.length) return false;
  try {
    return await Promise.any(asks);
  } catch (e) {
    return false;
  }
}

// Open one job's tab in the background. The tab is never made active.
async function startJob(kind, handle, account, now) {
  const url = kind === 'mute' ? `https://x.com/${handle}` : 'https://x.com/settings/muted/all';
  const tab = await chrome.tabs.create({ url, active: false });
  await noteJobTab(tab.id);
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

// Whether a job may still go ahead. Settings can change while its tab loads
// and waits for a post: muting turned off, another account, a bot's row moved
// off Mute on X, an account added to Always show. A mute job must still be for
// an account muting may visit.
async function stillWanted(job) {
  const s = await settings();
  if (!muting(s) || s.muteAccount !== job.account) return false;
  if (job.kind !== 'mute') return true;
  const list = await stored();
  return L.muteEligible(list && list.handles, s).includes(job.handle);
}

// Drop a job unrecorded and close its tab. The visit it cost stays counted.
async function dropJob(job) {
  await clearJob();
  chrome.alarms.clear(JOB_ALARM);
  await closeJobTab(job.tabId);
}

// Close a job's tab. Its id leaves the job-tab list only once the close
// succeeded; a tab that stayed open keeps being skipped by the x.com check.
async function closeJobTab(id) {
  const closed = await chrome.tabs.remove(id).then(
    () => true,
    () => false,
  );
  if (closed) await forgetJobTab(id);
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
  await closeJobTab(job.tabId);
}

// What tickWith returns when a mute visit is due at 50 or 100 a day and the
// tabs have not been asked yet.
const ASK_TABS = 'ask-tabs';

// One step of the mute loop, run by the alarm once a minute (runTick): finish
// a job that ran out of time, or start the next one if today's caps allow.
// Takes no argument, because serial() passes the previous step's result.
function tick() {
  return tickWith(null);
}

// The alarm's step. At 50 or 100 a day a mute visit also needs an x.com tab
// of the user's own open, and the tabs are asked outside the queue: a tab
// that has just loaded answers only once the worker has answered its
// xsh:job question, which waits in the queue behind any step running there.
async function runTick() {
  if ((await serial(tick)) !== ASK_TABS) return;
  const open = await userHasXOpen();
  await serial(() => tickWith(open));
}

// xOpen is null until the tabs are asked, then whether the user has an x.com
// tab open. A check of settings/muted/all runs either way.
async function tickWith(xOpen) {
  const s = await settings();
  const job = await getJob();
  const now = Date.now();
  if (job) {
    if (!muting(s)) {
      // Turned off mid-job: drop it unrecorded.
      await dropJob(job);
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
  const cap = L.muteCap(s);
  const b = L.muteBudget(rec, L.utcDay(now), cap);
  if (b.stopped) return;
  const list = await stored();
  const candidates = L.muteCandidates(list && list.handles, s, rec);
  const pending = (rec.sinceCheck || []).length;
  let canVisit = b.mutesLeft > 0 && b.visitsLeft > 0 && candidates.length > 0;
  if (pending >= L.DEFAULTS.muteCheckEvery) {
    await startJob('check', null, s.muteAccount, now);
    return;
  }
  if (canVisit && L.capNeedsXOpen(cap)) {
    if (xOpen === null) return ASK_TABS;
    canVisit = xOpen === true;
  }
  if (pending && !canVisit) {
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
  if (a.name === MUTE_ALARM || a.name === JOB_ALARM) runTick();
});

// The user closed a job's tab before it reported: count it as an error.
chrome.tabs.onRemoved.addListener((tabId) => {
  serial(async () => {
    const job = await getJob();
    if (job && job.tabId === tabId) await finishJob(job, { status: 'error', reason: 'the tab was closed before it finished' });
    await forgetJobTab(tabId);
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
      if (!(await stillWanted(job))) {
        await dropJob(job);
        return null;
      }
      await setJob(Object.assign({}, job, { claimed: true }));
      return job;
    }).then(sendResponse, () => sendResponse(null));
    return true;
  }
  if (msg.type === 'xsh:job-go') {
    // Asked by a mute job's tab just before it clicks Mute, up to a minute
    // after it claimed the job. No means the job was dropped and its tab closed.
    serial(async () => {
      const job = await getJob();
      if (!job || job.tabId !== tabId || job.id !== msg.id || !job.claimed) return false;
      if (await stillWanted(job)) return true;
      await dropJob(job);
      return false;
    }).then(sendResponse, () => sendResponse(false));
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
      // Only an account muting may visit: listed or extra, not Always-show,
      // and a bot only when its row says Mute on X.
      if (!muting(s) || !h || !L.muteEligible(list && list.handles, s).includes(h)) return;
      await saveMutes(L.noteSighting(await mutesRec(), h));
    }).then(() => sendResponse(true), () => sendResponse(false));
    return true;
  }
  if (msg.type === 'xsh:label') {
    serial(() => saveLabel(msg)).then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
  if (msg.type === 'xsh:labels-clear') {
    // Only from the popup: a page at the extension's own address (also when
    // opened in a tab), never a content script, whose address is the site's.
    const own = chrome.runtime.getURL('');
    if (!sender || typeof sender.url !== 'string' || !sender.url.startsWith(own)) return false;
    serial(clearLabels).then(sendResponse, (e) => sendResponse({ ok: false, reason: String((e && e.message) || e) }));
    return true;
  }
  return false;
});

// ------------------------------------------------------------------ labels

// Store one label from a content script, or clear it, after checking every
// field (lib.labelRecord). A new label adds the account to Also hide (slop)
// or Always show (not slop); clearing one changes neither box. Refused while
// labels are off, and once labelMax are saved.
// One read, then one write: settings are read in the same get as the label,
// so a popup save can only be overwritten inside that one gap.
async function saveLabel(msg) {
  const id = msg && typeof msg.url === 'string' ? (L.statusOf(msg.url) || {}).id : null;
  const key = id ? L.LABEL_PREFIX + id : null;
  const got = await chrome.storage.local.get([K.settings, K.list, K.labelCount, ...(key ? [key] : [])]);
  const s = got[K.settings] || {};
  if (s.labeling !== true) return { ok: false, reason: 'labels are off' };
  const list = got[K.list];
  const r = L.labelRecord(msg, { handles: list && list.handles, source: list && list.source, settings: s }, Date.now());
  if (!r.ok) return { ok: false, reason: r.reason };
  if (L.LABEL_PREFIX + r.id !== key) return { ok: false, reason: 'not a post URL' };
  const had = !!got[key];
  let n = Number(got[K.labelCount]) || 0;
  if (r.label === null) {
    if (had) {
      await chrome.storage.local.remove(key);
      await chrome.storage.local.set({ [K.labelCount]: Math.max(0, n - 1) });
    }
    return { ok: true, label: null };
  }
  const max = L.DEFAULTS.labelMax;
  if (!had && n >= max) {
    // The count is only a cache of the keys: recount before refusing.
    n = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(L.LABEL_PREFIX)).length;
    if (n >= max) return { ok: false, reason: `${max} labels saved: export and delete them to add more` };
  }
  const writes = { [key]: r.record, [K.labelCount]: had ? n : n + 1 };
  const patch = L.labelPatch(s, r.handle, r.label);
  if (patch) writes[K.settings] = Object.assign({}, s, patch);
  await chrome.storage.local.set(writes);
  return { ok: true, label: r.label, added: patch ? Object.keys(patch)[0] : null };
}

// Delete every label and the count. The two boxes are left as they are.
async function clearLabels() {
  const keys = Object.keys(await chrome.storage.local.get(null)).filter((k) => k.startsWith(L.LABEL_PREFIX));
  await chrome.storage.local.remove([...keys, K.labelCount]);
  return { ok: true, removed: keys.length };
}
