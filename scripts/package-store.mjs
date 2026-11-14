// Builds the Chrome Web Store zip from a commit, and checks it.
//   node scripts/package-store.mjs                 zip HEAD into build/
//   node scripts/package-store.mjs --ref v0.5.0    zip a tag or commit
//   node scripts/package-store.mjs --out <dir>     write the zip elsewhere
//
// The zip is built with git archive, so uncommitted edits never reach the
// store. It holds manifest.json at its root, LICENSE, and exactly the files the
// extension loads: the manifest's worker, content scripts, popup and icons,
// what the popup page loads, and what the worker imports. The userscript's
// adapter and the source SVG stay out.
//
// It refuses a manifest with a "key" (the store assigns the id), a name over
// 75 or a description over 132 characters, a version that differs from
// package.json, a file the extension loads that is missing from the commit,
// and a script that does not parse.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, posix, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Shipped though the extension never loads it.
export const EXTRA_FILES = Object.freeze(['LICENSE']);

const VERSION_RE = /^(0|[1-9][0-9]{0,4})(\.(0|[1-9][0-9]{0,4})){0,3}$/;
const chars = (s) => Array.from(String(s)).length;

// Problems with the manifest itself, as sentences. Empty when it is fine.
export function checkManifest(m, packageVersion) {
  if (!m || typeof m !== 'object' || Array.isArray(m)) return ['manifest.json is not a JSON object'];
  const errors = [];
  if (m.manifest_version !== 3) errors.push(`manifest_version is ${m.manifest_version}, not 3`);
  if (Object.hasOwn(m, 'key')) errors.push('manifest.json has a "key"; the store assigns the id, so remove it');
  if (typeof m.name !== 'string' || !m.name.trim()) errors.push('manifest.json has no name');
  else if (chars(m.name) > 75) errors.push(`name is ${chars(m.name)} characters; the limit is 75`);
  if (typeof m.description !== 'string' || !m.description.trim()) errors.push('manifest.json has no description');
  else if (chars(m.description) > 132) errors.push(`description is ${chars(m.description)} characters; the limit is 132`);
  if (typeof m.version !== 'string' || !VERSION_RE.test(m.version) || m.version.split('.').some((n) => Number(n) > 65535)) {
    errors.push(`version ${JSON.stringify(m.version)} is not 1 to 4 dot-separated whole numbers up to 65535`);
  } else if (packageVersion !== undefined && m.version !== packageVersion) {
    errors.push(`manifest.json version ${m.version} differs from package.json version ${packageVersion}`);
  }
  return errors;
}

const isExternal = (p) => /^([a-z][a-z0-9+.-]*:|\/\/|#)/i.test(p);

// Every path the extension loads, from the manifest and then from the files it
// names: <script src>, <link href> and <img src> in its pages, importScripts()
// in its scripts. read(path) returns a file's text, or null when it is missing.
// Returns { paths, missing, external }, each sorted.
export function referencedPaths(manifest, read) {
  const paths = new Set();
  const missing = new Set();
  const external = new Set();
  const queue = [];
  const add = (p, from) => {
    if (typeof p !== 'string' || !p) return;
    if (isExternal(p)) {
      external.add(p);
      return;
    }
    const full = posix.normalize(posix.join(from ? posix.dirname(from) : '', p.split(/[?#]/)[0]));
    if (full.startsWith('../') || full.startsWith('/')) throw new Error(`${from || 'manifest.json'} loads ${p}, outside the extension`);
    if (paths.has(full)) return;
    paths.add(full);
    queue.push(full);
  };
  const icons = (v) => (typeof v === 'string' ? [v] : Object.values(v || {}));

  const m = manifest || {};
  add(m.background && m.background.service_worker);
  for (const cs of m.content_scripts || []) for (const p of [...(cs.js || []), ...(cs.css || [])]) add(p);
  add(m.action && m.action.default_popup);
  for (const p of [...icons(m.icons), ...icons(m.action && m.action.default_icon)]) add(p);
  add(m.options_page);
  add(m.options_ui && m.options_ui.page);
  for (const w of m.web_accessible_resources || []) for (const p of w.resources || []) add(p);

  while (queue.length) {
    const p = queue.shift();
    if (!/\.(html?|js|mjs)$/i.test(p)) continue;
    const text = read(p);
    if (text === null) {
      missing.add(p);
      continue;
    }
    if (/\.html?$/i.test(p)) {
      for (const tag of text.match(/<(script|link|img)\b[^>]*>/gi) || []) {
        const attr = /\b(src|href)\s*=\s*["']([^"']+)["']/i.exec(tag);
        if (attr) add(attr[2], p);
      }
    } else {
      for (const call of text.matchAll(/\bimportScripts\s*\(([^)]*)\)/g)) {
        for (const arg of call[1].matchAll(/["']([^"']+)["']/g)) add(arg[1], p);
      }
    }
  }
  for (const p of paths) if (!/\.(html?|js|mjs)$/i.test(p) && read(p) === null) missing.add(p);
  const sorted = (s) => [...s].sort();
  return { paths: sorted(paths), missing: sorted(missing), external: sorted(external) };
}

// File names in a zip, read from its central directory.
export function zipEntries(buf) {
  const EOCD = 0x06054b50;
  const CEN = 0x02014b50;
  let end = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
    if (buf.readUInt32LE(i) === EOCD) {
      end = i;
      break;
    }
  }
  if (end < 0) throw new Error('not a zip file: no end of central directory');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const names = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(at) !== CEN) throw new Error(`bad central directory entry ${n}`);
    const nameLen = buf.readUInt16LE(at + 28);
    const extraLen = buf.readUInt16LE(at + 30);
    const commentLen = buf.readUInt16LE(at + 32);
    names.push(buf.toString('utf8', at + 46, at + 46 + nameLen));
    at += 46 + nameLen + extraLen + commentLen;
  }
  return names;
}

function git(args, opts = {}) {
  return execFileSync('git', args, { cwd: ROOT, encoding: opts.encoding === null ? null : 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 });
}

// Build and check the zip for one commit. Throws an Error whose `problems`
// lists every check that failed; nothing is written then.
export function packageStore({ ref = 'HEAD', out = join(ROOT, 'build') } = {}) {
  const sha = git(['rev-parse', '--verify', '--end-of-options', `${ref}^{commit}`]).trim();
  const read = (p) => {
    try {
      return git(['show', `${sha}:${p}`]);
    } catch (_) {
      return null;
    }
  };
  const problems = [];
  const parse = (p) => {
    const text = read(p);
    if (text === null) {
      problems.push(`${p} is missing in ${sha}`);
      return null;
    }
    try {
      return JSON.parse(text);
    } catch (e) {
      problems.push(`${p} is not valid JSON: ${e.message}`);
      return null;
    }
  };
  const manifest = parse('manifest.json');
  const pkg = parse('package.json');
  if (manifest) problems.push(...checkManifest(manifest, pkg ? pkg.version : undefined));

  let refs = { paths: [], missing: [], external: [] };
  if (manifest) {
    try {
      refs = referencedPaths(manifest, read);
    } catch (e) {
      problems.push(e.message);
    }
  }
  for (const p of refs.missing) problems.push(`the extension loads ${p}, which is missing in ${sha}`);
  for (const p of refs.external) problems.push(`the extension loads ${p} from outside the package; remotely hosted code is not allowed`);
  for (const p of EXTRA_FILES) if (read(p) === null) problems.push(`${p} is missing in ${sha}`);

  const scratch = mkdtempSync(join(tmpdir(), 'xsh-package-'));
  try {
    for (const p of refs.paths.filter((x) => /\.m?js$/.test(x) && !refs.missing.includes(x))) {
      const file = join(scratch, p.replaceAll('/', '__'));
      writeFileSync(file, read(p));
      try {
        execFileSync(process.execPath, ['--check', file], { stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (e) {
        problems.push(`${p} does not parse: ${String(e.stderr || e.message).trim().split('\n').slice(0, 5).join(' ')}`);
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  if (problems.length) {
    const err = new Error(`store zip refused for ${sha}:\n- ${problems.join('\n- ')}`);
    err.problems = problems;
    throw err;
  }

  const files = ['manifest.json', ...refs.paths, ...EXTRA_FILES].sort();
  const dir = resolve(out);
  mkdirSync(dir, { recursive: true });
  const zipPath = join(dir, `ai-anti-slop-${manifest.version}-chrome-web-store.zip`);
  git(['archive', '--format=zip', '-o', zipPath, sha, '--', ...files]);
  const buf = readFileSync(zipPath);
  const entries = zipEntries(buf).filter((n) => !n.endsWith('/')).sort();
  if (entries.join('\n') !== files.join('\n')) {
    rmSync(zipPath, { force: true });
    throw new Error(`the zip's files differ from the files chosen:\nzip: ${entries.join(', ')}\nchosen: ${files.join(', ')}`);
  }
  return { sha, version: manifest.version, zipPath, entries, sha256: createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { ref: { type: 'string', default: 'HEAD' }, out: { type: 'string', default: join(ROOT, 'build') } } });
  try {
    const r = packageStore({ ref: values.ref, out: values.out });
    console.log(`commit   ${r.sha}`);
    console.log(`version  ${r.version}`);
    console.log(`zip      ${r.zipPath}`);
    console.log(`sha256   ${r.sha256}`);
    console.log(`size     ${r.bytes} bytes, ${r.entries.length} files`);
    for (const e of r.entries) console.log(`  ${e}`);
  } catch (e) {
    console.error(e.message);
    process.exit(1);
  }
}
