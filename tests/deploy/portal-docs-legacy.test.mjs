// OCN Docs in DOCS_ADMIN_MODE=legacy (the live investor deck and signature tool) signs its admin
// in through the civicos-portal client. apply.mjs replaces a managed client's redirect URIs, so
// the Docs callback must be in the desired config, or the Docs admin sign-in breaks with
// "Invalid parameter: redirect_uri" the moment the realm is applied.
//   node --test tests/deploy/portal-docs-legacy.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { loadDesired } from '../../scripts/realm/lib.mjs';

for (const env of ['production', 'local']) {
  test(`${env}: civicos-portal keeps the Docs legacy admin callback`, () => {
    const { clients, vars } = loadDesired(env);
    const portal = clients.find((c) => c.clientId === 'civicos-portal');
    const docs = vars.docsUrl.replace(/\/$/, '');
    assert.ok(portal.redirectUris.includes(`${docs}/api/auth/callback/keycloak`), portal.redirectUris.join(', '));
    assert.ok(portal.redirectUris.includes(`${vars.portalUrl.replace(/\/$/, '')}/api/auth/callback/keycloak`));
    assert.ok(portal.redirectUris.every((u) => !u.includes('*')), 'no wildcards');
    assert.equal(portal.extraRedirectUris, undefined, 'the config key is not sent to Keycloak');
  });
}
