import {homedir} from 'node:os';
import {isAbsolute,relative,resolve,sep} from 'node:path';
import {canonical,inside,WorkbenchError} from './storage.ts';
import {repositoryPath,type Config,type Repository} from './config.ts';
import {childPath} from './gitlinks.ts';

export const filesystemRecordPaths = {canonical,inside,repositoryPath,childPath};
/** Display identities only. Never use this policy to authorize filesystem/Git work. */
const lexical = (path:string):string => {
  if(typeof path!=='string'||!path||path.includes('\0'))throw new WorkbenchError('record_invalid','Invalid record path');
  return resolve(path==='~'?homedir():path.startsWith('~/')?`${homedir()}/${path.slice(2)}`:path);
};
const within = (path:string,root:string,allowRoot=false):boolean => {
  const part=relative(lexical(root),lexical(path));
  return (allowRoot||part!=='') && part!=='..' && !part.startsWith('..'+sep) && !isAbsolute(part);
};
export const displayRecordPaths:typeof filesystemRecordPaths = {
  canonical:lexical,
  inside:within,
  repositoryPath(config:Config,repo:Repository){
    const path=repo.path.startsWith('~/')?lexical(repo.path):resolve(config.sourceRoot,repo.path);
    if(!within(path,config.sourceRoot,true))throw new WorkbenchError('path_outside_root','Repository path is outside the configured source root');
    return path;
  },
  childPath(root:string,path:string){
    if(!path||isAbsolute(path)||path.split('/').some(p=>!p||p==='.'||p==='..'))throw new WorkbenchError('gitlink_path_invalid','Gitlink path is unsafe');
    const target=resolve(root,path);
    if(!within(target,root))throw new WorkbenchError('gitlink_path_invalid','Gitlink escapes its outer repository');
    return target;
  },
};
