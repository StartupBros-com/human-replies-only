// Runs the real src/content.js label pairs against a linkedom post page shaped
// like x.com's: the post the page is about first, replies under it.
import test from 'node:test';
import assert from 'node:assert/strict';
import { post, page, meLink, runContent, stateWith, tick } from './helpers.mjs';

const settle = async () => {
  for (let i = 0; i < 5; i++) await tick();
};

const PAGE = '/op/status/1';
const THREAD = [post({ author: 'op', status: '1' }), post({ author: 'reply_a', status: '2' }), post({ author: 'reply_b', quote: 'someone', status: '3' })];
const on = (settings = {}, handles = []) => stateWith(handles, { labeling: true, ...settings });

// A failing assertion prints its values, and printing a linkedom node walks
// the whole document, which hangs the run: check a node's absence as a boolean.
const absent = (el) => el === null;
const bar = (t, status) => t.document.querySelector(`[data-fixture="${status}"] [data-xsh-bar]`);
const bars = (t) => t.document.querySelectorAll('[data-xsh-bar]').length;
const button = (t, status, label) => bar(t, status).querySelector(`[data-xsh-label="${label}"]`);
const note = (t, status) => bar(t, status).querySelector('[data-xsh-note]').textContent;
const pressed = (t, status) =>
  [...bar(t, status).querySelectorAll('[data-xsh-label]')].filter((b) => b.getAttribute('aria-pressed') === 'true').map((b) => b.getAttribute('data-xsh-label'));

// A click as the user makes it (`trusted`), or as a page script makes it.
function click(t, el, trusted = true) {
  const e = new t.window.Event('click', { bubbles: true, cancelable: true });
  Object.defineProperty(e, 'isTrusted', { value: trusted });
  el.dispatchEvent(e);
  return e;
}

test("with labelling on, a post's page gets a Slop / Not slop pair under each reply and none under the post itself", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  assert.equal(absent(bar(t, '1')), true, 'the post the page is about');
  assert.deepEqual(['2', '3'].map((s) => bar(t, s).getAttribute('data-xsh-bar')), ['2', '3']);
  assert.deepEqual(['2', '3'].map((s) => bar(t, s).getAttribute('data-xsh-author')), ['reply_a', 'reply_b']);
  assert.deepEqual([...bar(t, '2').querySelectorAll('button')].map((b) => b.textContent), ['Slop', 'Not slop']);
  assert.deepEqual(pressed(t, '2'), []);
  assert.equal(bars(t), 2);
  assert.ok(t.document.getElementById('xsh-bar-style'), 'the pair has its look');
  assert.equal(t.document.getElementById('xsh-style').textContent, '[data-xsh-hidden]{display:none!important}', 'the hide rule is unchanged');
});

test('no pair off a post page, with labelling off, or without a way to save (the userscript)', async () => {
  const home = runContent(page(THREAD), { pathname: '/home', state: on(), labels: {} });
  const profile = runContent(page(THREAD), { pathname: '/op', state: on(), labels: {} });
  const off = runContent(page(THREAD), { pathname: PAGE, state: stateWith([]), labels: {} });
  const truthy = runContent(page(THREAD), { pathname: PAGE, state: stateWith([], { labeling: 'true' }), labels: {} });
  const noSave = runContent(page(THREAD), { pathname: PAGE, state: on() });
  await settle();
  for (const t of [home, profile, off, truthy, noSave]) assert.equal(bars(t), 0);
  for (const t of [off, truthy, noSave]) assert.equal(absent(t.document.getElementById('xsh-bar-style')), true, 'no CSS while labelling is off');
  // Turned on, the pairs appear; turned off, they go.
  off.push(on());
  await settle();
  assert.equal(bars(off), 2);
  off.push(stateWith([], { labeling: false }));
  await settle();
  assert.equal(bars(off), 0);
});

test("a click saves the reply's author, link, page and own text; the other button switches; a second click clears", async () => {
  const emoji = post({ author: 'reply_c', status: '4' }).replace('<span>hello </span>', '<span>Great insight </span><img alt="🚀" src="e.svg">');
  const t = runContent(page([...THREAD, emoji]), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  click(t, button(t, '2', 'slop'));
  await settle();
  assert.deepEqual(t.saves, [{ label: 'slop', handle: 'reply_a', url: '/reply_a/status/2', page: PAGE, text: 'hello' }]);
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.deepEqual(pressed(t, '3'), [], 'only the clicked reply');
  click(t, button(t, '2', 'not_slop'));
  await settle();
  assert.equal(t.saves[1].label, 'not_slop');
  assert.deepEqual(pressed(t, '2'), ['not_slop']);
  click(t, button(t, '2', 'not_slop'));
  await settle();
  assert.equal(t.saves[2].label, null);
  assert.deepEqual(pressed(t, '2'), []);
  // A quoted post's text is not the reply's; emoji come from their alt text.
  click(t, button(t, '3', 'slop'));
  click(t, button(t, '4', 'slop'));
  await settle();
  assert.deepEqual(t.saves.slice(3).map((s) => s.text), ['hello', 'Great insight 🚀']);
});

test("nothing done in a pair reaches X's handlers, and a click made by the page's own script is ignored", async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: {} });
  await settle();
  const types = ['click', 'auxclick', 'dblclick', 'mousedown', 'mouseup', 'pointerdown', 'pointerup', 'touchstart', 'touchend', 'keydown', 'keyup'];
  const reached = [];
  const article = t.document.querySelector('[data-fixture="2"] article');
  for (const type of types) {
    article.addEventListener(type, () => reached.push(type));
    t.document.addEventListener(type, () => reached.push(`document ${type}`));
  }
  // The listeners work: a click on the reply's text reaches both.
  article.querySelector('[data-testid="tweetText"]').dispatchEvent(new t.window.Event('click', { bubbles: true }));
  assert.deepEqual(reached, ['click', 'document click']);
  reached.length = 0;
  for (const type of types) {
    const e = new t.window.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(e, 'isTrusted', { value: false });
    button(t, '2', 'slop').dispatchEvent(e);
  }
  await settle();
  assert.deepEqual(reached, []);
  assert.deepEqual(t.saves, [], 'a scripted click saves nothing');
  const e = click(t, button(t, '2', 'slop'));
  await settle();
  assert.deepEqual(reached, []);
  assert.equal(e.defaultPrevented, true);
  assert.equal(t.saves.length, 1);
});

test('a cell X reuses for another post moves its pair to that post; one for the post the page is about loses it', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 9: 'slop' } } });
  await settle();
  click(t, button(t, '2', 'not_slop'));
  await settle();
  // X rewrites the cell's links in place for post 9 by @reply_c.
  const article = t.document.querySelector('[data-fixture="2"] article');
  for (const a of article.querySelectorAll('a')) a.setAttribute('href', a.getAttribute('href').replace('reply_a', 'reply_c').replace('/status/2', '/status/9'));
  const link = article.querySelector('time').closest('a');
  t.deliverMutations([{ type: 'attributes', target: link, attributeName: 'href', addedNodes: [], removedNodes: [] }]);
  await settle();
  assert.equal(article.querySelectorAll('[data-xsh-bar]').length, 1, 'one pair per post');
  assert.equal(bar(t, '2').getAttribute('data-xsh-bar'), '9');
  assert.equal(bar(t, '2').getAttribute('data-xsh-author'), 'reply_c');
  assert.deepEqual(pressed(t, '2'), ['slop'], "post 9's saved label, not post 2's");
  click(t, button(t, '2', 'slop'));
  await settle();
  assert.deepEqual(t.saves.at(-1), { label: null, handle: 'reply_c', url: '/reply_c/status/9', page: PAGE, text: 'hello' });
  // Reused for the post the page is about.
  const other = t.document.querySelector('[data-fixture="3"] article');
  for (const a of other.querySelectorAll('[data-testid="User-Name"] a')) {
    if (!a.closest('[role="link"][tabindex="0"]')) a.setAttribute('href', a.getAttribute('href').replace('reply_b', 'op').replace('/status/3', '/status/1'));
  }
  t.deliverMutations([{ type: 'attributes', target: other.querySelector('time').closest('a'), attributeName: 'href', addedNodes: [], removedNodes: [] }]);
  await settle();
  assert.equal(absent(bar(t, '3')), true);
});

test('saved labels show when a pair appears, and a change made in another tab shows at once', async () => {
  const t = runContent(page(THREAD), { pathname: PAGE, state: on(), labels: { stored: { 2: 'slop' } } });
  await settle();
  assert.deepEqual(pressed(t, '2'), ['slop']);
  assert.deepEqual(pressed(t, '3'), []);
  t.labelChange('3', 'not_slop');
  assert.deepEqual(pressed(t, '3'), ['not_slop']);
  t.labelChange('2', null);
  assert.deepEqual(pressed(t, '2'), []);
});

test('a refused save says why on the pair, and the pair says when the list or a box already has the account', async () => {
  const cells = [...THREAD, post({ author: 'slop_x', status: '4' }), post({ author: 'pal', status: '5' })];
  const t = runContent(page(cells), {
    pathname: PAGE,
    state: on({ allowlist: 'pal', extraList: 'reply_b' }, ['slop_x']),
    labels: { answer: () => ({ ok: false, reason: 'labels are off' }) },
  });
  await settle();
  assert.deepEqual(['2', '3', '4', '5'].map((s) => note(t, s)), ['', 'in Also hide', 'on the list', 'in Always show']);
  assert.equal(t.hidden('4'), true, 'a hidden reply keeps its pair, for when hiding is paused');
  click(t, button(t, '2', 'slop'));
  await settle();
  assert.equal(note(t, '2'), 'not saved: labels are off');
  assert.deepEqual(pressed(t, '2'), []);
});

test("a tab says it is the user's own x.com tab only when it was given no job, and waits for that answer", async () => {
  let give;
  const later = new Promise((r) => (give = r));
  const t = runContent(page(THREAD), { state: stateWith([]), job: later, present: true });
  let answer = 'none yet';
  t.present().then((v) => (answer = v));
  await settle();
  assert.equal(answer, 'none yet', 'still waiting to hear whether this tab has a job');
  give(null);
  await settle();
  assert.equal(answer, true);
  // A job tab (here one logged in as another account, which stops at once).
  const jobTab = runContent(page([meLink('other'), post({ author: 'slop_a', status: '1' })]), {
    pathname: '/slop_a',
    state: stateWith(['slop_a'], { muteEnabled: true, muteAccount: 'startupbros' }),
    job: { id: 'j1', kind: 'mute', handle: 'slop_a', account: 'startupbros', waitMs: 400 },
    present: true,
  });
  assert.equal(await jobTab.present(), false);
  assert.equal((await jobTab.done).status, 'wrong-account');
});
