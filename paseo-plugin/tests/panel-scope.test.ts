import assert from "node:assert/strict";
import test from "node:test";
import { projectPreferenceScopeKey, workbenchScopeKey } from "../client/panel/scope.ts";
import {projectNavigationKey,sessionSelectionKey,savedWorkspaceSelection,projectTab,rememberProjectTab} from '../client/session-navigation.ts';

test("panel scope keys remain stable and isolate host/project/workspace", () => {
  assert.equal(projectPreferenceScopeKey("/tmp/project.json", "host-1"), "project:/tmp/project.json:paseo-workspace:host-1");
  assert.equal(projectPreferenceScopeKey("/tmp/project.json", ""), "project:/tmp/project.json:paseo-workspace:global");
  assert.notEqual(
    workbenchScopeKey({ hostWorkspaceId: "host-1", projectConfig: "a", workspaceId: "main" }),
    workbenchScopeKey({ hostWorkspaceId: "host-1", projectConfig: "a", workspaceId: "other" }),
  );
});

test('workspace selection is isolated by host, project and conversation while the global surface retains its own key',()=>{
 const key=sessionSelectionKey('host','project','conversation-A');assert.equal(key,sessionSelectionKey('host','project','conversation-A'));
 for(const other of [sessionSelectionKey('host','project','conversation-B'),sessionSelectionKey('other-host','project','conversation-A'),sessionSelectionKey('host','other-project','conversation-A'),sessionSelectionKey('host','project','')])assert.notEqual(key,other);
 assert.equal(sessionSelectionKey('host','project',''),projectNavigationKey('host','project'));
});
test('only an explicit conversation record can restore its selection; shared project history has no inferred owner',()=>{
 const a=sessionSelectionKey('host','project','A'),b=sessionSelectionKey('host','project','B'),oldA=projectPreferenceScopeKey('project','A'),oldB=projectPreferenceScopeKey('project','B');
 const values={[projectNavigationKey('host','project')]:'last-global-workspace',[oldA]:'old-A'};
 assert.equal(savedWorkspaceSelection(values,a,oldA),'old-A');assert.equal(savedWorkspaceSelection(values,b,oldB),'');
 const selected={...values,[a]:'new-A',[b]:'new-B'};assert.equal(savedWorkspaceSelection(selected,a,oldA),'new-A');assert.equal(savedWorkspaceSelection(selected,b,oldB),'new-B');assert.equal(values[projectNavigationKey('host','project')],'last-global-workspace');
});
test('conversation workspace memory does not turn the project tab into another conversation preference',()=>{
 const project=projectNavigationKey('host','tab-project'),other=projectNavigationKey('host','other-tab-project');rememberProjectTab(project,'session');
 assert.notEqual(sessionSelectionKey('host','tab-project','A'),sessionSelectionKey('host','tab-project','B'));assert.equal(projectTab(project),'session');assert.equal(projectTab(other),'workspace');
});

