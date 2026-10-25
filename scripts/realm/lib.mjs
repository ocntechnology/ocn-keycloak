// Shared helpers for the realm-as-code tools (apply.mjs, drift.mjs).
// Node 20+, no dependencies: talks to the Keycloak admin REST API with fetch.

import { readFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
export const CONFIG = join(REPO, 'realm', 'config');

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

export function parseArgs(argv) {
  const args = { env: process.env.REALM_ENV || 'local', realm: process.env.KC_REALM || 'ocn' };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith('--')) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

/** Replace {{name}} placeholders with values from the env file. A string that is exactly one
 * placeholder becomes the value itself (so objects such as smtp can be injected). */
export function render(value, vars) {
  if (typeof value === 'string') {
    const whole = value.match(/^\{\{(\w+)\}\}$/);
    if (whole) {
      if (!(whole[1] in vars)) throw new Error(`missing env value ${whole[1]}`);
      return structuredClone(vars[whole[1]]);
    }
    return value.replace(/\{\{(\w+)\}\}/g, (_, k) => {
      if (!(k in vars)) throw new Error(`missing env value ${k}`);
      return String(vars[k]);
    });
  }
  if (Array.isArray(value)) return value.map((v) => render(v, vars));
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) if (!k.startsWith('$')) out[k] = render(v, vars);
    return out;
  }
  return value;
}

/** Expand environment variables (${SMTP_PASSWORD}) from process.env. Unset ones are left as is. */
export function expandProcessEnv(value) {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z0-9_]+)\}/g, (m, k) => process.env[k] ?? m);
  if (Array.isArray(value)) return value.map(expandProcessEnv);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, expandProcessEnv(v)]));
  return value;
}

export function loadDesired(env) {
  const envFile = join(CONFIG, 'env', `${env}.json`);
  if (!existsSync(envFile)) throw new Error(`no env file ${envFile}`);
  const vars = expandProcessEnv(readJson(envFile));
  const settings = render(readJson(join(CONFIG, 'settings.json')), vars);
  const clientsCfg = readJson(join(CONFIG, 'clients.json'));
  const products = clientsCfg.products.map((p) => productClient(render(p, vars), clientsCfg.productTemplate));
  const service = render(clientsCfg.service, vars);
  // Keycloak's own clients (admin-cli): only the listed fields are managed, never created.
  const builtIn = render(clientsCfg.builtIn || [], vars).map((c) => ({ ...c, builtIn: true }));
  const scopes = render(readJson(join(CONFIG, 'client-scopes.json')), vars);
  const flows = readJson(join(CONFIG, 'flows.json')).flows;
  const policiesFile = join(CONFIG, 'client-policies.json');
  const clientPolicies = existsSync(policiesFile) ? render(readJson(policiesFile), vars) : null;
  return { vars, settings, clients: [...products, ...service, ...builtIn], scopes, flows, clientPolicies };
}

export function productClient(p, template) {
  const url = p.url.replace(/\/$/, '');
  const c = structuredClone(template);
  Object.assign(c, {
    clientId: p.clientId,
    name: p.name,
    description: p.description || `${p.name}. OIDC browser client (code + PKCE).`,
    rootUrl: url,
    baseUrl: url,
    adminUrl: url,
    redirectUris: [`${url}/api/auth/callback/keycloak`, ...(p.extraRedirectUris || [])],
    webOrigins: [url],
  });
  // Keycloak calls the product server to server (back-channel logout, account erasure). Locally
  // that is http://127.0.0.1:<port>, because Java cannot resolve the *.civicos.localhost names.
  const server = (p.backchannelUrl || url).replace(/\/$/, '');
  c.attributes = {
    ...c.attributes,
    'post.logout.redirect.uris': `${url}/*`,
    'backchannel.logout.url': `${server}/api/auth/civicos/backchannel-logout`,
    'civicos.erasure.url': p.erasure === false ? '' : `${server}/api/auth/civicos/erase`,
  };
  return c;
}

export class Admin {
  constructor({ server, realm, user, password, clientId, clientSecret }) {
    this.server = server.replace(/\/$/, '');
    this.realm = realm;
    this.creds = { user, password, clientId, clientSecret };
    this.token = null;
    this.tokenExpires = 0;
  }

  static fromEnv(realm) {
    return new Admin({
      server: process.env.KC_SERVER || 'http://localhost:8180',
      realm,
      user: process.env.KC_ADMIN || 'admin',
      password: process.env.KC_ADMIN_PASSWORD || 'admin',
      clientId: process.env.KC_ADMIN_CLIENT_ID,
      clientSecret: process.env.KC_ADMIN_CLIENT_SECRET,
    });
  }

  async auth() {
    if (this.token && Date.now() < this.tokenExpires - 10_000) return this.token;
    const { user, password, clientId, clientSecret } = this.creds;
    const body = clientId
      ? new URLSearchParams({ grant_type: 'client_credentials', client_id: clientId, client_secret: clientSecret })
      : new URLSearchParams({ grant_type: 'password', client_id: 'admin-cli', username: user, password });
    const tokenRealm = clientId ? this.realm : 'master';
    const res = await fetch(`${this.server}/realms/${tokenRealm}/protocol/openid-connect/token`, { method: 'POST', body });
    if (!res.ok) throw new Error(`admin sign-in failed: ${res.status} ${await res.text()}`);
    const json = await res.json();
    this.token = json.access_token;
    this.tokenExpires = Date.now() + json.expires_in * 1000;
    return this.token;
  }

  async req(method, path, body, { allow404 = false, raw = false } = {}) {
    const token = await this.auth();
    const url = path.startsWith('http') ? path : `${this.server}/admin/realms${path}`;
    const res = await fetch(url, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
    });
    if (allow404 && res.status === 404) return null;
    if (!res.ok) throw new Error(`${method} ${path} -> ${res.status} ${await res.text()}`);
    if (raw) return res;
    const text = await res.text();
    return text ? JSON.parse(text) : null;
  }

  r(path = '') { return `/${encodeURIComponent(this.realm)}${path}`; }
  get(path, opts) { return this.req('GET', this.r(path), undefined, opts); }
  post(path, body, opts) { return this.req('POST', this.r(path), body, opts); }
  put(path, body, opts) { return this.req('PUT', this.r(path), body, opts); }
  del(path, opts) { return this.req('DELETE', this.r(path), undefined, opts); }

  async client(clientId) {
    const list = await this.get(`/clients?clientId=${encodeURIComponent(clientId)}`);
    return list.find((c) => c.clientId === clientId) || null;
  }

  async scopeByName(name) {
    const list = await this.get('/client-scopes');
    return list.find((s) => s.name === name) || null;
  }

  async flowExecutions(alias) {
    return this.get(`/authentication/flows/${encodeURIComponent(alias)}/executions`);
  }

  async authenticatorProviders() {
    const list = await this.get('/authentication/authenticator-providers');
    return new Set(list.map((p) => p.id));
  }
}

/** Stable text for an execution's config ({ alias, config }), or null when it has none. */
function configKey(cfg) {
  if (!cfg) return null;
  const sorted = Object.fromEntries(Object.entries(cfg.config || {}).sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, String(v)]));
  return JSON.stringify({ alias: cfg.alias, config: sorted });
}

/** Flatten a desired flow definition to comparable rows: depth, provider or subflow alias, requirement, config. */
export function desiredFlowRows(executions, depth = 0) {
  const rows = [];
  for (const e of executions) {
    if (e.subflow) {
      rows.push({ level: depth, key: `flow:${e.subflow}`, requirement: e.requirement, config: null });
      rows.push(...desiredFlowRows(e.executions || [], depth + 1));
    } else {
      rows.push({ level: depth, key: e.authenticator, requirement: e.requirement, config: configKey(e.config) });
    }
  }
  return rows;
}

/** The live rows; with an Admin, each execution's config is read too. */
export async function liveFlowRows(executions, kc) {
  const rows = [];
  for (const e of executions) {
    let config = null;
    if (kc && e.authenticationConfig) {
      const c = await kc.get(`/authentication/config/${e.authenticationConfig}`, { allow404: true });
      config = configKey(c);
    }
    rows.push({ level: e.level, key: e.authenticationFlow ? `flow:${e.displayName}` : e.providerId, requirement: e.requirement, config });
  }
  return rows;
}

export function flowProviders(executions, out = new Set()) {
  for (const e of executions) {
    if (e.subflow) flowProviders(e.executions || [], out);
    else out.add(e.authenticator);
  }
  return out;
}

/** Shallow-ish comparison of the keys present in `desired`; returns a list of difference strings. */
export function diffObject(prefix, desired, live) {
  const out = [];
  for (const [k, v] of Object.entries(desired)) {
    const lv = live ? live[k] : undefined;
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      out.push(...diffObject(`${prefix}.${k}`, v, lv || {}));
    } else if (Array.isArray(v)) {
      const a = JSON.stringify([...v].map(String).sort());
      const b = JSON.stringify([...(lv || [])].map(String).sort());
      if (a !== b) out.push(`${prefix}.${k}: repo ${a} live ${b}`);
    } else if (String(v ?? '') !== String(lv ?? '')) {
      out.push(`${prefix}.${k}: repo ${JSON.stringify(v)} live ${JSON.stringify(lv)}`);
    }
  }
  return out;
}
