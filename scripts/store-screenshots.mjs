// Renders the Chrome Web Store screenshots (1280x800) and small promo tile
// (440x280) into store/images/, in Chromium with the unpacked extension.
//
//   node scripts/store-screenshots.mjs --chrome <chromium binary> [--out DIR] [--stage-root DIR] [--icon]
//
// Branded Google Chrome ignores --load-extension; use Chromium or Chrome for
// Testing. Snap Chromium reads files only under ~/snap/chromium/common, so pass
// --stage-root ~/snap/chromium/common with it.
//
// What is real and what is staged:
// - x.com is answered by a local HTTPS server with example threads by made-up
//   accounts (every handle starts with xsh_demo_). The page keeps the markup the
//   content script reads but is styled plainly, without X's look or logo.
// - The list is the real one: the extension downloads it from
//   clankwall.vogel.dev, as it does after any install, so the popup shows the
//   real count. The example's spam accounts are put in Also hide.
// - Opened as a page, the popup is its own active tab, so its "This tab" line
//   is pointed at the example x.com tab. The numbers in it are the content
//   script's own.
//
// --icon also rewrites icons/icon-128.png from icons/icon.svg: 96x96 artwork
// inside 16 pixels of transparent padding, as the store's image guidelines ask.
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { chromium } from 'playwright-core';
import { flattenPng, readPng } from './png.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { values: opt } = parseArgs({
  options: {
    chrome: { type: 'string', default: process.env.CHROME_PATH || '' },
    out: { type: 'string', default: join(ROOT, 'store', 'images') },
    'stage-root': { type: 'string', default: tmpdir() },
    icon: { type: 'boolean', default: false },
    keep: { type: 'boolean', default: false },
  },
});
if (!opt.chrome) {
  console.error('Pass --chrome <path to Chromium or Chrome for Testing>, or set CHROME_PATH.');
  process.exit(2);
}

// ------------------------------------------------------------ the example
const ME = 'xsh_demo_me';
const OP = 'xsh_demo_maker';
const PEOPLE = {
  xsh_demo_maker: ['Sam', '#2563eb'],
  xsh_demo_ana: ['Ana', '#059669'],
  xsh_demo_ben: ['Ben', '#7c3aed'],
  xsh_demo_cara: ['Cara', '#db2777'],
  xsh_demo_bot1: ['Jordan | AI growth', '#ea580c'],
  xsh_demo_bot2: ['Priya ✦ founder mindset', '#0891b2'],
  xsh_demo_bot3: ['Max Productivity', '#65a30d'],
  xsh_demo_bot4: ['Elena | daily wins', '#9333ea'],
};
const SPAM = ['xsh_demo_bot1', 'xsh_demo_bot2', 'xsh_demo_bot3'];
const OP_TEXT = 'Shipped my first browser extension this weekend. Two days from idea to a working build.';
const THREADS = {
  // The hiding shots: three spam replies among three real ones.
  1000: [
    ['xsh_demo_bot1', 1001, '2h', 'Great insight! This is a game-changer for anyone building in public. 🚀'],
    ['xsh_demo_ana', 1002, '2h', 'Nice. Did you go with Manifest V3 from the start?'],
    ['xsh_demo_bot2', 1003, '1h', "Absolutely agree. Consistency and execution are the keys to success in today's landscape."],
    ['xsh_demo_ben', 1004, '58m', 'Congrats! How long did the store review take?'],
    ['xsh_demo_bot3', 1005, '41m', 'This is so true! Thanks for sharing such valuable content with the community. 🙌'],
    ['xsh_demo_cara', 1006, '12m', 'Saving this for the weekend. Is the code public?'],
  ],
  // The labels shot: one spam reply that nothing lists yet.
  2000: [
    ['xsh_demo_bot4', 2001, '2h', 'What a fantastic thread! Your insights are truly inspiring. 💯'],
    ['xsh_demo_ana', 2002, '2h', 'Nice. Did you go with Manifest V3 from the start?'],
    ['xsh_demo_bot2', 2003, '1h', "Absolutely agree. Consistency and execution are the keys to success in today's landscape."],
    ['xsh_demo_cara', 2004, '12m', 'Saving this for the weekend. Is the code public?'],
  ],
};
const threadPath = (id) => `/${OP}/status/${id}`;
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

function post(handle, id, time, text, op = false) {
  const [name, color] = PEOPLE[handle];
  return (
    `<div data-testid="cellInnerDiv"><div><article data-testid="tweet" role="article" tabindex="0"${op ? ' class="op"' : ''}>` +
    `<div class="row"><div class="av" style="background:${color}">${esc(name[0])}</div><div class="main">` +
    `<div data-testid="User-Name"><a href="/${handle}" role="link" class="nm"><span>${esc(name)}</span></a>` +
    `<a href="/${handle}" role="link" tabindex="-1" class="hd"><span>@${handle}</span></a><span class="hd">·</span>` +
    `<a href="/${handle}/status/${id}" role="link" class="hd"><time datetime="2026-11-09T10:00:00.000Z">${time}</time></a></div>` +
    `<div data-testid="tweetText" class="tx"><span>${esc(text)}</span></div></div></div></article></div></div>`
  );
}

function threadPage(id) {
  const css =
    "body{margin:0;background:#fff;color:#0f1419;font:15px/1.4 system-ui,-apple-system,'Segoe UI',sans-serif}" +
    'nav{display:none}main{max-width:700px;margin:0 auto;min-height:100vh}' +
    '.head{position:sticky;top:0;z-index:1;padding:14px 16px;font-weight:700;font-size:19px;background:#fff;border-bottom:1px solid #eff3f4}' +
    'article{display:block;padding:12px 16px 2px;border-bottom:1px solid #eff3f4}' +
    '.row{display:flex;gap:12px}.main{min-width:0;flex:1;padding-bottom:10px}' +
    '.av{flex:none;width:40px;height:40px;border-radius:50%;color:#fff;font-weight:700;display:flex;align-items:center;justify-content:center}' +
    '[data-testid="User-Name"]{display:flex;gap:4px;align-items:baseline;flex-wrap:wrap}' +
    '.nm{color:#0f1419;font-weight:700;text-decoration:none}.hd{color:#536471;text-decoration:none}' +
    '.tx{margin-top:2px}.op .tx{font-size:18px;margin-top:8px}';
  const body = post(OP, id, '3h', OP_TEXT, true) + THREADS[id].map(([h, pid, t, text]) => post(h, pid, t, text)).join('');
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Example thread</title><style>${css}</style></head><body>` +
    `<nav><a data-testid="AppTabBar_Profile_Link" href="/${ME}">Profile</a></nav>` +
    `<main><div class="head">Thread</div><div aria-label="Timeline: Conversation">${body}</div></main></body></html>`
  );
}

// ------------------------------------------------------------ composition
const ICON_SVG = readFileSync(join(ROOT, 'icons', 'icon.svg'));
const iconUrl = `data:image/svg+xml;base64,${ICON_SVG.toString('base64')}`;
const pngUrl = (buf) => `data:image/png;base64,${buf.toString('base64')}`;
// CSS size of a screenshot taken at device scale factor 2.
const cssSize = (buf) => {
  const { width, height } = readPng(buf);
  return { w: width / 2, h: height / 2 };
};

const STAGE_TOP = 170;
const STAGE_H = 600;

function frame(title, sub, note, body) {
  const css =
    "*{box-sizing:border-box}html,body{margin:0}body{position:relative;width:1280px;height:800px;overflow:hidden;background:#eef0f3;color:#111827;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}" +
    'header{position:absolute;left:40px;right:40px;top:28px;display:flex;justify-content:space-between;align-items:flex-start;gap:24px}' +
    'h1{margin:0;font-size:38px;line-height:1.15;letter-spacing:-0.01em}.sub{margin:8px 0 0;font-size:19px;line-height:1.35;color:#374151}' +
    '.note{margin:5px 0 0;font-size:14px;color:#6b7280}.brand{flex:none;display:flex;align-items:center;gap:10px;font-weight:700;font-size:20px}' +
    '.panel{position:absolute;background:#fff;border-radius:14px;overflow:hidden;box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(17,24,39,.14)}' +
    '.panel img{display:block;width:100%}.chip{position:absolute;top:11px;right:14px;padding:4px 12px;border-radius:999px;font-size:14px;font-weight:600;color:#fff}' +
    '.card{position:absolute;display:block;border-radius:10px;box-shadow:0 1px 2px rgba(0,0,0,.06),0 10px 30px rgba(17,24,39,.14)}';
  return (
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><style>${css}</style></head><body>` +
    `<header><div><h1>${esc(title)}</h1><p class="sub">${esc(sub)}</p>${note ? `<p class="note">${esc(note)}</p>` : ''}</div>` +
    `<div class="brand"><img src="${iconUrl}" width="36" height="36" alt="">x-slop-hide</div></header>${body}</body></html>`
  );
}

const panel = (buf, x, w, chip) =>
  `<div class="panel" style="left:${x}px;top:${STAGE_TOP}px;width:${w}px;height:${STAGE_H}px"><img src="${pngUrl(buf)}" alt="">` +
  (chip ? `<span class="chip" style="background:${chip[1]}">${esc(chip[0])}</span>` : '') +
  '</div>';

// A popup screenshot, scaled to fit the box at x..x+boxW and centred in it.
function card(buf, x, boxW, maxScale, cls = 'card') {
  const { w, h } = cssSize(buf);
  const s = Math.min(maxScale, boxW / w, STAGE_H / h);
  const left = Math.round(x + (boxW - w * s) / 2);
  const top = Math.round(STAGE_TOP + (STAGE_H - h * s) / 2);
  return `<img class="${cls}" src="${pngUrl(buf)}" style="left:${left}px;top:${top}px;width:${Math.round(w * s)}px" alt="">`;
}

// The top of the popup at `scale`, top-aligned in the box, fading out at the
// bottom to show the popup continues.
function popupTop(buf, x, boxW, scale) {
  const { w, h } = cssSize(buf);
  const left = Math.round(x + (boxW - w * scale) / 2);
  return (
    `<div class="panel" style="left:${left}px;top:${STAGE_TOP}px;width:${Math.round(w * scale)}px;height:${Math.min(Math.round(h * scale), STAGE_H)}px">` +
    `<img src="${pngUrl(buf)}" alt=""><div style="position:absolute;left:0;right:0;bottom:0;height:${Math.round(56 * scale)}px;background:linear-gradient(rgba(255,255,255,0),#fff)"></div></div>`
  );
}

const tile = () =>
  '<!doctype html><html lang="en"><head><meta charset="utf-8"><style>' +
  "html,body{margin:0}body{width:440px;height:280px;overflow:hidden;background:#111827;display:flex;align-items:center;gap:20px;padding:0 30px;box-sizing:border-box;font-family:system-ui,-apple-system,'Segoe UI',sans-serif}" +
  '.n{color:#fff;font-weight:800;font-size:34px;letter-spacing:-0.01em}.t{color:#d1d5db;font-size:18px;line-height:1.3;margin-top:6px}' +
  `</style></head><body><img src="${iconUrl}" width="80" height="80" alt=""><div><div class="n">x-slop-hide</div><div class="t">Hide AI reply spam on x.com</div></div></body></html>`;

const iconPage = () =>
  '<!doctype html><html><head><style>html,body{margin:0;background:transparent}body{width:128px;height:128px;display:flex;align-items:center;justify-content:center}</style></head>' +
  `<body><img src="${iconUrl}" width="96" height="96" alt=""></body></html>`;

// ------------------------------------------------------------ run
async function until(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(200);
  }
}

const stage = mkdtempSync(join(resolve(opt['stage-root']), 'xsh-shots-'));
const ext = join(stage, 'ext');
const udd = join(stage, 'udd');
const out = resolve(opt.out);
let server;
let ctx;
try {
  mkdirSync(ext, { recursive: true });
  mkdirSync(udd);
  mkdirSync(out, { recursive: true });
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', join(stage, 'key.pem'), '-out', join(stage, 'cert.pem'), '-days', '1', '-subj', '/CN=x.com'], {
    stdio: ['ignore', 'ignore', 'pipe'],
  });

  server = https.createServer({ key: readFileSync(join(stage, 'key.pem')), cert: readFileSync(join(stage, 'cert.pem')) }, (req, res) => {
    const path = new URL(req.url, 'https://x.com').pathname;
    const id = Object.keys(THREADS).find((k) => threadPath(k) === path);
    if (id) res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(threadPage(id));
    else res.writeHead(404, { 'content-type': 'text/plain' }).end('Not part of the example.');
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;

  const launch = (dir, args) =>
    chromium.launchPersistentContext(dir, {
      executablePath: opt.chrome,
      headless: true,
      deviceScaleFactor: 2,
      colorScheme: 'light',
      viewport: { width: 1280, height: 800 },
      ignoreDefaultArgs: ['--disable-extensions'],
      args,
    });

  if (opt.icon) {
    // Rendered first, in a browser without the extension, so the copy staged
    // below carries the new icon.
    const plain = await launch(join(stage, 'udd-icon'), []);
    try {
      const p = plain.pages()[0] || (await plain.newPage());
      await p.setViewportSize({ width: 128, height: 128 });
      await p.setContent(iconPage(), { waitUntil: 'load' });
      const icon = await p.screenshot({ omitBackground: true, scale: 'css' });
      const info = readPng(icon);
      if (info.width !== 128 || info.height !== 128 || info.channels !== 4) throw new Error(`the icon came out ${info.width}x${info.height}, ${info.channels} channels`);
      writeFileSync(join(ROOT, 'icons', 'icon-128.png'), icon);
      console.log('wrote icons/icon-128.png');
    } finally {
      await plain.close();
    }
  }
  for (const p of ['manifest.json', 'src', 'icons']) cpSync(join(ROOT, p), join(ext, p), { recursive: true });

  ctx = await launch(udd, [
    `--disable-extensions-except=${ext}`,
    `--load-extension=${ext}`,
    // Only x.com and twitter.com are answered locally; the list host is real.
    `--host-resolver-rules=MAP x.com 127.0.0.1:${port}, MAP twitter.com 127.0.0.1:${port}`,
    '--ignore-certificate-errors',
  ]);
  const page = ctx.pages()[0] || (await ctx.newPage());

  let [sw0] = ctx.serviceWorkers();
  if (!sw0) sw0 = await ctx.waitForEvent('serviceworker', { timeout: 30000 });
  const extId = new URL(sw0.url()).host;
  const sw = () => ctx.serviceWorkers().find((w) => w.url().includes(extId)) || sw0;
  const local = (keys) => sw().evaluate((k) => chrome.storage.local.get(k), keys);
  const setSettings = (patch) =>
    sw().evaluate(async (p) => {
      const o = await chrome.storage.local.get('xsh:settings');
      await chrome.storage.local.set({ 'xsh:settings': Object.assign({}, o['xsh:settings'] || {}, p) });
    }, patch);

  const list = await until(async () => {
    const r = (await local('xsh:list'))['xsh:list'];
    return r && (r.handles.length || r.lastError) ? r : null;
  }, 30000, 'the list download');
  if (!list.handles.length) throw new Error(`the list did not download: ${list.lastError}`);
  if (SPAM.concat('xsh_demo_bot4').some((h) => list.handles.includes(h))) throw new Error('an example handle is on the real list; pick others');
  console.log(`list: ${list.handles.length} handles from ${list.source}`);
  await setSettings({ extraList: SPAM.join('\n') });

  // ---- 1. the same thread paused and hiding
  const x = await ctx.newPage();
  await x.setViewportSize({ width: 580, height: STAGE_H });
  await x.goto(`https://x.com${threadPath(1000)}`);
  const hiddenNow = (n) => x.waitForFunction((k) => document.querySelectorAll('[data-xsh-hidden]').length === k, n, { timeout: 15000 });
  await hiddenNow(SPAM.length);
  await sleep(300);
  const on = await x.screenshot();
  await setSettings({ paused: true });
  await hiddenNow(0);
  await sleep(300);
  const paused = await x.screenshot();
  await setSettings({ paused: false });
  await hiddenNow(SPAM.length);

  // ---- 2 and 3. the popup, pointed at the example tab
  // Without the "tabs" permission tab addresses are hidden, so the example tab
  // is the one whose content script answers.
  const xTab = await sw().evaluate(async () => {
    for (const t of await chrome.tabs.query({})) {
      try {
        if (await chrome.tabs.sendMessage(t.id, { type: 'xsh:stats' })) return t.id;
      } catch (_) {
        // No content script in this tab.
      }
    }
    return null;
  });
  if (xTab === null) throw new Error('no tab answered as the example x.com tab');
  const popup = await ctx.newPage();
  await popup.setViewportSize({ width: 400, height: 700 });
  await popup.addInitScript((id) => {
    const query = chrome.tabs.query.bind(chrome.tabs);
    chrome.tabs.query = (info) => (info && info.active && info.currentWindow ? chrome.tabs.get(id).then((t) => [t]) : query(info));
  }, xTab);
  const openPopup = async () => {
    await popup.goto(`chrome-extension://${extId}/src/popup.html`);
    await popup.waitForFunction(() => /^This tab: |^Paused on this tab/.test(document.getElementById('tab').textContent), null, { timeout: 15000 });
    await sleep(300);
  };
  await openPopup();
  console.log(`popup: ${await popup.textContent('#tab')} | ${await popup.textContent('#list')}`);
  // The top of the popup: the header, the tab and list card, and the start of
  // the muting card, which the composition fades out.
  const cut = await popup.evaluate(() => Math.ceil(document.querySelectorAll('section.card')[1].getBoundingClientRect().top + 64));
  const top = await popup.screenshot({ clip: { x: 0, y: 0, width: 400, height: cut } });
  await popup.evaluate(() => {
    document.querySelector('details.more').open = true;
  });
  const muting = await popup.locator('section.card').nth(1).screenshot();

  // ---- 4. labels, with hiding paused so the labelled replies stay in view
  await setSettings({ labeling: true, paused: true });
  await x.setViewportSize({ width: 700, height: STAGE_H });
  await x.goto(`https://x.com${threadPath(2000)}`);
  await x.waitForFunction((n) => document.querySelectorAll('[data-xsh-bar]').length === n, THREADS[2000].length, { timeout: 15000 });
  const press = async (handle, label) => {
    const b = x.locator(`[data-xsh-bar][data-xsh-author="${handle}"] button[data-xsh-label="${label}"]`);
    await b.click();
    await until(async () => (await b.getAttribute('aria-pressed')) === 'true', 10000, `${label} on @${handle} to save`);
  };
  await press('xsh_demo_bot4', 'slop');
  await press('xsh_demo_ana', 'not_slop');
  await sleep(400);
  const labelled = await x.screenshot();
  await openPopup();
  await popup.evaluate(() => {
    document.getElementById('labeling').closest('details').open = true;
  });
  const labelsCard = await popup.locator('details.card', { has: popup.locator('#labeling') }).screenshot();

  // ---- compose
  const shoot = async (name, html, w, h) => {
    await page.setViewportSize({ width: w, height: h });
    await page.setContent(html, { waitUntil: 'load' });
    await sleep(200);
    const png = flattenPng(await page.screenshot({ scale: 'css' }));
    const info = readPng(png);
    if (info.width !== w || info.height !== h || info.channels !== 3) throw new Error(`${name} came out ${info.width}x${info.height}, ${info.channels} channels`);
    writeFileSync(join(out, name), png);
    console.log(`wrote ${name} ${w}x${h}`);
  };
  await shoot(
    'screenshot-1-hide.png',
    frame('Hide AI reply spam on x.com', 'Posts by accounts on the clankwall list, or by accounts you add, are hidden from the page.', 'Example thread with made-up accounts.', panel(paused, 40, 580, ['Paused', '#d97706']) + panel(on, 660, 580, ['Hiding on', '#e11d48'])),
    1280,
    800,
  );
  await shoot(
    'screenshot-2-popup.png',
    frame('See what was hidden, pause any time', 'The popup counts what this tab hid. The list refreshes every 6 hours, or when you click Refresh list now.', 'Example thread with made-up accounts.', panel(on, 40, 580) + popupTop(top, 660, 580, 1.4)),
    1280,
    800,
  );
  await shoot(
    'screenshot-3-muting.png',
    frame('Muting is off until you turn it on', "Turned on, it clicks X's own Mute in background tabs, up to 25, 50 or 100 accounts a day.", '', card(muting, 40, 1200, 1.45)),
    1280,
    800,
  );
  await shoot(
    'screenshot-4-labels.png',
    frame('Label replies to fix your own lists', 'Slop adds the account to Also hide; Not slop adds it to Always show. Labels stay in this browser.', 'Example thread with made-up accounts, hiding paused.', panel(labelled, 40, 700) + card(labelsCard, 780, 460, 1.1)),
    1280,
    800,
  );
  await shoot('promo-small-440x280.png', tile(), 440, 280);
} finally {
  if (ctx) await ctx.close().catch(() => {});
  if (server) server.close();
  if (!opt.keep) rmSync(stage, { recursive: true, force: true });
  else console.log(`stage kept: ${stage}`);
}
