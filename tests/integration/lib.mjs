// Small headless browser for driving Keycloak's login pages over HTTP, plus Mailpit and admin helpers.
import './localhost-dns.cjs'; // *.localhost (auth.civicos.localhost, sso.kingston.localhost) for Node
import { createHash, createHmac, randomBytes } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { Admin } from '../../scripts/realm/lib.mjs';

import { CONFIG, readJson } from '../../scripts/realm/lib.mjs';
import { join } from 'node:path';

export const KC = process.env.KC_SERVER || 'http://localhost:8180';
// Browser-facing Keycloak hosts (realm ocn's frontendUrl and the fake council IdP's own host):
// a redirect to any of them stays "inside Keycloak". Node reaches *.localhost through
// ./localhost-dns.cjs (a copy of ~/Repositories/civicos-local/lib/localhost-dns.cjs).
const LOCAL_ENV = readJson(join(CONFIG, 'env', 'local.json'));
const LOCAL_SEED = readJson(join(CONFIG, 'env', 'local-seed.json'));
export const KC_PUBLIC = (LOCAL_ENV.frontendUrl || KC).replace(/\/$/, '');
export const SIM_PUBLIC = (LOCAL_SEED.councilSim.frontendUrl || KC).replace(/\/$/, '');
const KEYCLOAK_ORIGINS = [new URL(KC).origin, new URL(KC_PUBLIC).origin, new URL(SIM_PUBLIC).origin];
export const MAILPIT = process.env.MAILPIT_URL || 'http://localhost:8025';
export const PASSWORD = 'CivicOS-Local-2026!';
export const admin = Admin.fromEnv('ocn');
export const simAdmin = Admin.fromEnv('council-sim');

export function clientSecret(clientId) {
  const file = process.env.CLIENTS_ENV || `${process.env.HOME}/Repositories/ocn-keycloak/local/clients.env`;
  const key = `${clientId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_SECRET`;
  const line = readFileSync(file, 'utf8').split('\n').find((l) => l.startsWith(`${key}=`));
  if (!line) throw new Error(`no ${key} in ${file}`);
  return line.slice(key.length + 1).trim();
}

const unescapeHtml = (s) => s.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

export class Browser {
  constructor() { this.cookies = new Map(); this.html = ''; this.url = ''; }

  cookieHeader(url) {
    const u = new URL(url);
    return [...this.cookies.values()].filter((c) => u.pathname.startsWith(c.path || '/')).map((c) => `${c.name}=${c.value}`).join('; ');
  }

  store(res) {
    for (const sc of res.headers.getSetCookie?.() || []) {
      const [pair, ...attrs] = sc.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      const path = (attrs.find((a) => a.trim().toLowerCase().startsWith('path=')) || 'path=/').split('=')[1].trim();
      const expired = attrs.some((a) => /max-age=0/i.test(a)) || attrs.some((a) => /expires=thu, 01 jan 1970/i.test(a));
      const key = `${name}|${path}`;
      if (expired || value === '') this.cookies.delete(key); else this.cookies.set(key, { name, value, path });
    }
  }

  /** Request, following redirects until one leaves Keycloak's host:port (returned as { redirect }). */
  async go(url, init = {}) {
    let current = url;
    let opts = init;
    for (let i = 0; i < 20; i++) {
      const res = await fetch(current, { ...opts, redirect: 'manual', headers: { ...(opts.headers || {}), cookie: this.cookieHeader(current) } });
      this.store(res);
      if (res.status >= 300 && res.status < 400) {
        const loc = new URL(res.headers.get('location'), current).toString();
        if (!KEYCLOAK_ORIGINS.includes(new URL(loc).origin)) return { redirect: loc, status: res.status };
        current = loc;
        opts = {};
        continue;
      }
      this.url = current;
      this.html = await res.text();
      return { status: res.status, html: this.html };
    }
    throw new Error('too many redirects');
  }

  form(id) {
    const re = id ? new RegExp(`<form[^>]*id="${id}"[^>]*>`, 'i') : /<form[^>]*>/i;
    const m = this.html.match(re);
    if (!m) throw new Error(`no form ${id || ''} on page: ${this.title()}\n${this.text().slice(0, 400)}`);
    const action = unescapeHtml(m[0].match(/action="([^"]*)"/)[1]);
    return new URL(action, this.url).toString();
  }

  async submit(formId, fields) {
    return this.go(this.form(formId), { method: 'POST', body: new URLSearchParams(fields), headers: { 'content-type': 'application/x-www-form-urlencoded' } });
  }

  title() { return (this.html.match(/<title>([^<]*)<\/title>/) || [])[1] || ''; }
  text() { return unescapeHtml(this.html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<style[\s\S]*?<\/style>/g, '').replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()); }
  template() { return (this.html.match(/<!-- template: ([^ ]+)/) || [])[1] || ''; }
}

export function pkce() {
  const verifier = randomBytes(32).toString('base64url');
  const challenge = createHash('sha256').update(verifier).digest('base64url');
  return { verifier, challenge };
}

export const PORTAL = { clientId: 'civicos-portal', redirectUri: `${LOCAL_ENV.portalUrl.replace(/\/$/, '')}/api/auth/callback/keycloak` };

export function authUrl({ clientId = PORTAL.clientId, redirectUri = PORTAL.redirectUri, challenge, extra = {} }) {
  const u = new URL(`${KC_PUBLIC}/realms/ocn/protocol/openid-connect/auth`);
  const p = { client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: 'openid email profile', state: randomBytes(8).toString('hex'), nonce: randomBytes(8).toString('hex'), code_challenge: challenge, code_challenge_method: 'S256', ...extra };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}

export function decode(jwt) {
  return JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
}

export async function exchange(redirect, verifier, { clientId = PORTAL.clientId, redirectUri = PORTAL.redirectUri } = {}) {
  const u = new URL(redirect);
  const code = u.searchParams.get('code');
  if (!code) throw new Error(`no code in redirect ${redirect}`);
  const res = await fetch(`${KC}/realms/ocn/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirectUri, client_id: clientId, client_secret: clientSecret(clientId), code_verifier: verifier }),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  return { ...json, id: decode(json.id_token), access: decode(json.access_token) };
}

/** Start a sign-in for the portal client; returns { browser, verifier }. */
export async function start(extra = {}, browser = new Browser()) {
  const { verifier, challenge } = pkce();
  const r = await browser.go(authUrl({ challenge, extra }));
  return { browser, verifier, first: r };
}

// Mailpit -----------------------------------------------------------------------------------

export async function clearMail(to) {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  const json = await res.json();
  const ids = (json.messages || []).map((m) => m.ID);
  if (ids.length) await fetch(`${MAILPIT}/api/v1/messages`, { method: 'DELETE', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ IDs: ids }) });
}

export async function latestCode(to, { timeoutMs = 10000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
    const json = await res.json();
    const m = json.messages?.[0];
    if (m) {
      const full = await (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
      const code = (full.Text.match(/\b(\d{6})\b/) || [])[1];
      if (code) return { code, subject: full.Subject, text: full.Text };
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`no code email for ${to}`);
}

// Admin -------------------------------------------------------------------------------------

export async function userByEmail(email, a = admin) {
  return (await a.get(`/users?email=${encodeURIComponent(email)}&exact=true`))[0] || null;
}

export async function ensureUser(email, { password = PASSWORD, firstName = 'Test', lastName = 'Person', attributes } = {}) {
  let u = await userByEmail(email);
  if (!u) {
    await admin.post('/users', { username: email, email, firstName, lastName, enabled: true, emailVerified: true, attributes: attributes || { civicosMailboxVerifiedAt: [new Date().toISOString()] } });
    u = await userByEmail(email);
  }
  if (password) await admin.put(`/users/${u.id}/reset-password`, { type: 'password', value: password, temporary: false });
  return u;
}

export async function deleteUser(email) {
  const u = await userByEmail(email);
  if (u) await admin.del(`/users/${u.id}`);
}

export async function setUserAttribute(email, key, value) {
  const u = await admin.get(`/users/${(await userByEmail(email)).id}`);
  u.attributes = { ...(u.attributes || {}), [key]: [value] };
  await admin.put(`/users/${u.id}`, u);
}

export async function org(alias) {
  return (await admin.get('/organizations?first=0&max=10000&briefRepresentation=false')).find((o) => o.alias === alias);
}

export async function setOrgAttributes(alias, attrs) {
  const o = await org(alias);
  const next = { ...o, attributes: { ...(o.attributes || {}) } };
  for (const [k, v] of Object.entries(attrs)) next.attributes[k] = [String(v)];
  await admin.put(`/organizations/${o.id}`, next);
}

/** TOTP (SHA-1, 6 digits, 30 s) for Keycloak's raw secret (the hidden totpSecret field). */
export function totp(rawSecret, t = Date.now()) {
  const bytes = Buffer.from(rawSecret, 'utf8');
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 1000 / 30)));
  const h = createHmac('sha1', bytes).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

// Sign-in, refresh, realm and limit helpers ---------------------------------------------------

/** Password sign-in through the CivicOS browser flow for the portal client; returns the tokens. */
export async function signIn(email, { password = PASSWORD, browser = new Browser(), extra = {} } = {}) {
  const s = await start(extra, browser);
  await browser.submit('civicos-email-form', { email });
  if (browser.template() === 'civicos-choose.ftl') await browser.submit('civicos-choose-form', { method: 'password' });
  const r = await browser.submit('civicos-password-form', { password });
  if (!r.redirect) throw new Error(`sign-in for ${email} stopped at ${browser.template()}: ${browser.text().slice(0, 200)}`);
  return exchange(r.redirect, s.verifier);
}

/** refresh_token grant from a product client, as products do every 5 minutes. */
export async function refresh(refreshToken, clientId = PORTAL.clientId) {
  const res = await fetch(`${KC}/realms/ocn/protocol/openid-connect/token`, {
    method: 'POST',
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret(clientId) }),
  });
  return { status: res.status, json: await res.json() };
}

/** Set realm attributes; returns the previous values so a test can put them back. */
export async function setRealmAttributes(attrs) {
  const realm = await admin.get('');
  const before = {};
  for (const k of Object.keys(attrs)) before[k] = realm.attributes?.[k] ?? null;
  const next = { ...(realm.attributes || {}) };
  for (const [k, v] of Object.entries(attrs)) next[k] = v === null ? '' : String(v);
  await admin.put('', { ...realm, attributes: next });
  return before;
}

/** A realm-management token for realm ocn (the registry sync service account). */
export async function serviceToken() {
  const res = await fetch(`${KC}/realms/ocn/protocol/openid-connect/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'client_credentials', client_id: 'civicos-registry-sync', client_secret: clientSecret('civicos-registry-sync') }) });
  const json = await res.json();
  if (!res.ok) throw new Error(`service token: ${JSON.stringify(json)}`);
  return json.access_token;
}

/** Clear the per-address email-code counters and lock (the support endpoint). */
export async function resetCodeLimits(email) {
  const res = await fetch(`${KC}/realms/ocn/civicos-admin/code-limits/reset`, { method: 'POST', headers: { authorization: `Bearer ${await serviceToken()}`, 'content-type': 'application/json' }, body: JSON.stringify({ email }) });
  return res.status;
}

export async function mailCount(to) {
  const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}`);
  return (await res.json()).messages_count || 0;
}

/** The newest email to an address, optionally only one that arrived after a time. */
export async function latestMail(to, { after = 0, timeoutMs = 10000 } = {}) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const res = await fetch(`${MAILPIT}/api/v1/search?query=${encodeURIComponent(`to:"${to}"`)}&limit=1`);
    const m = (await res.json()).messages?.[0];
    if (m && Date.parse(m.Created) >= after) return (await fetch(`${MAILPIT}/api/v1/message/${m.ID}`)).json();
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
}

export async function ensureOrg(alias, domain, attributes = {}) {
  let o = await org(alias);
  const attrs = Object.fromEntries(Object.entries({ kind: 'council', customer: 'false', signInPolicy: 'open', requireSecondFactor: 'false', ...attributes }).map(([k, v]) => [k, [String(v)]]));
  if (!o) await admin.post('/organizations', { name: `Integration ${alias}`, alias, enabled: true, domains: [{ name: domain, verified: true }], attributes: attrs });
  else await admin.put(`/organizations/${o.id}`, { ...o, attributes: attrs });
  return org(alias);
}

export async function deleteOrg(alias) {
  const o = await org(alias);
  if (o) await admin.del(`/organizations/${o.id}`);
}

/** Give a user an authenticator app with a known raw secret (as scripts/local/seed.mjs does for staff). */
export async function addTotp(userId, secret, label = 'Integration phone') {
  await admin.put(`/users/${userId}`, {
    credentials: [{ type: 'otp', userLabel: label, secretData: JSON.stringify({ value: secret }), credentialData: JSON.stringify({ subType: 'totp', digits: 6, counter: 0, period: 30, algorithm: 'HmacSHA1' }) }],
  });
}

/** A TOTP code for a secret that is not the one used in this 30-second window yet. */
export async function freshTotp(secret, used = new Set()) {
  for (;;) {
    const left = 30_000 - (Date.now() % 30_000);
    const code = totp(secret);
    if (left > 4_000 && !used.has(code)) { used.add(code); return code; }
    await new Promise((r) => setTimeout(r, left + 250));
  }
}
