// Release automation operates on immutable upstream commits. Building is an
// isolated CI concern; consumers only need the published archive/descriptor.
import {readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {fileURLToPath} from 'node:url';

const root=fileURLToPath(new URL('../../',import.meta.url));
export function recipeIdentity(recipe, version) {
  if (recipe.schema!==1 || !/^[a-z0-9-]+$/.test(recipe.id) || version.trim()!==version || !new RegExp(recipe.version_pattern).test(version) || !/^\d+\.\d+\.\d+$/.test(version) || !/^wb\.\d+$/.test(recipe.recipe_version)) throw new Error('Unsupported source or recipe version');
  return {version:`${version}-${recipe.recipe_version}`,tag:`${recipe.id}-web-v${version}-${recipe.recipe_version}`};
}
async function github(path, options={}) {
  const response=await fetch(`https://api.github.com/${path}`,{...options,signal:AbortSignal.timeout(30_000),headers:{Accept:'application/vnd.github+json',...(process.env.GH_TOKEN?{Authorization:`Bearer ${process.env.GH_TOKEN}`}:{})}});
  if (response.status===404) return null;
  if (!response.ok) throw new Error(`GitHub API status ${response.status}`);
  return response.json();
}
export async function resolveRelease(recipe, version, repository) {
  const latest=await github(`repos/${recipe.repository}/releases/${version?`tags/v${version}`:'latest'}`);
  if(!latest||latest.draft||latest.prerelease||!/^v\d+\.\d+\.\d+$/.test(latest.tag_name)) throw new Error('Stable upstream release required');
  const upstream=latest.tag_name.slice(1), identity=recipeIdentity(recipe,upstream);
  const reference=await github(`repos/${recipe.repository}/git/ref/tags/${latest.tag_name}`);
  if(!reference)throw new Error('Upstream tag unavailable');
  let object=reference.object;
  for(let depth=0;object.type==='tag'&&depth<5;depth++)object=(await github(`repos/${recipe.repository}/git/tags/${object.sha}`)).object;
  if(object.type!=='commit'||!/^[a-f0-9]{40}$/.test(object.sha))throw new Error('Immutable upstream commit required');
  const existing=await github(`repos/${repository}/releases/tags/${identity.tag}`);
  if(existing) {
    if(existing.draft||!existing.assets.some(a=>a.name==='frontend-release.json')||!existing.assets.some(a=>a.name==='SHA256SUMS')) throw new Error('Incomplete existing release requires operator review');
    return {...identity,exists:true};
  }
  return {...identity,exists:false,schema:1,recipe:recipe.id,upstream_version:upstream,source_commit:object.sha,source_url:`https://codeload.github.com/${recipe.repository}/tar.gz/${object.sha}`,builder_commit:process.env.GITHUB_SHA||null};
}
export function verifyPublication(lock,descriptor, files) {
  if(!/^[A-Za-z0-9._-]+\.(?:tar\.gz|zip)$/.test(descriptor.archive?.name||''))throw new Error('Unsafe archive name');
  if(descriptor.schema!==1||descriptor.version!==lock.version||descriptor.source_commit!==lock.source_commit||descriptor.recipe_version!==lock.version.split('-').slice(1).join('-'))throw new Error('Release identity mismatch');
  if(!files.has(descriptor.archive.name)||createHash('sha256').update(files.get(descriptor.archive.name)).digest('hex')!==descriptor.archive.sha256)throw new Error('Release archive checksum mismatch');
}
async function main(){
 const [command,...args]=process.argv.slice(2);const opts=new Map();for(let i=0;i<args.length;i+=2)opts.set(args[i],args[i+1]);
 if(command!=='resolve')throw new Error('Use resolve --recipe paseo --output lock.json [--version X.Y.Z]');
 const id=opts.get('--recipe')||'paseo';if(!/^[a-z0-9-]+$/.test(id))throw new Error('Invalid recipe');
 const recipe=JSON.parse(await readFile(resolve(root,`web-assets/recipes/${id}/recipe.json`),'utf8'));
 const lock=await resolveRelease(recipe,opts.get('--version'),process.env.GITHUB_REPOSITORY||'ZSA233/workspace-workbench');
 const output=resolve(opts.get('--output')||resolve(root,'.local/web-release/lock.json'));await mkdir(resolve(output,'..'),{recursive:true});await writeFile(output,JSON.stringify(lock,null,2)+'\n');
 if(process.env.GITHUB_OUTPUT)await writeFile(process.env.GITHUB_OUTPUT,`tag=${lock.tag}\nversion=${lock.version}\nneeded=${!lock.exists}\n`,{flag:'a'});
 console.log(`${lock.tag}: ${lock.exists?'already published':'ready to build'}`);
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))await main();
