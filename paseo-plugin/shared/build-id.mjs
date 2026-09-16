import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
export function buildId(paths) {
  const hash = createHash('sha256');
  for (const path of paths) hash.update(readFileSync(new URL(path, import.meta.url)));
  return hash.digest('hex').slice(0, 16);
}
