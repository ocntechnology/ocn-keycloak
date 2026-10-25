# CivicOS identity platform: how it works

This repository holds the CivicOS sign-in service: the Keycloak realm `ocn` as code, the
"CivicOS sign-in policy" Keycloak extension, the OCN login theme, and the scripts that run the
whole platform locally. The product side (council registry, `@civicos/auth`, the portal's
Sign-in settings) lives in the `civicos` monorepo: see its `docs/identity.md`.

## What it does

- **Email first.** One sign-in page for every product. The email domain picks the
  organisation (Keycloak Organizations, kept in step with the council registry) and its policy.
- **Three ways in:** password, a six-digit code by email (10 minutes, 5 attempts), or the
  council's own SSO. Personal email domains are refused. Unregistered work domains get in only
  if invited.
- **Council policy:** `open`, `sso_available` (SSO offered first) or `sso_required` (SSO only),
  plus `requireSecondFactor` for password sign-ins.
- **30-day mailbox check** for password sign-ins (attribute `civicosMailboxVerifiedAt`).
- **Assurance level** in `acr`: 1 for password or code, 2 for SSO or a second step; step-up
  when a client asks for `acr_values=2`. Method in `civicos_method`, organisation in `organization`.
- **OCN's floor:** 12-character passwords, not the email or username, blocklist of common and
  breached passwords, 10 failures lock for 15 minutes, no forced expiry.

## Layout

| Path | What |
|---|---|
| `realm/config/settings.json` | Realm settings (theme, flows, password policy, brute force, sessions, organisations, acr map) |
| `realm/config/clients.json` | Product OIDC clients (code + PKCE, no direct grants, back-channel logout) and the registry sync service account |
| `realm/config/client-scopes.json` | `organization` scope: organisation claim and the `civicos_method` claim |
| `realm/config/flows.json` | `civicos-browser`, `civicos-first-broker-login`, `civicos-post-broker-login` |
| `realm/config/env/{local,production}.json` | Per-environment URLs and SMTP |
| `realm/config/env/local-seed.json` | Local only: organisations before the registry sync, test users, the fake council IdP |
| `realm/civicos-password-blocklist.txt` | Common and breached passwords of 12+ characters (NCSC top 100,000) |
| `realm/ocn-realm.json` | The older sanitised production export, used only to create the local realm the first time |
| `scripts/realm/apply.mjs` | Apply `realm/config` to a Keycloak through the admin API (idempotent) |
| `scripts/realm/drift.mjs` | Compare a live realm with `realm/config` and check every client's rules; exit 2 on differences |
| `scripts/sso/connect-council.mjs` | Connect a council's Microsoft 365, Google Workspace or OIDC sign-in to its organisation |
| `scripts/local-up.sh`, `scripts/local-down.sh` | Start and stop Mailpit and Keycloak locally |
| `extension/` | The Keycloak extension (Java 21, Maven): `CivicosSignInAuthenticator`, `BrokerGuardAuthenticator`, `SsoCompleteAuthenticator` |
| `themes/.../theme/ocn/login/civicos-*.ftl` | The extension's screens in the OCN login theme, with `messages/messages_en.properties` |
| `tests/integration/` | Integration tests against the local Keycloak |

## Run it locally

```bash
scripts/local-up.sh              # Mailpit, Postgres db keycloak_local, Keycloak 26.4.7 on :8180, realm, seed
scripts/local-up.sh --rebuild    # rebuild the extension JAR and restart Keycloak
scripts/local-down.sh            # stop Keycloak and Mailpit (data stays in Postgres)
```

It uses Keycloak from `~/Repositories/ocn-keycloak/keycloak-dev` (`KC_HOME`), Java 21 from
Homebrew, and writes `~/Repositories/ocn-keycloak/local/` (`LOCAL_DIR`): `STATUS.md` (URLs,
clients, users), `clients.env` (client secrets, never committed) and `keycloak.log`. The admin
console is http://localhost:8180/admin (admin / admin), Mailpit http://localhost:8025.

Realm `council-sim` is a fake council identity provider for Kingston (`kingston.gov.uk`),
linked to Kingston's organisation as `kingston-sso`, so SSO available and SSO required can be
tried end to end.

## Apply to another Keycloak

```bash
KC_SERVER=https://auth.ocn.technology KC_ADMIN_CLIENT_ID=... KC_ADMIN_CLIENT_SECRET=... \
  node scripts/realm/apply.mjs --env production
node scripts/realm/drift.mjs --env production      # nightly: exit 2 means the live realm drifted
```

`apply.mjs` builds a changed flow under a temporary alias and swaps it in, so the realm never
points at a half-built flow. It never prints or commits secrets. The deploy workflow builds
the extension (running its unit tests) into `providers/`; the JAR changes nothing until the
realm config is applied.

## Tests

```bash
cd extension && mvn test                                              # 11 unit tests
node --test --test-concurrency=1 tests/integration/signin.test.mjs    # 16 integration tests (local Keycloak)
```

The integration tests drive the real login pages over HTTP, read codes from Mailpit's API,
and sign in through the fake council IdP. They change Kingston's and Hackney's policies and
put them back.

## Architecture

```
product (Next.js + @civicos/auth) --code+PKCE--> Keycloak realm ocn
                                                  civicos-browser flow
                                                    civicos-sign-in authenticator
                                                      existing session? level, step-up, policy changes
                                                      email -> Organizations (domain, sharedDomains)
                                                      password | email code (SMTP) | redirect to council IdP
                                                      mailbox check, TOTP, acr level
                                                  council IdP (Entra / Google / OIDC)
                                                    civicos-first-broker-login: domain guard, create or link
                                                    civicos-post-broker-login: level 2, method sso
council registry (civicos directory) --sync (service account)--> Keycloak Organizations
```
