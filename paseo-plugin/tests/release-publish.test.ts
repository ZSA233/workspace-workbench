import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, delimiter } from 'node:path';
import { spawnSync } from 'node:child_process';

const workflow = readFileSync(resolve(import.meta.dirname, '../../.github/workflows/release.yml'), 'utf8');
const step = workflow.match(/      - name: Publish GitHub Release\n([\s\S]*?)(?=      - name: Promote released commit to stable\n)/)?.[1];
assert.ok(step);
const command = step.match(/        run: \|\n([\s\S]*)/)?.[1].replace(/^ {10}/gm, '');
assert.ok(command);

function publish(permanent: boolean) {
  const root = mkdtempSync(join(tmpdir(), 'workbench-publish-'));
  try {
    mkdirSync(join(root, 'bin')); mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist', 'SHA256SUMS'), 'verified checksum');
    writeFileSync(join(root, 'dist', 'plugin.tar.gz'), 'verified archive');
    const statePath = join(root, 'state.json');
    writeFileSync(statePath, JSON.stringify({ exists: permanent, draft: true, creates: 0, edits: 0, uploads: 0 }));
    writeFileSync(join(root, 'bin', 'sleep'), '#!/bin/sh\nexit 0\n', { mode: 0o700 });
    writeFileSync(join(root, 'bin', 'gh'), `#!/usr/bin/env node
const { readFileSync, writeFileSync } = require('node:fs');
const assert = require('node:assert/strict');
const args = process.argv.slice(2), state = JSON.parse(readFileSync(process.env.PUBLISH_STATE, 'utf8'));
let exit = 0;
assert.equal(args[0], 'release');
if (args[1] === 'view') {
  exit = state.exists ? 0 : 1;
  if (!exit && args.includes('--json')) console.log(state.draft);
} else if (args[1] === 'create') {
  state.creates++; state.exists = true;
  assert.ok(args.includes('--draft'));
  assert.ok(args.includes('--verify-tag'));
  // A server error may arrive after the draft was actually created.
  console.error('HTTP 500'); exit = 1;
} else if (args[1] === 'upload') {
  state.uploads++;
  assert.equal(readFileSync('dist/SHA256SUMS', 'utf8'), 'verified checksum');
  assert.equal(readFileSync('dist/plugin.tar.gz', 'utf8'), 'verified archive');
} else if (args[1] === 'edit') {
  state.edits++; assert.ok(args.includes('--draft=false'));
  if (process.env.PUBLISH_PERMANENT === '1' || state.edits === 1) { console.error('HTTP 500'); exit = 1; }
  else state.draft = false;
} else throw Error('unexpected release command');
writeFileSync(process.env.PUBLISH_STATE, JSON.stringify(state));
process.exit(exit);
`, { mode: 0o700 });
    const result = spawnSync('bash', ['-c', command!], { cwd: root, encoding: 'utf8', timeout: 10000,
      env: { ...process.env, PATH: join(root, 'bin') + delimiter + process.env.PATH, RELEASE_TAG: 'v1.2.3',
        PUBLISH_STATE: statePath, PUBLISH_PERMANENT: permanent ? '1' : '0' } });
    assert.ifError(result.error);
    return { result, state: JSON.parse(readFileSync(statePath, 'utf8')) };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('release publication recovers uncertain draft creation and a transient publish failure', () => {
  const { result, state } = publish(false);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(state.creates, 1);
  assert.equal(state.draft, false);
  assert.equal(state.edits, 2);
  assert.equal(state.uploads, 2);
});

test('an unpublished draft cannot pass the release step after bounded retries', () => {
  const { result, state } = publish(true);
  assert.equal(result.status, 1);
  assert.equal(state.draft, true);
  assert.equal(state.edits, 3);
  assert.equal(state.creates, 0);
  assert.match(result.stdout, /stable was not promoted/);
});
