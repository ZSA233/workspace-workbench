import {z} from 'zod';

export const TOPIC_TEXT_LIMIT=120000;
export const topicTemplateSchema=z.object({id:z.string().min(1).max(80),name:z.string().trim().min(1).max(40),body:z.string().max(12000)});
export type TopicTemplate=z.infer<typeof topicTemplateSchema>;
export const topicMaterialSettingsSchema=z.object({layout:z.enum(['auto','text','conversation']).default('auto'),
  identity:z.enum(['alias','name']).default('name'),presetId:z.string().max(80).default('forward'),presets:z.array(topicTemplateSchema).max(8).default([])});
export type TopicMaterialSettings=z.infer<typeof topicMaterialSettingsSchema>;
export const topicContentOptionsSchema=z.object({layout:z.enum(['auto','text','conversation']).default('auto'),identity:z.enum(['alias','name']).default('name'),
  timeZone:z.string().min(1).max(100).default('Asia/Shanghai'),template:z.string().max(12000).default('{{note}}\n\n{{materials}}'),
  aliases:z.array(z.object({key:z.string().min(1).max(4096),label:z.string().min(1).max(256).refine(value=>!/[\u0000-\u001f]/.test(value))})).max(512).optional()});
export type TopicContentOptions=z.infer<typeof topicContentOptionsSchema>;
export const defaultTopicMaterialSettings:TopicMaterialSettings={layout:'auto',identity:'name',presetId:'forward',presets:[]};
export const topicBuiltInTemplates:TopicTemplate[]=[{id:'forward',name:'普通转发',body:'{{note}}\n\n{{materials}}'},
  {id:'discussion',name:'对话整理',body:'{{note}}\n\n以下是我选择的对话片段。请结合发言顺序、说话者和相互回应来理解，不要把不同人的说法混为一谈。\n\n{{materials}}'}];
export function topicTemplateError(body:string){
  if(body.length>12000)return '模板内容过长';
  if(body.split('{{materials}}').length!==2)return '请保留一处「所选材料」';
  if(body.split('{{note}}').length!==2)return '请保留一处「本次说明」';
  return '';
}
export function topicContentOptions(settings:TopicMaterialSettings,timeZone:string):TopicContentOptions{
  const preset=[...topicBuiltInTemplates,...settings.presets].find(item=>item.id===settings.presetId)||topicBuiltInTemplates[0];
  return {layout:settings.layout,identity:settings.identity,timeZone,template:preset.body};
}
