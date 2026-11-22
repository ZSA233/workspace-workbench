import assert from 'node:assert/strict';
import test from 'node:test';
import {topicChoiceAvailable,topicModelChoice,topicModelKey} from '../client/topic-session-choice.ts';
import type {TopicModel} from '../shared/extensions/project-communications/topics.ts';

const model:TopicModel={provider:'codex',model:'model-a',label:'Model A',isDefault:true,
  thinkingOptions:[{id:'low',label:'Low',isDefault:true},{id:'high',label:'High'}],defaultThinkingOptionId:'low',
  permissionModes:[{id:'auto',label:'Default Permissions'},{id:'full-access',label:'Full Access'}]};

test('a fresh selection defaults to a supported Full Access preset and the host model effort',()=>{
  assert.deepEqual(topicModelChoice(model),{provider:'codex',model:'model-a',thinkingOptionId:'low',modeId:'full-access'});
  assert.equal(topicModelChoice({...model,provider:'custom',permissionModes:[]}).modeId,undefined);
});

test('compatible effort and permission choices survive model switches, including an explicit host-default permission',()=>{
  const previous={provider:'codex',model:'older-model',thinkingOptionId:'high',modeId:'auto'};
  assert.equal(topicModelChoice(model,previous).thinkingOptionId,'high');
  assert.equal(topicModelChoice(model,previous).modeId,'auto');
  assert.equal(topicModelChoice(model,{...previous,modeId:undefined}).modeId,undefined);
  const changed=topicModelChoice({...model,thinkingOptions:[{id:'adaptive',label:'Adaptive',isDefault:true}],defaultThinkingOptionId:'adaptive'},previous);
  assert.equal(changed.thinkingOptionId,'adaptive');assert.equal(changed.modeId,'auto');
  assert.equal(topicChoiceAvailable(model,{...previous,thinkingOptionId:'unsupported'}),false);
  assert.equal(topicChoiceAvailable(model,{...previous,modeId:'unlisted'}),false);
  assert.equal(topicChoiceAvailable({...model,permissionsUnavailable:true},previous),false);
  assert.notEqual(topicModelKey(model),topicModelKey({...model,provider:'other'}));
});
