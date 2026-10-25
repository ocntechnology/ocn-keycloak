#!/usr/bin/env node
// Local-only seed: organisations, test users, and the fake council IdP (realm council-sim)
// linked to Kingston's organisation. Idempotent. Never run against production.
//
//   node scripts/local/seed.mjs [--skip-organisations] [--reset-passwords]

import { Admin, CONFIG, parseArgs, readJson } from '../realm/lib.mjs';
import { join } from 'node:path';

const args = parseArgs(process.argv.slice(2));
const server = process.env.KC_SERVER || 'http://localhost:8180';
if (!/localhost|127\.0\.0\.1/.test(server)) {
  console.error(`refusing to seed ${server}: local only`);
  process.exit(1);
}
const seed = readJson(join(CONFIG, 'env', 'local-seed.json'));
const kc = Admin.fromEnv('ocn');
const sim = Admin.fromEnv(seed.councilSim.realm);

async function orgByAlias(alias) {
  const list = (await kc.get('/organizations?first=0&max=10000&briefRepresentation=false')) || [];
  return list.find((o) => o.alias === alias) || null;
}

async function seedOrganisations() {
  for (const o of seed.organisations) {
    const rep = { name: o.name, alias: o.alias, enabled: true, domains: o.domains.map((d) => ({ name: d, verified: true })), attributes: o.attributes };
    const live = await orgByAlias(o.alias);
    if (!live) { await kc.post('/organizations', rep); console.log(`organisation ${o.alias} created`); }
  }
}

async function ensureUser(admin, { username, email, firstName, lastName }, password, attributes = {}) {
  const found = await admin.get(`/users?email=${encodeURIComponent(email)}&exact=true`);
  let user = found[0];
  const rep = { username: username || email, email, firstName, lastName, enabled: true, emailVerified: true, attributes };
  if (!user) {
    await admin.post('/users', rep);
    user = (await admin.get(`/users?email=${encodeURIComponent(email)}&exact=true`))[0];
    await admin.put(`/users/${user.id}/reset-password`, { type: 'password', value: password, temporary: false });
    console.log(`user ${email} created in ${admin.realm}`);
  } else if (args['reset-passwords']) {
    await admin.put(`/users/${user.id}/reset-password`, { type: 'password', value: password, temporary: false });
  }
  return user;
}

async function seedUsers() {
  const now = new Date().toISOString();
  for (const u of seed.users) {
    const user = await ensureUser(kc, u, seed.password, { civicosMailboxVerifiedAt: [now] });
    for (const role of u.realmRoles || []) {
      const r = await kc.get(`/roles/${encodeURIComponent(role)}`, { allow404: true });
      if (r) await kc.post(`/users/${user.id}/role-mappings/realm`, [r]);
    }
    if (u.org) {
      const org = await orgByAlias(u.org);
      if (org) {
        const members = (await kc.get(`/organizations/${org.id}/members?search=${encodeURIComponent(u.email)}`)) || [];
        if (!members.some((m) => m.id === user.id)) await kc.req('POST', kc.r(`/organizations/${org.id}/members`), JSON.stringify(user.id));
      }
    }
  }
}

async function seedCouncilSim() {
  const cfg = seed.councilSim;
  const exists = await kc.req('GET', `/${cfg.realm}`, undefined, { allow404: true });
  if (!exists) {
    await kc.req('POST', '', { realm: cfg.realm, enabled: true, displayName: cfg.displayName, loginTheme: 'keycloak.v2', sslRequired: 'none' });
    console.log(`realm ${cfg.realm} created`);
  }
  let client = await sim.client(cfg.clientId);
  const clientRep = {
    clientId: cfg.clientId,
    name: 'OCN CivicOS (broker)',
    protocol: 'openid-connect',
    publicClient: false,
    standardFlowEnabled: true,
    directAccessGrantsEnabled: false,
    redirectUris: [`${server}/realms/ocn/broker/${cfg.idpAlias}/endpoint`],
    attributes: { 'pkce.code.challenge.method': 'S256' },
  };
  if (!client) { await sim.post('/clients', clientRep); client = await sim.client(cfg.clientId); }
  else await sim.put(`/clients/${client.id}`, { ...client, ...clientRep });
  const secret = (await sim.get(`/clients/${client.id}/client-secret`)).value;
  for (const u of cfg.users) await ensureUser(sim, u, seed.password);

  // The IdP in realm ocn that points at council-sim, tied to Kingston's organisation.
  const flows = await kc.get('/authentication/flows');
  const has = (a) => flows.some((f) => f.alias === a);
  const base = `${server}/realms/${cfg.realm}/protocol/openid-connect`;
  const idp = {
    alias: cfg.idpAlias,
    displayName: cfg.idpDisplayName,
    providerId: 'oidc',
    enabled: true,
    trustEmail: true,
    storeToken: false,
    hideOnLogin: true,
    firstBrokerLoginFlowAlias: has('civicos-first-broker-login') ? 'civicos-first-broker-login' : 'first broker login',
    postBrokerLoginFlowAlias: has('civicos-post-broker-login') ? 'civicos-post-broker-login' : '',
    config: {
      issuer: `${server}/realms/${cfg.realm}`,
      authorizationUrl: `${base}/auth`,
      tokenUrl: `${base}/token`,
      userInfoUrl: `${base}/userinfo`,
      jwksUrl: `${base}/certs`,
      logoutUrl: `${base}/logout`,
      useJwksUrl: 'true',
      validateSignature: 'true',
      clientId: cfg.clientId,
      clientSecret: secret,
      clientAuthMethod: 'client_secret_post',
      defaultScope: 'openid email profile',
      pkceEnabled: 'true',
      pkceMethod: 'S256',
      syncMode: 'IMPORT',
      loginHint: 'true',
      'civicos.provider': 'council-sim',
      'kc.org.domain': 'kingston.gov.uk',
      'kc.org.broker.redirect.mode.email-matches': 'true',
    },
  };
  const live = await kc.get(`/identity-provider/instances/${cfg.idpAlias}`, { allow404: true });
  if (!live) { await kc.post('/identity-provider/instances', idp); console.log(`identity provider ${cfg.idpAlias} created`); }
  else await kc.put(`/identity-provider/instances/${cfg.idpAlias}`, { ...live, ...idp, config: { ...live.config, ...idp.config } });
  const org = await orgByAlias(cfg.org);
  if (org) {
    const linked = (await kc.get(`/organizations/${org.id}/identity-providers`)) || [];
    if (!linked.some((x) => x.alias === cfg.idpAlias)) {
      await kc.req('POST', kc.r(`/organizations/${org.id}/identity-providers`), JSON.stringify(cfg.idpAlias));
      console.log(`identity provider ${cfg.idpAlias} linked to ${cfg.org}`);
    }
  }
}

async function main() {
  if (!args['skip-organisations']) await seedOrganisations();
  await seedUsers();
  await seedCouncilSim();
  console.log('seed done');
}

main().catch((e) => { console.error(e.message); process.exit(1); });
