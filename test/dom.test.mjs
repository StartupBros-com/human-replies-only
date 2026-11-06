// Runs the real src/content.js against linkedom documents shaped like x.com.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { lib, post, page, runContent, stateWith, tick } from './helpers.mjs';

const LIST = ['known_slop', 'fake_slop', 'grok'];

function article(html) {
  return parseHTML(page([html])).document.querySelector('article');
}

test('authorHandleOf reads the post author, case-insensitively', () => {
  assert.equal(lib.authorHandleOf(article(post({ author: 'Known_Slop' }))), 'known_slop');
});

test('the first author block wins over a later quote card or @-mention', () => {
  assert.equal(lib.authorHandleOf(article(post({ author: 'realhuman', quote: 'known_slop' }))), 'realhuman');
  assert.equal(lib.authorHandleOf(article(post({ author: 'realhuman', mention: 'known_slop' }))), 'realhuman');
});

// Planted negative: before X renders the author block, the quote card's
// User-Name is the only one present and must never be taken as the author.
test('a quote card is never read as the author while the author block is missing', () => {
  assert.equal(lib.authorHandleOf(article(post({ author: 'realhuman', authorBlock: false, quote: 'known_slop' }))), null);
});

test('hides cells authored by listed accounts and nothing else', async () => {
  const t = runContent(
    page([
      post({ author: 'Known_Slop', status: '1' }),
      post({ author: 'realhuman', status: '2' }),
      post({ author: 'realhuman', quote: 'known_slop', status: '3' }),
      post({ author: 'friend', mention: 'fake_slop', status: '4' }),
      post({ author: 'fake_slop', quote: 'realhuman', status: '5' }),
    ]),
    { state: stateWith(LIST) },
  );
  await tick();
  assert.deepEqual(['1', '2', '3', '4', '5'].map(t.hidden), [true, false, false, false, true]);
  assert.equal(t.document.getElementById('xsh-style').textContent, '[data-xsh-hidden]{display:none!important}');
  const s = t.content.stats();
  assert.equal(s.hiddenNow, 2);
  assert.equal(s.hiddenPosts, 2);
  // Array.from: the stats object comes from the VM's realm.
  assert.deepEqual(Array.from(s.hiddenAuthors), ['fake_slop', 'known_slop']);
});

test('allowlist and pause unhide, and resuming hides again', async () => {
  const t = runContent(page([post({ author: 'grok', status: '1' }), post({ author: 'known_slop', status: '2' })]), {
    state: stateWith(LIST, { allowlist: 'grok' }),
  });
  await tick();
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [false, true]);
  t.push(stateWith(LIST, { allowlist: 'grok', paused: true }));
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [false, false]);
  t.push(stateWith(LIST, { paused: false }));
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [true, true]);
});

// Planted negative: with no settings saved, @grok is hidden like any listed author.
test('@grok is hidden by default and shown only while showGrok is on', async () => {
  const t = runContent(page([post({ author: 'grok', status: '1' }), post({ author: 'known_slop', status: '2' })]), {
    state: stateWith(LIST),
  });
  await tick();
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [true, true]);
  t.push(stateWith(LIST, { showGrok: true }));
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [false, true]);
  t.push(stateWith(LIST, { showGrok: false }));
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [true, true]);
});

test("a listed account's own profile shows their posts but hides other listed replies", async () => {
  const t = runContent(page([post({ author: 'known_slop', status: '1' }), post({ author: 'fake_slop', status: '2' })]), {
    pathname: '/Known_Slop/with_replies',
    state: stateWith(LIST),
  });
  await tick();
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [false, true]);
});

test('posts added later are hidden, including when the author block arrives late', async () => {
  const t = runContent(page([post({ author: 'realhuman', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  const timeline = t.document.querySelector('[aria-label="Timeline"]');
  timeline.insertAdjacentHTML('beforeend', post({ author: 'known_slop', status: '2' }));
  // The shell first, then X fills in the author block.
  timeline.insertAdjacentHTML('beforeend', post({ author: 'fake_slop', status: '3', authorBlock: false }));
  await tick();
  assert.deepEqual([t.hidden('1'), t.hidden('2'), t.hidden('3')], [false, true, false]);
  const art3 = t.document.querySelector('[data-fixture="3"] article');
  art3.insertAdjacentHTML('afterbegin', parseHTML(page([post({ author: 'fake_slop' })])).document.querySelector('[data-testid="User-Name"]').outerHTML);
  await tick();
  assert.equal(t.hidden('3'), true);
});

test('navigating onto a listed profile re-evaluates already rendered posts', async () => {
  const t = runContent(page([post({ author: 'known_slop', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  assert.equal(t.hidden('1'), true);
  t.location.pathname = '/known_slop';
  t.document.querySelector('main').insertAdjacentHTML('beforeend', '<div></div>');
  await tick();
  assert.equal(t.hidden('1'), false);
});

test('a post shell holding only a listed quote card stays visible, before and after its author renders', async () => {
  const t = runContent(page([post({ author: 'realhuman', authorBlock: false, quote: 'known_slop', status: '1' })]), {
    state: stateWith(LIST),
  });
  await tick();
  assert.equal(t.hidden('1'), false);
  const art = t.document.querySelector('[data-fixture="1"] article');
  art.insertAdjacentHTML('afterbegin', parseHTML(page([post({ author: 'realhuman' })])).document.querySelector('[data-testid="User-Name"]').outerHTML);
  await tick();
  assert.equal(t.hidden('1'), false);
});

test('an empty list hides nothing', async () => {
  const t = runContent(page([post({ author: 'known_slop', status: '1' })]), { state: { list: null, settings: {} } });
  await tick();
  assert.equal(t.hidden('1'), false);
});

// These removal tests use real linkedom nodes but inject native-shaped childList
// records: linkedom v0.18.15 reports the observed document as their target.
// Existing addition tests above still exercise linkedom's automatic observer.
test('observer watches document child lists and href changes', async () => {
  const t = runContent(page([]), { state: stateWith(LIST) });
  await tick();
  assert.equal(t.observed().target, t.document);
  assert.deepEqual(JSON.parse(JSON.stringify(t.observed().options)), {
    childList: true, subtree: true, attributes: true, attributeFilter: ['href'],
  });
});

test('removing an author block reveals a previously hidden cell without changing historical stats', async () => {
  const t = runContent(page([post({ author: 'known_slop', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  assert.equal(t.hidden('1'), true);
  const name = t.document.querySelector('[data-fixture="1"] [data-testid="User-Name"]');
  const parent = name.parentNode;
  name.remove();
  t.deliverMutations([{ type: 'childList', target: parent, addedNodes: [], removedNodes: [name] }]);
  await tick();
  assert.equal(t.hidden('1'), false);
  assert.equal(t.content.stats().hiddenNow, 0);
  assert.equal(t.content.stats().hiddenPosts, 1);
  assert.deepEqual(Array.from(t.content.stats().hiddenAuthors), ['known_slop']);
});

test('removing a post or its wrapper clears the retained hidden cell', async () => {
  for (const removeWrapper of [false, true]) {
    const t = runContent(page([post({ author: 'known_slop', status: '1' })]), { state: stateWith(LIST) });
    await tick();
    const cell = t.document.querySelector('[data-fixture="1"]');
    assert.equal(t.hidden('1'), true);
    const removed = removeWrapper ? cell.firstElementChild : cell.querySelector('article');
    const parent = removed.parentNode;
    removed.remove();
    t.deliverMutations([{ type: 'childList', target: parent, addedNodes: [], removedNodes: [removed] }]);
    await tick();
    assert.equal(t.hidden('1'), false);
    assert.equal(t.content.stats().hiddenNow, 0);
    cell.insertAdjacentHTML('beforeend', '<div data-testid="recommendation">Recommended</div>');
    await tick();
    assert.equal(t.hidden('1'), false);
  }
});

test('removing the last usable profile link reveals the post', async () => {
  const t = runContent(page([post({ author: 'known_slop', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  const records = [];
  for (const link of t.document.querySelectorAll('[data-fixture="1"] [data-testid="User-Name"] a')) {
    const parent = link.parentNode;
    link.remove();
    records.push({ type: 'childList', target: parent, addedNodes: [], removedNodes: [link] });
  }
  t.deliverMutations(records);
  await tick();
  assert.equal(t.hidden('1'), false);
});

test('removing an unrelated quote keeps the listed author hidden', async () => {
  const t = runContent(page([post({ author: 'known_slop', quote: 'human', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  const quote = t.document.querySelector('[data-fixture="1"] [role="link"][tabindex="0"]');
  const parent = quote.parentNode;
  quote.remove();
  t.deliverMutations([{ type: 'childList', target: parent, addedNodes: [], removedNodes: [quote] }]);
  await tick();
  assert.equal(t.hidden('1'), true);
});

test('same-batch replacement reflects the new author, not the removed article', async () => {
  const t = runContent(page([post({ author: 'known_slop', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  const cell = t.document.querySelector('[data-fixture="1"]');
  const replacementHolder = t.document.createElement('div');
  replacementHolder.innerHTML = post({ author: 'human', status: '2' });
  const replacement = replacementHolder.querySelector('article');
  const old = cell.querySelector('article');
  const parent = old.parentNode;
  old.replaceWith(replacement);
  t.deliverMutations([{ type: 'childList', target: parent, addedNodes: [replacement], removedNodes: [old] }]);
  await tick();
  assert.equal(t.hidden('1'), false);
  assert.equal(t.content.stats().hiddenPosts, 1);
});

test('a listed post added and removed in one batch does not inflate historical stats', async () => {
  const t = runContent(page([]), { state: stateWith(LIST) });
  await tick();
  const timeline = t.document.querySelector('[aria-label="Timeline"]');
  const holder = t.document.createElement('div');
  holder.innerHTML = post({ author: 'fake_slop', status: '2' });
  const transient = holder.querySelector('[data-fixture="2"]');
  timeline.appendChild(transient);
  transient.remove();
  t.deliverMutations([
    { type: 'childList', target: timeline, addedNodes: [transient], removedNodes: [] },
    { type: 'childList', target: timeline, addedNodes: [], removedNodes: [transient] },
  ]);
  await tick();
  assert.equal(t.content.stats().hiddenNow, 0);
  assert.equal(t.content.stats().hiddenPosts, 0);
  assert.deepEqual(Array.from(t.content.stats().hiddenAuthors), []);
});

test('a hidden cell emptied while detached is cleared when reinserted in a later batch', async () => {
  const t = runContent(page([post({ author: 'known_slop', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  const timeline = t.document.querySelector('[aria-label="Timeline"]');
  const cell = t.document.querySelector('[data-fixture="1"]');
  assert.equal(t.hidden('1'), true);
  cell.remove();
  await tick();
  cell.querySelector('article').remove();
  timeline.appendChild(cell);
  t.deliverMutations([{ type: 'childList', target: timeline, addedNodes: [cell], removedNodes: [] }]);
  await tick();
  assert.equal(t.hidden('1'), false);
  assert.equal(t.content.stats().hiddenNow, 0);
  assert.equal(t.content.stats().hiddenPosts, 1);
  assert.deepEqual(Array.from(t.content.stats().hiddenAuthors), ['known_slop']);
});
