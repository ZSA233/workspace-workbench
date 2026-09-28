import test from 'node:test';
import assert from 'node:assert/strict';
import { RecordCatalog } from '../server/backend/record-catalog.ts';
function fixture(count = 20) {
    const files = new Map(Array.from({ length: count }, (_, i) => [`/records/${i}.json`, { version: 1, text: JSON.stringify({ id: String(i), history: { unknown: 'preserved' } }) }]));
    let running = 0, peak = 0, reads = 0;
    const io = {
        names: async () => [...files.keys()].map(p => p.split('/').pop()!),
        version: async (path: string) => { const f = files.get(path); if (!f)
            throw Object.assign(Error('missing'), { code: 'ENOENT' }); return { dev: 1, ino: 1, size: f.text.length, mtimeMs: f.version, ctimeMs: f.version }; },
        read: async (path: string) => { reads++; running++; peak = Math.max(peak, running); try {
            await new Promise(r => setTimeout(r, 10));
            return files.get(path)!.text;
        }
        finally {
            running--;
        } }
    };
    return { files, io, stats: () => ({ running, peak, reads }) };
}
test('catalog bounds concurrent reads and reuses only matching file identities', async () => {
    const f = fixture(), catalog = new RecordCatalog(f.io);
    const first = await catalog.read('/records');
    assert.equal(first.length, 20);
    assert.equal(f.stats().peak, 4);
    assert.equal(f.stats().reads, 20);
    assert.equal(first[0].value?.history.unknown, 'preserved');
    await catalog.read('/records');
    assert.equal(f.stats().reads, 20);
    assert.equal(catalog.health().hits, 20);
    const changed = f.files.get('/records/0.json')!;
    changed.version++;
    changed.text = JSON.stringify({ id: '0', changed: true });
    const second = await catalog.read('/records');
    assert.equal(f.stats().reads, 21);
    assert.equal(second.find(x => x.path.endsWith('/0.json'))?.value?.changed, true);
    f.files.delete('/records/0.json');
    f.files.set('/records/new.json', { version: 1, text: '{"id":"new"}' });
    const third = await catalog.read('/records');
    assert.equal(third.length, 20);
    assert.equal(third.some(x => x.path.endsWith('/0.json')), false);
    assert.equal(f.stats().reads, 22);
});
test('concurrent edits are not cached as current; failures retain execution slots until reads finish', async () => {
    const f = fixture(8), original = f.io.read;
    let change = true;
    f.io.read = async (path) => { const text = await original(path); if (change && path === '/records/0.json') {
        change = false;
        f.files.get(path)!.version++;
    } return text; };
    const catalog = new RecordCatalog(f.io);
    await assert.rejects(catalog.read('/records'), (e: any) => e.code === 'observer_records_changed');
    assert.equal(f.stats().running, 0);
    const result = await catalog.read('/records');
    assert.equal(result.length, 8);
    assert.equal(catalog.health().active, 0);
    assert.equal(f.stats().reads, 9);
});
test('invalid JSON stays explicit while I/O failures cannot masquerade as an empty catalog', async () => {
    const f = fixture(1);
    f.files.get('/records/0.json')!.text = '{invalid';
    const catalog = new RecordCatalog(f.io);
    assert.equal((await catalog.read('/records'))[0].value, null);
    f.files.get('/records/0.json')!.version++;
    f.io.read = async () => { throw Object.assign(Error('permission denied'), { code: 'EACCES' }); };
    await assert.rejects(catalog.read('/records'), /permission denied/);
});

test('non-regular JSON entries are invalid records rather than blocking reads', async () => {
    const catalog = new RecordCatalog({
        names: async () => ['pipe.json'],
        version: async () => ({dev:1,ino:1,size:0,mtimeMs:1,ctimeMs:1,isFile:()=>false}),
        read: async () => { throw Error('non-regular file must not be opened'); },
    });
    assert.deepEqual(await catalog.read('/records'), [{path:'/records/pipe.json',value:null}]);
    assert.equal(catalog.health().reads, 0);
});
