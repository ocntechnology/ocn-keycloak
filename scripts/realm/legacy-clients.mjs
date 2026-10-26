#!/usr/bin/env node
// Tighten live clients that apply.mjs does not manage, from realm/config/legacy-clients.json.
// Each change runs only when its flag is given, so nothing here happens by accident:
//
//   node scripts/realm/legacy-clients.mjs --constitution-admin --cms-localhost --dry-run
//   node scripts/realm/legacy-clients.mjs --constitution-admin --cms-localhost
//
// --dry-run prints every field that would change (live -> new) and writes nothing. Idempotent:
// a second run prints "already as configured". Admin credentials as for apply.mjs (KC_SERVER,
// KC_ADMIN / KC_ADMIN_PASSWORD, or KC_ADMIN_CLIENT_ID / KC_ADMIN_CLIENT_SECRET). Exit 1 on error.

import { join } from 'node:path';
import { Admin, CONFIG, parseArgs, readJson } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const dry = Boolean(args['dry-run']);
const { changes } = readJson(join(CONFIG, 'legacy-clients.json'));
const chosen = Object.keys(changes).filter((name) => args[name]);
if (!chosen.length) {
  console.error(`say which change to make: ${Object.keys(changes).map((n) => `--${n}`).join(' ')} (add --dry-run to only print it)`);
  process.exit(1);
}
const kc = Admin.fromEnv(args.realm);
const SEP = '##'; // Keycloak's separator inside the post.logout.redirect.uris attribute
// Keycloak keeps redirect URIs and web origins as sets, so lists compare without order.
const norm = (v) => (Array.isArray(v) ? [...v].map(String).sort() : v);
const same = (a, b) => JSON.stringify(norm(a)) === JSON.stringify(norm(b));
const show = (v) => (v === undefined ? '(unset)' : JSON.stringify(v));

/** The client representation after the change, and the list of differences from the live one. */
function plan(live, change) {
  const next = structuredClone(live);
  next.attributes = { ...(live.attributes || {}) };
  const diffs = [];
  const { attributes = {}, ...fields } = change.set || {};
  for (const [k, v] of Object.entries(fields)) {
    if (!same(live[k], v)) diffs.push(`${k}: ${show(live[k])} -> ${show(v)}`);
    next[k] = v;
  }
  for (const [k, v] of Object.entries(attributes)) {
    if (live.attributes?.[k] !== v) diffs.push(`attributes.${k}: ${show(live.attributes?.[k])} -> ${show(v)}`);
    next.attributes[k] = v;
  }
  for (const [k, drop] of Object.entries(change.remove || {})) {
    if (k === 'redirectUris' || k === 'webOrigins') {
      const kept = (live[k] || []).filter((u) => !drop.includes(u));
      if (kept.length !== (live[k] || []).length) diffs.push(`${k}: remove ${show(drop.filter((u) => (live[k] || []).includes(u)))}`);
      next[k] = kept;
    } else {
      const list = (live.attributes?.[k] || '').split(SEP).filter(Boolean);
      const kept = list.filter((u) => !drop.includes(u));
      if (kept.length !== list.length) diffs.push(`attributes.${k}: remove ${show(drop.filter((u) => list.includes(u)))}`);
      next.attributes[k] = kept.join(SEP);
    }
  }
  return { next, diffs };
}

async function main() {
  for (const name of chosen) {
    const change = changes[name];
    const live = await kc.client(change.clientId);
    if (!live) throw new Error(`client ${change.clientId} does not exist in realm ${args.realm} on ${kc.server}`);
    const { next, diffs } = plan(live, change);
    if (!diffs.length) { console.log(`${name} (${change.clientId}): already as configured`); continue; }
    console.log(`${dry ? '[dry-run] would change' : 'changing'} ${name} (${change.clientId}):`);
    for (const d of diffs) console.log(`  ${d}`);
    // Unchanged, for the record: anything the change does not mention stays as it is live.
    console.log(`  (left as live: serviceAccountsEnabled ${live.serviceAccountsEnabled}, publicClient ${live.publicClient}, client scopes and secret)`);
    if (dry) continue;
    await kc.put(`/clients/${live.id}`, next);
    const after = plan(await kc.client(change.clientId), change).diffs;
    if (after.length) throw new Error(`${name}: still differs after the update: ${after.join('; ')}`);
    console.log(`  done`);
  }
}

main().catch((e) => { console.error(e.message); process.exit(1); });
