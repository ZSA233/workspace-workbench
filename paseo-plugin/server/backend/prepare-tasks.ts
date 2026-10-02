import { resolveRuntimeDeclarations } from './runtime-declarations.ts';
import { taskIdentity } from "../../shared/task-state.ts";
import { Worker, type WorkerOptions } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { writeOperation } from './operation-storage.ts';
import { issue, stable, WorkbenchError, type Json } from './storage.ts';
import type { Workspaces } from './workspaces.ts';
/** Durable mutations outlive UI subscribers. Exactly one project operation executes. */
export class PrepareTasks {
    readonly generation = randomUUID();
    private records = new Map<string, Json>();
    private loaded?: Promise<void>;
    private flight?: Promise<void>;
    private worker?: Worker;
    private closed = false;
    private serial: Promise<unknown> = Promise.resolve();
    private workspaces: Workspaces;
    private changed: (workspaceId: string) => void;
    private workerFactory = (options: WorkerOptions) => new Worker(new URL('./prepare-worker.ts', import.meta.url), options);
    constructor(workspaces: Workspaces, changed: (workspaceId: string) => void) { this.workspaces = workspaces; this.changed = changed; }
    private get root() { return join(this.workspaces.config.stateRoot, 'prepare-operations'); }
    private save(record: Json) { return writeOperation(join(this.root, `${record.operationId}.json`), record); }
    private load() {
        return this.loaded ||= (async () => {
            const files = await readdir(this.root).catch((error) => { if (error.code === 'ENOENT')
                return []; throw error; });
            for (const file of files.filter(name => /^[a-f0-9-]+\.json$/.test(name))) {
                const record = JSON.parse(await readFile(join(this.root, file), 'utf8'));
                if (['queued', 'running'].includes(record.state)) {
                    record.state = 'interrupted';
                    record.phase = 'reconcile';
                    record.error = { code: 'operation_interrupted', message: 'Preparation interrupted; verify completed steps before continuing' };
                    const verified = await new Promise<Json[]>((resolve, reject) => {
                        const worker = this.workerFactory({ execArgv: ['--experimental-strip-types'], workerData: { config: record.config, workspace: record.workspace, inspect: true } });
                        let received = false;
                        worker.once('message', message => { received = true; message.error ? reject(new Error(message.error.message)) : resolve(message.result); });
                        worker.once('error', reject);
                        worker.once('exit', () => { if (!received)
                            reject(new Error('Preparation reconciliation exited')); });
                    }).catch(() => []);
                    for (const repo of record.repositories) {
                        const item = verified.find(value => value.id === repo.id);
                        repo.state = item?.ready ? 'ready' : 'interrupted';
                        if (item?.ready)
                            repo.result = item.result;
                    }
                    if (record.repositories.every((repo: Json) => repo.state === 'ready')) {
                        record.state = 'ready';
                        record.phase = 'reconciled';
                        delete record.error;
                    }
                    await this.save(record);
                }
                this.records.set(record.operationId, record);
            }
        })();
    }
    active(workspaceId: string) { return [...this.records.values()].some(r => r.workspaceId === workspaceId && ['queued', 'running'].includes(r.state)); }
    async request(params: Json): Promise<Json> {
        if (params.action === "status")
            return this.requestLocked(params);
        const run = this.serial.then(() => this.requestLocked(params));
        this.serial = run.catch(() => { });
        return run;
    }
    private async requestLocked(params: Json): Promise<Json> {
        await this.load();
        if (params.action === 'status') {
            const active = (record: Json) => ['queued', 'running'].includes(record.state) ? 1 : 0;
            const recent = [...this.records.values()].sort((a, b) => active(b) - active(a) || Number(b.updatedAt || b.acceptedAt) - Number(a.updatedAt || a.acceptedAt));
            const record = params.operationId ? this.records.get(String(params.operationId)) : recent.find(r => params.requestId ? r.requestIds.includes(params.requestId) : r.workspaceId === params.workspaceId);
            return record ? this.snapshot(record) : { protocol: 1, state: 'idle' };
        }
        if (this.closed)
            throw new WorkbenchError('observer_closed', 'Preparation service closed');
        if (!['start', 'continue'].includes(params.action || 'start'))
            throw new WorkbenchError('request_invalid', 'Unknown preparation action');
        if (!this.workspaces.config.managementEnabled || !this.workspaces.config.toolchain && params.workspaceId === "main")
            throw new WorkbenchError('capability_unavailable', 'Runtime preparation disabled');
        const requestId = String(params.requestId || '');
        if (!requestId || requestId.length > 200)
            throw new WorkbenchError('request_invalid', 'Preparation requestId required');
        const existing = [...this.records.values()].find(r => r.requestIds.includes(requestId));
        if (existing && params.action !== 'continue') {
            const aliases = params.repositories || (params.repositoryId ? [params.repositoryId] : existing.workspace.repositories.map((repo: Json) => repo.id));
            if (!Array.isArray(aliases))
                throw new WorkbenchError('request_invalid', 'Preparation repositories must be an array');
            const ids = [...new Set(aliases.map((alias: string) => this.workspaces.repository(existing.workspace, alias).id))].sort();
            if (existing.workspaceId !== params.workspaceId || stable(ids) !== stable(existing.repositories.map((repo: Json) => repo.id).sort()))
                throw new WorkbenchError('request_identity_conflict', 'Request belongs to another workspace or preparation scope');
            return this.snapshot(existing);
        }
        const workspace = await this.workspaces.observationRecords.request('get', { workspaceId: String(params.workspaceId || '') });
        if (!workspace.managed)
            throw new WorkbenchError('workspace_not_managed', 'Workspace is not managed');
        const requested = params.repositories || (params.repositoryId ? [params.repositoryId] : workspace.repositories.map((r: Json) => r.id));
        if (!Array.isArray(requested) || !requested.length || requested.length > 256)
            throw new WorkbenchError("request_invalid", "Preparation requires a bounded repository list");
        const repositories = [...new Set<string>(requested.map((id: string) => this.workspaces.repository(workspace, id).id))];
        const resolved = await resolveRuntimeDeclarations(this.workspaces.config, {...workspace, repositories: workspace.repositories.filter((repo: Json) => repositories.includes(repo.id))});
        const identity = stable({ workspaceId: workspace.id, repositories: [...repositories].sort(), requirements: resolved.config.toolchain });
        const active = [...this.records.values()].find(r => r.workspaceId === workspace.id && ['queued', 'running'].includes(r.state));
        if (active) {
            if (active.identity !== identity)
                throw new WorkbenchError('operation_conflict', 'A different preparation is already active');
            active.requestIds.push(requestId);
            await this.save(active);
            return this.snapshot(active);
        }
        let record: Json;
        if (params.action === 'continue') {
            record = this.records.get(String(params.operationId))!;
            if (!record || record.workspaceId !== workspace.id || record.identity !== identity || !['failed', 'interrupted'].includes(record.state))
                throw new WorkbenchError('operation_conflict', 'Preparation cannot be continued with a different scope');
            record = { ...record, state: 'queued', error: undefined, requestIds: [...new Set([...record.requestIds, requestId])] };
        }
        else {
            if ([...this.records.values()].filter(record => ['queued', 'running'].includes(record.state)).length >= 32)
                throw new WorkbenchError('operation_capacity', 'Preparation queue capacity reached');
            record = { protocol: 1, operationId: randomUUID(), requestIds: [requestId], identity, workspaceId: workspace.id, workspace, config: resolved.config, state: 'queued', phase: 'queued', acceptedAt: Date.now(), repositories: repositories.map(id => ({ id, state: 'queued' })) };
        }
        record.updatedAt = Date.now();
        await this.save(record);
        this.records.set(record.operationId, record);
        this.pump();
        return this.snapshot(record);
    }
    private snapshot(record: Json) { const { config, workspace, identity, ...value } = record; return { ...value, ...taskIdentity(record.operationId, this.generation, record.state, record.phase, record.acceptedAt) }; }
    private pump() {
        if (this.flight || this.closed)
            return;
        const record = [...this.records.values()].find(r => r.state === 'queued');
        if (!record)
            return;
        this.flight = this.execute(record).catch(async (error) => { record.state = 'interrupted'; record.error = issue(error); await this.save(record).catch(() => { }); }).finally(() => { this.flight = undefined; this.pump(); });
    }
    private async execute(record: Json) {
        record.state = 'running';
        record.phase = 'prepare';
        await this.save(record);
        for (const repo of record.repositories) {
            if (this.closed) {
                record.state = 'interrupted';
                break;
            }
            if (repo.state === 'ready')
                continue;
            // Revalidate workspace identity immediately before a persisted side effect.
            const current = await this.workspaces.observationRecords.request('get', { workspaceId: record.workspaceId });
            if (stable(current.repositories) !== stable(record.workspace.repositories))
                throw new WorkbenchError('workspace_changed', 'Workspace repositories changed during preparation');
            repo.state = 'running';
            record.updatedAt = Date.now();
            await this.save(record);
            const result = await new Promise<Json>((resolve, reject) => {
                const worker = this.workerFactory({ execArgv: ['--experimental-strip-types'], workerData: { config: record.config, workspace: current, repositoryId: repo.id } });
                this.worker = worker;
                if (this.closed)
                    worker.postMessage("close");
                let settled = false;
                worker.on('message', message => { if (message.progress) {
                    record.phase = message.progress.phase;
                    record.tool = message.progress.tool;
                    record.updatedAt = message.progress.at;
                    return;
                } settled = true; message.error ? reject(new WorkbenchError(message.error.code, message.error.message)) : resolve(message.result); });
                worker.once('error', reject);
                worker.once('exit', () => { if (this.worker === worker)
                    this.worker = undefined; if (!settled)
                    reject(new WorkbenchError('operation_interrupted', 'Preparation worker exited')); });
            });
            repo.result = result;
            repo.state = result.status === 'ready' ? 'ready' : 'failed';
            record.updatedAt = Date.now();
            await this.save(record);
            this.changed(record.workspaceId);
            if (repo.state === 'failed') {
                record.state = this.closed ? 'interrupted' : 'failed';
                break;
            }
        }
        if (record.state === 'running')
            record.state = 'ready';
        record.phase = record.state;
        record.updatedAt = Date.now();
        await this.save(record);
        this.changed(record.workspaceId);
    }
    async wait(operationId: string, budgetMs = 1500): Promise<Json> {
        const deadline = Date.now() + budgetMs;
        let state = await this.request({ action: 'status', operationId });
        while (['queued', 'running'].includes(state.state) && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, Math.min(100, deadline - Date.now())));
            state = await this.request({ action: 'status', operationId });
        }
        return state;
    }
    async close() { this.closed = true; await this.serial; await this.loaded?.catch(() => { }); this.worker?.postMessage('close'); await this.flight; for (const record of this.records.values())
        if (record.state === "queued") {
            record.state = "interrupted";
            record.phase = "shutdown";
            await this.save(record);
        } }
}
