# x-slop-hide

Hides posts on x.com when the post's author is on a public list of AI-reply
spam accounts. The list updates itself. It runs in your browser only: no X API,
no fees, and nothing changes on your X account. Nothing is muted, blocked or
reported; the posts are hidden in this browser profile and nowhere else.

The default list is [clankwall](https://clankwall.vogel.dev/)'s
`https://clankwall.vogel.dev/api/usernames.txt`, about 370 handles at the time
of writing.

## Install (Brave or Chrome, desktop)

1. Get this folder onto the machine that runs the browser (clone it, or
   download and unzip it). On Windows with the repo in WSL, copy the
   extension files (`manifest.json` and `src/`) to a Windows folder such as
   `C:\Users\<you>\x-slop-hide`. Loading straight from `\\wsl.localhost` has
   not been tried.
2. Open `brave://extensions` (or `chrome://extensions`) and turn on
   **Developer mode**.
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Open x.com. The extension's popup should show about 370 listed accounts and
   when the list was last updated.

The list refreshes itself on install, on browser start when it is due, and every
6 hours. To pick up new code, pull or re-copy the folder and click the reload
arrow on the extension's card.

### Userscript instead

`dist/x-slop-hide.user.js` carries the same logic for Violentmonkey or
Tampermonkey: open the file in the manager and install it. Its menu has pause,
refresh and the always-show list. This mode has unit tests but has not been run
under a real userscript manager.

## What gets hidden

- A post is hidden when its own author is on the list. The author is read from
  the post's name block, case-insensitively.
- A post that quotes a listed account, or @-mentions one, stays visible. Only
  the author counts.
- A repost carries the original author's name block, so it should be judged
  by the original author and hidden when that author is listed. This has not
  been checked against a live repost yet.
- On a listed account's own profile (`/handle`, `/handle/with_replies`) or on
  one of its posts (`/handle/status/...`), that account's posts stay visible.
  You went there on purpose. Other listed accounts replying there are still
  hidden.
- **Always show**: handles in the popup's allowlist are never hidden. `@grok`
  is on the clankwall list, so add `grok` there if you want to see Grok's
  replies.
- **Pause** shows everything again until you turn it back on.

## How list updates stay safe

An update replaces the stored list only if it looks like a list. The previous
list stays in place, and the popup shows why, when the fetch fails, times out,
returns HTML, is over 1 MB or 50,000 handles, is mostly lines that are not
handles, is empty, or has fewer than half as many handles as the stored list
(once that list has 20 or more). A broken or truncated feed cannot empty your
filter.

## Permissions and privacy

- `storage` holds the list and your settings. `alarms` schedules the refresh.
- The content script runs on x.com, twitter.com and their `mobile.` hosts. It
  makes no network requests; it only reads the page and sets an attribute.
- The one network request is the feed fetch, from the background worker, to
  `clankwall.vogel.dev` (the only host permission). It sends no cookies
  (`credentials: 'omit'`) and bypasses the cache.
- The feed URL is a setting (`feedUrl` in `xsh:settings`) with no UI yet. A
  feed on another host also needs that host added to `host_permissions` in
  `manifest.json`, unless it serves CORS headers.

## Limits

- **Handles, not accounts.** The feed lists handles. An account that renames
  itself escapes until the list catches up, and a handle that is released and
  re-registered would hide its new owner.
- **The list is someone else's judgement.** clankwall says its list is "not
  proof of authorship" and states no licence or uptime terms. If the feed goes
  away, the last good list stays in use.
- **Desktop browser only.** Nothing client-side reaches the X app or Brave on
  mobile.
- **Scrolling cost.** When nothing on screen matches, there is no measurable
  cost (home timeline, full list loaded: p95 21.7 and 20.9 ms against a
  baseline of 24.1 and 20.5 ms). When cells are hidden, X re-lays out its
  list, and scroll frames get
  slower: on a profile's replies page with 4 of the 11 to 17 rendered posts
  hidden, the 95th-percentile scroll frame went from about 20 ms to 30-41 ms.
- **X's markup.** The script relies on X's `data-testid` attributes
  (`tweet`, `User-Name`, `cellInnerDiv`). If X renames them, nothing is hidden
  until the selectors are updated; it fails open, not closed.
- Only post cells are hidden. Notification rows that are not posts ("X liked
  your post") are not.

## Development

```
pnpm install
pnpm test            # node --test 'test/*.test.mjs'
pnpm run build       # rebuild dist/x-slop-hide.user.js from src/
pnpm run check       # userscript is current + parses + tests (what CI runs)
```

- `src/lib.js`: pure logic (list parsing and validation, the update guard,
  author detection, the hide rule). Shared by every runtime and the tests.
- `src/content.js`: the content script. It watches the page and marks the
  cells to hide.
- `src/background.js`: the service worker that fetches the feed and stores it.
- `src/popup.*`: the popup.
- `src/userscript-adapter.js` and `scripts/build-userscript.mjs`: the
  userscript build, which concatenates `lib.js`, the adapter and `content.js`.

The DOM tests run the real `content.js` against [linkedom](https://github.com/WebReflection/linkedom)
documents shaped like X's markup. They cannot catch X changing that markup, so
after a change to the selectors, check on real x.com: load the extension,
scroll a busy reply thread, and confirm that each hidden post's `@handle` is on
the list and that no listed author's post is left showing.

## Tested

On 2026-11-03, the real `lib.js` and `content.js` were injected into a logged-in
x.com tab through the DevTools protocol, with a stub in place of extension
storage. A separate oracle read each post's visible `@handle` text (not the
script's own href matcher) and compared it with what was hidden.

| Page | Distinct posts | Should hide | Hidden | Mismatches |
|---|---|---|---|---|
| A listed account's `/with_replies` | 47 | 6 | 6 | 0 |
| Reply thread, 251 replies (reached by in-app navigation) | 118 | 12 | 12 | 0 |
| Reply thread, 105 replies | 106 | 13 | 13 | 0 |
| Home timeline | 25 | 0 | 0 | 0 |

The listed account's own posts stayed visible on its profile and were hidden on
other threads. Frame-time p95 was 20.3 and 19.9 ms before injection, 20.3 and
19.6 ms injected with hiding paused, and 30-41 ms with hiding on.

Frame times were measured on the listed account's `/with_replies` page.

The unpacked extension was also run in Chromium 156 (headless, through
Playwright) with x.com URLs answered by fixture pages: the service worker
fetched the real feed on install and scheduled the 360-minute alarm; the
content script hid exactly the listed authors and skipped the own profile;
the popup showed the list, read the active tab's counts, and its pause,
allowlist and refresh controls took effect. The only requests outside the
fixtures were the feed URL, once at install and once on refresh.

Not tested: Brave itself, the alarm actually firing after 6 hours, the
userscript under a real manager, reposts, and the notifications page.
