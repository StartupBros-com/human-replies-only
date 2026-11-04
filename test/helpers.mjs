import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { parseHTML } from 'linkedom';

export const root = join(dirname(fileURLToPath(import.meta.url)), '..');
export const src = (p) => readFileSync(join(root, p), 'utf8');
export const lib = createRequire(import.meta.url)('../src/lib.js');

export const tick = () => new Promise((r) => setTimeout(r, 0));

// A post shaped like x.com's markup as observed live on 2026-11-03: the
// author's links sit in the first [data-testid="User-Name"]; a quoted post is a
// [role="link"] card inside the article carrying its own User-Name block.
export function post({ author, quote = null, mention = null, status = '1', authorBlock = true }) {
  const userName = authorBlock
    ? `<div data-testid="User-Name"><div><a href="/${author}" role="link"><span>Name</span></a></div>` +
      `<div><a href="/${author}" role="link" tabindex="-1"><span>@${author}</span></a>` +
      `<a href="/${author}/status/${status}" role="link"><time datetime="2026-11-03T00:00:00.000Z">1h</time></a></div></div>`
    : '';
  const text = `<div data-testid="tweetText"><span>hello </span>${mention ? `<a href="/${mention}" role="link">@${mention}</a>` : ''}</div>`;
  const quoteCard = quote
    ? `<div role="link" tabindex="0"><div data-testid="User-Name"><a href="/${quote}"><span>@${quote}</span></a></div>` +
      `<div data-testid="tweetText">quoted text</div></div>`
    : '';
  return (
    `<div data-testid="cellInnerDiv" data-fixture="${status}"><div><article data-testid="tweet" role="article" tabindex="0">` +
    `${userName}${text}${quoteCard}</article></div></div>`
  );
}

export function page(cells) {
  return `<!doctype html><html><head></head><body><main><div aria-label="Timeline">${cells.join('')}</div></main></body></html>`;
}

// Run lib.js + content.js in a VM whose globals are a linkedom window, with a
// test adapter standing in for chrome.storage. Returns handles for the test.
export function runContent(html, { pathname = '/home', state = {} } = {}) {
  const { window, document, MutationObserver } = parseHTML(html);
  const location = { pathname };
  let subscriber = null;
  let current = state;
  let deliverMutations = null;
  let observed = null;
  // linkedom v0.18.15 reports the observed root, not the mutated parent, as
  // childList target. Tests may deliver a native-shaped record explicitly.
  // https://github.com/WebReflection/linkedom/blob/v0.18.15/esm/interface/mutation-observer.js#L85-L107
  class TestObserver extends MutationObserver {
    constructor(cb) {
      super(cb);
      deliverMutations = cb;
    }
    observe(target, options) {
      observed = { target, options };
      super.observe(target, options);
    }
  }
  const adapter = {
    load: () => Promise.resolve(current),
    subscribe(cb) {
      subscriber = cb;
    },
  };
  const ctx = vm.createContext({ window, document, location, MutationObserver: TestObserver, XSlopHideAdapter: adapter, console });
  vm.runInContext(src('src/lib.js'), ctx, { filename: 'src/lib.js' });
  vm.runInContext(src('src/content.js'), ctx, { filename: 'src/content.js' });
  const cell = (status) => document.querySelector(`[data-fixture="${status}"]`);
  return {
    document,
    location,
    hidden: (status) => cell(status).hasAttribute('data-xsh-hidden'),
    push(next) {
      current = next;
      subscriber(next);
    },
    content: ctx.XSlopHideContent,
    deliverMutations(records) { deliverMutations(records); },
    observed() { return observed; },
  };
}

export function stateWith(handles, settings = {}) {
  return { list: { handles, fetchedAt: 1 }, settings };
}
