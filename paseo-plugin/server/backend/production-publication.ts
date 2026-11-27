import {posix} from 'node:path';
import type {Git} from './git.ts';
import {requirementReversal} from './production-text.ts';

export type ProductionChange={path:string;oldMode:string;mode:string;before:string;after:string};
type Publication={basis:'identical-tree'|'integrated'|'source-integrated';rollbackPaths:string[];review?:boolean};
const missing=(oid:string|undefined)=>!oid||/^0+$/.test(oid);
const hashedAsset=/^assets\/[\w.-]+-[\w-]{6,}\.(?:js|css)(?:\.map)?$/;

/** A generated bundle is identified by both committed module manifests and
 * existing production objects, never by a commit subject or directory name. */
async function bundles(git:Git,head:string,production:string,paths:string[]){
 const candidates=new Set<string>();
 for(const path of paths){if(posix.basename(path)==='index.html')candidates.add(posix.dirname(path));const match=path.match(/^(.*)\/assets\/[\w.-]+-[\w-]{6,}\.(?:js|css)(?:\.map)?$/);if(match)candidates.add(match[1]);}
 const roots:Array<{prefix:string;replaced:boolean}>=[];
 for(const root of [...candidates].slice(0,8))try{
  const prefix=root==='.'?'':root+'/',path=prefix+'index.html';
  const read=async(ref:string)=>{const entry=await git.run(['ls-tree','-z',ref,'--',path],true,{maxBytes:4096});if(!/^100(?:644|755) blob /.test(entry.stdout))throw Error('bundle_manifest_unavailable');return(await git.run(['show',ref+':'+path],true,{maxBytes:65536})).stdout;};
  const old=await read(head),current=await read(production);
  const assets=(html:string)=>[...html.matchAll(/(?:src|href)=["'](?:\.\/|\/)?(assets\/[\w.-]+-[\w-]{6,}\.(?:js|css))["']/g)].map(m=>m[1]);
  const before=assets(old),after=assets(current);
  if(!/type=["']module["']/.test(old)||!/type=["']module["']/.test(current)||!before.some(p=>p.endsWith('.js'))||!after.some(p=>p.endsWith('.js')))continue;
  let complete=true;for(const asset of after){const result=await git.run(['ls-tree','-z',production,'--',prefix+asset],true,{maxBytes:4096});if(!/^100(?:644|755) blob /.test(result.stdout)){complete=false;break;}}
  if(complete)roots.push({prefix,replaced:old!==current});
 }catch{if(git.signal?.aborted)throw Error('observer_cancelled');}
 return roots;
}

/** Commit integration and current-content equivalence are different proofs.
 * Normal production evolution must not turn an integrated requirement red.
 * Positive rollback evidence still invalidates that publication. */
export async function publishedRequirement(git:Git,input:{base:string;head:string;production:string;paths:string[];changes:ProductionChange[]}):Promise<Publication|undefined>{
 const {base,head,production,paths,changes}=input;
 if(head===production||await git.text(['rev-parse',head+'^{tree}'])===await git.text(['rev-parse',production+'^{tree}']))return{basis:'identical-tree',rollbackPaths:[]};
 const integrated=(await git.run(['merge-base','--is-ancestor',head,production],false)).code===0;
 const roots=await bundles(git,head,production,paths),generated=(path:string,replaced=false)=>roots.some(r=>(!replaced||r.replaced)&&path.startsWith(r.prefix)&&(path.slice(r.prefix.length)==='index.html'||hashedAsset.test(path.slice(r.prefix.length))));
 let basis:Publication['basis']='integrated';
 if(!integrated){
  if(!paths.some(p=>!generated(p)))return;
  const remaining=await git.run(['rev-list','--max-count=41',head,'--not',production,'--'],true,{maxBytes:8192});
  const commits=remaining.stdout.trim().split('\n').filter(Boolean);if(!commits.length||commits.length>40)return;
  for(const sha of commits){const changed=await git.run(['diff-tree','--root','--no-commit-id','--name-only','--no-renames','-r','-m','--first-parent','-z',sha],true,{maxBytes:128*1024,truncate:true});const names=changed.stdout.split('\0').filter(Boolean);if(changed.truncated||!names.length||names.some(p=>!generated(p,true)))return;}
  basis='source-integrated';
 }
 // An explicit revert can be followed by a reapplication. Let the complete
 // content verifier handle that case instead of trusting either log alone.
 const history=await git.run(['log','--ancestry-path','--format=%B%x1e','--max-count=2001',head+'..'+production],true,{maxBytes:256*1024,truncate:true});
 if(history.truncated)return{basis,rollbackPaths:[],review:true};
 const reverted=[...new Set([...history.stdout.matchAll(/This reverts commit ([a-f0-9]{40,64})\b/gi)].map(m=>m[1]))];
 if(reverted.length>20)return{basis,rollbackPaths:[],review:true};
 if(reverted.length){const own=await git.run(['rev-list','--first-parent','--no-merges','--max-count=2001',base+'..'+head],true,{maxBytes:160*1024,truncate:true});const hashes=own.stdout.trim().split('\n');if(own.truncated||hashes.length>2000)return{basis,rollbackPaths:[],review:true};if(reverted.some(sha=>hashes.includes(sha)))return{basis,rollbackPaths:[],review:true};}
 const tree=new Map<string,{oid:string;mode:string}>();
 for(let i=0;i<changes.length;i+=100){const names=changes.slice(i,i+100).map(c=>c.path),raw=await git.run(['ls-tree','-r','-z',production,'--',...names],true,{maxBytes:256*1024,truncate:true});if(raw.truncated)return{basis,rollbackPaths:[],review:true};for(const row of raw.stdout.split('\0')){const m=row.match(/^(\d+) \w+ ([a-f0-9]+)\t([\s\S]+)$/);if(m)tree.set(m[3],{oid:m[2],mode:m[1]});}}
 const source=changes.filter(c=>!generated(c.path)),rollback=new Set<string>(),reversed=new Set<string>();
 const restored=(c:ProductionChange)=>missing(c.before)?!tree.has(c.path):tree.get(c.path)?.oid===c.before&&tree.get(c.path)?.mode===c.oldMode;
 if(source.length&&source.every(restored)&&await git.text(['rev-parse',base+'^{tree}'])===await git.text(['rev-parse',production+'^{tree}']))return{basis,rollbackPaths:source.map(c=>c.path)};
 for(const change of source){
  const current=tree.get(change.path);if(current?.oid===change.after&&current.mode===change.mode)continue;
  // Restoring a deleted housekeeping file beside an integrated requirement is
  // not, by itself, proof that the requirement was rolled back.
  if(missing(change.after))continue;
  if(restored(change)&&!missing(change.before)){reversed.add(change.path);continue;}
  // A later move, split or retirement is not proof of an unpublished commit.
  // Explicit reverts and a restoration of the original implementation are.
  if(!current){if(missing(change.before))reversed.add(change.path);continue;}
  if(!current||current.mode!==change.mode||['160000','120000'].includes(change.mode))continue;
  const sizes=await Promise.all([change.after,current.oid].map(oid=>git.text(['cat-file','-s',oid])));if(sizes.some(s=>Number(s)>128*1024))continue;
  const own=await git.run(['diff','--no-ext-diff','--no-textconv','--no-renames','--unified=0',base,head,'--',change.path],true,{maxBytes:32768,truncate:true});
  const later=await git.run(['diff','--no-ext-diff','--no-textconv','--no-renames','--diff-algorithm=myers','--unified=0',change.after,current.oid],true,{maxBytes:32768,truncate:true});
  if(!own.truncated&&!later.truncated){const reversal=requirementReversal(own.stdout,later.stdout,(await git.run(['cat-file','blob',change.after],true,{maxBytes:128*1024})).stdout,(await git.run(['cat-file','blob',current.oid],true,{maxBytes:128*1024})).stdout);if(reversal.conflicting)rollback.add(change.path);if(reversal.complete)reversed.add(change.path);}
 }
 if(source.length&&source.every(c=>reversed.has(c.path))){const delta=await git.run(['diff','--name-only','--no-renames','-z',head,production,'--'],true,{maxBytes:256*1024,truncate:true});const scope=new Set(source.map(c=>c.path));if(!delta.truncated&&delta.stdout.split('\0').filter(Boolean).every(p=>scope.has(p)||generated(p)))for(const path of reversed)rollback.add(path);}
 return{basis,rollbackPaths:[...rollback]};
}
