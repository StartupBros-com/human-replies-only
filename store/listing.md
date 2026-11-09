# Chrome Web Store listing

What to enter in the Chrome Web Store developer dashboard for x-slop-hide 0.6.2,
field by field. Field names and rules are from Google's developer documentation
at developer.chrome.com/docs/webstore, read on 2026-11-09. Where the docs show a
dashboard label only in a screenshot, this file says so; match it to the
dashboard itself.

## Package

Build the zip from a commit, never from a working tree:

```
git fetch origin
node scripts/package-store.mjs --ref origin/main
```

Build from `main`, or from a tag from `v0.6.0` on. The `v0.5.0` tag predates
the store icon: its `icons/icon-128.png` fills the whole 128x128 square, where
later commits have the 16 px padding the store asks for.

It writes `build/x-slop-hide-<version>-chrome-web-store.zip` and refuses a
manifest with a `key`, a name over 75 or a description over 132 characters, a
version that differs from `package.json`, and a missing or unparseable file.
Upload that zip under **Package**.

## Store listing tab

**Name** and **Summary** come from `manifest.json` (`name`, `description`), so
changing either takes a new upload:

- Name: `x-slop-hide`
- Summary: `Hides x.com posts by accounts on a self-updating AI-reply spam list, and can mute them on X at a capped daily pace. No X API.`

**Description** (plain text; the store shows line breaks but no formatting):

```
x-slop-hide hides posts on x.com by accounts on clankwall's public list of AI-reply spam accounts (clankwall.vogel.dev). The list refreshes every 6 hours. You can add accounts of your own, keep accounts you always want to see, and choose Show, Hide or Mute for six bots that answer when tagged, such as @grok and @AskPerplexity.

HIDING
- A post is hidden when its author is on the list or in your Also hide box. Quotes and mentions of a listed account stay visible.
- On an x.com tab, the popup counts what that tab hid. Pause hiding shows every post again.
- Hiding works in this browser profile only. In your own tabs the extension never clicks anything on X's page and makes no network request.

LABELS (optional)
- Turn on Slop and Not slop buttons under replies. Slop adds the account to Also hide; Not slop adds it to Always show.
- Labels stay in this browser. Export labels saves them to a file.

SETTINGS FILES
- Export your Always show and Also hide accounts, bot choices and tag setting to a file, or Also hide alone as a list of handles to share.
- Import a settings file or a shared list. Import adds accounts and never removes any, shows what will change before it changes anything, and never turns muting on.

MUTING (optional, off until you turn it on)
- When you turn it on, x-slop-hide mutes the listed accounts, the accounts in your Also hide box and any bot you set to Mute on X, on your X account. It clicks X's own Mute item on x.com, in background tabs it opens and closes, one visit about every 1 to 4 minutes. You pick 25, 50 or 100 mutes a day: 25 runs whenever the browser is open; 50 and 100 run only while you have an x.com tab open.
- It skips accounts you follow and accounts in Always show. It never blocks, never unmutes, and does not use the X API.
- X's rules forbid "scripting the X website" and say: "The use of these techniques may result in the permanent suspension of your account." Muting scripts x.com. Read the Muting section on the project page before you turn it on.

PRIVACY
- No account, no server, no analytics. The extension's own code makes one kind of request: it downloads the public list, without cookies. Everything it keeps stays in your browser's extension storage.
- Privacy policy: https://github.com/StartupBros-com/x-slop-hide/blob/main/PRIVACY.md

Free and open source under the MIT license: https://github.com/StartupBros-com/x-slop-hide

x-slop-hide is not affiliated with, endorsed by or sponsored by X Corp. It does not run or maintain the clankwall list.
```

The MUTING paragraph is the one to cut, with the muting UI, if a hide-only
store build is ever made. It has no such build today: the store zip is the
same extension as the GitHub release.

**Category:** Social Media & Networking ("extensions designed to enhance
social media platforms", in Google's category list).

**Language:** English.

**Graphics** (all in `store/images/`):

| Field | File | Size |
|---|---|---|
| Store icon | `icons/icon-128.png` (also in the zip) | 128x128, 96x96 artwork with 16 px transparent padding |
| Screenshot 1 | `screenshot-1-hide.png` | 1280x800 |
| Screenshot 2 | `screenshot-2-popup.png` | 1280x800 |
| Screenshot 3 | `screenshot-3-muting.png` | 1280x800 |
| Screenshot 4 | `screenshot-4-labels.png` | 1280x800 |
| Small promo tile | `promo-small-440x280.png` | 440x280 |

The screenshots and tile are 24-bit PNGs with no alpha channel. The marquee
tile (1400x560) is optional and not made.

The screenshots show the real extension on a local example page, not on x.com:
the threads use made-up `xsh_demo_` accounts, three of them put in **Also
hide** to stand in for listed spam, and the list counts are the live
clankwall list at render time. Regenerate them, and the tile, with:

```
pnpm install
node scripts/store-screenshots.mjs --chrome <path to a Chromium binary>
```

`--icon` also redraws `icons/icon-128.png` from `icons/icon.svg`. With snap
Chromium, pass `--stage-root` a directory under `~/snap/chromium/common`: snap
Chromium has its own private `/tmp` and cannot load an extension staged in the
system one.

**Official URL / homepage:** `https://github.com/StartupBros-com/x-slop-hide`
(the manifest's `homepage_url`).

**Support URL:** `https://github.com/StartupBros-com/x-slop-hide/issues`

## Privacy tab

**Single purpose:**

```
Hide posts on x.com by accounts on a public list of AI-reply spam accounts, or on lists the user keeps, with an optional mute of the same accounts on the user's X account that is off until the user turns it on.
```

**Permission justifications:**

| Permission | Justification |
|---|---|
| `storage` | Keeps the downloaded list, the user's settings and account lists, and, only if the user turns them on, the muting record and saved labels. All of it stays in the browser's extension storage. |
| `alarms` | Refreshes the list every 6 hours. When muting is on, a once-a-minute alarm checks whether a mute visit is due, and a 90-second alarm closes a visit tab that stalls. |
| Host permission `https://clankwall.vogel.dev/*` | The service worker downloads the public list from `https://clankwall.vogel.dev/api/usernames.txt`, without cookies. No other data is sent there. |
| Content scripts on `x.com`, `twitter.com`, `mobile.x.com`, `mobile.twitter.com` | The content script reads each post's author handle to hide posts by listed accounts. X serves the same pages on all four hosts. It reads the user's own handle from X's navigation bar, so a post by the user is never hidden for tagging a bot and muting runs only as the account that turned it on. With labels on, it adds Slop and Not slop buttons under replies and reads a reply's text when the user clicks one. With muting on, it clicks X's own Mute item only in a background tab the extension opened for one account, and reads the user's muted-accounts page in another tab the extension opened, to confirm earlier mutes. |

**Remote code:** No. All JavaScript ships in the package. The list it downloads
is plain text, one handle per line, read as data and never run.

**Data usage.** The docs show the checkbox labels only in a screenshot, so the
names below may differ from the dashboard's; tick the dashboard's nearest box
for each row. The stored fields are named by their keys in `PRIVACY.md`.

| Box | Tick | Why |
|---|---|---|
| Personally identifiable information | Yes | X handles: the user's own handle while muting is on (`xsh:settings`), and other people's handles in the user's lists, the muting record (`xsh:mutes`) and labels (`xsh:label:<post id>`). |
| Website content | Yes | Labels keep up to 1,000 characters of the labelled reply's text. |
| Web history (the FAQ's "web browsing activity": the sites and URLs a user visits) | Yes | Each label keeps the address of the post and of the page it was labelled on, with the time. A narrow case, but ticking it is the safer reading. |
| User activity | No | Nothing records keystrokes or mouse movement. With muting on, the muting record keeps up to 50 accounts (listed, in Also hide, or a bot set to Mute on X) whose posts were hidden on the user's screen, so they are muted first. Labels record the user's own Slop and Not slop clicks, covered under Website content and Web history. This is the extension's own function, not monitoring; if the dashboard's wording for this box reads as covering it, tick it. |
| Authentication information | No | The extension never reads passwords, cookies or tokens. Mute visits use the browser's own x.com login, as any page load does. |
| Personal communications | No | Public replies only; no messages or email. |
| Health, financial and payment, location | No | None handled. |

The boxes are ticked though nothing leaves the browser, because Google's User
Data FAQ asks "Does an extension need to disclose user data handling if the
data is only processed or stored locally on a user's device?" and answers
"Yes".

**Certifications:** tick every one. The docs show their wording only in a
screenshot; they certify compliance with the Limited Use policy. All of it
holds for x-slop-hide: it does not sell or transfer user data, does not use it
for anything outside its single purpose, does not use it for advertising or
for creditworthiness or lending, and no person reads it.

**Privacy policy URL:**
`https://github.com/StartupBros-com/x-slop-hide/blob/main/PRIVACY.md`. It
carries the Limited Use statement on the project's own page.

## Distribution tab

- Payment: free.
- Visibility: **Public** lists the item in the store. **Unlisted** creates no
  listing, but anyone with the item's store URL can install it. **Private**
  limits installs to named testers or groups. Google: "All visibility settings
  have the same policy requirements and will go through the same review
  process."
- Regions: all.
- Under **Submit for review**, untick automatic publishing to publish by hand
  after approval. An approved item not published within 30 days goes back to
  draft and needs resubmitting.

## Test instructions tab

Optional. Google says the tab is useful when an item needs restricted
credentials for full access; seeing x-slop-hide work needs an X login, so fill
it in (no credentials are given):

```
x-slop-hide needs no account of its own. To see hiding: log in to any X account, open a reply thread on x.com, open the extension's popup, and add the handle of one replier under Your accounts > Also hide these accounts, then Save. That reply disappears; the popup counts it; Pause hiding brings it back. Accounts on the downloaded list (shown as "N accounts on the list" in the popup) are hidden the same way.

Muting is off by default. To turn it on, open x.com logged in, keep that tab active, open the popup and tick "Mute listed accounts on X". It then mutes at most 25, 50 or 100 accounts a day (50 and 100 only while an x.com tab is open) by clicking X's own Mute item in background tabs. It does not use the X API, block anyone or unmute anyone. Testing it mutes real accounts on the reviewer's X account; they can be unmuted at x.com/settings/muted/all.
```
