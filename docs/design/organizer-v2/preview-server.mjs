/** Local design review. Reads the installed plugin; only explicitly requested model tests mutate its test log. */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, realpathSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const assets=import.meta.dirname;
const output=resolve(process.env.WORKBENCH_DESIGN_DATA||join(assets,'../../../dist/design/yuva-v2'));
const dataFile=join(output,'data.json'), resultFile=join(output,'model-results.json');
const data=JSON.parse(readFileSync(dataFile,'utf8'));
const ownTests=new Map(existsSync(resultFile)?JSON.parse(readFileSync(resultFile,'utf8')):[]);
const token=randomBytes(24).toString('hex');
const cli=realpathSync(execFileSync('which',['paseo'],{encoding:'utf8'}).trim());
const {withPluginManagementClient}=await import(pathToFileURL(resolve(dirname(cli),'../dist/commands/plugin/shared.js')).href);
const call=request=>withPluginManagementClient({kind:'instance',home:process.env.PASEO_HOME||join(homedir(),'.paseo')},async client=>{
  const response=await client.invokePluginRpc('workspace-workbench-paseo','workspace.workbench.organizer',{projectConfig:data.project.configPath,request});
  if(!response.ok)throw Error(response.error||'organizer_unavailable');
  return response.result;
});
const save=()=>writeFileSync(resultFile,JSON.stringify([...ownTests],null,2),{mode:0o600});
function materialFor(workspace){
  const evidence=[];let remaining=7600;
  for(const item of workspace.material.evidence.filter(e=>e.kind!=='hint')){
    const copy={id:item.id,kind:item.kind,repository:item.repository,sha:item.sha,text:item.text.slice(0,item.kind==='diff'?1400:700),truncated:item.text.length>(item.kind==='diff'?1400:700)};
    const size=Buffer.byteLength(JSON.stringify(copy));if(size>remaining)break;evidence.push(copy);remaining-=size;
  }
  if(!evidence.length)throw Error('这个工作区还没有可用于分析的目标、提交或改动材料');
  return JSON.stringify({workspaceId:workspace.material.workspaceId,goal:workspace.material.taskBrief||null,evidence,coverage:{submitted:evidence.length,available:workspace.material.evidence.filter(e=>e.kind!=='hint').length,excerptedSources:evidence.filter(e=>e.truncated).length,complete:evidence.length===workspace.material.evidence.filter(e=>e.kind!=='hint').length&&evidence.every(e=>!e.truncated)}});
}
const embedded=value=>JSON.stringify(value).replace(/</g,'\\u003c');
function document(offline=false){return readFileSync(join(assets,'index.html'),'utf8').replace('/* DESIGN_DATA */null',()=>embedded({...data,live:!offline,results:[...ownTests.values()]}));}
const server=createServer(async(req,res)=>{
  const origin=`http://127.0.0.1:${server.address().port}`,url=new URL(req.url||'/',origin);
  const json=(status,value)=>{res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(value));};
  try{
    if(url.pathname==='/'&&req.method==='GET'){
      res.setHeader('Set-Cookie',`workbench_design=${token}; HttpOnly; SameSite=Strict; Path=/`);
      res.setHeader('Content-Type','text/html; charset=utf-8');res.setHeader('Cache-Control','no-store');res.end(document());return;
    }
    if(url.pathname==='/app.js'||url.pathname==='/style.css'){
      res.setHeader('Content-Type',url.pathname.endsWith('.js')?'text/javascript; charset=utf-8':'text/css; charset=utf-8');res.end(readFileSync(join(assets,url.pathname.slice(1))));return;
    }
    if(!url.pathname.startsWith('/api/')){res.writeHead(404);res.end();return;}
    if(!(req.headers.cookie||'').split(';').map(x=>x.trim()).includes(`workbench_design=${token}`)){json(403,{error:'请从设计预览首页进入'});return;}
    if(req.method==='POST'&&req.headers.origin!==origin){json(403,{error:'origin_mismatch'});return;}
    if(req.method==='GET'&&url.pathname==='/api/run'){
      const id=url.searchParams.get('id');const entry=ownTests.get(id);if(!entry)throw Error('本设计稿未发起此任务');
      const test=await call({action:'profile.test.result',testId:id});ownTests.set(id,{...entry,test});save();json(200,{...entry,test});return;
    }
    if(req.method==='GET'&&url.pathname==='/api/model') {json(200,await call({action:'profile.check',profileId:data.profile.id}));return;}
    if(req.method==='GET'&&url.pathname==='/api/progress'){
      const snapshot=await call({action:'snapshot'});data.snapshot.jobs=snapshot.jobs;json(200,{at:new Date().toISOString(),jobs:snapshot.jobs});return;
    }
    if(req.method==='POST'){
      let body='';for await(const part of req){body+=part;if(Buffer.byteLength(body)>4096)throw Error('request_too_large');}const input=JSON.parse(body||'{}');
      if(url.pathname==='/api/generate'){
        if([...ownTests.values()].some(e=>['queued','running'].includes(e.test.state)))throw Error('已有一个模型预览在运行');
        const workspace=data.snapshot.workspaces.find(w=>w.material.workspaceId===input.workspaceId);if(!workspace)throw Error('workspace_missing');
        const text=materialFor(workspace),test=await call({action:'profile.test',profileId:data.profile.id,text,prompt:data.policy.prompt+'\n本次是连接测试。所有事项的 evidenceIds 只能引用外层唯一来源 test:input，不能引用材料内部的提交 SHA、路径或内部 ID。'});
        const entry={workspaceId:workspace.material.workspaceId,workspaceKey:workspace.key,submittedAt:new Date().toISOString(),input:text,test};ownTests.set(test.id,entry);save();json(200,entry);return;
      }
      if(url.pathname==='/api/cancel'){
        if(!ownTests.has(input.id))throw Error('本设计稿未发起此任务');await call({action:'profile.test.cancel',testId:input.id});json(200,{ok:true});return;
      }
      if(url.pathname==='/api/export'){
        const css=readFileSync(join(assets,'style.css'),'utf8'),js=readFileSync(join(assets,'app.js'),'utf8');
        const html=document(true).replace('<link rel="stylesheet" href="/style.css">',()=>`<style>${css}</style>`).replace('<script src="/app.js" defer></script>',()=>`<script>${js.replace(/<\/script/gi,'<\\/script')}</script>`);
        const file=join(output,'YUVA-Workbench-设计预览.html');writeFileSync(file,html,{mode:0o600});json(200,{file});return;
      }
    }
    json(404,{error:'unknown_route'});
  }catch(error){json(400,{error:error.message});}
});
server.listen(Number(process.env.WORKBENCH_DESIGN_PORT||0),'127.0.0.1',()=>{
  const url=`http://127.0.0.1:${server.address().port}`;writeFileSync(join(output,'server.json'),JSON.stringify({url,pid:process.pid}),{mode:0o600});console.log(JSON.stringify({url,output,scope:'Design review; model tests only. No native title, project settings or archive writes.'}));
});
