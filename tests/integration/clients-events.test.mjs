// ID-4: no password grants in realm ocn (admin-cli off, direct grant flow always fails).
// ID-7: the directory is an erasure target. ID-8: sign-in and admin events are stored.
// Run: node --test --test-concurrency=1 tests/integration/  (needs scripts/local-up.sh to have run)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { admin, signIn, userByEmail, KC, PASSWORD } from './lib.mjs';

const TH = 'matthew.mannion@towerhamlets.gov.uk';
const PROBE = 'integration-direct-grant-probe';

before(async () => {
  const c = await admin.client(PROBE);
  if (c) await admin.del(`/clients/${c.id}`);
});

after(async () => {
  const c = await admin.client(PROBE);
  if (c) await admin.del(`/clients/${c.id}`);
});

const passwordGrant = (clientId) => fetch(`${KC}/realms/ocn/protocol/openid-connect/token`, {
  method: 'POST', body: new URLSearchParams({ grant_type: 'password', client_id: clientId, username: TH, password: PASSWORD }),
});

test('admin-cli in realm ocn does not accept password grants', async () => {
  const res = await passwordGrant('admin-cli');
  const json = await res.json();
  assert.notEqual(res.status, 200, `got tokens: ${Object.keys(json)}`);
  assert.equal(json.access_token, undefined);
});

test('even a client with direct access grants switched on gets no tokens: the direct grant flow always fails', async () => {
  await admin.post('/clients', { clientId: PROBE, enabled: true, protocol: 'openid-connect', publicClient: true, standardFlowEnabled: false, directAccessGrantsEnabled: true });
  const res = await passwordGrant(PROBE);
  const json = await res.json();
  assert.notEqual(res.status, 200, `got tokens: ${Object.keys(json)}`);
  assert.equal(json.access_token, undefined);
  assert.equal(json.error, 'unauthorized_client');
  const realm = await admin.get('');
  assert.equal(realm.directGrantFlow, 'civicos-direct-grant-refused');
});

test('the directory is told about erasures (client civicos-directory, no browser or password sign-in)', async () => {
  const c = await admin.client('civicos-directory');
  assert.ok(c, 'client exists');
  assert.equal(c.publicClient, false);
  assert.equal(c.standardFlowEnabled, false);
  assert.equal(c.directAccessGrantsEnabled, false);
  assert.equal(c.implicitFlowEnabled, false);
  assert.match(c.attributes['civicos.erasure.url'], /^http:\/\/127\.0\.0\.1:3100\/api\/auth\/civicos\/erase$/);
});

test('a sign-in is stored as a LOGIN event with the CivicOS method, and admin events are stored', async () => {
  const realm = await admin.get('');
  assert.equal(realm.eventsEnabled, true);
  assert.ok(Number(realm.eventsExpiration) >= 390 * 86400, 'kept for about 400 days');
  for (const t of ['LOGIN', 'LOGIN_ERROR', 'RESET_PASSWORD', 'UPDATE_EMAIL', 'UPDATE_TOTP', 'REMOVE_TOTP', 'CODE_TO_TOKEN', 'REFRESH_TOKEN_ERROR']) {
    assert.ok(realm.enabledEventTypes.includes(t), `${t} is stored`);
  }
  const since = Date.now() - 1000;
  await signIn(TH);
  const u = await userByEmail(TH);
  const events = await admin.get(`/events?user=${u.id}&type=LOGIN&max=5`);
  const mine = events.filter((e) => e.time >= since);
  assert.ok(mine.length >= 1, 'a stored LOGIN event');
  assert.equal(mine[0].details.civicos_method, 'password');
  assert.equal(mine[0].details.civicos_staff, undefined);
  const adminEvents = await admin.get('/admin-events?max=5');
  assert.ok(adminEvents.length >= 1, 'admin events are stored');
});
