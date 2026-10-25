// E11: Keycloak private_key_jwt (realm key, x5t SHA-1, RS256) against real Entra.
import { signIn } from './kc.mjs';
import { admin } from '../integration/lib.mjs';
const A = 'ocntestcouncil-microsoft';
const step = process.argv[2];
const live = await admin.get(`/identity-provider/instances/${A}`);
const savedSecret = live.config.clientSecret;
const setIdp = (cfg) => admin.put(`/identity-provider/instances/${A}`, { ...live, config: { ...live.config, ...cfg } });
const run = async (name) => {
  const { result } = await signIn({ name, email: 'editor2@ocntestcouncil.onmicrosoft.com', service: 'entra-testcouncil-editor2' });
  return { signedIn: !!result.stopped, steps: result.steps.map((x) => x.slice(0, 4)) };
};
if (step === 'cert') {
  await setIdp({ clientAuthMethod: 'private_key_jwt', jwtX509HeadersEnabled: 'true', clientSecret: '', clientAssertionSigningAlg: 'RS256' });
  console.log('cert, before rotation', JSON.stringify(await run('e11-cert-1')));
} else if (step === 'rotate') {
  const realm = await admin.get('');
  await admin.post('/components', { name: 'rsa-rotated-e11', providerId: 'rsa-generated', providerType: 'org.keycloak.keys.KeyProvider', parentId: realm.id, config: { priority: ['999999'], keySize: ['2048'], active: ['true'], enabled: ['true'], algorithm: ['RS256'] } });
  console.log('cert, after rotation', JSON.stringify(await run('e11-cert-2')));
} else if (step === 'undo') {
  const comps = await admin.get(`/components?name=rsa-rotated-e11`);
  for (const c of comps) await admin.del(`/components/${c.id}`);
  await setIdp({ clientAuthMethod: 'client_secret_post', jwtX509HeadersEnabled: 'false', clientSecret: process.env.MS_CLIENT_SECRET });
  console.log('restored secret auth; removed', comps.length, 'rotated key(s)');
  console.log('secret, after undo', JSON.stringify(await run('e11-secret')));
}
