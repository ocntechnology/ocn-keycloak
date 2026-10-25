#!/usr/bin/env node
// Send the account-erasure notice again for a deleted account, to every product or one client.
// Keycloak sends it by itself when an account is deleted (event listener civicos-erasure); use
// this when a product was down then (Keycloak's log says "CivicOS erasure FAILED").
//
//   node scripts/erasure/resend.mjs --sub <keycloak user id> [--client civicos-discuss] [--realm ocn]
//
// Needs a service account in the realm with realm-management manage-users: KC_ADMIN_CLIENT_ID and
// KC_ADMIN_CLIENT_SECRET (production), or locally the registry sync account from clients.env.
import { existsSync, readFileSync } from 'node:fs';
import { Admin, parseArgs } from '../realm/lib.mjs';

const args = parseArgs(process.argv.slice(2));
if (!args.sub) { console.error('usage: resend.mjs --sub <user id> [--client <clientId>]'); process.exit(2); }
const realm = args.realm || 'ocn';
const local = `${process.env.HOME}/Repositories/ocn-keycloak/local/clients.env`;
if (!process.env.KC_ADMIN_CLIENT_ID && existsSync(local)) {
  const line = readFileSync(local, 'utf8').split('\n').find((l) => l.startsWith('CIVICOS_REGISTRY_SYNC_CLIENT_SECRET='));
  if (line) { process.env.KC_ADMIN_CLIENT_ID = 'civicos-registry-sync'; process.env.KC_ADMIN_CLIENT_SECRET = line.split('=')[1].trim(); }
}
const kc = Admin.fromEnv(realm);
const token = await kc.auth();
const res = await fetch(`${kc.server}/realms/${realm}/civicos-erasure/resend`, {
  method: 'POST',
  headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
  body: JSON.stringify({ sub: args.sub, ...(args.client ? { clientId: args.client } : {}) }),
});
console.log(res.status, await res.text());
process.exit(res.ok ? 0 : 1);
