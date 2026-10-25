// Council Microsoft Entra SSO, as far as it can be proved without an Entra tenant
// (docs/entra-test-plan.md in ocntechnology/civicos lists what needs a real tenant).
//
// A throwaway organisation `integration-entra` (domain entra-sim.gov.uk, SSO required) is
// connected to a throwaway identity provider `integration-entra-sim` that points at the fake
// council IdP realm council-sim, set up the way scripts/sso/connect-council.mjs sets up a
// council. Nothing here touches Kingston or Tower Hamlets.
//
//   1. connect-council.mjs --provider microsoft pins the council's tenant (never common).
//   2. An existing CivicOS account is linked by email on the first SSO sign-in.
//   3. A guest of the council's tenant at another domain is refused.
//   4. A token whose issuer is not the pinned tenant is refused.
//   5. Ending the person's sessions in Keycloak stops their refresh tokens straight away.
//   6. A person disabled at the council IdP is locked out at the next re-check.
//   7. What Keycloak 26.4 sends as a certificate (private_key_jwt) client assertion, which is why
//      the certificate option was taken out of the council guide.
//
// Run: node --test --test-concurrency=1 tests/integration/  (needs scripts/local-up.sh to have run)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, createPublicKey, createVerify, randomBytes } from 'node:crypto';
import { createServer } from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import {
  admin, simAdmin, start, exchange, refresh, ensureUser, deleteUser, userByEmail, ensureOrg, deleteOrg, setRealmAttributes,
  KC, KC_PUBLIC, SIM_PUBLIC, PASSWORD, Browser,
} from './lib.mjs';

const ORG = 'integration-entra';
const DOMAIN = 'entra-sim.gov.uk';
const ALIAS = 'integration-entra-sim';
const SIM_CLIENT = 'integration-entra-broker';
const SIM_SECRET = randomBytes(18).toString('base64url');
const MEMBER = `member@${DOMAIN}`;
const LEAVER = `leaver@${DOMAIN}`;
const GUEST = 'guest@contractor.example.com';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const REPO = fileURLToPath(new URL('../..', import.meta.url));
const run = promisify(execFile);

const simRealm = `${KC}/realms/council-sim/protocol/openid-connect`;
const simPublic = `${SIM_PUBLIC}/realms/council-sim`;

function idpRepresentation(overrides = {}) {
  return {
    alias: ALIAS,
    displayName: 'Entra simulation',
    providerId: 'oidc',
    enabled: true,
    trustEmail: true,
    storeToken: false,
    hideOnLogin: true,
    firstBrokerLoginFlowAlias: 'civicos-first-broker-login',
    postBrokerLoginFlowAlias: 'civicos-post-broker-login',
    config: {
      syncMode: 'IMPORT',
      loginHint: 'true',
      'kc.org.domain': DOMAIN,
      'kc.org.broker.redirect.mode.email-matches': 'true',
      issuer: simPublic,
      authorizationUrl: `${simPublic}/protocol/openid-connect/auth`,
      tokenUrl: `${simRealm}/token`,
      jwksUrl: `${simRealm}/certs`,
      useJwksUrl: 'true',
      validateSignature: 'true',
      clientId: SIM_CLIENT,
      clientSecret: SIM_SECRET,
      clientAuthMethod: 'client_secret_post',
      defaultScope: 'openid email profile',
      pkceEnabled: 'true',
      pkceMethod: 'S256',
      'civicos.provider': 'oidc',
      ...overrides,
    },
  };
}

async function setIdp(overrides) {
  const live = await admin.get(`/identity-provider/instances/${ALIAS}`);
  await admin.put(`/identity-provider/instances/${ALIAS}`, { ...live, config: { ...idpRepresentation().config, ...overrides } });
}

async function simUser(username, email, { enabled = true } = {}) {
  const existing = (await simAdmin.get(`/users?username=${encodeURIComponent(username)}&exact=true`))[0];
  if (existing) await simAdmin.del(`/users/${existing.id}`);
  await simAdmin.post('/users', {
    username, email, enabled, emailVerified: true, firstName: 'Entra', lastName: username,
    credentials: [{ type: 'password', value: PASSWORD, temporary: false }],
  });
  return (await simAdmin.get(`/users?username=${encodeURIComponent(username)}&exact=true`))[0];
}

async function cleanup() {
  for (const e of [MEMBER, LEAVER, GUEST]) await deleteUser(e);
  if (await admin.get(`/identity-provider/instances/${ALIAS}`, { allow404: true })) await admin.del(`/identity-provider/instances/${ALIAS}`);
  await deleteOrg(ORG);
  const c = (await simAdmin.get(`/clients?clientId=${SIM_CLIENT}`))[0];
  if (c) await simAdmin.del(`/clients/${c.id}`);
  for (const u of ['entra.member', 'entra.leaver', 'entra.guest']) {
    const existing = (await simAdmin.get(`/users?username=${u}&exact=true`))[0];
    if (existing) await simAdmin.del(`/users/${existing.id}`);
  }
}

before(async () => {
  await cleanup();
  await simAdmin.post('/clients', {
    clientId: SIM_CLIENT, enabled: true, protocol: 'openid-connect', publicClient: false, secret: SIM_SECRET,
    standardFlowEnabled: true, directAccessGrantsEnabled: false,
    redirectUris: [...new Set([KC, KC_PUBLIC])].map((h) => `${h}/realms/ocn/broker/${ALIAS}/endpoint`),
  });
  const o = await ensureOrg(ORG, DOMAIN, { signInPolicy: 'sso_required', customer: 'true' });
  await admin.post('/identity-provider/instances', idpRepresentation());
  await admin.req('POST', admin.r(`/organizations/${o.id}/identity-providers`), JSON.stringify(ALIAS));
  await simUser('entra.member', MEMBER);
  await simUser('entra.leaver', LEAVER);
  await simUser('entra.guest', GUEST);
});

after(async () => {
  await setRealmAttributes({ 'civicos.ssoSessionMaxSeconds': '43200' });
  await cleanup();
});

/** Email first at the council's domain (SSO required), then sign in at the fake council IdP. */
async function ssoSignIn(email, simUsername, browser = new Browser()) {
  const { verifier } = await start({}, browser);
  await browser.submit('civicos-email-form', { email });
  assert.match(browser.url, /\/realms\/council-sim\//, `went to the council sign-in, not ${browser.template()} ${browser.text().slice(0, 200)}`);
  const r = await browser.submit('kc-form-login', { username: simUsername, password: PASSWORD });
  return { r, browser, verifier };
}

test('1. connect-council.mjs --provider microsoft pins the council tenant and never uses common', async () => {
  const tenant = 'aaaabbbb-0000-cccc-1111-dddd2222eeee';
  const env = { ...process.env, KC_SERVER: KC, MS_CLIENT_ID: '00001111-aaaa-2222-bbbb-3333cccc4444', MS_CLIENT_SECRET: 'not-a-secret' };
  const script = `${REPO}/scripts/sso/connect-council.mjs`;
  const { stdout } = await run('node', [script, '--org', ORG, '--provider', 'microsoft', '--tenant', tenant, '--dry-run'], { env });
  const rep = JSON.parse(stdout);
  const base = `https://login.microsoftonline.com/${tenant}`;
  assert.equal(rep.alias, `${ORG}-microsoft`);
  assert.equal(rep.config.issuer, `${base}/v2.0`);
  assert.equal(rep.config.authorizationUrl, `${base}/oauth2/v2.0/authorize`);
  assert.equal(rep.config.tokenUrl, `${base}/oauth2/v2.0/token`);
  assert.equal(rep.config.jwksUrl, `${base}/discovery/v2.0/keys`);
  assert.equal(rep.config.validateSignature, 'true');
  assert.equal(rep.config.pkceMethod, 'S256');
  assert.equal(rep.config.clientAuthMethod, 'client_secret_post');
  assert.equal(rep.config.defaultScope, 'openid email profile');
  assert.equal(rep.config.clientSecret, '***', 'the secret is not printed');
  assert.equal(rep.trustEmail, true);
  assert.equal(rep.firstBrokerLoginFlowAlias, 'civicos-first-broker-login');
  assert.equal(rep.postBrokerLoginFlowAlias, 'civicos-post-broker-login');
  assert.doesNotMatch(stdout, /\/(common|organizations|consumers)\//);
  for (const bad of ['common', 'organizations', 'towerhamlets.gov.uk']) {
    await assert.rejects(run('node', [script, '--org', ORG, '--provider', 'microsoft', '--tenant', bad, '--dry-run'], { env }), /GUID/, bad);
  }
});

test('2. an existing account is linked by email on the first SSO sign-in, keeps its id and gets level 2', async () => {
  await ensureUser(MEMBER, { firstName: 'Mem', lastName: 'Ber' });
  const before = await userByEmail(MEMBER);
  const { r, verifier } = await ssoSignIn(MEMBER, 'entra.member');
  assert.ok(r.redirect, 'signed in');
  const t = await exchange(r.redirect, verifier);
  assert.equal(t.id.sub, before.id, 'same account');
  assert.equal(t.id.acr, '2');
  assert.equal(t.access.civicos_method, 'sso');
  assert.deepEqual(t.access.organization, [ORG]);
  const links = await admin.get(`/users/${before.id}/federated-identity`);
  assert.ok(links.some((l) => l.identityProvider === ALIAS), 'linked to the council IdP');
});

test("3. a guest in the council's tenant with another domain is refused and gets no account", async () => {
  const { r, browser } = await ssoSignIn(MEMBER, 'entra.guest');
  assert.equal(r.redirect, undefined);
  assert.match(browser.text(), /not at one of your organisation's email domains/);
  assert.equal(await userByEmail(GUEST), null);
});

test('4. a token whose issuer is not the pinned tenant is refused', async () => {
  await setIdp({ issuer: 'https://login.microsoftonline.com/11112222-bbbb-3333-cccc-4444dddd5555/v2.0' });
  try {
    await deleteUser(LEAVER);
    const started = Date.now() - 1000;
    const { r, browser } = await ssoSignIn(LEAVER, 'entra.leaver');
    assert.equal(r.redirect, undefined, 'no sign-in');
    assert.match(browser.text(), /Unexpected error when authenticating with identity provider/);
    const events = await admin.get(`/events?type=IDENTITY_PROVIDER_LOGIN_ERROR&max=5`);
    assert.ok(events.some((e) => e.time >= started && e.error === 'identity_provider_login_failure'), 'stored as an identity provider login error');
    assert.equal(await userByEmail(LEAVER), null, 'no account created');
  } finally {
    await setIdp({});
  }
});

test('5. ending the sessions in Keycloak stops refresh straight away and the next visit must sign in again', async () => {
  const browser = new Browser();
  const { r, verifier } = await ssoSignIn(MEMBER, 'entra.member', browser);
  const t = await exchange(r.redirect, verifier);
  assert.equal((await refresh(t.refresh_token)).status, 200);
  const u = await userByEmail(MEMBER);
  assert.ok((await admin.get(`/users/${u.id}/sessions`)).length >= 1);
  await admin.post(`/users/${u.id}/logout`); // Admin console: Users > the person > Sessions > Sign out
  assert.equal((await admin.get(`/users/${u.id}/sessions`)).length, 0);
  const after = await refresh(t.refresh_token);
  assert.equal(after.status, 400);
  assert.equal(after.json.error, 'invalid_grant');
  // The CivicOS session cookie no longer works: a silent sign-in is refused.
  const silent = await start({ prompt: 'none' }, browser);
  assert.match(silent.first.redirect || '', /error=login_required/);
});

test('6. a person disabled at the council IdP is refused at the next re-check', async () => {
  const browser = new Browser();
  const { r, verifier } = await ssoSignIn(LEAVER, 'entra.leaver', browser);
  assert.ok(r.redirect, browser.text().slice(0, 200));
  const t = await exchange(r.redirect, verifier);
  const sim = (await simAdmin.get('/users?username=entra.leaver&exact=true'))[0];
  await simAdmin.put(`/users/${sim.id}`, { ...sim, enabled: false }); // Entra: account disabled, or removed from the assigned group
  try {
    // Until the re-check, the CivicOS session still refreshes: this is the window the guide describes.
    assert.equal((await refresh(t.refresh_token)).status, 200);
    await setRealmAttributes({ 'civicos.ssoSessionMaxSeconds': '3' });
    await sleep(4000);
    assert.equal((await refresh(t.refresh_token)).status, 400, 'refresh refused once the SSO session is past the limit');
    // The product sends the person back to sign in; CivicOS goes back to the council IdP, which refuses them.
    const again = await start({}, browser);
    assert.equal(again.first.redirect, undefined, 'not signed in silently');
    if (browser.template() === 'civicos-email.ftl') await browser.submit('civicos-email-form', { email: LEAVER });
    assert.match(browser.url, /\/realms\/council-sim\//, 'sent back to the council sign-in');
    const last = await browser.submit('kc-form-login', { username: 'entra.leaver', password: PASSWORD }).catch(() => ({}));
    assert.equal(last.redirect, undefined, 'the council IdP does not let a disabled person through');
    assert.match(browser.text(), /Account is disabled/i);
  } finally {
    await setRealmAttributes({ 'civicos.ssoSessionMaxSeconds': '43200' });
    await simAdmin.put(`/users/${sim.id}`, { ...sim, enabled: true });
  }
});

test('7. a certificate client assertion from Keycloak 26.4 carries x5t (SHA-1) and RS256, not the x5t#S256 and PS256 Entra documents', async () => {
  let captured = null;
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      captured = new URLSearchParams(body);
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid_client', error_description: 'test endpoint' }));
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const tokenUrl = `http://127.0.0.1:${server.address().port}/tenant/oauth2/v2.0/token`;
  await setIdp({ tokenUrl, clientAuthMethod: 'private_key_jwt', jwtX509HeadersEnabled: 'true', clientSecret: '' });
  try {
    await ssoSignIn(MEMBER, 'entra.member');
    assert.ok(captured, 'Keycloak called the token endpoint');
    assert.equal(captured.get('client_assertion_type'), 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer');
    const [h, p, s] = captured.get('client_assertion').split('.');
    const header = JSON.parse(Buffer.from(h, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url'));
    // The realm's active RS256 key and its self-signed certificate: the certificate LBTH would upload.
    const certs = await (await fetch(`${KC}/realms/ocn/protocol/openid-connect/certs`)).json();
    const key = certs.keys.find((k) => k.kid === header.kid) || certs.keys.find((k) => k.alg === 'RS256' && k.use === 'sig');
    const der = Buffer.from(key.x5c[0], 'base64');
    assert.equal(header.alg, 'RS256');
    assert.equal(header.typ, 'JWT');
    assert.equal(header.x5t, createHash('sha1').update(der).digest('base64url'), 'x5t is the SHA-1 thumbprint of the realm certificate');
    assert.equal(header['x5t#S256'], undefined, 'no SHA-256 thumbprint header');
    assert.equal(claims.iss, SIM_CLIENT);
    assert.equal(claims.sub, SIM_CLIENT);
    assert.equal(Array.isArray(claims.aud) ? claims.aud[0] : claims.aud, tokenUrl);
    assert.ok(claims.jti && claims.exp);
    const publicKey = createPublicKey(`-----BEGIN CERTIFICATE-----\n${key.x5c[0]}\n-----END CERTIFICATE-----`);
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(s, 'base64url'));
    assert.ok(ok, 'signed with the realm key');
  } finally {
    server.close();
    await setIdp({});
  }
});
