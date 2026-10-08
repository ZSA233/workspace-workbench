import type {FileReviewSelection} from './file-review-store.ts';
import type {DiffResult} from './model.ts';

/** Directory suffixes disambiguate filenames; scope/repository disambiguate identical paths. */
export function diffTabLabels(selections:FileReviewSelection[]):string[]{
 return selections.map((selection,index)=>{
  if(selection.kind==='comparison'){
   const groups=selections.filter(s=>s.kind==='comparison'),range=selection.comparison;
   if(groups.length===1)return '整组差异';
   return `整组差异 · ${selection.workspaceId}/${selection.repoPath} · ${range?.fromSha.slice(0,8)}→${range?.toSha.slice(0,8)}${range?.mode==='contribution'?' (共同祖先)':''}`;
  }
  const parts=selection.path.split('/');
  const peers=selections.filter((other,i)=>i!==index&&other.kind!=='comparison'&&other.path.split('/').at(-1)===parts.at(-1));
  if(!peers.length)return parts.at(-1)||selection.path;
  let label=selection.path;
  for(let depth=2;depth<=parts.length;depth++){
   const suffix=parts.slice(-depth).join('/');
   if(peers.every(other=>other.path.split('/').slice(-depth).join('/')!==suffix)){label=suffix;break;}
  }
  if(peers.some(other=>other.path===selection.path)){
   const range=selection.comparison?`${selection.comparison.leftSha.slice(0,8)}→${selection.comparison.toSha.slice(0,8)} (${selection.comparison.mode})`:selection.commitSha?.slice(0,8)||selection.scope;
   label=`${label} · ${selection.workspaceId}/${selection.repoPath} · ${range}`;
  }
  return label;
 });
}
export function diffToolbarLayout(width:number,touch=false){return {showRange:width>=720,showMode:width>=480,minHeight:touch?44:36};}
export function diffReadingReferences(selection:FileReviewSelection|undefined,diff:DiffResult|null){
 if(!selection||!diff)return null;
 const comparison=selection.comparison;
 const from=comparison?.leftSha??diff.baseSha;
 const to=comparison?.toSha??(selection.scope==='commit'?selection.commitSha:diff.head);
 const short=(value:string|null|undefined)=>value?value.slice(0,8):'—';
 // A null left side is real empty content (root commit / untracked file), never the creation base.
 return {from:from||null,to:selection.scope==='working'?null:to||null,
   fromLabel:from?short(from):'∅',toLabel:selection.scope==='working'?'Working tree':short(to),
   mode:comparison?.mode||selection.scope,mergeBase:comparison?.mergeBase||null,
   fromRef:comparison?.fromRef||null,toRef:comparison?.toRef||null,
   fromRefSha:comparison?.fromSha||null,toRefSha:comparison?.toSha||null};
}
