import type {Comparison} from '../shared/comparison.ts';
export type ComparisonRequest={fromRef:string;toRef:string;mode:Comparison['mode']};
export function shortComparisonRef(ref:string){return /^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(ref)?ref.slice(0,8):ref.replace(/^refs\/(heads|remotes|tags)\//,'');}
export function sameComparisonRequest(a:ComparisonRequest|null|undefined,b:ComparisonRequest|null|undefined){return !!a&&!!b&&a.fromRef===b.fromRef&&a.toRef===b.toRef&&a.mode===b.mode;}
export function comparisonRequest(fromRef:string,toRef='HEAD',mode:Comparison['mode']='endpoints'):ComparisonRequest|null {
 const from=fromRef.trim(),to=toRef.trim();return from&&to&&!from.includes('\0')&&!to.includes('\0')?{fromRef:from,toRef:to,mode}:null;
}

export function comparisonRowHeight(touch:boolean,fontScale=1){return Math.max(touch?44:32,Math.ceil(32*Math.max(1,fontScale)));}

/** Android may already resize its window; avoid adding keyboard height twice. */
export function keyboardOverlap(windowHeight:number,keyboardTop:number|null){return keyboardTop===null?0:Math.max(0,windowHeight-keyboardTop);}
