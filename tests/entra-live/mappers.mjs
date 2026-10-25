import { admin } from '../integration/lib.mjs';
const A = 'ocntestcouncil-microsoft';
const have = await admin.get(`/identity-provider/instances/${A}/mappers`);
for (const claim of ['xms_edov', 'tid', 'oid', 'email', 'preferred_username', 'iss', 'amr', 'acr']) {
  const name = `test-claim-${claim}`;
  if (have.some((m) => m.name === name)) continue;
  await admin.post(`/identity-provider/instances/${A}/mappers`, { name, identityProviderAlias: A, identityProviderMapper: 'oidc-user-attribute-idp-mapper', config: { syncMode: 'FORCE', claim, 'user.attribute': `entra_${claim}` } });
}
console.log((await admin.get(`/identity-provider/instances/${A}/mappers`)).map((m) => m.name));
