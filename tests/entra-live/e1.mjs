import { open, msLogin, shot, pw, text, sleep, OUT } from './drv.mjs';
import { readFileSync } from 'node:fs';
const which = process.argv[2];
const base = readFileSync(`${OUT}/${process.env.CONSENT_URL_FILE || 'consent-url.txt'}`, 'utf8').trim();
const stopAt = (u) => u.startsWith('http://localhost:3000/');
const s = await open({ stopAt });
let url = base;
if (which === 'badredirect') url = base.replace(encodeURIComponent('http://localhost:3000/sso/microsoft/consent'), encodeURIComponent('http://localhost:3000/not-registered'));
await s.page.goto(url).catch(() => {});
let r;
const user = process.argv[3];
if (user) r = await msLogin(s, user, pw(process.argv[4]), { name: `e1-${which}`, onConsent: async () => 'return' });
else { await sleep(3000); r = { state: 'page', url: s.page.url(), text: await text(s) }; }
await shot(s, `e1-${which}`);
console.log(JSON.stringify({ ...r, text: (r.text || '').slice(0, 1500), log: s.log }, null, 1));
await s.browser.close();
