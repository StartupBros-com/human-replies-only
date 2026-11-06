![x-slop-hide: hide, don't block. The same reply thread twice: on x.com with the posts by listed accounts marked, and with x-slop-hide, where those posts are gone.](gh_og_share_image.png)

# x-slop-hide

x-slop-hide hides posts on x.com whose author is on
[clankwall](https://clankwall.vogel.dev/)'s public list of AI-reply spam
accounts, and can also mute those accounts on your X account.

Hiding works on the page in your desktop browser, in this browser profile
only, and the Pause switch shows the posts again. Muting is off until you turn
it on in the extension's popup. It then mutes up to 25 listed accounts a day by
clicking X's own Mute on x.com, so the mutes apply in the X app too. It never
blocks anyone, never unmutes, and does not use the X API. It is free and
MIT-licensed.

Muting is automation of the X website, which X's rules say "may result in the
permanent suspension of your account". Read [Muting](#muting) before you turn
it on.

The list is read from `https://clankwall.vogel.dev/api/usernames.txt`, the
"Plain text" link under clankwall's "AI flags" heading. It held 369 handles on
2026-11-03 and 767 on 2026-11-06. clankwall's separate "Spam flags" table
(2,738 accounts on 2026-11-06) is not used. x-slop-hide does not maintain the
list; see [Whose list is it?](#whose-list-is-it).

To install, open the
[userscript](https://raw.githubusercontent.com/StartupBros-com/x-slop-hide/main/dist/x-slop-hide.user.js)
in a userscript manager (tested with Violentmonkey; Tampermonkey is untested),
or load the Chrome extension unpacked. Both are under [Install](#install). Only
the extension mutes; the userscript hides.

## On a real thread

On 2026-11-03, on a reply thread with 251 replies, x-slop-hide hid 12 of the
118 distinct posts that loaded. All 12 were by listed authors, and no post by a
listed author was left showing. [Tested](#tested) has the method and three more
pages.

## Hide, mute or block

Hiding acts only on the page in your browser. x-slop-hide's muting, and X's own
Mute and Block, act on your X account.

| | Hiding | Muting with x-slop-hide | Mute on X | Block on X |
|---|---|---|---|---|
| Changes your X account | No | Yes: it is X's Mute | Yes | Yes |
| Applies in the X app | No | Yes | Yes | Yes |
| Covering a list of hundreds | Install once; the list refreshes itself | Up to 25 accounts a day, so the 767 listed on 2026-11-06 take about a month | Mute each account from its post or profile | Block each account from its post or profile |
| The account can find out | No | No, as with Mute on X | No: "Muted accounts will not know that you've muted them" | Yes: if it visits your profile, "they will see they have been blocked" |
| Undo | Pause, or add the handle to Always show | Unmute each account on X; x-slop-hide never unmutes | Unmute each account | Unblock each account |

The Mute and Block columns come from X's help pages on
[muting](https://help.x.com/en/using-x/x-mute) and
[blocking](https://help.x.com/en/using-x/blocking-and-unblocking-accounts),
read on 2026-11-06. Hiding cannot reach the X app on your phone; muting can,
because the mutes are X's own.

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

Install a userscript manager (the script was tested in Violentmonkey 2.50.0;
Tampermonkey is untested), then open
<https://raw.githubusercontent.com/StartupBros-com/x-slop-hide/main/dist/x-slop-hide.user.js>.
The manager offers to install it. In Chrome and other Chromium browsers, the
manager also needs **Allow User Scripts** turned on under **Details** on its
card in `chrome://extensions`; it is off in a new profile.

The manager checks that URL for updates and installs one when its version
number goes up. The script fetches the list when an x.com page opens and the
stored copy is more than 6 hours old, and checks again every 15 minutes and
whenever the tab comes back into view. The userscript does not mute.

## Controls

| To | In the extension popup | In the userscript menu |
|---|---|---|
| Show everything for a while | Tick **Pause hiding** | **Pause / resume hiding** |
| See @grok's posts | Tick **Show @grok's replies** | **Show / hide @grok** |
| Always see an account | Add its handle under **Always show these accounts**, then click **Save** | **Edit always-show list** |
| Fetch the list now | **Refresh list now** | **Refresh list now** |
| Mute listed accounts on your X account | Tick **Mute listed accounts on X** (see [Muting](#muting)) | Not available |

On an x.com tab, the popup also counts what it hid there: "This tab: N posts
from M accounts hidden (K on screen now)." The userscript has no counter.

## What gets hidden

- A post is hidden when its own author is on the list. The author is read from
  the post's name block, case-insensitively.
- A post that quotes a listed account, or @-mentions one, stays visible. Only
  the author counts.
- A repost carries the original author's name block, so it should be judged by
  the original author and hidden when that author is listed. This has not been
  checked against a live repost yet.
- On any page under a listed account's handle (its profile `/handle`,
  `/handle/with_replies`, one of its posts `/handle/status/...`, and so on),
  that account's posts stay visible, since you went there on purpose. Other
  listed accounts replying there are still hidden.
- @grok is on the clankwall list, so its posts are hidden unless you turn on
  **Show @grok's replies** in the popup (or **Show / hide @grok** in the
  userscript menu). That switch shows all of @grok's posts and no other
  account's.
- Handles in **Always show these accounts** are never hidden, and
  **Pause hiding** shows every post until you untick it.

## Muting

Muting is in the extension only, and it is off until you turn it on.

### Before you turn it on

Under "Don't!", X's
[automation rules](https://help.x.com/en/rules-and-policies/x-automation)
list: "Use non-API-based forms of automation, such as scripting the X website.
The use of these techniques may result in the permanent suspension of your
account." (read on 2026-11-06). Muting with x-slop-hide scripts the X website,
and the popup says so next to the switch. Turn it on only if you accept that
risk for the account you mute from.

### Turning it on

1. Under **Always show these accounts**, add every listed account you never
   want muted, and click **Save**. Accounts there are never hidden and never
   muted.
2. Open x.com in a tab, logged in as the account to mute from.
3. From that tab, open the popup and tick **Mute listed accounts on X**. The
   popup asks the tab which account is logged in and ties muting to that
   account. If it cannot tell, it leaves the box unticked and says "Open x.com
   in this tab, logged in as the account to mute from, then turn this on."

Unticking the box starts no new visits. A visit already under way either
finishes, and is recorded like any other, or is dropped when its 90 s are up
and its tab closed. So one more mute can land just after you untick.

### What it does

- Once a minute, the background worker checks whether a visit is due. When one
  is, it opens the account's profile in a new background tab. The tab shows in
  your tab strip but never takes focus. Leave it alone: closing it counts as a
  failed visit.
- In that tab, x-slop-hide waits for one of the account's own posts with a ⋯
  button, opens that menu, and clicks the item labelled exactly
  "Mute @handle" (or "Mute"). It waits for X's "has been muted" notice, then
  closes the tab.
- One tab at a time, 1 to 3 minutes apart, and at most 25 mutes and 50 profile
  visits a day. Days are UTC days.
- After every 5 mutes, and when the day's caps are reached or nothing is left
  to visit, it opens `x.com/settings/muted/all` the same way and checks that
  each new mute is listed there.
- Listed accounts whose posts it hid while you browsed go first (it keeps the
  latest 50), then the rest of the list in its order, then accounts being tried
  again.

It never mutes @grok (muting it account-wide is a much bigger step than hiding
its replies), an account in Always show, an account you follow, or an account
that is not on the list. When X's menu offers "Unfollow @handle", x-slop-hide
records that you follow the account and moves on. An account that is already
muted is recorded without a click. x-slop-hide never unmutes and never blocks.

### When it stops for the day

Muting stops until the next UTC day, and the popup shows "Stopped for today:"
with the reason, when:

- the tab is logged out, or logged in as a different account from the one
  muting was turned on from;
- the ⋯ menu does not have exactly one Mute item, or X asks for a confirmation
  (x-slop-hide leaves it unanswered);
- a check does not find a new mute on `x.com/settings/muted/all`, or cannot
  read that page.

[Muting stopped for today](#muting-stopped-for-today) under Troubleshooting
lists each reason.

### Retries

- A failed visit (no answer from the tab within 90 s, the tab closed before it
  finished, or a ⋯ menu that did not open) is tried again after the accounts
  not yet tried. After 2 failures the account is left alone.
- A profile with no post by the account, or none with a ⋯ button, is tried once
  more, then left alone.
- An account whose menu stopped the day is tried again on a later day, after
  the untried ones. If X shows the same menu, it stops that day too; add the
  account to Always show to end that.

### What it records

The popup shows today's counts and the totals, in this form: "Muting as @you.
Today (UTC): 3 of 25 mutes, 5 of 50 visits · next visit in 2 min. So far: 3
muted (3 seen on your muted list, 0 not found there), 1 already muted, 1 you
follow, 0 skipped." Skipped means no post, or 2 failed visits.

The record is `xsh:mutes` in the extension's local storage: one entry per
account visited, with its status, the time, X's notice text, and whether a
check found it on your muted list.

## Whose list is it?

The list is clankwall's, not this project's. clankwall says its list is "not
proof of authorship" and states no licence or uptime terms. x-slop-hide fetches
it at run time and does not copy it into this repository.

If you think an account is listed by mistake, clankwall's homepage says: "To
dispute your listing, email dispute-spam@ryan.ceo" (as of 2026-11-06).
x-slop-hide cannot remove anyone from the list. To see an account anyway, add
it to Always show; that also keeps it from being muted.

x-slop-hide is not affiliated with X Corp or with clankwall.

## How list updates stay safe

An update replaces the stored list only if it looks like a list. If the fetch
fails, times out, returns HTML, is over 1 MB or 50,000 handles, is mostly lines
that are not handles, is empty, or has fewer than half as many handles as the
stored list (once that list has 20 or more), the previous list stays in place
and the popup shows why. A broken or truncated feed cannot empty your filter.

## Permissions and privacy

- `storage` holds the list, your settings and the mute record. `alarms`
  schedules the list refresh, muting's once-a-minute check, and the 90 s limit
  on a visit. Opening and closing its own tabs needs no further permission.
- The content script runs on x.com, twitter.com and their `mobile.` hosts. In
  your own tabs it makes no network requests and clicks nothing: it reads the
  page, adds one style rule, and sets an attribute on the cells it hides. While
  muting is on, it also tells the background worker which listed authors it
  hid, so they are visited first.
- It clicks only in a tab the background worker opened for a visit. The worker
  hands that tab its job once, so a reload of the tab does not click again.
- The one network request the extension makes itself is the feed fetch, from
  the background worker, to `clankwall.vogel.dev` (the only host permission).
  It sends no cookies (`credentials: 'omit'`) and bypasses the cache. The
  userscript makes the same request through its manager
  (`@connect clankwall.vogel.dev`, anonymous).
- Muting sends no request of its own. The mute is the request x.com's page
  sends when its Mute item is clicked, with your x.com login, as when you click
  it yourself.
- Nothing else is collected or sent. There is no analytics.
- The feed URL is a setting (`feedUrl` in `xsh:settings`) with no UI yet. A
  feed on another host also needs that host added to `host_permissions` in
  `manifest.json` (unless it serves CORS headers), or, for the userscript, an
  `@connect` line for it.

## Troubleshooting

### The userscript is installed but hides nothing

In Chrome and other Chromium browsers, open `chrome://extensions`, click
**Details** on the userscript manager's card, and turn on **Allow User
Scripts**. It is off in a new profile. Then reload x.com.

### On an x.com tab, the popup says "Open x.com in this tab to see what was hidden."

The popup could not reach the extension's script in that tab. The likely
cause is that the tab was already open when the extension was installed or
reloaded, because Chrome does not add an extension's scripts to tabs that are
already open. Reload the tab.

### Ticking "Mute listed accounts on X" says "Open x.com in this tab, logged in as the account to mute from, then turn this on."

The popup could not read which account is logged in from the tab it was opened
over. Open the popup from an x.com tab where you are logged in. If you already
are, reload the tab (it was probably open before the extension was installed or
reloaded) and tick the box again.

### Muting stopped for today

The popup shows "Stopped for today:" and one of these reasons. Muting starts
again on the next UTC day.

| Reason | Meaning | What to do |
|---|---|---|
| `@handle: login (x.com shows a login button)` | The visit's tab was logged out. | Log in to x.com in this browser. |
| `@handle: wrong-account (logged in as @a, not @b)` | x.com is logged in as another account. | Log in as @b again, or untick muting and tick it again from the account you want. |
| `@handle: refused (N exact Mute items in the menu [...])` | The ⋯ menu had no item labelled exactly "Mute @handle", or more than one. The brackets list the labels it saw. | If they are not in English, set X's language to English. If only this account's menu is different, add it to Always show. |
| `@handle: refused (X asked for a confirmation; left it unanswered)` | Clicking Mute brought up a confirmation. | Mute that account by hand if you want to, or add it to Always show. |
| `not on settings/muted/all after muting: @handle` | A new mute was not in the top rows of your muted accounts. | Look for it at `x.com/settings/muted/all`, and see [Limits](#limits). |
| `settings/muted/all check: error (…)` | Your muted accounts page could not be read. | Open `x.com/settings/muted/all` and check that it loads. |

An account refused at its menu is tried again on a later day, and if X still
shows it the same menu, it stops that day too. Adding it to Always show ends
that.

### The popup says "Last refresh failed (…): …. Still using the previous list."

The list you already had is still in use. The text after the colon says why
the update was refused:

| Reason | Meaning |
|---|---|
| `network error: …`, `HTTP <status>`, `read error: …` | The feed did not answer properly. |
| `unexpected content-type …` | The feed URL returned a web page, not a list. |
| `feed larger than 1000000 bytes`, `too many handles`, `feed is mostly not handles (N invalid lines)` | The response does not look like a handle list. |
| `empty list`, `list shrank from X to Y` | The new list was empty, or under half the size of the stored one. |

Click **Refresh list now** to try again. Otherwise the extension tries again at
its next 6-hourly refresh, or at browser start if one is due. The userscript
stores the reason too but has no popup to show it in; while an x.com tab is
open, it retries at most every 30 minutes until a fetch works.

### A post you want to see is hidden

Add the author to **Always show these accounts**, or tick **Pause hiding**. On
an account's own profile and post pages, its posts always show.

### Nothing is hidden any more

Check that hiding is not paused and that the popup's list count is not 0. If
posts by listed authors still show, X may have renamed the markup the script
reads (see [Limits](#limits)). Please open an issue.

## Limits

- The feed lists handles, not accounts. An account that renames itself
  escapes until the list catches up, and a handle that is released and
  re-registered would hide its new owner, and with muting on, mute it.
- The list is someone else's judgement. If the feed goes away, the last good
  list stays in use.
- Hiding only works in a browser where it is installed, so it never covers the
  X app (the mutes do), and it has been tested only in desktop Chromium.
- Hiding has a scrolling cost. When nothing on screen matches, there is no
  measurable cost (home timeline, full list loaded: p95 21.7 and 20.9 ms
  against a baseline of 24.1 and 20.5 ms). When cells are hidden, X re-lays
  out its list, and scroll frames get slower: on a profile's replies page with
  4 of the 11 to 17 rendered posts hidden, the 95th-percentile scroll frame
  went from about 20 ms to 30-41 ms.
- The script relies on X's `data-testid` attributes (`tweet`, `User-Name`,
  `cellInnerDiv`). If X renames them, nothing is hidden until the selectors
  are updated; it fails open, not closed.
- Only post cells are hidden. Notification rows that are not posts ("X liked
  your post") are not.
- Muting reads X's menu in English: "Mute @handle", "Unmute @handle",
  "Unfollow @handle". With X set to another language, every visit is refused
  and muting stops for the day.
- The check reads only the top of `x.com/settings/muted/all`. In a background
  tab on 2026-11-06, X drew its first 7 to 9 rows. Mutes made elsewhere between
  checks (by hand, in the X app, or by another tool) push x-slop-hide's newest
  mutes down that list, and a mute that is there but not drawn reads as missing
  and stops the day. Don't mute by hand or run another muting tool while
  x-slop-hide is muting.
- Muting runs only while the browser is open with the extension loaded and
  logged in to x.com. It picks up again the next time the browser runs.
- The clicks are script events (their `isTrusted` is false). X's menu accepted
  them on 2026-11-06, but X can change its menu or how it treats such clicks at
  any time. A changed menu stops muting for the day; x-slop-hide does not
  click anything else instead.

## FAQ

### Which browsers does it run in?

The extension needs Chrome 116 or later, or another Chromium browser of that
age; it was tested in Chromium 156. The userscript was tested in Violentmonkey
2.50.0 on Chromium 156. Brave, Edge, Firefox and Tampermonkey have not been
tested.

### Does it work on my phone?

Hiding cannot reach the X app, and it has not been tried in a mobile browser.
The mutes x-slop-hide makes are X's own, so they apply in the X app too.
Muting itself runs from the extension in a desktop browser.

### Can I hide an account that is not on the list?

Not with x-slop-hide, which hides and mutes only listed authors. Mute the
account on X.

### If an account leaves the list, is it unmuted?

No. x-slop-hide never unmutes. Unmute it on X.

### How do I remove it?

Remove the extension in `chrome://extensions`, or delete the script in your
userscript manager. Hiding leaves nothing to undo. The mutes x-slop-hide made
stay on your X account; unmute them on X at `x.com/settings/muted/all`. To see
which accounts it muted, read the record before removing the extension: click
**service worker** on its card in `chrome://extensions` and, in the console
that opens, run `chrome.storage.local.get('xsh:mutes').then(console.log)`.

## Development

```
pnpm install
pnpm test            # node --test 'test/*.test.mjs'
pnpm run build       # rebuild dist/x-slop-hide.user.js from src/
pnpm run check       # userscript is current + parses + tests (what CI runs)
```

- `src/lib.js`: pure logic, shared by every runtime and the tests: list
  parsing and validation, the update guard, author detection, the hide rule
  and the @grok switch, and muting's rules (which menu item to click, the
  visit order, the daily caps and the mute record).
- `src/content.js`: the content script. It watches the page and marks the
  cells to hide. In a tab the background worker opened for a visit, it runs
  that one job (mute the profile's account, or read `settings/muted/all`) and
  reports the result.
- `src/background.js`: the service worker. It fetches the feed and stores it,
  and, while muting is on, runs the visits: a 1-minute alarm, one background
  tab at a time, and a 90 s limit per tab.
- `src/popup.*`: the popup.
- `src/userscript-adapter.js` and `scripts/build-userscript.mjs`: the
  userscript build, which concatenates `lib.js`, the adapter and `content.js`.
  The adapter has no visit jobs, so the userscript hides but never mutes.
  A release bumps `version` in `manifest.json` (and `package.json`), because
  userscript managers update only when it goes up.

The DOM tests run the real `content.js` against [linkedom](https://github.com/WebReflection/linkedom)
documents shaped like X's markup, including its profile and muted-accounts
pages and its ⋯ menu as seen on 2026-11-06. Their handles are made up. The
wiring tests run the real `background.js` against an in-memory `chrome`. None
of them can catch X changing its markup, so after a change to the selectors,
check on real x.com: load the extension, scroll a busy reply thread, and
confirm that each hidden post's `@handle` is on the list and that no listed
author's post is left showing.

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

- The userscript, in Violentmonkey 2.50.0. Opening a `.user.js` URL on a
  local web server brought up Violentmonkey's install page, which showed
  version 0.2.0 and `@connect clankwall.vogel.dev`. After install, the script
  fetched the real list (767 handles) through the manager, hid @grok and a
  listed author, and left an unlisted account showing. After a reload it hid
  them again from the stored list without fetching it again. Violentmonkey's
  menu showed all four commands, and **Show / hide @grok** showed @grok's post
  while the listed author stayed hidden. 10 of 10 checks passed: 8 on the
  script and 2 setup checks.
- The extension. The popup's **Show @grok's replies** box started unticked.
  Ticking it showed @grok's post in an open x.com tab while the listed author
  stayed hidden; the box was still ticked when the popup reopened; unticking
  it hid @grok again. On @grok's own profile its posts showed with the switch
  off. 9 of 9 checks passed: 8 on the extension and 1 setup check.

Muting was tested on 2026-11-06 in two ways.

On real x.com, logged in, the real `lib.js` and `content.js` were injected into
a background tab through the DevTools protocol, as in the extension's own visit
tab, and given a job shaped the way the background worker builds one. The job
muted one listed account in 9.6 s, and X showed "@… has been muted.Undo". A
check job then read 7 rows of `x.com/settings/muted/all`, with the new mute
first. On 3 of 4 profiles, the first post appeared 2 to 3 s before its ⋯
button, so the job waits for the button.

The unpacked extension was run in Chromium 156 (headless, through Playwright)
with x.com answered by a local HTTPS server of fixture pages; Playwright's own
request routing did not reach the tabs the extension opened. The 5 most recent
runs passed 24 of 24 checks:

- With muting off there is no mute alarm and no sightings. Turning it on
  creates a 1-minute alarm; turning it off clears it.
- A listed author hidden in the user's tab is visited first.
- The alarm starts each visit by itself, in a background tab, while the user's
  tab stays active and gets no click.
- A mute waits for a ⋯ button that appears 2.5 s after the post, clicks Mute
  once, keeps X's notice, and closes the tab.
- Visits are 1 to 3 minutes apart.
- An already-muted account and a followed one are recorded without a Mute
  click. @grok and an Always-show account are never visited.
- The check runs when nothing is left to visit, confirms two mutes, and stops
  the day on a third that the fixture muted list leaves out.
- A stopped day opens no tabs.

One run before those 5 failed a check. The likely cause is the test harness,
which changed the worker's stored state outside the worker's own queue; it now
goes through that queue. In an earlier run of the same setup, a visit tab that
never answered was closed after 90 s and recorded as a failed visit.

Not tested: Brave itself, Tampermonkey, Violentmonkey in Firefox, the 6-hour
refresh actually firing, reposts, and the notifications page. For muting: the
background worker's own visit tabs on real x.com (the live mute above was
driven through the DevTools protocol), a full day of 25 mutes or several days
in a row, how X responds to that pace, and X in other languages.

## Contributing

Issues and pull requests are welcome. For anything non-trivial, open an issue
first so we can agree on the approach before you spend time on it.

## License

[MIT](LICENSE). The list is not part of this repository and is not covered by
this licence.
