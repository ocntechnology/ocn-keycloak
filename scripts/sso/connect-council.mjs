#!/usr/bin/env node
// Connect a council's own sign-in (SSO) to its Keycloak organisation.
//
//   Microsoft 365 (one multi-tenant "CivicOS" app in OCN's Entra; the council's IT admin has
//   granted admin consent; we pin the council's tenant so no other tenant is accepted):
//     MS_CLIENT_ID=... MS_CLIENT_SECRET=... node scripts/sso/connect-council.mjs --org kingston \
//       --provider microsoft --tenant <council tenant id (GUID)>
//
//   Google Workspace (one OCN Google OAuth client; restricted to the council's Workspace domain):
//     GOOGLE_CLIENT_ID=... GOOGLE_CLIENT_SECRET=... node scripts/sso/connect-council.mjs --org hackney \
//       --provider google --hosted-domain hackney.gov.uk
//
//   Any OIDC provider (the council's own, or the local fake council IdP):
//     node scripts/sso/connect-council.mjs --org kingston --provider oidc --issuer https://... \
//       --client-id ... --client-secret ...
//
// Options: --alias (default <org>-<provider>), --display-name, --dry-run (print, change nothing).
// Then record it in the council registry (directory): set the organisation's `sso` field to
// { provider, idpAlias, tenantId|hostedDomain, displayName }, and run the registry sync, which
// links the IdP to the organisation and reports it as connected. The council's administrator can
// then choose "SSO available" or "SSO required" in the portal.
//
// Safety: trustEmail is on (needed to link by verified email), but the CivicOS broker guard only
// accepts emails at the organisation's own domains, and Microsoft's tenant-specific endpoints
// refuse sign-ins from any other tenant. Google's `hd` is checked by Keycloak's Google provider.

import { Admin, parseArgs } from '../realm/lib.mjs';

const a = parseArgs(process.argv.slice(2));
if (!a.org || !a.provider) {
  console.error('usage: connect-council.mjs --org <slug> --provider microsoft|google|oidc [...]');
  process.exit(2);
}
const kc = Admin.fromEnv(a.realm);
const alias = a.alias || `${a.org}-${a.provider}`;

async function orgByAlias(slug) {
  return ((await kc.get('/organizations?first=0&max=100000&briefRepresentation=false')) || []).find((o) => o.alias === slug) || null;
}

function representation(org) {
  const common = {
    alias,
    enabled: true,
    trustEmail: true,
    storeToken: false,
    hideOnLogin: true,
    firstBrokerLoginFlowAlias: 'civicos-first-broker-login',
    postBrokerLoginFlowAlias: 'civicos-post-broker-login',
    config: {
      syncMode: 'IMPORT',
      loginHint: 'true',
      'kc.org.domain': (org.domains || [])[0]?.name || '',
      'kc.org.broker.redirect.mode.email-matches': 'true',
    },
  };
  if (a.provider === 'microsoft') {
    if (!a.tenant || !/^[0-9a-f-]{36}$/i.test(a.tenant)) throw new Error('--tenant <GUID> is required for microsoft (never "common" or "organizations")');
    const base = `https://login.microsoftonline.com/${a.tenant}`;
    return {
      ...common,
      providerId: 'oidc',
      displayName: a['display-name'] || `${org.name} (Microsoft 365)`,
      config: {
        ...common.config,
        issuer: `${base}/v2.0`,
        authorizationUrl: `${base}/oauth2/v2.0/authorize`,
        tokenUrl: `${base}/oauth2/v2.0/token`,
        jwksUrl: `${base}/discovery/v2.0/keys`,
        logoutUrl: `${base}/oauth2/v2.0/logout`,
        useJwksUrl: 'true',
        validateSignature: 'true',
        clientId: process.env.MS_CLIENT_ID || '${MS_CLIENT_ID}',
        clientSecret: process.env.MS_CLIENT_SECRET || '${MS_CLIENT_SECRET}',
        clientAuthMethod: 'client_secret_post',
        defaultScope: 'openid email profile',
        pkceEnabled: 'true',
        pkceMethod: 'S256',
        'civicos.provider': 'microsoft',
        'civicos.tenantId': a.tenant,
      },
    };
  }
  if (a.provider === 'google') {
    if (!a['hosted-domain']) throw new Error('--hosted-domain is required for google');
    return {
      ...common,
      providerId: 'google',
      displayName: a['display-name'] || `${org.name} (Google Workspace)`,
      config: {
        ...common.config,
        clientId: process.env.GOOGLE_CLIENT_ID || '${GOOGLE_CLIENT_ID}',
        clientSecret: process.env.GOOGLE_CLIENT_SECRET || '${GOOGLE_CLIENT_SECRET}',
        hostedDomain: a['hosted-domain'],
        defaultScope: 'openid email profile',
        'civicos.provider': 'google',
      },
    };
  }
  if (a.provider === 'oidc') {
    if (!a.issuer || !a['client-id']) throw new Error('--issuer and --client-id are required for oidc');
    const base = `${a.issuer.replace(/\/$/, '')}/protocol/openid-connect`;
    return {
      ...common,
      providerId: 'oidc',
      displayName: a['display-name'] || `${org.name} sign-in`,
      config: {
        ...common.config,
        issuer: a.issuer,
        authorizationUrl: a['authorization-url'] || `${base}/auth`,
        tokenUrl: a['token-url'] || `${base}/token`,
        jwksUrl: a['jwks-url'] || `${base}/certs`,
        useJwksUrl: 'true',
        validateSignature: 'true',
        clientId: a['client-id'],
        clientSecret: a['client-secret'] || '',
        clientAuthMethod: 'client_secret_post',
        defaultScope: 'openid email profile',
        pkceEnabled: 'true',
        pkceMethod: 'S256',
        'civicos.provider': 'oidc',
      },
    };
  }
  throw new Error(`unknown provider ${a.provider}`);
}

async function main() {
  const org = await orgByAlias(a.org);
  if (!org) throw new Error(`no Keycloak organisation ${a.org}: run the registry sync first`);
  const rep = representation(org);
  if (a['dry-run']) {
    const shown = structuredClone(rep);
    if (shown.config.clientSecret) shown.config.clientSecret = '***';
    console.log(JSON.stringify(shown, null, 2));
    return;
  }
  const live = await kc.get(`/identity-provider/instances/${encodeURIComponent(alias)}`, { allow404: true });
  if (live) await kc.put(`/identity-provider/instances/${encodeURIComponent(alias)}`, { ...live, ...rep, config: { ...live.config, ...rep.config } });
  else await kc.post('/identity-provider/instances', rep);
  const linked = (await kc.get(`/organizations/${org.id}/identity-providers`)) || [];
  if (!linked.some((l) => l.alias === alias)) await kc.req('POST', kc.r(`/organizations/${org.id}/identity-providers`), JSON.stringify(alias));
  console.log(`connected ${alias} to ${a.org}. Now record it in the registry:`);
  console.log(JSON.stringify({ provider: a.provider, idpAlias: alias, tenantId: a.tenant, hostedDomain: a['hosted-domain'], displayName: rep.displayName }));
}

main().catch((e) => { console.error(e.message); process.exit(1); });
