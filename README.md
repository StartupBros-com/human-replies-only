# x-slop-hide

**Hide, don't block.** x-slop-hide hides posts on x.com whose author is on a
public, self-updating list of AI-reply spam accounts. It runs in your browser
only, with no X API, no fees, and no change to your X account. Nothing is
muted, blocked or reported. The posts are hidden in this browser profile and
nowhere else, so you can undo it at any time with one click.

The list is [clankwall](https://clankwall.vogel.dev/), read from
`https://clankwall.vogel.dev/api/usernames.txt`. It held 767 handles on
2026-11-06. x-slop-hide does not maintain that list; see
[Whose list is it?](#whose-list-is-it).

## Install

### Extension (Chrome or another Chromium browser, desktop)

1. Download this repository: **Code → Download ZIP** on GitHub, then unzip it.
   Or `git clone https://github.com/StartupBros-com/x-slop-hide`.
2. Open `chrome://extensions` (`brave://extensions` in Brave) and turn on
   **Developer mode**.
3. Click **Load unpacked** and pick the folder that contains `manifest.json`.
4. Open x.com, then click the extension's icon. The popup shows how many
   accounts are listed and when the list was last updated.

An unpacked extension does not update itself. To get a new version, download
again, replace the folder, and click the reload arrow on the extension's card.
The list itself refreshes without that: on install, on browser start when it is
due, and every 6 hours.

### Userscript (Violentmonkey or Tampermonkey)

Install a userscript manager, then open
<https://raw.githubusercontent.com/StartupBros-com/x-slop-hide/main/dist/x-slop-hide.user.js>.
The manager offers to install it. In Chrome and other Chromium browsers, the
manager also needs **Allow User Scripts** turned on under **Details** on its
card in `chrome://extensions`; it is off in a new profile.

The manager's menu has **Pause / resume hiding**, **Show / hide @grok**,
**Refresh list now** and **Edit always-show list**. The manager checks that
URL for updates and installs one when its version number goes up. The script
fetches the list when an x.com page opens and the stored
copy is more than 6 hours old, and checks again every 15 minutes and whenever
the tab comes back into view.

## What gets hidden

- A post is hidden when its own author is on the list. The author is read from
  the post's name block, case-insensitively.
- A post that quotes a listed account, or @-mentions one, stays visible. Only
  the author counts.
- A repost carries the original author's name block, so it should be judged
  by the original author and hidden when that author is listed. This has not
  been checked against a live repost yet.
- On any page under a listed account's handle (its profile `/handle`,
  `/handle/with_replies`, one of its posts `/handle/status/...`, and so on),
  that account's posts stay visible. You went there on purpose. Other listed
  accounts replying there are still hidden.
- **@grok** is on the clankwall list, so its posts are hidden unless you turn
  on **Show @grok's replies** in the popup (or **Show / hide @grok** in the
  userscript menu). That switch shows all of @grok's posts and no other
  account's.
- **Always show**: handles in the popup's allowlist are never hidden. Use it
  for any other account you want to see.
- **Pause** shows everything again until you turn it back on.

## Whose list is it?

The list is clankwall's, not this project's. clankwall says its list is "not
proof of authorship" and states no licence or uptime terms. x-slop-hide fetches
it at run time and does not copy it into this repository.

If you think an account is listed by mistake, clankwall's homepage says: "To
dispute your listing, email dispute-spam@ryan.ceo" (as of 2026-11-06).
x-slop-hide cannot remove anyone from the list. To see an account anyway, add
it to Always show.

x-slop-hide is not affiliated with X Corp or with clankwall.

## How list updates stay safe

An update replaces the stored list only if it looks like a list. If the fetch
fails, times out, returns HTML, is over 1 MB or 50,000 handles, is mostly lines
that are not handles, is empty, or has fewer than half as many handles as the
stored list (once that list has 20 or more), the previous list stays in place
and the popup shows why. A broken or truncated feed cannot empty your filter.

## Permissions and privacy

- `storage` holds the list and your settings. `alarms` schedules the refresh.
- The content script runs on x.com, twitter.com and their `mobile.` hosts. It
  makes no network requests; it reads the page, adds one style rule, and sets
  an attribute on the cells it hides.
- The one network request is the feed fetch, from the background worker, to
  `clankwall.vogel.dev` (the only host permission). It sends no cookies
  (`credentials: 'omit'`) and bypasses the cache. The userscript makes the same
  request through its manager (`@connect clankwall.vogel.dev`, anonymous).
- Nothing is collected or sent anywhere else. There is no analytics.
- The feed URL is a setting (`feedUrl` in `xsh:settings`) with no UI yet. A
  feed on another host also needs that host added to `host_permissions` in
  `manifest.json` (unless it serves CORS headers), or, for the userscript, an
  `@connect` line for it.

## Limits

- **Handles, not accounts.** The feed lists handles. An account that renames
  itself escapes until the list catches up, and a handle that is released and
  re-registered would hide its new owner.
- **The list is someone else's judgement.** If the feed goes away, the last
  good list stays in use.
- **Desktop browser only.** Nothing client-side reaches the X app or mobile
  browsers.
- **Scrolling cost.** When nothing on screen matches, there is no measurable
  cost (home timeline, full list loaded: p95 21.7 and 20.9 ms against a
  baseline of 24.1 and 20.5 ms). When cells are hidden, X re-lays out its
  list, and scroll frames get slower: on a profile's replies page with 4 of
  the 11 to 17 rendered posts hidden, the 95th-percentile scroll frame went
  from about 20 ms to 30-41 ms.
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
  author detection, the hide rule and the @grok switch). Shared by every
  runtime and the tests.
- `src/content.js`: the content script. It watches the page and marks the
  cells to hide.
- `src/background.js`: the service worker that fetches the feed and stores it.
- `src/popup.*`: the popup.
- `src/userscript-adapter.js` and `scripts/build-userscript.mjs`: the
  userscript build, which concatenates `lib.js`, the adapter and `content.js`.
  A release bumps `version` in `manifest.json` (and `package.json`), because
  userscript managers update only when it goes up.

The DOM tests run the real `content.js` against [linkedom](https://github.com/WebReflection/linkedom)
documents shaped like X's markup. Their handles are made up. They cannot catch
X changing that markup, so after a change to the selectors, check on real
x.com: load the extension, scroll a busy reply thread, and confirm that each
hidden post's `@handle` is on the list and that no listed author's post is
left showing.

Issues and pull requests are welcome.

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

On 2026-11-06, the same setup passed 22 of 22 checks: 20 page-change scenarios,
including X removing, recycling and reinserting post cells, plus 2 setup
checks. Each scenario ended with exactly the listed authors hidden.

Also on 2026-11-06, version 0.2.0 ran in Chromium 156 the same way, twice:

- **Userscript, in Violentmonkey 2.50.0.** Opening a `.user.js` URL on a
  local web server brought up Violentmonkey's install page, which showed
  version 0.2.0 and `@connect clankwall.vogel.dev`. After install, the script
  fetched the real list (767 handles) through the manager, hid @grok and a
  listed author, and left an unlisted account showing. After a reload it hid
  them again from the stored list without fetching it again. Violentmonkey's
  menu showed all four commands, and **Show / hide @grok** showed @grok's post
  while the listed author stayed hidden. 10 of 10 checks passed: 8 on the
  script and 2 setup checks.
- **Extension.** The popup's **Show @grok's replies** box started unticked.
  Ticking it showed @grok's post in an open x.com tab while the listed author
  stayed hidden; the box was still ticked when the popup reopened; unticking
  it hid @grok again. On @grok's own profile its posts showed with the switch
  off. 9 of 9 checks passed: 8 on the extension and 1 setup check.

Not tested: Brave itself, Tampermonkey, Violentmonkey in Firefox, the 6-hour
refresh actually firing, reposts, and the notifications page.

## License

[MIT](LICENSE). The list is not part of this repository and is not covered by
this licence.
