import test from 'node:test';
import assert from 'node:assert/strict';
import { tryAccessDownload } from '../client/access-download.ts';

const token = '00000000-1111-2222-3333-444444444444';
function fixture(ua = 'AccessPocket/0.2.9', options: { missing?: boolean; hostile?: boolean } = {}) {
  const requests: any[] = [], clicks: string[] = [];
  const web = { URL, location: { href: 'https://paseo.test/', origin: 'https://paseo.test' }, navigator: { userAgent: ua },
    document: { body: { appendChild() {} }, createElement() { return { href: '', download: '', rel: '', click() { clicks.push(this.href); }, remove() {} }; } },
    async fetch(path: string, init: any) {
      requests.push({ path, init });
      if (path.endsWith('capabilities')) return { ok: !options.missing, status: options.missing ? 404 : 200, json: async () => ({ download_handoff_version: 1, entry_server_id: 'mini' }) };
      return { ok: true, status: 201, json: async () => ({ download_url: options.hostile ? 'https://evil.test/file' : '/__access/paseo/downloads/' + 'a'.repeat(64) + (ua.includes('AccessPocket') ? '/start' : '/content') }) };
    } };
  return { web, requests, clicks };
}
test('routed host uses its identity and an opaque same-origin handoff', async () => {
  const f = fixture(); assert.equal(await tryAccessDownload('/api/files/download?token=' + token, 'studio', '实验.zip', f.web), true);
  assert.deepEqual(JSON.parse(f.requests[1].init.body), { server_id: 'studio', token, filename: '实验.zip', transport: 'native' });
  assert.equal(f.clicks.length, 1); assert.ok(f.clicks[0].endsWith('/start')); assert.ok(!f.clicks[0].includes(token));
});
test('ordinary browser consumes content directly and absent adapter preserves legacy path', async () => {
  const browser = fixture('Chrome'); assert.equal(await tryAccessDownload('/api/files/download?token=' + token, 'studio', 'x', browser.web), true); assert.ok(browser.clicks[0].endsWith('/content'));
  const missing = fixture('Chrome', { missing: true }); assert.equal(await tryAccessDownload('/api/files/download?token=' + token, 'studio', 'x', missing.web), false); assert.equal(missing.requests.length, 1);
});
test('rejects origin escape and unknown native downloader before creating a ticket', async () => {
  for (const url of ['https://evil.test/api/files/download?token=' + token, '/api/files/download?token=' + token + '&token=' + token, '/api/files/download?token=' + token + '&url=http://evil']) {
    const f = fixture(); await assert.rejects(tryAccessDownload(url, 'studio', 'x', f.web)); assert.equal(f.requests.length, 0);
  }
  for (const ua of ['AccessPocket/0.2.8', 'Android; wv) Chrome']) { const f = fixture(ua); await assert.rejects(tryAccessDownload('/api/files/download?token=' + token, 'studio', 'x', f.web)); assert.equal(f.requests.length, 1); }
  const hostile = fixture('AccessPocket/0.2.9', { hostile: true }); await assert.rejects(tryAccessDownload('/api/files/download?token=' + token, 'studio', 'x', hostile.web)); assert.equal(hostile.clicks.length, 0);
});
