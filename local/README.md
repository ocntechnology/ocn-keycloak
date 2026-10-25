# local/

Written by `scripts/local-up.sh` for local development only. Everything here except this README is gitignored.

- `clients.env`: local OIDC client secrets (never commit)
- `STATUS.md`: what is running, URLs, clients, test users, start and stop commands
- `keycloak.log`, `keycloak.pid`: the local Keycloak process

By default the scripts use `~/Repositories/ocn-keycloak/local` (set `LOCAL_DIR` to change it), so every worktree shares one local Keycloak.
