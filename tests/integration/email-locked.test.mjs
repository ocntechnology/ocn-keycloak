// ID-1: a person cannot change their own account email, and an unverified email never gets an
// organisation membership or a password-only sign-in.
// Run: node --test --test-concurrency=1 tests/integration/  (needs scripts/local-up.sh to have run)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Browser, start, exchange, clearMail, latestCode, ensureUser, deleteUser, userByEmail, admin, signIn, org, resetCodeLimits, KC, PASSWORD } from './lib.mjs';

const ME = 'integration.email@towerhamlets.gov.uk';
const OTHER = 'integration.email@hackney.gov.uk';
const PERSONAL = 'integration.email@gmail.com';

async function memberOf(userId) {
  return ((await admin.get(`/organizations/members/${userId}/organizations`)) || []).map((o) => o.alias);
}

before(async () => {
  // Fixed addresses: lift the per-address code limits (ID-3) so back-to-back runs get codes.
  for (const e of [ME, OTHER, PERSONAL]) { await deleteUser(e); await resetCodeLimits(e); }
});

after(async () => {
  for (const e of [ME, OTHER, PERSONAL]) await deleteUser(e);
  await clearMail(ME);
});

test('the account API refuses an email change, so a sign-in cannot move the person into another organisation', async () => {
  await ensureUser(ME, { firstName: 'Ema', lastName: 'Ilchange' });
  const t = await signIn(ME);
  assert.deepEqual(t.access.organization, ['tower-hamlets']);
  const headers = { authorization: `Bearer ${t.access_token}`, 'content-type': 'application/json', accept: 'application/json' };
  const account = await (await fetch(`${KC}/realms/ocn/account/`, { headers })).json();
  assert.equal(account.email, ME);
  for (const email of [OTHER, PERSONAL]) {
    const res = await fetch(`${KC}/realms/ocn/account/`, { method: 'POST', headers, body: JSON.stringify({ ...account, email }) });
    const u = await userByEmail(ME);
    assert.ok(u, `the account still has ${ME} after trying ${email} (status ${res.status})`);
    assert.equal(u.email, ME);
    assert.equal(u.emailVerified, true);
    assert.equal(await userByEmail(email), null, `${email} was not given to the account`);
  }
  // Signing in at the other council's address is a different, new person (an email code), never this account.
  const s = await start();
  await s.browser.submit('civicos-email-form', { email: OTHER });
  assert.equal(s.browser.template(), 'civicos-code.ftl');
  const u = await userByEmail(ME);
  assert.deepEqual(await memberOf(u.id), ['tower-hamlets']);
  await clearMail(OTHER);
});

test('the user profile makes email admin-only', async () => {
  const profile = await admin.get('/users/profile');
  const email = profile.attributes.find((a) => a.name === 'email');
  assert.deepEqual(email.permissions.edit, ['admin']);
});

test('a correct password for an unverified email asks for an email code first, and gives no membership until then', async () => {
  for (const e of [OTHER, PERSONAL]) await deleteUser(e);
  const u = await ensureUser(ME);
  const th = await org('tower-hamlets');
  if ((await memberOf(u.id)).includes('tower-hamlets')) await admin.del(`/organizations/${th.id}/members/${u.id}`);
  const full = await admin.get(`/users/${u.id}`);
  await admin.put(`/users/${u.id}`, { ...full, emailVerified: false });
  await clearMail(ME);
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: ME });
  const r = await browser.submit('civicos-password-form', { password: PASSWORD });
  assert.equal(r.redirect, undefined, 'no sign-in on the password alone');
  assert.equal(browser.template(), 'civicos-code.ftl');
  assert.deepEqual(await memberOf(u.id), [], 'not a member before the mailbox is proved');
  const { code } = await latestCode(ME);
  const done = await browser.submit('civicos-code-form', { code });
  assert.ok(done.redirect, browser.text().slice(0, 200));
  const t = await exchange(done.redirect, verifier);
  assert.deepEqual(t.access.organization, ['tower-hamlets']);
  assert.equal((await userByEmail(ME)).emailVerified, true);
});

test('the first-sign-in profile screen shows the email as text, not a field', async () => {
  await deleteUser(OTHER);
  await clearMail(OTHER);
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: OTHER });
  const { code } = await latestCode(OTHER);
  await browser.submit('civicos-code-form', { code });
  assert.match(browser.html, /id="kc-update-profile-form"/);
  assert.doesNotMatch(browser.html, /<input[^>]*name="email"/, 'no email input');
  assert.match(browser.text(), new RegExp(OTHER.replace(/\./g, '\\.')));
  const r = await browser.submit('kc-update-profile-form', { firstName: 'Ina', lastName: 'Tegration' });
  assert.ok(r.redirect, browser.text().slice(0, 300));
  const t = await exchange(r.redirect, verifier);
  assert.equal(t.id.email, OTHER);
  void Browser;
});
