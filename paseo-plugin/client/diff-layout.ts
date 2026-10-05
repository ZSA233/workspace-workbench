import { DIFF_HUNK_ROW_HEIGHT, type DiffDisplayRow, type ParsedPatch } from './model.ts';
/** Measurements belong to a single width/font/wrap generation. */
export function measuredDiffRows(rows: DiffDisplayRow[], fontSize: number, measured: Record<string,number> = {}) {
  const offsets:number[]=[], lengths:number[]=[]; let contentHeight=0;
  for(const row of rows){offsets.push(contentHeight);const length=measured[row.key] || (row.kind==='hunk'?DIFF_HUNK_ROW_HEIGHT:fontSize+8);lengths.push(length);contentHeight+=length;}
  return {offsets,lengths,contentHeight};
}
export function changedFragment(before:string, after:string): [number,number] {
  let start=0,end=0;
  while(start<before.length && start<after.length && before[start]===after[start]) start++;
  while(end<before.length-start && end<after.length-start && before[before.length-1-end]===after[after.length-1-end]) end++;
  return [start,after.length-end];
}
/** Pair contiguous replacement lines; do not invent matches across context boundaries. */
export function highlightReplacements(patch:ParsedPatch):ParsedPatch {
  return {...patch,hunks:patch.hunks.map(hunk=>{
    const lines=hunk.lines.map(line=>({...line}));
    for(let i=0;i<lines.length;){
      if(lines[i].kind!=='removed'){i++;continue;}
      const start=i;while(i<lines.length&&lines[i].kind==='removed')i++;
      const added=i;while(i<lines.length&&lines[i].kind==='added')i++;
      for(let n=0;n<Math.min(added-start,i-added);n++){
        const left=lines[start+n],right=lines[added+n];
        left.inlineChange=changedFragment(right.content,left.content);right.inlineChange=changedFragment(left.content,right.content);
      }
    }
    return {...hunk,lines};
  })};
}
