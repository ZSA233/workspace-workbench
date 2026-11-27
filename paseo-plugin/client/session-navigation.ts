export type WorkbenchTab='workspace'|'review'|'files'|'cache'|'communications'|'session';
const tabs=new Map<string,WorkbenchTab>();
export function projectNavigationKey(hostId:string,projectConfig:string){return 'workbench-project:'+JSON.stringify([hostId,projectConfig]);}
export function sessionSelectionKey(hostId:string,projectConfig:string,hostWorkspaceId:string){return hostWorkspaceId?'workbench-session:'+JSON.stringify([hostId,projectConfig,hostWorkspaceId]):projectNavigationKey(hostId,projectConfig);}
/** Only the old conversation-specific key is a valid migration source. The
 * project-wide choice has no recorded owner and must not be borrowed. */
export function savedWorkspaceSelection(values:Record<string,string>,selectionKey:string,legacyScopeKey:string){return values[selectionKey]??values[legacyScopeKey]??'';}
export function projectTab(key:string){return tabs.get(key)||'workspace';}
export function rememberProjectTab(key:string,tab:WorkbenchTab){tabs.set(key,tab);}
