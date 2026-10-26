// The VM runs Debian's OpenJDK 17. On 26 October 2026 a deploy shipped an extension JAR compiled
// for Java 21 (class file 65) and a distribution built on the runner, and Keycloak crash-looped:
// `kc.sh start --optimized` refused the copied JAR ("A provider JAR was updated since the last
// build"), and rebuilding on the VM failed (UnsupportedClassVersionError). These tests hold the
// three fixes in place:
//   - the build job rejects any class newer than Java 17 (it runs the workflow's own check);
//   - the deploy job runs `kc.sh build` on the VM after the copy and Java install, before start;
//   - the verify step prints the last 50 journal lines when Keycloak is not ready.
//   node --test tests/deploy/workflow-java17.test.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const YML = readFileSync(join(REPO, '.github', 'workflows', 'deploy-gcp.yml'), 'utf8');
const POM = readFileSync(join(REPO, 'extension', 'pom.xml'), 'utf8');

/** The run script of one step, unindented. */
function stepRun(name) {
  const start = YML.indexOf(`- name: ${name}`);
  assert.ok(start >= 0, `step "${name}" not found`);
  const body = YML.slice(YML.indexOf('run: |', start) + 'run: |'.length);
  const next = body.search(/\n {6}(- name:|[a-z]+:)/);
  return (next >= 0 ? body.slice(0, next) : body).split('\n').map((l) => l.replace(/^ {10}/, '')).join('\n');
}

/** The class-version check from the extension build step (from its comment to the closing fi). */
function versionCheck() {
  const run = stepRun('Build CivicOS sign-in policy extension (with unit tests) and the password blocklist');
  const start = run.indexOf('# Fail here, not on the VM');
  assert.ok(start >= 0, 'class-version check not found in the build step');
  const end = run.indexOf('\nfi\n', start);
  assert.ok(end >= 0, 'end of the class-version check not found');
  return run.slice(start, end + '\nfi'.length);
}

/** A JAR at extension/target/civicos-signin-policy.jar under `dir` with classes of these majors. */
function fakeJar(dir, majors) {
  const classes = join(dir, 'classes', 'technology', 'ocn');
  mkdirSync(classes, { recursive: true });
  majors.forEach((major, i) => {
    writeFileSync(join(classes, `C${i}.class`), Buffer.from([0xca, 0xfe, 0xba, 0xbe, 0, 0, major >> 8, major & 0xff, 0, 0]));
  });
  mkdirSync(join(dir, 'extension', 'target'), { recursive: true });
  execFileSync('zip', ['-qr', join(dir, 'extension', 'target', 'civicos-signin-policy.jar'), 'technology'], { cwd: join(dir, 'classes') });
}

function runCheck(majors) {
  const dir = mkdtempSync(join(tmpdir(), 'kc-jar-'));
  try {
    fakeJar(dir, majors);
    execFileSync('bash', ['-eo', 'pipefail', '-c', versionCheck()], { cwd: dir, encoding: 'utf8', stdio: 'pipe' });
    return { ok: true };
  } catch (e) {
    return { ok: false, out: `${e.stdout}${e.stderr}` };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('the extension is compiled for Java 17', () => {
  assert.match(POM, /<maven\.compiler\.release>17<\/maven\.compiler\.release>/);
});

test('the build step accepts a JAR of Java 17 (and older) classes', () => {
  assert.deepEqual(runCheck([61, 61, 52]), { ok: true });
});

test('the build step rejects a JAR with a Java 21 class', () => {
  const r = runCheck([61, 65]);
  assert.equal(r.ok, false);
  assert.match(r.out, /C1\.class \(class file 65\)/);
  assert.doesNotMatch(r.out, /C0\.class/);
});

test('the deploy job rebuilds Keycloak on the VM after the copy and Java install, before the start', () => {
  const order = ['Copy Keycloak distribution to VM', 'Install Java on VM', 'Create systemd service for Keycloak',
    'Build Keycloak on the VM', 'Enable and start Keycloak service', 'Verify Keycloak is running'];
  const at = order.map((n) => YML.indexOf(`- name: ${n}`));
  at.forEach((i, k) => assert.ok(i >= 0, `step "${order[k]}" not found`));
  assert.deepEqual([...at].sort((a, b) => a - b), at, `steps out of order: ${order.join(' -> ')}`);
  assert.match(stepRun('Build Keycloak on the VM'), /bin\/kc\.sh build/);
});

test('the verify step prints the last 50 journal lines when Keycloak is not ready', () => {
  const run = stepRun('Verify Keycloak is running');
  assert.match(run, /journalctl -u keycloak -n 50/);
  assert.match(run, /health\/ready/);
  // Every failing exit shows the logs first.
  const exits = run.split('\n').map((l, i, a) => (/^\s*exit 1$/.test(l) ? a[i - 1].trim() : null)).filter(Boolean);
  assert.ok(exits.length >= 2);
  for (const before of exits) assert.equal(before, 'show_logs');
});
