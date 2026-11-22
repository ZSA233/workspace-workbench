import {existsSync,mkdirSync,readFileSync,renameSync,writeFileSync} from 'node:fs';
import {dirname,join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {topicSessionPreferencesSchema,type TopicSessionPreferences} from '../shared/extensions/project-communications/topics.ts';
import type {ProjectRoute} from './projects.ts';

/** Local host/project choices; independent of archive credentials and discovery policy. */
export function topicSessionPreferences(route:ProjectRoute,value?:TopicSessionPreferences):TopicSessionPreferences {
  const path=join(route.stateRoot,'extensions','topic-session-preferences.json');
  const stored=existsSync(path)?JSON.parse(readFileSync(path,'utf8')):{version:1};
  if(stored.version!==1)throw Error('topic_preferences_invalid');
  if(value){
    const choice=topicSessionPreferencesSchema.parse(value);
    mkdirSync(dirname(path),{recursive:true,mode:0o700});
    const temporary=path+'.'+randomUUID();
    writeFileSync(temporary,JSON.stringify({...stored,selection:{...stored.selection,...choice}}),{mode:0o600});
    renameSync(temporary,path);return choice;
  }
  return topicSessionPreferencesSchema.parse(stored.selection||{});
}
