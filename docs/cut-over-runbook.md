# Cut-over runbook: CivicOS sign-in on auth.ocn.technology

How to move production realm `ocn` from `idp.opencouncil.network` to `auth.ocn.technology` and
switch on the CivicOS sign-in policy, without breaking the products that use the realm today
(`cms`, `cms-admin`, `ocn-constitution-admin`, `civicos-committee`). Nothing here has been run.
Every production step needs Toby's go-ahead.

## Why it needs care

- The issuer (`iss`) of every token comes from the realm's `frontendUrl` when it is set, and
  otherwise from the host the request arrived on (Keycloak runs with no fixed `hostname` during
  the move). Setting `frontendUrl` to `https://auth.ocn.technology` changes the issuer for
  **every** client in the realm at once, so a product that still expects
  `https://idp.opencouncil.network/realms/ocn` would refuse the new tokens. That is why
  `realm/config/env/production.json` leaves `frontendUrl` empty until step F1 of the release.
- The realm configuration refers to authenticators, a client policy executor and a JPA table
  that only exist once the extension JAR is deployed. Applying the realm before the JAR (or
  deploying a JAR the realm does not match) can leave the realm pointing at a flow or executor
  that is not there.

## Before the day

1. **SMTP (interim: the existing SES account).** Until AWS grants SES production access in
   OCN's own account, mail keeps going through the SES account the live realm uses today:
   `email-smtp.eu-west-1.amazonaws.com`, implicit TLS on 465 (`ssl` true, `starttls` false), from
   `admin@opencouncil.network` (verified in that account; `ocn.technology` may not be), shown as
   "CivicOS". **Run the interim apply WITHOUT `SMTP_USER` / `SMTP_PASSWORD`** (unset or empty):
   `apply.mjs` then keeps the user and password the live realm
   already stores (it sends back the live user and the masked password, which Keycloak reads as
   "keep the stored one"; checked on Keycloak 26.4 by sending through a probe server) and logs
   `SMTP user and password: not set for this apply, keeping the live realm's`. Setting them
   replaces the live credentials. After the deploy, the Keycloak log must show
   `CivicOS SMTP check: realm ocn can reach email-smtp.eu-west-1.amazonaws.com:465 and log in`;
   an ERROR `CivicOS SMTP check FAILED` means codes and reset links will not be sent. The later
   move to OCN's account (`eu-west-2`, `no-reply@ocn.technology`) needs new SMTP credentials
   created in that region, set as `SMTP_USER` / `SMTP_PASSWORD` for that apply.
2. **Admin service account** for `apply.mjs` and `drift.mjs`: client `civicos-realm-admin` in
   `clients.json` (client credentials, realm-management `realm-admin`). The first production apply
   runs with the master admin (`KEYCLOAK_ADMIN` / `KEYCLOAK_ADMIN_PASSWORD`), creates it and, with
   `--secrets-out`, writes `CIVICOS_REALM_ADMIN_CLIENT_SECRET`; store that as
   `KC_ADMIN_CLIENT_SECRET` (and `KC_ADMIN_CLIENT_ID=civicos-realm-admin`, `KC_SERVER`) on
   ocn-keycloak for the nightly drift job and later applies. Do not use password grants (they are refused in realm `ocn`
   once the realm config is applied).
3. **DNS and TLS** for `auth.ocn.technology` pointing at the same Keycloak as
   `idp.opencouncil.network` (the Google Cloud HTTPS load balancer in front of the `keycloak` VM).
4. **Load balancer host allowlist (a prerequisite of the hostname change, step 5).** With no fixed
   hostname, Keycloak builds the issuer, every link in its emails (required actions, password
   reset), the sign-in form's address, redirects and the issuer of erasure and back-channel
   logout tokens from the request's `Host` header, **and from a client-supplied
   `X-Forwarded-Host` or `X-Forwarded-Port`** (`proxy-headers=xforwarded` trusts them). Tested
   on a local Keycloak 26.4.7 with this repo's conf: `Host: evil.example` gave issuer
   `https://evil.example/realms/ocn`, a sign-in form posting to `https://evil.example`, and a
   required-actions email whose link was `https://evil.example/...`; `Host: auth.ocn.technology`
   with `X-Forwarded-Host: evil.example` gave the same; `X-Forwarded-Port: 8443` gave
   `https://auth.ocn.technology:8443/realms/ocn`. Today the URL map `cr-url-map-keycloak` has no
   host rules and Google's load balancer passes the client's `X-Forwarded-Host` through, so before
   the template change is deployed:
   - only `idp.opencouncil.network` and `auth.ocn.technology` reach the Keycloak backend; any
     other host gets a redirect or 404 at the load balancer;
   - the load balancer removes any client-sent `X-Forwarded-Host` and `X-Forwarded-Port` (URL map
     `headerAction.requestHeadersToRemove`, or the equivalent for this load balancer type);
   - the VM's port 8080 is reachable only from the load balancer (Google's ranges
     `130.211.0.0/22` and `35.191.0.0/16`), not from the internet, so nobody can skip the
     load balancer.
   Check from outside, after the load balancer change and again after the deploy (each must show
   the honest issuer or be refused):
   ```bash
   curl -s https://idp.opencouncil.network/realms/ocn/.well-known/openid-configuration | jq -r .issuer
   curl -s https://auth.ocn.technology/realms/ocn/.well-known/openid-configuration | jq -r .issuer
   curl -s -H 'Host: evil.example' https://idp.opencouncil.network/realms/ocn/.well-known/openid-configuration -o /dev/null -w '%{http_code} %{redirect_url}\n'   # not 200
   curl -s -H 'X-Forwarded-Host: evil.example' https://auth.ocn.technology/realms/ocn/.well-known/openid-configuration | jq -r .issuer
   curl -s -H 'X-Forwarded-Port: 8443' https://auth.ocn.technology/realms/ocn/.well-known/openid-configuration | jq -r .issuer
   ```
   Keycloak 26.4 itself has no list of allowed hostnames: `hostname-strict=false` accepts any
   host, and `hostname-backchannel-dynamic` only applies when a fixed `hostname` is set. The
   allowlist stops being load-bearing at step F1, when a fixed hostname
   (`hostname=https://auth.ocn.technology`) goes back into the template and `frontendUrl` is set;
   keep the load balancer rules anyway.
5. **Hostname change, deployed on its own (release step A3).** `deploy/keycloak.conf.template`
   no longer fixes `hostname` (it was `hostname={{ IDP_DOMAIN }}`, which fixed the issuer to
   `idp.opencouncil.network` whatever host a request arrived on); it sets
   `hostname-strict=false` and keeps `proxy-headers=xforwarded`, so each request gets the issuer
   of the host it arrived on while `frontendUrl` is empty. `deploy-gcp.yml` still substitutes
   `{{ IDP_DOMAIN }}`, which is simply absent from the template until F1. After the deploy, the
   checks in step 4 show `https://idp.opencouncil.network/realms/ocn` on the old host and
   `https://auth.ocn.technology/realms/ocn` on the new one. Tested locally (Keycloak 26.4.7 in
   production mode with the rendered template, production-shaped realm, `apply.mjs --env
   production`): a sign-in through each host got an ID, access and refresh token whose `iss` is
   that host; userinfo and refresh work on the same host and are refused on the other
   (`401`, `Invalid token issuer`); the `cms` client signed in through `idp.opencouncil.network`
   with issuer `https://idp.opencouncil.network/realms/ocn` after the apply; `drift.mjs --env
   production` is clean. Nothing that runs outside a request builds a URL: the erasure outbox
   takes its issuer from the request that deleted the account and stores it, and the timer and
   the start-up SMTP check build none, so nothing came out as `localhost`.
6. **What both hostnames mean for products during the move.**
   - A product must use one host for everything (browser sign-in, token, refresh, userinfo,
     JWKS): a token from one host is refused on the other.
   - Moving a product's issuer from the old host to the new one signs its users out: their next
     refresh is refused, and the new host has its own sign-in cookie, so they sign in again.
     Single sign-on only works between products on the same host.
   - Erasure and back-channel logout tokens carry the issuer of the host the deletion or
     sign-out request came through. Products check it (`@civicos/auth` `createErasureHandler`),
     so delete accounts (admin console or admin API) through `https://auth.ocn.technology`,
     the host the erasure receivers (Docs, Groups, Discuss, directory) use; a notice a product
     refuses is logged as `CivicOS erasure FAILED` and can be resent with
     `scripts/erasure/resend.mjs`.
7. **List every client and who owns it**: `cms`, `cms-admin`, `ocn-constitution-admin`,
   `civicos-committee`, then the CivicOS products. For each, note the issuer and redirect URIs
   it is configured with today.
8. **`ocn-constitution-admin` and `cms` (release step A4, Toby approves).** These clients belong
   to other repos, so `apply.mjs` never edits them. `ocn-constitution-admin` (the public
   constitution site's admin sign-in, ocn-constitution `auth_service.py`: code + PKCE + userinfo)
   has implicit flow, direct access grants and the `cms.opencouncil.network` and wildcard
   `cms2.opencouncil.network/*` redirects on; `cms` still lists `http://localhost:3002`.
   `drift.mjs` reports all of these. `scripts/realm/legacy-clients.mjs` makes exactly the
   changes in `realm/config/legacy-clients.json`, one flag per change, and prints them first
   with `--dry-run`:
   - `--constitution-admin`: implicit flow and direct access grants off, code flow and client
     authentication on, PKCE `S256`, redirect URIs exactly
     `https://constitution.opencouncil.network/tower-hamlets/admin/callback` and
     `https://constitution.ocn.technology/tower-hamlets/admin/callback` (the site's two Render
     custom domains; Tower Hamlets is its only council), web origins and post-logout redirects
     to match. Service accounts are turned off (the site never uses client credentials); scopes and the secret are left as they are. A new council's
     admin needs its two callbacks added to the file first.
   - `--cms-localhost`: removes `http://localhost:3002/*` (redirect), `http://localhost:3002`
     (web origin and post-logout redirect) from `cms`; the rest stays.
   Tested on a local Keycloak with the production export, after `apply.mjs --env production`:
   the site's own sign-in code (ocn-constitution `main`, `AuthController` and `AuthService`)
   signed in and came back to the admin page on both hosts; before the change
   `constitution.ocn.technology` was refused (`Invalid parameter: redirect_uri`, the export does
   not list it). After it, password grant, implicit (`unauthorized_client`), the `cms`/`cms2`
   redirects and `localhost:3002` are refused, the site's sign-out returns to its admin page on
   both hosts, and `drift.mjs --env production` is clean. A second run prints "already as
   configured". The live client may differ from the export: read the `--dry-run` output.
9. **Existing sessions end at the apply.** The `civicos-session-rules` client policy refuses a
   refresh whose mailbox check is older than 30 days, and no existing session has one, so every
   signed-in person is signed out within about 5 minutes of the apply and the next sign-in needs
   an email code. SES must work first, and accounts with a personal address (gmail and the
   like), a bare username or no email cannot sign in afterwards: list them first.
10. **`ocn-admin` gains `ocn-staff`** (roles.json makes it composite). Everyone who holds
   `ocn-admin` becomes OCN staff in every product, always with a second step. Check who holds it.
11. **The `saml` identity provider**: first broker login moves to `civicos-first-broker-login`,
   which refuses new links from an IdP with no organisation. Confirm it is unused.
12. **Docs legacy admin** signs in through `civicos-portal`; its callback
   (`https://docs.ocn.technology/api/auth/callback/keycloak`) is kept in `clients.json` until Docs
   runs `DOCS_ADMIN_MODE=civicos`.

## Migration (both hostnames)

1. Deploy the extension JAR and theme with the hostname change (before the day, steps 4 and 5),
   and apply the realm with `frontendUrl` empty (`realm/config/env/production.json`).
2. Move each existing client's issuer to `https://auth.ocn.technology/realms/ocn`, one product at
   a time (product config change and redeploy). Requests on `auth.ocn.technology` get the new
   issuer; requests on `idp.opencouncil.network` still get the old one.
3. When every client uses the new host (release step F1): set `frontendUrl` to
   `https://auth.ocn.technology` in `realm/config/env/production.json` and apply it, and put a
   fixed `hostname=https://auth.ocn.technology` back in `deploy/keycloak.conf.template` (remove
   `hostname-strict=false`). From then on the issuer no longer depends on the request's host.
4. Keep `idp.opencouncil.network` resolving for at least a month, redirecting browsers to the new
   host, then retire it.

## Apply the realm and deploy in one job

Run these in one workflow job, in this order, and stop on the first failure:

```bash
# 1. Build and test the extension (unit tests), copy the JAR, theme and password blocklist.
# 2. Deploy to the VM and restart Keycloak; wait for /health/ready.
# 3. Apply the realm config to the running Keycloak (the JAR is there now):
KC_SERVER=https://auth.ocn.technology KC_ADMIN_CLIENT_ID=... KC_ADMIN_CLIENT_SECRET=... \
  node scripts/realm/apply.mjs --env production
# 4. With Toby's approval of release step A4, tighten the two legacy clients: print, then apply:
node scripts/realm/legacy-clients.mjs --constitution-admin --cms-localhost --dry-run
node scripts/realm/legacy-clients.mjs --constitution-admin --cms-localhost
# 5. Check it:
node scripts/realm/drift.mjs --env production          # exit 0, or the job fails
```

Without step 4, `drift.mjs` still reports the `ocn-constitution-admin` and `cms` client rules
(exit 2). `apply.mjs` does not undo step 4 when it runs again: it does not touch those clients.

`apply.mjs` skips a flow whose authenticators are not installed and keeps the realm's current
binding, so a missing JAR cannot leave the realm on a half-built flow, but the job must still
fail so someone looks. Roll back by redeploying the previous JAR and theme and re-running
`apply.mjs` from the previous commit.

## After

- The nightly `.github/workflows/realm-drift.yml` runs `drift.mjs --env production` and fails
  (exit 2) on any difference; connect its failure notification to Slack.
- Alert on these Keycloak log lines: `CivicOS erasure FAILED`, `CivicOS SMTP check FAILED`.
- Check stored events in the admin console (Events) after the first staff sign-in: the LOGIN
  event has `civicos_staff: true` and `civicos_level: 2`.
