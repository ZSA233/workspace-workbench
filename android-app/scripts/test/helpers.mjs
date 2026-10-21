import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { git } from '../../../scripts/release-android.mjs';

export async function gitFixture() {
  const parent = await mkdtemp(join(tmpdir(), 'pocket-release-test-'));
  const remote = join(parent, 'remote.git'), root = join(parent, 'checkout');
  git(parent, ['init', '--bare', '--initial-branch=main', remote]);
  git(parent, ['clone', remote, root]);
  git(root, ['config', 'user.name', 'Release Test']);
  git(root, ['config', 'user.email', 'release@example.invalid']);
  await mkdir(join(root, 'android-app'), { recursive: true });
  await writeFile(join(root, 'android-app/version.properties'), 'versionName=0.1.1\nversionCode=2\n');
  await writeFile(join(root, 'source.txt'), 'existing application\n');
  await writeFile(join(root, '.gitignore'), 'output/\n');
  git(root, ['add', '.']); git(root, ['commit', '-m', 'Initial']); git(root, ['push', 'origin', 'main']);
  return { parent, root, remote };
}
