// What the renames to Human Replies Only (0.7.0, issue #36) and AI Anti-Slop
// (0.7.1, issue #39) left under the old name on purpose. Each is how an
// installed copy or a saved file finds its data, so renaming one would
// strand something users already have.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildUserscript } from '../scripts/build-userscript.mjs';
import { src, lib } from './helpers.mjs';

const OLD_REPO = 'https://github.com/StartupBros-com/x-slop-hide';

// The userscript header as `@key value` pairs, in order.
function header() {
  const out = [];
  for (const line of buildUserscript().split('\n')) {
    if (line === '// ==/UserScript==') break;
    const m = /^\/\/ @(\S+)\s+(.*)$/.exec(line);
    if (m) out.push([m[1], m[2].trim()]);
  }
  return out;
}
const one = (key) => {
  const v = header().filter(([k]) => k === key);
  assert.equal(v.length, 1, `exactly one @${key}`);
  return v[0][1];
};

test('settings files keep the x-slop-hide-settings tag, so 0.6.x and 0.7.0 read each other\'s exports', () => {
  assert.equal(lib.SETTINGS_FORMAT, 'x-slop-hide-settings', '0.6.x refuses any other tag');
  assert.equal(lib.settingsExport({}, Date.UTC(2026, 10, 12)).format, 'x-slop-hide-settings');
  // A file as 0.6.2's Export settings wrote it.
  const exported062 = {
    format: 'x-slop-hide-settings',
    version: 1,
    exported: '2026-11-09',
    alwaysShow: ['friend_one'],
    alsoHide: ['spam_a'],
    bots: { grok: 'mute' },
    hideBotMentions: true,
  };
  const r = lib.readSettingsFile(JSON.stringify(exported062));
  assert.equal(r.ok, true, r.error);
});

test('storage keys keep the xsh: prefix, so an updated copy finds its settings, lists, mute record and labels', () => {
  assert.deepEqual({ ...lib.STORAGE_KEYS }, {
    list: 'xsh:list',
    settings: 'xsh:settings',
    mutes: 'xsh:mutes',
    labelCount: 'xsh:labelCount',
  });
  assert.equal(lib.LABEL_PREFIX, 'xsh:label:');
});

test('the userscript keeps the @name and @namespace managers know it by, and its file path', () => {
  // A changed @name or @namespace can install as a second script instead of
  // updating the one already installed.
  assert.equal(one('name'), 'x-slop-hide');
  assert.equal(one('namespace'), OLD_REPO);
  assert.equal(one('name:en'), 'AI Anti-Slop');
  // Installed copies check the URL they were installed from; raw.githubusercontent.com
  // still serves the renamed repository under its old name.
  for (const key of ['downloadURL', 'updateURL']) {
    assert.ok(one(key).endsWith('/main/dist/x-slop-hide.user.js'), `@${key} keeps the file path`);
  }
  assert.equal(src('dist/x-slop-hide.user.js'), buildUserscript());
});

// The CSS between `@media (forced-colors: active) {` and its closing brace.
function forcedColorsBlock(css) {
  const open = '@media (forced-colors: active) {';
  const start = css.indexOf(open);
  assert.ok(start >= 0, 'the popup has a forced-colors block');
  let depth = 0;
  for (let i = start + open.length - 1; i < css.length; i++) {
    if (css[i] === '{') depth++;
    else if (css[i] === '}' && --depth === 0) return { start, end: i + 1, body: css.slice(start + open.length, i) };
  }
  throw new Error('unclosed forced-colors block');
}

test('popup: every switch with its own checked colour is restated in forced-colors mode, Pause and Mute included', () => {
  const css = src('src/popup.html').replace(/\/\*[\s\S]*?\*\//g, '');
  const fc = forcedColorsBlock(css);
  const outside = css.slice(0, fc.start) + css.slice(fc.end);
  // An id rule outranks `input[role='switch']:checked`, and forced colours draw
  // a non-system background as the page colour: a checked switch would look off.
  const coloured = [...outside.matchAll(/(#[\w-]+:checked)\s*\{[^}]*\bbackground\s*:/g)].map((m) => m[1]);
  assert.ok(coloured.includes('#paused:checked'), 'Pause has its own on colour');
  assert.ok(coloured.includes('#mute:checked'), 'Mute has its own on colour');
  assert.match(outside, /#paused:checked\s*\{\s*background:\s*var\(--bad\);/, 'Pause on is orange-red');
  const rule = /([^{}]*input\[role='switch'\]:checked[^{}]*)\{([^}]*)\}/.exec(fc.body);
  assert.ok(rule, 'forced-colors restates the checked track');
  const selectors = rule[1].split(',').map((s) => s.trim());
  for (const sel of coloured) assert.ok(selectors.includes(sel), `${sel} is restated in forced-colors mode`);
  assert.match(rule[2], /background:\s*Highlight/);
  // Chromium's dark forced palette puts Highlight at 2.29:1 on Canvas; a
  // ButtonText border keeps a checked switch's edge visible.
  assert.match(rule[2], /border-color:\s*ButtonText/);
});
