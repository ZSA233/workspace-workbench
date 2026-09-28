import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, symlinkSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Git } from '../server/backend/git.ts';
import { GitQueue } from '../server/backend/git-scheduler.ts';
import { DiffReadTasks } from '../server/backend/diff-read-tasks.ts';
import { createDiffReadClient } from '../client/diff-read-client.ts';
import { countFile } from '../server/backend/file-statistics.ts';
import { Service } from '../server/backend/service.ts';
import { loadConfig } from '../server/backend/config.ts';
const wait = (ms: number) => new Promise<void>(r => setTimeout(r, ms));
const git = (root: string, ...args: string[]) => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-diff-'))), repo = join(root, 'repo'); mkdirSync(repo);
  git(repo, 'init', '-q'); git(repo, 'config', 'user.name', 'Test'); git(repo, 'config', 'user.email', 'test@example.invalid');
  writeFileSync(join(repo, 'file'), 'old\n'); git(repo, 'add', '.'); git(repo, 'commit', '-qm', 'initial');
  const config = join(root, 'project.json');
  writeFileSync(config, JSON.stringify({ schemaVersion: 1, project: { id: 'diff' }, sourceRoot: root, workspaceRoot: join(root, 'workspaces'), stateRoot: join(root, 'state'), repositories: [{ id: 'repo', path: 'repo' }], discovery: { mode: 'manual' }, management: { enabled: true } }));
  return { root, repo, config };
}

test('single-file reads avoid global status, files and numstat; literal paths, rename, deletion and commits remain correct', async () => {
  const f = fixture();
  try {
    writeFileSync(join(f.repo, 'file'), 'new\n');
    writeFileSync(join(f.repo, ':(glob)*'), 'literal\n');
    const reader = new Git(f.repo), calls: string[][] = [];
    reader.files = async () => { throw Error('whole repository scan forbidden'); };
    const run = reader.run.bind(reader);
    reader.run = async (...args) => { calls.push(args[0]); return run(...args); };
    assert.match((await reader.diff('working', 'file')).patch, /\+new/);
    assert.match((await reader.diff('working', ':(glob)*')).patch, /literal/);
    assert.ok(calls.every(args => !args.includes('--numstat')));
    assert.ok(calls.filter(args => args[0] === 'status').every(args => args.includes('--') && args.at(-1) !== '--'));
    git(f.repo, 'reset', '--hard', '-q');
    renameSync(join(f.repo, 'file'), join(f.repo, 'renamed')); git(f.repo, 'add', '-A');
    assert.match((await reader.diff('working', 'renamed')).patch, /rename from file/);
    git(f.repo, 'commit', '-qm', 'rename'); const sha = git(f.repo, 'rev-parse', 'HEAD');
    assert.match((await reader.diff('commit', 'renamed', null, sha)).patch, /rename to renamed/);
    rmSync(join(f.repo, 'renamed'));
    assert.match((await reader.diff('working', 'renamed')).patch, /deleted file mode/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('symlinks are shown as links and escaping paths rejected; output is capped and valid UTF-8', async () => {
  const f = fixture();
  try {
    symlinkSync('/etc/passwd', join(f.repo, 'link'));
    const reader = new Git(f.repo);
    const result = await reader.diff('working', 'link');
    assert.match(result.patch, /120000/); assert.match(result.patch, /\+\/etc\/passwd/); assert.doesNotMatch(result.patch, /root:/);
    await assert.rejects(reader.diff('working', '../outside'), /relative/);
    writeFileSync(join(f.repo, 'huge'), '中文 line\n'.repeat(200000));
    const bounded = await reader.diff('working', 'huge', null, null, { maxBytes: 4096 });
    assert.equal(bounded.truncated, true); assert.ok(Buffer.byteLength(bounded.patch) <= 4096); assert.ok(!bounded.patch.includes('\ufffd'));
    const deferred = await countFile(join(f.repo, 'huge'), f.repo, 1024);
    assert.equal(deferred.statisticsState, 'deferred'); assert.equal(deferred.additions, null); assert.equal(deferred.binary, null);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test('Git scheduling reserves capacity for interaction and cancellation retains running slots until cleanup', async () => {
  const queue = new GitQueue(); let release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  const background = Array.from({ length: 4 }, () => queue.run(() => gate, 'background'));
  await wait(0); assert.equal(queue.health().running, 2); assert.equal(queue.health().queued, 2);
  assert.equal(await queue.run(async () => 'interactive', 'interactive'), 'interactive');
  const abort = new AbortController(); const cancelled = queue.run(async () => 'never', 'background', undefined, abort.signal);
  abort.abort(); await assert.rejects(cancelled, /cancelled/);
  assert.equal(queue.health().running, 2);
  release(); await Promise.all(background); assert.equal(queue.health().running, 0);
});

test('diff jobs merge consumers, recover lost start responses and do not repeat terminal reads', async () => {
  const tasks = new DiffReadTasks(); let executions = 0, release!: () => void;
  const gate = new Promise<void>(r => { release = r; });
  try {
    const work = async () => { executions++; await gate; return { patch: 'same', readBytes: 4 }; };
    const a = await tasks.start('key', 'a', work);
    const b = await tasks.start('key', 'b', work);
    assert.equal(a.taskId, b.taskId); assert.equal(executions, 1);
    assert.equal((await tasks.start('key', 'a', work)).taskId, a.taskId);
    tasks.release(a.taskId, 'a'); release(); await wait(0);
    assert.equal(tasks.status(b.taskId, 'b').state, 'ready');
    assert.equal(tasks.health().started, 1);
  } finally { release?.(); await tasks.close(); }
});

test('job deadline and subscriber lease cancel owned work and terminal status keeps its stage', async () => {
  const tasks = new DiffReadTasks(); let aborted = false;
  try {
    const a = await tasks.start('slow', 'request', signal => new Promise((_, reject) => signal.addEventListener('abort', () => { aborted = true; reject(Error('cancelled')); })), 20);
    await wait(300);
    const result = tasks.status(a.taskId, 'request');
    assert.equal(result.state, 'failed'); assert.equal(result.error.code, 'diff_read_timeout'); assert.equal(aborted, true);
    assert.ok(result.error.details.stage);
  } finally { await tasks.close(); }
});

test('UI task client reuses identity after a lost response and releases the returned task after blur', async () => {
  const client = createDiffReadClient(); const calls: Record<string, unknown>[] = []; let n = 0;
  const rpc = async (_: string, params: Record<string, unknown>) => {
    calls.push(params);
    if (++n === 1) return { ok: false, error: { code: 'observer_timeout', message: 'lost' } };
    return { ok: true, result: { protocol: 1, generation: 'g', requestId: params.requestId, taskId: 't', state: 'running', deadline: Date.now() + 30_000 } };
  };
  await client.read('key', {}, rpc, true); await client.read('key', {}, rpc, true);
  assert.equal(calls[0].requestId, calls[1].requestId);
  client.release('key', rpc); assert.equal(calls.at(-1)?.action, 'release');
});

test('real backend read protocol returns the same Diff as legacy RPC with no watcher prerequisite', async () => {
  const f = fixture(), service = new Service(loadConfig(f.config));
  try {
    const workspaceId = (await service.handle('workspace.list', {})).workspaces[0].id;
    writeFileSync(join(f.repo, 'file'), 'changed\n');
    const params = { workspaceId, repoPath: 'repo', scope: 'working', path: 'file' };
    let task = await service.handle('repository.diff.read', { ...params, requestId: 'one' });
    for (let i = 0; i < 30 && ['queued', 'running'].includes(task.state); i++) { await wait(50); task = await service.handle('repository.diff.read', { action: 'status', requestId: 'one', taskId: task.taskId }); }
    assert.equal(task.state, 'ready'); assert.match(task.result.patch, /changed/);
    const legacy = await service.handle('repository.diff', params);
    assert.equal(legacy.patch, task.result.patch);
  } finally { await service.close(); rmSync(f.root, { recursive: true, force: true }); }
});

test('returning to a cancelled task waits for its cleanup rather than reusing its aborted cache flight', async () => {
  const tasks = new DiffReadTasks(); let finish!: () => void, replacement = false;
  try {
    const a = await tasks.start('key', 'old', signal => new Promise((_, reject) => {
      signal.addEventListener('abort', () => { finish = () => reject(Error('old abort')); });
    }));
    tasks.release(a.taskId, 'old');
    const next = tasks.start('key', 'new', async () => { replacement = true; return { patch: 'new' }; });
    await wait(10); assert.equal(replacement, false);
    finish(); const result = await next;
    assert.equal(result.state, 'ready'); assert.equal(replacement, true);
  } finally { finish?.(); await tasks.close(); }
});

test('failed reads stop automatic replay; backend generation loss restarts only once', async () => {
  const client = createDiffReadClient(); let calls = 0;
  const failed = async () => { calls++; return { ok: true, result: { protocol: 1, taskId: 't', generation: 'g', deadline: Date.now() + 30_000, state: 'failed', error: { code: 'git_timeout', message: 'timeout' } } }; };
  assert.equal((await client.read('one', {}, failed, true)).ok, false);
  await client.read('one', {}, failed, true); assert.equal(calls, 1);
  client.retry('one'); await client.read('one', {}, failed, true); assert.equal(calls, 2);
});

test('UI restarts a lost task after backend generation change once, while same-generation loss is terminal', async () => {
  const client = createDiffReadClient(); let call = 0;
  const rpc = async () => {
    call++;
    if (call === 1 || call === 3) return { ok: true, result: { protocol: 1, taskId: String(call), generation: call === 1 ? 'old' : 'new', state: 'running', deadline: Date.now() + 30000 } };
    return { ok: false, error: { code: 'diff_task_missing', message: 'missing', details: { generation: 'new' } } };
  };
  await client.read('k', {}, rpc, true);
  assert.equal((await client.read('k', {}, rpc, true)).ok, true);
  await client.read('k', {}, rpc, true);
  assert.equal((await client.read('k', {}, rpc, true)).ok, false);
  await client.read('k', {}, rpc, true); assert.equal(call, 4);
});

test('empty repositories, binary files and modified symlinks preserve diff semantics', async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wb-empty-diff-')));
  try {
    git(root, 'init', '-q'); git(root, 'config', 'user.name', 'Test'); git(root, 'config', 'user.email', 'test@example.invalid');
    const reader = new Git(root);
    writeFileSync(join(root, 'new'), 'first\n');
    assert.match((await reader.diff('working', 'new')).patch, /first/);
    git(root, 'add', 'new'); assert.match((await reader.diff('working', 'new')).patch, /first/);
    symlinkSync('/tmp/old-target', join(root, 'link')); git(root, 'add', 'link'); git(root, 'commit', '-qm', 'initial');
    rmSync(join(root, 'link')); symlinkSync('/tmp/new-target', join(root, 'link'));
    assert.match((await reader.diff('working', 'link')).patch, /new-target/);
    writeFileSync(join(root, 'binary'), Buffer.from([0, 1, 2, 3]));
    assert.match((await reader.diff('working', 'binary')).patch, /Binary files/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test('a concurrent commit cannot change the captured working comparison base', async () => {
  const f = fixture();
  try {
    const before = git(f.repo, 'rev-parse', 'HEAD');
    writeFileSync(join(f.repo, 'file'), 'changed during read\n');
    const reader = new Git(f.repo), run = reader.run.bind(reader); let moved = false;
    reader.run = async (...args) => {
      if (!moved && args[0].includes('--name-status')) { moved = true; git(f.repo, 'add', 'file'); git(f.repo, 'commit', '-qm', 'concurrent'); }
      return run(...args);
    };
    const result = await reader.diff('working', 'file');
    assert.equal(result.head, before); assert.match(result.patch, /changed during read/);
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
