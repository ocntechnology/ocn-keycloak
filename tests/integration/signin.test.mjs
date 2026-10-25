// Integration tests for the CivicOS sign-in policy extension against the local Keycloak.
// Run: node --test tests/integration/  (needs scripts/local-up.sh to have run)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  Browser, start, exchange, clearMail, latestCode, ensureUser, deleteUser, setUserAttribute, setOrgAttributes,
  userByEmail, admin, simAdmin, totp, PASSWORD, KC,
} from './lib.mjs';

const pause = () => new Promise((r) => setTimeout(r, 1100));
const TH = 'matthew.mannion@towerhamlets.gov.uk';
const KINGSTON = 'officer@kingston.gov.uk';
const NEW_HACKNEY = 'integration.new@hackney.gov.uk';
const GUEST = 'guest@partner-agency.example';
const LOCK = 'integration.lockout@hackney.gov.uk';
const STEP = 'integration.stepup@hackney.gov.uk';

before(async () => {
  await deleteUser(NEW_HACKNEY);
  await deleteUser(GUEST);
  await deleteUser(STEP);
  await deleteUser(LOCK);
  await setOrgAttributes('kingston', { signInPolicy: 'sso_available', requireSecondFactor: 'false' });
  await setOrgAttributes('hackney', { signInPolicy: 'open', requireSecondFactor: 'false' });
  await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date().toISOString());
});

after(async () => {
  await setOrgAttributes('kingston', { signInPolicy: 'sso_available', requireSecondFactor: 'false' });
  await setOrgAttributes('hackney', { signInPolicy: 'open', requireSecondFactor: 'false' });
  await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date().toISOString());
  for (const e of [NEW_HACKNEY, GUEST, STEP, LOCK]) await deleteUser(e);
});

test('the sign-in page asks for an email first, with the OCN theme', async () => {
  const { browser } = await start();
  assert.equal(browser.template(), 'civicos-email.ftl');
  assert.match(browser.html, /<label for="email"/);
  assert.match(browser.html, /autocomplete="username email"/);
  assert.match(browser.html, /login\.css/);
});

test('password sign-in gives acr 1, the organisation and the method', async () => {
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: TH });
  assert.equal(browser.template(), 'civicos-password.ftl');
  const r = await browser.submit('civicos-password-form', { password: PASSWORD });
  assert.ok(r.redirect, `expected redirect, got ${browser.template()} ${browser.text().slice(0, 200)}`);
  const t = await exchange(r.redirect, verifier);
  assert.equal(t.id.acr, '1');
  assert.equal(t.access.acr, '1');
  assert.deepEqual(t.access.organization, ['tower-hamlets']);
  assert.equal(t.access.civicos_method, 'password');
  assert.equal(t.id.email, TH);
});

test('a wrong password is refused with a clear message', async () => {
  const { browser } = await start();
  await browser.submit('civicos-email-form', { email: TH });
  await browser.submit('civicos-password-form', { password: 'not-the-password-123' });
  assert.equal(browser.template(), 'civicos-password.ftl');
  assert.match(browser.text(), /That password is not right/);
});

test('personal email addresses are refused', async () => {
  for (const email of ['someone@gmail.com', 'someone@yahoo.co.uk', 'someone@outlook.com']) {
    const { browser } = await start();
    await browser.submit('civicos-email-form', { email });
    assert.equal(browser.template(), 'civicos-email.ftl');
    assert.match(browser.text(), /cannot use a personal email address/);
  }
});

test('an unregistered work domain is refused unless the person was invited', async () => {
  const { browser } = await start();
  await browser.submit('civicos-email-form', { email: GUEST });
  assert.match(browser.text(), /do not recognise this organisation/);
  // Invite (create) them: now they can sign in with a code.
  await ensureUser(GUEST, { password: null });
  await clearMail(GUEST);
  const s = await start();
  await s.browser.submit('civicos-email-form', { email: GUEST });
  assert.equal(s.browser.template(), 'civicos-code.ftl');
  const { code } = await latestCode(GUEST);
  const r = await s.browser.submit('civicos-code-form', { code });
  assert.ok(r.redirect, s.browser.text().slice(0, 300));
  const t = await exchange(r.redirect, s.verifier);
  assert.equal(t.access.civicos_method, 'email_code');
  assert.equal(t.access.organization, undefined);
});

test('first email-code sign-in at a registered council creates the account and asks for a name', async () => {
  await clearMail(NEW_HACKNEY);
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: NEW_HACKNEY });
  assert.equal(browser.template(), 'civicos-code.ftl');
  const mail = await latestCode(NEW_HACKNEY);
  assert.equal(mail.subject, 'Your CivicOS sign-in code');
  assert.match(mail.text, /works for 10 minutes/);
  await browser.submit('civicos-code-form', { code: mail.code });
  assert.match(browser.html, /id="kc-update-profile-form"/, 'asks for their name');
  const r = await browser.submit('kc-update-profile-form', { firstName: 'Ina', lastName: 'Tegration', email: NEW_HACKNEY });
  assert.ok(r.redirect, browser.text().slice(0, 300));
  const t = await exchange(r.redirect, verifier);
  assert.equal(t.id.acr, '1');
  assert.equal(t.access.civicos_method, 'email_code');
  assert.deepEqual(t.access.organization, ['hackney']);
  const u = await userByEmail(NEW_HACKNEY);
  assert.equal(u.emailVerified, true);
  assert.ok(u.attributes.civicosMailboxVerifiedAt?.[0]);
});

test('email codes: wrong codes are counted and the fifth wrong one voids the code', async () => {
  await clearMail(NEW_HACKNEY);
  const { browser } = await start();
  await browser.submit('civicos-email-form', { email: NEW_HACKNEY });
  // Existing user with no password: goes straight to a code.
  assert.equal(browser.template(), 'civicos-code.ftl');
  const { code } = await latestCode(NEW_HACKNEY);
  const wrong = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < 4; i++) {
    await pause(); // Keycloak locks briefly for attempts under a second apart
    await browser.submit('civicos-code-form', { code: wrong });
    assert.match(browser.text(), /That code is not right/);
  }
  await pause();
  await browser.submit('civicos-code-form', { code: wrong });
  assert.match(browser.text(), /Too many wrong codes/);
  await browser.submit('civicos-code-form', { code });
  assert.match(browser.text(), /expired/, 'the right code no longer works');
});

test('30-day mailbox check: a password sign-in after 31 days needs an email code', async () => {
  await setUserAttribute(TH, 'civicosMailboxVerifiedAt', new Date(Date.now() - 31 * 864e5).toISOString());
  await clearMail(TH);
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: TH });
  await browser.submit('civicos-password-form', { password: PASSWORD });
  assert.equal(browser.template(), 'civicos-code.ftl');
  assert.match(browser.text(), /Every 30 days/);
  const mail = await latestCode(TH);
  assert.equal(mail.subject, 'Confirm your email for CivicOS');
  const r = await browser.submit('civicos-code-form', { code: mail.code });
  assert.ok(r.redirect);
  const t = await exchange(r.redirect, verifier);
  assert.equal(t.access.civicos_method, 'password');
  const u = await userByEmail(TH);
  assert.ok(Date.now() - Date.parse(u.attributes.civicosMailboxVerifiedAt[0]) < 60_000, 'attribute refreshed');
});

async function councilSimLogin(browser, username) {
  // We are now on the fake council IdP's own login page (realm council-sim).
  assert.match(browser.url, /\/realms\/council-sim\//);
  return browser.submit('kc-form-login', { username, password: PASSWORD });
}

test('SSO available: the choice page offers council SSO; SSO gives acr 2 and links the existing account', async () => {
  const { browser, verifier } = await start();
  await browser.submit('civicos-email-form', { email: KINGSTON });
  assert.equal(browser.template(), 'civicos-choose.ftl');
  assert.match(browser.text(), /Sign in with Kingston Council SSO/);
  assert.match(browser.text(), /Use my password/);
  await browser.submit('civicos-choose-form', { method: 'sso' });
  const r = await councilSimLogin(browser, 'officer');
  assert.ok(r.redirect, `${browser.template()} ${browser.text().slice(0, 300)}`);
  const t = await exchange(r.redirect, verifier);
  assert.equal(t.id.acr, '2');
  assert.equal(t.access.civicos_method, 'sso');
  assert.deepEqual(t.access.organization, ['kingston']);
  const u = await userByEmail(KINGSTON);
  const links = await admin.get(`/users/${u.id}/federated-identity`);
  assert.ok(links.some((l) => l.identityProvider === 'kingston-sso'), 'linked by verified email');
  assert.equal(t.id.sub, u.id, 'same account as before');
});

test('SSO required: email goes straight to the council IdP; passwords no longer work', async () => {
  await setOrgAttributes('kingston', { signInPolicy: 'sso_required' });
  try {
    const { browser, verifier } = await start();
    await browser.submit('civicos-email-form', { email: KINGSTON });
    assert.match(browser.url, /\/realms\/council-sim\//, 'redirected to the council sign-in');
    const r = await councilSimLogin(browser, 'officer');
    const t = await exchange(r.redirect, verifier);
    assert.equal(t.id.acr, '2');
    // A brand-new Kingston starter is created on first SSO sign-in.
    const s = await start();
    await s.browser.submit('civicos-email-form', { email: 'new.starter@kingston.gov.uk' });
    const r2 = await councilSimLogin(s.browser, 'newstarter');
    assert.ok(r2.redirect, `${s.browser.template()} ${s.browser.text().slice(0, 300)}`);
    const t2 = await exchange(r2.redirect, s.verifier);
    assert.equal(t2.id.email, 'new.starter@kingston.gov.uk');
    assert.equal(t2.access.civicos_method, 'sso');
  } finally {
    await setOrgAttributes('kingston', { signInPolicy: 'sso_available' });
    await deleteUser('new.starter@kingston.gov.uk');
  }
});

test('SSO for the wrong domain cannot take over an account', async () => {
  const { browser } = await start();
  await browser.submit('civicos-email-form', { email: KINGSTON });
  await browser.submit('civicos-choose-form', { method: 'sso' });
  await councilSimLogin(browser, 'intruder'); // someone@hackney.gov.uk at Kingston's IdP
  assert.match(browser.text(), /not at one of your organisation's email domains/);
  assert.equal(await userByEmail('someone@hackney.gov.uk'), null);
});

test('step-up: acr_values=2 on an existing session asks for an authenticator app (set up on first use)', async () => {
  await ensureUser(STEP);
  const b = new Browser();
  const first = await start({}, b);
  await b.submit('civicos-email-form', { email: STEP });
  const r1 = await b.submit('civicos-password-form', { password: PASSWORD });
  const t1 = await exchange(r1.redirect, first.verifier);
  assert.equal(t1.id.acr, '1');

  // Same browser, product asks for level 2.
  const second = await start({ acr_values: '2' }, b);
  assert.match(b.html, /id="kc-totp-settings-form"/, `got ${b.template()} ${b.text().slice(0, 200)}`);
  const secret = b.html.match(/name="totpSecret" value="([^"]+)"/)[1];
  const r2 = await b.submit('kc-totp-settings-form', { totpSecret: secret, totp: totp(secret), userLabel: 'Phone' });
  assert.ok(r2.redirect, b.text().slice(0, 300));
  const t2 = await exchange(r2.redirect, second.verifier);
  assert.equal(t2.id.acr, '2');
  assert.equal(t2.id.sub, t1.id.sub);

  // A fresh browser: password then the authenticator code; level 2 because a second factor was used.
  const fresh = await start({ acr_values: '2' });
  await fresh.browser.submit('civicos-email-form', { email: STEP });
  await fresh.browser.submit('civicos-password-form', { password: PASSWORD });
  assert.equal(fresh.browser.template(), 'civicos-otp.ftl');
  await fresh.browser.submit('civicos-otp-form', { otp: '000000' });
  assert.match(fresh.browser.text(), /That code is not right/);
  // Wait for a new TOTP window so the code is not a replay of the one used at setup.
  await new Promise((r) => setTimeout(r, 31_000 - (Date.now() % 30_000)));
  const r3 = await fresh.browser.submit('civicos-otp-form', { otp: totp(secret) });
  const t3 = await exchange(r3.redirect, fresh.verifier);
  assert.equal(t3.id.acr, '2');
});

test('organisation requires a second step for passwords', async () => {
  await setOrgAttributes('hackney', { requireSecondFactor: 'true' });
  try {
    const { browser } = await start();
    await browser.submit('civicos-email-form', { email: 'tracey.anderson@hackney.gov.uk' });
    await browser.submit('civicos-password-form', { password: PASSWORD });
    assert.match(browser.html, /id="kc-totp-settings-form"/, 'no app yet, so set one up');
  } finally {
    await setOrgAttributes('hackney', { requireSecondFactor: 'false' });
    const u = await userByEmail('tracey.anderson@hackney.gov.uk');
    const full = await admin.get(`/users/${u.id}`);
    await admin.put(`/users/${u.id}`, { ...full, requiredActions: [] });
  }
});

test('brute force: 10 wrong passwords lock the account for 15 minutes', async () => {
  await ensureUser(LOCK);
  for (let i = 0; i < 10; i++) {
    await pause();
    const { browser } = await start();
    await browser.submit('civicos-email-form', { email: LOCK });
    await browser.submit('civicos-password-form', { password: `wrong-password-${i}-xx` });
  }
  const { browser } = await start();
  await browser.submit('civicos-email-form', { email: LOCK });
  await browser.submit('civicos-password-form', { password: PASSWORD });
  assert.match(browser.text(), /Too many attempts/);
  const u = await userByEmail(LOCK);
  const status = await admin.req('GET', `/attack-detection/brute-force/users/${u.id}`.replace(/^/, `/ocn`));
  assert.equal(status.disabled, true);
});

test('password policy: under 12 characters, the email, or a common password is refused', async () => {
  const u = await ensureUser(STEP);
  for (const value of ['Short-pw1!', STEP, 'passwordpassword']) {
    await assert.rejects(admin.put(`/users/${u.id}/reset-password`, { type: 'password', value, temporary: false }), /400/, value);
  }
  await admin.put(`/users/${u.id}/reset-password`, { type: 'password', value: 'A-long-unusual-phrase-77', temporary: false });
});

test('prompt=none with no session returns login_required; with a session it succeeds silently', async () => {
  const none = await start({ prompt: 'none' });
  assert.match(none.first.redirect, /error=login_required/);
  const b = new Browser();
  const s = await start({}, b);
  await b.submit('civicos-email-form', { email: TH });
  const r = await b.submit('civicos-password-form', { password: PASSWORD });
  await exchange(r.redirect, s.verifier);
  const silent = await start({ prompt: 'none' }, b);
  assert.match(silent.first.redirect, /[?&]code=/);
  const t = await exchange(silent.first.redirect, silent.verifier);
  assert.equal(t.id.acr, '1');
  void KC; void simAdmin;
});
