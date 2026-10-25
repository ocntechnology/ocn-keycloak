// E8: end a person's sessions in Keycloak; refresh refused at once; silent sign-in refused; next visit.
import { signIn, refresh } from './kc.mjs';
import { admin, userByEmail } from '../integration/lib.mjs';
const upn = 'editor1@ocntestcouncil.onmicrosoft.com';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const { result: r1, s } = await signIn({ name: 'e8-1', email: upn, service: 'entra-testcouncil-editor1', keep: true });
log('signed in', !!r1.stopped);
log('refresh before', (await refresh(r1.refresh_token)).status);
const u = await userByEmail(upn);
log('sessions before', (await admin.get(`/users/${u.id}/sessions`)).length);
await admin.post(`/users/${u.id}/logout`);
log('sessions after', (await admin.get(`/users/${u.id}/sessions`)).length);
const after = await refresh(r1.refresh_token);
log('refresh after', after.status, after.json.error);
const silent = await signIn({ name: 'e8-silent', email: upn, service: null, session: s, keep: true, extra: { prompt: 'none' } });
log('silent', silent.result.stopped);
// Next visit without removal in Entra: does Microsoft sign them straight back in (no password)?
const again = await signIn({ name: 'e8-again', email: upn, service: null, session: s, keep: true });
log('next visit', !!again.result.stopped, JSON.stringify(again.result.steps.map((x) => x.slice(0, 3))));
await s.browser.close();
