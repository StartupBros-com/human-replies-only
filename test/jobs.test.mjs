// Runs the real src/content.js job mode against linkedom pages shaped like
// x.com's profile and settings/muted/all pages, with X's ⋯ menu faked from
// the item labels seen live on 2026-11-06.
import test from 'node:test';
import assert from 'node:assert/strict';
import { post, page, postWithCaret, meLink, wireMenu, runContent, stateWith, tick } from './helpers.mjs';

const ME = 'startupbros';
const H = 'slop_a';
const MENU = ['Not interested in this post', `Follow @${H}`, `Add/remove @${H} from Lists`, 'Mute', `Block @${H}`, 'Report post'];
const job = (over = {}) => ({ id: 'j1', kind: 'mute', handle: H, account: ME, waitMs: 400, ...over });
const muting = stateWith([H], { muteEnabled: true, muteAccount: ME });

function profile(cells, { me = ME } = {}) {
  return page([me ? meLink(me) : '<button data-testid="loginButton">Log in</button>', ...cells]);
}

function muteRun({ items = MENU, cells = [postWithCaret({ author: H })], me = ME, confirmSheet = false, j = job() } = {}) {
  const t = runContent(profile(cells, { me }), { pathname: `/${H}`, state: muting, job: j });
  const clicks = wireMenu(t.document, { items, handle: H, confirmSheet });
  return { t, clicks };
}

test('mute job: clicks the one exact Mute item and reports X\'s toast', async () => {
  const { t, clicks } = muteRun({ items: [...MENU, 'Mute this conversation'] });
  const r = await t.done;
  assert.deepEqual(clicks, ['Mute']);
  assert.deepEqual(r, { id: 'j1', status: 'muted', toast: `@${H} has been muted.Undo` });
});

test('mute job: "Mute @handle" is the same item', async () => {
  const { t, clicks } = muteRun({ items: [`Follow @${H}`, `Mute @${H}`, `Block @${H}`] });
  assert.equal((await t.done).status, 'muted');
  assert.deepEqual(clicks, [`Mute @${H}`]);
});

test('mute job: an Unmute item means already muted, and nothing is clicked', async () => {
  const { t, clicks } = muteRun({ items: [`Follow @${H}`, 'Unmute', `Block @${H}`] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'already' });
  assert.deepEqual(clicks, []);
});

test('mute job: an account the user follows is left alone', async () => {
  const { t, clicks } = muteRun({ items: [`Unfollow @${H}`, 'Mute', `Block @${H}`] });
  const r = await t.done;
  assert.equal(r.status, 'followed');
  assert.deepEqual(clicks, []);
});

// Planted negatives: a menu we do not recognise is refused, never guessed at.
test('mute job: no Mute item, or two, is refused without a click', async () => {
  for (const items of [[`Follow @${H}`, 'Mute this conversation', `Block @${H}`], ['Mute', `Mute @${H}`]]) {
    const { t, clicks } = muteRun({ items });
    const r = await t.done;
    assert.equal(r.status, 'refused');
    assert.match(r.reason, /exact Mute items/);
    assert.deepEqual(clicks, []);
  }
});

test('mute job: a confirmation sheet after the click is left unanswered and refused', async () => {
  const { t, clicks } = muteRun({ confirmSheet: true });
  const r = await t.done;
  assert.equal(r.status, 'refused');
  assert.match(r.reason, /confirmation/);
  assert.deepEqual(clicks, ['Mute']);
});

test('mute job: another logged-in account, or none, stops before any click', async () => {
  let run = muteRun({ me: 'someone_else' });
  assert.deepEqual(await run.t.done, { id: 'j1', status: 'wrong-account', reason: `logged in as @someone_else, not @${ME}` });
  assert.deepEqual(run.clicks, []);
  run = muteRun({ me: null });
  assert.equal((await run.t.done).status, 'login');
  assert.deepEqual(run.clicks, []);
});

test('mute job: a profile with no post the account wrote is skipped; a quote of it does not count', async () => {
  const { t, clicks } = muteRun({ cells: [postWithCaret({ author: 'realhuman', quote: H, status: '2' })] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'no-post', reason: 'no post by the account on its profile' });
  assert.deepEqual(clicks, []);
});

// Seen live on 2026-11-06: a profile's first post rendered 2-3 s before its ⋯ button.
test('mute job: waits for a post that has its ⋯ button, then mutes', async () => {
  const { t, clicks } = muteRun({ cells: [post({ author: H, status: '9' })], j: job({ waitMs: 3000 }) });
  setTimeout(() => {
    const art = t.document.querySelector('article[data-testid="tweet"]');
    art.insertAdjacentHTML('beforeend', '<button data-testid="caret" aria-label="More">⋯</button>');
    wireMenu(t.document, { items: MENU, handle: H, clicks });
  }, 700);
  const r = await t.done;
  assert.equal(r.status, 'muted');
  assert.deepEqual(clicks, ['Mute']);
});

test('mute job: posts that never get a ⋯ button are reported as such', async () => {
  const { t, clicks } = muteRun({ cells: [post({ author: H, status: '9' })] });
  assert.deepEqual(await t.done, { id: 'j1', status: 'no-post', reason: 'its posts have no ⋯ button' });
  assert.deepEqual(clicks, []);
});

test('mute job: a menu that never opens reports an error', async () => {
  // A caret with no menu wired to it.
  const t = runContent(profile([postWithCaret({ author: H })]), { pathname: `/${H}`, state: muting, job: job() });
  const r = await t.done;
  assert.deepEqual(r, { id: 'j1', status: 'error', reason: 'the ⋯ menu did not open' });
});

test('mute job: the page timeout reports an error instead of hanging', async () => {
  const { t } = muteRun({ cells: [], j: job({ waitMs: 5000, pageTimeoutMs: 300 }) });
  assert.deepEqual(await t.done, { id: 'j1', status: 'error', reason: 'timed out in the page' });
});

test('check job: reports the muted-list rows the page renders, newest first', async () => {
  const rows = ['Slop_A', 'slop_b', 'other'].map(
    (h) => `<div data-testid="UserCell"><a href="/${h}"><img alt=""></a><a href="/${h}">@${h}</a></div>`,
  );
  const t = runContent(page([meLink(ME), ...rows]), { pathname: '/settings/muted/all', state: muting, job: job({ kind: 'check', handle: null }) });
  assert.deepEqual(await t.done, { id: 'j1', status: 'checked', rows: ['slop_a', 'slop_b', 'other'] });
});

test("the user's own tabs get no job and no click, even with muting on", async () => {
  const t = runContent(profile([postWithCaret({ author: H })]), { pathname: '/home', state: muting });
  const clicks = wireMenu(t.document, { items: MENU, handle: H });
  for (let i = 0; i < 10; i++) await tick();
  await new Promise((r) => setTimeout(r, 600));
  assert.deepEqual(clicks, []);
  assert.equal(t.document.querySelector('[role="menu"]'), null);
});

test('a listed post seen while browsing is sent once as a sighting, only while muting is on', async () => {
  let t = runContent(page([post({ author: H, status: '1' }), post({ author: H, status: '2' })]), { state: muting });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(t.hidden('1'), true);
  assert.deepEqual(t.sightings, [H]);
  t = runContent(page([post({ author: H, status: '1' })]), { state: stateWith([H]) });
  for (let i = 0; i < 5; i++) await tick();
  assert.equal(t.hidden('1'), true);
  assert.deepEqual(t.sightings, []);
});

test('stats report the logged-in account the popup binds muting to', async () => {
  const t = runContent(page([meLink('StartupBros')]), { state: stateWith([]) });
  await tick();
  assert.equal(t.content.stats().me, 'startupbros');
});
