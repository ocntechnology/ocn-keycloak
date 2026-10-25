// Live Entra SSO checks against the OCN Test Council tenant (docs/entra-test-plan.md in the civicos
// repo, "Results against real Entra"). Test tenants only; never production Keycloak or the real app.
//
// Needs: a local Keycloak whose realm ocn is reached as http://localhost:<port> (Entra refuses http
// redirect URIs on any other host, AADSTS500117), e.g. a second instance on 8181 (see the plan),
// KC_SERVER pointing at it, the test app's broker redirect URI for that port, puppeteer (from
// Marketing/_render, or PUPPETEER_FROM=<package.json that has it>), and the test users' passwords in
// Keychain (entra-testcouncil-<user>). Results and screenshots go to ENTRA_LIVE_OUT (/tmp/entra-live).
//
//   node setup-org.mjs; node client.mjs; MS_CLIENT_ID=... MS_CLIENT_SECRET=... node ../../scripts/sso/connect-council.mjs ...
//   node kc.mjs <name> <email> <keychain service>          sign in through Keycloak and Entra
//   node idtoken.mjs <upn> <keychain service>               raw Entra ID token claims (MS_CLIENT_SECRET set)
//   node e1.mjs <label> [upn] [keychain service]            consent link ($ENTRA_LIVE_OUT/consent-url.txt)
//   node e7.mjs remove|disable editor2|editor1              removal and the re-check (set it to 300 first)
//   node e8.mjs ; node e11.mjs cert|rotate|undo
// g.sh: Graph helpers G (council tenant) and O (OCN tenant) using the signed-in Azure CLI.
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
const require = createRequire(process.env.PUPPETEER_FROM || `${process.env.HOME}/Dropbox/Toby Admin/Companies/Open Council Network/Marketing/_render/package.json`);
const puppeteer = require('puppeteer');

export const OUT = process.env.ENTRA_LIVE_OUT || '/tmp/entra-live';
mkdirSync(OUT, { recursive: true });
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function pw(service) {
  return execFileSync('security', ['find-generic-password', '-s', service, '-w']).toString().trim();
}

/** Launch; `stopAt(url)` true means abort that navigation and record it (the "app" redirect). */
export async function open({ stopAt = () => false } = {}) {
  const browser = await puppeteer.launch({ headless: true, args: ['--lang=en-GB'] });
  const page = await browser.newPage();
  await page.setViewport({ width: 1100, height: 900 });
  await page.setExtraHTTPHeaders({ 'accept-language': 'en-GB,en;q=0.9' });
  const s = { browser, page, stopped: null, log: [] };
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const u = req.url();
    if (req.isNavigationRequest() && stopAt(u)) { s.stopped = u; s.log.push(['STOP', u]); req.abort(); return; }
    if (req.isNavigationRequest() && req.frame() === page.mainFrame()) s.log.push(['NAV', u.slice(0, 300)]);
    req.continue();
  });
  return s;
}

export async function shot(s, name) {
  const file = `${OUT}/${name}.png`;
  try { await s.page.screenshot({ path: file, fullPage: true }); } catch {}
  try { writeFileSync(`${OUT}/${name}.txt`, `${s.page.url()}\n\n${await text(s)}`); } catch {}
  return file;
}

export async function text(s) {
  try { return (await s.page.evaluate(() => document.body?.innerText || '')).replace(/\n{2,}/g, '\n'); } catch { return ''; }
}

const visible = async (page, sel) => {
  const el = await page.$(sel);
  if (!el) return null;
  const box = await el.boundingBox().catch(() => null);
  return box ? el : null;
};

/**
 * Drive the Microsoft login pages until we leave login.microsoftonline.com, are stopped, or hit
 * a page we do not handle. Returns { state, url, text }.
 */
export async function msLogin(s, upn, password, { name = 'ms', kmsi = false, maxSteps = 25, onConsent } = {}) {
  const { page } = s;
  let lastSig = '';
  const done = new Set();
  for (let i = 0; i < maxSteps; i++) {
    await sleep(1500);
    if (s.stopped) return { state: 'stopped', url: s.stopped };
    let url = '';
    try { url = page.url(); } catch {}
    if (!/login\.microsoftonline\.com|login\.live\.com|account\.activedirectory|mysignins|aka\.ms|microsoft\.com/.test(url)) {
      return { state: 'left', url, text: await text(s) };
    }
    const t = await text(s);
    const sig = url + t.slice(0, 200);
    if (!done.has('upn') && await visible(page, 'input[name=loginfmt]')) {
      done.add('upn');
      await page.click('input[name=loginfmt]', { clickCount: 3 });
      await page.type('input[name=loginfmt]', upn, { delay: 20 });
      await page.keyboard.press('Enter');
      await page.waitForSelector('input[name=passwd]', { visible: true, timeout: 15000 }).catch(() => {});
      await sleep(800);
    }
    if (!done.has('pw') && await visible(page, 'input[name=passwd]')) {
      done.add('pw');
      await sleep(1200);
      for (let k = 0; k < 3; k++) {
        await page.click('input[name=passwd]', { clickCount: 3 }).catch(() => {});
        await page.evaluate(() => { const e = document.querySelector('input[name=passwd]'); if (e) e.value = ''; });
        await page.type('input[name=passwd]', password, { delay: 25 });
        const len = await page.evaluate(() => document.querySelector('input[name=passwd]')?.value.length || 0);
        if (len === password.length) break;
        await sleep(700);
      }
      await sleep(300);
      await page.keyboard.press('Enter');
      continue;
    }
    if (/Stay signed in\?/i.test(t) && await visible(page, '#idBtn_Back')) {
      await page.click(kmsi ? '#idSIButton9' : '#idBtn_Back');
      continue;
    }
    if (/Permissions requested|Accept/i.test(t) && /Accept/.test(t) && onConsent) {
      const r = await onConsent(s, t);
      if (r === 'return') return { state: 'consent', url, text: t };
      continue;
    }
    if (/Need admin approval|Approval required/i.test(t) && !done.has('approval')) {
      done.add('approval');
      await shot(s, `${name}-approval`);
      const links = await page.$$('a, button, input[type=submit]');
      for (const l of links) {
        const lt = await page.evaluate((e) => e.innerText || e.value || '', l);
        if (/Return to the application/i.test(lt)) { await l.click(); break; }
      }
      continue;
    }
    if (/AADSTS\d+/.test(t)) { await shot(s, `${name}-error`); return { state: 'error', url, text: t, code: t.match(/AADSTS\d+/)[0] }; }
    if (sig === lastSig) {
      await shot(s, `${name}-stuck-${i}`);
      return { state: 'page', url, text: t };
    }
    lastSig = sig;
  }
  await shot(s, `${name}-max`);
  return { state: 'max', url: page.url(), text: await text(s) };
}
