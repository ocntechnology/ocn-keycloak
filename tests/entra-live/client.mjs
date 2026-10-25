import { admin, org } from '../integration/lib.mjs';
import { OUT } from './drv.mjs';
import { writeFileSync } from 'node:fs';
const ID = 'entra-test-local';
const portal = (await admin.get('/clients?clientId=civicos-portal'))[0];
let c = (await admin.get(`/clients?clientId=${ID}`))[0];
const rep = { clientId: ID, name: 'Entra SSO test (local, temporary)', enabled: true, protocol: 'openid-connect', publicClient: false,
  standardFlowEnabled: true, directAccessGrantsEnabled: false, redirectUris: ['http://localhost:9911/cb'], webOrigins: [],
  attributes: { 'pkce.code.challenge.method': 'S256', 'post.logout.redirect.uris': 'http://localhost:9911/*' },
  defaultClientScopes: portal.defaultClientScopes, optionalClientScopes: portal.optionalClientScopes, protocolMappers: (portal.protocolMappers||[]).map(({id, ...m}) => m) };
if (!c) await admin.post('/clients', rep); else await admin.put(`/clients/${c.id}`, { ...c, ...rep });
c = (await admin.get(`/clients?clientId=${ID}`))[0];
const secret = (await admin.get(`/clients/${c.id}/client-secret`)).value;
writeFileSync(`${OUT}/client.env`, `ENTRA_TEST_CLIENT_SECRET=${secret}\n`);
const o = await org('ocntestcouncil');
await admin.put(`/organizations/${o.id}`, { ...o, name: 'OCN Test Council' });
console.log('ok', c.id, 'portal scopes', portal.defaultClientScopes, 'mappers', (portal.protocolMappers||[]).map(m=>m.name));
