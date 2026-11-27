import type {OrganizerJob} from './organizer.ts';

export const sessionStageLabels:Record<string,string>={queued:'排队中',retrying:'资料已更新，重新核对',discovering:'读取会话关联',materials:'读取提交与差异',production:'核对生产分支',fetching:'更新生产引用',conversation:'读取会话记录','model-queued':'等待本地模型',checking:'连接本地模型',requesting:'生成标题和摘要',validating:'校验模型结果',complete:'模型已返回',verifying:'核对资料版本',titles:'写入会话标题',finished:'处理结束',failed:'模型返回未通过校验'};
export function sessionJobProgress(job:OrganizerJob,now=Date.now()){
  const running=job.state==='running'||job.state==='queued',seconds=Math.max(0,Math.floor(((running?now:Date.parse(job.updatedAt))-Date.parse(job.startedAt||job.createdAt))/1000));
  let label=sessionStageLabels[job.stage||'queued']||'核对资料',detail='';
  if(job.stage==='materials')detail=[job.total?`${job.completed+1}/${job.total}`:null,job.current?.name,job.current?.repositoryCount?job.current.repositoryCount+' 个仓库':null].filter(Boolean).join(' · ');
  if(job.stage==='production'||job.stage==='fetching')detail=[job.current?.repository,job.current?.ref].filter(Boolean).join(' · ');
  if(job.stage==='conversation')detail=job.current?.page?'第 '+job.current.page+' 页 · '+(job.input?.history.fragments||0)+' 个公开片段':'核对增量断点';
  if(['model-queued','checking','requesting','validating','complete'].includes(job.stage||''))detail=job.model?.model||job.model?.name||'';
  if(job.stage==='verifying')detail=job.current?.name||'';
  if(job.stage==='requesting')label=job.intent?.title?job.intent.summaries?'生成标题和摘要':'生成会话标题':job.intent?.summaries?'生成工作区摘要':'归纳会话片段';
  if(!running){
    label=job.state==='failed'?'本次处理未完成':job.state==='cancelled'?'已取消':job.state==='interrupted'?'上次处理已中断':job.result?.previewStale?'资料已更新，请重新预览':job.result?.titleWrites?'会话标题已更新':job.result?.previewReady?'标题建议已就绪':job.model?.reason==='no-profile'?'等待配置模型':job.model?.reason==='no-material'?'暂无可生成的提交资料':job.model?.reason==='interval'?'已核对，沿用已有结果':'资料核对完成';
    detail=[job.result?.analyzed?job.result.analyzed+' 份摘要已更新':null,job.result?.cached?job.result.cached+' 份摘要沿用缓存':null,job.model?.calls?'本地模型 '+job.model.calls+' 次':'模型未调用'].filter(Boolean).join(' · ');
  }
  return{running,label,detail,seconds};
}
