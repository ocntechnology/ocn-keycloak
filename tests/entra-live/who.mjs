import { admin, userByEmail } from '../integration/lib.mjs';
for (const e of process.argv.slice(2)) {
  const u = await userByEmail(e);
  if (!u) { console.log(e, 'NO ACCOUNT'); continue; }
  const full = await admin.get(`/users/${u.id}`);
  const fed = await admin.get(`/users/${u.id}/federated-identity`);
  const sess = await admin.get(`/users/${u.id}/sessions`);
  console.log(JSON.stringify({ email: e, id: u.id, enabled: full.enabled, attrs: Object.fromEntries(Object.entries(full.attributes || {}).filter(([k]) => k.startsWith('entra_'))), fed: fed.map((f) => ({ idp: f.identityProvider, userId: f.userId, userName: f.userName })), sessions: sess.length }));
}
