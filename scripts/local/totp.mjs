#!/usr/bin/env node
// Print the current six-digit code for the local OCN staff test authenticator (local only).
//   node scripts/local/totp.mjs            current code
//   node scripts/local/totp.mjs --base32   the secret as an authenticator app wants it
// Also importable: import { totp, STAFF_TOTP_SECRET } from '.../scripts/local/totp.mjs'.
import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const seed = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'realm', 'config', 'env', 'local-seed.json'), 'utf8'));
export const STAFF_TOTP_SECRET = seed.staffTotp.secret;

export function totp(secret = STAFF_TOTP_SECRET, at = Date.now(), period = 30) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / period)));
  const h = createHmac('sha1', Buffer.from(secret, 'utf8')).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const n = ((h[o] & 0x7f) << 24) | (h[o + 1] << 16) | (h[o + 2] << 8) | h[o + 3];
  return String(n % 1_000_000).padStart(6, '0');
}

export function base32(text = STAFF_TOTP_SECRET) {
  const a = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const b of Buffer.from(text, 'utf8')) bits += b.toString(2).padStart(8, '0');
  let out = '';
  for (let i = 0; i < bits.length; i += 5) out += a[parseInt(bits.slice(i, i + 5).padEnd(5, '0'), 2)];
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  console.log(process.argv.includes('--base32') ? base32() : totp());
}
