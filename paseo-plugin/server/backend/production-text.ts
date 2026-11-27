type Edit = {start:number; removed:string[]; added:string[]; next:number};

/** Read the positions of actual edits, without treating unchanged patch context
 * as requirement content. Malformed/truncated/non-text patches cannot prove coverage. */
function edits(patch:string):Edit[]|undefined {
  if(/\0|\ufffd|Binary files|GIT binary patch|^\\ No newline/m.test(patch))return;
  const result:Edit[]=[];let old=0,next=0,oldLeft=0,nextLeft=0,current:Edit|undefined,started=false;
  const flush=()=>{if(current){result.push(current);current=undefined;}};
  for(const line of patch.split('\n')){
    const header=line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if(header){
      if(oldLeft||nextLeft)return;
      flush();oldLeft=Number(header[2]??1);nextLeft=Number(header[4]??1);
      old=Number(header[1])-(oldLeft?1:0);next=Number(header[3])-(nextLeft?1:0);started=true;continue;
    }
    if(!oldLeft&&!nextLeft)continue;
    if(!started||!/^[-+ ]/.test(line))return;
    if(line[0]===' '){flush();if(--oldLeft<0||--nextLeft<0)return;old++;next++;}
    else{
      current||={start:old,next,removed:[],added:[]};
      if(line[0]==='-'){if(--oldLeft<0)return;current.removed.push(line.slice(1));old++;}
      else{if(--nextLeft<0)return;current.added.push(line.slice(1));next++;}
    }
  }
  if(oldLeft||nextLeft)return;flush();return result;
}
const lines=(text:string)=>{const value=text.split('\n');if(value.at(-1)==='')value.pop();return value;};
function unique(haystack:string[],needle:string[]){
  let count=0;
  for(let i=0;i+needle.length<=haystack.length;i++)if(needle.every((line,n)=>line===haystack[i+n])&&++count>1)return false;
  return count===1;
}

/** A second, positional proof for changed context and rewritten commit IDs.
 * All requirement lines must survive at their mapped location in the current
 * production file. Changes through those lines, ambiguous copies, restoration
 * of removed lines, and edits at a deletion boundary are deliberately rejected. */
export function retainedRequirementEdits(requirementPatch:string,laterPatch:string,committed:string,production:string):boolean {
  if([committed,production].some(text=>text.includes('\0')||text.includes('\ufffd')))return false;
  const own=edits(requirementPatch),later=edits(laterPatch);if(!own?.length||!later||own.length>256||later.length>256)return false;
  const source=lines(committed),target=lines(production);
  for(const change of own){
    const start=change.next,end=start+change.added.length;
    if(change.added.some((line,n)=>source[start+n]!==line))return false;
    let shift=0;
    for(const follow of later){
      const a=follow.start,b=a+follow.removed.length;
      if(!change.added.length){if(a<=start&&b>=start)return false;}
      else{
        if(follow.removed.length&&a<end&&b>start)return false;
        if(!follow.removed.length&&a>start&&a<end)return false;
        // Even when the new lines survive, reintroducing removed requirement
        // lines beside them can undo a replacement or create conflicting copies.
        if((b===start||a===end)&&change.removed.some(line=>follow.added.includes(line)))return false;
      }
      if(b<=start)shift+=follow.added.length-follow.removed.length;
    }
    if(change.added.length){
      if(!change.added.some(line=>line.trim())||!unique(source,change.added)||!unique(target,change.added))return false;
      if(change.added.some((line,n)=>target[start+shift+n]!==line))return false;
    }else{
      // A deletion has no surviving new line. Require an unchanged, unique
      // boundary on both sides rather than interpreting absence anywhere as proof.
      const left=Math.max(0,start-1),right=Math.min(source.length,start+1),boundary=source.slice(left,right);
      if(!boundary.length||!unique(source,boundary)||!unique(target,boundary)||boundary.some((line,n)=>target[left+shift+n]!==line))return false;
    }
  }
  return true;
}
