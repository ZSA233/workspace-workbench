import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, stat, readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProperties, serializeProperties, restoreSigning, cleanupSigning } from '../signing.mjs';

test('signing properties preserve escaping using the real JDK Properties reader', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'pocket-properties-test-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const values = { storeFile: 'C:\\test path\\release.p12', storePassword: ' #=se\\cret\n行🚀 ', keyAlias: 'pocket', keyPassword: 'test\tpass' };
  const text = serializeProperties(values);
  assert.deepEqual(parseProperties(text), values);
  assert.equal(parseProperties('storeFile=C\\:\\\\folder\\\\key.p12\n').storeFile, 'C:\\folder\\key.p12');
  assert.equal(parseProperties('keyAlias=po\\\n  cket\n').keyAlias, 'pocket');
  assert.throws(() => parseProperties('keyAlias=a\nkeyAlias=b\n'));
  await writeFile(join(parent, 'signing.properties'), text);
  await writeFile(join(parent, 'Probe.java'), `import java.util.*; import java.nio.file.*; public class Probe { public static void main(String[] args) throws Exception {
    var p = new Properties(); try(var in = Files.newInputStream(Path.of(args[0]))) { p.load(in); }
    if (!p.getProperty("storePassword").equals(" #=se\\\\cret\\n行🚀 ")) throw new Exception("Properties round trip failed");
    System.out.print("ok"); } }`);
  assert.equal(execFileSync('java', [join(parent, 'Probe.java'), join(parent, 'signing.properties')], { encoding: 'utf8', timeout: 30000 }).trim(), 'ok');
});
test('runner signing restore uses private files outside checkout and ownership-checked cleanup', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'pocket-signing-test-')); t.after(() => rm(parent, { recursive: true, force: true }));
  const environment = { ANDROID_KEYSTORE_BASE64: Buffer.from('test fixture only').toString('base64'), ANDROID_STORE_PASSWORD: ' test\\pass ',
    ANDROID_KEY_ALIAS: 'fixture', ANDROID_KEY_PASSWORD: 'fake\npassword' };
  const result = await restoreSigning(environment, parent);
  assert.equal((await stat(result.directory)).mode & 0o777, 0o700);
  assert.equal((await stat(result.config)).mode & 0o777, 0o600);
  const properties = parseProperties(await readFile(result.config, 'utf8'));
  assert.equal(properties.storePassword, environment.ANDROID_STORE_PASSWORD);
  assert.equal(properties.keyPassword, environment.ANDROID_KEY_PASSWORD);
  assert.equal((await stat(properties.storeFile)).mode & 0o777, 0o600);
  await assert.rejects(cleanupSigning(parent, parent), /ownership/);
  await cleanupSigning(result.directory, parent);
  assert.deepEqual(await readdir(parent), []);
});
test('missing or invalid secrets never create private runner files', async t => {
  const parent = await mkdtemp(join(tmpdir(), 'pocket-invalid-signing-')); t.after(() => rm(parent, { recursive: true, force: true }));
  await assert.rejects(restoreSigning({}, parent), /Configure repository secret/);
  await assert.rejects(restoreSigning({ ANDROID_KEYSTORE_BASE64: 'invalid!!', ANDROID_STORE_PASSWORD: 'x', ANDROID_KEY_ALIAS: 'x', ANDROID_KEY_PASSWORD: 'x' }, parent), /Invalid encoded/);
  assert.deepEqual(await readdir(parent), []);
});
