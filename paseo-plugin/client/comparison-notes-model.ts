import type {Comparison} from '../shared/comparison';
import type {ComparisonNoteRecord} from '../shared/change-notes';
export function comparisonRecordState(record:ComparisonNoteRecord,refs:Array<{name:string;shortName:string;sha?:string}>,head?:string){
 const c=record.comparison;
 const sha=(ref:string)=>ref==='HEAD'?head:refs.find(r=>r.name===ref||r.shortName===ref)?.sha;
 return [sha(c.fromRef)&&sha(c.fromRef)!==c.fromSha,sha(c.toRef)&&sha(c.toRef)!==c.toSha].some(Boolean)?'historical':'fixed';
}
export function comparisonExplanationRequest(project:string,workspaceId:string,repoPath:string,c:Comparison){return [
 '请为以下固定比较的最终净差异补充 Workbench 改动说明，不逐个解释中间提交。',
 `项目配置：${project}`,`工作区：${workspaceId}`,`仓库：${repoPath}`,
 `显示引用：${c.fromRef} → ${c.toRef}`,`固定起点：${c.fromSha}`,`固定终点：${c.toSha}`,
 `方式：${c.mode}`,`实际差异起点：${c.leftSha}`,...(c.mergeBase?[`共同祖先：${c.mergeBase}`]:[]),
 `读取参数：${JSON.stringify({workspaceId,repoPath,scope:'compare',comparison:{fromRef:c.fromSha,toRef:c.toSha,fromLabel:c.fromRef,toLabel:c.toRef,mode:c.mode}})}`,
 '调用 workbench_change_notes_read，随后通过 workbench_change_notes_write 写入。分页读取继续使用相同完整 SHA，不重新解析分支。',
 '结合本会话需求说明原因、最终行为变化和自主调整。合并低信息量机械修改；不知道需求时明确说明，不编造依据。'
 ].join('\n');}
