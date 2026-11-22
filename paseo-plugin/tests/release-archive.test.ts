import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { resolve, join } from 'node:path';
import { execFileSync } from 'node:child_process';
// @ts-ignore repository packaging script
import { buildArchive } from '../../scripts/package_plugin.mjs';

test('release archive contains the gateway and shared connection runtime', async () => {
  const output = mkdtempSync(join(tmpdir(), 'workbench-release-'));
  try {
    const archive = await buildArchive(resolve(import.meta.dirname,'../..'),output);
    const entries = execFileSync('tar',['-tzf',archive],{encoding:'utf8'}).split('\n');
    assert.ok(!entries.some(entry => entry.startsWith('client/pocket-sdk/')), 'Release must not contain the retired Pocket sidebar SDK');
    for (const file of ['shared/extensions/project-communications/shared.ts','shared/extensions/project-communications/service-contract.ts','client/extensions/project-communications/topics-panel.tsx', 'client/extensions/project-communications/topic-row.tsx', 'client/extensions/project-communications/topic-basket.tsx', 'client/extensions/project-communications/topic-settings.tsx', 'client/extensions/project-communications/topic-ui.tsx', 'client/use-topics.ts', 'client/topic-selection.ts', 'shared/extensions/project-communications/topics.ts', 'shared/artifact-limits.ts', 'server/archive-topics.ts', 'server/topic-materials.ts', 'client/extensions/project-communications/ui.tsx','server/communications-connection.ts','mcp.mjs','mcp-gateway.mjs','shared/request-scheduler.mjs','shared/mcp-router.mjs','server/paseo-endpoint.mjs','server/backend/observation-records-worker.ts','server/backend/observation-records.ts','server/backend/derived-json.ts', 'server/backend/prepare-worker.ts', 'server/backend/prepare-tasks.ts', 'server/backend/operation-storage.ts', 'shared/task-state.ts']) assert.ok(entries.includes(file),file);
  } finally { rmSync(output,{recursive:true,force:true}); }
});
