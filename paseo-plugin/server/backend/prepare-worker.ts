import { parentPort, workerData } from 'node:worker_threads';
import { Runtime } from './runtime.ts';
import { issue } from './storage.ts';
const abort = new AbortController();
parentPort!.on('message', message => { if (message === 'close')
    abort.abort(); });
try {
    const runtime = new Runtime(workerData.config);
    runtime.signal = abort.signal;
    runtime.onProgress = (phase, tool) => parentPort!.postMessage({ progress: { phase, tool, at: Date.now() } });
    const saved = workerData.inspect ? runtime.load(workerData.workspace) : null;
    const result = workerData.inspect ? workerData.workspace.repositories.map((repo: any) => {
        const entry = saved?.[repo.id], requirements = runtime.requirements[repo.id] || {};
        return { id: repo.id, ready: entry?.status === 'ready' && runtime.ready(entry, requirements), result: entry };
    }) : await runtime.prepare(workerData.workspace, workerData.repositoryId);
    parentPort!.postMessage({ result });
}
catch (error) {
    parentPort!.postMessage({ error: issue(error) });
}
finally {
    parentPort!.close();
}
