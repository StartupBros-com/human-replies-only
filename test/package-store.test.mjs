// The Chrome Web Store zip: the manifest checks, which files go in, and one
// real build of HEAD with git archive.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkManifest, packageStore, referencedPaths } from '../scripts/package-store.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf8'));
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
const readTree = (p) => {
  try {
    return readFileSync(join(root, p), 'utf8');
  } catch (_) {
    return null;
  }
};

const LOADED = [
  'icons/icon-128.png',
  'icons/icon-16.png',
  'icons/icon-32.png',
  'icons/icon-48.png',
  // The popup header draws the vector icon so it stays sharp at 24px on any
  // screen; the settings page and the manifest still use the PNGs.
  'icons/icon.svg',
  'src/background.js',
  'src/content.js',
  'src/lib.js',
  'src/popup.html',
  'src/popup.js',
  'src/settings.html',
  'src/settings.js',
];

test('the manifest passes the store checks', () => {
  assert.deepEqual(checkManifest(manifest, pkg.version), []);
});

test('a manifest key, a long name or description, a bad version or a version mismatch is refused', () => {
  const base = { manifest_version: 3, name: 'x', description: 'd', version: '1.2.3' };
  assert.deepEqual(checkManifest(base, '1.2.3'), []);
  assert.match(checkManifest({ ...base, key: 'abc' }, '1.2.3').join(), /has a "key"/);
  assert.deepEqual(checkManifest({ ...base, description: 'a'.repeat(132) }, '1.2.3'), []);
  assert.match(checkManifest({ ...base, description: 'a'.repeat(133) }, '1.2.3').join(), /133 characters; the limit is 132/);
  assert.deepEqual(checkManifest({ ...base, name: 'n'.repeat(75) }, '1.2.3'), []);
  assert.match(checkManifest({ ...base, name: 'n'.repeat(76) }, '1.2.3').join(), /76 characters; the limit is 75/);
  assert.match(checkManifest(base, '1.2.4').join(), /differs from package.json version 1.2.4/);
  assert.match(checkManifest({ ...base, version: '1.02' }).join(), /not 1 to 4/);
  assert.match(checkManifest({ ...base, version: '1.70000' }).join(), /not 1 to 4/);
  assert.match(checkManifest({ ...base, version: '1.2.3.4.5' }).join(), /not 1 to 4/);
  assert.match(checkManifest({ ...base, manifest_version: 2 }).join(), /manifest_version is 2/);
  assert.deepEqual(checkManifest([]), ['manifest.json is not a JSON object']);
});

test('the extension loads its worker, content scripts, popup, options page, their scripts and image, and its icons', () => {
  const r = referencedPaths(manifest, readTree);
  assert.deepEqual(r.paths, LOADED);
  assert.deepEqual(r.missing, []);
  assert.deepEqual(r.external, []);
  assert.ok(!r.paths.includes('src/userscript-adapter.js'));
});

test('worker imports, page scripts and images are followed, and missing ones reported', () => {
  const files = {
    'src/w.js': "importScripts('a.js', \"b.js\");",
    'src/a.js': '',
    'src/p.html': '<script src="c.js"></script><img src="../i.png"><a href="https://example.com/">not loaded</a>',
  };
  const m = { background: { service_worker: 'src/w.js' }, action: { default_popup: 'src/p.html' }, icons: { 16: 'i16.png' } };
  const r = referencedPaths(m, (p) => (p in files ? files[p] : null));
  assert.deepEqual(r.paths, ['i.png', 'i16.png', 'src/a.js', 'src/b.js', 'src/c.js', 'src/p.html', 'src/w.js']);
  assert.deepEqual(r.missing, ['i.png', 'i16.png', 'src/b.js', 'src/c.js']);
  assert.deepEqual(r.external, []);
});

test('a page that loads a remote script is reported, and a path outside the package throws', () => {
  const m = { action: { default_popup: 'p.html' } };
  assert.deepEqual(referencedPaths(m, () => '<script src="https://cdn.example.com/x.js"></script>').external, ['https://cdn.example.com/x.js']);
  assert.throws(() => referencedPaths({ action: { default_popup: '../p.html' } }, () => ''), /outside the extension/);
});

test('the zip built from HEAD holds the manifest at its root, LICENSE and the loaded files, nothing else', () => {
  const out = mkdtempSync(join(tmpdir(), 'xsh-zip-test-'));
  try {
    const r = packageStore({ ref: 'HEAD', out });
    assert.deepEqual(r.entries, ['LICENSE', 'manifest.json', ...LOADED].sort());
    assert.match(r.zipPath, /x-slop-hide-\d+\.\d+\.\d+-chrome-web-store\.zip$/);
    assert.match(r.sha256, /^[0-9a-f]{64}$/);
  } finally {
    rmSync(out, { recursive: true, force: true });
  }
});

test('a ref that is not a commit is refused', () => {
  assert.throws(() => packageStore({ ref: 'no-such-ref-xsh', out: tmpdir() }));
});
