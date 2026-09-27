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
    for (const file of ['mcp.mjs','mcp-gateway.mjs','shared/request-scheduler.mjs','shared/mcp-router.mjs','server/paseo-endpoint.mjs','server/backend/observation-records-worker.ts','server/backend/observation-records.ts','server/backend/derived-json.ts']) assert.ok(entries.includes(file),file);
  } finally { rmSync(output,{recursive:true,force:true}); }
});
