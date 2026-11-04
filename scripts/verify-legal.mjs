import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = new URL('..', import.meta.url).pathname;
const failures = [];
const checks = [];

function check(name, condition, detail = '') {
  checks.push(name);
  if (!condition) failures.push(`${name}${detail ? `: ${detail}` : ''}`);
}

function read(path) {
  return readFileSync(join(root, path), 'utf8');
}

const ANALYSIS = 'docs/legal/license-analysis.md';
const CATALOG = 'docs/legal/vendor-catalog.tsv';
const PRODUCTION = 'docs/legal/production-dependencies.tsv';
const SBOM = 'docs/legal/sbom.cdx.json';
const ALLOWED_STATES = new Set(['version-dependent', 'terms-review', 'identity-unknown']);

// 1. Upstream reference licence is the actual pinned text, not a misleading summary.
const licenceHash = createHash('sha256').update(readFileSync(join(root, '..', 'LICENSE'))).digest('hex');
const analysis = read(ANALYSIS);
check('analysis names BSD 3-Clause', /BSD 3-Clause/.test(analysis));
check('analysis records pinned LICENSE digest', analysis.includes(licenceHash), `expected ${licenceHash}`);
check('analysis does not claim the project is MIT', !/StackManage[^\n]*\bMIT\b/.test(analysis));

// 2. Vendor catalog is complete and never presents an unresolved vendor as approved.
const rows = read(CATALOG).trim().split('\n').map(line => line.split('\t'));
const header = rows.shift() ?? [];
check('catalog header', header.join('\t') === 'id\tmodule\tlicenseCandidate\tsourceUrl\tlicenseUrl\treviewState\tnote', header.join('\t'));
const ids = new Set();
for (const [id, , licence, sourceUrl, licenceUrl, state, note] of rows) {
  check(`catalog row ${id} has id`, Boolean(id));
  check(`catalog row ${id} unique`, !ids.has(id), 'duplicate id');
  ids.add(id);
  check(`catalog row ${id} licence evidence`, Boolean(licence));
  check(`catalog row ${id} source https`, /^https:\/\//.test(sourceUrl ?? ''));
  check(`catalog row ${id} licence url https`, /^https:\/\//.test(licenceUrl ?? ''));
  check(`catalog row ${id} review state`, ALLOWED_STATES.has(state), state);
  check(`catalog row ${id} note`, Boolean(note));
}
check('catalog has rows', rows.length > 0);

// 3. Production dependencies stay permissive; copyleft must be explicitly reviewed later.
const production = read(PRODUCTION).trim().split('\n').slice(1).filter(Boolean).map(line => line.split('\t'));
const permissive = new Set(['MIT', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', 'Apache-2.0', '0BSD', 'BlueOak-1.0.0']);
for (const [name, version, licence] of production) {
  check(`production ${name}@${version} permissive`, permissive.has(licence), licence);
}
check('production inventory not empty', production.length > 0);

// 4. SBOM is machine-readable, complete enough, and free of local absolute paths.
const sbom = JSON.parse(read(SBOM));
check('SBOM CycloneDX', sbom.bomFormat === 'CycloneDX' && typeof sbom.specVersion === 'string');
check('SBOM metadata component', Boolean(sbom.metadata?.component?.name));
check('SBOM components', Array.isArray(sbom.components) && sbom.components.length > 0);
check('SBOM dependency graph', Object.keys(sbom.dependencies ?? {}).length > 0);
const serialised = JSON.stringify(sbom);
check('SBOM has no local absolute path', !/\/(?:home|tmp|Users)\//.test(serialised));
check('SBOM has no legacy project path', !/FlyEnv/i.test(serialised));
for (const file of ['pnpm-tree.raw.json', 'pnpm-licenses.raw.json', 'production-dependencies.tsv']) {
  const content = read(`docs/legal/${file}`);
  check(`${file} has no local absolute path`, !/\/(?:home|tmp|Users)\//.test(content));
}

// 5. Shipped application code contains no FlyEnv branding or byte-identical assets.
const assetPattern = /\.(png|jpe?g|webp|gif|ico|icns|svg)$/i;
const forbidden = /(flyenv|macphpstudy|xpf0000)/i;
const scanDirs = ['apps', 'packages'];
const legacyDirs = ['build', 'public', 'static', 'src'];
const assets = [];
const brandHits = [];
function walk(dir, visit) {
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    const info = statSync(path);
    if (info.isDirectory()) {
      if (entry === 'node_modules' || entry === 'dist' || entry === '.turbo') continue;
      walk(path, visit);
    } else {
      visit(path);
    }
  }
}
for (const dir of scanDirs) walk(join(root, dir), path => {
  if (assetPattern.test(path)) assets.push(path);
  else if (/\.(ts|vue|mjs|js|css|html|json)$/.test(path) && forbidden.test(readFileSync(path, 'utf8'))) brandHits.push(relative(root, path));
});

const legacyRoot = join(root, '..');
const legacyHashes = new Map();
for (const dir of legacyDirs) {
  walk(join(legacyRoot, dir), path => {
    if (!assetPattern.test(path)) return;
    const hash = createHash('sha256').update(readFileSync(path)).digest('hex');
    legacyHashes.set(hash, relative(legacyRoot, path));
  });
}
const copied = assets.filter(path => legacyHashes.has(createHash('sha256').update(readFileSync(path)).digest('hex')));
check('no byte-identical legacy assets', copied.length === 0, copied.map(path => `${relative(root, path)} = ${legacyHashes.get(createHash('sha256').update(readFileSync(path)).digest('hex'))}`).join(', '));
check('no legacy branding in shipped code', brandHits.length === 0, brandHits.join(', '));

// 6. Notices exist and name the reference plus unresolved vendor policy.
const notices = read('THIRD_PARTY_NOTICES.md');
check('notices include reference BSD text', /BSD 3-Clause License/.test(notices) && /FlyEnv/.test(notices));
check('notices state no redistribution of proprietary vendors', /Do not bundle/i.test(notices));
check('notices require unresolved vendors to block release', /identity-unknown|terms-review/.test(notices));

if (failures.length > 0) {
  console.error(`LEGAL_VERIFY_FAILED (${failures.length}/${checks.length})`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exitCode = 1;
} else {
  console.log(`LEGAL_VERIFY_OK: ${checks.length} checks, ${production.length} production packages, ${rows.length} vendor rows, ${sbom.components.length} SBOM components`);
}
