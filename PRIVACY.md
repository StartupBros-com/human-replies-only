# Privacy policy

x-slop-hide hides posts on x.com by accounts on a public list of AI-reply spam
accounts. The browser extension can also mute those accounts on X, and can save
labels you give to replies. This policy covers the extension and the userscript,
version 0.5.0. Last updated 2026-11-09.

## In short

- x-slop-hide has no account, no server, no analytics and no telemetry. Its
  developers receive none of the data described here.
- The extension's own code makes one kind of network request: it downloads the
  public list from `clankwall.vogel.dev`, without cookies.
- Everything it keeps is in your browser profile's extension storage, on your
  computer.
- If you turn muting on (it is off by default), the extension opens x.com pages
  in background tabs with your x.com login and clicks X's own Mute item. X sees
  those visits and mutes as your activity.
- Labels leave your browser only as a file, when you click **Export labels**.

## What it reads on x.com

On x.com and twitter.com pages (and their `mobile.` hosts) the extension reads,
in the page:

- the author's handle on each post, to decide whether to hide it;
- your own handle, from X's profile link in the navigation bar, so that hiding
  posts which tag a hidden bot never hides your own posts, and so that muting
  runs only as the account you turned it on from;
- with labels turned on, the text of a reply when you click **Slop** or
  **Not slop** under it.

None of this is sent anywhere. What is kept is listed below.

## What it stores

The extension stores data in `chrome.storage.local` for this browser profile. Chrome
Sync does not copy it to other devices.

| Storage key | What it holds | When |
|---|---|---|
| `xsh:list` | The list of handles, when it was fetched and last tried, the address it was fetched from, and the last error, if any. | Always. |
| `xsh:settings` | Your settings: paused or not, your **Always show** and **Also hide** accounts, your choice for each bot, whether to hide posts that tag a bot, muting on or off, the daily mute cap, labels on or off, and an optional list address (the popup has no setting for it; it is empty unless set by hand). While muting is on, also the x.com handle muting runs as. | Always; the muting handle only while muting is on. Turning muting off removes it. |
| `xsh:mutes` | The muting record. For each account muted or tried: the outcome, the time, X's notice text (up to 120 characters), the reason it failed (up to 200 characters), whether a later check found it on your muted list, and the number of attempts. For each UTC day: the number of mutes and visits, and why muting stopped, which can name an account and the handle you were logged in as. Up to 50 accounts muting may visit whose posts were hidden on your screen, to be muted first. The time of the next visit. | Only once you turn muting on. |
| `xsh:label:<post id>` | One saved label: the time, the label, the author's handle, the post's address, up to 1,000 characters of the reply's own text, the address of the page you labelled it on, whether the author was on the list, in **Also hide** or in **Always show**, and whether the reply was hidden. At most 2,000 labels. | Only when labels are on and you click **Slop** or **Not slop**. |
| `xsh:labelCount` | The number of saved labels. | Same as above. |

While a mute visit is running, the extension also keeps, in `chrome.storage.session`,
the account being visited, the handle muting runs as, and the id of the tab it
opened (`xsh:job`), plus the ids of tabs it opened for visits that are still open
(`xsh:jobTabs`). Chrome clears session storage when the browser closes.

The userscript stores only the list and your settings, in your userscript
manager's storage. It does not mute and has no labels.

## What it sends, and where

**The list.** The extension downloads
`https://clankwall.vogel.dev/api/usernames.txt` when it is installed, at browser
start when a refresh is due, every 6 hours, and when you click **Refresh list
now** in the popup. The request carries no cookies, no identifiers and no body. Like any
web request, it reaches that server with your IP address and your browser's
standard request headers. clankwall is run by a third party, not by
x-slop-hide's developers; see its site for how it handles requests. The
userscript downloads the same file through your userscript manager, marked
anonymous so no cookies are sent.

**Muting, only if you turn it on.** The extension opens two kinds of x.com page
in background tabs: the profile of a listed account (`https://x.com/<handle>`),
where it clicks X's own Mute menu item, and your muted-accounts page
(`https://x.com/settings/muted/all`), which it reads to check earlier mutes. Your
browser loads these pages with your x.com login, the same as if you opened them,
so X receives the visits and the mutes as your activity. The extension sends
nothing else to X. At a daily cap of 50 or 100, before a visit it asks your open
tabs whether one of them is an x.com tab. It uses only each tab's id and whether
the browser has unloaded it; it does not read tab addresses or titles.

A **Slop** label adds the account to **Also hide**; a **Not slop** label adds it
to **Always show**. With muting on, an account in **Also hide** can be visited
and muted like a listed one.

**Export labels** saves your labels as a `.jsonl` file through your browser's
download. Nothing is uploaded.

**Links in the popup** (X's muted-words settings, an account's profile, this
project's page) open only when you click them.

Nothing else is collected or sent. There is no analytics, no crash reporting and
no remotely hosted code.

## Other people's replies

Labels keep the text of replies written by other people, so you can review or
share your own record of what you marked. That text stays in your browser
profile until you click **Delete all labels** (it asks for a second click) or
remove the extension. A file you exported stays where you saved it.

## Selling and sharing

x-slop-hide does not sell, transfer or share user data. Its developers do not
receive any. The use of information received from the extension's handling of
user data complies with the
[Chrome Web Store User Data Policy](https://developer.chrome.com/docs/webstore/program-policies),
including the Limited Use requirements.

## Your controls

- **Pause hiding** shows every post again, on every tab. It does not stop
  muting.
- Turning muting off stops visits and removes the handle muting ran as. It
  keeps the muting record (`xsh:mutes`) until you remove the extension. Mutes
  already made stay on your X account; undo them at
  `https://x.com/settings/muted/all`.
- Turning labels off removes the buttons. **Delete all labels** deletes every
  saved label and the label count. Accounts a label added to **Also hide** or
  **Always show** stay there; remove them in the popup.
- Removing the extension deletes everything it stored in the browser.

## Changes and contact

This policy lives in the project's repository, and every change to it is in the
repository's history. Questions and requests go to
[GitHub issues](https://github.com/StartupBros-com/x-slop-hide/issues).
