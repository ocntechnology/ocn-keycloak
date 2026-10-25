# Cut-over runbook: CivicOS sign-in on auth.ocn.technology

How to move production realm `ocn` from `idp.opencouncil.network` to `auth.ocn.technology` and
switch on the CivicOS sign-in policy, without breaking the products that use the realm today
(`cms`, `cms-admin`, `ocn-constitution-admin`, `civicos-committee`). Nothing here has been run.
Every production step needs Toby's go-ahead.

## Why it needs care

- The issuer (`iss`) of every token comes from the realm's `frontendUrl`. Setting it to
  `https://auth.ocn.technology` (as `realm/config/env/production.json` does) changes the issuer
  for **every** client in the realm at once. A product that still expects
  `https://idp.opencouncil.network/realms/ocn` refuses the new tokens.
- The realm configuration refers to authenticators, a client policy executor and a JPA table
  that only exist once the extension JAR is deployed. Applying the realm before the JAR (or
  deploying a JAR the realm does not match) can leave the realm pointing at a flow or executor
  that is not there.

## Before the day

1. **SMTP.** Verify `no-reply@ocn.technology` in SES (eu-west-1) and create SMTP credentials.
   Put them in the deploy secrets as `SMTP_USER` / `SMTP_PASSWORD`. After the deploy, the
   Keycloak log must show `CivicOS SMTP check: realm ocn can reach email-smtp... and log in`;
   an ERROR `CivicOS SMTP check FAILED` means codes and reset links will not be sent.
2. **Admin service account** for `apply.mjs` and `drift.mjs` in realm `ocn` (client credentials,
   realm-management roles as `civicos-registry-sync` has). Store as `KC_ADMIN_CLIENT_ID` /
   `KC_ADMIN_CLIENT_SECRET` secrets. Do not use password grants (they are refused in realm `ocn`
   once the realm config is applied).
3. **DNS and TLS** for `auth.ocn.technology` pointing at the same Keycloak as
   `idp.opencouncil.network`. Keycloak must answer on both hostnames (run without a fixed
   `hostname`, or with `hostname-strict=false`), so old and new issuers both work during the
   migration: a request that arrives on a host gets that host's issuer only while `frontendUrl`
   is unset.
4. **List every client and who owns it**: `cms`, `cms-admin`, `ocn-constitution-admin`,
   `civicos-committee`, then the CivicOS products. For each, note the issuer and redirect URIs
   it is configured with today.
5. **`ocn-constitution-admin`** has implicit flow, direct access grants and a wildcard redirect
   (`https://cms2.opencouncil.network/*`) on. `drift.mjs` reports these. Decide with its owner
   whether it is still used; retire it, or move it to code + PKCE with exact redirect URIs,
   before the cut-over. (The localhost entries were removed from the export in the repo; the
   live client is unchanged.)

## Migration (both hostnames)

1. Deploy the extension JAR and theme **with** `frontendUrl` still unset on the live realm.
2. Move each existing client's issuer to `https://auth.ocn.technology/realms/ocn`, one product at
   a time (product config change and redeploy). Requests on `auth.ocn.technology` get the new
   issuer; requests on `idp.opencouncil.network` still get the old one.
3. When every client uses the new host, set `frontendUrl` (apply `--env production`, below).
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
# 4. Check it:
node scripts/realm/drift.mjs --env production          # exit 0, or the job fails
```

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
