import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { buildSync } from 'esbuild';

const binary = process.env.HERMES_BINARY || new URL('../node_modules/react-native/sdks/hermesc/osx-bin/hermes', import.meta.url).pathname;
const available = existsSync(binary) && (process.platform === 'darwin' || !!process.env.HERMES_BINARY);

test('Hermes source evaluation constructs refresh readers without prototype failures', {skip: !available && 'Set HERMES_BINARY to run the native engine regression'}, () => {
  const entry = `
    import('./client/repository-refresh-client.ts').then(function(module) { var Reader = module.createRepositoryRefreshClient;
    for (var i = 0; i < 3; i++) {
      var reader = Reader();
      reader.retry('one');
      reader.releaseRefresh('one', function() { throw Error('empty reader dispatched'); });
      if (typeof reader.readRefresh !== 'function') throw Error('reader unavailable');
    }
    print('native-refresh-ok');
    import('./client/observation-coordinator.ts').then(function(m) { var c = m.createObservationCoordinator('p', {queries:function(){return [];},read:function(){return Promise.resolve({ok:true,result:{}});},issue:function(){}}); c.close(); print('native-coordinator-ok'); }).catch(function(e){print('FAILED: '+e.stack);});
    });
  `;
  const source = buildSync({stdin:{contents:entry,resolveDir:new URL('..',import.meta.url).pathname,loader:'ts'},bundle:true,tsconfigRaw:{compilerOptions:{alwaysStrict:true}},format:'cjs',platform:'neutral',target:'es2020',supported:{'async-await':false},write:false}).outputFiles[0].text;
  const root = mkdtempSync(join(tmpdir(), 'wb-native-refresh-'));
  try {
    const path = join(root, 'evaluate.js');
    // The native plugin loader evaluates source, rather than Metro bytecode.
    // Cross the native loader's large-source lazy-compilation threshold.
    const evaluatedSource = `/*${' '.repeat(100000)}*/\n${source}`;
    writeFileSync(path, `eval(${JSON.stringify(evaluatedSource)}); setTimeout(function(){}, 0);`);
    const output = execFileSync(binary, ['-w', '-lazy', '-Xes6-promise', '-Xmicrotask-queue', path], {encoding:'utf8',timeout:15000});
    assert.match(output, /native-refresh-ok/);
    assert.match(output, /native-coordinator-ok/);
    assert.doesNotMatch(output, /FAILED/);
  } finally { rmSync(root,{recursive:true,force:true}); }
});
