import { lstat } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { workspaceInstanceKey } from '../../shared/workspace-lineage.ts';
import { aggregateProduction, type OrganizerEvidence, type RepositoryCoverage, type WorkspaceMaterial } from '../../shared/organizer.ts';
import { Git, withBackgroundGit } from './git.ts';
import { hash, stable, type Json } from './storage.ts';
import type { Observation } from './observation.ts';

type Change = { path: string; oldMode: string; mode: string; before: string; after: string };
const missing = (oid: string) => /^0+$/.test(oid);
function rawChanges(text: string): Change[] {
  const values = text.split('\0'), changes: Change[] = [];
  for (let i = 0; i < values.length - 1; i += 2) {
    const match = values[i].match(/^:(\d+) (\d+) ([a-f0-9]+) ([a-f0-9]+) [A-Z]\d*$/);
    if (!match) throw Error('coverage_changes_invalid');
    changes.push({ path: values[i + 1], oldMode: match[1], mode: match[2], before: match[3], after: match[4] });
  }
  return changes;
}
function occurrences(lines: string[], fragment: string[]): number {
  if (!fragment.length) return 0;
  let count = 0;
  for (let i = 0; i + fragment.length <= lines.length; i++) {
    if (fragment.every((line, n) => lines[i + n] === line) && ++count > 1) return count;
  }
  return count;
}
/** Verify net text hunks against the current production blob. Ambiguity never means shipped. */
export function textPatchCoverage(patch: string, production: string): 'covered' | 'pending' | 'unknown' {
  if (production.includes('\0') || production.includes('\ufffd') || /Binary files|GIT binary patch/.test(patch)) return 'unknown';
  const hunks: Array<{ old: string[]; next: string[] }> = [];
  let hunk: typeof hunks[number] | undefined;
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@ ')) { hunk = { old: [], next: [] }; hunks.push(hunk); }
    else if (hunk && /^[ +-]/.test(line)) {
      if (line[0] !== '+') hunk.old.push(line.slice(1));
      if (line[0] !== '-') hunk.next.push(line.slice(1));
    }
  }
  if (!hunks.length) return 'unknown';
  const lines = production.split('\n');
  let pending = false;
  for (const part of hunks) {
    const next = occurrences(lines, part.next), old = occurrences(lines, part.old);
    if (next === 1 && old === 0) continue;
    if (old === 1 && next === 0) { pending = true; continue; }
    return 'unknown';
  }
  return pending ? 'pending' : 'covered';
}

export async function inspectRepository(git: Git, input: { repositoryId: string; repoPath: string; baseSha?: string; productionRef?: string }): Promise<{ coverage: RepositoryCoverage; evidence: OrganizerEvidence[]; fingerprint: string; activityAt: string; complete: boolean }> {
  const coverage: RepositoryCoverage = { repositoryId: input.repositoryId, repoPath: input.repoPath, productionRef: input.productionRef || '', state: 'unknown', covered: 0, pending: 0, uncertain: 0, dirty: false, observedAt: new Date().toISOString() };
  const evidence: OrganizerEvidence[] = [];
  let activityAt = '', complete = true;
  try {
    const head = coverage.head = await git.commit('HEAD');
    if (!input.baseSha) throw Error('创建基线缺失');
    const base = coverage.baseSha = await git.commit(input.baseSha);
    if (!coverage.productionRef) {
      for (const ref of ['origin/main', 'origin/master']) {
        try { await git.commit(ref); coverage.productionRef = ref; break; } catch {}
      }
    }
    const status = await git.status(false, false, true);
    coverage.dirty = status.length > 0;
    const own = await git.run(['log', '--first-parent', '--no-merges', '--format=%H%x00%cI%x00%s', '--max-count=41', `${base}..${head}`, '--'], true, { maxBytes: 32768 });
    const commits = own.stdout.trim().split('\n').filter(Boolean);
    if (commits.length > 40) complete = false;
    for (const row of commits.slice(0, 40)) {
      const [sha, at, subject] = row.split('\0');
      if (!activityAt) activityAt = at;
      evidence.push({ id: `commit:${input.repositoryId}:${sha}`, kind: 'commit', text: subject, sha, repository: input.repositoryId });
    }
    const ownPaths = new Set<string>();
    if(commits.length) {
      const paths=await git.run(['diff-tree','--no-commit-id','--name-only','--no-renames','-r','-z','--stdin'],true,{maxBytes:128*1024,input:commits.slice(0,40).map(row=>row.split('\0')[0]).join('\n')+'\n'});
      for(const path of paths.stdout.split('\0').filter(Boolean))ownPaths.add(path);
    }
    const working = coverage.dirty ? await git.run(['diff', '--no-ext-diff', '--no-textconv', '--unified=2', 'HEAD', '--'], true, { maxBytes: 16384, truncate: true }) : null;
    if (working?.stdout) evidence.push({ id: `diff:${input.repositoryId}:${hash(working.stdout)}`, kind: 'diff', text: working.stdout, repository: input.repositoryId });
    if (working?.truncated) complete = false;
    const dirtyStats = [];
    for (const [, name] of status.slice(0, 80)) {
      const path = resolve(git.path, name.split('\0')[0]);
      if (!path.startsWith(git.path + sep)) { complete = false; continue; }
      const stat = await lstat(path).catch(() => null);
      dirtyStats.push([name, stat?.size, stat?.mtimeMs]);
      if (stat && new Date(stat.mtimeMs).toISOString() > activityAt) activityAt = new Date(stat.mtimeMs).toISOString();
    }
    if (status.length > 80) complete = false;
    const sourceFingerprint = hash(stable([base, head, working?.stdout, dirtyStats]));
    const raw = await git.run(['diff', '--raw', '-z', '--no-abbrev', '--no-renames', base, head, '--'], true, { maxBytes: 96 * 1024 });
    // Incoming mainline merges are not this Workspace's requirement changes.
    const changes = rawChanges(raw.stdout).filter(change=>ownPaths.has(change.path));
    if(changes.length) {
      const patch=await git.run(['diff','--no-ext-diff','--no-textconv','--unified=2',base,head,'--',...changes.slice(0,12).map(c=>c.path)],true,{maxBytes:12000,truncate:true});
      if(patch.stdout)evidence.push({id:`diff:${input.repositoryId}:${hash(patch.stdout)}`,kind:'diff',text:patch.stdout,repository:input.repositoryId});
    }
    if (!changes.length && !coverage.dirty) {
      coverage.state = ownPaths.size ? 'unknown' : 'discussion';
      if (ownPaths.size) coverage.reason = '提交已无净改动，不能据此确认已上线';
      return { coverage, evidence, fingerprint: sourceFingerprint, activityAt, complete };
    }
    if (!coverage.productionRef) throw Error('请配置生产分支');
    coverage.productionSha = await git.commit(coverage.productionRef);
    const productionIsAncestor = (await git.run(['merge-base', '--is-ancestor', coverage.productionSha, head], false)).code === 0;
    if (changes.length > 160) complete = false;
    for (const change of changes.slice(0, 160)) {
      const tree = await git.text(['ls-tree', '-z', coverage.productionSha, '--', change.path]);
      const entry = tree.match(/^(\d+) \w+ ([a-f0-9]+)\t/), productionOid = entry?.[2];
      if (missing(change.after) && !productionOid) { coverage.covered++; continue; }
      if (productionOid === change.after && entry?.[1] === change.mode) { coverage.covered++; continue; }
      if (productionOid === change.before || !productionOid && missing(change.before)) { coverage.pending++; continue; }
      if (!productionOid || missing(change.after) || change.mode === '160000' || change.mode === '120000' || entry?.[1] !== change.mode) { coverage.uncertain++; continue; }
      const size = Number(await git.text(['cat-file', '-s', productionOid]));
      if (size > 128 * 1024) { coverage.uncertain++; continue; }
      const patch = await git.run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--unified=3', base, head, '--', change.path], true, { maxBytes: 32768, truncate: true });
      if (patch.truncated) { coverage.uncertain++; continue; }
      const content = (await git.run(['cat-file', 'blob', productionOid], true, { maxBytes: 128 * 1024 })).stdout;
      const state = textPatchCoverage(patch.stdout, content);
      if (state === 'covered') coverage.covered++; else if (state === 'pending' || productionIsAncestor) coverage.pending++; else coverage.uncertain++;
    }
    if (coverage.dirty) coverage.pending++;
    if (!complete || coverage.uncertain) { coverage.state = 'unknown'; coverage.reason = '存在未完整读取或无法确认的代码变化'; }
    else if (coverage.covered && coverage.pending) coverage.state = 'partial';
    else coverage.state = coverage.pending ? 'pending' : 'deployed';
    return { coverage, evidence, fingerprint: sourceFingerprint, activityAt, complete };
  } catch (error) {
    if (git.signal?.aborted) throw error;
    coverage.reason = error instanceof Error ? error.message : '生产证据不可用';
    return { coverage, evidence, fingerprint: hash(stable([coverage.head, coverage.baseSha, evidence, coverage.reason])), activityAt, complete: false };
  }
}

export async function workspaceMaterials(observation: Observation, params: Json, signal?: AbortSignal): Promise<WorkspaceMaterial> {
  const workspace = await observation.workspaces.observationRecords.request('get', { workspaceId: String(params.workspaceId || '') });
  const instance = workspaceInstanceKey(workspace);
  if (params.instance && params.instance !== instance) throw Error('workspace_instance_changed');
  const evidence: OrganizerEvidence[] = [], repositories: RepositoryCoverage[] = [], fingerprints: string[] = [];
  let activityAt = workspace.createdAt || '', complete = true;
  const brief = String(workspace.taskBrief || workspace.description || '');
  if (brief) evidence.push({ id: 'goal:' + instance, kind: 'goal', text: (workspace.taskKind?'类型：'+workspace.taskKind+'\n':'')+brief });
  for (const repo of workspace.repositories) {
    if (signal?.aborted) throw Error('organizer_cancelled');
    const context = await observation.workspaces.observationRecords.request('context', { workspaceId: workspace.id, repository: repo.repoPath || repo.id });
    const git = new Git(context.path, Math.max(3000, observation.workspaces.config.gitTimeout), Date.now() + 25000, signal, true);
    if (await git.root() !== context.path) throw Error('repository_root_mismatch');
    const configured=observation.workspaces.config.repositories.find(r=>r.id===repo.id||r.path===repo.sourcePath);
    const result = await withBackgroundGit(() => inspectRepository(git, { repositoryId: repo.id, repoPath: repo.repoPath || repo.id, baseSha: repo.baseSha, productionRef: params.productionBranches?.[repo.sourcePath] || params.productionBranches?.[configured?.path||''] || params.productionBranches?.[repo.id] || params.productionBranches?.[repo.repoPath] }));
    result.coverage.sourcePath=repo.sourcePath;
    repositories.push(result.coverage); evidence.push(...result.evidence); fingerprints.push(result.fingerprint);
    if (result.activityAt > activityAt) activityAt = result.activityAt;
    complete &&= result.complete;
  }
  evidence.push({id:'hint:'+instance,kind:'hint',text:'工作区名称（仅作为弱线索）：'+(workspace.displayName||workspace.id)});
  return { workspaceId: workspace.id, instance, name: workspace.displayName || workspace.id, createdAt: workspace.createdAt || '', activityAt,
    ...(workspace.creator?.agentId ? { creatorAgentId: workspace.creator.agentId } : {}), taskBrief: brief, taskKind: workspace.taskKind,
    evidence, repositories, fingerprint: hash(stable([brief, workspace.taskKind, fingerprints])), state: aggregateProduction(repositories.map(r => r.state)), complete };
}
