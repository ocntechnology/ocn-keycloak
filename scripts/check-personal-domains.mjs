#!/usr/bin/env node
// The personal (free-mail) domain list has one source: packages/auth/src/personal-email-domains.json
// in the civicos repo. This repo keeps a byte-identical copy for the Keycloak extension
// (extension/src/main/resources/personal-email-domains.json). This script compares the two.
//
//   node scripts/check-personal-domains.mjs [path/to/civicos/checkout]
//
// Exit 0 when they match, 2 when they differ, 0 with a note when no civicos checkout is found
// (CI without the other repo). Defaults: $CIVICOS_REPO, ~/Repositories/civicos-identity, ~/Repositories/civicos.
import { existsSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { REPO } from './realm/lib.mjs';

const ours = join(REPO, 'extension', 'src', 'main', 'resources', 'personal-email-domains.json');
const candidates = [process.argv[2], process.env.CIVICOS_REPO, join(process.env.HOME || '', 'Repositories', 'civicos-identity'), join(process.env.HOME || '', 'Repositories', 'civicos')]
  .filter(Boolean).map((d) => join(d, 'packages', 'auth', 'src', 'personal-email-domains.json'));
const theirs = candidates.find((p) => existsSync(p));
const sha = (p) => createHash('sha256').update(readFileSync(p)).digest('hex');

if (!theirs) {
  console.log(`no civicos checkout found (looked for ${candidates.join(', ')}); nothing to compare`);
  process.exit(0);
}
const a = sha(ours);
const b = sha(theirs);
if (a === b) {
  console.log(`personal-email-domains.json matches ${theirs}`);
  process.exit(0);
}
const list = (p) => { const j = JSON.parse(readFileSync(p, 'utf8')); return { d: new Set(j.domains), p: JSON.stringify(j.patterns || []) }; };
const x = list(ours);
const y = list(theirs);
console.log(`personal-email-domains.json differs from ${theirs}`);
for (const d of y.d) if (!x.d.has(d)) console.log(`  only in civicos: ${d}`);
for (const d of x.d) if (!y.d.has(d)) console.log(`  only here: ${d}`);
if (x.p !== y.p) console.log(`  patterns differ: here ${x.p}, civicos ${y.p}`);
console.log(`copy it: cp ${theirs} ${ours}`);
process.exit(2);
