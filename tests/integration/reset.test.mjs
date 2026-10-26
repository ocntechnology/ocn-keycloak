// ID-2: "Forgotten your password?" follows the CivicOS sign-in policy and never signs anyone in.
// Run: node --test --test-concurrency=1 tests/integration/  (needs scripts/local-up.sh to have run)
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  Browser, start, exchange, clearMail, latestMail, mailCount, ensureUser, deleteUser, userByEmail, admin, ensureOrg, deleteOrg,
  addTotp, freshTotp, resetCodeLimits, KC_PUBLIC,
} from './lib.mjs';

const SSOREQ_ORG = 'integration-ssoreq';
const SSOREQ_DOMAIN = 'integration-ssoreq.example';
const SSOREQ = `person@${SSOREQ_DOMAIN}`;
const STAFF = 'integration.reset-staff@ocn.technology';
const OTP = 'integration.reset-otp@hackney.gov.uk';
const OTP_SECRET = 'Integration-Reset-TOTP-Secret';
const NEWPW = `Integration-Reset-${Date.now()}`;
const used = new Set();

before(async () => {
  for (const e of [SSOREQ, STAFF, OTP]) { await deleteUser(e); await clearMail(e); await resetCodeLimits(e); }
  await ensureOrg(SSOREQ_ORG, SSOREQ_DOMAIN, { signInPolicy: 'sso_required', requireSecondFactor: 'true' });
});

after(async () => {
  for (const e of [SSOREQ, STAFF, OTP]) { await deleteUser(e); await clearMail(e); await resetCodeLimits(e); }
  await deleteOrg(SSOREQ_ORG);
});

/** Open the reset page for a portal sign-in in this browser, as the "Forgotten your password?" link does. */
async function openReset(browser) {
  const s = await start({}, browser);
  const tab = new URL(browser.form('civicos-email-form')).searchParams.get('tab_id');
  await browser.go(`${KC_PUBLIC}/realms/ocn/login-actions/reset-credentials?client_id=civicos-portal&tab_id=${tab}`);
  return s;
}

/** Ask for a reset email for an address on whichever reset form the realm shows. */
async function askForReset(browser, email) {
  const m = browser.html.match(/<form[^>]*id="([^"]+)"/);
  return browser.submit(m ? m[1] : undefined, { email, username: email });
}

/** Follow the reset link from the email and choose a new password. */
async function followLinkAndSetPassword(browser, email, since) {
  const mail = await latestMail(email, { after: since });
  assert.ok(mail, 'a reset email was sent');
  const link = (mail.Text.match(/https?:\/\/\S+action-token\S+/) || [])[0];
  assert.ok(link, 'the email has a reset link');
  await browser.go(link.replace(/[)>\].,]+$/, ''));
  return browser.submit('kc-passwd-update-form', { 'password-new': NEWPW, 'password-confirm': NEWPW });
}

test('reset is refused when the organisation requires its own sign-in (SSO required), and no email is sent', async () => {
  await ensureUser(SSOREQ);
  const b = new Browser();
  await openReset(b);
  await askForReset(b, SSOREQ);
  assert.match(b.text(), /organisation signs you in with its own account|requires its own sign-in/i, b.text().slice(0, 300));
  await new Promise((r) => setTimeout(r, 1500));
  assert.equal(await mailCount(SSOREQ), 0, 'no reset email');
});

test('reset refuses personal and unknown domains, like sign-in', async () => {
  for (const [email, re] of [['someone@gmail.com', /cannot use a personal email address/], ['someone@not-registered.example', /do not recognise this organisation/]]) {
    const b = new Browser();
    await openReset(b);
    await askForReset(b, email);
    assert.match(b.text(), re, `${email}: ${b.text().slice(0, 200)}`);
  }
});

test('reset for OCN staff ends on the sign-in page, and signing in still needs the authenticator app', async () => {
  const u = await ensureUser(STAFF);
  await admin.post(`/users/${u.id}/role-mappings/realm`, [await admin.get('/roles/ocn-staff')]);
  const b = new Browser();
  await openReset(b);
  const since = Date.now() - 1000;
  await askForReset(b, STAFF);
  const r = await followLinkAndSetPassword(b, STAFF, since);
  assert.equal(r.redirect, undefined, `no sign-in at the end of a reset (went to ${r.redirect})`);
  assert.match(b.text(), /password has been changed|Sign in/i, b.text().slice(0, 300));
  // Signing in now goes through the normal flow: password, then set up the authenticator app.
  const s = await start({}, new Browser());
  await s.browser.submit('civicos-email-form', { email: STAFF });
  const r2 = await s.browser.submit('civicos-password-form', { password: NEWPW });
  assert.equal(r2.redirect, undefined, 'staff are never signed in on a password alone');
  assert.match(s.browser.html, /id="kc-totp-settings-form"/);
});

test('reset for a person with an authenticator app keeps the app, and signing in still asks for it', async () => {
  const u = await ensureUser(OTP);
  await addTotp(u.id, OTP_SECRET);
  const b = new Browser();
  await openReset(b);
  const since = Date.now() - 1000;
  await askForReset(b, OTP);
  const r = await followLinkAndSetPassword(b, OTP, since);
  assert.equal(r.redirect, undefined, `no sign-in at the end of a reset (went to ${r.redirect})`);
  const creds = await admin.get(`/users/${u.id}/credentials`);
  assert.ok(creds.some((c) => c.type === 'otp'), 'the authenticator app is still there');
  assert.ok(!(await admin.get(`/users/${u.id}`)).requiredActions?.includes('CONFIGURE_TOTP'), 'no new app set-up');
  const s = await start({}, new Browser());
  await s.browser.submit('civicos-email-form', { email: OTP });
  await s.browser.submit('civicos-password-form', { password: NEWPW });
  assert.equal(s.browser.template(), 'civicos-otp.ftl', `asked for the app code, got ${s.browser.template()}`);
  const r3 = await s.browser.submit('civicos-otp-form', { otp: await freshTotp(OTP_SECRET, used) });
  assert.ok(r3.redirect, s.browser.text().slice(0, 300));
  const t = await exchange(r3.redirect, s.verifier);
  assert.equal(t.id.acr, '2');
  void userByEmail;
});
