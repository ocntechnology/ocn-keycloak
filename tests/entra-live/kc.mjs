// CivicOS sign-in through local Keycloak to the real council test tenant.
//   node kc.mjs <name> <email> <keychain-service|-> [upn] [--prompt none] [--expect-sso]
import { open, msLogin, shot, pw, text, sleep, OUT } from './drv.mjs';
import { pkce, decode } from '../integration/lib.mjs';
import { writeFileSync, readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
export const CLIENT = { clientId: 'entra-test-local', redirectUri: 'http://localhost:9911/cb',
  secret: readFileSync(`${OUT}/client.env`, 'utf8').match(/=(.*)/)[1].trim() };
export const KCL = 'http://localhost:8181/realms/ocn/protocol/openid-connect';
const PORTAL = CLIENT;
function authUrl({ challenge, extra = {} }) {
  const u = new URL(`${KCL}/auth`);
  const p = { client_id: CLIENT.clientId, redirect_uri: CLIENT.redirectUri, response_type: 'code', scope: 'openid email profile', state: randomBytes(8).toString('hex'), nonce: randomBytes(8).toString('hex'), code_challenge: challenge, code_challenge_method: 'S256', ...extra };
  for (const [k, v] of Object.entries(p)) u.searchParams.set(k, v);
  return u.toString();
}
async function exchange(redirect, verifier) {
  const code = new URL(redirect).searchParams.get('code');
  const res = await fetch(`${KCL}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: CLIENT.redirectUri, client_id: CLIENT.clientId, client_secret: CLIENT.secret, code_verifier: verifier }) });
  const json = await res.json();
  if (!res.ok) throw new Error(`token exchange failed: ${JSON.stringify(json)}`);
  return { ...json, id: decode(json.id_token), access: decode(json.access_token) };
}
export async function refresh(rt) {
  const res = await fetch(`${KCL}/token`, { method: 'POST', body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: rt, client_id: CLIENT.clientId, client_secret: CLIENT.secret }) });
  return { status: res.status, json: await res.json() };
}

export async function signIn({ name, email, service, upn = email, extra = {}, keep = false, session } = {}) {
  const { verifier, challenge } = pkce();
  const s = session || await open({ stopAt: (u) => u.startsWith(PORTAL.redirectUri) });
  s.stopped = null;
  await s.page.goto(authUrl({ challenge, extra })).catch(() => {});
  await sleep(1000);
  const steps = [];
  for (let i = 0; i < 8 && !s.stopped; i++) {
    const url = s.page.url();
    if (url.includes('login.microsoftonline.com')) {
      const r = await msLogin(s, upn, service ? pw(service) : '', { name });
      steps.push(['ms', r.state, r.code || '', (r.text || '').slice(0, 600)]);
      if (r.state === 'error' || r.state === 'page' || r.state === 'max') break;
      continue;
    }
    if (await s.page.$('#civicos-email-form')) {
      await s.page.type('#email', email); steps.push(['email']);
      await Promise.all([s.page.waitForNavigation().catch(() => {}), s.page.click('#civicos-continue')]);
      continue;
    }
    if (await s.page.$('#civicos-sso')) {
      steps.push(['choose', (await text(s)).slice(0, 300)]);
      await shot(s, `${name}-choose`);
      await Promise.all([s.page.waitForNavigation().catch(() => {}), s.page.click('#civicos-sso')]);
      await sleep(1500);
      continue;
    }
    if (url.includes('localhost:8181') || url.includes('civicos.localhost')) {
      steps.push(['kc-page', url.slice(0, 200), (await text(s)).slice(0, 600)]);
      await shot(s, `${name}-kc`);
      break;
    }
    await sleep(1500);
  }
  let tokens = null;
  if (s.stopped && new URL(s.stopped).searchParams.get('code')) tokens = await exchange(s.stopped, verifier);
  await shot(s, `${name}-end`);
  const result = { name, stopped: s.stopped, steps, id: tokens?.id, access: tokens && { acr: tokens.access.acr, civicos_method: tokens.access.civicos_method, organization: tokens.access.organization, sub: tokens.access.sub }, refresh_token: tokens?.refresh_token };
  if (!keep) await s.browser.close();
  return { result, s };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [name, email, service, upn] = process.argv.slice(2);
  const extra = process.argv.includes('--none') ? { prompt: 'none' } : {};
  const { result } = await signIn({ name, email, service: service === '-' ? null : service, upn, extra });
  writeFileSync(`${OUT}/${name}.json`, JSON.stringify(result, null, 1));
  const { refresh_token, ...shown } = result;
  console.log(JSON.stringify(shown, null, 1));
}
