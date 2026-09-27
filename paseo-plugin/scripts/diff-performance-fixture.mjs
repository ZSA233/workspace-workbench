import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);
export async function createDiffPerformanceFixture(repo) {
  const directory = join(repo, 'diff-performance');
  await mkdir(directory, { recursive: true });
  for (let start = 0; start < 20_000; start += 100) {
    await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(directory, `file-${String(start + i).padStart(5, '0')}.txt`), `original ${start + i}\n`)));
  }
  await exec('git', ['-C', repo, 'add', 'diff-performance'], { timeout: 30_000 });
  await exec('git', ['-C', repo, 'commit', '-qm', 'Diff performance fixture'], { timeout: 30_000 });
  for (let start = 0; start < 500; start += 100) await Promise.all(Array.from({ length: 100 }, (_, i) => writeFile(join(directory, `file-${String(start + i).padStart(5, '0')}.txt`), `changed ${start + i}\n`)));
  await writeFile(join(repo, 'large-untracked-proof.txt'), Buffer.alloc(32 * 1024 * 1024, 'line\n'));
  return { tracked: 20_000, changed: 500, untrackedBytes: 32 * 1024 * 1024 };
}
export const percentile95 = samples => [...samples].sort((a, b) => a - b)[Math.ceil(samples.length * .95) - 1];
