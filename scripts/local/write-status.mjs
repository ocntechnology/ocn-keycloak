#!/usr/bin/env node
// Write $LOCAL_DIR/STATUS.md: what is running locally and how to use it.
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { CONFIG, readJson } from '../realm/lib.mjs';

const dir = process.argv[2];
const seed = readJson(join(CONFIG, 'env', 'local-seed.json'));
const env = readJson(join(CONFIG, 'env', 'local.json'));
const clients = readJson(join(CONFIG, 'clients.json'));
const secretsFile = join(dir, 'clients.env');
const secrets = existsSync(secretsFile) ? readFileSync(secretsFile, 'utf8') : '';
const extension = existsSync(join(process.env.KC_HOME || `${process.env.HOME}/Repositories/ocn-keycloak/keycloak-dev`, 'providers', 'civicos-signin-policy.jar'));
const shaFile = join(dir, 'civicos-sha.txt');
const sha = existsSync(shaFile) ? readFileSync(shaFile, 'utf8').trim() : '(not pushed yet)';
const server = (env.frontendUrl || process.env.KC_SERVER || 'http://localhost:8180').replace(/\/$/, '');
const sim = (seed.councilSim.frontendUrl || server).replace(/\/$/, '');

const rows = clients.products.map((p) => {
  const url = p.url.replace(/\{\{(\w+)\}\}/g, (_, k) => env[k]);
  const key = `${p.clientId.toUpperCase().replace(/[^A-Z0-9]/g, '_')}_CLIENT_SECRET`;
  return `| \`${p.clientId}\` | ${url} | \`${url}/api/auth/callback/keycloak\` | \`${key}\` |`;
});

const md = `# Local CivicOS identity platform: status

Updated ${new Date().toISOString()} by \`ocn-keycloak/scripts/local-up.sh\` (branch \`feat/identity-platform\`, worktree \`~/Repositories/ocn-keycloak-identity\`).

Keycloak and Mailpit are shared by every local agent. **Do not start your own Keycloak.** If it is down, run the start command below, or start the whole platform with \`~/Repositories/civicos-local/up.sh\`.

**Hostnames.** Every product has its own host under \`civicos.localhost\`, like \`*.ocn.technology\` in production: separate cookies per product (no collisions, no HTTP 431), and one site, so silent sign-in inside iframes works. Chromium and Firefox resolve \`*.localhost\` to 127.0.0.1 by themselves; Node does not on macOS, so start Node with \`NODE_OPTIONS="--require $HOME/Repositories/civicos-local/lib/localhost-dns.cjs"\` (the civicos-local scripts do). Keycloak still answers on http://localhost:8180 for admin scripts.

## Services

| Service | URL |
|---|---|
| Keycloak (realm \`ocn\`) | ${server}/realms/ocn |
| OIDC issuer | \`${server}/realms/ocn\` |
| OIDC discovery | ${server}/realms/ocn/.well-known/openid-configuration |
| Keycloak admin console | ${server}/admin/ (user \`admin\`, password \`admin\`) |
| Fake council IdP (realm \`council-sim\`, acts as Kingston's Microsoft 365, on a host of its own) | ${sim}/realms/council-sim |
| Mailpit web UI / API | http://localhost:8025 (API: http://localhost:8025/api/v1/messages) |
| Mailpit SMTP | localhost:1025 (no auth, no TLS) |
| Postgres database | \`keycloak_local\` on postgresql://toby@localhost:5432 |
| Council directory and registry (civicos \`apps/directory\`, worktree \`~/Repositories/civicos-identity\`) | ${env.directoryUrl} (when running) |
| Portal (civicos \`apps/portal\`, Sign-in settings at /settings/sign-in) | ${env.portalUrl} (when running; 3110 is taken on this Mac) |

CivicOS sign-in policy extension installed: **${extension ? 'yes' : 'not yet (stock Keycloak password form for now)'}**.

## OIDC clients (realm \`ocn\`)

All are confidential clients: authorization code + PKCE (S256), direct access grants **off**, back-channel logout to \`<server>/api/auth/civicos/backchannel-logout\` and account erasure to \`<server>/api/auth/civicos/erase\` (\`<server>\` is http://127.0.0.1:<port> locally: Keycloak's Java cannot resolve \`*.localhost\`). Default scopes include \`organization\` (claim \`organization\`: the person's organisation slugs) and \`acr\` (claim \`acr\`: \`"1"\` or \`"2"\`).

| Client | Local URL | Redirect URI | Secret variable in \`clients.env\` |
|---|---|---|---|
${rows.join('\n')}

Secrets: \`${secretsFile}\` (gitignored). Auth.js settings: \`AUTH_KEYCLOAK_ID=<client>\`, \`AUTH_KEYCLOAK_SECRET=<secret>\`, \`AUTH_KEYCLOAK_ISSUER=${server}/realms/ocn\`.

## Test users (realm \`ocn\`)

Password for all: \`${seed.password}\` (email codes arrive in Mailpit).

| Email | Organisation (slug) | Notes |
|---|---|---|
${seed.users.map((u) => `| ${u.email} | ${u.org || 'shared domain: richmond or wandsworth'} | ${(u.realmRoles || []).includes('ocn-admin') ? 'OCN staff: realm role \`ocn-admin\` (includes \`ocn-staff\`), authenticator app set up (see below)' : ''} |`).join('\n')}

### Signing in as OCN staff

OCN staff (realm role \`ocn-staff\`, included in \`ocn-admin\`) must use an authenticator app: after the password or email code, Keycloak asks for the six-digit code, and a staff session is always level 2. Staff without one are made to set one up. Locally, \`toby.abel@ocn.technology\` has a test authenticator with a known secret:

- secret (raw, as Keycloak stores it): \`${seed.staffTotp.secret}\`; for an authenticator app (base32): \`node ~/Repositories/ocn-keycloak-identity/scripts/local/totp.mjs --base32\`
- current code: \`node ~/Repositories/ocn-keycloak-identity/scripts/local/totp.mjs\`
- in tests: \`import { totp } from "<ocn-keycloak-identity>/scripts/local/totp.mjs"\` (TOTP, SHA-1, 6 digits, 30 seconds, key = the raw secret's UTF-8 bytes)

So tests sign staff in the real way (password, then the code) rather than working round the second step.

Organisations (Keycloak Organizations, synced from the council registry): ${seed.organisations.map((o) => `\`${o.alias}\``).join(', ')}, plus every UK principal council once the registry sync has run. Kingston has SSO connected to the fake council IdP (users \`officer\` / \`newstarter\`, same password) and policy \`sso_available\` by default.

## @civicos/auth

Pin to the \`civicos\` repo branch \`feat/identity-platform\`, commit **${sha}**:

\`\`\`json
"@civicos/auth": "https://github.com/ocntechnology/civicos.git#${sha}&path:/packages/auth"
\`\`\`

Wiring (see \`packages/auth/src/next.ts\` and \`docs/identity.md\` in that commit):

\`\`\`ts
// auth.ts
import NextAuth from "next-auth";
import { civicosAuthConfig } from "@civicos/auth/next";
export const { handlers, auth, signIn, signOut } = NextAuth(civicosAuthConfig());

// app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/auth";
export const { GET, POST } = handlers;

// app/api/auth/civicos/[action]/route.ts: step-up, silent sign-in for iframes, back-channel logout
import { createCivicosAuthRoutes } from "@civicos/auth/next";
import { signIn } from "@/auth";
export const { GET, POST } = createCivicosAuthRoutes({ signIn });
\`\`\`

- \`civicosSession(await auth())\` gives \`{ sub, email, name, level, method, organisation, organisations, roles }\` or null (signed out, or the Keycloak session ended).
- \`requireLevel(session, 2, { signIn, returnTo })\` steps the person up (Keycloak \`acr_values=2\`).
- Embedded iframe: send a signed-out request to \`/api/auth/civicos/silent?returnTo=/embed/...\` (prompt=none; falls back to a sign-in button that opens a popup).
- Env: \`AUTH_KEYCLOAK_ISSUER=${server}/realms/ocn\`, \`AUTH_KEYCLOAK_ID\`, \`AUTH_KEYCLOAK_SECRET\`, \`AUTH_SECRET\`.
- CI: \`assertConformance(process.cwd())\` from \`@civicos/auth/conformance\`.
- Cookies are named after the client id by default (\`civicos-groups.session-token\` …): no \`overrides.cookies\` needed.
- OCN staff: \`isOcnStaff(civicosSession(session))\` (role \`ocn-staff\` at level 2). Never a product list of staff emails or roles.
- Embedded products: pass \`embed: { hostOrigins, page: "/embed/sign-in" }\` to both \`civicosAuthConfig\` and \`createCivicosAuthRoutes\`, and render \`<CivicosEmbedSignIn>\` (\`@civicos/auth/embed\`) on that page. It posts \`{ source: "civicos-auth", type: "signin-required" }\` to the host and offers a popup and a full-tab sign-in that returns to the host page (\`silentSignInPath(returnTo, hostReturn)\`).
- Account erasure: pass \`onErase: async ({ sub }) => …\` to \`createCivicosAuthRoutes\`; Keycloak posts a signed \`erasure_token\` to \`/api/auth/civicos/erase\` when an account is deleted.
- More than one instance: \`createSqlLogoutStore(exec)\` for back-channel logouts, passed as \`logoutStore\` to both.

## Directory (council registry) for products

Directory URL: ${env.directoryUrl}. Local directory tokens (\`Authorization: Bearer <token>\`): \`local-groups-token\`, \`local-discuss-token\`, \`local-docs-token\` (write scope), \`local-portal-token\` (admin).

- \`GET /api/registry/lookup?email=<email>\`: the organisation(s) for an email, \`personal: true\` for Gmail and the like.
- \`GET /api/registry/organisations?q=\`: search councils and organisations (382 UK councils plus OCN, LGA, London Councils, GLA).
- \`POST /api/sign-in\` \`{ sub, email, emailVerified, name }\`: record a sign-in; creates the person and a basic membership the first time.

## Start and stop

\`\`\`bash
~/Repositories/ocn-keycloak-identity/scripts/local-up.sh            # start or refresh (idempotent)
~/Repositories/ocn-keycloak-identity/scripts/local-up.sh --rebuild  # rebuild the extension and restart Keycloak
~/Repositories/ocn-keycloak-identity/scripts/local-down.sh          # stop Keycloak and Mailpit
tail -f ${join(dir, 'keycloak.log')}                                 # Keycloak log
\`\`\`
`;
writeFileSync(join(dir, 'STATUS.md'), md);
console.log(`wrote ${join(dir, 'STATUS.md')}`);
