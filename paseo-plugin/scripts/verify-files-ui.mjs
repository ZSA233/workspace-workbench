/** Actual isolated Paseo plugin + Chromium UI. Never touches the normal host or registry. */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { mkdir, readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium } from 'playwright';
import { DaemonClient } from '@getpaseo/client/internal/daemon-client';
import WebSocket from 'ws';
const plugin = resolve(import.meta.dirname, '..'), output = resolve(process.env.WORKBENCH_VERIFY_OUTPUT || join(plugin, '../.local/verification/files'));
await mkdir(output, { recursive: true });
let child, client, browser, ui, logs = '';
const report = { kind: 'actual-paseo-files-chromium', checks: [], errors: [], console: [], screenshots: [], limitations: ['Chromium on macOS; Windows native drag and native Save picker require Windows acceptance. Save export uses a real OPFS-backed file handle in this harness.'] };
const check = message => { report.checks.push(message); console.log(JSON.stringify({ check: message })); };
const pause = ms => new Promise(r => setTimeout(r, ms));
const wait = async (fn, timeout = 20000) => { const until = Date.now()+timeout; while (Date.now()<until) { const value = await fn(); if (value) return value; await pause(100); } throw Error('Timed out waiting for file proof'); };
try {
  if (process.env.WORKBENCH_FILES_HOST_LOG) ui = JSON.parse((await readFile(process.env.WORKBENCH_FILES_HOST_LOG, 'utf8')).split('\n').find(line => line.includes('"ui-ready"')));
  else {
    child = spawn(process.execPath, [join(plugin, 'scripts/verify-live.mjs')], { cwd: resolve(plugin, '..'), env: { ...process.env, WORKBENCH_LIVE_UI: '1', WORKBENCH_VERIFY_OUTPUT: output }, stdio: ['ignore', 'pipe', 'pipe'] });
    ui = await new Promise((resolveReady, reject) => { const timer = setTimeout(() => reject(Error('Isolated host did not start')), 90000); child.stderr.on('data', b => { logs += b; }); createInterface({ input: child.stdout }).on('line', line => { logs += line+'\n'; try { const value=JSON.parse(line); if(value.kind==='ui-ready') { clearTimeout(timer); resolveReady(value); } } catch {} }); child.once('exit', code => { clearTimeout(timer); reject(Error('Host exited: '+code)); }); });
  }
  if (child) await writeFile(join(output, 'files-ui-host.log'), logs);
  assert.match(ui.project, /^\/(?:private\/)?tmp\/wb-live-[^/]+\/a$/);
  await rm(join(ui.project, 'drag-proof.txt'), { force: true }); await rm(join(ui.project, 'drop-target'), { recursive: true, force: true });
  client = new DaemonClient({ url: `ws://${new URL(ui.url).host}/ws`, clientId: 'files-proof', clientType: 'mcp', reconnect: { enabled: false }, webSocketFactory: (url, options) => new WebSocket(url, options?.protocols, { headers: options?.headers }) }); await client.connect();
  const projectConfig = join(ui.project, 'project.json');
  const rpc = async request => { const response = await client.invokePluginRpc('workspace-workbench-paseo', 'workspace.workbench.files', { projectConfig, request }); assert.ok(response.ok, JSON.stringify(response.error)); return response.result; };
  const observer = async (method, params={}) => { const response = await client.invokePluginRpc('workspace-workbench-paseo', 'workspace.workbench.query', { projectConfig, method, params }); assert.ok(response.ok, JSON.stringify(response.error)); return response.result; };
  const created = await observer('workspace.create', { name: 'file-proof-space', repositories: ['one'] });
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } }); page.on('pageerror', e => report.errors.push(e.message));
  page.on('console', message => { if (['warning', 'error'].includes(message.type())) report.console.push({ type: message.type(), text: message.text() }); });
  await page.addInitScript(() => {
    window.__proofPickerCalls = [];
    window.showSaveFilePicker = async options => { window.__proofPickerCalls.push({ name: options.suggestedName, activated: navigator.userActivation.isActive }); const root = await navigator.storage.getDirectory(); const handle = await root.getFileHandle('workbench-proof-export', { create: true }); return handle; };
    window.__proofReads = [];
    window.__proofMutations = [];
    const send = WebSocket.prototype.send;
    WebSocket.prototype.send = function(data) {
      const inspect = value => { if (typeof value === 'string' && /^[\[{]/.test(value)) { try { inspect(JSON.parse(value)); } catch {} } else if (value && typeof value === 'object') { if (value.action === 'read' && typeof value.id === 'string') window.__proofReads.push({ id: value.id, offset: value.offset }); if (value.action === 'mutate' && typeof value.id === 'string') window.__proofMutations.push(value); for (const child of Object.values(value)) inspect(child); } };
      if (typeof data === 'string') inspect(data);
      return send.call(this, data);
    };
  });
  await page.goto(ui.url);
  await page.getByText('Workspace Workbench', { exact: true }).first().waitFor({ timeout: 20000 }); await pause(1000);
  if (await page.getByText('Add project', { exact: true }).first().isVisible().catch(() => false)) { await page.getByText('Add project', { exact: true }).first().click(); await page.getByText('Search for directory', { exact: true }).click(); await page.getByPlaceholder('Search directories or enter a path...').fill(ui.project); await page.getByText('Open this path', { exact: true }).click(); }
  await page.getByText('Workspace Workbench', { exact: true }).first().click();
  await page.getByText('Repositories', { exact: true }).filter({ visible: true }).first().waitFor({ timeout: 20000 });
  const gitTab = page.getByRole('tab', { name: 'Git', exact: true }), filesTab = page.getByRole('tab', { name: 'Files', exact: true });
  const gitBox = await gitTab.boundingBox(), filesBox = await filesTab.boundingBox();
  assert.ok(filesBox.x > gitBox.x && filesBox.x < gitBox.x + gitBox.width + 24, 'Files is immediately right of Git');
  check('Git is the default tab and Files follows it immediately');
  await page.getByText('Files', { exact: true }).click(); await page.locator('[data-file-path=""]').waitFor({ timeout: 20000 }); await page.locator('[data-file-path="one"]').waitFor({timeout:20000});
  const rootEntry = page.locator('[data-file-path=""]');
  await rootEntry.dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['drag upload proof\n'], 'drag-proof.txt', { type: 'text/plain', lastModified: 123 })); return data; }) });
  await wait(async () => { try { return await readFile(join(ui.project, 'drag-proof.txt'), 'utf8') === 'drag upload proof\n'; } catch { return false; } });
  const uploadCommitted = Date.now();
  await page.locator('[data-file-path="drag-proof.txt"]').waitFor({ timeout: 1200 }); report.uploadListDelayMs = Date.now() - uploadCommitted; check('external file drop uploads to the pinned main Workspace root and appears without a periodic refresh');
  const beforeChoice = (await rpc({ action: 'tasks', limit: 200 })).tasks.map(task => task.id).sort();
  await page.evaluate(() => { window.__proofRealPicker = window.showSaveFilePicker; window.showSaveFilePicker = () => new Promise((_resolve, reject) => { window.__proofCancelChoice = reject; }); });
  await page.locator('[data-file-path="drag-proof.txt"]').click({ button: 'right' }); await page.getByText('Download / ZIP', { exact: true }).click();
  await page.waitForFunction(() => Boolean(window.__proofCancelChoice));
  assert.deepEqual((await rpc({ action: 'tasks', limit: 200 })).tasks.map(task => task.id).sort(), beforeChoice, 'an unconfirmed picker creates no remote task');
  await page.evaluate(() => { window.__proofCancelChoice(new DOMException('User cancelled', 'AbortError')); window.showSaveFilePicker = window.__proofRealPicker; }); await pause(150);
  assert.deepEqual((await rpc({ action: 'tasks', limit: 200 })).tasks.map(task => task.id).sort(), beforeChoice, 'cancelling leaves the original task list unchanged');
  assert.equal(await page.getByText('User cancelled', { exact: true }).count(), 0);
  check('waiting for or cancelling the initial save location never creates a task or requires a queue action');
  await page.locator('[data-file-path="drag-proof.txt"]').click({ button: 'right' }); await page.getByText('Download / ZIP', { exact: true }).click();
  await wait(async () => (await rpc({ action: 'tasks', limit: 200 })).tasks.some(t => t.direction === 'download' && t.name === 'drag-proof.txt' && t.state === 'complete'));
  assert.deepEqual(await page.evaluate(() => window.__proofPickerCalls), [{ name: 'drag-proof.txt', activated: true }]);
  assert.equal(await page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle('workbench-proof-export')).getFile()).text()), 'drag upload proof\n');
  check('the initial Download gesture opens a save destination before RPC and saves automatically without a second queue action');
  await page.getByText('+ Folder', { exact: true }).click(); await page.getByText('New folder',{exact:true}).waitFor(); await page.getByRole('textbox').last().fill('drop-target'); await page.getByText('Confirm', { exact: true }).last().click();
  await page.locator('[data-file-path="drop-target"]').waitFor({ timeout: 20000 });
  const target = page.locator('[data-file-path="drop-target"]');
  await target.dispatchEvent('dragover', { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) }); await pause(800);
  await target.dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => { const data = new DataTransfer(); data.items.add(new File(['nested proof'], 'nested.txt')); return data; }) });
  await wait(async () => { try { return await readFile(join(ui.project, 'drop-target/nested.txt'), 'utf8') === 'nested proof'; } catch { return false; } }); check('hovered directory expands and receives a dropped file');
  const file = page.locator('[data-file-path="drag-proof.txt"]'); await file.click(); await page.getByText(/1 selected$/).waitFor({ timeout: 5000 }); await file.press('Control+c'); await target.click(); await target.press('Control+v');
  await wait(async () => { try { return await readFile(join(ui.project, 'drop-target/drag-proof.txt'), 'utf8') === 'drag upload proof\n'; } catch { return false; } }); check('keyboard Copy and Paste copies into the selected directory');
  const beforeNoops = (await rpc({ action: 'tasks', limit: 200 })).tasks.map(task => task.id).sort(), mutationCount = await page.evaluate(() => window.__proofMutations.length);
  for (const [source, landing] of [[file, rootEntry], [file, file], [target, target]]) {
    const data = await page.evaluateHandle(() => new DataTransfer());
    await source.dispatchEvent('dragstart', { dataTransfer: data }); await landing.dispatchEvent('dragover', { dataTransfer: data });
    assert.equal(await data.evaluate(value => value.dropEffect), 'none');
    await landing.dispatchEvent('drop', { dataTransfer: data }); await source.dispatchEvent('dragend', { dataTransfer: data });
  }
  await pause(250); assert.equal(await page.evaluate(() => window.__proofMutations.length), mutationCount);
  assert.deepEqual((await rpc({ action: 'tasks', limit: 200 })).tasks.map(task => task.id).sort(), beforeNoops);
  check('dragging back to the same folder, onto the file itself or onto its own directory creates neither an RPC nor a transfer row');
  await file.click(); await page.getByRole('button', { name: 'More file actions', exact: true }).click();
  const menuSelection = page.getByTestId('files-menu-selection');
  assert.match(await menuSelection.innerText(), /1 selected/); assert.match(await menuSelection.innerText(), /drag-proof\.txt/); assert.match(await menuSelection.innerText(), /Upload \/ new folder \/ paste into: \//);
  await page.screenshot({ path: join(output, 'file-menu-selected-path.png') }); report.screenshots.push('file-menu-selected-path.png');
  await page.getByText('Copy', { exact: true }).last().click();
  await file.click(); await target.click({ modifiers: ['Meta'] }); await page.getByRole('button', { name: 'More file actions', exact: true }).click();
  assert.match(await menuSelection.innerText(), /2 selected/); assert.match(await menuSelection.innerText(), /drag-proof\.txt/); assert.match(await menuSelection.innerText(), /drop-target/);
  await page.getByText('Copy', { exact: true }).last().click();
  check('the toolbar menu lists single and multiple selected paths separately from the upload/new-folder/paste directory');
  await page.evaluate(()=>{window.__proofNormalPicker=window.showSaveFilePicker;window.showSaveFilePicker=async options=>({createWritable:async()=>{const output=await(await window.__proofNormalPicker(options)).createWritable();return{write:bytes=>output.write(bytes),close:async()=>{await output.abort();throw new Error('Injected save cancellation')},abort:async()=>{await output.abort().catch(()=>{})}}}});});
  await target.click(); await target.click({ button: 'right' }); await page.getByText('Download / ZIP', { exact: true }).click();
  await page.getByRole('button', { name: 'Transfers', exact: true }).click();
  await page.getByText('Injected save cancellation',{exact:true}).waitFor({timeout:15000});
  assert.equal((await rpc({action:'tasks',limit:200})).tasks.find(t=>t.direction==='download'&&t.name==='drop-target.zip').state,'ready_to_save');
  check('a cancelled final writer retains the staged download and never marks it complete');
  await page.evaluate(()=>{window.showSaveFilePicker=window.__proofNormalPicker;});
  await page.getByText('Save to device', { exact: true }).first().click();
  await wait(async () => page.evaluate(async () => { try { const file = await (await (await navigator.storage.getDirectory()).getFileHandle('workbench-proof-export')).getFile(); return file.size > 0 && (await file.slice(0, 2).text()) === 'PK'; } catch { return false; } }));
  check('directory download streams ZIP to OPFS and exports through a closed file writer');
  const temp = await mkdtemp(join(tmpdir(), 'wb-upload-folder-'));
  try { await mkdir(join(temp, 'nested')); await writeFile(join(temp, 'nested/folder.txt'), 'folder chooser proof'); const chooser = page.waitForEvent('filechooser'); await page.getByText('Upload folder', { exact: true }).click(); await (await chooser).setFiles(temp); await wait(async () => { try { return await readFile(join(ui.project, 'drop-target', temp.split('/').at(-1), 'nested/folder.txt'), 'utf8') === 'folder chooser proof'; } catch { return false; } }); } finally { await rm(temp, { recursive: true, force: true }); }
  check('actual directory selection preserves nested paths');
  // Internal drag uses the actual browser DragEvent/DataTransfer path.
  if (!await page.locator('[data-file-path="drop-target/nested.txt"]').isVisible()) await page.locator('[data-file-path="drop-target"]').click();
  await page.locator('[data-file-path="drop-target/nested.txt"]').waitFor({ timeout: 15000 });
  await page.locator('[data-file-path="drop-target/nested.txt"]').dragTo(rootEntry);
  await wait(async () => { try { await readFile(join(ui.project, 'nested.txt')); return !(await readFile(join(ui.project, 'drop-target/nested.txt')).then(()=>true,()=>false)); } catch { return false; } });
  check('internal tree drag moves the file into the root directory');
  // macOS maps physical Control-click to a context menu. Exercise the Windows
  // modifier DragEvent path explicitly; physical Windows acceptance stays separate.
  const copyDrag = await page.evaluateHandle(() => new DataTransfer());
  await file.dispatchEvent('dragstart',{dataTransfer:copyDrag}); await target.dispatchEvent('dragover',{dataTransfer:copyDrag,ctrlKey:true}); await target.dispatchEvent('drop',{dataTransfer:copyDrag,ctrlKey:true});
  await page.getByText('Keep both',{exact:true}).waitFor({timeout:15000});await page.getByText('Keep both',{exact:true}).click();
  await wait(async()=>{try{return await readFile(join(ui.project,'drop-target/drag-proof (1).txt'),'utf8')==='drag upload proof\n';}catch{return false;}});
  assert.equal(await readFile(join(ui.project,'drag-proof.txt'),'utf8'),'drag upload proof\n');check('Windows Ctrl-copy DragEvent path and Keep both preserve the original (synthetic modifier)');

  await page.locator('[data-file-path="nested.txt"]').click(); await page.locator('[data-file-path="nested.txt"]').press('F2');
  await page.getByText('Rename', { exact: true }).waitFor();
  await page.getByRole('textbox').last().fill('renamed-proof.txt'); await page.getByText('Confirm', { exact: true }).last().click();
  await wait(async()=>{try{return await readFile(join(ui.project,'renamed-proof.txt'),'utf8')==='nested proof';}catch{return false;}});
  await page.locator('[data-file-path="renamed-proof.txt"]').waitFor({timeout:15000}); await page.locator('[data-file-path="renamed-proof.txt"]').click({button:'right'}); await page.getByText('Delete permanently…',{exact:true}).click();
  await page.getByText('Confirm permanent deletion',{exact:true}).waitFor(); const deleteStarted = Date.now(); await page.getByText('Delete permanently',{exact:true}).click();
  await page.locator('[data-file-path="renamed-proof.txt"]').waitFor({state:'detached',timeout:1500}); report.deleteListDelayMs = Date.now() - deleteStarted;
  await wait(async()=>!(await readFile(join(ui.project,'renamed-proof.txt')).then(()=>true,()=>false)));check('rename shortcut and reviewed permanent deletion work through real UI actions');
  await file.click(); await file.press('Control+c'); await page.getByText(/1 copied$/).waitFor({timeout:5000});
  await page.getByText('Main workspace',{exact:true}).first().click(); await page.getByText('file-proof-space',{exact:true}).first().click();
  await page.getByRole('button',{name:'file-proof-space',exact:true}).waitFor({timeout:15000}); await page.locator('[data-file-path="one"]').waitFor({timeout:15000});
  await page.locator('[data-file-path=""]').press('Control+v');
  await wait(async()=>{try{return await readFile(join(created.treePath,'drag-proof.txt'),'utf8')==='drag upload proof\n';}catch{return false;}});
  check('Workspace switching retains Files tab and clipboard pastes into the new Workspace root');
  await page.getByText('Git',{exact:true}).click(); await page.getByRole('button',{name:'Transfers',exact:true}).waitFor(); check('transfer summary stays mounted on the Git Workspace tab');
  await page.getByText('Files',{exact:true}).filter({visible:true}).click();

  const currentRoot = page.locator('[data-file-path=""]');
  await page.locator('[data-file-path="one"]').waitFor({ timeout: 15000 });
  await currentRoot.dispatchEvent('drop', { dataTransfer: await page.evaluateHandle(() => { const data = new DataTransfer(); const bytes = new Uint8Array(2*1024*1024+17); bytes.fill(0x5a); data.items.add(new File([bytes], 'pinned-large.bin', { lastModified: 42 })); return data; }) });
  await page.getByText('Git', {exact:true}).click(); await page.getByText('file-proof-space',{exact:true}).first().click(); await page.getByText('Main workspace',{exact:true}).first().click();
  await wait(async()=>{try{return (await readFile(join(created.treePath,'pinned-large.bin'))).length===2*1024*1024+17;}catch{return false;}});
  assert.equal(await readFile(join(ui.project,'pinned-large.bin')).then(()=>true,()=>false),false);
  check('multi-chunk upload stays pinned to its original Workspace after switching tabs and spaces');
  await page.getByText('Files',{exact:true}).filter({visible:true}).click(); await page.locator('[data-file-path="drag-proof.txt"]').waitFor({timeout:15000});

  const resumeTemp = await mkdtemp(join(tmpdir(), 'wb-upload-resume-'));
  try {
    const originalPath = join(resumeTemp, 'reselect-proof.bin'), bytes = Buffer.alloc(2*512*1024+17, 0x63);
    await writeFile(originalPath, bytes);
    await page.evaluate(() => {
      const slice = File.prototype.slice;
      File.prototype.slice = function(start, end, type) {
        const blob = slice.call(this, start, end, type);
        if (this.name === 'reselect-proof.bin' && start >= 512*1024) return { arrayBuffer: async () => { window.__proofUploadBlocked = true; await new Promise(() => {}); } };
        return blob;
      };
    });
    await page.locator('[data-file-path=""]').click();
    const [chooser] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('↑ Upload', { exact: true }).click()]); await chooser.setFiles(originalPath);
    await wait(() => page.evaluate(() => window.__proofUploadBlocked));
    const upload = (await rpc({action:'tasks',limit:200})).tasks.find(t => t.direction === 'upload' && t.name === 'reselect-proof.bin');
    assert.equal(upload.offset, 512*1024);
    await page.reload(); await page.getByText('Workspace Workbench',{exact:true}).first().waitFor({timeout:20000}); await page.getByText('Workspace Workbench',{exact:true}).first().click();
    await page.getByRole('button',{name:'Transfers',exact:true}).click(); await page.getByText('Select original file',{exact:true}).waitFor({timeout:15000});
    const [reselect] = await Promise.all([page.waitForEvent('filechooser'), page.getByText('Select original file',{exact:true}).click()]); await reselect.setFiles(originalPath);
    await wait(async () => (await rpc({action:'task',id:upload.id})).state === 'complete');
    assert.deepEqual(await readFile(join(ui.project,'reselect-proof.bin')), bytes);
    check('browser refresh preserves the upload ID and confirmed prefix; selecting the original file verifies and resumes it');
  } finally { await rm(resumeTemp,{recursive:true,force:true}); }

  const mainId = (await rpc({action:'tasks',limit:200})).tasks.find(t => t.direction === 'upload' && t.name === 'reselect-proof.bin').workspaceId;
  const resumeDownloadId = 'refresh_download_' + Date.now(), downloadBytes = Buffer.alloc(3*512*1024+31, 0x6b);
  await writeFile(join(ui.project,'refresh-proof.bin'),downloadBytes);
  await page.evaluate(() => {
    const create = FileSystemFileHandle.prototype.createWritable;
    FileSystemFileHandle.prototype.createWritable = async function(options) {
      const stream = await create.call(this,options);
      if (this.name !== 'progress' || window.__proofStagedOnce) return stream;
      return { write: data => stream.write(data), abort: () => stream.abort(), close: async () => { await stream.close(); window.__proofStagedOnce = true; await new Promise(() => {}); } };
    };
  });
  await rpc({action:'download',id:resumeDownloadId,workspaceId:mainId,paths:['refresh-proof.bin']});
  await wait(() => page.evaluate(() => window.__proofStagedOnce));
  assert.equal((await rpc({action:'task',id:resumeDownloadId})).offset,0,'refresh happens after local durability and before the ACK');
  await page.reload(); await page.getByText('Workspace Workbench',{exact:true}).first().waitFor({timeout:20000}); await page.getByText('Workspace Workbench',{exact:true}).first().click();
  await wait(async () => (await rpc({action:'task',id:resumeDownloadId})).state === 'ready_to_save');
  const resumedReads = await page.evaluate(id => window.__proofReads.filter(read => read.id === id),resumeDownloadId);
  assert.equal(resumedReads[0]?.offset,512*1024,'the closed OPFS prefix survives refresh without redownloading offset zero');
  await page.getByRole('button',{name:'Transfers',exact:true}).click(); await page.getByText('Save to device',{exact:true}).first().click();
  await wait(async () => (await rpc({action:'task',id:resumeDownloadId})).state === 'complete');
  assert.equal(await page.evaluate(async () => { const file = await (await (await navigator.storage.getDirectory()).getFileHandle('workbench-proof-export')).getFile(); return file.size === 3*512*1024+31 && new Uint8Array(await file.arrayBuffer()).every(value => value === 0x6b); }),true);
  check('browser refresh recovers closed OPFS chunks before a lost ACK, continues at the next offset and exports the complete file');
  await page.getByText('Files',{exact:true}).filter({visible:true}).click(); await page.locator('[data-file-path="drag-proof.txt"]').waitFor({timeout:15000});
  await page.evaluate(()=>{window.__proofPicker=window.showSaveFilePicker;window.showSaveFilePicker=undefined;});
  const delegatedDownload = page.waitForEvent('download');
  await page.locator('[data-file-path="drag-proof.txt"]').click({button:'right'}); await page.getByText('Download / ZIP',{exact:true}).click();
  const downloaded = await delegatedDownload;
  const downloadPath = join(output,'browser-download-proof.txt');await downloaded.saveAs(downloadPath);assert.equal(await readFile(downloadPath,'utf8'),'drag upload proof\n');
  await page.getByText('Handed to browser',{exact:false}).first().waitFor({timeout:15000});check('verified same-origin host token delegates a download and reports browser ownership without a false completion');
  await page.evaluate(()=>{window.showSaveFilePicker=window.__proofPicker;});

  await page.screenshot({ path: join(output, 'files-tree-and-transfers.png') }); report.screenshots.push('files-tree-and-transfers.png');
  report.page = { url: page.url(), title: await page.title(), nonBlank: (await page.locator('body').innerText()).includes('Workspace Workbench'), frameworkOverlay: await page.locator('vite-error-overlay,nextjs-portal').count() };
  assert.ok(report.page.nonBlank); assert.equal(report.page.frameworkOverlay, 0); assert.equal(report.console.some(message => message.type === 'error'), false);
  assert.deepEqual(report.errors, []); report.ok = true;
} catch (e) { report.ok = false; report.error = e.stack || String(e); if (browser) { const page = browser.contexts()[0]?.pages()[0]; if (page) { await page.screenshot({ path: join(output, 'files-failure.png') }).catch(() => {}); await writeFile(join(output, 'files-failure.txt'), await page.locator('body').innerText().catch(() => '')); } } process.exitCode=1; }
finally { await browser?.close(); await client?.close(); if (ui && child) { await writeFile(ui.continueFile, 'done'); await Promise.race([new Promise(r => child.once('exit', r)), pause(30000)]); } await writeFile(join(output, 'files-ui-report.json'), JSON.stringify(report,null,2)); await writeFile(join(output, 'files-ui-host.log'), logs); console.log(JSON.stringify(report,null,2)); }
