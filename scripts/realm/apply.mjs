#!/usr/bin/env node
// Apply the realm configuration in realm/config/ to a running Keycloak through the admin API.
//
//   node scripts/realm/apply.mjs [--env local|production] [--realm ocn] [--secrets-out file]
//                                [--organisations file.json] [--dry-run]
//
// Admin credentials: KC_SERVER (default http://localhost:8180), KC_ADMIN / KC_ADMIN_PASSWORD
// (master realm), or KC_ADMIN_CLIENT_ID / KC_ADMIN_CLIENT_SECRET (a service account in the realm).
// Idempotent: run it as often as you like. Prints what it changed.

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  Admin, CONFIG, parseArgs, loadDesired, readJson, desiredFlowRows, liveFlowRows, flowProviders,
} from './lib.mjs';

const args = parseArgs(process.argv.slice(2));
const desired = loadDesired(args.env);
const kc = Admin.fromEnv(args.realm);
const dry = Boolean(args['dry-run']);
const log = (...m) => console.log(dry ? '[dry-run]' : '', ...m);

async function applyScopes() {
  for (const scope of desired.scopes) {
    let live = await kc.scopeByName(scope.name);
    const { protocolMappers = [], ...rep } = scope;
    if (!live) {
      log(`create client scope ${scope.name}`);
      if (dry) continue;
      await kc.post('/client-scopes', rep);
      live = await kc.scopeByName(scope.name);
    } else if (!dry) {
      await kc.put(`/client-scopes/${live.id}`, { ...live, ...rep, protocolMappers: undefined });
    }
    const liveMappers = live.protocolMappers || [];
    for (const m of protocolMappers) {
      const existing = liveMappers.find((x) => x.name === m.name);
      if (!existing) {
        log(`  add mapper ${m.name} to ${scope.name}`);
        if (!dry) await kc.post(`/client-scopes/${live.id}/protocol-mappers/models`, m);
      } else if (JSON.stringify(existing.config) !== JSON.stringify({ ...existing.config, ...m.config }) || existing.protocolMapper !== m.protocolMapper) {
        log(`  update mapper ${m.name} on ${scope.name}`);
        if (!dry) await kc.put(`/client-scopes/${live.id}/protocol-mappers/models/${existing.id}`, { ...existing, ...m, config: { ...existing.config, ...m.config } });
      }
    }
  }
}

async function applyClients() {
  const secrets = {};
  const scopes = await kc.get('/client-scopes');
  const scopeId = (name) => scopes.find((s) => s.name === name)?.id;
  for (const c of desired.clients) {
    const { defaultClientScopes, optionalClientScopes, serviceAccountRealmRoles, serviceAccountClientRoles, ...rep } = c;
    let live = await kc.client(c.clientId);
    if (!live) {
      log(`create client ${c.clientId}`);
      if (dry) continue;
      await kc.post('/clients', rep);
      live = await kc.client(c.clientId);
    } else {
      log(`update client ${c.clientId}`);
      if (!dry) await kc.put(`/clients/${live.id}`, { ...live, ...rep, attributes: { ...live.attributes, ...rep.attributes } });
    }
    if (dry) continue;
    // Scopes: make the default and optional lists match exactly.
    for (const [kind, want] of [['default', defaultClientScopes], ['optional', optionalClientScopes]]) {
      if (!want) continue;
      const current = await kc.get(`/clients/${live.id}/${kind}-client-scopes`);
      for (const name of want) {
        if (!current.some((s) => s.name === name)) {
          const id = scopeId(name);
          if (!id) { console.warn(`  warning: client scope ${name} does not exist`); continue; }
          // A scope can only be default or optional, so remove it from the other list first.
          const other = kind === 'default' ? 'optional' : 'default';
          await kc.del(`/clients/${live.id}/${other}-client-scopes/${id}`, { allow404: true });
          await kc.put(`/clients/${live.id}/${kind}-client-scopes/${id}`);
          log(`  ${kind} scope ${name} on ${c.clientId}`);
        }
      }
      for (const s of current) {
        if (!want.includes(s.name)) {
          await kc.del(`/clients/${live.id}/${kind}-client-scopes/${s.id}`);
          log(`  removed ${kind} scope ${s.name} from ${c.clientId}`);
        }
      }
    }
    if (serviceAccountClientRoles) {
      const sa = await kc.get(`/clients/${live.id}/service-account-user`);
      for (const [clientId, roleNames] of Object.entries(serviceAccountClientRoles)) {
        const target = await kc.client(clientId);
        const roles = [];
        for (const n of roleNames) roles.push(await kc.get(`/clients/${target.id}/roles/${encodeURIComponent(n)}`));
        await kc.post(`/users/${sa.id}/role-mappings/clients/${target.id}`, roles);
      }
    }
    if (!rep.publicClient) {
      const s = await kc.get(`/clients/${live.id}/client-secret`);
      secrets[c.clientId] = s.value;
    }
  }
  return secrets;
}

async function buildFlowInto(alias, executions) {
  for (const e of executions) {
    if (e.subflow) {
      await kc.post(`/authentication/flows/${encodeURIComponent(alias)}/executions/flow`, {
        alias: e.subflow, type: 'basic-flow', provider: 'registration-page-form', description: e.description || '',
      });
      await setRequirement(alias, `flow:${e.subflow}`, e.requirement);
      await buildFlowInto(e.subflow, e.executions || []);
    } else {
      await kc.post(`/authentication/flows/${encodeURIComponent(alias)}/executions/execution`, { provider: e.authenticator });
      await setRequirement(alias, e.authenticator, e.requirement);
    }
  }
}

async function setRequirement(alias, key, requirement) {
  const rows = await kc.flowExecutions(alias);
  // The execution just added is the last direct child matching the key.
  const direct = rows.filter((r) => r.level === 0 && (r.authenticationFlow ? `flow:${r.displayName}` : r.providerId) === key);
  const row = direct[direct.length - 1];
  if (row.requirement !== requirement) await kc.put(`/authentication/flows/${encodeURIComponent(alias)}/executions`, { ...row, requirement });
}

async function applyFlows() {
  const available = await kc.authenticatorProviders();
  const applied = new Set();
  const flows = await kc.get('/authentication/flows');
  for (const f of desired.flows) {
    const missing = [...flowProviders(f.executions)].filter((p) => !available.has(p));
    if (missing.length) {
      console.warn(`skip flow ${f.alias}: authenticators not installed: ${missing.join(', ')} (build the extension first)`);
      continue;
    }
    applied.add(f.alias);
    const live = flows.find((x) => x.alias === f.alias);
    if (live) {
      const same = JSON.stringify(liveFlowRows(await kc.flowExecutions(f.alias))) === JSON.stringify(desiredFlowRows(f.executions));
      if (same) continue;
    }
    log(`${live ? 'rebuild' : 'create'} flow ${f.alias}`);
    if (dry) continue;
    // Build under a temporary alias, then swap: delete the old one (after moving any binding to
    // the new one by id) and rename the new one. Bindings are stored by id, so they follow.
    const tmp = `${f.alias}.next`;
    const stale = flows.find((x) => x.alias === tmp);
    if (stale) await kc.del(`/authentication/flows/${stale.id}`);
    await kc.post('/authentication/flows', { alias: tmp, description: f.description, providerId: 'basic-flow', topLevel: true, builtIn: false });
    // Subflow aliases must be unique realm-wide, so suffix them while building.
    const suffixed = suffixSubflows(f.executions, '.next');
    await buildFlowInto(tmp, suffixed);
    const fresh = (await kc.get('/authentication/flows')).find((x) => x.alias === tmp);
    if (live) {
      await rebind(live.alias, tmp);
      await kc.del(`/authentication/flows/${live.id}`);
    }
    await kc.put(`/authentication/flows/${fresh.id}`, { ...fresh, alias: f.alias });
    await renameSubflows(f.alias, '.next');
  }
  return applied;
}

function suffixSubflows(executions, suffix) {
  return executions.map((e) => (e.subflow ? { ...e, subflow: e.subflow + suffix, executions: suffixSubflows(e.executions || [], suffix) } : e));
}

async function renameSubflows(alias, suffix) {
  const rows = await kc.flowExecutions(alias);
  const all = await kc.get('/authentication/flows');
  for (const r of rows) {
    if (!r.authenticationFlow || !r.displayName.endsWith(suffix)) continue;
    // Subflows are not listed at top level; update through the execution's flowId.
    const target = r.flowId;
    const rep = await kc.get(`/authentication/flows/${target}`);
    await kc.put(`/authentication/flows/${target}`, { ...rep, alias: r.displayName.slice(0, -suffix.length) });
  }
  void all;
}

const BINDINGS = ['browserFlow', 'firstBrokerLoginFlow', 'registrationFlow', 'directGrantFlow', 'resetCredentialsFlow', 'clientAuthenticationFlow', 'dockerAuthenticationFlow'];

async function rebind(fromAlias, toAlias) {
  const realm = await kc.get('');
  let changed = false;
  for (const b of BINDINGS) if (realm[b] === fromAlias) { realm[b] = toAlias; changed = true; }
  if (changed) await kc.put('', realm);
  const idps = (await kc.get('/identity-provider/instances')) || [];
  for (const idp of idps) {
    let c = false;
    if (idp.firstBrokerLoginFlowAlias === fromAlias) { idp.firstBrokerLoginFlowAlias = toAlias; c = true; }
    if (idp.postBrokerLoginFlowAlias === fromAlias) { idp.postBrokerLoginFlowAlias = toAlias; c = true; }
    if (c) await kc.put(`/identity-provider/instances/${encodeURIComponent(idp.alias)}`, idp);
  }
}

async function applySettings(appliedFlows) {
  const live = await kc.get('');
  const want = structuredClone(desired.settings);
  const profileAttrs = want.userProfileAttributes || [];
  delete want.userProfileAttributes;
  for (const [key, flow] of [['browserFlow', 'civicos-browser'], ['firstBrokerLoginFlow', 'civicos-first-broker-login']]) {
    if (want[key] === flow && !appliedFlows.has(flow)) {
      const fallback = key === 'browserFlow' ? 'browser' : 'first broker login';
      console.warn(`${key}: ${flow} not available, keeping ${live[key] || fallback}`);
      want[key] = live[key] || fallback;
    }
  }
  if (want.attributes && want.attributes.frontendUrl === '') want.attributes.frontendUrl = '';
  log('update realm settings');
  if (!dry) await kc.put('', { ...live, ...want, attributes: { ...live.attributes, ...want.attributes } });
  if (profileAttrs.length) await applyUserProfile(profileAttrs);
}

// CivicOS attributes are admin-only: a person must never be able to set their own
// mailbox-verified time from the account console.
async function applyUserProfile(attrs) {
  const profile = await kc.get('/users/profile');
  let changed = false;
  for (const a of attrs) {
    const i = profile.attributes.findIndex((x) => x.name === a.name);
    if (i === -1) { profile.attributes.push(a); changed = true; }
    else if (JSON.stringify(profile.attributes[i].permissions) !== JSON.stringify(a.permissions)) { profile.attributes[i] = { ...profile.attributes[i], ...a }; changed = true; }
  }
  if (profile.unmanagedAttributePolicy !== 'ADMIN_EDIT') { profile.unmanagedAttributePolicy = 'ADMIN_EDIT'; changed = true; }
  if (changed) { log('update user profile attributes'); if (!dry) await kc.put('/users/profile', profile); }
}

/** Organisations: [{ alias, name, domains: [..], attributes: { kind: [..], ... }, sharedDomains: [..] }]. */
export async function applyOrganisations(file) {
  const orgs = readJson(file);
  for (const o of orgs) {
    const found = (await kc.get('/organizations?first=0&max=10000&briefRepresentation=false')) || [];
    const live = found.find((x) => x.alias === o.alias);
    const rep = {
      name: o.name,
      alias: o.alias,
      enabled: true,
      domains: o.domains.map((d) => ({ name: d, verified: true })),
      attributes: o.attributes || {},
    };
    if (!live) {
      log(`create organisation ${o.alias}`);
      if (!dry) await kc.post('/organizations', rep);
    } else {
      log(`update organisation ${o.alias}`);
      if (!dry) await kc.put(`/organizations/${live.id}`, { ...live, ...rep });
    }
  }
}

/** Realm roles from realm/config/roles.json (create, describe, composites; never removes). */
async function applyRoles() {
  const file = join(CONFIG, 'roles.json');
  if (!existsSync(file)) return;
  const { roles } = readJson(file);
  for (const r of roles) {
    let live = await kc.get(`/roles/${encodeURIComponent(r.name)}`, { allow404: true });
    if (!live) {
      log(`create realm role ${r.name}`);
      if (dry) continue;
      await kc.post('/roles', { name: r.name, description: r.description });
      live = await kc.get(`/roles/${encodeURIComponent(r.name)}`);
    } else if (live.description !== r.description) {
      log(`update realm role ${r.name}`);
      if (!dry) await kc.put(`/roles/${encodeURIComponent(r.name)}`, { ...live, description: r.description });
    }
    if (r.composites?.length && !dry) {
      const have = (await kc.get(`/roles/${encodeURIComponent(r.name)}/composites`)) || [];
      const add = [];
      for (const c of r.composites) if (!have.some((h) => h.name === c)) add.push(await kc.get(`/roles/${encodeURIComponent(c)}`));
      if (add.length) { log(`  ${r.name} includes ${add.map((x) => x.name).join(', ')}`); await kc.post(`/roles/${encodeURIComponent(r.name)}/composites`, add); }
    }
  }
}

async function main() {
  const realm = await kc.get('', { allow404: true });
  if (!realm) throw new Error(`realm ${args.realm} does not exist on ${kc.server}`);
  // Organisations must be on before the organization scope mapper is useful.
  if (!realm.organizationsEnabled && !dry) await kc.put('', { ...realm, organizationsEnabled: true });
  await applyScopes();
  await applyRoles();
  const secrets = await applyClients();
  const flows = await applyFlows();
  await applySettings(flows);
  if (args.organisations) await applyOrganisations(args.organisations);
  if (args['secrets-out'] && !dry) {
    const lines = Object.entries(secrets).map(([id, s]) => `${id.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_SECRET=${s}`);
    writeFileSync(args['secrets-out'], `# Local client secrets written by scripts/realm/apply.mjs. Do not commit.\n${lines.join('\n')}\n`);
    log(`wrote ${Object.keys(secrets).length} client secrets to ${args['secrets-out']}`);
  }
  log('done');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
