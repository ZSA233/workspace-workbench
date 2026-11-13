// The freshly built web UI must work with the exact backend claimed by the
// release descriptor, in a disposable home/project registry and browser.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {createInterface} from 'node:readline';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve} from 'node:path';
const root=resolve(import.meta.dirname,'../..');
const {chromium}=await import(process.env.PLAYWRIGHT_MODULE_PATH);
if(!process.env.WORKBENCH_LIVE_WEB_DIST)throw new Error('Fresh web dist required');
const child=spawn(process.execPath,['paseo-plugin/scripts/verify-live.mjs'],{cwd:root,env:{...process.env,WORKBENCH_LIVE_UI:'1'},stdio:['ignore','pipe','pipe']});
let ui,browser,currentPage,errors=[],hostResult;
const exit=new Promise(resolveExit=>child.once('exit',resolveExit));
const ready=new Promise((accept,reject)=>{
 const timer=setTimeout(()=>reject(Error('Isolated web host timed out')),180_000);
 const lines=createInterface({input:child.stdout});
 lines.on('line',line=>{try{const v=JSON.parse(line);if(v.kind==='ui-ready'){clearTimeout(timer);accept(v);}}catch{}});
 child.once('exit',code=>{clearTimeout(timer);reject(Error(`Isolated web host exited early (${code})`));});
 child.stderr.on('data',()=>{}); // Isolated host owns its bounded private error log.
});
const evidence=resolve(root,'.local/web-release/evidence');await mkdir(evidence,{recursive:true});
try {
 ui=await ready;
 const status=await (await fetch(ui.url+'/api/status')).json();assert.equal(status.version,'0.15.4');
 browser=await chromium.launch({headless:true,...(process.env.CHROME_EXECUTABLE?{executablePath:process.env.CHROME_EXECUTABLE}:{})});
 const page=await browser.newPage({viewport:{width:1280,height:900}});currentPage=page;page.on('pageerror',e=>errors.push(e.message));
  await page.goto(ui.url);await page.getByText(/^Add (?:a )?project$/).filter({visible:true}).first().waitFor();
  const skip=page.getByText('Skip setup',{exact:true});if(await skip.isVisible())await skip.click();
  const dismiss=page.getByLabel('Dismiss',{exact:true}).last();if(await dismiss.isVisible())await dismiss.click();
  await page.getByText(/^Add (?:a )?project$/).filter({visible:true}).first().click();
  await page.getByText('Search for directory',{exact:true}).click();await page.getByPlaceholder('Search directories or enter a path...').fill(ui.project);
  await page.getByText('Open this path',{exact:true}).click();await page.getByText('Workspace Workbench',{exact:true}).first().click();
  await page.getByText('Repositories',{exact:true}).filter({visible:true}).first().waitFor({timeout:30_000});
  await page.getByText('one',{exact:true}).filter({visible:true}).first().waitFor({timeout:30_000});
 for(const width of [1280,390]) {
  await page.setViewportSize({width,height:900});
  await page.getByText('Repositories',{exact:true}).filter({visible:true}).first().waitFor();
  assert.equal(await page.locator('vite-error-overlay').count(),0);
  await page.screenshot({path:resolve(evidence,`web-${width}.png`)});
 }
 assert.deepEqual(errors,[]);hostResult={ok:true,backend:'0.15.4',viewports:[1280,390],fresh_dist:true,plugin_rpc:true,isolated_home:true};
} catch(error) {
 if(currentPage&&!currentPage.isClosed()){await currentPage.screenshot({path:resolve(evidence,'failure.png')});await writeFile(resolve(evidence,'failure.txt'),(await currentPage.locator('body').innerText()).slice(0,30000));}
 throw error;
} finally {
 if(browser)await browser.close();
 if(ui)await writeFile(ui.continueFile,'continue');else child.kill('SIGTERM');
 const code=await Promise.race([exit,new Promise(r=>setTimeout(()=>{child.kill('SIGTERM');r(1);},15_000).unref())]);
 if(code!==0)throw Error('Actual host lifecycle regression failed');
}
await writeFile(resolve(evidence,'result.json'),JSON.stringify(hostResult,null,2));console.log(JSON.stringify(hostResult));
