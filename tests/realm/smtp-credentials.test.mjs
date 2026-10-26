// The interim production apply runs without SMTP_USER / SMTP_PASSWORD, so the realm keeps the
// SES credentials it stores today. apply.mjs must then send back the live user and the masked
// password (Keycloak keeps the stored one), never the unexpanded placeholders or blanks.
//   node --test tests/realm/smtp-credentials.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDesired, mergeSmtpCredentials } from '../../scripts/realm/lib.mjs';

const LIVE = { host: 'email-smtp.eu-west-1.amazonaws.com', ssl: 'true', starttls: 'false', auth: 'true', user: 'AKIALIVEUSER', password: '**********', from: 'admin@opencouncil.network' };

function withoutSmtpEnv(fn) {
  const saved = { u: process.env.SMTP_USER, p: process.env.SMTP_PASSWORD };
  delete process.env.SMTP_USER; delete process.env.SMTP_PASSWORD;
  try { return fn(); } finally {
    if (saved.u !== undefined) process.env.SMTP_USER = saved.u;
    if (saved.p !== undefined) process.env.SMTP_PASSWORD = saved.p;
  }
}

test('production without SMTP_USER/SMTP_PASSWORD keeps the live user and stored password', () => {
  const { settings } = withoutSmtpEnv(() => loadDesired('production'));
  assert.equal(settings.smtpServer.user, '${SMTP_USER}', 'placeholder left unexpanded by loadDesired');
  const { smtp, kept } = mergeSmtpCredentials(settings.smtpServer, LIVE);
  assert.equal(smtp.user, 'AKIALIVEUSER');
  assert.equal(smtp.password, '**********', 'the mask tells Keycloak to keep the stored password');
  assert.deepEqual(kept, ['user', 'password']);
  assert.doesNotMatch(JSON.stringify(smtp), /\$\{/);
});

test('production SMTP matches the live realm: existing SES account in eu-west-1, implicit TLS, opencouncil.network sender', () => {
  const { settings } = withoutSmtpEnv(() => loadDesired('production'));
  const s = settings.smtpServer;
  assert.equal(s.host, 'email-smtp.eu-west-1.amazonaws.com');
  assert.equal(s.ssl, 'true');
  assert.equal(s.starttls, 'false');
  assert.equal(s.port, '465');
  assert.equal(s.auth, 'true');
  assert.equal(s.from, 'admin@opencouncil.network');
  assert.equal(s.fromDisplayName, 'CivicOS');
});

test('SMTP_USER/SMTP_PASSWORD, when set, replace the live credentials', () => {
  const { smtp, kept } = mergeSmtpCredentials({ ...LIVE, user: 'AKIANEW', password: 'new-secret' }, LIVE);
  assert.equal(smtp.user, 'AKIANEW');
  assert.equal(smtp.password, 'new-secret');
  assert.deepEqual(kept, []);
});

test('blank values count as not set', () => {
  const { smtp } = mergeSmtpCredentials({ ...LIVE, user: '', password: '  ' }, LIVE);
  assert.equal(smtp.user, 'AKIALIVEUSER');
  assert.equal(smtp.password, '**********');
});

test('a vault reference stored in the live realm is sent back unchanged', () => {
  const { smtp } = mergeSmtpCredentials({ ...LIVE, password: '${SMTP_PASSWORD}' }, { ...LIVE, password: '${vault.smtp_password}' });
  assert.equal(smtp.password, '${vault.smtp_password}');
});

test('auth on with no credentials anywhere is refused', () => {
  assert.throws(() => mergeSmtpCredentials({ ...LIVE, user: '${SMTP_USER}', password: '${SMTP_PASSWORD}' }, { host: LIVE.host }), /no SMTP user and password/);
});

test('local Mailpit (no auth) needs no credentials', () => {
  const { settings } = loadDesired('local');
  const { smtp, kept } = mergeSmtpCredentials(settings.smtpServer, undefined);
  assert.equal(smtp.auth, 'false');
  assert.deepEqual(kept, []);
});
