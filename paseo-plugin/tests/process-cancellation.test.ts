import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
import { command } from '../server/backend/process.ts';

test('cancelling a failed spawn never signals the caller process group', async () => {
  // Keep the regression in an owned detached group so a reintroduced pid-0
  // signal fails this test without killing the test runner or other programs.
  const module = pathToFileURL(join(import.meta.dirname, '../server/backend/process.ts')).href;
  const code = `import {command} from ${JSON.stringify(module)};const abort=new AbortController();const pending=command('git',['status'],{cwd:'/nonexistent-workbench-cancellation-fixture',signal:abort.signal});abort.abort();try{await pending;process.exitCode=2;}catch(e){if(!['observer_cancelled','process_unavailable'].includes(e.code))throw e;console.log('survived');}`;
  const child = spawn(process.execPath, ['--experimental-strip-types','--input-type=module','-e',code], { detached: process.platform !== 'win32', stdio:['ignore','pipe','pipe'] });
  let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);
  const timer=setTimeout(()=>{if(child.pid)child.kill('SIGKILL');},5000);
  const codeResult=await new Promise<number|null>((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);}).finally(()=>clearTimeout(timer));
  assert.equal(codeResult,0,output);assert.match(output,/survived/);
});
test('already cancelled work never spawns a process', async () => {
  const abort=new AbortController();abort.abort();
  await assert.rejects(command('nonexistent-workbench-executable',[],{cwd:'/',signal:abort.signal}), (error:any)=>error.code==='observer_cancelled');
});
