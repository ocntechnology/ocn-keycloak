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
- **OCN staff** hold the realm role `ocn-staff` (`ocn-admin` includes it): every staff sign-in
  that is not council SSO needs the authenticator app (set up on first use), so a staff session
  is always level 2. Products read it with `@civicos/auth`'s `isOcnStaff`.
- **Email is admin-only.** The user profile makes `email` editable by administrators only, so a
  person cannot change their own address through the account console or API (and so cannot move
  themselves into another organisation, or onto a personal domain). The first-sign-in page shows
  the email as text. If an administrator changes an address (it is then unverified), a password
  alone is not enough: the person must enter an email code first, and organisation membership
  is only given for a verified email. `verifyEmail` stays off: CivicOS verifies with its own codes.
- **Forgotten password** (`civicos-reset-credentials`, bound as the reset flow):
  1. `civicos-reset-identify` asks for the email and applies the sign-in routing: personal and
     unknown domains are refused, a disabled account is refused, and an organisation that
     requires SSO has no CivicOS password to reset. An unknown address is told "if there is an
     account, we sent a link" and nothing is sent. A reset email counts towards the address's
     email limit (below).
  2. `reset-credential-email` with `force-login: true` sends the link.
  3. When the link is used the flow runs again from the top, so the rules are checked again
     (the policy may have changed in between); the mailbox counts as checked.
  4. `reset-password` sets the new password. There is no `reset-otp` step, so an authenticator
     app is never removed by a reset.
  5. The person is not signed in: Keycloak shows "Your password has been changed" with a
     "Sign in" link back to the product, which starts the normal sign-in, so the second step,
     staff rules and SSO policy all apply. A reset never gives a session, let alone level 2.
- **Email-code limits per address** (Keycloak's single-use object store, shared across the
  cluster, never the authentication session; keys are a hash of realm and address):
  at most 3 codes per 15 minutes and 10 per day; 10 wrong codes for an address (with or without
  an account) lock it for 15 minutes; a new code never resets the wrong-code count, a right one
  does; the 30-second wait before "Send a new code" holds after a code is voided too. Realm
  attributes `civicos.codes.per15Minutes`, `.perDay`, `.wrongBeforeLock`, `.lockSeconds`.
  Support can lift the limits for one address:
  `POST /realms/ocn/civicos-admin/code-limits/reset {"email": "..."}` (needs `manage-users`).
- **Session rules at every token refresh** (client policy `civicos-session-rules`, condition
  `any-client`, executor in the extension, `realm/config/client-policies.json`). Products refresh
  every 5 minutes, so these take effect in every product within minutes. A refresh is refused
  (`invalid_grant`) and the Keycloak session ended when:
  (a) a council SSO session is older than `civicos.ssoSessionMaxSeconds` (43200, 12 hours);
  (b) the person's organisation now requires SSO and the session was not made by SSO;
  (c) a password or code session's last mailbox check (`civicosMailboxVerifiedAt`) is older than
  `civicos.mailboxMaxAgeSeconds` (2592000, 30 days).
  The browser sign-in applies the same rules when it re-uses a Keycloak session.
- **No password grants:** `admin-cli` in realm `ocn` has direct access grants off, and the
  realm's direct grant flow is `civicos-direct-grant-refused` (`civicos-refuse-password-grant`
  always answers `unauthorized_client`), so no client can get tokens with a password. Admin
  scripts use the master realm's admin or a service account. `drift.mjs` checks admin-cli too.
- **Stored events:** sign-in events (LOGIN, LOGIN_ERROR, RESET_PASSWORD, SEND_RESET_PASSWORD,
  UPDATE_PASSWORD, UPDATE_EMAIL, UPDATE_TOTP, REMOVE_TOTP, UPDATE/REMOVE_CREDENTIAL,
  CODE_TO_TOKEN, REFRESH_TOKEN_ERROR, DELETE_ACCOUNT, identity provider logins and their errors)
  and admin events are kept for 400 days (`eventsExpiration`, `adminEventsExpiration`). Every
  CivicOS sign-in event carries `civicos_method` and `civicos_level`; OCN staff sign-ins also
  carry `civicos_staff: true`. Read them in the admin console (Events) or
  `GET /admin/realms/ocn/events?type=LOGIN`.
- **Account erasure:** when an account is deleted (an administrator, or the person), the
  `civicos-erasure` event listener writes one row per product with a `civicos.erasure.url`
  attribute to `CIVICOS_ERASURE_OUTBOX` in Keycloak's database, in the deletion's own
  transaction. Each row is sent straight after the commit as a realm-signed `erasure_token`
  (RS256, the realm's published key; `aud` = the client, `sub` = the person, `email` = their
  address just before deletion, event `https://ocn.technology/events/account-erased`). A failure
  is retried by a timer (every 15 seconds it looks for due rows) with back-off: 1, 4, 16, 64
  minutes, then every 4 hours, for 25 hours (`civicos.erasure.retryBaseSeconds`, default 60). It
  survives restarts. A 2xx deletes the row; a 400, or running out of time, marks it failed and
  logs an ERROR starting `CivicOS erasure FAILED` (alert on that line).
  `GET /realms/ocn/civicos-erasure/pending` lists what is not delivered yet;
  `POST /realms/ocn/civicos-erasure/resend` (`scripts/erasure/resend.mjs`, with `--email` to
  put the address in the token) queues it again. Both need `manage-users`. The directory is a
  target too: client `civicos-directory` (confidential, no browser, password or service-account
  sign-in) points at the directory's `POST /api/auth/civicos/erase`.
- **Start-up SMTP check:** once Keycloak has started, the extension connects to every realm's
  SMTP server (and logs in when it uses authentication) without sending mail, and logs
  `CivicOS SMTP check: ...` or an ERROR `CivicOS SMTP check FAILED ...`.
- **Personal domains:** one list, `extension/src/main/resources/personal-email-domains.json`, a
  byte-identical copy of `packages/auth/src/personal-email-domains.json` in the civicos repo
  (exact domains plus anchored patterns). `node scripts/check-personal-domains.mjs` compares the
  two copies when the civicos checkout is present.
- New accounts get a random id: the `sub` is never the email address.

## Layout

| Path | What |
|---|---|
| `realm/config/settings.json` | Realm settings (theme, flows, password policy, brute force, sessions, organisations, acr map) |
| `realm/config/clients.json` | Product OIDC clients (code + PKCE, no direct grants, back-channel logout and erasure URLs on `backchannelUrl`) and the registry sync service account |
| `realm/config/roles.json` | Realm roles: `ocn-staff`, and `ocn-admin` including it |
| `realm/config/client-scopes.json` | `organization` scope: organisation claim and the `civicos_method` claim |
| `realm/config/flows.json` | `civicos-browser`, `civicos-first-broker-login`, `civicos-post-broker-login`, `civicos-reset-credentials`, `civicos-direct-grant-refused` (with execution config, such as `force-login`) |
| `realm/config/env/{local,production}.json` | Per-environment URLs and SMTP (production: the existing SES account in `eu-west-1`, from `admin@opencouncil.network`; an apply without `SMTP_USER`/`SMTP_PASSWORD` keeps the live realm's credentials, `mergeSmtpCredentials` in `scripts/realm/lib.mjs`) |
| `realm/config/env/local-seed.json` | Local only: organisations before the registry sync, test users, the staff test authenticator's secret, the fake council IdP and its host |
| `realm/civicos-password-blocklist.txt` | 515,983 common and breached passwords of 12 to 128 characters (NCSC top 100,000 plus the 10 million passwords list; see `civicos-password-blocklist.SOURCES.txt`), loaded once at start-up |
| `realm/config/client-policies.json` | Client policy `civicos-session-rules`: the session rules at every token refresh |
| `realm/ocn-realm.json` | The older sanitised production export, used only to create the local realm the first time |
| `scripts/realm/apply.mjs` | Apply `realm/config` to a Keycloak through the admin API (idempotent) |
| `scripts/realm/drift.mjs` | Compare a live realm with `realm/config` and check every client's rules; exit 2 on differences |
| `realm/config/drift-exceptions.json` | Exact wildcard redirects accepted on the legacy `cms` and `cms-admin` clients, with why; anything else still fails |
| `scripts/sso/connect-council.mjs` | Connect a council's Microsoft 365, Google Workspace or OIDC sign-in to its organisation |
| `scripts/erasure/resend.mjs` | Send an account-erasure notice again |
| `scripts/local/totp.mjs` | The local staff test authenticator's current code (`--base32` for an app) |
| `scripts/local-up.sh`, `scripts/local-down.sh` | Start and stop Mailpit and Keycloak locally |
| `extension/` | The Keycloak extension (Java 21, Maven): `CivicosSignInAuthenticator`, `CivicosResetAuthenticator`, `BrokerGuardAuthenticator`, `SsoCompleteAuthenticator`, `SessionRulesExecutor`, `CodeLimits`, `ErasureEventListener` and `ErasureOutbox` (JPA entity and Liquibase changelog), `ErasureResource`, `SupportResource`, `SmtpCheck` |
| `scripts/check-personal-domains.mjs` | Compare the personal-domain list with the civicos copy |
| `docs/cut-over-runbook.md` | Moving production to auth.ocn.technology |
| `.github/workflows/realm-drift.yml` | Nightly `drift.mjs` against production (needs secrets; see the runbook) |
| `docs/screenshots/` | The sign-in screens at 1440 and 390 wide |
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

The whole platform (Keycloak, Mailpit, directory, portal, Docs, Discuss, Groups) starts with
`~/Repositories/civicos-local/up.sh`. Locally the realm's `frontendUrl` is
http://auth.civicos.localhost:8180 and every product has its own `*.civicos.localhost` host, so
they are one site (silent sign-in in iframes) with separate cookies, as on `ocn.technology` in
production. Keycloak calls products back on `127.0.0.1` (`backchannelUrl` in
`realm/config/env/local.json`) because Java cannot resolve `*.localhost`; `sslRequired` is
`none` locally only.

Realm `council-sim` is a fake council identity provider for Kingston (`kingston.gov.uk`), on a
host of its own (http://sso.kingston.localhost:8180, like a council's Microsoft 365), linked to
Kingston's organisation as `kingston-sso`, so SSO available and SSO required can be tried end
to end.

OCN staff sign in locally with the test authenticator: `toby.abel@ocn.technology` has an OTP
credential with the known secret in `local-seed.json` (codes from `node scripts/local/totp.mjs`).

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
cd extension && mvn test                                              # 20 unit tests
node --test --test-concurrency=1 tests/integration/*.test.mjs         # 42 integration tests (local Keycloak)
node --test tests/deploy/*.test.mjs                                   # deploy workflow ships the JAR and the password blocklist
```

The integration tests drive the real login pages over HTTP (on the public hosts, through
`tests/integration/localhost-dns.cjs`), read codes from Mailpit's API, sign in through the fake
council IdP, sign staff in with the test authenticator, and catch an erasure notice with a
stand-in product. They change Kingston's and Hackney's policies and put them back, shorten the
`civicos.*` realm limits for a few seconds and put them back, and lift the email-code limits for
the addresses they use (run them under `~/Repositories/civicos-local/lib/locked.sh browser`, as
other suites share the test users and Mailpit). Files: `signin` (sign-in policy),
`email-locked` (ID-1), `reset` (ID-2), `code-limits` (ID-3), `clients-events` (ID-4, ID-7
client, ID-8), `refresh` (ID-5), `staff-erasure` (staff, erasure outbox).

Other test suites that send more than 3 email codes to one address in 15 minutes (or 10 in a
day) now hit the per-address limit. Lift it with the support endpoint above (as
`tests/integration/lib.mjs` `resetCodeLimits` does).

## Known trade-off: the identify step tells you whether an account exists

The email-first screen behaves differently for a disabled account, an account with a password,
and an address with no account (email code), and for an unregistered domain with or without an
invitation. That reveals whether an address has an account. CivicOS accepts this for now: a
uniform screen would mean always offering both "password" and "email me a code" and hiding why
sign-in is refused, which officers find confusing, and the email-code limits above now stop the
code-guessing it would help. The identify step is not rate-limited per IP inside Keycloak:
locally every request comes from 127.0.0.1, and in production the right place is the load
balancer or Cloud Armor (for example 60 identify requests per minute per IP on
`/realms/ocn/login-actions/authenticate`). Decision for Toby: accept, or ask for uniform screens.

## Architecture

```
product (Next.js + @civicos/auth) --code+PKCE--> Keycloak realm ocn
                                                  civicos-browser flow
                                                    civicos-sign-in authenticator
                                                      existing session? level, step-up, policy changes
                                                      email -> Organizations (domain, sharedDomains)
                                                      password | email code (SMTP) | redirect to council IdP
                                                      mailbox check, TOTP, acr level, code limits
                                                  civicos-reset-credentials flow
                                                    civicos-reset-identify, reset email (force login), new password
                                                  client policy civicos-session-rules (every refresh)
                                                  civicos-erasure listener -> CIVICOS_ERASURE_OUTBOX -> products, directory
                                                  council IdP (Entra / Google / OIDC)
                                                    civicos-first-broker-login: domain guard, create or link
                                                    civicos-post-broker-login: level 2, method sso
council registry (civicos directory) --sync (service account)--> Keycloak Organizations
```
