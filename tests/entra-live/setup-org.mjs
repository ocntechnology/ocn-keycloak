import { ensureOrg, org } from '../integration/lib.mjs';
const o = await ensureOrg('ocntestcouncil', 'ocntestcouncil.onmicrosoft.com', { signInPolicy: 'sso_available', customer: 'true' });
console.log(JSON.stringify({ id: o.id, alias: o.alias, domains: o.domains, attributes: o.attributes }));
