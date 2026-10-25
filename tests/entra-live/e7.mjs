// E7: access removed in Entra (group removal or disabled account), then the CivicOS re-check.
import { signIn, refresh } from './kc.mjs';
import { shot, sleep } from './drv.mjs';
import { execFileSync } from 'node:child_process';
const [mode, user] = process.argv.slice(2); // remove|disable, editor2|editor1
const upn = `${user}@ocntestcouncil.onmicrosoft.com`;
const SECS = Number(process.env.RECHECK || 300);
const graph = (m, path, body) => execFileSync('bash', ['-c', `source ${new URL('./g.sh', import.meta.url).pathname}; G ${m} '${path}' '${body || ''}'`], { cwd: process.env.HOME }).toString();
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const { result: r1, s } = await signIn({ name: `e7-${mode}-1`, email: upn, service: `entra-testcouncil-${user}`, keep: true });
log('signed in', !!r1.stopped, r1.access);
if (mode === 'remove') log('remove from group', graph('DELETE', `v1.0/groups/f176681e-18ef-42dd-b3d0-cdbe245930aa/members/${user === 'editor2' ? '0c667498-3be4-4dab-8c12-0d9670f07722' : '5dfe4f41-6a5a-47ce-b757-9a66e00d37d3'}/$ref`) || 'ok');
else log('disable', graph('PATCH', `v1.0/users/${upn}`, '{"accountEnabled":false}') || 'ok');
const t0 = Date.now();
log('refresh right after', (await refresh(r1.refresh_token)).status);
let rt = r1.refresh_token, last;
while ((Date.now() - t0) / 1000 < SECS + 30) {
  await sleep(60_000);
  last = await refresh(rt);
  log('refresh', last.status, last.json.error || '');
  if (last.status !== 200) break;
  rt = last.json.refresh_token;
}
const { result: r2 } = await signIn({ name: `e7-${mode}-2`, email: upn, service: `entra-testcouncil-${user}`, session: s, keep: true });
log('after re-check: signed in?', !!r2.stopped, JSON.stringify(r2.steps.map((x) => x.slice(0, 4))));
await s.browser.close();
