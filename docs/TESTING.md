# Testing

How x-slop-hide has been tested, run by run. The
README's [Development](../README.md#development) section covers the
automated tests.

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
  off. 9 of 9 checks passed: 8 on the extension and 1 setup check. Version
  0.4.0 replaced that box with @grok's row under [Bots](../README.md#bots).

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
request routing did not reach the tabs the extension opened. The 6 most recent
runs, the last at version 0.3.0, passed 24 of 24 checks:

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

One run before those 6 failed a check. The likely cause is the test harness,
which changed the worker's stored state outside the worker's own queue; it now
goes through that queue. In an earlier run of the same setup, a visit tab that
never answered was closed after 90 s and recorded as a failed visit.

Version 0.4.0 ran the same way on 2026-11-06 and passed 35 of 35 checks on
each of three runs, the last after the review fixes (each Mute click now waits
for the worker's go-ahead). Besides the muting checks above (now 5 mutes and 7
visits, with the check after the 5th mute), it checked:

- The popup, opened as a page: six bot rows, @grok at **Hide here** and the
  other five at **Show**, and no settings written by opening it. **Save** wrote
  both boxes; a bot in Always show was locked to **Show**; picking **Mute on
  X** for @AskPerplexity saved only that row; ticking the tag box saved it.
- The user's timeline, with the tag box ticked: posts by a listed author and
  by @grok were hidden, and so were a post tagging @grok and one tagging
  @AskPerplexity in their own text. A post quoting a post that tagged @grok,
  the user's own post tagging @grok, and a post tagging @pangramlabs (at
  **Show**) stayed visible. The tab's count had the 2 tag posts apart from the
  2 listed posts.
- With muting on, only the listed author went to the front of the queue, not
  @grok or the taggers. Visits went through the list, then the extra account,
  then @AskPerplexity, each muted with one click. @grok, the bots at **Show**
  or in Always show, the Always-show account and the taggers were never
  visited.

## In daily use

Since 2026-11-07 (UTC) the extension has run in Brave on Windows, on the
maintainer's own X account, with muting on. These mutes came from the
extension's own background visit tabs on real x.com; the runs above injected
the scripts through the DevTools protocol instead. The counts below were read
from `x.com/settings/muted/all`.

- By 23:22 UTC on 2026-11-07 it had made 25 mutes that UTC day, the daily cap,
  with 0.3.0 and then 0.4.0 after a reload.
- By 00:12 UTC on 2026-11-08, 0.4.0 had made 4 more.

## Not tested

Hiding in Brave (muting has run there, above), Tampermonkey, Violentmonkey in
Firefox, the 6-hour refresh actually firing, reposts, and the notifications
page. For muting: a bot row set to **Mute on X** and accounts from **Also hide
these accounts** on real x.com, more than two days in a row, how X responds to
this pace over weeks, and X in other languages.
