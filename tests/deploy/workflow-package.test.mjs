// The deploy workflow must ship the password blocklist to the VM. realm/config/settings.json sets
// passwordBlacklist(civicos-password-blocklist.txt), which Keycloak reads from
// <home>/data/password-blacklists/. Without the file, apply.mjs's realm settings update fails
// with 500 "Password blacklist civicos-password-blocklist.txt not found!", after clients and
// flows were already changed.
//
// This runs the workflow's own "Copy Keycloak distribution to VM" packaging commands (up to the
// scp) against a fake distribution, in both layouts the step handles, and checks the tarball.
//   node --test tests/deploy/workflow-package.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const BLOCKLIST = 'data/password-blacklists/civicos-password-blocklist.txt';

/** The packaging part of the step's run script: from its first line to just before the scp. */
function packagingScript() {
  const yml = readFileSync(join(REPO, '.github', 'workflows', 'deploy-gcp.yml'), 'utf8');
  const start = yml.indexOf('- name: Copy Keycloak distribution to VM');
  assert.ok(start >= 0, 'step "Copy Keycloak distribution to VM" not found');
  const run = yml.slice(yml.indexOf('run: |', start) + 'run: |'.length);
  const end = run.indexOf('scp "$TARBALL"');
  assert.ok(end >= 0, 'scp of the tarball not found in the step');
  return run.slice(0, end).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
}

function fakeDist(dir) {
  for (const d of ['bin', 'conf', 'lib', 'providers', 'themes/ocn', 'data/password-blacklists']) mkdirSync(join(dir, d), { recursive: true });
  writeFileSync(join(dir, 'bin', 'kc.sh'), '#!/bin/sh\n');
  writeFileSync(join(dir, 'providers', 'civicos-signin-policy.jar'), 'jar');
  writeFileSync(join(dir, BLOCKLIST), 'correcthorsebatterystaple\n');
  writeFileSync(join(dir, 'LICENSE.txt'), 'licence');
}

function packageAndList(distDir, asArtifactRoot) {
  // The step tests [ "$DIST_DIR" = "/tmp" ] for the artifact downloaded straight into /tmp; point
  // that branch at our fake directory instead of the real /tmp.
  let script = packagingScript().replace('DIST_DIR="${{ env.DIST_DIR }}"', `DIST_DIR="${distDir}"`);
  if (asArtifactRoot) script = script.replace('[ "$DIST_DIR" = "/tmp" ]', `[ "$DIST_DIR" = "${distDir}" ]`);
  else script = script.replace('[ "$DIST_DIR" = "/tmp" ]', '[ "$DIST_DIR" = "/not-this-branch" ]');
  script += '\ntar tzf "$TARBALL"\n';
  return execFileSync('bash', ['-e', '-c', script], { encoding: 'utf8' }).split('\n').map((l) => l.replace(/^\.\//, ''));
}

for (const [name, asArtifactRoot] of [['artifact downloaded into /tmp', true], ['distribution directory', false]]) {
  test(`deploy tarball carries the password blocklist (${name})`, () => {
    const dir = mkdtempSync(join(tmpdir(), 'kc-dist-'));
    try {
      fakeDist(dir);
      const files = packageAndList(dir, asArtifactRoot);
      assert.ok(files.includes('providers/civicos-signin-policy.jar'), 'extension JAR missing from the tarball');
      assert.ok(files.includes(BLOCKLIST), `${BLOCKLIST} missing from the tarball:\n${files.join('\n')}`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
}
