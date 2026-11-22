import type {TopicModel,TopicNewSession} from '../shared/extensions/project-communications/topics.ts';

export const topicModelKey=(model:TopicNewSession)=>JSON.stringify([model.provider,model.model]);
export const topicProviderLabel=(provider:string)=>provider.replace(/[-_]+/g,' ').replace(/\b\w/g,letter=>letter.toUpperCase());
export const topicEffortLabel=(option:{id:string;label?:string})=>{const label=option.label||option.id;return label.charAt(0).toUpperCase()+label.slice(1);};

/** Keep compatible choices; model/provider changes cannot carry unsupported settings. */
export function topicModelChoice(model:TopicModel,previous?:TopicNewSession):TopicNewSession {
  const thinkingOptionId=model.thinkingOptions?.find(option=>option.id===previous?.thinkingOptionId)?.id
    ||model.thinkingOptions?.find(option=>option.id===model.defaultThinkingOptionId)?.id
    ||model.thinkingOptions?.find(option=>option.isDefault)?.id||model.thinkingOptions?.[0]?.id;
  const modeId=previous?.provider===model.provider
    ?model.permissionModes?.find(mode=>mode.id===previous.modeId)?.id
    :model.permissionModes?.find(mode=>mode.id==='full-access'||mode.label.replace(/[\s_-]/g,'').toLowerCase()==='fullaccess')?.id;
  return {provider:model.provider,model:model.model,...(thinkingOptionId?{thinkingOptionId}:{}),...(modeId?{modeId}:{})};
}

export function topicChoiceAvailable(model:TopicModel,choice:TopicNewSession):boolean {
  return !model.permissionsUnavailable
    &&(!choice.thinkingOptionId||Boolean(model.thinkingOptions?.some(option=>option.id===choice.thinkingOptionId)))
    &&(!choice.modeId||Boolean(model.permissionModes?.some(mode=>mode.id===choice.modeId)));
}
