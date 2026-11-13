import test from 'node:test';
import assert from 'node:assert/strict';
import { lib } from './helpers.mjs';

const NOW = Date.UTC(2026, 10, 9, 12);
const read = (o) => lib.readSettingsFile(JSON.stringify(o));
const file = (extra = {}) => ({ format: 'x-slop-hide-settings', version: 1, ...extra });
const apply = (settings, plan) => Object.assign({}, settings, plan.patch);

test('settingsExport holds the account boxes, bot choices and tag setting, and nothing else', () => {
  const settings = {
    allowlist: 'Friend_One, @friend_two\nsixteen_chars_xx <b>',
    extraList: 'spam_b\nspam_a spam_b',
    bots: { grok: 'mute', askperplexity: 'show', pangram: 'loud', nobody: 'hide' },
    hideBotMentions: true,
    muteEnabled: true,
    muteCap: 100,
    muteAccount: 'me_here',
    feedUrl: 'https://example.com/list.txt',
    paused: true,
    labeling: true,
  };
  const out = lib.settingsExport(settings, NOW);
  assert.deepEqual(Object.keys(out).sort(), ['alsoHide', 'alwaysShow', 'bots', 'exported', 'format', 'hideBotMentions', 'version']);
  assert.equal(out.format, 'x-slop-hide-settings');
  assert.equal(out.version, 1);
  assert.equal(out.exported, '2026-11-09');
  assert.deepEqual(out.alwaysShow, ['friend_one', 'friend_two']);
  assert.deepEqual(out.alsoHide, ['spam_a', 'spam_b']);
  assert.deepEqual(out.bots, { grok: 'mute', askperplexity: 'show' });
  assert.equal(out.hideBotMentions, true);
  const text = JSON.stringify(out);
  for (const leak of ['me_here', 'example.com', 'muteEnabled', 'muteCap', 'paused', 'labeling']) {
    assert.ok(!text.includes(leak), `export leaked ${leak}`);
  }
});

test('settingsExport of empty settings, and the legacy showGrok switch', () => {
  assert.deepEqual(lib.settingsExport({}, NOW), {
    format: 'x-slop-hide-settings',
    version: 1,
    exported: '2026-11-09',
    alwaysShow: [],
    alsoHide: [],
    bots: {},
    hideBotMentions: false,
  });
  assert.deepEqual(lib.settingsExport({ showGrok: true }, NOW).bots, { grok: 'show' });
});

test('alsoHideText is Also hide as a list file: sorted, one handle per line', () => {
  assert.equal(lib.alsoHideText({ extraList: 'Spam_B, @spam_a\nspam_b' }), 'spam_a\nspam_b\n');
  assert.equal(lib.alsoHideText({}), '');
  const back = lib.readSettingsFile(lib.alsoHideText({ extraList: 'spam_b spam_a' }));
  assert.equal(back.kind, 'list');
  assert.deepEqual(back.alsoHide, ['spam_a', 'spam_b']);
});

test('readSettingsFile reads a settings file', () => {
  const r = read(file({ alwaysShow: ['Friend', '@pal'], alsoHide: ['spam'], bots: { GROK: 'hide' }, hideBotMentions: false }));
  assert.deepEqual(r, {
    ok: true,
    kind: 'settings',
    alwaysShow: ['friend', 'pal'],
    alsoHide: ['spam'],
    bots: { grok: 'hide' },
    hideBotMentions: false,
  });
  const bare = read(file());
  assert.equal(bare.ok, true);
  assert.deepEqual([bare.alwaysShow, bare.alsoHide, bare.bots, bare.hideBotMentions], [[], [], {}, undefined]);
});

test('readSettingsFile reads a list of handles: @ optional, # comments and blank lines skipped', () => {
  const r = lib.readSettingsFile('﻿# shared by a friend\r\n@Spam_One\r\n\r\nspam_two\nspam_one\n');
  assert.deepEqual(r, { ok: true, kind: 'list', alwaysShow: [], alsoHide: ['spam_one', 'spam_two'], bots: {}, hideBotMentions: undefined });
});

test('readSettingsFile refuses a bad file whole, with the reason', () => {
  const cases = [
    ['', 'the file is empty'],
    ['  \n ', 'the file is empty'],
    ['{"format": "x-slop-hide-settings", ', 'the file is not valid JSON'],
    ['{"labels": 1}\n{"labels": 2}\n', 'the file is not valid JSON'],
    [JSON.stringify({ format: 'something-else', version: 1 }), 'the file is not a Human Replies Only settings file'],
    ['[]', 'line 1 is not an X handle'],
    [JSON.stringify(file({ version: 2 })), 'this settings file comes from a newer or unknown version'],
    [JSON.stringify(file({ version: '1' })), 'this settings file comes from a newer or unknown version'],
    [JSON.stringify(file({ alwaysShow: 'friend' })), '"alwaysShow" is not a list'],
    [JSON.stringify(file({ alsoHide: ['ok_one', 'not a handle'] })), '"alsoHide" has an entry that is not an X handle'],
    [JSON.stringify(file({ alsoHide: [7] })), '"alsoHide" has an entry that is not an X handle'],
    [JSON.stringify(file({ bots: ['grok'] })), '"bots" is not an object'],
    [JSON.stringify(file({ bots: { someone: 'mute' } })), '"bots" names an account that is not one of the bots'],
    [JSON.stringify(file({ bots: { grok: 'block' } })), '"bots" has a choice other than show, hide or mute'],
    [JSON.stringify(file({ hideBotMentions: 'yes' })), '"hideBotMentions" is not true or false'],
    ['spam_one\nspam two\n', 'line 2 is not an X handle'],
    ['# only a comment\n\n', 'the file has no handles'],
    ['a'.repeat(1000001), 'the file is larger than 1 MB'],
  ];
  for (const [text, reason] of cases) {
    assert.deepEqual(lib.readSettingsFile(text), { ok: false, reason }, JSON.stringify(text).slice(0, 60));
  }
});

test('readSettingsFile never echoes file content in a refusal', () => {
  const r = lib.readSettingsFile('spam_one\n<img src=x onerror=alert(1)>\n');
  assert.equal(r.ok, false);
  assert.equal(r.reason, 'line 2 is not an X handle');
});

test('readSettingsFile refuses more than maxHandles accounts', () => {
  const n = lib.DEFAULTS.maxHandles + 1;
  const hs = Array.from({ length: n }, (_, i) => `h${i}`);
  assert.deepEqual(lib.readSettingsFile(hs.join('\n')), { ok: false, reason: `the file has more than ${n - 1} accounts` });
  assert.deepEqual(read(file({ alsoHide: hs })), { ok: false, reason: `"alsoHide" has more than ${n - 1} accounts` });
});

// Planted negative (issue #27): a file naming muting, its cap, its account
// and the list URL changes none of them.
test('import never writes muting, its cap, its account, the list URL, pause or labels', () => {
  const settings = { muteEnabled: false, muteCap: 25, muteAccount: 'me_here', feedUrl: '', paused: false, labeling: false };
  const r = read(
    file({
      alsoHide: ['spam'],
      muteEnabled: true,
      muteCap: 100,
      muteAccount: 'someone',
      feedUrl: 'https://evil.example/list.txt',
      paused: true,
      labeling: true,
    }),
  );
  assert.equal(r.ok, true);
  assert.deepEqual(Object.keys(r).sort(), ['alsoHide', 'alwaysShow', 'bots', 'hideBotMentions', 'kind', 'ok']);
  const plan = lib.importPlan(settings, r, []);
  for (const k of Object.keys(plan.patch)) assert.ok(lib.IMPORT_KEYS.includes(k), `patch wrote ${k}`);
  const next = apply(settings, plan);
  for (const k of ['muteEnabled', 'muteCap', 'muteAccount', 'feedUrl', 'paused', 'labeling']) {
    assert.equal(next[k], settings[k], k);
  }
  assert.equal(next.extraList, 'spam');
});

test('importPlan adds to both boxes and never removes an account', () => {
  const settings = { allowlist: 'pal, Friend  ', extraList: '# mine\nspam_a\n' };
  const r = read(file({ alwaysShow: ['friend', 'new_pal'], alsoHide: ['spam_a', 'spam_b'] }));
  const plan = lib.importPlan(settings, r, []);
  assert.deepEqual(plan.addShow, ['new_pal']);
  assert.deepEqual(plan.addHide, ['spam_b']);
  assert.equal(plan.patch.allowlist, 'pal, Friend\nnew_pal');
  assert.equal(plan.patch.extraList, '# mine\nspam_a\nspam_b');
  const next = apply(settings, plan);
  for (const h of ['pal', 'friend', 'new_pal']) assert.ok(lib.parseAllowlist(next.allowlist).has(h), h);
  for (const h of ['spam_a', 'spam_b']) assert.ok(lib.parseAllowlist(next.extraList).has(h), h);
  assert.equal(plan.empty, false);
});

test('importPlan of a file already applied changes nothing', () => {
  const settings = { allowlist: 'pal', extraList: 'spam', bots: { grok: 'hide' }, hideBotMentions: true };
  const r = read(lib.settingsExport(settings, NOW));
  const plan = lib.importPlan(settings, r, ['listed']);
  assert.equal(plan.empty, true);
  assert.deepEqual(plan.patch, {});
  assert.deepEqual([plan.addShow, plan.addHide, plan.botChanges, plan.muteTargets], [[], [], [], []]);
  assert.equal(plan.mentions, null);
});

test('importPlan applies bot choices and the tag setting, and names what changes', () => {
  const settings = { bots: { grok: 'hide', pangram: 'show' }, showGrok: true, hideBotMentions: false };
  const r = read(file({ bots: { grok: 'show', askperplexity: 'mute', pangram: 'show' }, hideBotMentions: true }));
  const plan = lib.importPlan(settings, r, []);
  assert.deepEqual(plan.botChanges, [
    { handle: 'grok', from: 'hide', to: 'show' },
    { handle: 'askperplexity', from: null, to: 'mute' },
  ]);
  assert.deepEqual(plan.patch.bots, { grok: 'show', pangram: 'show', askperplexity: 'mute' });
  assert.equal(plan.patch.hideBotMentions, true);
  assert.equal(plan.mentions, true);
  assert.deepEqual(plan.muteBots, ['askperplexity']);
  assert.ok(!('showGrok' in plan.patch));
});

test('importPlan overrides the legacy showGrok switch with a saved grok choice', () => {
  const settings = { showGrok: true };
  const plan = lib.importPlan(settings, read(file({ bots: { grok: 'hide' } })), ['grok']);
  assert.deepEqual(plan.botChanges, [{ handle: 'grok', from: 'show', to: 'hide' }]);
  assert.equal(lib.botChoice(apply(settings, plan), 'grok'), 'hide');
});

// A bot set to Show stays shown because of that choice, not because Always
// show has it, so the preview names it apart, with its own reason.
test('importPlan keeps bots set to Show apart from the accounts Always show keeps', () => {
  const settings = { allowlist: 'kept_pal\npangram', bots: { grok: 'show', pangram: 'show' } };
  const r = read(file({ alsoHide: ['grok', 'kept_pal', 'pangram', 'new_spam'] }));
  const plan = lib.importPlan(settings, r, []);
  assert.deepEqual(plan.addHide, ['grok', 'kept_pal', 'new_spam', 'pangram']);
  assert.deepEqual(plan.staysShown, ['kept_pal', 'pangram'], 'Always show wins the reason when both apply');
  assert.deepEqual(plan.staysShownBots, ['grok']);
  // A bot the same file sets to Show counts too.
  const viaFile = lib.importPlan({}, read(file({ alsoHide: ['askperplexity'], bots: { askperplexity: 'show' } })), []);
  assert.deepEqual([viaFile.staysShown, viaFile.staysShownBots], [[], ['askperplexity']]);
  const none = lib.importPlan({}, read(file({ alsoHide: ['grok'] })), []);
  assert.deepEqual([none.staysShown, none.staysShownBots], [[], []]);
});

test('importPlan names the accounts muting newly reaches, and Also hide accounts Always show keeps', () => {
  const settings = { allowlist: 'kept_pal', muteEnabled: true, muteAccount: 'me_here', muteCap: 50 };
  const r = read(file({ alsoHide: ['listed', 'new_spam', 'kept_pal'], bots: { pangram: 'mute', grok: 'hide' } }));
  const plan = lib.importPlan(settings, r, ['listed', 'grok']);
  assert.deepEqual(plan.addHide, ['kept_pal', 'listed', 'new_spam']);
  assert.deepEqual(plan.muteTargets, ['new_spam', 'pangram']);
  assert.deepEqual(plan.muteBots, ['pangram']);
  assert.deepEqual(plan.staysShown, ['kept_pal']);
  assert.deepEqual(plan.staysShownBots, []);
  assert.equal(plan.muting, true);
  assert.equal(plan.muteAccount, 'me_here');
  assert.equal(plan.muteCap, 50);
});

test('importPlan reports muting off until both the switch and an account are set', () => {
  const r = read(file({ alsoHide: ['spam'] }));
  assert.equal(lib.importPlan({ muteEnabled: true }, r, []).muting, false);
  assert.equal(lib.importPlan({ muteAccount: 'me_here' }, r, []).muting, false);
  const off = lib.importPlan({}, r, []);
  assert.equal(off.muting, false);
  assert.deepEqual(off.muteTargets, ['spam']);
  assert.equal(off.muteCap, 25);
});

test('importPlan of a list file adds to Also hide only', () => {
  const settings = { allowlist: 'pal', extraList: 'spam_a', bots: { grok: 'show' }, hideBotMentions: true };
  const plan = lib.importPlan(settings, lib.readSettingsFile('spam_b\n@spam_a\n'), []);
  assert.deepEqual(Object.keys(plan.patch), ['extraList']);
  assert.equal(plan.patch.extraList, 'spam_a\nspam_b');
  assert.equal(plan.mentions, null);
  assert.deepEqual(plan.botChanges, []);
});

test('round trip: export, then import into empty settings, gives the same lists and bot choices', () => {
  const settings = {
    allowlist: 'Pal, friend\n@third',
    extraList: 'spam_c spam_a\nspam_b',
    bots: { grok: 'mute', askperplexity: 'show', threadreaderapp: 'hide' },
    hideBotMentions: true,
    muteEnabled: true,
    muteAccount: 'me_here',
  };
  const text = JSON.stringify(lib.settingsExport(settings, NOW), null, 2);
  const plan = lib.importPlan({}, lib.readSettingsFile(text), ['listed']);
  const next = apply({}, plan);
  assert.deepEqual([...lib.effectiveAllow(next)].sort(), [...lib.effectiveAllow(settings)].sort());
  assert.deepEqual([...lib.parseAllowlist(next.extraList)].sort(), [...lib.parseAllowlist(settings.extraList)].sort());
  for (const { handle } of lib.BOTS) assert.equal(lib.botChoice(next, handle), lib.botChoice(settings, handle), handle);
  assert.equal(next.hideBotMentions, true);
  assert.deepEqual(lib.muteEligible(['listed'], next), lib.muteEligible(['listed'], settings));
  assert.equal(next.muteEnabled, undefined);
  assert.equal(next.muteAccount, undefined);
});
