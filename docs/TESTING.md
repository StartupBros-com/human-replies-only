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

Version 0.4.1 changed the Pangram row from @pangramlabs, which is not an X
account, to @pangram.

Version 0.4.1 also redesigned the popup and added the toolbar icon. On
2026-11-08 the popup page was rendered in Chromium 156 with a stub in place of
the extension APIs, in light and dark, for three states: muting on, a new
install, and muting stopped with a failed refresh. With the folded sections
closed, each was 400 pixels wide and 483 to 595 tall, so none scrolls (a popup
scrolls past 600); opening all three folds makes it scroll again. Before the
change the same states were 1,259 to 1,380 pixels tall. The wiring tests check
what each part of the popup says.

The same day, 0.4.1 ran in the 0.4.0 setup above and passed 40 of 40 checks:
the 35 above, with @pangram in place of @pangramlabs, and 5 on the popup's
folded sections. Both folds started closed and showed their counts ("Show 5 ·
Hide here 1 · Mute on X 0"), the popup was 483 pixels tall, clicking each
summary opened it, and both counts followed **Save** and the bot rows. The
runner's first wait now accepts a bot row hidden in a closed fold. Later on
2026-11-08 the maintainer reloaded 0.4.1 in Brave and reported that the popup
looked right. A bot row set to **Mute on X** has not run in Brave yet.

Version 0.5.0 ran the same way on 2026-11-09 (UTC) and passed 62 of 62 checks.
The local server also answered for the list's host, so the install refresh
read a 3-account fixture list and nothing reached the real one. The checks:

- Labels are off on a new install: the popup said "Off · 0 saved" with Export
  and Delete disabled, and a post page had no Slop / Not slop pair. Once the
  switch was ticked, each reply got a pair, and the post the page is about and
  the post above it, which it replies to, got none. The pair of a reply hidden
  by the list was hidden with it.
- **Slop** saved a record with every documented field and added the account
  to Also hide, which hid the reply at once. **Not slop** added its account to
  Always show. Clicking a pressed button again cleared the label and left the
  box as it was.
- A click sent by the page's own script saved nothing. Enter on a focused
  button saved, with the reply's own text and not the quoted post's. None of
  the pair's click, pointer, mouse or key events reached the page's own
  document or post listeners (a capture-phase listener saw 5 clicks happen),
  and the page did not navigate.
- With hiding paused, the listed reply showed with its pair, and its record
  named the list's host (`clankwall.vogel.dev`) and said `hidden: true`.
- When the page reused a reply's element for another post, as X does when it
  scrolls, the pair moved to the new post, unpressed and not doubled. The home
  timeline, a profile and the post's quotes page had no pairs.
- The popup said "On · 3 saved". **Export** downloaded
  `x-slop-hide-labels-2026-11-09.jsonl`: 3 records, oldest first, each with
  exactly the documented fields. **Delete** asked "Click again to delete 3
  labels"; the second click deleted the 3 labels and the count, left both boxes
  as they were, and the open page dropped its pressed buttons. Unticking the
  switch removed every pair.
- The daily mute setting started at 25. Picking 100 saved it, and the popup
  said why nothing goes above 100 and that the 3 accounts left take 1 day.
- Without the "tabs" permission, the worker listed every tab but saw an
  address and title only for its own popup page, never for the x.com tab. Its
  check for an x.com tab said no with none open, yes with the user's
  `x.com/home` tab open, no when that tab was counted as a visit tab or
  discarded by the browser, and no once it was closed.
- At 100 with no x.com tab of the user's, a tick started no visit. With the
  user's tab open, the 1-minute alarm started a visit 58 s later, in a
  background tab, which clicked Mute once. A due check of the muted list still
  ran with no x.com tab and confirmed that mute.
- At 25, a tick started a visit with no x.com tab open. The visit's own tab did
  not count as the user's: the check said no, and the tab itself answered no.
  That visit waited 20 s for a late ⋯ button and muted the second account.
  Turning muting off cleared the alarm. Nothing threw an uncaught error.

The runner took three shortcuts: it turned muting on by writing the setting to
storage, ran most ticks by calling the function the worker's alarm calls (one
visit started from the real alarm), and skipped the wait between visits
through the worker's queue.

Four earlier runs that day failed. Two could not save the export download,
which was the runner's download folder. One found a defect: the worker refused
**Delete** from the popup page opened in a tab, because it refused every
sender in a tab. It now accepts **Delete** only from a page at the extension's
own address, and a wiring test covers the popup opened in a tab. The fourth
asked for the tab list before any x.com tab was open; that check now runs with
one open.

A fifth run passed, and a review of the branch after it found two more
defects. The worker asked for an x.com tab from inside its own queue, so a tab
that had just loaded, whose answer waits on its own question to the worker,
could not answer within the 1.5 s timeout and counted as no tab; the worker now
asks between two passes of its queue. And the pairs also appeared on the posts
above the page's post and on its quotes, likes and photo pages; they now appear
only below the post, on its own page. Wiring and DOM tests cover both, and the
run above adds a post above the page's post and a quotes page to the fixture.
The first run after those fixes passed all it ran but skipped the
background-tab check, because the visit had ended before the runner read its
tab; the runner now reads the tab while the visit runs and fails if it cannot.

Not tested: real x.com's own handlers (the fixture page has plain listeners),
Brave, whether 50 or 100 mutes a day is safe for an account, and the
userscript, whose missing pair is covered only by the unit tests. Nor whether
x.com keeps its posts in page order, which the check for posts above the
page's post relies on. A post above the page's post that first appears after
x.com has unmounted the page's post (a long chain scrolled far up) gets a pair.

On 2026-11-09, version 0.6.0's export and import page ran in Chromium 156
(headless, through Playwright) with the unpacked extension, the browser's own
downloads and the page's own file input. The real list (772 handles)
downloaded, and x.com was made unresolvable. The profile started with one
account in each box, @grok set to Hide here, and muting on at 50 a day as a
made-up account, with no x.com tab open. All 42 checks passed:

- **Export settings** saved `x-slop-hide-settings-2026-11-09.json` with exactly
  its seven keys. The file held no muting setting, muting handle, list address,
  pause or labels. **Export Also hide as a list** saved one handle per line.
- A shared list with a `#` note line, a blank line, an upper-case handle with
  `@`, a listed account and an Always show account brought up a preview. It
  named each account Also hide would gain, the Always show account that stays
  shown, the account muting runs as and the two accounts muting could newly
  reach. Nothing was stored until **Import these changes**.
- A settings file that also set muting off, a cap of 100, another muting
  account, a list address, pause and labels changed only Also hide, one bot
  choice and the tag setting. The other six stayed as they were, and the
  preview named @AskPerplexity, set to Mute on X, among the new mute targets.
- **Cancel**, and a list whose second line had a note after the handle
  ("Not imported: line 2 is not an X handle."), stored nothing.
- With the settings changed after the preview, the first click on **Import
  these changes** showed a new preview with a notice and stored nothing; the
  second stored the new preview.
- Importing the first export into empty settings and exporting again gave the
  same file apart from its date.
- The page made no request outside the extension and logged no error. The
  popup's **Export or import** link, under **Your accounts**, opened the page
  in a new tab.

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
this pace over weeks, and X in other languages. For export and import: Brave
and branded Chrome, a file picked from a desktop file dialog (the run above set
the file input directly), and whether a file picker opened from the popup
would close it, which is why import has a page of its own.
