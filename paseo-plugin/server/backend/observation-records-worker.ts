import { parentPort } from 'node:worker_threads';
import { Workspaces } from './workspaces.ts';
import { canonical, issue, stable, withCanonicalSnapshot } from './storage.ts';
let workspaces: Workspaces | undefined;
let configuration = '';
parentPort!.on('message', async ({ id, operation, input, config, event }) => {
  try {
    if (event === 'invalidate') { workspaces?.invalidateOrphanScan(); return; }
    const next = stable(config);
    if (!workspaces || configuration !== next) {
      workspaces = new Workspaces(config); configuration = next;
      workspaces.onOrphanScanChanged = workspaces.onDiscoveryChanged = () => parentPort!.postMessage({ event: 'roster-changed' });
    }
    const value = await withCanonicalSnapshot(async () => {
      if (operation === 'supplements') {
        if (input.snapshotOnly) return workspaces!.observationSupplementSnapshot();
        const orphanScan = await workspaces!.orphanSnapshot(input.force === true, 250);
        const discovered = await workspaces!.discoverySnapshot(false, 0);
        return { orphanScan, discovered };
      }
      if (operation === 'roster') return { workspaces: await workspaces!.roster() };
      if (operation === 'list') return workspaces!.list();
      if (operation === 'identify') return workspaces!.identify(input.directory);
      const workspace = workspaces!.get(input.workspaceId);
      if (operation === 'get') return workspace;
      if (operation !== 'context') throw Error('Unknown observation metadata operation');
      const repo = workspaces!.repository(workspace, input.repository);
      return { workspace, repo, path: canonical(repo.worktreePath || repo.sourcePath) };
    });
    parentPort!.postMessage({ id, value, ...(operation === 'roster' ? {recordReads:workspaces!.recordReadHealth()} : {}) });
  } catch (error) { parentPort!.postMessage({ id, error: issue(error) }); }
});
