// Runs the real src/content.js against linkedom documents shaped like x.com.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseHTML } from 'linkedom';
import { lib, post, page, runContent, stateWith, tick } from './helpers.mjs';

const LIST = ['kaibgr', 'frontmostai', 'grok'];

function article(html) {
  return parseHTML(page([html])).document.querySelector('article');
}

test('authorHandleOf reads the post author, case-insensitively', () => {
  assert.equal(lib.authorHandleOf(article(post({ author: 'KaiBGR' }))), 'kaibgr');
});

test('the first author block wins over a later quote card or @-mention', () => {
  assert.equal(lib.authorHandleOf(article(post({ author: 'realhuman', quote: 'kaibgr' }))), 'realhuman');
  assert.equal(lib.authorHandleOf(article(post({ author: 'realhuman', mention: 'kaibgr' }))), 'realhuman');
});

// Planted negative: before X renders the author block, the quote card's
// User-Name is the only one present and must never be taken as the author.
test('a quote card is never read as the author while the author block is missing', () => {
  assert.equal(lib.authorHandleOf(article(post({ author: 'realhuman', authorBlock: false, quote: 'kaibgr' }))), null);
});

test('hides cells authored by listed accounts and nothing else', async () => {
  const t = runContent(
    page([
      post({ author: 'KaiBGR', status: '1' }),
      post({ author: 'realhuman', status: '2' }),
      post({ author: 'realhuman', quote: 'kaibgr', status: '3' }),
      post({ author: 'friend', mention: 'frontmostai', status: '4' }),
      post({ author: 'frontmostai', quote: 'realhuman', status: '5' }),
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
  assert.deepEqual(Array.from(s.hiddenAuthors), ['frontmostai', 'kaibgr']);
});

test('allowlist and pause unhide, and resuming hides again', async () => {
  const t = runContent(page([post({ author: 'grok', status: '1' }), post({ author: 'kaibgr', status: '2' })]), {
    state: stateWith(LIST, { allowlist: 'grok' }),
  });
  await tick();
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [false, true]);
  t.push(stateWith(LIST, { allowlist: 'grok', paused: true }));
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [false, false]);
  t.push(stateWith(LIST, { paused: false }));
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [true, true]);
});

test("a listed account's own profile shows their posts but hides other listed replies", async () => {
  const t = runContent(page([post({ author: 'kaibgr', status: '1' }), post({ author: 'frontmostai', status: '2' })]), {
    pathname: '/KaiBGR/with_replies',
    state: stateWith(LIST),
  });
  await tick();
  assert.deepEqual([t.hidden('1'), t.hidden('2')], [false, true]);
});

test('posts added later are hidden, including when the author block arrives late', async () => {
  const t = runContent(page([post({ author: 'realhuman', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  const timeline = t.document.querySelector('[aria-label="Timeline"]');
  timeline.insertAdjacentHTML('beforeend', post({ author: 'kaibgr', status: '2' }));
  // The shell first, then X fills in the author block.
  timeline.insertAdjacentHTML('beforeend', post({ author: 'frontmostai', status: '3', authorBlock: false }));
  await tick();
  assert.deepEqual([t.hidden('1'), t.hidden('2'), t.hidden('3')], [false, true, false]);
  const art3 = t.document.querySelector('[data-fixture="3"] article');
  art3.insertAdjacentHTML('afterbegin', parseHTML(page([post({ author: 'frontmostai' })])).document.querySelector('[data-testid="User-Name"]').outerHTML);
  await tick();
  assert.equal(t.hidden('3'), true);
});

test('navigating onto a listed profile re-evaluates already rendered posts', async () => {
  const t = runContent(page([post({ author: 'kaibgr', status: '1' })]), { state: stateWith(LIST) });
  await tick();
  assert.equal(t.hidden('1'), true);
  t.location.pathname = '/kaibgr';
  t.document.querySelector('main').insertAdjacentHTML('beforeend', '<div></div>');
  await tick();
  assert.equal(t.hidden('1'), false);
});

test('a post shell holding only a listed quote card stays visible, before and after its author renders', async () => {
  const t = runContent(page([post({ author: 'realhuman', authorBlock: false, quote: 'kaibgr', status: '1' })]), {
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
  const t = runContent(page([post({ author: 'kaibgr', status: '1' })]), { state: { list: null, settings: {} } });
  await tick();
  assert.equal(t.hidden('1'), false);
});
