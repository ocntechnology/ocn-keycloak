// Integration tests: OCN staff always use a second step, and account erasure reaches products.
// Run: node --test --test-concurrency=1 tests/integration/  (needs scripts/local-up.sh to have run)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createPublicKey, verify } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { start, exchange, ensureUser, deleteUser, userByEmail, admin, totp, PASSWORD, KC, KC_PUBLIC } from './lib.mjs';
import { CONFIG, readJson } from '../../scripts/realm/lib.mjs';

const SEED = readJson(join(CONFIG, 'env', 'local-seed.json'));
const TOBY = 'toby.abel@ocn.technology';
const STAFF_TEMP = 'integration.staff@ocn.technology';
const ERASE = 'integration.erase@hackney.gov.uk';
const CLIENT = 'integration-erasure-probe';

let server;
let port;
const received = [];

before(async () => {
  await deleteUser(STAFF_TEMP);
  await deleteUser(ERASE);
  // A stand-in product that records the erasure notices it is sent.
  server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      received.push({ path: req.url, token: new URLSearchParams(body).get('erasure_token') });
      res.writeHead(200, { 'content-type': 'application/json' }).end('{"erased":true}');
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  port = server.address().port;
  const existing = await admin.client(CLIENT);
  if (existing) await admin.del(`/clients/${existing.id}`);
  await admin.post('/clients', {
    clientId: CLIENT, enabled: true, protocol: 'openid-connect', publicClient: false, standardFlowEnabled: false,
    directAccessGrantsEnabled: false, attributes: { 'civicos.erasure.url': `http://127.0.0.1:${port}/api/auth/civicos/erase` },
  });
});

after(async () => {
  const c = await admin.client(CLIENT);
  if (c) await admin.del(`/clients/${c.id}`);
  await deleteUser(STAFF_TEMP);
  await deleteUser(ERASE);
  server?.close();
});

test('OCN staff: a password sign-in always asks for the authenticator code, and gives level 2', async () => {
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: TOBY });
  await browser.submit('civicos-password-form', { password: PASSWORD });
  assert.equal(browser.template(), 'civicos-otp.ftl', `got ${browser.template()} ${browser.text().slice(0, 200)}`);
  // Keycloak refuses a code already used in its window; other suites sign Toby in too (shared file).
  const file = join(tmpdir(), 'civicos-staff-totp-last');
  let code;
  for (;;) {
    const left = 30_000 - (Date.now() % 30_000);
    code = totp(SEED.staffTotp.secret);
    let last = '';
    try { last = readFileSync(file, 'utf8').trim(); } catch { /* first use */ }
    if (left > 4_000 && last !== code) break;
    await new Promise((r) => setTimeout(r, left + 250));
  }
  writeFileSync(file, code);
  const r = await browser.submit('civicos-otp-form', { otp: code });
  assert.ok(r.redirect, browser.text().slice(0, 300));
  const t = await exchange(r.redirect, verifier);
  assert.equal(t.id.acr, '2');
  assert.ok(t.access.realm_access.roles.includes('ocn-staff'), 'ocn-admin includes ocn-staff');
});

test('OCN staff without an authenticator app must set one up, even after an email code', async () => {
  const u = await ensureUser(STAFF_TEMP);
  const role = await admin.get('/roles/ocn-staff');
  await admin.post(`/users/${u.id}/role-mappings/realm`, [role]);
  const { browser } = await start();
  await browser.submit('civicos-email-form', { email: STAFF_TEMP });
  await browser.submit('civicos-password-form', { password: PASSWORD });
  assert.match(browser.html, /id="kc-totp-settings-form"/, `got ${browser.template()} ${browser.text().slice(0, 200)}`);
});

test('the realm roles: ocn-admin includes ocn-staff', async () => {
  const composites = await admin.get('/roles/ocn-admin/composites');
  assert.ok(composites.some((r) => r.name === 'ocn-staff'));
});

test('account erasure: deleting an account sends every registered product a signed erasure_token', async () => {
  const u = await ensureUser(ERASE);
  received.length = 0;
  await admin.del(`/users/${u.id}`);
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(received.length, 1, 'the stand-in product was told once');
  assert.equal(received[0].path, '/api/auth/civicos/erase');
  const [h, p, s] = received[0].token.split('.');
  const header = JSON.parse(Buffer.from(h, 'base64url').toString());
  const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
  assert.equal(header.alg, 'RS256');
  assert.equal(claims.sub, u.id);
  assert.equal(claims.aud, CLIENT);
  assert.equal(claims.iss, `${KC_PUBLIC}/realms/ocn`);
  assert.ok(claims.events['https://ocn.technology/events/account-erased']);
  // Signed with a key the realm publishes.
  const jwks = await (await fetch(`${KC}/realms/ocn/protocol/openid-connect/certs`)).json();
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  assert.ok(jwk, 'the signing key is in the realm JWKS');
  assert.ok(verify('RSA-SHA256', Buffer.from(`${h}.${p}`), createPublicKey({ key: jwk, format: 'jwk' }), Buffer.from(s, 'base64url')));

  // Resend: refused while an account exists, sent again for a deleted one.
  const syncSecret = readFileSync(`${process.env.HOME}/Repositories/ocn-keycloak/local/clients.env`, 'utf8').split('\n').find((l) => l.startsWith('CIVICOS_REGISTRY_SYNC_CLIENT_SECRET=')).split('=')[1].trim();
  const tok = await (await fetch(`${KC}/realms/ocn/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'civicos-registry-sync', client_secret: syncSecret }) })).json();
  const resend = (sub) => fetch(`${KC}/realms/ocn/civicos-erasure/resend`, { method: 'POST', headers: { authorization: `Bearer ${tok.access_token}`, 'content-type': 'application/json' }, body: JSON.stringify({ sub, clientId: CLIENT }) });
  const still = await userByEmail(TOBY);
  assert.equal((await resend(still.id)).status, 409);
  received.length = 0;
  const again = await resend(u.id);
  assert.equal(again.status, 202);
  for (let i = 0; i < 50 && !received.length; i++) await new Promise((r) => setTimeout(r, 200));
  assert.equal(received.length, 1);
  assert.equal((await fetch(`${KC}/realms/ocn/civicos-erasure/resend`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 401);
});

test('new accounts get a random id, never the email address', async () => {
  const u = await ensureUser(ERASE);
  assert.match(u.id, /^[0-9a-f-]{36}$/);
});
