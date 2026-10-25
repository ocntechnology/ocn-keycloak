#!/usr/bin/env node
// Compare a live Keycloak realm with the repo's realm/config and print every difference.
//
//   node scripts/realm/drift.mjs [--env local|production] [--realm ocn] [--json]
//
// Exit code 0 when they match, 2 when they differ (so a nightly job can alert), 1 on error.
// Also checks the platform rule for every OIDC client in the realm, not just ours: no direct
// access grants, PKCE S256, and no wildcard redirect URIs.

import { Admin, parseArgs, loadDesired, desiredFlowRows, liveFlowRows, diffObject } from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const desired = loadDesired(args.env);
const kc = Admin.fromEnv(args.realm);
const diffs = [];
const add = (area, text) => diffs.push({ area, text });

const SETTINGS_IGNORE = new Set(['smtpServer', 'userProfileAttributes']);
// Keycloak's own clients, apart from admin-cli: it is public, so it must not allow password grants either.
const BUILT_IN_CLIENTS = new Set(['account', 'account-console', 'broker', 'realm-management', 'security-admin-console']);

async function main() {
  const live = await kc.get('');
  const settings = Object.fromEntries(Object.entries(desired.settings).filter(([k]) => !SETTINGS_IGNORE.has(k)));
  for (const d of diffObject('realm', settings, live)) add('settings', d);
  // SMTP: compare host/port/from only (never print secrets).
  for (const k of ['host', 'port', 'from']) {
    if (String(desired.settings.smtpServer?.[k] ?? '') !== String(live.smtpServer?.[k] ?? '')) add('settings', `realm.smtpServer.${k}: repo ${desired.settings.smtpServer?.[k]} live ${live.smtpServer?.[k]}`);
  }

  const profile = await kc.get('/users/profile');
  for (const a of desired.settings.userProfileAttributes || []) {
    const l = profile.attributes.find((x) => x.name === a.name);
    if (!l) add('user profile', `attribute ${a.name} missing`);
    else if (JSON.stringify(l.permissions) !== JSON.stringify(a.permissions)) add('user profile', `attribute ${a.name} permissions differ`);
  }
  if (profile.unmanagedAttributePolicy !== 'ADMIN_EDIT') add('user profile', `unmanagedAttributePolicy is ${profile.unmanagedAttributePolicy}, repo ADMIN_EDIT`);

  for (const s of desired.scopes) {
    const l = await kc.scopeByName(s.name);
    if (!l) { add('client scopes', `${s.name} missing`); continue; }
    for (const m of s.protocolMappers || []) {
      const lm = (l.protocolMappers || []).find((x) => x.name === m.name);
      if (!lm) add('client scopes', `${s.name}: mapper ${m.name} missing`);
      else for (const d of diffObject(`${s.name}.${m.name}.config`, m.config, lm.config)) add('client scopes', d);
    }
  }

  for (const c of desired.clients) {
    const l = await kc.client(c.clientId);
    if (!l) { add('clients', `${c.clientId} missing`); continue; }
    const { defaultClientScopes, optionalClientScopes, serviceAccountRealmRoles, serviceAccountClientRoles, builtIn, ...rep } = c;
    void builtIn;
    for (const d of diffObject(c.clientId, rep, l)) add('clients', d);
    if (defaultClientScopes) {
      const names = (await kc.get(`/clients/${l.id}/default-client-scopes`)).map((s) => s.name);
      for (const d of diffObject(c.clientId, { defaultClientScopes }, { defaultClientScopes: names })) add('clients', d);
    }
    void optionalClientScopes; void serviceAccountRealmRoles; void serviceAccountClientRoles;
  }

  const allClients = await kc.get('/clients?max=1000');
  for (const c of allClients) {
    if (c.protocol !== 'openid-connect' || BUILT_IN_CLIENTS.has(c.clientId) || c.bearerOnly) continue;
    if (c.directAccessGrantsEnabled) add('client rules', `${c.clientId}: direct access grants are on`);
    if (c.standardFlowEnabled && c.attributes?.['pkce.code.challenge.method'] !== 'S256') add('client rules', `${c.clientId}: PKCE S256 is not required`);
    for (const u of c.redirectUris || []) if (u.includes('*')) add('client rules', `${c.clientId}: wildcard redirect URI ${u}`);
    if (c.implicitFlowEnabled) add('client rules', `${c.clientId}: implicit flow is on`);
  }

  for (const f of desired.flows) {
    const rows = await kc.flowExecutions(f.alias).catch(() => null);
    if (!rows) { add('flows', `${f.alias} missing`); continue; }
    const a = JSON.stringify(desiredFlowRows(f.executions));
    const b = JSON.stringify(await liveFlowRows(rows, kc));
    if (a !== b) add('flows', `${f.alias}: repo ${a} live ${b}`);
  }

  // Flow bindings: the realm must use these flows (also checked through settings, named here for clarity).
  for (const k of ['browserFlow', 'firstBrokerLoginFlow', 'resetCredentialsFlow', 'directGrantFlow']) {
    if (desired.settings[k] && live[k] !== desired.settings[k]) add('flows', `${k} is ${live[k]}, repo ${desired.settings[k]}`);
  }

  if (desired.clientPolicies) {
    const strip = (x) => JSON.parse(JSON.stringify(x, (k, v) => (k.startsWith('$') ? undefined : v)));
    const lp = (await kc.get('/client-policies/profiles')).profiles || [];
    const lpol = (await kc.get('/client-policies/policies')).policies || [];
    if (JSON.stringify(lp) !== JSON.stringify(strip(desired.clientPolicies.profiles))) add('client policies', `profiles: repo ${JSON.stringify(strip(desired.clientPolicies.profiles))} live ${JSON.stringify(lp)}`);
    if (JSON.stringify(lpol) !== JSON.stringify(strip(desired.clientPolicies.policies))) add('client policies', `policies: repo ${JSON.stringify(strip(desired.clientPolicies.policies))} live ${JSON.stringify(lpol)}`);
  }

  if (args.json) console.log(JSON.stringify({ realm: args.realm, server: kc.server, differences: diffs }, null, 2));
  else if (!diffs.length) console.log(`realm ${args.realm} on ${kc.server} matches realm/config (${args.env})`);
  else {
    console.log(`realm ${args.realm} on ${kc.server}: ${diffs.length} difference(s) from realm/config (${args.env})`);
    for (const d of diffs) console.log(`  [${d.area}] ${d.text}`);
  }
  process.exit(diffs.length ? 2 : 0);
}

main().catch((e) => { console.error(e.message); process.exit(1); });
