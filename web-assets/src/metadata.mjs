import { createPublicKey, verify } from 'node:crypto';
import { readFile } from 'node:fs/promises';

export const trust = JSON.parse(await readFile(new URL('../trust.json', import.meta.url), 'utf8'));
export const limits = Object.freeze({ metadata: 1024 * 1024, archive: 64 * 1024 * 1024,
  expanded: 256 * 1024 * 1024, files: 4096, file: 64 * 1024 * 1024 });

export function httpsUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash)
    throw new Error('An HTTPS URL without credentials or fragment is required');
  return url;
}

export function verifyMetadata(raw, policy = trust) {
  if (raw?.name !== policy.packageName || typeof raw.version !== 'string' ||
      raw.version.length > 80 || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(raw.version))
    throw new Error('Invalid package identity or version');
  const dist = raw.dist;
  if (typeof dist?.integrity !== 'string' || !/^sha512-[A-Za-z0-9+/]{86}==$/.test(dist.integrity))
    throw new Error('Expected one SHA-512 integrity digest');
  httpsUrl(dist.tarball);
  const payload = Buffer.from(`${raw.name}@${raw.version}:${dist.integrity}`);
  const signatures = Array.isArray(dist.signatures) ? dist.signatures.slice(0, 16) : [];
  const valid = signatures.some(({ keyid, sig } = {}) => {
    const key = policy.keys.find(k => k.keyid === keyid);
    if (!key || typeof sig !== 'string' || sig.length > 512) return false;
    try { return verify('sha256', payload, createPublicKey({ key: Buffer.from(key.publicKey, 'base64'),
      format: 'der', type: 'spki' }), Buffer.from(sig, 'base64')); }
    catch { return false; }
  });
  if (!valid) throw new Error('Untrusted or invalid npm signature; a new APK may be required for a new key');
  return { name: raw.name, version: raw.version, dist: { tarball: dist.tarball,
    integrity: dist.integrity, signatures } };
}

export async function fetchHttps(url, options = {}) {
  let current = httpsUrl(url);
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await fetch(current, { ...options, redirect: 'manual' });
    if (response.status >= 300 && response.status < 400) {
      const next = response.headers.get('location');
      await response.body?.cancel();
      if (!next) throw new Error('Redirect without location');
      current = httpsUrl(new URL(next, current).href);
      continue;
    }
    if (!response.ok) { await response.body?.cancel(); throw new Error(`HTTP ${response.status}`); }
    return response;
  }
  throw new Error('Too many redirects');
}

export async function readMetadata(url, signal = AbortSignal.timeout(30_000)) {
  const response = await fetchHttps(url, { signal });
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > limits.metadata) throw new Error('Metadata exceeds size limit');
    chunks.push(chunk);
  }
  return verifyMetadata(JSON.parse(Buffer.concat(chunks).toString('utf8')));
}
