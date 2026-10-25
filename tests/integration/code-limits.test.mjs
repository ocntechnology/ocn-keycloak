// ID-3: email codes are capped per address (3 per 15 minutes, 10 per day), the resend wait holds
// after a void, and 10 wrong codes for an address lock it for 15 minutes, account or not.
// The reviewer's reproduction (review/id/codes.cjs) as a test.
// Run: node --test --test-concurrency=1 tests/integration/  (needs scripts/local-up.sh to have run)
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { start, clearMail, latestCode, mailCount, resetCodeLimits, userByEmail, deleteUser } from './lib.mjs';

const run = Date.now().toString(36);
const GRIND = `integration.grind.${run}@towerhamlets.gov.uk`;
const CAP = `integration.cap.${run}@towerhamlets.gov.uk`;

after(async () => {
  for (const e of [GRIND, CAP]) { await resetCodeLimits(e); await clearMail(e); await deleteUser(e); }
});

async function codeScreen(email) {
  const s = await start();
  await s.browser.submit('civicos-email-form', { email });
  return s;
}

async function wrong(browser, code, n) {
  const bad = code === '000000' ? '111111' : '000000';
  for (let i = 0; i < n; i++) await browser.submit('civicos-code-form', { code: bad });
}

test('grinding codes for an address with no account: no new code straight after a void, and 10 wrong codes lock the address', async () => {
  const a = await codeScreen(GRIND);
  assert.equal(a.browser.template(), 'civicos-code.ftl');
  const first = await latestCode(GRIND);
  await wrong(a.browser, first.code, 5);
  assert.match(a.browser.text(), /Too many wrong codes/);
  await a.browser.submit('civicos-code-form', { resend: '1' });
  assert.equal(await mailCount(GRIND), 1, 'no new code straight after the fifth wrong one');
  assert.match(a.browser.text(), /less than 30 seconds ago/);

  // A fresh sign-in gets a new code, but the wrong ones still count for the address.
  const b = await codeScreen(GRIND);
  assert.equal(await mailCount(GRIND), 2);
  const second = await latestCode(GRIND);
  await wrong(b.browser, second.code, 4);
  assert.match(b.browser.text(), /That code is not right/);

  const c = await codeScreen(GRIND);
  assert.equal(await mailCount(GRIND), 3);
  const third = await latestCode(GRIND);
  await wrong(c.browser, third.code, 1); // the 10th wrong code for this address
  assert.match(c.browser.text(), /Too many wrong codes for this email address/);
  const r = await c.browser.submit('civicos-code-form', { code: third.code });
  assert.equal(r.redirect, undefined, 'even the right code is refused while the address is locked');
  assert.match(c.browser.text(), /Too many wrong codes for this email address/);
  assert.equal(await userByEmail(GRIND), null, 'no account was created');

  const d = await codeScreen(GRIND);
  assert.equal(await mailCount(GRIND), 3, 'no more codes while locked');
  assert.match(d.browser.text(), /Too many|wait/i);
});

test('at most 3 codes per address in 15 minutes, however many sign-ins ask', async () => {
  for (let i = 1; i <= 3; i++) {
    await codeScreen(CAP);
    assert.equal(await mailCount(CAP), i);
  }
  const fourth = await codeScreen(CAP);
  assert.equal(await mailCount(CAP), 3, 'the fourth code is not sent');
  assert.match(fourth.browser.text(), /sent several codes to this address/);
  // Support can lift the limit for an address.
  assert.equal(await resetCodeLimits(CAP), 204);
  await codeScreen(CAP);
  assert.equal(await mailCount(CAP), 4);
});
