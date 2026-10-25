// ID-5: Keycloak refuses a token refresh when the session no longer meets the sign-in rules, so
// every product (they refresh every 5 minutes) signs the person out within minutes:
//   (a) council SSO session older than 12 hours (realm attribute civicos.ssoSessionMaxSeconds);
//   (b) the organisation now requires SSO and the session was not made by SSO;
//   (c) a password or code session whose last mailbox check is older than 30 days
//       (realm attribute civicos.mailboxMaxAgeSeconds).
// The limits are shortened for the test and put back afterwards.
// Run: node --test --test-concurrency=1 tests/integration/  (needs scripts/local-up.sh to have run)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, exchange, signIn, refresh, setRealmAttributes, setOrgAttributes, setUserAttribute, PASSWORD } from './lib.mjs';

const KINGSTON = 'officer@kingston.gov.uk';
const TH = 'matthew.mannion@towerhamlets.gov.uk';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEFAULTS = { 'civicos.ssoSessionMaxSeconds': '43200', 'civicos.mailboxMaxAgeSeconds': '2592000' };

after(async () => {
  await setRealmAttributes(DEFAULTS);
  await setOrgAttributes('kingston', { signInPolicy: 'sso_available' });
  await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date().toISOString());
});

async function ssoSignIn() {
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: KINGSTON });
  await browser.submit('civicos-choose-form', { method: 'sso' });
  assert.match(browser.url, /\/realms\/council-sim\//);
  const r = await browser.submit('kc-form-login', { username: 'officer', password: PASSWORD });
  assert.ok(r.redirect, browser.text().slice(0, 200));
  return exchange(r.redirect, verifier);
}

test('a fresh session refreshes normally', async () => {
  const t = await signIn(TH);
  const r = await refresh(t.refresh_token);
  assert.equal(r.status, 200, r.json.error || "tokens issued");
});

test('(a) a council SSO session past its limit cannot be refreshed', async () => {
  const t = await ssoSignIn();
  assert.equal(t.access.civicos_method, 'sso');
  assert.equal((await refresh(t.refresh_token)).status, 200);
  await setRealmAttributes({ 'civicos.ssoSessionMaxSeconds': '3' });
  try {
    await sleep(4000);
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 400, r.json.error || "tokens issued");
    assert.equal(r.json.error, 'invalid_grant');
  } finally {
    await setRealmAttributes(DEFAULTS);
  }
  // The Keycloak session is gone too, so no product can refresh or silently sign in on it.
  assert.equal((await refresh(t.refresh_token)).status, 400);
});

test('(b) once the organisation requires SSO, a password session cannot be refreshed', async () => {
  const t = await signIn(KINGSTON);
  assert.equal(t.access.civicos_method, 'password');
  assert.equal((await refresh(t.refresh_token)).status, 200);
  await setOrgAttributes('kingston', { signInPolicy: 'sso_required' });
  try {
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 400, r.json.error || "tokens issued");
    assert.equal(r.json.error, 'invalid_grant');
  } finally {
    await setOrgAttributes('kingston', { signInPolicy: 'sso_available' });
  }
});

test('(b) an SSO session still refreshes when the organisation requires SSO', async () => {
  const t = await ssoSignIn();
  await setOrgAttributes('kingston', { signInPolicy: 'sso_required' });
  try {
    assert.equal((await refresh(t.refresh_token)).status, 200);
  } finally {
    await setOrgAttributes('kingston', { signInPolicy: 'sso_available' });
  }
});

test('(c) a password session whose mailbox check is past the limit cannot be refreshed', async () => {
  await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date().toISOString());
  const t = await signIn(TH);
  assert.equal((await refresh(t.refresh_token)).status, 200);
  await setRealmAttributes({ 'civicos.mailboxMaxAgeSeconds': '2' });
  try {
    await sleep(4000); // whole seconds: more than 2 have passed
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 400, r.json.error || "tokens issued");
    assert.equal(r.json.error, 'invalid_grant');
  } finally {
    await setRealmAttributes(DEFAULTS);
    await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date().toISOString());
  }
});

test('(c) with the default 30 days, a mailbox check 31 days old stops the refresh', async () => {
  await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date().toISOString());
  const t = await signIn(TH);
  await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date(Date.now() - 31 * 864e5).toISOString());
  try {
    const r = await refresh(t.refresh_token);
    assert.equal(r.status, 400, r.json.error || "tokens issued");
  } finally {
    await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date().toISOString());
  }
});
