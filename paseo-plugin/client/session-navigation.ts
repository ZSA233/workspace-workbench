export type WorkbenchTab='workspace'|'review'|'files'|'cache'|'communications'|'session';
const tabs=new Map<string,WorkbenchTab>();
export function projectNavigationKey(hostId:string,projectConfig:string){return 'workbench-project:'+JSON.stringify([hostId,projectConfig]);}
export function projectTab(key:string){return tabs.get(key)||'workspace';}
export function rememberProjectTab(key:string,tab:WorkbenchTab){tabs.set(key,tab);}
