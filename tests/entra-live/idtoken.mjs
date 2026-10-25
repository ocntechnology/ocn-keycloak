// Raw Entra ID token for a test user, via the test app's localhost:3000 redirect (code + PKCE + secret).
import { open, msLogin, shot, pw } from './drv.mjs';
import { createHash, randomBytes } from 'node:crypto';
const [upn, service, tenant = '335d5e4c-ad34-4cf1-ad38-6926f427a8e9'] = process.argv.slice(2);
const CLIENT = 'e39036e7-2905-4a0d-bff4-a5ba4731f909', RU = 'http://localhost:3000/sso/microsoft/consent';
const verifier = randomBytes(32).toString('base64url');
const u = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
Object.entries({ client_id: CLIENT, response_type: 'code', redirect_uri: RU, scope: 'openid email profile', state: 'x', nonce: 'n', prompt: 'login', code_challenge: createHash('sha256').update(verifier).digest('base64url'), code_challenge_method: 'S256' }).forEach(([k, v]) => u.searchParams.set(k, v));
const s = await open({ stopAt: (x) => x.startsWith(RU) });
await s.page.goto(u.toString()).catch(() => {});
const r = await msLogin(s, upn, pw(service), { name: `idt-${upn.split('@')[0]}` });
await s.browser.close();
if (!s.stopped) { console.log(JSON.stringify({ state: r.state, code: r.code, text: (r.text || '').slice(0, 500) })); process.exit(0); }
const back = new URL(s.stopped);
if (!back.searchParams.get('code')) { console.log(JSON.stringify(Object.fromEntries(back.searchParams))); process.exit(0); }
const res = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, { method: 'POST', body: new URLSearchParams({ client_id: CLIENT, client_secret: process.env.MS_CLIENT_SECRET, grant_type: 'authorization_code', code: back.searchParams.get('code'), redirect_uri: RU, code_verifier: verifier, scope: 'openid email profile' }) });
const j = await res.json();
if (!j.id_token) { console.log(JSON.stringify(j)); process.exit(0); }
const c = JSON.parse(Buffer.from(j.id_token.split('.')[1], 'base64url'));
console.log(JSON.stringify({ iss: c.iss, tid: c.tid, email: c.email, xms_edov: c.xms_edov, preferred_username: c.preferred_username, name: c.name, claims: Object.keys(c) }));
